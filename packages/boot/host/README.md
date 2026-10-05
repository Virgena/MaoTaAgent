---
description: "Spawn the blmoadll kernel from Node and drive it: invoke capabilities, stream chunks, subscribe to events, and shut it down over the kernel's stdio protocol."
kind: "package-reference"
---

# @virgena/maota-boot-host

English | [中文](README.zh.md)

## Summary

Boot one blmoadll kernel as a child process and talk to it from Node: ask for the capability table, invoke a capability, consume a stream of chunks, subscribe to kernel events, and shut the process down with a reason. The host owns framing, backpressure, cancellation and the failure text you see when a kernel dies, so callers never touch raw stdio. Use it from any Node front end; the CLI and the smoke tests are the current callers. It does not resolve paths or read configuration.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further exploration](#further-exploration)

-----

<a id="use-this-package"></a>
## Use this package

Use it from any Node front end that drives a kernel: boot once, then invoke, stream, subscribe and shut down through the returned host.

### Booting a kernel

`boot()` resolves once the kernel has answered `capabilities`, so a returned host is a live, wired process:

```ts
import { boot } from "../../boot/host/src/index.ts";

const kernel = await boot(configPath, { bin });
const table = await kernel.capabilities();
const stream = await kernel.invoke("agent.loop", "run", { input: "hi" }, { stream: true });
for await (const chunk of stream) console.log(chunk.data);
process.exit(await kernel.shutdown("ui_quit"));
```

### Options

| Option | Default | Meaning |
|---|---|---|
| `bin` | `BLMOADLL_BIN`, else `blmoadll` | Kernel binary to spawn. |
| `cwd` | the parent's cwd | Working directory for the child. |
| `env` | `process.env` | Environment for the child. |
| `onLog` | write stderr through | Callback for each JSON log line the kernel writes to stderr. |

### Call surfaces

| Call | Meaning |
|---|---|
| `capabilities()` | The capability table: capability id to providing plugin and version. |
| `invoke(capability, method, params?)` | One request, one reply; rejects with `KernelError`. |
| `invoke(capability, method, params, { stream: true })` | A chunk stream as an `AsyncIterable`; breaking out of it cancels the call. |
| `subscribe(patterns)` | An `AsyncIterable` of matching kernel events. |
| `on(patterns, handler)` | The same events through a callback; returns an unsubscribe function. |
| `restart(plugin, reason?)` | Stop one named plugin and start it again; `reason` is `source` or `manual` and only shows up in events. |
| `shutdown(reason)` | Ask for shutdown, then resolve with the child's exit code. |
| `exited` | The child's exit code as a promise, without asking for shutdown. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

This section explains how the host keeps one child process and one stdio pipe honest; the calls it exposes are covered in [Use this package](#use-this-package).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `boot`, `Host`, `KernelError`, `Queue`, framing helpers, `Chunk` and `Event` types |

### Framing, backpressure and cancellation

Both directions use the kernel's framing: a `Content-Length` header, a blank line, then one JSON body. Replies settle the pending call by id; `$/stream/chunk`, `$/stream/error` and `$/event` are notifications. Chunks that arrive before the consumer starts iterating are parked per stream id and replayed when it does, and a stream that never gets a consumer is parked until the process ends. Queued bytes above 1 MiB pause the child's stdout; below 256 KiB it resumes. Leaving a stream early sends `$/cancel` for it. When the child dies, the host keeps the last 32 stderr lines, finds the last one that looks like a kernel report, and expands its `errors[]` into the thrown message. A provider that dies mid-flight makes later calls to its capability fail with `-32011`; an unknown capability fails with `-32010`.

### Restart and plugin identity

`kernel.plugin.started` carries `trigger` (`boot`, `config`, `source`, `manual`) together with the plugin's `cwd`, `command` and `args` as the loader resolved them, which is what lets a front end map a changed file back to the plugin that owns it. `restart` reuses the reload path in stop-then-start order: the old instance gets `shutdown{reason: "reload"}` and must leave, force-killed after its `shutdown_grace_ms`, and only then does the same spawn, initialize, validate, swap, start sequence run for that one plugin. A plugin that cannot come up stays absent and keeps failing with `-32011` until another `restart` succeeds. Subscriptions ask for `replay`, so the plugins that were already running when the host subscribed announce themselves too.
A plugin whose required capabilities nobody serves is not a boot failure: the kernel spawns and initializes it, then holds it back in a waiting state. Its `provides` stay out of the routing table, so `invoke` on a capability it would have offered fails with `-32010`, and `kernel.plugin.blocked` carries the plugin and the capability ids it waits for. `replay` covers those waiting plugins as well. The same state shows up after a reload when a running plugin loses a provider: that plugin is stopped with `trigger: config` and started again by the reload that brings the provider back. A config row switched off with `disabled = true` is the other half of this: it is not started and not in the table, and an upper config layer overriding it to `false` brings it up. The kernel's `--check` report names both worlds as `disabled` (plugin ids) and `blocked` (plugin id to missing capability ids), and counts them as warnings, so a config that only has those still exits 0.
Four facts bound this host. A pattern matches whole topic segments: `*` matches one segment and `**` never matches. Nothing published before a subscription is replayed, with one exception, since `subscribe` carries `replay`, so a subscription created after boot is told about every plugin already running and every plugin already waiting. A handler that throws ends its subscription, and the failure is reported nowhere else. `shutdown` always resolves, so a kernel that ignores the request leaves the caller waiting for the process to exit, and `restart` replaces exactly the plugin it is named.



<a id="further-exploration"></a>
## Further exploration

- [boot group](../README.md): the launch glue this host belongs to.
- [maota CLI](../../../apps/cli/README.md): the caller that decides which plugins a changed file restarts.
- [Architecture](../../../docs/architecture.md#launch-path): where the host sits in the launch path.

-----

<a id="dev-note"></a>
## Dev Note

Open: plugin ownership still comes from a static import scan the CLI runs over each entry, so a module reached only through a computed specifier or a path alias is invisible and editing it restarts nothing. The direction being weighed is to let a plugin report the files it actually loaded, which would delete the scan and that ceiling with it.

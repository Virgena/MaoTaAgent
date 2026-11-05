---
description: "One Node process that loads every eligible Node plugin over a single pipe to the kernel, and the crash reports that let the kernel attribute a death to a plugin."
kind: "package-reference"
---

# plugin-host

English | [中文](README.zh.md)

## Summary

The kernel normally starts one process per plugin. This package is the alternative: one child process imports every eligible Node plugin into a single V8 instance, multiplexes their frames over the pipe the kernel already speaks, and tags each frame with the plugin it belongs to. A plugin author never sees it: packages call `runPlugin` as before. The kernel owns the policy (which rows are eligible, when to restart, which plugin is quarantined); this package owns loading, tagging, and the crash reports that make attribution possible.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further exploration](#further-exploration)

-----

<a id="use-this-package"></a>
## Use this package

The launcher writes the row for you. Nothing imports this package as a library.

```toml
[kernel.host]
command = "<node>"
args = ["<...>/@maota/plugin-host/lib/index.js"]
```

| Input | Meaning |
|---|---|
| stdin | `Content-Length` frames from the kernel. A frame carrying `plugin` belongs to that plugin; a frame without one is the control plane. |
| stdout | `Content-Length` frames to the kernel. Every plugin frame is tagged with `plugin`, and nothing else may write fd 1. |
| `MAOTA_HOME` | Where the V8 compile cache lives, in `compile-cache` under it. A home that cannot hold it costs startup time and nothing else. |

The control plane is the kernel's, never a plugin's. A frame with a `plugin` member may not address it, and the kernel refuses such a call.

| Method | Direction | Meaning |
|---|---|---|
| `$/host/load` | kernel to host | Import one entry and bind it to that plugin id. The reply waits for `serve()` to adopt the definition. |
| `$/host/unload` | kernel to host | Ask a plugin to close, and reply once it has. |
| `$/host/kill` | kernel to host | Stop delivering to a plugin and report it gone. |
| `$/host/ping` | kernel to host | The watchdog's question. |
| `$/host/loading` | host to kernel | An import started, naming the plugin, so a crash in the next moment has a culprit. |
| `$/host/exited` | host to kernel | That plugin's channel is closed, with its exit code. |
| `$/host/failed` | host to kernel | The import or the plugin start failed. |
| `$/host/crash` | host to kernel | An uncaught error, attributed to the plugin whose code was running when possible. |
| `$/host/stuck` | host to kernel | A close that did not finish in time. |
| `$/host/fatal` | host to kernel | The host itself cannot continue; it exits 70. |

Four boundaries are worth knowing before changing this package:

- A plugin that writes to stdout would corrupt the pipe. This host points `process.stdout.write` at stderr, so stray logging becomes one host log line instead of a broken frame.
- A shared host ignores `cwd`, `env` and `clear_env` on a plugin row, and the kernel only shares rows that ask for none of them.
- Every hosted plugin shares one thread. A synchronous loop blocks its siblings; the kernel's answer is a kill and a restart, not preemption.
- Reloading a hosted plugin re-evaluates its module graph behind a generation query (`module.registerHooks`), so a source change is visible without restarting the process.

<a id="understand-the-implementation"></a>
## Understand the implementation

### Source map

| File | Owns |
|---|---|
| `src/index.ts` | The process: stdin dispatch, the control plane, crash handlers, the compile cache. |
| `src/members.ts` | The member registry: load and unload, adoption, generation queries, attribution, closure. |
| `src/outbound.ts` | The single writer on fd 1, one whole frame at a time. |
| `src/control.ts` | The method names and the one host error code, `-32022`. |

### How a load becomes a plugin

`$/host/load` records the plugin and its canonical entry, announces `$/host/loading`, and imports the entry inside an `AsyncLocalStorage` scope that names the plugin. The plugin module calls `runPlugin`, as it always did; `plugin-kit`'s adapter compares the calling module with the entry, and only a match takes the slot. A dependency that calls `runPlugin` from its own top level is therefore inert instead of stealing the slot. When the import returns, the host answers the kernel only if a definition was adopted.

### Why a reload can see new code

Node caches a module by URL. A first load is untagged, which is what lets hosted plugins share their dependency graph. A reload carries `maota=<plugin>&gen=<n>` in the entry URL, and `module.registerHooks` propagates both to every file that tagged module imports. Old generations stay cached and are left to the collector.

<a id="further-exploration"></a>
## Further exploration

- [the boot package group](../README.md): how these packages compose into one launch.
- [plugin-kit](../../plugin-kit/README.md): the adapter and the transport this host installs.
- [Architecture](../../../docs/architecture.md): where the host sits in the whole system.

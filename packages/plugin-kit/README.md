---
description: "The plugin protocol every MaoTa package imports: stdio framing, channels, capability routing, tool declaration, and the config-key and schema checks."
kind: "package-reference"
---

# plugin-kit

English | [中文](README.zh.md)

## Summary

Every MaoTa package imports this one, and nothing here imports them back. It owns the stdio frame format, the channel that carries requests, replies, notices and cancel notices, the `runPlugin` entry that gives a package its `--check` mode, the controlled JSON Schema subset a tool declares its parameters in, and `defineTools`, which turns those declarations into the four methods one tool capability answers. It carries no tool, no model and no config of its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further exploration](#further-exploration)

-----

<a id="use-this-package"></a>
## Use this package

### Writing a plugin

| Export | Meaning |
|---|---|
| `runPlugin(definition)` | The entry every spawned package calls. Under `--check` it validates `provides`, `injects`, `registrations`, `hostCalls`, `configKeys` and `selfCheck`, prints one JSON line and exits; otherwise it serves stdio and performs registration lifecycle. |
| `Definition` | `provides`, `injects`, `registrations`, `hostCalls`, `configKeys`, `setup`, `start`, `methods`, `close` and `selfCheck`. |
| `Call` | What a method receives: `channel`, `signal`, `config`, `capabilities`, `caller`, `capability`, `method` and `stream`. |
| `CallError` | A failure with a JSON-RPC code and optional `data`. |
| `Channel` | `call`, `stream`, `publish`, `subscribe`, `unsubscribe`, `notify` and `log` over the kernel connection. |
| `ProviderStream` | Pushes chunks for an invoke that asked for `meta.stream`. |
| `installHostAdapter` / `hostAdapter` | The seam a shared extension host uses: `isPluginEntry` asks it first, and `serve` hands it the channel instead of binding this process's stdio. |
| `Transport` / `HostAdapter` | Where a channel's frames go, and the host's side of that seam. |

### Sharing one process

A package never asks where it runs. Spawned as its own process, a plugin writes fd 1 and reads fd 0 exactly as before. Loaded by a shared host, the same `runPlugin` call hands its channel to that host: frames are tagged with the plugin id and written by the host's one writer, and `isPluginEntry` answers from the host's list of entries rather than from `process.argv`. An absent adapter changes nothing, which is why using a host is the kernel's choice and not a package's.

### Declaring a tool

`defineTools(blueprints)` returns `{ provides, methods }`, and `methods` holds `describe`, `policy`, `run` and `classify`.

| Blueprint field | Meaning |
|---|---|
| `capability` | `tool.<name>`, the capability the kernel routes to. |
| `paths` | The parameter names that carry a file path, each a `string` or an array of `string`, so a caller can tell which arguments touch the file system. |
| `version` | A full semver. |
| `description` | The text the model reads. |
| `parameters` | Fields written by property, compiled into one `{ type: "object", properties, required }`. |
| `concurrency` | `"always"`, `"never"`, or `{ safe(args) }`. |
| `maxResultChars` | A positive integer, or `null` for never spill. Omitted means the dispatcher applies its own budget. |
| `run(args, call)` | The work. It runs only after the arguments pass validation. |

| Parameter field | Meaning |
|---|---|
| `type` | One of `object`, `array`, `string`, `number`, `integer`, `boolean` and `null`. |
| `required` | Top level only. The model must send it. |
| `description`, `enum`, `items`, `additionalProperties` | The usual hints, inside the subset below. |
| `host` | A host source: `session_cwd`, `session_id`, `call_id`, `subagent` or `session_touched`. The host fills it before the call, and the model never sees it. The type is `string`, or `object` for a source that hands over a value rather than a name. |

### The controlled schema subset

`assertSupportedJsonSchema` accepts only the scalar `type` list above, `properties`, `required`, boolean `additionalProperties`, `items`, scalar `enum` and `const`, `oneOf`, plus `description`, `title` and `default`. Anything else is a `JsonSchemaError` that lists every offending path at once, so one declaration cannot fail twice.

`validateParameters(schema, args)` returns a path-qualified list of everything wrong with a value, or an empty list. A tool method answers with `ToolArgsError` when it is non-empty, and the loop turns that into a readable `{ error }` result instead of ending the turn.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

### Source map

| File | Role |
|---|---|
| [`src/frame.ts`](src/frame.ts) | The stdio frame reader and writer. |
| [`src/channel.ts`](src/channel.ts) | `Channel`, `CallError`, routing and cancel. |
| [`src/plugin.ts`](src/plugin.ts) | `runPlugin`, `serve`, the initialize / start / invoke / shutdown handshake, `ProviderStream` and the unknown-config-key warning. |
| [`src/glob.ts`](src/glob.ts) | `patternToRegExp`: the `**`, `*` and `?` matcher the file tools and the skill roots share. |
| [`src/json-schema.ts`](src/json-schema.ts) | The controlled subset: `assertSupportedJsonSchema` and `validateJsonSchemaValue`. |
| [`src/tool.ts`](src/tool.ts) | `defineTools`, `ToolArgsError`, host arguments and the two compiled schemas. |
| [`src/config-keys.check.ts`](src/config-keys.check.ts) | The unknown-key warning, checked by a script. |
| [`src/tool-schema.check.ts`](src/tool-schema.check.ts) | The declaration and value checks, checked by a script. |

### One declaration, two schemas

A blueprint's `parameters` compiles into two objects. The published one becomes the model-visible `input_schema`; the validation one adds every host argument as required, except a source that is allowed to be absent. `describe` returns the published schema plus `host_args`, so the host knows what to inject without the model ever seeing those names. A host argument that is `required`, whose type is neither `string` nor `object`, or that appears below the top level is a declaration error rather than a runtime one.

### Runs after validation, never before

`run` validates first and only then calls the blueprint. `classify` validates the same way and answers `safe: false` for bad arguments or a throwing `safe`, so a call that is about to fail on its arguments still runs alone instead of beside a safe call.

Five facts bound this contract. The host sources are a fixed set, `session_cwd`, `session_id`, `call_id`, `subagent` and `session_touched`, so a tool that needs another one cannot declare it, and only the optional ones may be missing from the arguments. Only the input side of a tool is described, because there is no output schema. The schema subset is closed: `pattern`, `minimum`, `maximum` and `$ref` are refused, so a tool that needs them needs a change here first. `oneOf` branches are checked for shape and not for exclusivity. And a capability name and a version range are all the routing check there is, because there is no permission layer.

-----

<a id="further-exploration"></a>
## Further exploration

- [tools](../agent/tools/README.md): the dispatcher that lists and calls these capabilities.
- [tool-fs](../fs/tool-fs/README.md): a worked example of three tools in one plugin.
- [packages group](../README.md): the plugin tree this package belongs to.

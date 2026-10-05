---
description: "The packages under packages/: what each one provides, and what it hands to the rest."
kind: "package-group"
---

# packages/

English | [中文](README.zh.md)

## Summary

Every directory under `packages/` is a package, and each one carries one duty: a package the kernel spawns as its own process, a package the others import, a package that decides what one launch does, or a package that lists the rows a profile mounts. To find who owns a capability, look the package up here and open its directory. Package-level conventions live in that package's own README; this page says only what is here.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)

-----

<a id="packages"></a>
## Packages

Each profile writes its own `$MAOTA_HOME/profiles/<name>/blmoadll.toml`, one row per spawned package: the row states the package to run and nothing else, the kernel resolves that name out of the profile's own `node_modules`, and the capability comes from the process itself.

| Package | Directory | Capability | Role |
|---|---|---|---|
| `@maota/context-agent-instructions` | [`context/agent-instructions`](context/agent-instructions/) | `hook.agent-instructions` | The `PreModel` provider for `AGENTS.md` and `CLAUDE.md`. |
| `@maota/memory` | [`memory/memory`](memory/memory/) | `hook.memory`, `tool.memory` | The fixed-budget memory snapshot and the model tool that maintains it. |
| `@maota/agent-core` | [`agent/agent-core`](agent/agent-core/) | `agent.loop` | The package a front end talks to: the system prompt, session bookkeeping, tool wiring and the streaming `run`. |
| `@maota/agent-runner` | [`agent/agent-runner`](agent/agent-runner/) | `agent.runner` | Per-session turn serialization, queue priority, wake budget and system message delivery. |
| `@maota/jobs` | [`jobs/jobs`](jobs/jobs/) | `jobs` | The central process-local background job registry. |
| `@maota/tool-jobs` | [`jobs/tool-jobs`](jobs/tool-jobs/) | `tool.job_output`, `tool.job_list`, `tool.job_kill` | The model tools for reading, listing and stopping jobs. |
| `@maota/schedule` | [`schedule/schedule`](schedule/schedule/) | `schedule` | Persistent reminders and scripted or agent-backed automation. |
| `@maota/tool-cron` | [`schedule/tool-cron`](schedule/tool-cron/) | `tool.cron_*` | The model tools for schedule management. |
| `@maota/api` | [`api`](api/) | `api` | The model gateway: an openai backend and a scripted one for tests. |
| `@maota/model-protocol` | [`model/model-protocol`](model/model-protocol/) |  | The vendor-neutral request, stream, model metadata and failure dialect. |
| `@maota/model-router` | [`model/model-router`](model/model-router/) | `model` | The provider/model catalog, adapter discovery, thinking-level routing, credentials and retries. |
| `@maota/model-api` | [`model/model-api`](model/model-api/) | `model.adapter.api` | The compatibility edge that routes the new model request shape through the preserved `api` plugin. |
| `@maota/model-openai` | [`model/model-openai`](model/model-openai/) | `model.adapter.openai` | The OpenAI Chat Completions edge adapter. |
| `@maota/model-anthropic` | [`model/model-anthropic`](model/model-anthropic/) | `model.adapter.anthropic` | The Anthropic Messages edge adapter. |
| `@maota/model-scripted` | [`model/model-scripted`](model/model-scripted/) | `model.adapter.scripted` | The deterministic model adapter used by tests. |
| `@maota/hmr` | [`boot/hmr`](boot/hmr/) | `dev.hmr` | The development watcher: it publishes `dev.source.changed` for the paths it watches, and its generated row ships disabled. |
| `@maota/hooks-native` | [`hooks/hooks-native`](hooks/hooks-native/) | `hooks` | The hook engine: it discovers the `hook.*` capabilities, asks the ones a hook point belongs to, and merges their answers into one. |
| `@maota/permission` | [`interaction/permission`](interaction/permission/) | `permission` | The gate a tool asks before a destructive command: the session's mode, the questions waiting for an answer, and the paired audit file. |
| `@maota/pwsh-local` | [`shell/pwsh-local`](shell/pwsh-local/) | `shell` | The provider that runs a command with the local PowerShell. |
| `@maota/session` | [`session`](session/) | `session` | Stored conversations, their titles and their working directories, and the parent link a subagent's document carries. |
| `@maota/settings` | [`settings/settings`](settings/settings/) | `settings` | Host-owned locale and theme preferences. |
| `@maota/workspace` | [`workspace/workspace`](workspace/workspace/) | `workspace` | Workspace registrations and the global session pin and archive sets. |
| `@maota/skill` | [`skill/skill`](skill/skill/) | `skill` | The registry a turn lists skills through, loads one with, and renders a catalog from. |
| `@maota/skill-bundled` | [`skill/skill-bundled`](skill/skill-bundled/) | `skill.bundled` | The six skills that ship with the repository. |
| `@maota/skill-filesystem` | [`skill/skill-filesystem`](skill/skill-filesystem/) | `skill.filesystem` | Skills read from the local roots. |
| `@maota/tool-fs` | [`fs/tool-fs`](fs/tool-fs/) | `tool.read`, `tool.write`, `tool.edit` | The tools the model reads, writes and edits files through. |
| `@maota/tool-fs-search` | [`fs/tool-fs-search`](fs/tool-fs-search/) | `tool.glob`, `tool.grep` | The tools that find files by path pattern and lines by regular expression. |
| `@maota/tool-pwsh` | [`shell/tool-pwsh`](shell/tool-pwsh/) | `tool.pwsh` | The tool the model runs commands through, and the one that asks the gate first. |
| `@maota/tool-skill` | [`skill/tool-skill`](skill/tool-skill/) | `tool.skill` | The tool the model loads one skill body through, and the `control` block it hands back. |
| `@maota/tool-todo` | [`todo/tool-todo`](todo/tool-todo/) | `tool.todo_write` | The plan: the tool the model writes its task list with, and the session document the list is kept in. |
| `@maota/tool-subagent` | [`subagent/tool-subagent`](subagent/tool-subagent/) | `tool.task` | The delegation: the tool that hands one sub-task to an agent with a context of its own, and brings back only the message it ends with. |
| `@maota/tools` | [`agent/tools`](agent/tools/) | `tools` | The tool registry every tool is listed and dispatched through. |
| `@maota/agent-loop` | [`agent/agent-loop`](agent/agent-loop/) |  | The loop engine `agent-core` runs in its own process: the model call, the tool round, the exit reason. |
| `@maota/app-boot` | [`boot/app-boot`](boot/app-boot/) |  | Decides which config file and which kernel binary one launch uses, and generates a profile's config and links. |
| `@maota/base` | [`bundle/base`](bundle/base/) |  | The row list the `default` profile mounts. |
| `@maota/fs` | [`fs/fs`](fs/fs/) |  | The workspace library the file tools share: path containment and atomic writes. |
| `@maota/hook-protocol` | [`hooks/hook-protocol`](hooks/hook-protocol/) |  | The hook dialect: the twelve events, the payload each carries, what a hook answers with, and how several answers fold into one. |
| `@maota/host` | [`boot/host`](boot/host/) |  | Spawns the kernel and drives it over stdio: invoke, streams, events, shutdown. |
| `@maota/plugin-kit` | [`plugin-kit`](plugin-kit/) |  | The protocol the packages above import: framing, channels, `runPlugin`, tool declaration and the config-key and schema checks. |
| `@maota/shell` | [`shell/shell`](shell/shell/) |  | The command seam: the request and result shapes and `parseExitStatus`. |
| `@maota/web-bundle` | [`bundle/web`](bundle/web/) |  | The single row the `serve` profile adds to the `default` set. |

<a id="bundles"></a>
A profile's rows come from those two lists, and each bundle declares its row packages as dependencies: `base` mounts the thirty rows it owns in that order, with `hmr` disabled, and `web` adds the one row it owns, so only the `serve` profile mounts it. The launcher holds one list per profile (`default` names `base`, `serve` names `base` then `web`), resolves the rows from those bundles, and keeps the list a profile actually uses in `$MAOTA_HOME/profiles/<name>/package.json`, so adding or dropping one never touches this repository. The `web` capability itself comes from `apps/web`, which sits outside this tree.

`pnpm check:plugins` runs every spawned package's entry with `--check` and validates `provides`, `injects`, `registrations`, `hostCalls`, `configKeys` and `selfCheck` without a kernel.

<a id="related-documentation"></a>
## Related documentation

- [Architecture](../docs/architecture.md): the component map and the launch path.
- [maota CLI](../apps/cli/README.md): the front end that launches these packages.
- [agent](../agent/README.md): how the agent package and its loop divide the work.
- [interaction](interaction/README.md): the gate a tool asks before it acts.
- [dev.hmr](boot/hmr/README.md): the watcher behind event-driven hot reload.

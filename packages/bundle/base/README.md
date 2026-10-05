---
description: "The base row list: the thirty plugin rows the default profile mounts and the dependency graph they declare."
kind: "package-reference"
---

# base

English | [中文](README.zh.md)

## Summary

This package holds the list of rows a profile mounts and declares every row package as a dependency. The launcher reads that list, resolves each package from this bundle's own dependency tree, and turns it into a generated `blmoadll.toml` plus a link per package inside the profile directory. Row order is not load-bearing: startup order comes from each plugin's `injects` and `registrations` declarations. `hmr` is the one row that ships disabled.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further exploration](#further-exploration)

-----

<a id="use-this-package"></a>
## Use this package

```toml
[[patch]]
insert = [
  { id = "tools", name = "@maota/tools" },
]
```

| File | Shape | Meaning |
|---|---|---|
| `patch.toml` | `[[patch]]` list | Ordered insert and update operations. `insert` adds rows; `id` updates an existing row. `config` replaces the whole table and `name`, when present, must match. |

### The rows

| id | Package | Capability |
|---|---|---|
| `model-openai` | `@maota/model-openai` | `model.adapter.openai` |
| `model-anthropic` | `@maota/model-anthropic` | `model.adapter.anthropic` |
| `model-router` | `@maota/model-router` | `model` |
| `settings` | `@maota/settings` | `settings` |
| `i18n` | `@maota/i18n-native` | `i18n` |
| `jobs` | `@maota/jobs` | `jobs` |
| `pwsh-local` | `@maota/pwsh-local` | `shell` |
| `permission` | `@maota/permission` | `permission` |
| `tool-pwsh` | `@maota/tool-pwsh` | `tool.pwsh` |
| `tool-jobs` | `@maota/tool-jobs` | `tool.job_output`, `tool.job_list`, `tool.job_kill` |
| `tool-fs` | `@maota/tool-fs` | `tool.read`, `tool.write`, `tool.edit` |
| `tool-fs-search` | `@maota/tool-fs-search` | `tool.glob`, `tool.grep` |
| `tool-todo` | `@maota/tool-todo` | `tool.todo_write` |
| `tool-subagent` | `@maota/tool-subagent` | `tool.task` |
| `tools` | `@maota/tools` | `tools` |
| `tool-skill` | `@maota/tool-skill` | `tool.skill` |
| `skill` | `@maota/skill` | `skill` |
| `skill-filesystem` | `@maota/skill-filesystem` | `skill.filesystem` |
| `skill-bundled` | `@maota/skill-bundled` | `skill.bundled` |
| `session` | `@maota/session` | `session` |
| `workspace` | `@maota/workspace` | `workspace` |
| `hooks` | `@maota/hooks-native` | `hooks`, with an 80 KiB context budget |
| `context-agent-instructions` | `@maota/context-agent-instructions` | `hook.agent-instructions` |
| `memory` | `@maota/memory` | `hook.memory`, `tool.memory` |
| `system-prompt` | `@maota/system-prompt` | `system-prompt` |
| `agent-core` | `@maota/agent-core` | `agent.loop` |
| `agent-runner` | `@maota/agent-runner` | `agent.runner` |
| `schedule` | `@maota/schedule` | `schedule` |
| `tool-cron` | `@maota/tool-cron` | `tool.cron_create`, `tool.cron_list`, `tool.cron_update`, `tool.cron_delete`, `tool.cron_run_now` |
| `hmr` | `@maota/hmr` | `dev.hmr`, disabled by default |

### Order

Registries start before the providers that register with them: `tools` precedes `tool.*`, `skill` precedes `skill.*`, and `model` precedes `model.adapter.*`. `i18n` optionally injects `settings`; the web plugin injects `settings` and `workspace`. `agent-core` injects `model`, `tools`, `session`, `system-prompt`, `skill`, `permission` and `hooks`; `agent-runner` injects `agent.loop`; `schedule` injects `agent.runner`; and `tool-cron` registers with `tools` while injecting `schedule`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

### Source map

| File | Role |
|---|---|
| [`patch.toml`](patch.toml) | `PluginRow` and `rows`. |
| [`src/index.ts`](src/index.ts) | Re-exports. |

### How a row becomes a running plugin

`app-boot` reads `maota.bundle.patch` out of this package's `package.json`, imports that file, and walks the array. It rejects a duplicate `id` across bundles, resolves each named package from this bundle's `dependencies`, links that package into the profile directory so the kernel can resolve it, and renders the generated `blmoadll.toml` from the list. A row with a `config` object is rendered as that plugin's config block, and a disabled row is written as disabled.

### Where a user overrides things

The generated file is not the file a user edits. The profile directory also holds `blmoadll.local.toml`, which extends the generated one, and that is where a config block such as `[plugins.tools.config]` belongs. Since a row names a package and nothing else, swapping a provider means editing the row list or the local layer, not editing this package.

A bundle is one list, and a profile mounts all of it or none, so dropping a single row means editing this array. Order is manual: nothing checks that a provider sits above its dispatcher, and a mistake shows up as a tool that is simply missing. A config block ships in the generated file only when the row carries one, and everything else belongs to the user's local layer. The disabled row is still written, so `hmr` appears switched off in a fresh config and turning it on needs no other change.

-----

<a id="further-exploration"></a>
## Further exploration

- [web bundle](../web/README.md): the row the serve profile adds to this list.
- [app-boot](../../boot/app-boot/README.md): the code that reads this list and generates a profile.
- [packages group](../../README.md): what each named package provides.
- [bundle group](../README.md): what a row list is.

---
description: "base 行清单：default profile 挂载的三十个插件行，以及它们声明的依赖图。"
kind: "package-reference"
---

# base

[English](README.md) | 中文

## 概述

这个包装着 profile 挂载的行清单，并把每一行点名的包声明成自己的依赖。启动器读取这份清单，从本组合包自己的依赖树里解析每个包，再把清单变成生成的 `blmoadll.toml`，并在 profile 目录里为每个包建一条链接。行顺序不是契约的一部分：启动顺序来自每个插件声明的 `injects` 与 `registrations`。`hmr` 是唯一一个带着 disabled 出厂的。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)

-----

<a id="use-this-package"></a>
## 使用本包

```toml
[[patch]]
insert = [
  { id = "tools", name = "@maota/tools" },
]
```

| 文件 | 形状 | 含义 |
|---|---|---|
| `patch.toml` | `[[patch]]` 列表 | 按顺序执行 insert 与 update。`insert` 新增行；带 `id` 的表更新已有行；`config` 整体替换，`name` 出现时必须匹配。 |

### 这些行

| id | 包 | 能力 |
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
| `tool-jobs` | `@maota/tool-jobs` | `tool.job_output`、`tool.job_list`、`tool.job_kill` |
| `tool-fs` | `@maota/tool-fs` | `tool.read`、`tool.write`、`tool.edit` |
| `tool-fs-search` | `@maota/tool-fs-search` | `tool.glob`、`tool.grep` |
| `tool-todo` | `@maota/tool-todo` | `tool.todo_write` |
| `tool-subagent` | `@maota/tool-subagent` | `tool.task` |
| `tools` | `@maota/tools` | `tools` |
| `tool-skill` | `@maota/tool-skill` | `tool.skill` |
| `skill` | `@maota/skill` | `skill` |
| `skill-filesystem` | `@maota/skill-filesystem` | `skill.filesystem` |
| `skill-bundled` | `@maota/skill-bundled` | `skill.bundled` |
| `session` | `@maota/session` | `session` |
| `workspace` | `@maota/workspace` | `workspace` |
| `hooks` | `@maota/hooks-native` | `hooks`，上下文预算 80 KiB |
| `context-agent-instructions` | `@maota/context-agent-instructions` | `hook.agent-instructions` |
| `memory` | `@maota/memory` | `hook.memory`、`tool.memory` |
| `system-prompt` | `@maota/system-prompt` | `system-prompt` |
| `agent-core` | `@maota/agent-core` | `agent.loop` |
| `agent-runner` | `@maota/agent-runner` | `agent.runner` |
| `schedule` | `@maota/schedule` | `schedule` |
| `tool-cron` | `@maota/tool-cron` | `tool.cron_create`、`tool.cron_list`、`tool.cron_update`、`tool.cron_delete`、`tool.cron_run_now` |
| `hmr` | `@maota/hmr` | `dev.hmr`，缺省关着 |

### 顺序

注册表先于向它注册的 provider 启动：`tools` 先于 `tool.*`，`skill` 先于 `skill.*`，`model` 先于 `model.adapter.*`。`i18n` 可选注入 `settings`；web 插件注入 `settings` 与 `workspace`。`agent-core` 注入 `model`、`tools`、`session`、`system-prompt`、`skill`、`permission` 与 `hooks`；`agent-runner` 注入 `agent.loop`；`schedule` 注入 `agent.runner`；`tool-cron` 向 `tools` 注册，同时注入 `schedule`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

### 源码地图

| 文件 | 职责 |
|---|---|
| [`patch.toml`](patch.toml) | `PluginRow` 与 `rows`。 |
| [`src/index.ts`](src/index.ts) | 再导出。 |

### 一行怎么变成一个跑着的插件

`app-boot` 从本包 `package.json` 里读 `maota.bundle.patch`，import 那个文件，然后走一遍数组。它会拒绝跨 bundle 重复的 `id`，从本组合包的 `dependencies` 里解析每个点名的包，把那个包链接进 profile 目录好让内核解析得到，并由这份清单渲染出生成的 `blmoadll.toml`。带 `config` 对象的行会渲染成那个插件的配置块，被禁用的行会写成 disabled。

### 用户在哪里覆盖

生成的那个文件不是用户改的文件。profile 目录里还有 `blmoadll.local.toml`，它 extends 生成的那份，而 `[plugins.tools.config]` 这样的配置块就该写在那里。由于一行只点一个包，别的不写，换 provider 意味着改行清单或改本地层，而不是改这个包。

一个 bundle 就是一份列表，profile 要么整份挂载要么完全不挂载，所以删掉一行就意味着改这个数组。顺序靠人手维护：没有东西检查 provider 是否排在它的派发器之前，写错的后果是一个工具干脆不见了。配置块只在行自带配置时才写进生成文件，其余设置属于用户的本地层。被禁用的行仍然会被写出来，所以 `hmr` 在全新配置里是关闭的，打开它不需要别的改动。

-----

<a id="further-exploration"></a>
## 进一步探索

- [web bundle](../web/README.zh.md)：serve profile 在这份清单之上追加的那一行。
- [app-boot](../../boot/app-boot/README.zh.md)：读这份清单并生成 profile 的代码。
- [packages/ ，插件树](../../README.zh.md)：被点名的每个包各提供什么。
- [bundle 组](../README.zh.md)：行清单是什么。

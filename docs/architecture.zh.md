# 架构

[English](architecture.md) | 中文

MaoTa 是一个插件式 agent 框架：Rust 内核把每个插件当自己的子进程跑，在它们之间路由能力，对外只露一套 stdio 协议；Node 这一侧是拉起并驱动那个内核的前端。这一页是地图，不是契约；下面每个组件的细节都由它自己的 README 或源码文件负责。

## 组件

| 组件 | 它是什么 | 契约在哪 |
|---|---|---|
| `apps/cli` | `maota` 启动器：交互、一次性、`serve` 与 `check`。 | [README](../apps/cli/README.zh.md) |
| `apps/web` | web 插件：一个 HTTP 服务同时提供界面与宿主接口。只有 `serve` profile 会拉起它。 | `apps/web/src/index.ts` |
| `packages/boot/app-boot` | 为一次启动定下配置文件与内核二进制。 | [README](../packages/boot/app-boot/README.zh.md) |
| `packages/boot/host` | 拉起内核并在 stdio 上驱动它。 | [README](../packages/boot/host/README.zh.md) |
| `packages/boot/hmr` | 开发期监视插件：为它盯着的路径发布 `dev.source.changed`。 | `packages/boot/hmr/src/index.ts` |
| `packages/interaction/permission` | 审批闸门：会话跑在哪一档、还在等回答的问题，以及把每次提问和它的决定配成对的审计文件。 | [README](../packages/interaction/permission/README.zh.md) |
| `packages/hooks` | 十二个 hook 点：持有那十二个事件的方言包，以及发现 hook 插件、合并它们答案的引擎。 | [十二个 hook 点](user/hooks.zh.md) |
| `packages/todo` | 模型持有的计划：它写下任务清单用的工具，以及清单所住的会话文档。 | [README](../packages/todo/tool-todo/README.zh.md) |
| `packages/subagent` | 委派：把一件子任务交给一个自带上下文的代理的那个 `task` 工具。 | [子代理](user/subagent.zh.md) |
| `packages/agent/system-prompt` | 提示词：部署方把段落与变量组装进去的那个注册表，以及循环每轮读一次的组装。 | [系统提示词](user/system-prompt.zh.md) |
| `packages/agent/agent-runner` | turn 协调器：session 串行、系统消息顺序、唤醒预算与 `agent.turn.*` 事件。 | [README](../packages/agent/agent-runner/README.zh.md) |
| `packages/jobs` | 进程内后台任务注册表，以及模型读写、列出和停止任务的工具。 | [README](../packages/jobs/README.zh.md) |
| `packages/schedule` | 持久提醒与自动化，以及面向模型的 `cron_*` 管理工具。 | [README](../packages/schedule/README.zh.md) |
| `packages/model` | 模型路由层：内部模型协议、目录与路由器、保留的 `api` 兼容适配器、OpenAI 与 Anthropic 边缘适配器，以及 scripted 测试适配器。 | `packages/model/*/src/index.ts` |
| `packages/*` | 内核插件：api、model-*、pwsh-local、permission、tool-pwsh、tool-fs、tool-fs-search、tool-todo、tool-subagent、skill-filesystem、skill-bundled、skill、tool-skill、tools、session、system-prompt、hooks 与 agent。 | `packages/<组>/<包>/src/index.ts`，例如 `packages/agent/agent-core/src/index.ts` |
| `packages/bundle/*` | 组合包：每个按包名列出某个 profile 挂载的插件行，并把这些插件包声明成自己的依赖。 | [packages README](../packages/README.zh.md#bundles) |
| `blmoadll` 二进制 | 内核本身以及它的 stdio 协议。 | `blmoadll` 仓库 |

## 启动链路

1. `maota` 定下配置文件与内核二进制。
2. 它拉起内核，等内核答出能力表。
3. 内核把 `[plugins.<id>]` 每一项当自己的子进程起起来，按各插件的 `provides` 路由能力。
4. 前端 invoke 能力：CLI 与 Web 驱动 `agent.runner`，Web 还通过自己的桥使用 `session`、`settings` 与 `workspace`；runner 负责串行 turn 并调用 `agent.loop`。
5. 停机时内核收到 `ui_quit` 或 `kernel_exit`，停掉插件并以宿主报出的码退出。

开发运行还可能带上 `hmr` 插件（生成的那一行默认关着）：它把改动过的路径发布成 `dev.source.changed`。CLI 从每个 `kernel.plugin.started` 里读出解析后的入口，走一遍入口的静态 import 图，维护一份"文件 → 插件"索引；于是每条改动路径都精确落到 import 它的那几个插件上，再让内核以 `reason: "source"` 重启它们。

## 配置分层

- 仓库根什么都不放：启动器读 `$MAOTA_HOME`，缺省 `~/.maota`。每个 profile 自带一个 `node_modules`，里面为每一行放一条链接，而那个包从持有该行的组合包自己的依赖树里解析。
- 启动器一次只选一个 profile：serve 用 serve（base 加 web），其余命令用 default（只 base）。
- $MAOTA_HOME/profiles/<name>/blmoadll.toml 由该 profile 列出的组合包生成。每一行只写包名，内核从该 profile 自己的 `node_modules` 里解析它，所以只有行变了才会重写这个文件。它是插件集：有哪些插件、怎么起；各插件的默认值由插件自己持有。
- `$MAOTA_HOME/profiles/<name>/blmoadll.local.toml` 是机器自己的那层：网关、模型、钥匙。它 `extends` 生成的那份，并且赢过它。
- `disabled = true` 的行照样解析、照样参与合并，但内核从不拉起它，能力表里也没有它。后面的层写 `false` 就启用，内核的 reloader 自己会发现，不用重启。
- 后加载的层赢：表逐键合并，数组整体替换。
- 拼错的 config 键会被 `pnpm run check:config` 点名，只报不拦。

## 边界

- 插件之间从不直接调用；都走内核路由的能力。
- 审批闸门是插件，不是内核功能：内核像路由其它能力一样路由 `permission`，从不看命令。
- Node 宿主从不解释插件的配置值；它只挑路径、说协议。
- `apps/web` 和其它插件一样是插件；浏览器那一侧不持有任何内核特权。
- `agent.runner` 是唯一 turn 入口。直接调用 `agent.loop` 会绕过队列、唤醒预算与系统消息投递。
- 后台任务只存在于进程内。持久计划定义保存在 `$MAOTA_HOME/schedules.json`。
- 内核从不监视源码；它只看自己的配置，并在宿主开口时重启被点名的那个插件。

## 相关文档

- [boot 包组](../packages/boot/README.zh.md)
- [fs 包组](../packages/fs/README.zh.md)
- [shell 包组](../packages/shell/README.zh.md)
- [interaction 包组](../packages/interaction/README.zh.md)
- [权限闸门](user/permission.zh.md)
- [系统提示词](user/system-prompt.zh.md)
- [十二个 hook 点](user/hooks.zh.md)
- [子代理](user/subagent.zh.md)
- [bundle 包组](../packages/bundle/README.zh.md)
- [tools 分发器](../packages/agent/tools/README.zh.md)
- [jobs 包组](../packages/jobs/README.zh.md)
- [schedule 包组](../packages/schedule/README.zh.md)
- [后台任务](user/background-tasks.zh.md)
- [计划任务](user/scheduled-tasks.zh.md)
- [maota CLI](../apps/cli/README.zh.md)
- [防御性模式](defensive-patterns.zh.md)

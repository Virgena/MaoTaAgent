# `@virgena/maota`

[English](README.md) | 中文

`maota` 是 MaoTa 唯一的 Node 启动器：它定下这次运行读哪个配置文件、跑哪个内核二进制，把 blmoadll 内核当子进程拉起来，并在内核的 stdio 协议上驱动它。[`src/args.ts`](src/args.ts) 负责命令语法，[`src/index.ts`](src/index.ts) 负责入口模式与终端渲染。未知选项、选项缺值、`serve` 或 `check` 多带参数、配置文件不存在，都以非零码退出。

## 目录

- [入口模式](#entry-modes)
- [选项](#options)
- [退出码](#exit-codes)
- [配置解析](#configuration-resolution)
- [开发期热重载](#dev-hot-reload)
- [开发](#development)

-----

<a id="entry-modes"></a>
## 入口模式

| 命令 | 行为 |
|---|---|
| `maota` | 交互：TTY 下带 `> ` 提示符，否则逐行读 stdin。 |
| `maota <问句>` | 一次性：问一次，打印最终回答，退出。 |
| `maota serve` | 常驻：启动后报出 web 插件的 URL，一直待到 Ctrl-C。 |
| `maota check` | 只检查：跑内核自己的 `--check`，把它的退出码透传出去。 |
| `maota jobs list\|show\|kill` | 查看或停止当前会话的后台任务。 |
| `maota cron list\|add\|update\|remove\|run\|pause\|resume` | 管理持久计划。`add` 与 `update` 接收 JSON 对象。 |
| `maota plugin add\|remove\|update\|why` | 通过 profile 内的 pnpm 安装、移除、更新或检查组合包。 |
| `maota --help` | 打印用法并退出 0。 |
| `maota --version` | 打印 `maota <版本>` 并退出 0。 |

由第一个位置参数决定模式：`serve` 与 `check` 后面不能再带参数；`jobs` 与 `cron` 接收一个 action 及其参数；其它位置参数算一次性问句，后面的参数用空格拼起来。
`maota check` 打印的就是内核打印的内容。内核因为某个 inject 或 registration service 没有提供者而扣住的插件、以及用 `disabled = true` 关掉的行，都只算警告：check 仍然退出 0，报告用 `disabled` 与 `blocked` 两个字段列出它们（内核在 `docs/PROTOCOL.md` 第 14.1 节记录这两个字段）。

子代理的活发生在派出它的那一轮里面，所以 CLI 把它缩进打印，而不是揉进这一轮自己的输出：本轮驱动的会话所对应的每条 `agent.subagent.*` 事件都变成一行，例如 `  [explore sub-3f2a] -> read src/a.ts`。子代理别的东西都不上终端，它的答案仍然以那次 `task` 调用的结果形式回来。

<a id="options"></a>
<a id="jobs-and-schedules"></a>
## 后台任务与计划任务

`maota jobs list` 列出当前 session 的后台任务。`show <id>` 读取新输出与状态，`kill <id>` 请求停止。

`maota cron list` 列出计划。`add` 与 `update` 接收 JSON 对象；CLI 会注入当前 session 与 cwd。`remove <id>` 删除，`run <id>` 立即运行，`pause` 与 `resume` 切换 enabled。

这些命令只调用 `jobs` 与 `schedule` capability，不直接读写任务文件。

## 插件组合包

`maota plugin --profile <name> add <spec>` 用 profile 内的 pnpm 安装组合包，写入 profile 的 `dependencies`；如果包声明了 `maota.bundle.patch`，还会加入 `maota.profile.bundles`。`remove` 会同时撤销这两项。`update` 转发给 pnpm 并重新同步组合包声明。`why` 原样转发。相对路径以调用目录为锚点，`pnpm` 必须在 `PATH` 上。

## 选项

| 选项 | 含义 |
|---|---|
| `--profile <name>` | 启动哪个 profile：`serve` 子命令用 `serve`，其余用 `default`。 |
| `--kernel <bin>` | 要拉起来的内核二进制。 |
| `--session <id>` | 会话 id，缺省 `cli`。 |
| `--json` | 只在 `check` 下有效：让内核输出 JSON 报告。 |
| `-h`, `--help` | 打印用法并退出 0。 |
| `-v`, `--version` | 打印版本并退出 0。 |

同一行里 `--help` 与 `--version` 压过其它一切。

<a id="exit-codes"></a>
## 退出码

| 码 | 含义 |
|---|---|
| 0 | 正常退出，包括内核 shutdown 返回 0 的情况。 |
| 1 | 运行期失败：内核没起来、流里报了错，或内核异常退出。 |
| 2 | 用法或配置错误：未知选项、选项缺值、`serve` 或 `check` 多带参数、配置文件不存在。 |
| 其它 | 内核 `shutdown` 返回什么就透传什么。 |

<a id="configuration-resolution"></a>
## 配置解析

两个输入都在重启任何东西之前由 [`@maota/app-boot`](../../packages/boot/app-boot/README.zh.md) 定下：

- 配置文件：`--config`，其次 `BLMOADLL_CONFIG`，其次存在的 `$MAOTA_HOME/profiles/<profile>/blmoadll.local.toml`，否则是同目录里生成的那份 `blmoadll.toml`；`MAOTA_HOME` 缺省 `~/.maota`。首次运行会写下 profile 清单，按该 profile 列出的组合包生成配置，并为每一行在 profile 自己的 `node_modules` 里建一条指向该包的链接，同时往 stderr 打一行 `MaoTa: wrote <path>`。显式给的 `--config` 从不写入；文件不在，内核还没起来就以 2 退出。
- Profile：`--profile`，其次 `serve` 子命令用 `serve`，其余命令用 `default`。profile 是 `$MAOTA_HOME/profiles` 下的一个目录；它的 `package.json` 记着启动时读回的组合包列表，所以光在 home 目录里就能改插件集。
- 内核二进制：`--kernel`，其次 `BLMOADLL_BIN`，其次安装好的 `@virgena/blmoadll` 二进制，最后隔壁 `blmoadll` 的 debug 产物。

内核 stderr 上的日志行也走 stderr：`serve` 丢掉 `info` 行、留下的前缀是 `MaoTa`，其它模式前缀是 `[kernel]`。

<a id="dev-hot-reload"></a>
## 开发期热重载

生成的配置里那一行 `hmr` 插件是关着的。在机器层打开它，并把 `roots` 指向你在改的目录：

```toml
[plugins.hmr]
disabled = false
name = "@maota/hmr"
[plugins.hmr.config]
roots = ["<repo>/apps", "<repo>/packages"]
```

那个插件监视 `roots`，把变动的路径以 `dev.source.changed` 发出去。CLI 对每条 `kernel.plugin.started` 事件读出该插件解析后的 `cwd` 与入口参数，走过这个入口的静态 import 图（[`src/graph.ts`](src/graph.ts)），记下哪个插件 import 了哪个文件。之后每条 `dev.source.changed` 路径都会解析到恰好 import 它的那些插件，这些插件以 `reason: "source"` 重启（[`src/hmr.ts`](src/hmr.ts)）。像 `packages/plugin-kit/src/index.ts` 这样的共享文件会重启每个 import 它的插件；没人 import 的路径什么也不重启。不写这一行就什么都不监视，所以生产运行里没有 watcher，CLI 自己也不额外监视。
当内核因为某个 inject 或 registration service 缺席而扣住插件时，会发布 `kernel.plugin.blocked`，带上插件和它在等的那些能力，CLI 会打一行 stderr：`MaoTa: <plugin> waits for <capability>`。插件在其提供者消失时也会被重载器停进同一个等待态，把提供者带回来的那次重载会重新启动它。

<a id="development"></a>
## 开发

从源码直接跑；这个应用没有构建步骤：

| 命令 | 效果 |
|---|---|
| `pnpm boot` | 交互或一次性，看终端允许哪种。 |
| `pnpm boot "问句"` | 带问句的一次性。 |
| `pnpm web` | 等价于 `maota serve`。 |
| `pnpm check:config` | 等价于 `maota check`。 |
| `pnpm cli:smoke` | 语法与用法文本的冒烟测试，不需要内核。 |

`pnpm boot` 会把脚本名后面的内容原样转给 `maota`，所以 `pnpm boot serve`、`pnpm boot check --json`、`pnpm boot --session web "问句"` 也都能用。

`package.json` 里的 `bin.maota` 是为将来安装声明的；本仓库里没有任何东西把这个 bin 链进 `node_modules`，所以请用 `node` 直接跑这个文件，或走上面的 `pnpm` 脚本。

第一次 Ctrl-C 让内核以 `ui_quit` 停机，并以内核返回的码退出；停机在路上时后续的 Ctrl-C 不再重复。`check` 故意绕开 `boot()`，用内核自己的检查器并继承 stdio，因此诊断与退出码都属于内核。

七条事实界定了这个启动器。选项从不抵达插件，因为每一项插件设置都在 profile 的 `blmoadll.toml` 或它旁边的 `blmoadll.local.toml` 里，而 `serve` 自己没有选项，web 端口只来自 `[plugins.web.config]`。web 插件始终不监听的 `serve` 会一直等下去，因为没有启动期限。会话只能用 `--session` 指认。导入图是静态读出来的，所以只能通过计算出来的 specifier 或路径别名到达的模块不在图里，改它不会重启任何东西。热重载重启整个插件进程，所以插件内部没有任何东西能活过一次重启。这一切都要求 `hmr` 行是打开的，而生成的那一行是关闭的。

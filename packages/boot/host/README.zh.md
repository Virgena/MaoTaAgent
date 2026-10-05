---
description: "从 Node 拉起 blmoadll 内核并驱动它：在内核的 stdio 协议上 invoke 能力、收流、订阅事件、停机。"
kind: "package-reference"
---

# @virgena/maota-boot-host

[English](README.md) | 中文

## 概述

把一个 blmoadll 内核当子进程拉起来，再从 Node 这一侧跟它说话：要能力表、invoke 一个能力、消费一条分片流、订阅内核事件、带原因让它停机。帧、背压、取消，以及内核死掉时你看到的那段失败说明都归宿主管，所以调用方永远不碰裸 stdio。任何 Node 前端都可以用它；今天的调用方是 CLI 与冒烟测试。它不定路径、不读配置。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)

-----

<a id="use-this-package"></a>
## 使用本包

任何驱动内核的 Node 前端都用它：boot 一次，然后通过拿到的宿主 invoke、收流、订阅、停机。

### 拉起内核

`boot()` 在内核答出 `capabilities` 之后才 resolve，所以拿到的宿主是一个已经接好线的活进程：

```ts
import { boot } from "../../boot/host/src/index.ts";

const kernel = await boot(configPath, { bin });
const table = await kernel.capabilities();
const stream = await kernel.invoke("agent.loop", "run", { input: "hi" }, { stream: true });
for await (const chunk of stream) console.log(chunk.data);
process.exit(await kernel.shutdown("ui_quit"));
```

### 选项

| 选项 | 缺省 | 含义 |
|---|---|---|
| `bin` | `BLMOADLL_BIN`，再退到 `blmoadll` | 要拉起来的内核二进制。 |
| `cwd` | 父进程的 cwd | 子进程的工作目录。 |
| `env` | `process.env` | 子进程的环境变量。 |
| `onLog` | 直接把 stderr 透出去 | 内核写到 stderr 的每条 JSON 日志行的回调。 |

### 调用面

| 调用 | 含义 |
|---|---|
| `capabilities()` | 能力表：能力 id 到提供方与版本。 |
| `invoke(capability, method, params?)` | 一来一回；失败以 `KernelError` reject。 |
| `invoke(capability, method, params, { stream: true })` | 以 `AsyncIterable` 给出的分片流；提前跳出即取消这次调用。 |
| `subscribe(patterns)` | 匹配到的内核事件构成的 `AsyncIterable`。 |
| `on(patterns, handler)` | 同一批事件走回调；返回退订函数。 |
| `restart(plugin, reason?)` | 点名停掉一个插件再把它起回来；`reason` 是 `source` 或 `manual`，只出现在事件里。 |
| `shutdown(reason)` | 请求停机，然后 resolve 出子进程的退出码。 |
| `exited` | 不求停机，只拿子进程退出码的 promise。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

本节说明宿主怎么同一条子进程、同一条 stdio 管道打交道；它暴露哪些调用见 [使用本包](#use-this-package)。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `boot`、`Host`、`KernelError`、`Queue`、分帧辅助函数、`Chunk` 与 `Event` 类型 |

### 分帧、背压与取消

两个方向都用内核的帧格式：一段 `Content-Length` 头、一个空行、一个 JSON 体。回包按 id 结掉挂起的调用；`$/stream/chunk`、`$/stream/error` 与 `$/event` 是通知。消费者还没开始迭代就到的分片会按 stream id 寄存，等它开始时补发；始终没有消费者的流会一直寄存到进程结束。排队字节超过 1 MiB 就暂停子进程 stdout，低于 256 KiB 再恢复。中途离开一条流会给它发 `$/cancel`。子进程死掉时，宿主保留最后 32 行 stderr，找出最后一行看起来像内核报告的行，把它的 `errors[]` 摊进抛出的消息里。提供方半路死掉，之后调它的能力会以 `-32011` 失败；不认识的能力以 `-32010` 失败。

### 重启与插件身份

`kernel.plugin.started` 带上 `trigger`（`boot`、`config`、`source`、`manual`）与该插件的 `cwd`、`command`、`args`（loader 解析之后的值），宿主正是靠这些把改动过的文件映射回拥有它的插件。`restart` 复用重载那条管线，顺序是先停后起：旧实例收到 `shutdown{reason: "reload"}` 并必须离开（超过它的 `shutdown_grace_ms` 就强杀），之后才对这一个插件跑同一套 spawn、initialize、校验、换表、start。起不来的插件保持缺席，能力调用持续回 `-32011`，直到下一次 `restart` 成功。订阅会带上 `replay`，因此宿主订阅时已经在跑的插件也会自报一次。
某个插件必需的能力没人提供，不算启动失败：内核照样把它拉起来、跑完 initialize，然后把它扣在等待态。它的 `provides` 不进路由表，所以调它本该提供的能力会以 `-32010` 失败，`kernel.plugin.blocked` 则带上这个插件和它在等的那些能力 id。`replay` 也会补发这些等待中的插件。一次重载让某个正在跑的插件失去提供者时，它进入的是同一个等待态：它带着 `trigger: config` 被停掉，把提供者带回来的那次重载再把它启动起来。配置里用 `disabled = true` 关掉的行是这件事的另一半：它不启动、也不进表，上层配置把它覆盖成 `false` 就会把它带起来。内核 `--check` 的报告用 `disabled`（插件 id 列表）与 `blocked`（插件 id 到缺失的能力 id）记录这两种情况，并只算警告，所以只有这些问题的配置仍然退出 0。
四条事实界定了这个 host。模式匹配整个主题分段：`*` 匹配一个分段，`**` 永远不匹配。订阅之前发布的事件不会重放，只有一个例外，`subscribe` 带 `replay`，所以启动之后建立的订阅会被告知每一个已经在运行的插件与每一个已经在等待的插件。抛错的处理器会结束自己的订阅，而失败不会报到别处。`shutdown` 总是 resolve，所以一个忽略请求的内核会让调用方一直等到进程退出；`restart` 只替换被点名的那个插件。



<a id="further-exploration"></a>
## 进一步探索

- [boot 包组](../README.zh.md)：这个宿主所属的启动粘合层。
- [maota CLI](../../../apps/cli/README.zh.md)：决定改动文件该重启哪些插件的调用方。
- [架构](../../../docs/architecture.zh.md#launch-path)：宿主在启动链路里的位置。

-----

## 开发备注

待定：插件归属目前仍由 CLI 对每个入口做静态 import 扫描得出，因此只经算出来的 specifier 或路径别名才能到达的模块不可见，改它不重启任何东西。正在权衡的方向是让插件自报它真正加载过的文件，那样连这次扫描带这个天花板一起删掉。

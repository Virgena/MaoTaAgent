---
description: "One Node process that loads every eligible Node plugin over a single pipe to the kernel, and the crash reports that let the kernel attribute a death to a plugin."
kind: "package-reference"
---

# plugin-host

[English](README.md) | 中文

## Summary

内核通常为每个插件启动一个进程。这个包是另一种做法：一个子进程把每个合规的 Node 插件加载进同一个 V8 实例，在一条内核本来就在说的管道上复用它们的帧，并给每一帧打上插件标记。插件作者看不到它：包照旧调用 `runPlugin`。内核掌握策略（哪些行合规、何时重启、隔离哪个插件），这个包负责加载、打标，以及让归因成为可能的崩溃报告。

## Table of Contents

- [使用这个包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)

-----

<a id="use-this-package"></a>
## 使用这个包

启动器会替你写好这一行。没有任何代码把它当库导入。

```toml
[kernel.host]
command = "<node>"
args = ["<...>/@maota/plugin-host/lib/index.js"]
```

| 输入 | 含义 |
|---|---|
| stdin | 来自内核的 `Content-Length` 帧。带 `plugin` 的帧属于该插件；不带的是控制面。 |
| stdout | 发往内核的 `Content-Length` 帧。插件的每一帧都带 `plugin`，除它以外不许写 fd 1。 |
| `MAOTA_HOME` | V8 编译缓存所在的位置，位于其下的 `compile-cache`。放不下只影响启动时间，不影响正确性。 |

控制面属于内核，不属于插件。带 `plugin` 成员的帧不能调用它，内核会拒绝这类调用。

| 方法 | 方向 | 含义 |
|---|---|---|
| `$/host/load` | 内核到宿主 | 导入一个入口并绑定到该插件 id。回复要等 `serve()` 接管 definition 之后才发。 |
| `$/host/unload` | 内核到宿主 | 让插件关闭，关闭完成后回复。 |
| `$/host/kill` | 内核到宿主 | 停止向该插件投递，并报告它已消失。 |
| `$/host/ping` | 内核到宿主 | 看门狗的问题。 |
| `$/host/loading` | 宿主到内核 | 一次导入开始了，并指出插件，让紧随其后的崩溃有肇事者。 |
| `$/host/exited` | 宿主到内核 | 该插件的通道已关闭，附退出码。 |
| `$/host/failed` | 宿主到内核 | 导入或插件启动失败。 |
| `$/host/crash` | 宿主到内核 | 未捕获的错误，尽量归到当时正在运行的插件。 |
| `$/host/stuck` | 宿主到内核 | 一次没有按时完成的关闭。 |
| `$/host/fatal` | 宿主到内核 | 宿主本身无法继续，退出码 70。 |

改动这个包之前，有四条边界值得知道：

- 插件往 stdout 写会污染管道。这个宿主把 `process.stdout.write` 指向 stderr，于是误写的日志变成一条宿主日志，而不是一个坏帧。
- 共享宿主忽略插件行上的 `cwd`、`env` 和 `clear_env`，内核也只会把三条都不要求的行放进共享宿主。
- 所有 hosted 插件共享一个线程。同步死循环会卡住兄弟插件；内核的回答是杀掉并重启，而不是抢占。
- 重载一个 hosted 插件时，模块图会在带 generation 查询串的情况下重新求值（`module.registerHooks`），因此源码改动无需重启进程即可生效。

<a id="understand-the-implementation"></a>
## 理解实现

### 源码地图

| 文件 | 负责 |
|---|---|
| `src/index.ts` | 进程本身：stdin 分发、控制面、崩溃处理器、编译缓存。 |
| `src/members.ts` | 成员注册表：加载与卸载、接管、generation 查询、归因、关闭。 |
| `src/outbound.ts` | fd 1 上的唯一写者，一次写完一整帧。 |
| `src/control.ts` | 方法名和唯一的宿主错误码 `-32022`。 |

### 一次加载如何变成插件

`$/host/load` 记下插件和它规范化后的入口，发出 `$/host/loading`，然后在一个指明该插件的 `AsyncLocalStorage` 作用域里导入入口。插件模块照旧调用 `runPlugin`；`plugin-kit` 的适配器把调用方模块与入口比较，只有匹配的那一个能占住位置。因此，一个在自己的顶层调用 `runPlugin` 的依赖会保持惰性，而不是抢走位置。导入返回后，只有确实接管了 definition，宿主才回复内核。

### 为什么重载能看到新代码

Node 按 URL 缓存模块。首次加载不带标记，这正是 hosted 插件可以共用依赖图的原因。重载会在入口 URL 上带 `maota=<plugin>&gen=<n>`，`module.registerHooks` 再把两者传播到被标记模块导入的每个文件。旧 generation 留在缓存里，交给回收器。

<a id="further-exploration"></a>
## 延伸阅读

- [boot 包组](../README.md)：这些包如何组成一次启动。
- [plugin-kit](../../plugin-kit/README.md)：这个宿主安装的适配器与传输层。
- [架构](../../../docs/architecture.md)：宿主在整个系统中的位置。

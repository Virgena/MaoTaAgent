---
description: "每个 MaoTa 包都 import 的插件协议：stdio 分帧、channel、能力路由、工具声明，以及配置键与 schema 检查。"
kind: "package-reference"
---

# plugin-kit

[English](README.md) | 中文

## 概述

每个 MaoTa 包都 import 它，而它不 import 任何一个包。它持有 stdio 的分帧格式，承载请求、回复、通知与取消通知的 channel，给包带来 `--check` 模式的 `runPlugin` 入口，工具用来声明参数的受控 JSON Schema 子集，以及把这些声明变成某个工具能力所答的四个方法的 `defineTools`。它自己不含任何工具、模型与配置。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)

-----

<a id="use-this-package"></a>
## 使用本包

### 写一个插件

| 导出 | 含义 |
|---|---|
| `runPlugin(definition)` | 每个被拉起的包都调用的入口。带 `--check` 时校验 `provides`、`injects`、`registrations`、`hostCalls`、`configKeys` 与 `selfCheck`，打印一行 JSON 后退出；否则在 stdio 上提供服务并执行注册生命周期。 |
| `Definition` | `provides`、`injects`、`registrations`、`hostCalls`、`configKeys`、`setup`、`start`、`methods`、`close` 与 `selfCheck`。 |
| `Call` | 方法收到的东西：`channel`、`signal`、`config`、`capabilities`、`caller`、`capability`、`method` 与 `stream`。 |
| `CallError` | 带 JSON-RPC 码与可选 `data` 的失败。 |
| `Channel` | 在内核连接上的 `call`、`stream`、`publish`、`subscribe`、`unsubscribe`、`notify` 与 `log`。 |
| `ProviderStream` | 为要了 `meta.stream` 的 invoke 推块。 |
| `installHostAdapter` / `hostAdapter` | 共享扩展宿主接入的缝：`isPluginEntry` 先问它，`serve` 把 channel 交给它，而不是绑定本进程的 stdio。 |
| `Transport` / `HostAdapter` | channel 的帧往哪去，以及宿主这一侧的形状。 |

### 共用一个进程

包从不询问自己跑在哪里。作为独立进程被拉起时，插件的读写与从前一样是 fd 1 和 fd 0。被共享宿主加载时，同一个 `runPlugin` 调用把 channel 交给宿主：帧带上插件 id，由宿主的唯一写者写出，`isPluginEntry` 也改成问宿主的入口清单，而不是看 `process.argv`。没有适配器时一切不变，所以用不用宿主是内核的选择，不是包的选择。

### 声明一个工具

`defineTools(blueprints)` 返回 `{ provides, methods }`，`methods` 里有 `describe`、`policy`、`run` 与 `classify`。

| 声明字段 | 含义 |
|---|---|
| `capability` | `tool.<name>`，内核路由用的那个能力。 |
| `paths` | 承载文件路径的参数名，每个都是 `string` 或 `string` 数组，好让调用方分辨哪些参数动过文件系统。 |
| `version` | 完整的 semver。 |
| `description` | 模型读到的那段文字。 |
| `parameters` | 按属性书写的字段，编译成一个 `{ type: "object", properties, required }`。 |
| `concurrency` | `"always"`、`"never"`，或 `{ safe(args) }`。 |
| `maxResultChars` | 正整数，或表示永不落盘的 `null`。不写则由分发器套用自己的预算。 |
| `run(args, call)` | 真正干活的部分。参数校验通过后才会跑。 |

| 参数字段 | 含义 |
|---|---|
| `type` | 取 `object`、`array`、`string`、`number`、`integer`、`boolean`、`null` 之一。 |
| `required` | 只允许出现在顶层。模型必须给。 |
| `description`、`enum`、`items`、`additionalProperties` | 常见的那些提示，受下面这个子集限制。 |
| `host` | 一个宿主来源：`session_cwd`、`session_id`、`call_id`、`subagent` 或 `session_touched`。由宿主在调用前填入，模型从来看不到它。类型是 `string`，若来源交出的是一份值而不是一个名字则为 `object`。 |

### 受控的 schema 子集

`assertSupportedJsonSchema` 只接受上面那份标量 `type` 清单、`properties`、`required`、布尔 `additionalProperties`、`items`、标量 `enum` 与 `const`、`oneOf`，以及 `description`、`title`、`default`。其余关键字一律是 `JsonSchemaError`，并把所有违规路径一次列全，所以同一份声明不会分两次失败。

`validateParameters(schema, args)` 返回带路径的违规清单，全部合法时返回空表。非空时工具方法以 `ToolArgsError` 作答，循环会把它变成模型可读的 `{ error }` 结果，而不是直接结束这一轮。

-----

<a id="understand-the-implementation"></a>
## 理解实现

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/frame.ts`](src/frame.ts) | stdio 分帧的读与写。 |
| [`src/channel.ts`](src/channel.ts) | `Channel`、`CallError`、路由与取消。 |
| [`src/plugin.ts`](src/plugin.ts) | `runPlugin`、`serve`、initialize / start / invoke / shutdown 握手、`ProviderStream`，以及未知配置键告警。 |
| [`src/glob.ts`](src/glob.ts) | `patternToRegExp`：文件工具与技能根共用的 `**`、`*`、`?` 匹配器。 |
| [`src/json-schema.ts`](src/json-schema.ts) | 受控子集：`assertSupportedJsonSchema` 与 `validateJsonSchemaValue`。 |
| [`src/tool.ts`](src/tool.ts) | `defineTools`、`ToolArgsError`、宿主参数，以及编译出的两份 schema。 |
| [`src/config-keys.check.ts`](src/config-keys.check.ts) | 未知键告警，由脚本检查。 |
| [`src/tool-schema.check.ts`](src/tool-schema.check.ts) | 声明与取值的检查，由脚本检查。 |

### 一份声明，两份 schema

一份声明的 `parameters` 会编译成两个对象。公开的那份成为模型可见的 `input_schema`；校验的那份把每个宿主参数都加成必填，只有允许缺席的来源除外。`describe` 返回公开 schema 加 `host_args`，于是宿主知道该注入什么，而模型始终看不到这些名字。宿主参数若写成 `required`、若类型既不是 `string` 也不是 `object`、若出现在顶层以下，都是声明期错误而不是运行期错误。

### 先校验，再运行

`run` 先校验，之后才调声明体。`classify` 同样先校验，并对非法参数或抛错的 `safe` 答 `safe: false`，所以一个参数注定非法的调用仍会单独执行，而不会和别的安全调用并排跑。

五条事实界定了这份契约。host 源是一个固定集合，`session_cwd`、`session_id`、`call_id`、`subagent` 与 `session_touched`，所以需要别的东西的工具没法声明它，而且只有可选的那些允许在参数里缺席。工具只有输入侧被描述，因为没有输出 schema。schema 子集是封闭的：`pattern`、`minimum`、`maximum` 与 `$ref` 会被拒绝，需要它们的工具得先改这里。`oneOf` 的分支只检查形状，不检查排他性。路由检查只有能力名与版本范围，因为没有权限层。

-----

<a id="further-exploration"></a>
## 进一步探索

- [tools](../agent/tools/README.zh.md)：把这些能力列出并调起来的那个分发器。
- [tool-fs](../fs/tool-fs/README.zh.md)：一个插件里放三个工具的完整例子。
- [packages/ ，插件树](../README.zh.md)：本包所属的那棵树。

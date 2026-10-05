---
description: "为一次 maota 启动定下读哪个配置文件、跑哪个内核二进制，并在首次运行时生成用户级配置。"
kind: "package-reference"
---

# @maota/app-boot

[English](README.md) | 中文

## 概述

定下每次启动都要的两个输入：要启动的配置文件、要拉起来的内核二进制。配置住在 `MAOTA_HOME/profiles/<name>`（缺省 `~/.maota`）；首次运行会写下 profile 清单与生成的 `blmoadll.toml`，同级目录里若有 `blmoadll.local.toml` 就压过那份生成物。内核二进制那个解析函数是对 options 对象做纯路径运算，所以调用方可以注入临时 home 或假环境，而不用碰真实环境。任何要拉起内核的 MaoTa 入口都可以用它；它从不读配置文件，因此也说不出挑中的那个文件是否有效。今天只有 CLI 在用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)

-----

<a id="use-this-package"></a>
## 使用本包

凡是需要决定读哪个配置文件、跑哪个内核二进制的入口，都先解析一次，再把两条路径交给宿主。这些函数都不读配置文件，所以解析出路径不代表那个文件有效。

### 解析两个输入

```ts
import { resolveConfigPath, resolveKernelBin, maotaHome } from "@maota/app-boot";

const home = maotaHome();
const config = await resolveConfigPath({ explicit: flagValue, profile: "serve", root: packageRoot });
const bin = resolveKernelBin({ explicit: flagValue });
```

### 优先级

| 输入 | 顺序，先命中者胜 |
|---|---|
| 配置文件 | `--config`、`BLMOADLL_CONFIG`、存在时的 `<home>/profiles/<profile>/blmoadll.local.toml`，否则是同目录里生成的那份 `blmoadll.toml` |
| Profile | 调用方给的 `profile`，缺省 `default` |
| 内核二进制 | `--kernel`、`BLMOADLL_BIN`、安装好的 `@virgena/blmoadll` 二进制、`<repo>/../blmoadll/target/debug/blmoadll.exe` |

显式给了 `--config`，或注入了 `home`，都不会写盘：这两种情况下文件缺失就是缺失。

-----

<a id="understand-the-implementation"></a>
## 理解实现

本节说明这两个解析函数内部怎么工作；它们接受哪些输入见 [使用本包](#use-this-package)。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `repoRoot`、`PROFILE_TEMPLATES`、`profileDir`、`ensureProfile`、`bundlesOfProfile`、`rowsOfBundles`、`resolvedRowsOfBundles`、`BundlePluginRow`、`renderConfig`、`linkPackage`、`entryOf`、`maotaHome`、`resolveConfigPath`、`resolveKernelBin` 与 options 类型 |

### 首次运行时的生成

这个模块从不读配置文件：分层（`extends`、后写的键赢、表逐键合并、数组整体替换）属于内核加载器。一个 profile 是 `<home>/profiles/<name>` 下的目录，里面有 `package.json` 与生成的 `blmoadll.toml`；清单记着该 profile 的 `maota.profile.bundles` 列表，而启动时读回的正是这份列表，所以人加减组合包不必改代码。每个组合包是一个包，它自己的清单指向它的行（`maota.bundle.patch`），并把行点名的包声明成依赖。行里写的是包名而不是路径，于是文件里没有任何钉住本机布局的东西。`ensureProfile` 在首次运行时写下清单，从持有该行的组合包自己的依赖树里解析每个包，给 profile 一个 `node_modules`、为每一行放一条链接，并且只在行发生变化时重写生成的那份，同时往 stderr 报一行 `MaoTa: wrote <path>`；调用方给 `resolveConfigPath` 传持有组合包依赖的根包，CLI 传自己的包根；指向已经正确的链接不动，存在但不是链接的会被拦下；解析失败一律出声：未知 profile、组合包没有行、同一个 id 被列两次、包解析不到，都会带着名字中断启动。`repoRoot` 从 `src/` 上推四层，所以解析函数在哪儿被 import 都能算对。`resolveKernelBin` 从 `@virgena/blmoadll` 包拿安装后的二进制路径，并接受 `installed` 覆盖以便测试。

四条事实界定了这个模块。解析不等于校验：只有内核自己的 `--check` 能说一份配置有效。最后一条内核回退是 Windows 形状的，硬编码了 `.exe` 后缀与 `debug` profile。插件只能经 bundle 挂载，所以把一个包加进仓库并不会运行它，除非某个 bundle 列出它。没有设置层与凭据层，因为会话根仍然属于 session 插件。

-----

<a id="further-exploration"></a>
## 进一步探索

- [boot 包组](../README.zh.md)：这两个解析函数所属的启动粘合层。
- [maota CLI](../../../apps/cli/README.zh.md)：唯一的调用方，以及喂给两个解析函数的 flag。
- [架构](../../../docs/architecture.zh.md#configuration-layering)：生成物与机器层如何叠起来。

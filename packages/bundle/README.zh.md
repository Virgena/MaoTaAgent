---
description: "bundle 组：一个 profile 挂载的两份行清单，以及启动器如何把它们变成生成的配置与链接好的 profile 目录。"
kind: "package-group"
---

# bundle/ ,  行清单

[English](README.md) | 中文

## 概述

profile 不逐个点名插件。它点名 bundle，而一个 bundle 是导出行清单、并把行点名的包声明成自己依赖的包。现有两个 bundle：每个 profile 都挂载的基础集，以及 `serve` profile 追加的 web bundle。这里没有任何东西被拉起，也没有任何东西答能力，所以 bundle 是持有依赖、带一个 manifest 键的库。在这一页看清哪份清单装了什么，再进目录看清单本身。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)

-----

<a id="packages"></a>
## 包

| 包 | 目录 | 行数 | 职责 |
|---|---|---|---|
| `@maota/base` | [`base`](base/) | 30 行，其中一行是 disabled | 每个 profile 都挂载的那一份。 |
| `@maota/web-bundle` | [`web`](web/) | 1 行 | `serve` profile 在基础集之上追加的那一行。 |

bundle 把清单声明在 `package.json` 的 `maota.bundle.patch` 下，把行点名的包声明在 `dependencies` 下，启动器从组合包本身读这两份信息。default profile 挂载 `base`；serve profile 挂载 `base` 再挂 `web-bundle`，于是多出一行，别的都不变。

<a id="related-documentation"></a>
## 相关文档

- [base](base/README.zh.md)：每个 profile 都挂载的那份行清单。
- [web bundle](web/README.zh.md)：serve profile 追加的那一行。
- [app-boot](../boot/app-boot/README.zh.md)：读这些清单并生成 profile 的代码。
- [packages/ ，插件树](../README.zh.md)：这些行点名的插件树。
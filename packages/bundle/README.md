---
description: "The bundle group: the two row lists a profile mounts, and how the launcher turns them into a generated config and a linked profile directory."
kind: "package-group"
---

# bundle/: the row lists

English | [中文](README.zh.md)

## Summary

A profile does not name plugins one by one. It names bundles, and a bundle is a package that exports a list of rows and declares those row packages as dependencies. Two bundles exist: the base set every profile mounts, and the web bundle the `serve` profile adds. Nothing here is spawned and nothing here answers a capability, so a bundle is a dependency-owning library with a manifest key. Read this page to see which row list holds what, then open the directory for the list itself.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)

-----

<a id="packages"></a>
## Packages

| Package | Directory | Rows | Role |
|---|---|---|---|
| `@maota/base` | [`base`](base/) | 30, of which one is disabled | The set every profile mounts. |
| `@maota/web-bundle` | [`web`](web/) | 1 | The row the `serve` profile adds to the base set. |

A bundle declares its list in `package.json` under `maota.bundle.patch`, declares the row packages under `dependencies`, and the launcher reads both from the bundle. The default profile mounts `base`; the serve profile mounts `base` and then `web-bundle`, so one more row arrives and nothing else changes.

<a id="related-documentation"></a>
## Related documentation

- [base](base/README.md): the row list every profile mounts.
- [web bundle](web/README.md): the single row the serve profile adds.
- [app-boot](../boot/app-boot/README.md): the code that reads these lists and generates a profile.
- [packages group](../README.md): the plugin tree these rows name.
---
description: "The boot package group: how one maota launch resolves its config and kernel binary, how the Node host drives the blmoadll kernel over stdio, and the watcher that reports source changes."
kind: "package-group"
---

# boot/: the launch glue

English | [中文](README.zh.md)

## Summary

MaoTa runs the blmoadll kernel as a child process and talks to it over stdio; the boot group owns both halves of that launch. Read it when you are changing how a launch finds its config file or kernel binary, or how the Node side invokes capabilities, streams chunks, subscribes to events and shuts the kernel down. The group holds no plugin logic and never interprets plugin config values. It is a library family rather than a plugin set, with one member that is a plugin: `hmr`.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)

-----

<a id="packages"></a>
## Packages

The CLI composes the first two. `hmr` is the group's one plugin, the kernel mounts it, and nothing else in the repository launches a kernel.

| Package | Role |
|---|---|
| [`app-boot`](app-boot/README.md) | Resolves the config file and the kernel binary for one launch, and generates the config file in `$MAOTA_HOME/profiles/<name>` on a first run. |
| [`host`](host/README.md) | Spawns the kernel, then invokes, streams, subscribes and shuts down over its stdio protocol. |
| [`hmr`](hmr/README.md) | Watches the configured roots and publishes `dev.source.changed`, so a host can restart the plugins that import a changed file. |

<a id="related-documentation"></a>
## Related documentation

- [maota CLI](../../apps/cli/README.md): the launcher that consumes both packages.
- [Architecture](../../docs/architecture.md): the component map and the launch path.

---
description: "Resolve which config file and which kernel binary one maota launch uses, and generate the per-user config on a first run."
kind: "package-reference"
---

# @maota/app-boot

English | [中文](README.zh.md)

## Summary

Decide the two inputs every launch needs: the config file to boot and the kernel binary to spawn. Config lives under `MAOTA_HOME/profiles/<name>` (default `~/.maota`); a first run writes the profile manifest and the generated `blmoadll.toml`, and an `blmoadll.local.toml` beside it wins over that generated file. The kernel-binary resolver is pure path arithmetic over an options object, so a caller can inject a temporary home or a fake environment instead of the ambient one. Use it from any MaoTa entry point that launches a kernel; it never reads a config file, so it cannot tell you whether the chosen one is valid. The CLI is its only caller today.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further exploration](#further-exploration)

-----

<a id="use-this-package"></a>
## Use this package

Use these helpers from any entry point that has to decide which config file to boot and which kernel binary to spawn: resolve once, then hand both paths to the host. None of them reads a config file, so a resolved path says nothing about whether that file is valid.

### Resolving the two inputs

```ts
import { resolveConfigPath, resolveKernelBin, maotaHome } from "@maota/app-boot";

const home = maotaHome();
const config = await resolveConfigPath({ explicit: flagValue, profile: "serve", root: packageRoot });
const bin = resolveKernelBin({ explicit: flagValue });
```

### Precedence

| Input | Order, first match wins |
|---|---|
| Config file | `--config`, `BLMOADLL_CONFIG`, `<home>/profiles/<profile>/blmoadll.local.toml` when it exists, otherwise the generated `blmoadll.toml` beside it |
| Profile | the caller's `profile`, else `default` |
| Kernel binary | `--kernel`, `BLMOADLL_BIN`, the installed `@virgena/blmoadll` binary, `<repo>/../blmoadll/target/debug/blmoadll.exe` |

An explicit `--config` and an injected `home` both suppress the write: with either, a missing file stays missing.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

This section explains how the two resolvers work; the inputs they accept are covered in [Use this package](#use-this-package).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `repoRoot`, `PROFILE_TEMPLATES`, `profileDir`, `ensureProfile`, `bundlesOfProfile`, `rowsOfBundles`, `resolvedRowsOfBundles`, `BundlePluginRow`, `renderConfig`, `linkPackage`, `entryOf`, `maotaHome`, `resolveConfigPath`, `resolveKernelBin` and the option types |

### First-run generation

The module never reads a config file: layering (`extends`, later keys winning, tables merging per key, arrays replacing wholesale) belongs to the kernel loader. A profile is a directory under `<home>/profiles/<name>` holding a `package.json` and the generated `blmoadll.toml`. The manifest records the profile's `maota.profile.bundles` list, and boot reads that list back, so a person adds or drops a bundle without editing code. A bundle is a package whose own manifest points at its rows (`maota.bundle.patch`) and declares the row packages as dependencies. Every row names a package rather than a path, so nothing in the file pins this machine's layout. `ensureProfile` writes the manifest on a first run, resolves each row from the dependency tree of the bundle that owns it, gives the profile a `node_modules` with one link per row, and rewrites the generated config only when its rows changed, reporting `MaoTa: wrote <path>` on stderr. Callers give `resolveConfigPath` the root package that owns the bundle dependencies; the CLI passes its own package root. A link that already points at the right package is left alone; one that exists and is not a link stops the boot. Resolution failures are loud: an unknown profile, a bundle without rows, an id listed twice, and a package that does not resolve each stop the boot with the name in the message. `repoRoot` walks up four levels from `src/`, so the resolvers work wherever they are imported from. `resolveKernelBin` imports the `@virgena/blmoadll` package for the installed binary path and accepts an `installed` override for tests.

Four facts bound this module. Resolution is not validation: the kernel's own `--check` is the only thing that says a config is valid. The last kernel fallback is Windows-shaped, hard-coding the `.exe` suffix and the `debug` profile. A plugin is mounted only through a bundle, so adding a package to the repository does not run it until a bundle lists it. And there is no settings or credential layer, because session roots still belong to the session plugin.

-----

<a id="further-exploration"></a>
## Further exploration

- [boot group](../README.md): the launch glue these resolvers belong to.
- [maota CLI](../../../apps/cli/README.md): the only caller, and the flags that feed both resolvers.
- [Architecture](../../../docs/architecture.md#configuration-layering): how the generated file and the machine layer stack.

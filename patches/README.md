# Dependency patches

`7zip-bin@5.2.0.patch` is applied by Bun through `patchedDependencies` in the root `package.json`; it is part of reproducible dependency installation, not generated output.

The patch adds a macOS compatibility wrapper that uses system `zip` when creating archives with symlinks. Other platforms retain the bundled executable path. Keep the patch and lockfile together until the workaround is removed or replaced and the affected packaging flow has been verified.

Do not delete this directory independently of `package.json` and `bun.lock`. The tracked patch is retained unchanged in this documentation cleanup.

## OpenH3 Core source (historical patch)

`openh3-core.patch` is retained as a reproducibility record for the pre-monorepo split checkout. The complete backend changes are now versioned directly under [`../core/`](../core/); new development must edit `core/` and must not apply this patch to a second checkout. The patch remains useful for auditing how the original OpenH3 Core tree was derived.

- Upstream: `https://github.com/iOfficeAI/AionCore.git`
- Base commit: `503a87199eb978790ca77675b39c84b241535bf3`
- Patched Git tree: `d53609d6280ac937b9900c053b00e84f6fcae0e8`
- Upstream root license: Apache-2.0; its Cargo metadata declares MIT. Both upstream notices remain in the source.

Only historical reconstruction uses this patch: apply it to a separate clean checkout of that exact base, never to the current `core/` tree. Normal development and packaging build the versioned `core/` source directly; follow the [development guide](../docs/contributing/development.md). The unmodified upstream `v0.2.2` release does not contain the historical OpenH3 fixes recorded by this patch.

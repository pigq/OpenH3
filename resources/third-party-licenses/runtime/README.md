# Historical OpenH3 Windows x64 runtime notice

This inventory records the pre-monorepo Windows x64 experience package, not
the component versions of every current build. Keep it as historical
distribution evidence. Current packaging builds the versioned [`core/`](../../../core/)
source by default; the actual bundle's `manifest.json` records its origin.

This notice records the runtime components included in the Windows x64
experience package. The package contains the corresponding upstream license
files at the paths listed below; those files are installed beside the
application under `resources/`.

## Components included in the package

| Component                 | Version  | License / notice                                                                                                                      | Upstream source                                    |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| OpenH3 Core runtime       | v0.2.2   | Apache License 2.0; source URL and build manifest are recorded in `resources/bundled-openh3-core/win32-x64/manifest.json`             | https://github.com/pigq/OpenH3/releases/tag/v0.2.2 |
| Node.js runtime           | v24.11.0 | MIT and bundled third-party notices in `resources/bundled-openh3-core/win32-x64/managed-resources/node/node-v24.11.0-win-x64/LICENSE` | https://nodejs.org/download/release/v24.11.0/      |
| npm CLI                   | v11.6.1  | Artistic License 2.0 and dependency notices in the npm package metadata under the bundled Node installation                           | https://github.com/npm/cli/tree/v11.6.1            |
| Corepack                  | v0.34.0  | MIT; license file is included in the bundled Node installation under `node_modules/corepack/LICENSE.md`                               | https://github.com/nodejs/corepack/tree/v0.34.0    |
| FFmpeg (essentials build) | 7.1.1    | GPL-3.0; see `resources/ffmpeg/LICENSE` and `resources/ffmpeg/README.txt`                                                             | https://github.com/FFmpeg/FFmpeg/commit/db69d06eee |

The adjacent `LICENSE.*` files are unmodified copies of the shipped Node,
npm and Corepack license files and the AionCore v0.2.2 root LICENSE. Node's
license includes the notices for its embedded third-party components. npm's
own license does not replace the licenses of its individual dependencies.
The AionCore tag's root LICENSE is Apache-2.0, while its Cargo workspace
metadata declares MIT; the root LICENSE is preserved verbatim here. Its
Rust dependency license inventory must be assessed separately from this
top-level runtime inventory.

OpenH3 does not ship a separate `bun.exe` or `7z.exe` in the Windows x64
runtime directory. AionCore v0.2.2 is built with Rust, not Bun: its tagged
[release workflow](https://github.com/iOfficeAI/AionCore/blob/v0.2.2/.github/workflows/release.yml)
uses Rust 1.95.0 and `cargo build --release -p aionui-app`.
The historical OpenH3 backend described by this inventory was built from upstream commit
`503a87199eb978790ca77675b39c84b241535bf3` with the complete
[`openh3-core.patch`](../../../patches/openh3-core.patch) in the OpenH3 source
repository. The resulting source tree is
`d53609d6280ac937b9900c053b00e84f6fcae0e8`; the patch includes the native
skill runtime and existing-conversation discovery changes. Its local-bundle
origin is recorded in the adjacent runtime manifest. This build is not the
unmodified upstream release download. The NSIS installer uses
electron-builder's build-time tooling and
does not expose a standalone 7-Zip executable to end users.

The complete source and corresponding-source obligations for GPL components
are tracked in `../SOURCE-OFFER.md`. This file is an inventory and does not
replace any upstream license text or source offer.

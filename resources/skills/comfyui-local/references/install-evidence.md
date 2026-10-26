# Install evidence ledger

Use this short ledger while planning or repairing an installation. It keeps the LLM from treating a reachable page, downloaded file, or successful import as proof of a usable profile.

## Record each artifact

For every model, encoder, VAE, LoRA, node repository, Python package, and workflow record:

- artifact class and role in the API graph;
- authoritative repository, immutable revision/path, license, expected bytes, and SHA-256;
- candidate transports and their batch number in `openh3_comfy_environment.sources` (no more than 12 URLs per call);
- per-source reachability, redirect, Range/content-length result, and mirror identity/digest evidence;
- local path, resume receipt, and post-download size/hash result;
- loader/node schema compatibility and the profile/workflow fingerprint.

Keep model-host, Git-host, package-index, and workflow-host results separate. A successful probe is only network evidence; it is not artifact identity evidence.

## State transitions

Use the states `planned`, `downloaded`, `loadable`, and `verified`:

1. `planned` means the component set, workflow graph, sources, and required space are reviewable. Execution is authorized by the observed full-automatic session policy or one explicit UI confirmation in other modes.
2. `downloaded` means the approved bytes are present and their receipt, size, and SHA-256 match.
3. `loadable` means the selected ComfyUI runtime exposes the required node classes, loaders, dtypes, and paths.
4. `verified` means a representative task-specific smoke input completes and the output passes the media checks.

Apply evidence at its own stage: plan from host measurements, pinned component metadata and matching offline schemas; record downloads and receipts after transfer, loader/kernel execution after runtime installation, and representative outputs after generation. A missing target loader before installation is installation work, while an installed loader failing validation is a real error. Exclude an unprobed or unidentified mirror and try the next eligible source; stop when a required component has no eligible source, a hash mismatches, or post-install validation fails. Report the precise failed transition and a bounded next action. Do not silently change family, quantization, workflow or dimensions.

## Complete plan fields

Prepare a complete snapshot containing:

- Profile `id`, `family` (`h3`, `fasth3-omni`, `qwen-edit`, `z-image`, `flux-3-image-klein`, `moss-image-base`, `moss-image-sft`, or `krea2`), `name`, `kind`, pinned `version`, diffusion `quantization`, and supported `capabilities`.
- `environment`: absolute ComfyUI root, exact Python executable, local `http://127.0.0.1:<port>` endpoint, and supported launch arguments. For a cold install, use a dedicated `targetRoot` parent and its ComfyUI child as `environment.root`; neither can be a volume root. The executor creates the target parent after consent. Component/workflow files, command working directories, partial downloads, source receipts, and resume files must be inside `targetRoot`, `environment.root`, or a model directory explicitly declared by `launchArgs --models-directory` (also `--models-directory=...`). Existing ancestor realpaths are checked to reject junction/symlink escapes. Declare an external model directory explicitly before proposing reuse.
- `components`: each role, filename, absolute path, fixed revision/version, separate precision, pinned upstream identity in `url`, expected bytes, and SHA-256 when downloading. For catalog entries with equivalent transports, set `sourceUrls` to the eligible `transports.map(transport => transport.url)` in order: ModelScope, verified domestic mirror, then upstream `url` last. The executor falls back on network failures; size/SHA-256 validation failure stops installation. Resolve moving `main`/`latest` URLs to fixed revisions first. Include encoders, VAE, adapters, and LoRAs actually used by the graph.
- `nodes`: every required core/custom-node package and fixed version. Pin ComfyUI, runtime dependencies, and any conversion tooling in the command records; do not run blanket updates.
- A complete **API graph** in `workflow`, absolute `workflowPath`, optional workflow hash, semantic input `bindings`, and tested `defaults`. UI JSON with subgraphs/widgets is not directly an API prompt. For an existing runtime, convert against its node schemas; for a cold installation, use a traceable API baseline or matching pinned offline schemas as described in [environment-and-repair.md](environment-and-repair.md). Include the graph and conversion evidence before requesting consent; a later command cannot replace this approved graph.
- `commands`: executable plus argument array, absolute `cwd`, readable label, fixed `revision`, and `stage` (`prepare` for runtime/nodes, `finish` for checks of the approved graph). Allowed entry points are `git`, `comfy`, `uv`, the exact target Python, and its same-directory `pip`, with the bounded subcommands in [environment-and-repair.md](environment-and-repair.md). A separate existing bootstrap Python can only create the target venv. Arbitrary Python scripts, `-c`, modules other than `pip`/`venv`/`comfy_cli`, shell wrappers, and unknown executables are rejected. Offline graph conversion is read-only planning work performed before consent; it does not permit arbitrary converter commands in the install executor.
- Accurate `downloadBytes` and `requiredBytes`, including extraction, temporary download, runtime, and output headroom. A component verified reusable by expected SHA-256/source receipt needs zero download bytes; `requiredBytes` still includes additional runtime, temporary, and output space. `reason` and `evidence` explain selection, hardware checks, estimates, existing reusable assets, licenses, and limitations.
- A small representative `smokeInput` and `repair` flag. Editing validation needs a real input image; video validation needs frames and requested audio as well as a container file.
- If the profile records `memoryPolicy`, include its measured or explicitly estimated minimum width/height, dimension step, minimum batch, permitted offload, and evidence. These are constraints of this exact component set, not a generic VRAM table. Bind `width`, `height`, `batchSize`, and `offload` only when the API graph supports them.

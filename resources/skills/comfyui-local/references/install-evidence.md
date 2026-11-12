# Install evidence ledger

Use this short ledger while planning or repairing an installation. It keeps the LLM from treating a reachable page, downloaded file, or successful import as proof of a usable profile.

The Agent keeps this ledger in the installation journal. The optional managed backend stores equivalent evidence when executing a submitted plan. Missing metadata calls for targeted research; block only the affected transfer or verification if required identity evidence remains unresolved. Executor command allowlists do not prohibit authorized general tools.

## Record each artifact

For every model, encoder, VAE, LoRA, node repository, Python package, and workflow record:

- artifact class and role in the API graph;
- authoritative repository, immutable revision/path, license, expected bytes, and SHA-256;
- candidate transports and their batch number in `openh3_comfy_environment.sources` (no more than 12 URLs per call), or equivalent general-tool HTTPS probe records;
- per-source reachability, redirect, Range/content-length result, and mirror identity/digest evidence;
- local path, resume receipt, and post-download size/hash result;
- loader/node schema compatibility and the profile/workflow fingerprint.

Keep model-host, Git-host, package-index, and workflow-host results separate. A successful probe is only network evidence; it is not artifact identity evidence.

For sharded weights, inspect the model's `*.safetensors.index.json` or `*.bin.index.json` and register every unique file named by `weight_map`, with the original component role, precision and pinned version. Record size and SHA-256 for each real file; a directory is not a single weight file and has no file digest. Include the index and required `config.json` as `identityRole: workflow` dependencies so their changes invalidate validation. Directory registration is normalized from that index, but hashes on a legacy directory record are not per-shard evidence. Read back the normalized components and complete their actual file metadata before recording installation success. Missing shards require repairing those files, not reinstalling an otherwise usable runtime.

Completing missing file hashes/sizes or correcting a directory record to its unchanged indexed files is a registration repair. Keep model family, precision and the actual base weight set unchanged; different known hashes or sizes must be investigated. Register a repaired profile ID, revalidate it, then adopt/complete it through the existing conversation. Do not change the family or pretend a weight is a workflow dependency to suppress `COMFY_REPAIR_MODEL_CHANGED`.

## State transitions

Use the states `planned`, `downloaded`, `loadable`, and `verified`:

1. `planned` means the chosen component set, sources, required space and next execution stages are reviewable. The managed executor additionally requires a complete workflow graph and uses the observed full-automatic policy or one installation-card confirmation. General tools use the actual runtime's approval channel and existing grants, without an extra chat confirmation.
2. `downloaded` means the approved bytes are present and their receipt, size, and SHA-256 match.
3. `loadable` means the selected ComfyUI runtime exposes the required node classes, loaders, dtypes, and paths.
4. `verified` means a representative task-specific smoke input completes and the output passes the media checks.

Apply evidence at its own stage: plan from host measurements and pinned component metadata; use offline schemas when available or obtain live schemas after staged runtime/node installation. Record downloads and receipts after transfer, loader/kernel execution after runtime installation, and representative outputs after generation. A missing target loader before installation is installation work, while an installed loader failing validation calls for diagnosis and repair. Stop the affected transfer on integrity failure and quarantine its bytes; resolve authoritative identity before resuming. A failed validation or unreachable catalog source does not end the user's goal: inspect the failed layer, research supported sources/repairs, and continue within existing authorization. Report an unresolved blocker only when required access/evidence or a supported route cannot be obtained. Preserve explicitly required model, precision and output constraints; record and validate workflow changes.

## Optional managed executor: complete plan fields

These fields describe the managed executor's submission protocol, not prerequisites for general-tool installation. For a staged Agent plan, install known compatible runtime/nodes first when needed, obtain live schemas and complete the graph before GPU submission; keep the same identity and verification evidence. To use the managed executor, prepare a complete snapshot containing:

- Profile `id`, the real stable lowercase model `family` slug, `name`, explicit image/video `kind`, pinned `version`, diffusion `quantization`, and supported `capabilities`. Bundled families have curated recipes; other local models use their own evidenced component set and workflow.
- `environment`: absolute ComfyUI root, exact Python executable, local `http://127.0.0.1:<port>` endpoint, and supported launch arguments. For a cold install, use a dedicated `targetRoot` parent and its ComfyUI child as `environment.root`; neither can be a volume root. The executor creates the target parent after consent. Component/workflow files, command working directories, partial downloads, source receipts, and resume files must be inside `targetRoot`, `environment.root`, or a model directory explicitly declared by `launchArgs --models-directory` (also `--models-directory=...`). Existing ancestor realpaths are checked to reject junction/symlink escapes. Declare an external model directory explicitly before proposing reuse.
- `components`: each role, filename, absolute path, fixed revision/version, separate precision, pinned upstream identity in `url`, expected bytes, and SHA-256 when downloading. For catalog entries with equivalent transports, set `sourceUrls` to the eligible `transports.map(transport => transport.url)` in order: ModelScope, verified domestic mirror, then upstream `url` last. The executor falls back on network failures; size/SHA-256 validation failure stops installation. Resolve moving `main`/`latest` URLs to fixed revisions first. Include encoders, VAE, adapters, and LoRAs actually used by the graph.
- `nodes`: every required core/custom-node package and fixed version. Pin ComfyUI, runtime dependencies, and any conversion tooling in the command records; do not run blanket updates.
- A complete **API graph** in `workflow`, absolute `workflowPath`, optional workflow hash, semantic input `bindings`, and tested `defaults`. UI JSON with subgraphs/widgets is not directly an API prompt. For an existing runtime, convert against its node schemas; for a cold installation, use a traceable API baseline or matching pinned offline schemas as described in [environment-and-repair.md](environment-and-repair.md). Include the graph and conversion evidence before requesting consent; a later command cannot replace this approved graph.
- `commands`: executable plus argument array, absolute `cwd`, readable label, fixed `revision`, and `stage` (`prepare` for runtime/nodes, `finish` for checks of the approved graph). Allowed entry points are `git`, `comfy`, `uv`, the exact target Python, and its same-directory `pip`, with the bounded subcommands in [environment-and-repair.md](environment-and-repair.md). A separate existing bootstrap Python can only create the target venv. Arbitrary Python scripts, `-c`, modules other than `pip`/`venv`/`comfy_cli`, shell wrappers, and unknown executables are rejected. Offline graph conversion is read-only planning work performed before consent; it does not permit arbitrary converter commands in the install executor.
- Accurate `downloadBytes` and `requiredBytes`, including extraction, temporary download, runtime, and output headroom. A component verified reusable by expected SHA-256/source receipt needs zero download bytes; `requiredBytes` still includes additional runtime, temporary, and output space. `reason` and `evidence` explain selection, hardware checks, estimates, existing reusable assets, licenses, and limitations.
- A small representative `smokeInput` and `repair` flag. Editing validation needs a real input image; video validation needs frames and requested audio as well as a container file.
- If the profile records `memoryPolicy`, include its measured or explicitly estimated minimum width/height, dimension step, minimum batch, permitted offload, and evidence. These are constraints of this exact component set, not a generic VRAM table. Bind `width`, `height`, `batchSize`, and `offload` only when the API graph supports them.

# Custom local models

The profile registry accepts stable lowercase model-family slugs beyond the bundled directory. Register the real name, fixed revision, explicit image/video kind, exact base components, runtime and usable graph. Keep image and video kinds explicit; an unknown family has no default output kind. Obtain and validate an authoritative recipe with normal tools when no curated candidate exists. Do not copy an unrelated family identifier or invent verified state. Register with installationIntent=install-other, validate a representative request, finish the installation receipt and check that the model is in inventory. Observing a direct ComfyUI prompt only attaches its outputs; it does not replace profile registration.

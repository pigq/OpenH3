# Source catalog and mirror policy

This file is a decision aid, not a list of unverified download links. The candidate's upstream repository, immutable revision, filename, license, byte count, and SHA-256 remain the identity record.

## Preferred lookup order

1. **ModelScope (魔搭)** — look for the same repository or an explicitly documented export. Record the ModelScope repository, revision, file path, and the evidence that it is an exact copy of the upstream artifact.
2. **A reputable domestic mirror** — for example `hf-mirror.com` or another Hugging Face mirror that preserves the repository and revision path. Treat the mirror as transport only; compare the downloaded bytes and source metadata with upstream. The host must appear in the built-in trusted-host list or be explicitly approved by the product before probing.
3. **Upstream host** — use the pinned Hugging Face, Git, Python index, or Comfy-Org URL when it is reachable and the first two sources do not provide equivalent evidence.

The LLM must pass the exact candidate URLs to `openh3_comfy_environment.sources` before selecting one. A host page, search result, repository name, or same-size file is not sufficient evidence. Do not send credentials or signed query strings in a report; use a short-lived URL only for the actual approved download and keep the receipt local.

## Host-specific rules

- Model weights, encoders, VAEs, and LoRAs may use ModelScope or a domestic mirror when the fixed revision and SHA-256 match. Keep the upstream identity in the plan even when the selected transport is a mirror.
- Custom nodes and ComfyUI itself are Git or package artifacts. Use a pinned commit or package version from the appropriate host; never replace a Git repository with a model mirror.
- Python wheels must match the selected OS, Python, Torch, CUDA/ROCm, and architecture. A faster package index is not evidence of ABI compatibility.
- Official workflow templates are converted into the fixed API graph shipped in this Skill bundle. Do not download a fresh workflow during generation. Probe and pin a template URL only for a planned bundle update.

## Additional image model snapshot (2026-10-22)

- `flux-3-image-klein`: upstream `black-forest-labs/flux-3-image-klein-comfy`, revision `feef60b0aaf63a4773ace96636ebbcf43b881312`. The same fixed-revision `hf-mirror.com` file metadata matches upstream sizes and Git-LFS SHA-256. Official ModelScope exists but requires authorization and anonymous file metadata returned 404; it is a lookup candidate, not an eligible pinned transport. Re-check authorized metadata before adding it. Neither the mirror nor upstream metadata proves gated weight downloads are authorized or reachable.
- `moss-image-base`: upstream `Comfy-Org/MOSS-Image`, revision `ee64003102c8470ee32501cf883419235db81884`. The catalog's Base diffusion, Qwen3.5 encoder and small FLUX2 VAE have byte-identical metadata on ModelScope and the domestic mirror; per-file ModelScope revisions are pinned in `transports`. SFT files are not part of this family recipe.
- `moss-image-sft`: upstream `Comfy-Org/MOSS-Image`, revision `24147db865fcdc207270f844777587223fed8d6e`, with the SFT BF16/INT8 diffusion files and shared Qwen3.5/VAE files matched against ModelScope and `hf-mirror.com`. Keep this family separate from Base; the SFT template and graph use the same native loader but distinct diffusion filenames and source revision.
- `krea2`: upstream `Comfy-Org/Krea-2`, revision `1171f4dc7e325bf3734586942e737872506c73e1`. Turbo diffusion/encoder/VAE sets have matching ModelScope and domestic-mirror size/SHA-256 metadata. Raw checkpoints, optional styles and MXFP8 are not substitutes for the bundled Turbo sets.

For each selected component, pass its ordered eligible `transports` URLs to the environment network probe and install plan. Reuse the common resumable transfer, source receipt and digest validation. A file digest mismatch must stop, not silently fall through to another source. The upstream identity stays in `url`, and transports populate `sourceUrls`; never replace the identity with a mirror URL.

## When no mirror is usable

Try the pinned upstream identity URL next. A missing domestic transport entry is not proof that upstream is unavailable, and one failed mirror does not block a reachable eligible source. If no eligible source remains for a required component, report that exact component and its probe errors; ask only for the smallest needed source decision or a user-provided verified file. Do not silently downgrade the model, change quantization, use a moving `latest` snapshot, or switch to a cloud workflow.

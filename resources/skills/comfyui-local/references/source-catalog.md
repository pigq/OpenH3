# Source catalog and mirror policy

Use this source policy during Agent-led installation, repair and resume. The optional fixed executor performs equivalent checks for its saved plan. General HTTPS/download tools may apply the same identity checks directly. The upstream repository, immutable revision, filename, license, byte count and SHA-256 form the identity record.

## Preferred lookup order

1. **ModelScope (魔搭)** — look for the same repository or an explicitly documented export. Record the ModelScope repository, revision, file path, and the evidence that it is an exact copy of the upstream artifact.
2. **A reputable domestic mirror** — for example `hf-mirror.com` or another Hugging Face mirror that preserves the repository and revision path. Treat the mirror as transport only; compare the downloaded bytes and source metadata with upstream. Managed probes enforce their trusted-host list. General tools may verify other authoritative sources or byte-identical transports under actual runtime permissions; a missing allowlist entry alone is not a permission denial.
3. **Upstream host** — use the pinned Hugging Face, Git, Python index, or Comfy-Org URL when it is reachable and the first two sources do not provide equivalent evidence.

The backend planner probes the exact immutable candidate URLs before selecting a source and records the per-source results. `openh3_comfy_environment.sources` can expose the same read-only evidence for a specific diagnosis when needed; the chat agent does not call it before every installation. A host page, search result, repository name, or same-size file is not sufficient evidence. Do not send credentials or signed query strings in a report; use a short-lived URL only for the actual approved download and keep the receipt local.

## Host-specific rules

- Model weights, encoders, VAEs, and LoRAs may use ModelScope or a domestic mirror when the fixed revision and SHA-256 match. Keep the upstream identity in the plan even when the selected transport is a mirror.
- Custom nodes and ComfyUI itself are Git or package artifacts. Use a pinned commit or package version from the appropriate host; never replace a Git repository with a model mirror.
- Python wheels must match the selected OS, Python, Torch, CUDA/ROCm, and architecture. A faster package index is not evidence of ABI compatibility.
- Reuse a compatible bundled API graph for ordinary generation. Installation, capability repair or compatibility diagnosis may require fetching an authoritative template at a fixed revision. Record its hash/conversion evidence, inspect actual runtime schemas and validate the resulting workflow variant before treating it as usable.

## Additional image model snapshot (2026-10-22)

- `flux-3-image-klein`: upstream `black-forest-labs/flux-3-image-klein-comfy`, revision `feef60b0aaf63a4773ace96636ebbcf43b881312`. The same fixed-revision `hf-mirror.com` file metadata matches upstream sizes and Git-LFS SHA-256. Official ModelScope exists but requires authorization and anonymous file metadata returned 404; it is a lookup candidate, not an eligible pinned transport. Re-check authorized metadata before adding it. Neither the mirror nor upstream metadata proves gated weight downloads are authorized or reachable.
- `moss-image-base`: upstream `Comfy-Org/MOSS-Image`, revision `ee64003102c8470ee32501cf883419235db81884`. The catalog's Base diffusion, Qwen3.5 encoder and small FLUX2 VAE have byte-identical metadata on ModelScope and the domestic mirror; per-file ModelScope revisions are pinned in `transports`. SFT files are not part of this family recipe.
- `moss-image-sft`: upstream `Comfy-Org/MOSS-Image`, revision `24147db865fcdc207270f844777587223fed8d6e`, with the SFT BF16/INT8 diffusion files and shared Qwen3.5/VAE files matched against ModelScope and `hf-mirror.com`. Keep this family separate from Base; the SFT template and graph use the same native loader but distinct diffusion filenames and source revision.
- `krea2`: upstream `Comfy-Org/Krea-2`, revision `1171f4dc7e325bf3734586942e737872506c73e1`. Turbo diffusion/encoder/VAE sets have matching ModelScope and domestic-mirror size/SHA-256 metadata. Raw checkpoints, optional styles and MXFP8 are not substitutes for the bundled Turbo sets.

For each selected component, the backend planner passes its ordered eligible `transports` URLs to its network probe and install plan. The downloader reuses the common resumable transfer, source receipt and digest validation. A file digest mismatch must stop, not silently fall through to another source. The upstream identity stays in `url`, and transports populate `sourceUrls`; never replace the identity with a mirror URL.

## When no mirror is usable

Try the pinned upstream identity URL next. A missing transport entry or failed probe calls for bounded source research and diagnosis, not a conclusion that the model is unavailable. For the optional managed executor, pass exact candidate file URLs as `sourceOverrides`; that API accepts only `modelscope.cn`, `hf-mirror.com`, and `huggingface.co` and still verifies pinned size/SHA-256. General tools may use an independently verified authoritative source or equivalent transport outside that list, preserving revisions, receipts, actual permissions and license/access requirements. Never bypass a real denial or identity/integrity check, or compete with active/unknown managed work. Only after available permitted routes are exhausted, report the exact component/blocker and ask for information or access that needs the user. Do not silently downgrade the model, change quantization, use a moving `latest` snapshot, or switch to a cloud workflow.

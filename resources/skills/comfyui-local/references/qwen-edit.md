# Qwen-Image editing

Use this family for an instruction-driven edit of source images. Text-to-image Qwen checkpoints and editing checkpoints are separate model identities. Preserve the user's source and edit intent; do not route an edit to Z-Image generation because it is cheaper to load.

## Build a matched editing profile

Discover official local templates such as `image_qwen_image_edit`, `image_qwen_image_edit_2509`, and `image_qwen_image_edit_2511`. The available catalog changes: keep an existing verified version when it supports the requested edit, otherwise choose a maintained compatible template and pin its repository revision. Do not assume the numerically newest model is the balanced choice for this runtime.

The component set must bind:

- The exact editing diffusion checkpoint and precision/quantization.
- The matching Qwen vision-language encoder, loader type, and separate precision.
- The Qwen image VAE and the graph's encode/decode settings.
- Any version-specific Lightning/other LoRA with its matching scheduler, guidance, strength, and step count.
- A core/custom-node revision providing the actual `TextEncodeQwenImageEdit` or `TextEncodeQwenImageEditPlus` path used by that template.
- The exact workflow, source image slots, prompt inputs, sampler, output nodes, and tested defaults.

The traced 2511 candidate in [candidates.json](candidates.json) selects `qwen_image_edit_2511_fp8mixed.safetensors`, `qwen_2.5_vl_7b_fp8_scaled.safetensors`, `qwen_image_vae.safetensors`, and its 2511-specific Lightning LoRA; the same template also describes a BF16 option. Keep the candidate's selected diffusion identity and graph flags together. These are discovery facts, not validated compatibility for this computer. Resolve all assets to fixed upstream revisions and verify current template metadata. The encoder's FP8 does not make diffusion FP8, and a low-step LoRA from another Qwen version is not interchangeable.

Its `apiBaselineId` selects `qwen-edit-2511-fp8mixed-lightning-single-image-api-discovery` in [workflows.json](workflows.json). This API graph was converted from the fixed official template with source-derived schemas. The original double-image converter output is retained alongside explicit changes: select `enable_turbo_mode=true`, fold its three switches to the matching LoRA/CFG 1/4-step branch, omit optional second/third images, and replace the example image/prompt/seed with user-input bindings. The source keeps the official shift 3.1, CFGNorm strength 1, `index_timestep_zero`, Euler/simple, and LoRA strength 1. All classes, input order/types, schema sources, and conversion hashes are recorded. The only editing image binding is `41.image`; the application uploads the real `imagePaths[0]`, replacing `source.png`. Supply that actual image in `smokeInput`; the placeholder is not a packaged asset.

Copy this graph, its exact four components and core pin, bindings, and defaults together for a cold request after hardware assessment. This baseline exposes prompt, negative prompt, source image, seed, and output prefix. `FluxKontextImageScale` determines dimensions from the source; there are no width/height/batch/offload bindings, so do not offer a memory-policy resize/offload retry with this graph. Multiple images or a different size-control path need a separate graph and representative validation. Offline structure checks are complete; local loader, kernel, memory, and editing-quality validation remain pending.

Use that pinned baseline when the installed template package differs. An unrelated local UI template does not invalidate the bundled FP8-mixed API graph. Only report a BF16/FP8 conflict after extracting the actual selected loader node and component identity; a template filename, an empty search, unread fields or absent downloaded weights cannot prove such a conflict. Do not invent an additional FP8-only loader requirement: validate the loader declared by this exact graph. A `discovery-only` candidate can be installed for validation; it is not already verified. For a cold install, plan supported pinned runtime dependencies first and execute their kernel/load checks after installation.

BF16/FP16, FP8/scaled-FP8, and community GGUF/INT routes have different loader and kernel requirements. Validate the actual accelerator's dtype support and selected node execution. A GGUF loader changes the component set and workflow; renaming a checkpoint or selecting a precision flag is insufficient. Account for source/reference image count and the vision-language encoder alongside diffusion and VAE memory.

## Input and verification

Inspect live node schemas when the target runtime is installed; use the pinned offline schemas for a cold plan. Store the correct image upload/loader bindings, positive and negative prompt nodes if present, seed, dimensions, and output prefix. Multi-image templates often have optional slots and ordering semantics; only advertise the count and roles validated by the selected API graph. Do not pass an image path into a prompt field or leave a required image slot unbound.

The source image path must exist and be uploaded to the selected local runtime. Resize/crop only as the selected template prescribes; retain the original source. Tell the edit instruction what changes and what remains stable: subject identity, composition, colors, background, or readable text as relevant.

Use one real source image and a simple localized edit for the smoke run. Verify a decodable output at the expected dimensions, the intended edit, and reasonable preservation of the untouched content. A successful text-conditioned sample without the image encoder path does not verify editing. For a multi-image capability, validate its reference ordering explicitly.

Record the measured run, component/workflow fingerprint, and tested image count. Reuse that profile for later generation through `openh3_comfy_generate`; changing the source image or prompt needs no model-tree scan or fresh install plan. If fidelity is inadequate, first check source binding, resize policy, model/LoRA version, and sampler settings before proposing another quantization.

Sources: [official Qwen-Image examples](https://docs.comfy.org/tutorials/image/qwen/qwen-image), [pinned official editing template](https://github.com/Comfy-Org/workflow_templates/blob/020a271ba4cf341096f70dfb6f4fe85bd5df2f5e/templates/image_qwen_image_edit_2511.json), [Comfy-Org Qwen editing components](https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI), [Qwen-Image project](https://github.com/QwenLM/Qwen-Image). Workflow derivation and license are recorded in [sources.md](sources.md).

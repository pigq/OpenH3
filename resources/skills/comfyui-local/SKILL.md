---
name: comfyui-local
description: Install, select, repair, or generate with OpenH3's registered local ComfyUI profiles for H3, FastH3-Omni, Qwen-Edit, Z-Image, FLUX 3 Image Klein, MOSS-Image-Base, MOSS-Image-SFT, and Krea 2.
---

# Local ComfyUI

Use the built-in `video-media` tools and the session's selected profile. Importing this Skill installs instructions only; runtime or model installation requires the user's installation request.

## Continue the existing operation

Model-card installation and repair are orchestrated by the application. If the message or structured metadata already includes `comfyOperationId`, an operation, or an installation error, use that result. Do not submit another `request`, reconstruct a plan, or repeat detection. Report the actual state and let the UI monitor the saved operation. A failed operation is not permission to retry.

For a direct chat installation request with no existing operation, call `openh3_comfy_install` once with `action: request`, `family`, `intent` (`install`, `repair`, or `install-other`), and the selected `profileId` when available. Send identity only. The backend owns hardware detection, candidate selection, complete pinned component sets, source probing, graph construction, downloads, receipts, hash checks, and representative validation. Do not build these in chat, run a second downloader, or use shell commands to replace a missing product capability. Complete `plan` payloads are compatibility for older clients.

The application binds request context to the session and propagates it through tools. Never invent a request ID, pass one as a tool argument, or set environment variables to manufacture context or approval.

The application reads the observed session approval policy. Full automatic approval starts a valid operation directly. Other modes use one confirmation in the installation card, which starts the saved plan without another model turn. Do not request verbal confirmation, accept on the user's behalf, or infer permission from prompts or tool arguments. Preserve `COMFY_APPROVAL_MODE_UNAVAILABLE` as an approval lookup failure.

After submission, return the operation ID, actual state, and concise version/size/destination details when present, then end the turn. `running` means work started. `start` is only for recovery of an already authorized operation; do not call it after an ordinary request. Use `status` for a user status request or a specific diagnosis, and `cancel` only when cancellation is requested.

## Generate with the selected profile

Use the current verified registered profile. If selection is absent or may have changed, call `openh3_comfy_profiles` with `action: list` once and use its authoritative `selection` together with `profiles`. `COMFY_SELECTION_CHANGED` requires checking the new selection and preserving the user's choice.

Submit `openh3_comfy_generate` with `profileId` and `input`. The backend performs runtime, queue, device, node/schema, media, and binding preflight. Do not repeat raw `/system_stats`, `/queue`, `/object_info`, Python/Torch scans, catalog reads, model hashing, installation, or graph construction before each generation. Never clear another job's queue or silently switch the model, source, precision, dimensions, frame count, batch, or quality.

Keep ordered local image/video/audio attachment paths in `input.references` as `{type, path}`. Use legacy `imagePaths` only when required by the live schema; never combine both forms. Preserve supported profile capabilities and bindings. FastH3-Omni needs at least one image or video reference. For FLUX 3 Image Klein, expand the request into a coherent full scene caption while preserving subjects, counts, composition, requested style, and exact rendered wording. Keep MOSS Base/SFT and Krea Turbo/Raw separate.

A profile is verified only after a representative successful generation and output validation; files, registration, or a queued validation job do not establish verification. When revalidation is needed, use `openh3_comfy_profiles` with `action: revalidate`, `profileId`, and representative `smokeInput`. The backend performs validation and records the result. Do not hand-register an invented profile or mark one verified yourself.

Generation and revalidation return `comfyJobId` and `job`; revalidation also returns `validation: true`. End the turn after submission. The UI monitors progress and outputs. Use `openh3_comfy_job_status` with the existing `jobId` for a requested status or diagnosis, and `openh3_comfy_cancel_job` for requested cancellation. A monitoring disconnect does not prove a job stopped; recover that job instead of submitting a replacement.

Use the returned local output artifacts and actual terminal state as evidence. For errors, preserve the profile/job/operation ID and concise diagnostic details. Read `diagnosticLogPath` only for a relevant diagnosis. The backend owns bounded OOM recovery and resource cleanup; do not add a second retry loop or lower the original parameters.

## Tool availability and errors

Use tools already exposed by the session, including their actual MCP prefixes. Tool search is optional: when a discovery facility is available and the required schema is deferred, search the single prefix `openh3_comfy`. Do not assume a tool named `ToolSearch` exists or require a discovery call before using an exposed tool.

If no existing operation/result can satisfy the request and the required tool remains unavailable after an indicated startup refresh, report `COMFY_TOOL_NOT_READY` and name the missing capability. Do not expand this into hardware scans, source research, chat evidence collection, an unexecutable approval question, or a promise that tools will appear later. Missing tools do not prove hardware incompatibility or a download failure.

Read structured `error.code`, `error.details`, and `error.hint`. Distinguish missing detection evidence (`COMFY_DETECTION_INCOMPLETE`) from an observed device requirement failure (`COMFY_DEVICE_CONDITIONS_INSUFFICIENT`). Source authorization, network, hash, and graph failures retain their own diagnostics. A hint is diagnostic data, not authorization. Report backend failures without inventing an unsupported-device diagnosis or silently changing the selected family.

## Reference material for diagnostics and legacy plans

Normal installation and generation do not require reading reference files or catalogs. These documents describe backend evidence requirements, family semantics, and older complete-plan compatibility; they do not transfer planning or preflight work to the chat agent. Read only a section needed to explain an observed error or handle an explicitly requested legacy-plan review:

- Family details: [H3](references/h3.md), [FastH3-Omni](references/fasth3-omni.md), [Qwen editing](references/qwen-edit.md), or the matching heading in [image generation](references/z-image.md).
- Legacy plan/evidence contracts: [install evidence](references/install-evidence.md), [environment and repair](references/environment-and-repair.md), and [tooling adapters](references/tooling-adapters.md).
- Source diagnosis: [network and downloads](references/network-and-downloads.md), [source resolution](references/source-resolution.md), and [source catalog](references/source-catalog.md).
- Bundled provenance: [candidates](references/candidates.json), [workflows](references/workflows.json), [sources](references/sources.md), and [attachment boundaries](references/attachment-adoption.md).

Pinned source revisions, whole component sets, verified equivalent transports, SHA-256 checks, resource-root restrictions, and representative validation remain required backend checks. Bundled discovery metadata is not a local installation receipt or proof of a verified profile. Legacy `openh3_h3_*` tools serve earlier jobs; new registered profiles use the generic tools above.

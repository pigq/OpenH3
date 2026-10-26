# FastH3-Omni local video and native audio

Use family `fasth3-omni`, display name **FastH3-Omni**, and kind `video`. The FastVideo/Diffusers checkpoint `FastVideo/FastVideo-FastH3-Omni-8-Step-V1` is the model identity; it is not a ComfyUI single-file checkpoint. Install the official [ComfyUI distribution](https://huggingface.co/FastVideo/FastH3-Omni-Comfy) and its matching components. The earlier `FastH3-OmniRef-Comfy` URL currently resolves to that canonical repository.

Read only the selected `fasth3-omni` candidate in [candidates.json](candidates.json) and its `apiBaselineId` in `omni.baselines` of [workflows.json](workflows.json). All four entries remain `discovery-only`, `verifiedOnThisMachine: false`. Source metadata and upstream GPU reports are evidence for discovery; only this computer's successful representative generation establishes a verified profile.

## Editable install prompt

> Install FastH3-Omni through the bundled `comfyui-local` Skill. Detect my actual OS, GPU architecture, driver, Python, Torch/CUDA build, executing attention and quantization kernels, available VRAM, RAM and disk. Choose one complete pinned BF16, INT8-ConvRot, FP8 or NVFP4-QAD ComfyUI candidate that this environment can support. Prefer ModelScope, then the verified domestic mirror, then the official upstream. Preserve revisions, size and SHA-256 and resume receipts. Report concrete missing device conditions separately from incomplete detection. Use the matching 8-step R2V API graph, guidance 1 and video/audio shifts 12/3, with no Turbo LoRA. Verify an image/video reference and synchronized video-plus-audio output before declaring the model usable.

This prompt is a draft for the input box. Preserve user edits and send it as an ordinary chat request. Use the shared session approval policy: full automatic approval starts a valid submitted plan directly; other modes require one confirmation in the installation card.

## Select a complete hardware-compatible set

For a cold install, confirm the host architecture/driver and the pinned runtime's upstream platform/kernel support before selection; execute those target kernels only after the approved dependencies are installed. Record those checks as pending rather than requiring an uninstalled kernel to run. A known unsupported platform excludes a candidate; missing target packages do not by themselves exclude it. Real kernel and representative video/audio validation are mandatory before marking the profile usable.

| Candidate    | Diffusion                       | Text/vision encoder   | Video VAE    | Audio VAE |
| ------------ | ------------------------------- | --------------------- | ------------ | --------- |
| BF16         | Official pruned BF16            | Qwen3-VL BF16         | FP16         | FP32      |
| INT8-ConvRot | Official pruned INT8 ConvRot    | Qwen3-VL INT8 ConvRot | INT8 ConvRot | FP32      |
| FP8          | Official Comfy-native FP8       | Qwen3-VL BF16         | FP16         | FP32      |
| NVFP4-QAD    | Official Comfy-native NVFP4 QAD | Qwen3-VL NVFP4 AWQ    | INT8 ConvRot | FP32      |

The graph needs the encoder's vision support and both VAEs. Precision of diffusion does not imply the precision of the encoder or either VAE. FP8 and NVFP4 use their separate **Comfy-native** repositories; do not insert the FastVideo-format FP8/NVFP4 files or make an unvalidated conversion. The non-Blackwell FP8 candidate deliberately uses a BF16 encoder. Its large encoder still needs a measured memory/offload plan.

Before selection, inspect exact host OS/architecture, GPU UUID and compute capability, driver, available VRAM/RAM and free disk. Check existing Python/Torch/CUDA and kernel execution when installed; for a cold target, assess the pinned dependencies' platform support now and execute those checks after installation. Include peak encoder, reference, sampling, video/audio decode, temporary download and output allocations. File size and advertised GPU names are insufficient. Do not invent a fixed VRAM-to-model table.

**NVFP4-QAD requires confirmed NVIDIA Blackwell hardware and a working compatible native NVFP4 kernel**, including the AWQ encoder path. A Blackwell GPU with an incompatible driver, OS wheel or kernel is still unsupported for that set. BF16, INT8 and FP8 also require successful checks of their own kernels. The source-derived core pin is `b1a247c9cf9dbfda4b2c0a0c1d50950667eeaa0c`, with `comfy-kitchen==0.2.39` and `comfy-aimdo==0.5.6`; resolve and record exact compatible Python/Torch/CUDA wheels before preparing a cold install. Upstream's GB200 validation environment is not a Windows compatibility guarantee.

Report these outcomes separately:

- **device conditions insufficient / 设备条件不足:** a completed probe proves a missing architecture, driver, executing kernel, VRAM/RAM/disk or runtime requirement. Name each condition and the evidence.
- **detection incomplete / 检测未完成:** a command failed, timed out, or did not establish a required value. Identify the missing probe and retry only that read-only check. Do not classify an unknown device as unsupported or silently select a smaller checkpoint.

## Pinned sources and transfer

Every component records the canonical upstream revision/path/bytes/SHA-256 and an ordered `transports` list. Shared components and BF16/INT8 diffusion have matching ModelScope API SHA-256/size records. Their ModelScope revisions are per-file commits and differ from Hugging Face commits; preserve each transport's own revision. FP8 and NVFP4-QAD diffusion had no matching ModelScope repository during discovery, so those files start with the verified domestic mirror.

Use **ModelScope → verified domestic mirror (`hf-mirror.com`) → upstream**. An unavailable or unverified source is skipped, and its failure stays in the evidence. The mirror's pinned Git-LFS metadata was compared with the upstream manifest and API for repository/path/size/SHA-256; this is metadata identity verification, not a completed payload download. Probe exact immutable URLs in batches of at most 12 on this computer. Retain expected upstream SHA-256 and verify every completed file before reuse or registration.

For each planned component, preserve `url` as the pinned upstream identity and set `sourceUrls` to that component's eligible `transports.map(transport => transport.url)` in catalog order, including the upstream `url` last. All sources share the same approved `sizeBytes` and `sha256`. The install executor automatically falls back through this approved list after network/transport failures, reusing the application's downloader, `.part` file, source receipt and range support. A byte-count or SHA-256 failure stops installation and quarantines the failed payload; it must not silently continue through mirrors as if the failed bytes were trusted. A URL outside the approved equivalent list needs a new plan. Never create a second downloader or label same-size bytes reusable.

## Official R2V baseline and references

The UI source is `Comfy-Org/workflow_templates` revision `020a271ba4cf341096f70dfb6f4fe85bd5df2f5e`, `templates/video_minimax_h3_r2v.json`, SHA-256 `afeea99e9fd5a1456df348e0573e289c1243f2f28546fc95c1c963f808d61ddb`. `omni.baselines` provides the derived API graph with recorded source schemas, graph hashes and derivation. Copy `graph`, `graphSha256`, `bindings`, `defaults`, and `requiredNodes` into the plan; loader paths and runtime commands must be resolved on the target computer. The graph hash is UTF-8 `JSON.stringify(graph, null, 2) + '\n'`.

Keep eight steps, BasicGuider guidance 1, video/audio sigma shifts 12/3, 24 FPS and native `VAEDecodeAudio` → `CreateVideo` → `SaveVideo` links. Turbo LoRA is removed because it belongs to a different model. Match each baseline's exact diffusion, text/vision encoder, video VAE and audio VAE. `frames` binds to `length`; duration conversion uses 24 FPS and `17n + 5` alignment. The small 832×480, 124-frame default is a validation example, not proof that it fits the current machine.

Supply ordered `references: { type: 'image' | 'video' | 'audio'; path: absoluteLocalPath }[]`. Legacy `imagePaths` remains available; never send both fields. At least one image or video is required. Limits are 9 images, 3 videos, 3 standalone audio clips and 12 total reference slots; original video soundtracks consume audio labels and total presentation slots. The shared audio-label limit is 3, including video soundtracks. Runtime reference limits are inclusive: each video or standalone audio must be 2–15 seconds; all videos together must be at most 15 seconds; all soundtracks plus standalone audio together must be at most 15 seconds. Video frames use the 24-FPS decoding contract. Probe durations/audio streams before submission and report invalid media without discarding or truncating it silently.

The official conditioning node presents images first, then each video with its soundtrack, then standalone audio. Assign `<Picture N>` and `<Video N>` in their per-type order. Each video soundtrack receives the next `<Audio N>` immediately before that video; standalone audios continue the same audio counter. Bind `ref_videos.ref_video_N` and `ref_video_audios.ref_video_audio_N` with the same zero-based suffix, including gaps for silent videos. Do not renumber an existing video's soundtrack onto a different video. Explain the resulting reference tag map before generation when attachments include both video and standalone audio.

## Validate and recover

Validate the complete API graph against the real `/object_info` and confirm the pinned runtime/component fingerprints. A smoke test must use a real local image or video; `omni_smoke_reference.png` is only a placeholder. Exercise each advertised reference capability. Confirm moving decoded frames, expected dimensions/frame count/duration, and a non-silent synchronized audio stream; the model's native output is 32-kHz stereo audio at 24 FPS. Retain the prompt ID, job record, output paths and diagnostic logs. A queued job, successful sampler, empty queue or playable silent MP4 is insufficient.

For continuous generation, prefer speed and preserve same-set caches. Release only after terminal-state and queue/identity checks on component changes, memory pressure, terminal failures or the 120-second idle policy. OOM recovery first frees the confirmed idle runtime and observes the result, then retries **once with the original model, references and parameters**. Persist the retry count. Do not reduce resolution, frames, batch, quality or switch quantization automatically. An unconfirmed submission, cancellation or monitoring disconnect blocks resubmission until the existing job is recovered.

# Network-aware downloads

This reference defines source and download checks for cold installs, missing components, resumed downloads, and source changes. The managed backend performs them without a separate chat checklist. In SKILL.md's general-tool fallback, the agent performs equivalent read-only HTTPS probes and verified transfers with permitted tools; the absence of `openh3_comfy_environment` is not a download prohibition. Network reachability is not evidence that a model file is the right file.

## Probe before choosing a source

1. The backend planner probes the exact immutable candidate URLs before finalizing its install plan. For a specific diagnosis, `openh3_comfy_environment` can return this evidence for URLs in `sources`; it is not an extra chat approval or installation prerequisite. Its returned `network.requested`, `network.proxy`, and per-source `status`, `httpStatus`, `contentLengthBytes`, and `range` describe that probe only. A report without `network.requested: true` is not a completed source probe; do not claim that a host is reachable.
   The probe accepts at most 12 URLs per batch. The backend groups candidates by artifact class (models, Git/custom nodes, Python packages, and workflows), preserves each candidate/result in its evidence ledger, and splits larger groups into batches. An omitted URL is unprobed, not unreachable.
2. Managed source probes accept HTTPS on the bundled trusted model/code/package hosts only and follow redirects manually. Every redirect target is checked again; private IPs, localhost, untrusted hosts, credentials, non-HTTPS URLs, and non-standard ports are rejected. Fallback preserves the same source/redirect boundaries and actual network permissions; it does not use Shell to route around a rejected host or URL. Treat `NETWORK_SOURCE_HOST_UNTRUSTED`, `NETWORK_SOURCE_URL_UNSUPPORTED`, or any redirect error as a source failure, not as a reason to try an arbitrary URL. Other already-eligible sources may still be checked.
3. Record failures separately for model hosts, Git hosts, Python package indexes, and workflow/template hosts. The source probe performs read-only HEAD/one-byte Range checks; it never downloads a model, follows a moving repository branch, or proves that a mirror contains the right artifact.
4. Prefer a source that is reachable from the user's network and has a traceable copy of the exact candidate. For model weights, check ModelScope (魔搭) first when it provides the same repository, revision, filename, byte count, and SHA-256; otherwise check a reputable domestic mirror such as `hf-mirror.com`, then the upstream source when reachable. The mirror name alone is never identity evidence.
5. A mirror is eligible only when repository identity, immutable revision, file name, size, license, and SHA-256 (or an independently verifiable digest) match the pinned candidate. A same-name or same-size file is not an equivalent copy. If the mirror cannot provide that evidence, keep it as a connectivity hint, not an install source.
6. Pin every URL to a revision or immutable object. Never use `latest`, a moving branch, an unpinned ModelScope snapshot, or a dynamically composed component set in an approved plan.

Reachability is only transport evidence. A successful HEAD, Range response, content length, or fast mirror does not prove that the bytes are the pinned artifact. Before selecting a ModelScope or domestic mirror transport, record the upstream repository, revision, path, license, expected byte count, and SHA-256, then verify the mirror's corresponding identity and digest. If a mirror lacks that evidence, exclude that transport and continue to the next eligible mirror or upstream. Stop for source review only when no eligible source remains for a required component. A failed optional mirror does not block an otherwise complete plan.

## Transfer and resume

- Use the approved downloader's resume support after a connection reset. Preserve the partial file and resume metadata inside the selected target root; do not restart a large file blindly.
- Verify byte count and SHA-256 after completion and after switching sources. If either check fails, quarantine the file and rebuild the plan; do not retry the same bytes from another URL under the old approval.
- A source switch is allowed only between already-approved equivalent sources. If identity, revision, license, component set, or hash evidence changes, stop the old transfer and revise the recorded plan under the actual runtime approval policy. In the managed route the backend owns that revision; the chat agent must not start a competing transfer. Fallback records the new evidence in its journal and honors any scope or permission change. Do not add chat confirmation to an already-authorized equivalent source switch.
- Keep temporary files, receipts, and hashes with the profile snapshot so a restart can distinguish downloaded, loadable, and verified states.

## Diagnose the right network layer

- **Model host:** inspect redirects, range support, authentication, quota, and the final immutable URL. ModelScope or a domestic mirror can reduce latency, but it does not replace integrity checks.
- **Git or custom nodes:** use a pinned commit and test the repository host independently. Do not substitute a model mirror for a Git repository or silently fetch a moving branch.
- **Python dependencies:** use the configured package index only with pinned versions and compatible wheels. A faster index does not prove that the wheel matches the OS, Python, CUDA, or Torch ABI.
- **ComfyUI templates and workflow files:** pin the template commit and preserve the workflow hash. Do not fetch a fresh template during generation.

## Source decision table

| Probe result                                                                      | Allowed action                                                                                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| ModelScope is reachable and its immutable file identity and digest match upstream | Select ModelScope and record upstream identity plus the selected mirror URL in the component evidence.                                            |
| ModelScope is unreachable or lacks identity evidence                              | Probe a domestic mirror with the same checks, then upstream. Keep the failed source result in the plan evidence.                                  |
| A mirror responds but size, revision, license, or digest cannot be checked        | Exclude that mirror and try the next eligible mirror or pinned upstream source; ask the user only when no eligible source remains.                |
| All candidate hosts are unreachable, or the probe is incomplete                   | Stop at a reviewable plan and report the missing evidence. Do not switch to a smaller or differently quantized model just because its page opens. |

Workflow templates normally ship as the pinned API graph in the Skill bundle. They should not be downloaded again for each generation. Probe a workflow URL only when planning a template update or when the bundle lacks the required graph; pin and hash that update before approval.

If backend probing is incomplete, report the specific missing evidence from the operation and use its bounded follow-up path. In fallback, use available tools to fill the missing evidence without repeating completed probes or turning it into a hardware/source interview. Ask only for information or access that cannot be obtained within existing permissions. Do not choose a smaller checkpoint merely because a download is reachable, and do not label an installation usable until loader checks and a representative smoke run succeed.

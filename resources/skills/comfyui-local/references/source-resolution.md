# Source resolution playbook

Use this playbook before a cold install, a missing component download, or a source switch. It is deliberately a decision procedure, not a list of guessed mirror URLs.

## Classify the artifact first

- **Model weights, encoders, VAE, and LoRA:** resolve the authoritative repository, immutable revision, repository path, license, byte count, and SHA-256. ModelScope (魔搭) or a domestic mirror is only an approved transport when it proves the same identity and digest.
- **ComfyUI and custom nodes:** keep the Git repository and pinned commit. A model mirror cannot replace a Git source. Read `comfy`, `comfy-custom-nodes`, and `comfy-debug` guidance where useful, but keep their commands inside the approved local plan.
- **Python packages:** use the configured package index only after checking Python, Torch, CUDA/ROCm, OS, architecture, and wheel ABI. A fast domestic index is not evidence that a wheel is compatible.
- **Workflow/template:** use the pinned API graph shipped with this Skill whenever possible. Only probe a remote template when updating the bundle, and store its revision, conversion evidence, and graph hash.

## Select a network route

1. Build a short candidate list from the pinned artifact record. Never create a URL from a search result, a `latest` tag, a moving branch, or a filename alone.
2. Pass the exact immutable HTTPS URLs to `openh3_comfy_environment.sources`. The tool accepts at most 12 URLs per call, so split a longer list into artifact-class batches (models, Git/custom nodes, Python packages, workflows) and preserve the batch number and returned result for each URL. Treat `network.requested: false`, missing per-source results, an untrusted redirect, or any `NETWORK_*` error as incomplete evidence.
3. Prefer ModelScope (魔搭) when its manifest or API identifies the same repository/revision/path and the downloaded bytes can be checked against the upstream SHA-256. If that evidence is unavailable, probe a reputable domestic mirror under the same rules, then the upstream host.
4. Keep model, Git, package-index, and workflow failures separate. A reachable model host does not prove that Git or Python dependencies will work.
5. If every route lacks identity or reachability evidence, stop at a reviewable plan. Ask for another approved source, a user-provided file with a digest, or a later retry. Do not silently downgrade precision or move to cloud execution.

Do not collapse the evidence into a single “network is available” claim. A candidate is selectable only when its class-specific probe is present and its identity record is complete. A reachable mirror without a matching repository/revision/path, license, byte count, and SHA-256 is not an equivalent source.

## Transfer and recovery

- Download into the selected profile root with a `.part` file and a receipt containing URL, source identity, expected bytes, and expected SHA-256. Resume only when the server advertises byte ranges and the receipt still matches the approved component.
- After completion, verify size and SHA-256 before extraction or registration. On mismatch, quarantine the partial/full file and rebuild the plan; do not reuse same-size bytes.
- A source switch is allowed only between already-approved equivalent URLs. A new revision, license, component set, or digest requires a new complete plan submitted through `action=request`. Apply SKILL.md's observed approval-mode contract: full automatic approval starts directly; other modes require one UI confirmation. Do not request chat confirmation.
- If direct access fails but a configured proxy succeeds, record the proxy route as network evidence without treating it as a different artifact source. Do not ask the LLM to invent proxy credentials or embed them in a URL.
- For offline installation, accept only a user-selected local file or an existing path whose digest and component identity are recorded. Mark it downloaded first; loader checks and a representative smoke run are still required before it becomes loadable or verified.

## Package and node recovery order

For a dependency failure, diagnose in this order: exact Python executable and architecture, Torch/CUDA or ROCm ABI, pinned node commit, package index response, then the node's import log. Snapshot before mutation, make one bounded repair, and re-run the smallest representative check. Do not run blanket upgrades or let a package index select a newer Torch build implicitly.

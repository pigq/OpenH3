# Source resolution playbook

Use this playbook before a cold install, a missing component download, or a source switch. It is deliberately a decision procedure, not a list of guessed mirror URLs.

The managed backend normally owns these steps. For the general-tool fallback in SKILL.md, use equivalent permitted HTTPS/file/command tools and keep the same identity, redirect, approval, and receipt checks. Missing probe tooling is not proof that sources are unreachable.

## Classify the artifact first

- **Model weights, encoders, VAE, and LoRA:** resolve the authoritative repository, immutable revision, repository path, license, byte count, and SHA-256. ModelScope (魔搭) or a domestic mirror is only an approved transport when it proves the same identity and digest.
- **ComfyUI and custom nodes:** keep the Git repository and pinned commit. A model mirror cannot replace a Git source. Read `comfy`, `comfy-custom-nodes`, and `comfy-debug` guidance where useful, but keep their commands inside the approved local plan.
- **Python packages:** use the configured package index only after checking Python, Torch, CUDA/ROCm, OS, architecture, and wheel ABI. A fast domestic index is not evidence that a wheel is compatible.
- **Workflow/template:** use the pinned API graph shipped with this Skill whenever possible. Only probe a remote template when updating the bundle, and store its revision, conversion evidence, and graph hash.

## Select a network route

1. Build a short candidate list from the pinned artifact record. Never create a URL from a search result, a `latest` tag, a moving branch, or a filename alone.
2. Probe the exact immutable HTTPS URLs. When available, use `openh3_comfy_environment.sources` (at most 12 URLs per call), splitting longer lists into artifact-class batches and recording each result. In fallback, equivalent read-only HTTPS probes record status, redirects, Range support, length, and identity evidence. An omitted or failed probe is incomplete evidence, not proof of reachability or incompatibility; follow source/redirect rejections without bypassing them.
3. Prefer ModelScope (魔搭) when its manifest or API identifies the same repository/revision/path and the downloaded bytes can be checked against the upstream SHA-256. If that evidence is unavailable, probe a reputable domestic mirror under the same rules, then the upstream host.
4. Keep model, Git, package-index, and workflow failures separate. A reachable model host does not prove that Git or Python dependencies will work.
5. If a route lacks identity or reachability evidence, first use available read-only tools to resolve the specific gap or try the next eligible source. If every route still fails, save the completed work and report the exact blocker. Ask only for a source/account/local file that requires the user's input. Do not silently downgrade precision or move to cloud execution.

Do not collapse the evidence into a single “network is available” claim. A candidate is selectable only when its class-specific probe is present and its identity record is complete. A reachable mirror without a matching repository/revision/path, license, byte count, and SHA-256 is not an equivalent source.

## Transfer and recovery

- Download into the selected profile root with a `.part` file and a receipt containing URL, source identity, expected bytes, and expected SHA-256. Resume only when the server advertises byte ranges and the receipt still matches the approved component.
- After completion, verify size and SHA-256 before extraction or registration. On mismatch, quarantine the partial/full file and rebuild the plan; do not reuse same-size bytes.
- A source switch is allowed only between already-approved equivalent URLs. A new revision, license, component set, or digest requires a revised complete plan and the actual runtime's approval policy. Managed operations submit that plan through their supported interface; fallback updates its journal without inventing product operation IDs or bypassing permissions. Do not request chat confirmation for an already-authorized equivalent source switch.
- If direct access fails but a configured proxy succeeds, record the proxy route as network evidence without treating it as a different artifact source. Do not ask the LLM to invent proxy credentials or embed them in a URL.
- For offline installation, accept only a user-selected local file or an existing path whose digest and component identity are recorded. Mark it downloaded first; loader checks and a representative smoke run are still required before it becomes loadable or verified.

## Package and node recovery order

For a dependency failure, diagnose in this order: exact Python executable and architecture, Torch/CUDA or ROCm ABI, pinned node commit, package index response, then the node's import log. Snapshot before mutation, make one bounded repair, and re-run the smallest representative check. Do not run blanket upgrades or let a package index select a newer Torch build implicitly.

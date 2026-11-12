# Source resolution playbook

Use this playbook before a cold install, a missing component download, or a source switch. It is deliberately a decision procedure, not a list of guessed mirror URLs.

The Agent may perform these steps directly with permitted HTTPS/file/command tools; the optional managed backend performs equivalent checks for its submitted plan. Preserve identity, redirect evidence, actual runtime permissions and receipts. Missing probe tooling is not proof that sources are unreachable.

## Classify the artifact first

- **Model weights, encoders, VAE, and LoRA:** resolve the authoritative repository, immutable revision, repository path, license, byte count, and SHA-256. ModelScope (魔搭) or a domestic mirror is only an approved transport when it proves the same identity and digest.
- **ComfyUI and custom nodes:** keep the Git repository and pinned commit. A model mirror cannot replace a Git source. Read `comfy`, `comfy-custom-nodes`, and `comfy-debug` guidance where useful; record commands in the installation journal and preserve actual runtime permissions.
- **Python packages:** use the configured package index only after checking Python, Torch, CUDA/ROCm, OS, architecture, and wheel ABI. A fast domestic index is not evidence that a wheel is compatible.
- **Workflow/template:** reuse a compatible pinned API graph. Installation, missing capabilities or compatibility repair may require a new authoritative template; record its immutable revision, conversion evidence and graph hash, inspect actual node schemas, and validate the resulting variant. Do not refetch templates for ordinary generation. The complete graph must precede an optional managed plan's approval; general tools may bootstrap pinned runtime/nodes first to obtain the schemas, completing the graph before generation submission.

## Select a network route

1. Build a short candidate list from pinned artifact records or authoritative metadata found through bounded research. A search result, `latest` tag, moving branch or filename alone is only a discovery lead; resolve the exact immutable artifact identity before selecting its URL.
2. Probe the exact immutable HTTPS URLs with `openh3_comfy_environment.sources` (at most 12 URLs per call) or permitted equivalent read-only tools, recording status, redirects, Range support, length and identity evidence. Split longer lists into artifact-class batches and retain every result. An omitted or failed probe needs targeted diagnosis. The managed API enforces its host/redirect allowlist; general tools may verify authoritative HTTPS sources outside that executor's list under actual permissions. Do not bypass a real permission/source-access denial, license restriction or integrity check.
3. Prefer ModelScope (魔搭) when its manifest or API identifies the same repository/revision/path and the downloaded bytes can be checked against the upstream SHA-256. If that evidence is unavailable, probe a reputable domestic mirror under the same rules, then the upstream host.
4. Keep model, Git, package-index, and workflow failures separate. A reachable model host does not prove that Git or Python dependencies will work.
5. If a route lacks identity or reachability evidence, first use available read-only tools to resolve the specific gap or try the next eligible source. If every route still fails, save the completed work and report the exact blocker. Ask only for a source/account/local file that requires the user's input. Do not silently downgrade precision or move to cloud execution.

Do not collapse the evidence into a single “network is available” claim. A candidate is selectable only when its class-specific probe is present and its identity record is complete. A reachable mirror without a matching repository/revision/path, license, byte count, and SHA-256 is not an equivalent source.

## Transfer and recovery

- Download into the selected profile root with a `.part` file and a receipt containing URL, source identity, expected bytes, and expected SHA-256. Resume only when the server advertises byte ranges and the receipt still matches the approved component.
- After completion, verify size and SHA-256 before extraction or registration. On mismatch, quarantine the partial/full file and rebuild the plan; do not reuse same-size bytes.
- A source switch requires verified equivalent URLs within the authorized scope. A new revision, license, component set, or digest requires revised evidence and the actual runtime's approval policy. Managed operations must include sources in their complete approved plan; general tools update the installation journal without inventing product operation IDs or bypassing permissions. Do not request chat confirmation for an already-authorized equivalent source switch.
- If direct access fails but a configured proxy succeeds, record the proxy route as network evidence without treating it as a different artifact source. Do not ask the LLM to invent proxy credentials or embed them in a URL.
- For offline installation, accept only a user-selected local file or an existing path whose digest and component identity are recorded. Mark it downloaded first; loader checks and a representative smoke run are still required before it becomes loadable or verified.

## Package and node recovery order

For a dependency failure, diagnose in this order: exact Python executable and architecture, Torch/CUDA or ROCm ABI, pinned node commit, package index response, then the node's import log. Snapshot before mutation, make one bounded repair, and re-run the smallest representative check. Do not run blanket upgrades or let a package index select a newer Torch build implicitly.

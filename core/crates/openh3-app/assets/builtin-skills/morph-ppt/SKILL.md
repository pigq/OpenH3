---
name: morph-ppt
description: "Use when the user wants a .pptx with continuous cross-slide motion, PowerPoint Morph transitions, or shared shapes that move, resize, rotate, enter, or exit across adjacent slides. For a generic static deck or isolated entrance effects, use officecli-pptx; for fundraising without Morph, use officecli-pitch-deck."
---

> **⚠️ Platform note — read before running any command.** The shell snippets in this skill are written for **macOS / Linux** (bash/zsh). Always check which OS you are on first. On **Windows** do **not** run them verbatim — the underlying tool/CLI commands are usually cross-platform, but the surrounding shell syntax is not. Translate it to PowerShell before running:
>
> | bash (macOS / Linux) | PowerShell (Windows) |
> | --- | --- |
> | `a && b` | run as two steps, or `a; if ($?) { b }` |
> | `cat <<'EOF' \| tool …` (heredoc) | write the text to a temp file, then pipe/pass that file to the tool |
> | `VAR=$(cmd)` … `$VAR` | `$VAR = cmd` … `$VAR` |
> | `cmd > /dev/null` | `cmd > $null` |
> | `… \| grep PAT` | `… \| Select-String PAT` |
> | `… \| jq …` | `… \| ConvertFrom-Json`, then read the fields |
> | `python3 x.py` | `python x.py` (or `py x.py`) |
> | `~/dir`, `/tmp` | `$env:USERPROFILE\dir`, `$env:TEMP` |
> | `cp` / `mkdir -p` / `rm -rf` | `Copy-Item` / `New-Item -ItemType Directory -Force` / `Remove-Item -Recurse -Force` |
>
> If a command has no obvious Windows equivalent, prefer the built-in file/HTTP tools over raw shell.

# OfficeCLI Morph-PPT Skill

**This skill is a scene layer on top of `officecli-pptx`.** Read its current layout, tool-help, shell, and Delivery Gate sections as dependencies in this session. This file adds cross-slide naming, lifecycle planning, ghosting, style references, and Morph-specific structural/runtime checks. User-provided scope and design take precedence over default recipes; preserve factual accuracy and readable output.

When the pptx base rules cover it, the text here says `→ see pptx v2 §X`. Read `skills/officecli-pptx/SKILL.md` first if you have not.

## Setup

If `officecli` is missing:

- **macOS / Linux**: `curl -fsSL https://d.officecli.ai/install.sh | bash`
- **Windows (PowerShell)**: `irm https://d.officecli.ai/install.ps1 | iex`

Verify with `officecli --version` (open a new terminal if PATH hasn't picked up). If install fails, download a binary from https://github.com/iOfficeAI/OfficeCLI/releases.

## ⚠️ Help-First Rule

**This skill teaches the Morph workflow — when shape names must match, when to ghost, when the CLI auto-prefixes — not every command flag.** When a prop name, enum, or preset is uncertain, consult help BEFORE guessing.

```bash
officecli help pptx slide           # authoritative for: transition, advanceTime, advanceClick, background
officecli help pptx transition      # transition / transitionDuration / transitionSpeed (Parent: slide)
officecli help pptx shape           # name, preset, x/y/width/height, fill, rotation, opacity, animation
officecli help pptx animation       # preset + trigger + duration values
officecli help pptx <element> --json  # machine-readable schema
```

Help reflects the installed CLI version. When skill and help disagree, **help wins.** Examples use `transition=morph` and combined timing values such as `morph-slow` or `morph-1500`; establish supported syntax and actual readback from installed help/output before using them. This document is not a capture proving every property works on the current machine.

## Mental Model & Inheritance

**Inherits the current officecli-pptx skill.** Read it in this session when needed; do not open another session or ask the user to resolve a tool-knowledge gap.

**Shared rules:**

- Use the current base layout/readability guidance, adapted to the task's template and canvas.
- Consult installed help for shape, chart, connector, animation, and batch support. Do not apply historical version limits as universal guarantees.
- Follow shell quoting rules and check command status before interpreting readback.
- Run current base Gate 1 (schema), Gate 2 (issues), Gate 2b (placeholders), and Gate 3 (visual review). Preserve its screenshot/HTML capability boundary and continue authorized repair after diagnosis.
- Animation count and duration serve the narrative and target viewer; there is no inherited one-animation or fixed-duration cap.

**Morph identity — what this skill owns (delta on top of pptx v2):**

- **Cross-slide shape-name binding.** PowerPoint's Morph engine pairs shapes by **identical `name=`** across adjacent slides and interpolates their position / size / rotation / fill / opacity. No matching name ⇒ no animation, silent fade. This is a workflow discipline, not a CLI feature.
- **Namespace prefixes:** `!!scene-*` (persistent decoration, never ghosted) / `!!actor-*` (content that evolves then exits) / `#sN-*` (per-slide content, ghosted on slide N+1). Plan the names BEFORE you `add`.
- **Ghost position `x=36cm`** (off the right edge of the 33.87cm canvas). Never delete a `!!`-prefixed shape — move it off-canvas so the morph exit animation still plays.
- **`transition=morph` auto-prefix quirk.** The CLI auto-prepends `!!` to every shape on a morph slide (`#s1-title` is stored as `!!#s1-title`). `@name=` path selectors **still resolve** — `get .../shape[@name=#s1-title]` returns the shape (matching is suffix/prefix-tolerant). The name you read back is the prefixed form. See §Known Issues.
- **Adjacent-slide spatial variety.** Displacement ≥ 5cm or rotation ≥ 15° between pairs — otherwise morph interpolates nothing visible.
- **Renderer reality.** Structural metadata and still images do not prove Morph playback. Verify motion in an available target presentation viewer, record the viewer/version used, and report runtime behavior as unverified if playback cannot be observed.

### Reverse handoff — when to go BACK to pptx base (or sibling skills)

Stay in **pptx v2 base** for any deck without cross-slide motion (board reviews, sales decks, all-hands, training). Stay in **officecli-pitch-deck** for fundraising narrative arcs without morph. Use this skill only when the user explicitly asks for "morph" / "smooth transitions" / "continuous animation" AND ≥ 2 consecutive slides share a visual element that transforms. "Animated deck" meaning one-off entrance animations → pptx v2 §Animations, not morph.

## Shell & Execution Discipline

**Shell quoting, incremental execution, `$FILE` convention** → see pptx v2 §Shell & Execution Discipline. Same rules verbatim.

**Morph-specific additions:**

- **`!!` in shell values — single-quote.** Bash / zsh history expansion eats unquoted `!!foo`. Always use `--prop 'name=!!scene-ring'` (single quotes). In Python `subprocess.run([...])` lists, no quoting needed — pass `"name=!!scene-ring"` as a plain string.
- **`$` in prop text — single-quote literal prices.** Use `--prop text='$9/mo'`, not a double-quoted shell value that can expand positional parameters. Compare extracted text against source values; the Price / metric text integrity check below supplies review candidates only.
- **`#` in shell values — safe, but quote anyway.** `#` is a comment leader only at the start of a shell word. `--prop name=#s1-title` works, but `--prop 'name=#s1-title'` is the habit that stops you guessing.
- **Batch heredoc is the cleanest path for multi-shape slides.** `<<'EOF' | officecli batch $FILE` disables all shell expansion — safe for `$`, `!!`, `#`, `'` inside the JSON body.
- **`--json` responses wrap the payload in `.data.results[]`.** Both `query` and `get` return a `.data.results[]` array. A single node's `format` sits at `.data.results[0].format.X`; that node's children sit at `.data.results[0].children[]` (each child's format at `.data.results[0].children[].format.X`). Always go through `.data.results[0]` — bare `.data.children[]` or `.data.format` returns null silently.
- **Variable:** `FILE="deck.pptx"` at the top of every build script; every example below uses `$FILE`.
- **Gate result discipline.** Check each command exit status and response shape before counting results. Informational inventories and successful readback may print lines; neither stdout length nor a missing grep match proves success. Count only explicit confirmed defects, and keep unverified checks separate.

## Two primitives this skill owns

- **Scene Actors** = persistent `!!`-named shapes (decoration or content) **paired by identical name** across adjacent slides so Morph can interpolate them. Every `!!scene-*` / `!!actor-*` shape is a scene actor.
- **Choreography** = the plan for how actors evolve — who moves where, who enters, who exits, on which slide pair. Written BEFORE code in the §Morph Pair Planning table.

Use this skill when the user asks for cross-slide motion and the plan contains elements that transform between slides. Confirm available target-viewer capabilities from evidence; explain a real compatibility limitation when it affects the requested output.

**Speaker notes.** Add narration notes when the presentation brief calls for a speaking deck or minimal visuals need explanation. Do not invent a missing base-rule number or require notes for a user-requested silent/visual sequence.

## What is Morph? (core mechanics)

PowerPoint's Morph transition creates smooth motion by interpolating shape properties between adjacent slides, matched by **identical shape names**.

```
Slide 1: shape name="!!scene-ring" x=5cm  width=8cm   fill=E94560 opacity=0.3
Slide 2: shape name="!!scene-ring" x=20cm width=12cm fill=E94560 opacity=0.6
         ↓  transition=morph on slide 2
Result:  Ring smoothly moves, grows, and fades darker over ~1 second
```

Morph only runs if slide N+1 carries `transition=morph`. Apply it via `officecli add / --type slide --prop transition=morph` on creation, or `officecli set "/slide[N]" --prop transition=morph` after the fact. Slides 2+ that omit this prop fall back to whatever the master defines (usually no transition) — motion dies silently.

**Three-prefix naming system (non-negotiable):**

| Prefix | Role | Lifecycle | Example |
|---|---|---|---|
| `!!scene-*` | Background / decoration — persists across the entire deck | Set once, adjust position/size to create motion; **rarely ghosted** | `!!scene-ring`, `!!scene-bg-band`, `!!scene-grid` |
| `!!actor-*` | Content / foreground — evolves across a section | Introduced on slide N, modified on slide N+1, N+2…, **ghosted to `x=36cm`** on its exit slide | `!!actor-feature-box`, `!!actor-metric`, `!!actor-headline` |
| `#sN-*` | Per-slide content (titles, bullets, captions) | Added fresh on slide N, **ghosted to `x=36cm`** on slide N+1 | `#s1-title`, `#s2-kpi`, `#s3-caption` |

**Name uniqueness:** different intended actors must not share the same full name on one slide. Exact names identify planned pairs across slides; `!!scene-card` and `!!actor-card` are different names, so their shared suffix alone is not a collision.

**Charts can be morph-paired.** `officecli add … --type chart` accepts `--prop name=!!…` (the name reads back), so a chart with an identical `!!`-name on adjacent slides participates in shape-name morph pairing — the chart frame interpolates position / size. Note morph cannot interpolate the *plotted data* inside the chart frame. For bar-grow / line-grow narratives where the bars themselves must animate: (a) accept plain fade-in of the chart as-is, OR (b) build N `!!actor-bar-K` rectangles manually sized to the values and morph those — each rect carries the same `!!actor-bar-K` name across adjacent slides while width / height / fill evolves.

**Cloned slides can retain stale content.** Compare each slide against the lifecycle plan: an actor intentionally visible on that slide is not a leak. An actor that should have exited must be off-canvas when retained for pairing. Ghost counts alone do not establish either condition.

**Spatial variety follows the story.** Plan a perceptible position, size, rotation, or appearance change where a pair is intended to move; one moving hero can be enough. Intentional holds are valid. Validate the planned change and watch the actual transition rather than requiring three actors or arbitrary distance thresholds on every pair.

**Simultaneous-timing constraint.** All `!!` shapes in one morph pair animate simultaneously. To stagger shape A before shape B, insert an intermediate keyframe slide — there is no per-shape delay knob.

**Paired vs enter vs exit — three behaviors, one rule.** Same mechanism (shape-name match) produces three outcomes:

| Behavior | Source slide A | Target slide B | Who carries `!!`? |
|---|---|---|---|
| **Paired morph** (interpolate) | has `!!foo` | has `!!foo` | both slides, identical name |
| **Enter** (fade / morph-in) | — (no counterpart) | has `!!foo` | target only — new shape |
| **Exit via ghost** (slide off) | has `!!foo` at visible `x` | has `!!foo` at `x=36cm` | both — same name, B is off-canvas |

**Outgoing content (not incoming) is what gets `!!`-prefixed + ghosted.** `!!actor-*` shapes silently "disappear" when you forget them — their name going missing on slide B reads as an unpaired exit (plain fade). Always explicit-ghost to `x=36cm` so the exit animation slides off the right edge visibly. One runnable example:

```bash
# Slide 2: actor is visible at x=5cm — Slide 3: same name, ghosted off-canvas → visible slide-off motion
officecli add "$FILE" "/slide[3]" --type shape --prop 'name=!!actor-metric' \
  --prop text="42%" --prop x=36cm --prop y=8cm --prop width=6cm --prop height=3cm
```

**Per-slide content (`#sN-*`).** Give slide-specific titles/captions distinct names unless they intentionally transform as the same actor. If outgoing content is retained for a slide-off, keep its paired name and ghost it; otherwise follow the planned entry/exit behavior. Do not add or ghost shapes solely to satisfy a prefix-count rule.

## Morph Pair Planning (pre-code, REQUIRED)

Before planning morph pairs, if the deck's audience / purpose / narrative is underspecified, run the planning prompt in `reference/decision-rules.md` to emit a `brief.md` first — a morph arc without a narrative spine collapses into "slide with motion", not "story with motion".

Plan every transition in a table inside `brief.md` **before** writing any `officecli add`. Renaming shapes mid-build is the #1 cause of ghost accumulation bugs.

| Pair | Slide A (start) | Slide B (end) | Actors in play | Ghost on Slide B |
|---|---|---|---|---|
| 1→2 | `!!scene-ring` centered 5cm, `#s1-title` visible | Ring shifts to x=20cm, grows 8→12cm; `#s2-subtitle` revealed | `!!scene-ring` evolves | `#s1-title` → x=36cm |
| 2→3 | `!!actor-feature-box` large (14cm wide) | Feature box small (6cm), `!!actor-metric` enters | `!!scene-ring`, `!!actor-feature-box`, `!!actor-metric` | `#s2-subtitle` → x=36cm |
| 3→4 | Content section A | Section B divider | — | `!!actor-feature-box` + `!!actor-metric` → x=36cm (section-exit); `#s3-*` → x=36cm |

**Planning rules:**

1. Decide ALL `!!` names up front — each morph-paired shape must use the **exact same name** on both slides.
2. Classify every `!!` shape as `!!scene-*` or `!!actor-*`. Scene shapes persist; actors must have a planned exit slide.
3. **Section-transition boundary:** when moving into a new topic section, ghost ALL previous-section `!!actor-*` on the first slide of the new section. Only `!!scene-*` (whole-deck decoration) remains.
4. Do NOT start building until the table is complete. If the plan changes mid-build, redraw the table and re-verify affected slides.

## Morph Recipes (4 patterns)

Four patterns cover ~95% of morph decks. `$FILE="deck.pptx"` throughout. Each block is self-contained and ≤ 20 lines.

### (a) Single-element morph — size / position

**Visual outcome.** A hero title centered on slide 1 (size 48pt at y=8cm), then slide 2 shrinks it to 32pt and shifts it to the top-left corner (x=1.5cm, y=1cm) — letting fresh slide-2 content take center stage. One shape, clean motion, no actors.

```bash
FILE="deck.pptx"
officecli create "$FILE"; officecli open "$FILE"

# Slide 1 — hero
officecli add "$FILE" / --type slide --prop layout=blank --prop background=1E2761
officecli add "$FILE" /slide[1] --type shape --prop 'name=!!actor-headline' \
  --prop text="The one idea" --prop x=4cm --prop y=8cm --prop width=26cm --prop height=3cm \
  --prop font=Georgia --prop size=48 --prop bold=true --prop color=FFFFFF --prop align=center --prop fill=none

# Slide 2 — headline shrinks + moves; new body takes stage
officecli add "$FILE" / --type slide --prop layout=blank --prop background=1E2761 --prop transition=morph
officecli add "$FILE" /slide[2] --type shape --prop 'name=!!actor-headline' \
  --prop text="The one idea" --prop x=1.5cm --prop y=1cm --prop width=12cm --prop height=1.5cm \
  --prop font=Georgia --prop size=24 --prop bold=true --prop color=FFFFFF --prop align=left --prop fill=none
officecli add "$FILE" /slide[2] --type shape --prop 'name=#s2-body' \
  --prop text="Here is the supporting evidence." --prop x=1.5cm --prop y=5cm --prop width=30cm --prop height=2cm \
  --prop font=Calibri --prop size=20 --prop color=CADCFC --prop fill=none

officecli close "$FILE"; officecli validate "$FILE"
```

### (b) Multi-element coordinated morph — Actors / Choreography

**Visual outcome.** Three scene actors (`!!scene-ring`, `!!scene-dot`, `!!scene-band`) repositioned across 3 slides to feel like a camera pan. Fresh per-slide titles fade in / out via the `#sN-*` ghost pattern. Use this when the narrative has a continuous visual backdrop.

```bash
# Slide 1 — anchor composition (already built via recipe a; here we add actors)
officecli add "$FILE" /slide[1] --type shape --prop 'name=!!scene-ring' --prop preset=ellipse \
  --prop fill=E94560 --prop opacity=0.3 --prop x=5cm --prop y=3cm --prop width=8cm --prop height=8cm
officecli add "$FILE" /slide[1] --type shape --prop 'name=!!scene-dot' --prop preset=ellipse \
  --prop fill=0F3460 --prop x=28cm --prop y=15cm --prop width=1cm --prop height=1cm

# Slide 2 — morph: ring moves + grows, dot slides left (spatial variety ≥ 5cm on both)
officecli set "$FILE" "/slide[2]" --prop transition=morph
officecli add "$FILE" /slide[2] --type shape --prop 'name=!!scene-ring' --prop preset=ellipse \
  --prop fill=E94560 --prop opacity=0.6 --prop x=20cm --prop y=2cm --prop width=12cm --prop height=12cm
officecli add "$FILE" /slide[2] --type shape --prop 'name=!!scene-dot' --prop preset=ellipse \
  --prop fill=0F3460 --prop x=3cm --prop y=16cm --prop width=1.5cm --prop height=1.5cm
# Ghost slide-1 content (name path still resolves after morph — see Known Issues)
officecli set "$FILE" "/slide[2]/shape[@name=#s1-title]" --prop x=36cm 2>/dev/null || true

# Verify morph pair: identical names on slides 1 & 2
officecli get "$FILE" /slide[1] --depth 1 --json | jq -r '.data.results[0].children[]?.format.name // empty'
officecli get "$FILE" /slide[2] --depth 1 --json | jq -r '.data.results[0].children[]?.format.name // empty'
# Compare — `!!scene-ring` and `!!scene-dot` MUST appear on both, byte-identical.
# Note: morph stores names with a `!!` prefix; compare the prefixed forms.
```

### (c) Continuous multi-slide morph (story arc) — use helpers

**Visual outcome.** A 5-slide arc telling one continuous story: same 2 scene actors drift across the canvas as the narrative progresses; content (`#sN-*`) refreshes per slide and is ghosted on the next. Building this by hand is ~60 commands — use `reference/morph-helpers.py` to keep the build script short and auto-verified.

```python
#!/usr/bin/env python3
# Invoke the provided helper library for clone + ghost + verify
import subprocess, sys, os
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
HELPERS = os.path.join(SCRIPT_DIR, "reference", "morph-helpers.py")
FILE = "deck.pptx"

def helper(*args):
    subprocess.run([sys.executable, HELPERS, *[str(a) for a in args]], check=True)

# ... assume slide 1 is built with 2 scene actors (!!scene-ring, !!scene-dot) + #s1-title
# Helper builds slide 2–5 with: clone from previous + apply transition=morph + ghost previous #sN- content
# `clone` prints the cloned slide's shape list — read it to pick which shape indices carry the
# previous slide's #s(n-1)- content, then pass those explicit indices to `ghost`.
for n in range(2, 6):
    helper("clone", FILE, n - 1, n)          # clone + set transition=morph + list shapes (note the #s(n-1)- indices)
    helper("ghost", FILE, n, 1, 2)           # ghost the #s(n-1)- content shapes by index (here shapes 1 & 2)
    # …then add THIS slide's #sN- content via officecli add as normal…
helper("final-check", FILE)                   # structural pass; DOES NOT catch !! lingering in visible area
```

Helper signatures and source: `reference/morph-helpers.py` (`clone`, `ghost`, `verify`, `final-check`, `inspect-ghosts`). The bundled `reference/morph-helpers.sh` delegates its compatibility functions to Python and propagates failure status. Use an available Python runtime and inspect `--help` before adopting an older installed copy.

**When to use helpers vs raw commands.** Small decks may use raw commands with explicit error/readback checks. For repeated operations, use the Python helper and check its exit status. Read its actual checks and limitations: structural success does not establish lifecycle intent or animated playback. Preserve schema validation and visual/runtime review.

### (d) Morph + fade hybrid — entrance on morph slide

**Visual outcome.** A morph pair where `!!scene-ring` moves continuously while a NEW per-slide card fades in simultaneously. Used when a morph-paired backdrop carries the eye and fresh foreground content needs a softer entrance than a raw appearance.

```bash
# Slide 2 already has transition=morph and !!scene-ring. Add a new card with fade-entrance.
officecli add "$FILE" /slide[2] --type shape --prop 'name=#s2-card' --prop preset=roundRect \
  --prop fill=F5F7FA --prop line=none --prop x=2cm --prop y=12cm --prop width=10cm --prop height=5cm

# Apply simultaneous-with-morph fade entrance to the new card.
# 'fade-entrance-300-with' = fade in, 300ms, trigger=withPrevious (plays with the morph transition).
officecli set "$FILE" "/slide[2]/shape[@name=#s2-card]" --prop animation=fade-entrance-300-with
officecli get "$FILE" "/slide[2]/shape[@name=#s2-card]" --json | jq '.data.results[0].format.animation'  # readback sanity — drops the trigger suffix, reads back as "fade-entrance-300"
```

**Intended effect.** The paired backdrop carries continuity while the new card enters. Choose timing and supported entrance presets that fit the narrative; validate the installed syntax and observe the target viewer to confirm how entrance animation combines with Morph. Metadata readback alone cannot prove simultaneous playback.

## Choreography — animation types + staggered timing

How morph animates multiple shapes determines what the audience sees. Pick the right mechanism for each pair:

| Animation type | How to achieve it (between Slide A and Slide B) |
|---|---|
| Simple move | Same `!!` name on both slides, same size, different `x`/`y` — morph interpolates position |
| Scale transform | Same name, different `width`/`height` — morph interpolates size (and re-positions the center) |
| Move + scale | Different `x`, `y`, `width`, `height` simultaneously — morph handles all dimensions at once |
| Color / opacity shift | Same name, different `fill` or `opacity` — morph cross-fades the fill |
| Rotation | Same name, different `rotation` (degrees) — morph rotates along the shortest arc |
| Font size change | Same name, different `size` (pt) on text shape — interpolates in PowerPoint 365; less reliable on Keynote / WPS / LibreOffice (may degrade to crossfade). For portable motion, pair `size` change with a matching `width`/`height` delta or an `x`/`y` displacement — the spatial change keeps motion visible when size interpolation drops out |
| Enter (fade in) | Shape exists only on Slide B (no counterpart on A) — morph fades it in |
| Exit (fade out) | Shape exists only on Slide A (no counterpart on B) — morph fades it out |

**Multi-shape timing constraint.** All `!!` shapes in one morph pair animate **simultaneously** — there is no per-shape delay / duration knob in the CLI (help confirms: no `morph.duration` / `morph.delay` on slide). To stagger shape A before shape B, **split the transition into two pairs** with an intermediate slide:

```
Slide 2 → Slide 3:  !!actor-A moves (!!actor-B stays put)
Slide 3 → Slide 4:  !!actor-B moves (!!actor-A stays put or ghosts)
```

Slide 3 is an explicit intermediate keyframe. Do NOT attempt to fake staggering via timing props on the shape's `animation=` prop — Morph runs before per-shape animations.

**Motion design heuristic.** Position, scale, rotation, fill, and opacity are options for making a planned change visible. Use the properties needed by the story; a single hero translation or an intentional hold can be correct. Judge the rendered transition, not a fixed property-count quota.

**Structural review follows the choreography.** Check exact expected counterparts and planned endpoints for every intended pair. Persistent logos and fixed scenery are allowed. There is no three-shape acceptance quota; runtime motion remains a separate check.

**Deck-length rhythm.** Filling every transition with morph reads as anxious, not cinematic. Pace morph moments to deck length:
- **8-10 slides (dense):** 3-5 morph moments; motion can cluster.
- **12-18 slides (ceremonial):** 3-5 TOTAL morphs, spaced every 4-6 slides; use `transition=morph` at section dividers so the animation reads as chapter punctuation, not continuous agitation.
- **18+ slides (Act-based):** structure into 3 acts with 1 long section-divider morph between acts (5-10s of deliberate motion with a brief hold), plus 2-3 quieter morphs inside each act. Lean heavier on `!!scene-*` continuity than per-slide `!!actor-*` churn.

## Scene-actor spatial rule

Scene actors and actors moving across the canvas MUST stay in predictable zones during morph — otherwise they cross over content and read as clutter.

**Safe zones (prefer for scene actor rest positions and morph paths):**

```
Top-right corner:   x ≥ 24cm, y ≤ 6cm
Bottom-right:       x ≥ 24cm, y ≥ 12cm
Bottom-left:        x ≤ 2cm,  y ≥ 12cm
Off-canvas (ghost): x ≥ 33.87cm  (canvas right edge; use x=36cm for explicit ghost)
```

**Avoid resting actors in the content core:** `x = 2~28cm, y = 3~16cm`. Actors may **pass through** the core during morph (that's the motion), but they should not end a slide parked there with high opacity unless they are content themselves (`!!actor-*` carrying the slide's message).

**Before placing any scene actor, inspect existing shape bounds:**

```bash
officecli get "$FILE" "/slide[$N]" --depth 1 --json | \
  jq -r '.data.results[0].children[]? | "\(.format.name // .path)  x=\(.format.x) y=\(.format.y) w=\(.format.width) h=\(.format.height)"'
```

Confirm the actor's target position does not overlap any `#sN-*` content shape's bounding box (`x` to `x + width`, `y` to `y + height`). If it would overlap, lower actor `opacity` ≤ 0.15 OR move it to a safe zone.

## Style library lookup workflow

`reference/styles/` contains the currently bundled visual styles (dark / light / warm / vivid / bw / mixed) as design inspiration. The directory inventory is authoritative; not every style has a build script. Use the library as an on-demand reference.

**Why lookup, not copy.** Available build demos illustrate design techniques, but their coordinates fit their own content and may contain layout issues. Read design intent and adapt palette, shapes, and choreography to the actual content; do not run or copy a demo blindly.

**Four-step lookup:**

1. **Browse INDEX.** `reference/styles/INDEX.md` groups the available styles by palette and mood. Pick a style that fits the topic and user brand; verify its directory exists before reading it.
2. **Read philosophy.** Open `reference/styles/<style-id>/style.md` for design intent — type pairing, color logic, signature elements.
3. **Glance technique when present.** Read `reference/styles/<style-id>/build.sh` only if that file exists and implementation reference is useful. A style with only `style.md` is valid; continue from its design guidance without installing or inventing a missing script.
4. **Apply on your own canvas.** Build your deck using pptx v2 grid math + visual floor; borrow only the palette and the signature gesture.

**Pointer:** `→ see reference/styles/<style-id>/` — never inline-copy coordinates from a style build.sh.

## Delivery Gate (current pptx base + Morph checks)

Run the current `officecli-pptx` Delivery Gate by heading: schema, issues, placeholders, and visual review (Gates 1, 2, 2b, 3). Do not substitute historical C-P rules or obsolete numbered gates. Then apply the Morph checks below.

### Price / metric text integrity

Single-quote literal currency text when constructing shell commands. Compare rendered/extracted values to the source copy. A valid `$9/mo` or `$199/yr` is not a leak. This grep only locates suspicious missing-amount suffixes and escape/template tokens for review:

```bash
if ! MORPH_TEXT=$(officecli view "$FILE" text); then
  echo "REJECT: text extraction failed"; exit 1
fi
PRICE_REVIEW=$(printf '%s\n' "$MORPH_TEXT" | grep -nE '(^|[[:space:]])/(mo|month|yr|year|day|wk|week|hr|hour)([^[:alpha:]]|$)|\$\{[A-Z_]+\}|\\[nrt]|^\.$' || true)
printf '%s\n' "$PRICE_REVIEW"
```

A match is a review candidate, not automatic rejection: units, code examples, and punctuation can be intentional. Compare each suspect line against the actual intended text; fix confirmed substitutions, and do not treat an empty candidate list as proof that all amounts are intact.

### Complete slide inventory

Read every slide in the actual deck order, not a fixed five-slide sample. The example below uses the documented `.data.results`/`.children` layout; confirm the installed CLI contract before adopting it. Command failure or malformed/missing data cannot be PASS. PowerShell implementations must check `$LASTEXITCODE` before parsing JSON.

```bash
SLIDES_JSON=$(officecli query "$FILE" slide --json) || exit 1
SLIDE_PATHS=$(printf '%s\n' "$SLIDES_JSON" | jq -er '
  .data.results | if type == "array" and length > 0 then
    .[] | .path | if type == "string" and length > 0 then . else error("missing slide path") end
  else error("missing slide inventory") end') || exit 1
while IFS= read -r SLIDE_PATH; do
  SLIDE_JSON=$(officecli get "$FILE" "$SLIDE_PATH" --depth 1 --json) || exit 1
  printf '%s\n' "$SLIDE_JSON" | jq -e '
    .data.results | type == "array" and length == 1 and (.[0].children | type == "array")' >/dev/null || exit 1
  printf 'INVENTORY %s\n' "$SLIDE_PATH"
  printf '%s\n' "$SLIDE_JSON" | jq '.data.results[0]'
done <<< "$SLIDE_PATHS"
```

These are diagnostic inventories; normal output is not a defect. For the full deck, record each check's evidence and status:

1. **Actor lifecycle:** compare each `!!actor-*` against its expected state in `brief.md` on that specific slide: active, exiting, already exited, or intentionally re-entering. Visible active actors are valid. Only planned off-canvas actors that remain visible are leaks. Use the real slide dimensions and shape bounds, including transforms; do not default missing geometry to zero or blindly apply the 33.87cm example width.
2. **Planned transformations:** inspect every adjacent pair intended to Morph, including pairs beyond slide 5. Compare properties of the same planned names on both sides; added/removed rows in a text diff do not prove motion. A single paired hero or an intentional hold is valid when planned. Missing expected counterparts, wrong endpoints, or missing transition metadata are structural defects.
3. **Name pairing:** compare exact readback names across each planned pair. Normalize an optional `!!` only when classifying content prefixes (`#sN-*` and `!!#sN-*`); preserve exact names when determining pairs. Do not infer pairing from a count of any two names. Duplicate text alone is a review hint, not a defect: repeated logos, labels, and captions can be intentional.
4. **Per-slide content:** inspect all older content retained on each later slide, not only the immediately previous prefix. Recognize both `#sN-*` and `!!#sN-*`. Match the intended lifecycle: retained outgoing elements needed for a slide-off should be off-canvas; do not invent an absent counterpart or move current content off-canvas just to satisfy a filter.
5. **Visual and runtime review:** apply base Gate 3 to every slide. Static HTML/PNG and structural helper results cannot validate animated playback; observe the intended transitions in an available target viewer, and record any unverified runtime behavior.

Reject confirmed structural/content defects and continue authorized repair. Informational lines, deliberate composition choices, and explicitly unverified runtime checks must not be converted into automatic rejection or fake PASS by counting stdout lines.

## Renderer honesty

Viewer support varies with application and version. Use an available presentation viewer that supports the requested transition and record what was actually observed. If a viewer falls back to a fade or static page, investigate compatibility and the file's transition structure before attributing a renderer bug.

Static screenshots, HTML previews, and helper checks establish only their stated structural/visual evidence. They do not prove Morph interpolation, timing, or motion quality. If runtime inspection is unavailable, deliver the authorized work with a precise "Morph playback not verified" limitation rather than asserting motion works in a named application.

## Ghost Discipline & Actor Lifecycle

**Every `!!actor-*` and `#sN-*` shape must be managed across EVERY slide, not just its "exit" slide.**

### Per-slide lifecycle rule

Each slide has its own shape list. Cloning can carry an earlier shape forward, while creating a blank slide does not automatically add it. Follow the planned lifecycle instead of ghosting every actor on every slide:

1. Keep actors visible on the slides where they carry content.
2. On a planned slide-off transition, retain the exact paired name on the destination and move that counterpart outside the actual canvas.
3. On later slides, inspect retained/cloned shapes and keep exited actors off-canvas unless re-entry is planned. Do not add redundant shapes where no pairing requires them.
4. Check command success and readback after every mutation; missing selectors or failed writes are not harmless results to suppress with `|| true`.

### Ghost inventory and cleanup

Use `morph-helpers.py final-check` as the structural check described by its actual help/output. A large ghost inventory or repeated text is a review prompt, not proof of a leak. Confirm lifecycle and adjacency before any cleanup.

For a continuous Morph deck, `final-check` defaults to requiring Morph metadata on every slide after slide 1. For a mixed-transition deck, pass the actual **destination slide numbers** from the choreography, for example:

```bash
python "$MORPH_HELPER" final-check "$FILE" --morph-slides 2,4,6 || exit 1
```

Resolve `MORPH_HELPER` to this skill's absolute `reference/morph-helpers.py` path. Every slide still receives the helper's content/structure checks; only the listed destinations require Morph metadata. The single-slide `verify` command expects Morph on slides after slide 1, so do not use it to reject an intentionally static destination. This flag is a structural scope declaration, not proof of runtime motion or a substitute for lifecycle review.

`morph-helpers.py clean-accumulation` is a **read-only** inventory alias in the bundled helper; it must not delete shapes by count. Never remove an arbitrary tail of off-canvas shapes to reach a fixed threshold. If editing redundant shapes is needed, identify them individually from the plan, preserve every required pair, and recheck affected transitions afterward.

## Common Morph Pitfalls (design + workflow traps)

Base pptx pitfalls (shell quoting, zsh `[N]` globbing, hex `#` prefix, `\n` in prop text) → see pptx v2 §Common Pitfalls. These are the morph-specific traps:

| Pitfall | Correct approach |
|---|---|
| `!!scene-card` and `!!actor-card` | These full names differ and can coexist. Reject duplicate full names only when they ambiguously identify distinct actors on the same slide. |
| Renaming shapes mid-build after some slides are already done | Ghost accumulation bug waiting to happen. Stop, redraw the §Morph Pair Planning table, rerun affected slides |
| Placing `!!actor-*` into the content core without planning an exit | Every `!!actor-*` needs a ghost slide. Plan it in the pair table BEFORE coding |
| **Unexpected retained content (M-2)** | Compare every slide with the actor lifecycle plan. Ghost only actors expected to be off-canvas there; count alone does not establish a defect or authorize deletion. |
| Missing intended Morph transition metadata | Check every planned destination slide using installed help/readback; then verify playback in the target viewer. |
| Assuming `@name=` paths break on a morph slide | They do not — `@name=` still resolves after `transition=morph` (M-1); only the *readback* name gains a `!!` prefix |
| Adjacent slides visually identical | Compare with the plan: a hold can be intentional. For intended motion, change the planned actor properties and observe the transition; no universal minimum actor count applies. |
| Trying to stagger 2 shapes via per-shape timing | Not supported — split the pair into two transitions with an intermediate keyframe slide |
| Testing Morph through a static preview | Static rendering cannot prove runtime playback. Record the actual viewer/version and observed behavior; leave unavailable runtime checks unverified. |
| Deleting a `!!` shape on exit instead of ghosting it | Deletion breaks morph pairing — the shape vanishes without animation. Always ghost to `x=36cm` |
| Writing `--prop text="$9/mo"` with double quotes | Shell eats `$9` as empty variable → text stored as `/mo` or stray `.`. Use single quotes: `--prop text='$9/mo'`. Gate 2 morph addendum greps this leak. |
| Using `<a:br/>` literal inside `--prop text='line1<a:br/>line2'` | Stored as 7 literal characters, not a line break. Use `officecli add "/slide[N]/shape[@id=K]" --type paragraph` once per line (M-6). |
| Using `shape[name^=!!actor-]` selector | `officecli query` has no `^=` operator — returns `invalid_selector`. Use `get /slide[N] --depth 1 --json \| jq '.data.results[0].children[]? \| select(.format.name \| startswith("!!actor-"))'`. |
| Running `validate` while resident mode is open | Pptx v2 inherits this trap — `officecli close "$FILE"` BEFORE `validate` |

## Known Issues & Pitfalls

Read the current `officecli-pptx` §Common Pitfalls and installed element help. Historical numbered C-P sections are not a current contract; apply a workaround only when evidence shows the relevant issue.

**Morph-specific (M-1..5):**

| # | Symptom | Workaround |
|---|---|---|
| **M-1** | After `officecli set '/slide[N]' --prop transition=morph`, every shape on that slide has `!!` auto-prepended to its name (`#s1-title` → `!!#s1-title`). The readback name is the prefixed form. **Selector filter caveat:** after auto-prefix, `!!#sN-caption` coexists alongside `!!actor-*` — filtering "scene actors" in `jq` with `startswith("!!")` produces false matches on auto-prefixed content. Always filter with `startswith("!!actor-")` or `startswith("!!scene-")`, never bare `startswith("!!")`. | `@name=` path selectors **still resolve** — `/slide[N]/shape[@name=#s1-title]` returns the shape (matching is suffix/prefix-tolerant), so no path rewrite is needed. When you need the prefixed name in a jq filter, account for the leading `!!`. |
| **M-2** | Cloned slides can retain actors after their planned exit. | Compare expected lifecycle with actual per-slide shapes. Preserve active actors and needed off-canvas counterparts; do not reject or delete based on ghost count. |
| **M-3** | Section-transition boundary — on the first slide of a new topic section, previous-section `!!actor-*` shapes visibly linger. No command errors; only visual clutter. | On every section-start slide, explicitly ghost ALL `!!actor-*` from the previous section to `x=36cm`. Scene shapes (`!!scene-*`) stay. |
| **M-4** | Agents sometimes invent `morph.duration=` / `transition.delay=` as independent props — they are rejected as UNSUPPORTED. | Use the combined shorthand on the `transition` prop: `transition=morph-slow` / `-fast`, or `transition=morph-<DUR_MS>` (e.g. `transition=morph-1500`). Both round-trip on readback (`transitionSpeed=slow`, `transitionDuration=1500`). Only beyond what the shorthand exposes (fine control of the raw XML), fall back to `raw-set` on `<p:transition>` — see M-4 example block below. |
| **M-5** | Runtime Morph playback differs between viewers or versions. | Inspect the file and available target viewer. Structural validation is not playback validation; report what was actually tested. |
| **M-6** | `<a:br/>` written inside `--prop text='line1<a:br/>line2'` is stored as the literal 7-character string, NOT interpreted as a line break. Audience sees `line1<a:br/>line2` rendered verbatim. | For multi-line bullets / captions, add one paragraph per line: `officecli add "/slide[N]/shape[@id=K]" --type paragraph --prop text='line1'` then repeat with `text='line2'`. See pptx v2 §Shell escape for the real-newline workflow. |

**M-4 example — slow down all morph transitions, raw-set fallback** (prefer `transition=morph-slow`; use this only for control beyond the shorthand). Note `//p:transition` matches both `mc:Choice` and `mc:Fallback` on a morph slide, yielding `2 element(s) affected`:

```bash
# Per-slide: add spd="slow" to every transition element on slide N (2 XML hits per morph slide)
for N in 2 3 4; do
  officecli raw-set "$FILE" "/slide[$N]" --xpath "//p:transition" --action setattr --xml 'spd=slow'
done
officecli validate "$FILE"
```

Readback: `officecli query "$FILE" slide --json | jq '.data.results[].format | select(.transition=="morph") | .transitionSpeed'` prints `"slow"` for each affected slide.

## Outputs & delivery

By default, deliver these three artifacts; follow the user's requested output scope when it differs:

1. `<topic>.pptx` — the deck, closed + `officecli validate` clean (Delivery Gate 1 OK).
2. `build.sh` or `build.py` — the re-runnable script (bash for shell-native builds; Python for multi-slide arcs using `morph-helpers.py`). Must recreate the deck from a fresh `officecli create` call.
3. `brief.md` — **standalone file, NOT embedded in anything else.** Contains:
   - Section 1: topic / audience / purpose / narrative / style direction (1 named style from `reference/styles/INDEX.md`)
   - Section 2: slide-by-slide outline (page type + one-sentence argument per slide)
   - Section 3: §Morph Pair Planning table (Pair / Slide A / Slide B / Actors / Ghosts) — the design record the reviewer needs to audit choreography

**Pre-deliver reminder to the user (verbatim-safe wording):**

- State the observed verification status: "The deck includes Morph transition metadata; playback was verified in <viewer/version>" only when actually observed, otherwise "Morph playback has not been verified in the target viewer."
- "While the build script is running, the `.pptx` may be rewritten several times. If you want to preview progress, use `officecli watch "$FILE"` and open the live preview in OpenH3 — do NOT click 'Open with system app' during the build, or you'll hit a file lock."

## Adjustments after creation

Standard adjustments → see current pptx base guidance and installed `swap` / `move` / `remove` / `set` help. After any reorder, recheck the actual adjacency, exact paired names, endpoints, and lifecycle of every affected pair; update the choreography when the order changes.

**Final sanity check before delivery.** Run the current base gates and all applicable Morph checks above. Inspect runtime transitions in an available compatible viewer; if unavailable, state the exact limitation. Repair confirmed defects and recheck affected pairs. A structural helper success never implies that animated playback was tested.

## References

- `reference/decision-rules.md` — Pyramid Principle, SCQA, page-type menu, `brief.md` schema. Read during §Morph Pair Planning to decide narrative arc before writing commands.
- `reference/pptx-design.md` — residual design notes (Scene Actors mechanics, page-type table, choreography patterns). Canvas / fonts / colors live in pptx v2 — this file covers only the morph-unique material.
- `reference/morph-helpers.py` — Cross-platform (Mac / Windows / Linux) Python helpers for clone + ghost + verify + final-check. Import as a library or call via CLI args. Preferred for 5+ slide arcs.
- `reference/morph-helpers.sh` — Bash compatibility functions delegated to the Python helper, preserving its exit status; Windows can call Python directly.
- `reference/styles/INDEX.md` — current bundled visual style inventory grouped by palette and mood. Style guidance is usable even when no build script is present.
- `skills/officecli-pptx/SKILL.md` — current base layout/readability, shell, tool-help, Common Pitfalls, and Delivery Gate sections.

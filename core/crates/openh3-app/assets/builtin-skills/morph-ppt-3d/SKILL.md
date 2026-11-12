---
name: morph-ppt-3d
description: 3D Morph PPT — extends morph-ppt with GLB model insertion, cinematographic camera, model-content layout, and enriched visual design system.
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

# Morph PPT — 3D Extension

This skill **extends** `morph-ppt`. All morph-ppt rules (naming, ghosting, design, verification) apply in full.
This file covers **3D-specific additions** and an **enriched design system** combining morph-ppt aesthetics with concrete color palettes, font pairings, and layout quality guardrails.

---

## Setup

If `officecli` is missing:

- **macOS / Linux**: `curl -fsSL https://d.officecli.ai/install.sh | bash`
- **Windows (PowerShell)**: `irm https://d.officecli.ai/install.ps1 | iex`

Verify with `officecli --version` (open a new terminal if PATH hasn't picked up). If install fails, download a binary from https://github.com/iOfficeAI/OfficeCLI/releases.

## Use when

- User wants a `.pptx` with a `.glb` 3D model and Morph transitions.

---

## 3D Model Compatibility Gate (before generation)

1. The deck requires `.glb`. If the user supplies another format, first check available authorized conversion tools (for example an installed Blender importer/exporter), their actual format support, and required textures. When conversion is supported, create a separate `.glb`, preserve the original, and verify geometry/materials before insertion. Do not require the user to perform a conversion the agent can complete. Ask for a compatible file or a specific fidelity decision only when no permitted conversion route works; do not silently discard animation, materials, or geometry.
2. If user has no model, follow the **Model Discovery Flow** below.
3. Keep model assets, deck, and build script in an organized task directory with resolvable relative paths; QA subdirectories and requested extra outputs are allowed.

---

## Model Discovery Flow (when user has no model)

When the user gives a topic but no `.glb` file, **proactively help them find a matching model** instead of just listing websites.

### Step 1: Understand the topic and suggest model direction

Based on the user's topic, suggest what kind of 3D model would work:

| Topic type         | Model suggestion                    | Example                                               |
| ------------------ | ----------------------------------- | ----------------------------------------------------- |
| Product/brand      | The actual product or a similar one | "coffee brand" → coffee cup, coffee machine, bean     |
| Animal/character   | The animal or mascot                | "fox mascot" → fox 3D model                           |
| Architecture/space | Building, room, or structure        | "new office" → office building, interior              |
| Vehicle/transport  | The vehicle itself                  | "EV launch" → car, motorcycle, bicycle                |
| Food/cooking       | The dish or ingredient              | "Japanese food" → sushi platter, ramen bowl           |
| Tech/gadget        | The device                          | "phone launch" → phone, tablet, laptop                |
| Nature/science     | The subject                         | "solar system" → planet, sun, earth                   |
| Abstract concept   | A symbolic object                   | "teamwork" → puzzle pieces, gears, bridge             |

Tell the user: "Your topic is [X]. I suggest using a 3D model of [description]. Here are some free sources to find one:"

### Step 2: Search for models (agent-driven)

**Proactively search for models on behalf of the user.** Don't just list websites — actually find candidates.

**Search strategy (try in order):**

1. **Web search** for free GLB models matching the topic:

   ```
   Search: "[topic keyword] 3d model glb free download"
   Example: "fox 3d model glb free download"
   ```

2. **Sketchfab API** (no auth needed for search):

   ```bash
   curl -s "https://api.sketchfab.com/v3/search?type=models&q=[keyword]&downloadable=true&archives_flavours=glb" \
     | python3 -c "
   import json, sys
   data = json.load(sys.stdin)
   for m in data.get('results', [])[:5]:
       print(f\"Name: {m['name']}\")
       print(f\"URL: https://sketchfab.com/3d-models/{m['slug']}-{m['uid']}\")
       print(f\"Likes: {m.get('likeCount', 0)}, License: {m.get('license', {}).get('label', 'unknown')}\")
       print()
   "
   ```

3. **Poly Pizza** (direct GLB download, all free):

   ```bash
   # Search results page — parse for download links
   curl -s "https://poly.pizza/api/search/[keyword]" 2>/dev/null
   ```

4. **Khronos glTF-Sample-Assets** (public sample fallback; verify availability and suitability):
   ```bash
   # Public sample URL — check HTTP status and downloaded file before using it
   curl -L -o model.glb "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/[ModelName]/glTF-Binary/[ModelName].glb"
   ```
   Available models: Duck, Fox, Avocado, BrainStem, CesiumMan, DamagedHelmet, FlightHelmet, Lantern, Suzanne, WaterBottle, etc.

### Step 3: Select a model within the user's request

If the user delegated model selection or asked you to build the deck, choose a suitable freely downloadable model with a verified license and proceed. Briefly record its source, license, and why it fits. Do not add another confirmation for the same authorized search or download. A purchase, account action, or license restriction outside the requested use needs a specific user decision.

If the user requested options or reserved model selection, show 2-3 candidates with:

- Model name and source
- Preview link (Sketchfab URL or description)
- License info
- Why this model fits their topic

Example response:

```
Based on your topic "fox mascot", here are some models I found:

1. Fox (Khronos sample)
   Direct download, guaranteed compatible
   Why: clean fox model, good for mascot/character decks

2. Low Poly Fox (Poly Pizza)
   URL: https://poly.pizza/m/xxx
   License: CC0 (completely free)
   Why: low-poly style, good fit for clean minimal design

3. Cartoon Fox (Sketchfab)
   URL: https://sketchfab.com/3d-models/fox-xxx
   License: CC BY 4.0 (free, commercial use ok)
   Why: expressive face, high detail

Which one do you want? I'll download it and start building.
```

Wait for a model choice only when the user reserved that choice or the remaining candidates require a decision outside the authorized scope.

### Step 4: Download the selected model

Download the model selected by the user or under their delegated selection:

```bash
# For Sketchfab (if user has the download URL)
curl -L -o model.glb "[download_url]"

# For a public Khronos sample (verify network/download result)
curl -L -o model.glb "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Fox/glTF-Binary/Fox.glb"
```

After download, verify:

- File exists and is not empty
- File extension is `.glb`
- File size is under 50MB

If Sketchfab requires login to download, tell the user:

> "This model requires a Sketchfab login to download. You can grab the .glb file from the page and share it with me. Or I can use a Khronos sample model for a demo version first?"

### Step 5: When user says "anything" / "you decide" / "just make a demo"

Use the deck topic and existing context to choose the model. For an unconstrained demo, choose a simple sample and state the assumed topic. Ask for a topic only when it is necessary to meet a specific requirement and cannot be inferred; do not return delegated creative choices to the user as a mandatory questionnaire.

### Step 6: When user wants to find models themselves

Give specific website links with step-by-step guidance:

> **Recommended 3D model websites:**
>
> 1. **Sketchfab** (largest 3D model platform)
>    - Link: https://sketchfab.com/search?q=[keyword]&type=models&downloadable=true
>    - Filter steps: search keyword → check "Downloadable" → format "glTF" → sort by "Likes"
>    - When downloading, select **glTF (.glb)** format
>    - Note: some models require free registration to download
> 2. **Poly Pizza** (all free low-poly)
>    - Link: https://poly.pizza/
>    - All CC0 licensed — click Download to get .glb directly
>    - Best for: minimalist or cartoon-style presentations
> 3. **Sketchfab popular categories**
>    - Animals: https://sketchfab.com/search?q=animal&type=models&downloadable=true
>    - Food: https://sketchfab.com/search?q=food&type=models&downloadable=true
>    - Tech: https://sketchfab.com/search?q=gadget&type=models&downloadable=true
>    - Architecture: https://sketchfab.com/search?q=architecture&type=models&downloadable=true
> 4. **Free3D** (general free model site)
>    - Link: https://free3d.com/3d-models/glb
>    - Note: check the license type before use
> 5. **TurboSquid Free** (pro model site free section)
>    - Link: https://www.turbosquid.com/Search/3D-Models/free/glb
>
> After downloading, share the .glb file with me. If the download is a .gltf folder, use Blender to convert it to .glb.

### Step 7: When user gives keywords and asks agent to search

Proceed with Step 2 using the supplied keywords. If the user asked for options, return candidates; if they delegated selection and deck creation, continue through the selected download and build. Use Step 6 when the user wants to find the model themselves. Honor an actual tool or account approval requirement without inventing an extra chat-confirmation step.

### License reminder

Check the source's actual license before downloading, include any required attribution, and ensure it allows the requested use. If the license is unknown or incompatible, choose another suitable model within the user's request or ask for the specific missing usage decision.

---

## Visual Design System (4.0 enrichment)

morph-ppt provides the base design rules. This section adds **concrete palettes, font pairings, and layout quality rules** from PPT Creator to give the AI more variety and stronger guardrails.

### Color Palettes (pick one per deck, or blend)

Choose a palette that matches the **topic mood** — don't default to generic blue.

| Palette                | Primary               | Secondary             | Accent           | Body Text | Muted/Caption |
| ---------------------- | --------------------- | --------------------- | ---------------- | --------- | ------------- |
| **Coral Energy**       | `F96167` (coral)      | `F9E795` (gold)       | `2F3C7E` (navy)  | `333333`  | `8B7E6A`      |
| **Midnight Executive** | `1E2761` (navy)       | `CADCFC` (ice blue)   | `FFFFFF`         | `333333`  | `8899BB`      |
| **Forest & Moss**      | `2C5F2D` (forest)     | `97BC62` (moss)       | `F5F5F5` (cream) | `2D2D2D`  | `6B8E6B`      |
| **Charcoal Minimal**   | `36454F` (charcoal)   | `F2F2F2` (off-white)  | `212121`         | `333333`  | `7A8A94`      |
| **Warm Terracotta**    | `B85042` (terracotta) | `E7E8D1` (sand)       | `A7BEAE` (sage)  | `3D2B2B`  | `8C7B75`      |
| **Berry & Cream**      | `6D2E46` (berry)      | `A26769` (dusty rose) | `ECE2D0` (cream) | `3D2233`  | `8C6B7A`      |
| **Ocean Gradient**     | `065A82` (deep blue)  | `1C7293` (teal)       | `21295C`         | `2B3A4E`  | `6B8FAA`      |
| **Teal Trust**         | `028090` (teal)       | `00A896` (seafoam)    | `02C39A` (mint)  | `2D3B3B`  | `5E8C8C`      |
| **Sage Calm**          | `84B59F` (sage)       | `69A297` (eucalyptus) | `50808E`         | `2D3D35`  | `7A9488`      |
| **Cherry Bold**        | `990011` (cherry)     | `FCF6F5` (off-white)  | `2F3C7E` (navy)  | `333333`  | `8B6B6B`      |

**Rules:**

- One color dominates (60-70% visual weight), 1-2 supporting tones, one accent
- On light backgrounds: use Body Text color for copy, Muted for captions
- On dark backgrounds: use Secondary or `FFFFFF` for copy, Muted for captions
- For additional inspiration, browse `../morph-ppt/reference/styles/INDEX.md`. Read `style.md` for design guidance and `build.sh` only when present. A style without a build script is valid; adapt the approach without copying coordinates verbatim.

### Font Pairings (pick one per deck)

| Header Font  | Body Font     | Best For                         |
| ------------ | ------------- | -------------------------------- |
| Georgia      | Calibri       | Formal business, finance         |
| Arial Black  | Arial         | Bold marketing, product launches |
| Calibri      | Calibri Light | Clean corporate, minimal         |
| Cambria      | Calibri       | Traditional professional         |
| Trebuchet MS | Calibri       | Friendly tech, startups          |
| Impact       | Arial         | Bold headlines, keynotes         |
| Palatino     | Garamond      | Elegant editorial, luxury        |
| Consolas     | Calibri       | Developer tools, technical       |

### Hard Rules (mandatory, no exceptions)

**H4 — Body text minimum 16pt:**
All body text, card content, and bullet points must be >= 16pt. "Content doesn't fit" is not an excuse — reduce text, split slides, or reduce card count instead. Exceptions: chart axis labels (<=12pt), short sublabels (<=14pt, max 5 words), footnotes.

**H6 — Dark background contrast:**
When slide background brightness < 30% (e.g. `1E2761`, `36454F`, `000000`), ALL body text, card content, chart labels, and icon fills MUST use white (`FFFFFF`) or near-white (brightness > 80%). Never use mid-gray or muted colors as body text on dark backgrounds.

**H7 — Speaker notes required:**
Every content slide (not title/closing) MUST have speaker notes. Use:

```bash
officecli add deck.pptx '/slide[N]' --type notes --prop text="..."
```

### Visual Element Checkpoint

**Every 3 content slides, at least 1 must contain a non-text visual element:**

| Visual type            | Implementation                               |
| ---------------------- | -------------------------------------------- |
| Icon in colored circle | ellipse shape + centered text/number overlay |
| Colored block          | `preset=roundRect` with fill                 |
| Large stat number      | `size=64, bold=true` with small label below  |
| Chart                  | `--type chart` (column/pie/line)             |
| Gradient background    | `background=COLOR1-COLOR2-180`               |
| Shape composition      | circles + connectors for diagrams            |

Text-only slides are only allowed for: quotes, code examples, pure tables.

---

## 3D Model Insertion Rules

### Fresh-model recipe — avoid unintended duplicate instances

This recipe adds the model independently to each planned slide with the same intended pair name. Do not assume cloning support or playback behavior from the helper's name; verify the installed tool and target viewer if choosing a clone-based workflow.

**Check model inventory after cloning.** A clone can already contain the source model. Adding another with the same name would create unintended duplicates. Inspect the new slide before deciding whether an add or removal is needed; duplicate names also make the planned pair ambiguous.

If you clone a slide for scene actors and the plan requires replacing its copied model, first confirm which element is the copied model. This example assumes that confirmed element is `/model3d[1]`:

```bash
# After cloning slide 1 to slide 2:
officecli remove deck.pptx '/slide[2]/model3d[1]'  # only after identifying this copied model
officecli add deck.pptx '/slide[2]' --type 3dmodel ...  # add fresh model
```

**Recommended approach: Do NOT clone slides with 3D models at all.** Create all slides empty first, then add models fresh on each.

```bash
# Slide 1
officecli add deck.pptx '/slide[1]' --type 3dmodel \
  --prop path=model.glb --prop 'name=!!model-hero' \
  --prop x=16cm --prop y=1cm --prop width=16cm --prop height=16cm \
  --prop roty=0

# Slide 2
officecli add deck.pptx '/slide[2]' --type 3dmodel \
  --prop path=model.glb --prop 'name=!!model-hero' \
  --prop x=0.5cm --prop y=1cm --prop width=18cm --prop height=17cm \
  --prop roty=50
```

### Controllable properties

| Property          | What it does              | Notes                                         |
| ----------------- | ------------------------- | --------------------------------------------- |
| `x`, `y`          | Position on slide         | Standard slide coordinates                    |
| `width`, `height` | Frame size                | Model renders inside this frame               |
| `name`            | Shape name                | Must be identical across slides for Morph     |
| `roty`            | Y-axis rotation (degrees) | Primary storytelling axis                     |
| `rotx`            | X-axis tilt (degrees)     | Range -25 to +40. See Camera Language section |
| `rotz`            | Z-axis roll (degrees)     | Rarely needed                                 |

### Do NOT manually set

- `meterPerModelUnit` — auto-computed from GLB bounding box
- `preTrans` — auto-computed for model centering
- `camera` depth/position — auto-computed to fit the model
- Never use `raw-set` on any 3D transform parameter

---

## Model-Content Layout

### Core Principle: Model IS the Subject

The model must feel like the **protagonist** of the presentation, not a sidebar decoration.
Text supports the model; the model does not decorate the text.

### Size contrast options

A model area ratio near 1.5x or 0.67x can create a clear push-in or pull-back. It is a design option, not a required change on every adjacent pair.
Compute area as `width × height` when planning scale changes. For a 16×15=240 cm² frame, 360 or 160 cm² are example endpoints; rotation, translation, or a hold may serve the content better.

**Keep framing purposeful.** Similar sizes and repeated layouts can preserve continuity. Change scale when it supports the narrative; do not force visual churn to pass a threshold.

| Size tier      | Width   | Height  | Area (approx) | When to use                                |
| -------------- | ------- | ------- | ------------- | ------------------------------------------ |
| **XL (bleed)** | 28-36cm | 22-28cm | 600-1000      | Close-up, model extends beyond slide edges |
| **L (hero)**   | 18-24cm | 15-19cm | 270-456       | Title, closing, dramatic moments           |
| **M (split)**  | 13-17cm | 12-16cm | 156-272       | Standard content pages with text           |
| **S (accent)** | 5-10cm  | 5-10cm  | 25-100        | Data-heavy pages, model as icon            |

### Layout Patterns (6 types)

**A — Model right, content left** (content pages)
Content at x=1-14cm. Model at x=15-20cm, width 14-18cm.

**B — Model left, content right** (alternate with A)
Model at x=0-2cm, width 14-18cm. Content at x=18-32cm.

**C — Model centered, text overlay** (title/closing)
Model centered large (18-24cm). Text at slide top or bottom.

**D — Model small corner, content dominant** (data pages)
Model 5-10cm in any corner. Content fills the rest.

**E — Model as backdrop** (impact/quote pages)
Model XL (28-36cm), centered, partially cropped by slide edges.
Text overlaid directly on top of model area with high-contrast color.
The model becomes the "canvas" — text lives inside the model's space.

```bash
# Pattern E: model fills slide as backdrop
officecli add deck.pptx '/slide[N]' --type 3dmodel \
  --prop path=model.glb --prop 'name=!!model-hero' \
  --prop x=-2cm --prop y=-2cm --prop width=38cm --prop height=24cm \
  --prop roty=45 --prop rotx=10

# Text overlaid on model
officecli add deck.pptx '/slide[N]' --type shape \
  --prop 'name=#sN-quote' --prop text="Key insight here" \
  --prop x=3cm --prop y=7cm --prop width=28cm --prop height=5cm \
  --prop size=44 --prop bold=true --prop color=FFFFFF --prop fill=none
```

**F — Model bleed edge** (transition/teaser pages)
Model partially off-screen (negative x or y, or x+width > 33.87cm).
Only part of the model visible — implies more beyond the frame.

```bash
# Pattern F: model bleeds off right edge
officecli add deck.pptx '/slide[N]' --type 3dmodel \
  --prop path=model.glb --prop 'name=!!model-hero' \
  --prop x=20cm --prop y=-1cm --prop width=24cm --prop height=22cm \
  --prop roty=70
```

### Layout Progression

Vary patterns where it helps the story; consecutive repetitions are valid when intentional. One possible progression:

```
Slide 1: C (centered hero, L)
Slide 2: E (backdrop close-up, XL)   ← 1.5x+ area jump
Slide 3: A (model right, M)          ← pull back
Slide 4: F (bleed edge, L)           ← push in
Slide 5: D (small corner, S)         ← dramatic pull back
Slide 6: B (model left, M)           ← grow
Slide 7: C (centered closing, L)     ← push in
```

### Text Layout Safety (MANDATORY)

**Prevent unintended text collisions.** Separate content and model frames in side-by-side layouts. **Pattern E exception:** intentional text over a model backdrop is valid when the text remains readable, avoids important model details, and has suitable contrast or a scrim/card as needed. A model bounding-box intersection alone is not an error for this pattern.

Rules:

1. **Title and body must not collide.** If a title wraps to 2 lines, the body `y` must account for the title's actual height, not the planned height. Safe formula: `body_y = title_y + title_height + 0.5cm`
2. **Fixed-height text boxes are dangerous.** If text content is longer than expected, it will overflow invisibly. Use generous heights: title `3-4cm`, body `6-8cm`, bullets `8-10cm`.
3. **Side-by-side model and text:** aim for a gap of at least 1cm, adjusted to the actual layout and brief. For Pattern E, assess readability and obscured model details in the rendered result instead of enforcing a frame gap.
4. **On Pattern C (centered model + text overlay):** text goes at slide top (`y=0.5-2cm`) or bottom (`y=14-17cm`), NOT in the vertical middle where the model lives (`y=3-13cm`).
5. **After building each slide, verify coordinates:**
   ```bash
   officecli get deck.pptx '/slide[N]' --depth 1
   # Compare geometry with the planned layout; review intentional Pattern E overlap visually.
   ```

### Model Bleed Guidelines

**Not every model looks good when cropped.** Bleed (Pattern E/F) works best for:

- ✅ Symmetric objects (spheres, helmets, bottles) — any crop looks intentional
- ✅ Large flat surfaces (cars, buildings) — partial view implies scale
- ✅ When cropping non-critical parts (background, base, stand)

Bleed does NOT work for:

- ❌ Character/animal models — cropping ears, tails, or limbs looks broken
- ❌ Small detailed models — cropping loses the detail you want to show
- ❌ When the cropped part is the most recognizable feature

**For character/animal models (like fox, duck, avocado):** keep the full model visible on all slides. Use size changes (L→M→S) for rhythm instead of bleed cropping. Use `rotx` for angle variety instead.

---

## Camera Language

Three tools work together: **roty** (orbit), **rotx** (tilt), **width/height** (zoom).

### Shot Types (use >= 3 different per deck)

| Shot                     | Size                  | rotx       | When                        |
| ------------------------ | --------------------- | ---------- | --------------------------- |
| **Establishing**         | L (18-24cm)           | 0-5        | Title, intro, closing       |
| **Three-quarter beauty** | L (16-20cm)           | 5-10       | Hero, first impression      |
| **Close-up**             | XL (28-36cm), cropped | 0-10       | Feature highlight, detail   |
| **Bird's eye**           | M (13-17cm)           | 25-40      | Structure, overview         |
| **Low angle**            | L (16-20cm)           | -15 to -25 | Power, drama                |
| **Side profile**         | M (13-16cm)           | 0          | Form factor, silhouette     |
| **Over-the-shoulder**    | S (5-10cm)            | 10-15      | Data-heavy, model as accent |

### Content-Driven Camera

Match the shot to what the slide talks about:

- "Front design" → Close-up, `roty=0`, XL cropped
- "Side profile" → Side, `roty=90`, M
- "Internal structure" → Bird's eye, `roty=30, rotx=35`, M
- "Power/authority" → Low angle, `roty=20, rotx=-20`, L
- "Data & specs" → Over-the-shoulder, `roty=60`, S in corner

### Rotation guidance

Use a coherent camera arc that explains the content. Gentle adjacent rotations are a useful default, not a universal hard limit: deliberate reversals, close-ups, holds, or larger angle changes can serve a planned reveal. For an ordinary continuous sweep, prefer one direction and modest tilt changes; inspect target-viewer playback for disorientation. A short deck does not need a forced 180–360° rotation.

The example below uses a consistent positive roty sweep and adjacent rotx changes no larger than 20°. This is one possible plan, not an acceptance threshold.

### Example Shot Plan

| Slide | Shot                 | roty | rotx | Size     | Pattern |
| ----- | -------------------- | ---- | ---- | -------- | ------- |
| 1     | Three-quarter beauty | 30   | 8    | L 20×17  | C       |
| 2     | Close-up             | 60   | 5    | XL 30×24 | E       |
| 3     | Side profile         | 90   | 0    | M 15×14  | A       |
| 4     | Elevated angle       | 120  | 15   | M 14×13  | B       |
| 5     | Low angle            | 170  | -5  | L 20×18  | F       |
| 6     | Over-the-shoulder    | 220  | 10   | S 8×7    | D       |
| 7     | Establishing         | 300  | 5    | L 20×17  | C       |

---

## Workflow Integration with morph-ppt

### Phase 2 additions (Planning)

In `brief.md`, add a **Model Choreography Table**:

| Slide | Pattern | Size Tier | Model x,y,w,h | roty | rotx |
| ----- | ------- | --------- | ------------- | ---- | ---- |
| 1     | C       | L         | 7,0.5,20,17   | 30   | 8    |
| 2     | E       | XL        | -2,-2,38,24   | 60    | 5    |
| ...   | ...     | ...       | ...           | ...  | ...  |

Review planned framing and motion between adjacent rows. A large area change is one way to create a reveal; rotation, translation, and intentional holds can also be appropriate. Validate the intended sequence rather than forcing an area ratio on every pair.

### Phase 3 additions (Build)

For the fresh-model recipe, build from model-free slide scaffolding so a clone does not accidentally introduce a second model. Confirm behavior in the installed tool and target viewer:

1. Plan the actual slide count and create model-free slides, adding Morph only on planned destination slides.
2. Add or copy the needed scene actors between the planned slides; avoid creating a second set of slides after the target pages already exist.
3. Add the intended model instances to each applicable slide, reusing exact names only for planned pairs; inspect the inventory to avoid accidental duplicates.
4. Add content per slide and manage retained outgoing shapes according to their lifecycle.

```python
model_positions = [
    {"slide": 1, "x": "7cm",  "y": "0.5cm", "w": "20cm", "h": "17cm", "roty": 30},
    {"slide": 2, "x": "-2cm", "y": "-2cm",  "w": "38cm", "h": "24cm", "roty": 60},
    {"slide": 3, "x": "16cm", "y": "1cm",   "w": "15cm", "h": "14cm", "roty": 90},
    # ...
]
for pos in model_positions:
    run("officecli", "add", OUTPUT, f"/slide[{pos['slide']}]", "--type", "3dmodel",
        "--prop", f"path={MODEL}", "--prop", "name=!!model-hero",
        "--prop", f"x={pos['x']}", "--prop", f"y={pos['y']}",
        "--prop", f"width={pos['w']}", "--prop", f"height={pos['h']}",
        "--prop", f"roty={pos['roty']}")
```

### Phase 4 additions (Verification)

After standard morph verification, additionally check:

- Each slide contains the planned model instances; the single-hero recipe uses one model, but follow the actual brief.
- Each intended cross-slide model pair has the exact same readback name and the intended model asset.
- Adjacent framing, position, rotation, and scale match the choreography. Check actual target-viewer playback; structural metadata cannot prove 3D Morph animation.
- Repeated layout or framing is acceptable when it serves continuity; check readability, intentional overlays, and camera motion against the brief.

---

## File Placement Rule

Keep the deck, model assets, build script, and planning in one task output directory or a clear relative subdirectory structure.

**Default delivery set (adapt to the user's requested outputs):**

- `.glb` model file (the 3D model used in the deck)
- Output `.pptx`
- Build script (re-runnable)
- `brief.md`

Keep planning concise in `brief.md` by default. QA screenshots, temporary render files, reports, and additional user-requested artifacts are allowed; distinguish review artifacts from the final delivery set and keep paths organized.

Do not scatter model files across unrelated paths.

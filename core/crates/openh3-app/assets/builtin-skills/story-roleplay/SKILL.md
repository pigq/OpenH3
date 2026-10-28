---
name: story-roleplay
description: Parse and apply character cards and world info files in multiple formats (PNG, WebP, JSON), fully compatible with SillyTavern format. Supports automatic parsing, keyword triggering, and dynamic updates.
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

# Story Roleplay Skills

Parse and apply character cards and world info files for immersive story roleplay experiences. Fully compatible with SillyTavern formats.

## ⚠️ Core Constraints (Must Follow)

1. Extract and validate actual embedded JSON from PNG/WebP metadata; never invent character data from visible artwork.
2. Prefer the parser in the currently loaded Skill directory. If it or its dependencies cannot handle the input, use an available metadata parser or a small scoped helper. Do not require exhaustive filesystem searches before trying an equivalent tool.
3. Keep helpers and any pinned dependencies in a separate working subdirectory; preserve the user's original image, existing `package.json`, and other project files. Use actual runtime permissions and existing grants without a separate confirmation for the same authorized parse.

---

## Common: Parser Tool Usage Workflow

### Preferred parser and equivalent tools

Locate `scripts/parse-character-card.js` relative to this loaded SKILL.md, not a guessed project root. The bundled parser supports PNG metadata; it explicitly rejects WebP. Check the input format before selecting it. JSON inputs can be read and validated directly without Node/npm.

For PNG, invoke the available bundled parser using its absolute path and a new output path:

```bash
# Character card
node "<skill-dir>/scripts/parse-character-card.js" "<image-path>" "<output-json-path>"

# World info
node "<skill-dir>/scripts/parse-character-card.js" "<image-path>" "<output-json-path>" --world-info
```

**Important**:

- ✅ Must provide output path as second argument
- ❌ Do not use stdout redirection (`>`)
- Use quotes if filename contains Chinese characters or spaces

**Examples**:

```bash
node "<skill-dir>/scripts/parse-character-card.js" character.png character.json
node "<skill-dir>/scripts/parse-character-card.js" "薇娜丽丝.png" character.json
node "<skill-dir>/scripts/parse-character-card.js" world-info.png world-info.json --world-info
```

If the script, Node, or a dependency is unavailable, first check existing metadata libraries/tools rather than installing the whole preset environment. A permitted small helper may read PNG text chunks or WebP metadata and decode the embedded JSON. Install only a necessary pinned dependency into a dedicated helper directory if no existing tool can do the job. Do not search the entire user directory or copy a preset `package.json` over the user's project.

**Verify Results**

- Check output: Should see "Successfully extracted data to: <path>"
- Verify JSON file exists and format is correct
- **If fails**:
  - Check error message (script will output specific error)
  - Common errors:
    - "PNG metadata does not contain any text chunks" → Image may not be a valid SillyTavern character card
    - "Required dependencies not found" → Use an available equivalent parser or isolate the necessary pinned dependencies
    - "Image file not found" → Check if image path is correct
  - **ABSOLUTELY CANNOT guess or fabricate information**, must report error clearly

### Fallback helper

When the preferred parser is unavailable, an equivalent metadata tool or helper is allowed immediately after the targeted capability check. The example below supports PNG only; do not use it to claim WebP support:

1. **Create `package.json`** (see "Example PNG helper" below)
2. **Create `parse-character-card.js`** (see "Example PNG helper" below)

Use the example files only in a dedicated helper directory. A rejected permission still applies to every route; an unavailable parser is not a rejected permission.

---

## Character Card Parser

**Triggers**: character card, 角色卡, load character, 加载角色, parse character, 解析角色卡

**Description**: Parse character card files in multiple formats, including PNG, WebP image formats and JSON file format.

### Supported Formats

#### 1. PNG Image Format (SillyTavern Standard)

- Data location: In PNG tEXt chunks
- Keywords: `chara` (v2) or `ccv3` (v3)
- Encoding: Base64-encoded JSON string

**Processing**: Use common parser tool workflow (see above), use character card command format when executing.

#### 2. WebP Image Format (SillyTavern Compatible)

- Data location: In WebP EXIF/XMP metadata or text chunks
- Keywords: `chara` (v2) or `ccv3` (v3)

**Processing**:

- Use an available parser that actually reads WebP EXIF/XMP metadata and extracts the embedded card JSON. The bundled PNG parser cannot do this.
- Ordinary image conversion may discard card metadata; do not treat a PNG rendering of the artwork as a recovered card. A conversion route is usable only when embedded data preservation is verified.
- Try equivalent permitted metadata tools or a scoped helper before asking for a JSON export. If none can extract the data, report the exact unsupported metadata/capability and request a compatible export; do not claim the original file has no card merely because one parser rejects WebP.

#### 3. JSON File Format

**Standard Format** (Tavern Card V2/V3):

- Includes: `name`, `description`, `personality`, `scenario`, `first_mes`, `system_prompt`
- Optional: `character_book` (character knowledge base)
- Supports simplified format (direct fields, no nested structure)

**Processing**: Read and parse directly (simplest, preferred)

### Parsing Steps

**Important: PNG/WebP images must use parser tool, guessing content is forbidden**

1. **Detect file format**:
   - **JSON files**: Read and parse directly (simplest, preferred)
   - **PNG/WebP files**: Use common parser tool workflow (see above)

2. **Extract character information**:
   - `name`: Character name
   - `description`: Character description
   - `personality`: Personality traits
   - `scenario`: Scenario setting
   - `first_mes`: First message (used as opening)
   - `system_prompt`: System prompt (character behavior rules)
   - `character_book`: Character knowledge base (similar to world info)

3. **Apply character information**:
   - Use character's system_prompt as behavior rules
   - Use first_mes as conversation opening
   - Apply character_book entries to conversation

4. **Save as JSON format (after parsing images)**:
   - After successfully parsing PNG/WebP images, **automatically convert to JSON format**
   - Save as `character.json` in workspace
   - Preserve all original data from image

### Best Practices

- **Prefer JSON format** (easiest to parse, no additional tools needed)
- **PNG format**: Must use parser tool, guessing content is forbidden
- **WebP format**: Extract actual embedded metadata with a compatible tool; preserve and validate it if any conversion is used
- **Error handling**: When parsing fails, must provide clear error message, absolutely cannot guess or fabricate character information
- **Always save parsed images as JSON format** for easier viewing and editing

---

## World Info Parser

**Triggers**: world info, 世界信息, world tree, 世界树, load world info, 加载世界信息

**Description**: Parse and apply world info files, implementing keyword trigger mechanism. Supports JSON files and PNG/WebP image formats (with embedded world info data).

### Supported Formats

#### 1. JSON File Format

```json
{
  "name": "World Name",
  "entries": [
    {
      "keys": ["keyword1", "keyword2"],
      "content": "Content to inject when triggered",
      "priority": 100,
      "enabled": true
    }
  ]
}
```

#### 2. PNG Image Format (SillyTavern Compatible)

- Data location: In PNG tEXt chunks
- Keyword: `naidata` (SillyTavern standard)
- Encoding: Base64-encoded JSON string

**Processing**: Use common parser tool workflow (see above), use `--world-info` flag when executing.

#### 3. WebP Image Format (SillyTavern Compatible)

**Processing**:

- Use an available compatible metadata parser or scoped helper to extract the actual embedded world-info JSON. The bundled parser supports PNG only; its WebP rejection is a tool limitation, not evidence that the file lacks world info.
- Do not convert the artwork to PNG unless preservation of the embedded metadata is verified. Request a JSON export only when no permitted extraction route succeeds.

### Field Descriptions

- `keys`: Keyword array, triggers when these words appear in conversation
- `content`: Content to inject when triggered
- `priority`: Priority (higher number = higher priority)
- `enabled`: Whether enabled (true/false)

### Trigger Mechanism

1. **Keyword detection**: Monitor conversation content, detect if it contains world info keywords
2. **Content injection**: When keywords appear, integrate corresponding content into response, sorted by priority
3. **Natural integration**: Do not insert world info content awkwardly, naturally integrate into conversation and narrative

### Parsing Steps

1. **Detect file format**:
   - **JSON files**: Read and parse directly (simplest, preferred)
   - **PNG/WebP files**: Use common parser tool workflow (see above), use `--world-info` flag

2. **Extract world info**:
   - Read output JSON file
   - Parse JSON, extract `entries` array
   - Verify JSON structure is correct (must contain `entries` field)

3. **Save as JSON format (after parsing images)**:
   - After successfully parsing PNG/WebP images, automatically convert to JSON format
   - Save as `world-info.json` in workspace

### Best Practices

- **Prefer JSON format** (easiest to parse, no additional tools needed)
- **PNG format**: Use same parser tool as character cards (with `--world-info` flag)
- **WebP format**: Use compatible metadata extraction; request JSON only when available permitted tools cannot recover the embedded data
- Keywords should be specific and meaningful, avoid overly broad keywords
- **Always save parsed images as JSON format** for easier viewing and editing

---

## Character Book Handler

**Triggers**: character book, 角色知识库, character entry, 角色条目

**Description**: Handle character_book (character knowledge base) in character cards, similar to world info but bound to specific character.

### Character Book Format

character_book field in character card:

- `name`: Character knowledge base name
- `entries`: Entry array, each entry contains `keys`, `content`, `priority`, `enabled`

### Processing

1. **When loading character card**: Extract character_book field, parse entries array, apply together with character information
2. **During conversation**: Detect keywords in character_book, inject relevant content when keywords appear
3. **Priority**: character_book entries usually have higher priority than world info

### Best Practices

- character_book is for character-specific knowledge
- World info is for general world settings
- Both can be used together, but pay attention to priority

---

## File Detection and Loading Workflow

### Automatic Detection

1. **Scan workspace**:
   - Find character card files: `character.png`, `character.webp`, `character.json`, `*.character.json`
   - Find world info files: `world-info.png`, `world-info.webp`, `world-info.json`, `world.json`

2. **Format recognition and parsing**:
   - **JSON files**: Read directly
   - **PNG/WebP images**: Use common parser tool workflow (see above)

3. **Apply parsed results**:
   - Apply parsed results to conversation context
   - After successfully parsing images, automatically save as JSON format

### Character Card and World Info Creation

**When the user requests a new character card or world info file**:

1. Use the story type, character details, and world setting already provided. Ask only for missing details that materially affect the result; if the user delegates creative choices, choose suitable details and proceed.

2. Create `character.json` with the supplied character information. If the requested scope includes world-building, create `world-info.json` with relevant entries. An explicit creation request is sufficient authorization for these new local files; do not require a separate summary-confirmation turn. Preserve existing user files unless the user requested their replacement.

3. Report the created files and any creative assumptions. If no files exist but the user only requested roleplay, continue from the supplied context rather than requiring a file-creation interview.

**Creation format**:

- Character card: Use Tavern Card V2/V3 standard format, include all essential fields
- World info: Create entries for key concepts, locations, rules, use meaningful keywords

### Manual Loading

Users can manually load via:

- "Load character card: character.png"
- "Read world info: world-info.json"
- "Use this character: [upload file]"

## Compatibility

This skill is fully compatible with SillyTavern formats:

- ✅ PNG image format (embedded JSON, SillyTavern standard) - for character cards and world info
- ✅ WebP image format (embedded JSON, SillyTavern compatible) - for character cards and world info
- ✅ JSON file format (Tavern Card V2/V3) - for character cards and world info
- ✅ World info format (PNG/WebP images use keyword `naidata`)
- ✅ Character Book (character knowledge base)

---

## Example PNG helper

Prefer an existing compatible parser. This example is available when a scoped PNG helper is needed; no exhaustive path search is required. It does not implement WebP parsing. Keep its files and pinned dependencies in a separate working directory.

### package.json

```json
{
  "name": "story-roleplay-parser",
  "version": "1.0.0",
  "description": "Parser tools for character cards and world info",
  "main": "parse-character-card.js",
  "scripts": {
    "parse": "node parse-character-card.js"
  },
  "dependencies": {
    "png-chunks-extract": "1.0.0",
    "png-chunk-text": "1.0.0"
  }
}
```

### parse-character-card.js

Complete code reference: `<skill-dir>/scripts/parse-character-card.js`, relative to the currently loaded Skill directory. Inspect that file before copying it into a dedicated helper directory; do not guess a project-root path.

**Key features**:

- Extract character card data from PNG images (keywords: `chara` or `ccv3`)
- Extract world info data from PNG images (keyword: `naidata`)
- Support Base64 decoding and JSON validation
- Complete error handling and user-friendly error messages

**If file is not accessible**, can create based on following logic:

- Use `png-chunks-extract` to extract PNG chunks
- Use `png-chunk-text` to decode tEXt chunks
- Find keywords (`chara`/`ccv3` for character cards, `naidata` for world info)
- Base64 decode and validate JSON format

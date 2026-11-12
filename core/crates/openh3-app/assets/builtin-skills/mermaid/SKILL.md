---
name: mermaid
description: Render Mermaid diagrams as SVG or ASCII art using beautiful-mermaid. Use when users need to create flowcharts, sequence diagrams, state diagrams, class diagrams, or ER diagrams. Supports both graphical SVG output and terminal-friendly ASCII/Unicode output.
---

# Mermaid Diagram Renderer

Render Mermaid diagrams using `beautiful-mermaid` library. Supports 5 diagram types with dual output modes.

## Quick Start

Resolve this skill's installed directory and invoke its `scripts/render.mjs` by absolute path. Use an available Node.js interpreter and npm. No `npx` or TypeScript runner is required. Input/output paths are resolved from your task's working directory.

On the first render, the script installs exact versions `beautiful-mermaid@1.1.3`, `elkjs@0.11.0`, and `entities@7.0.1` into a private versioned runtime under `%LOCALAPPDATA%/OpenH3/mermaid` on Windows or `${XDG_CACHE_HOME:-~/.cache}/OpenH3/mermaid` on macOS/Linux. It loads the module from that same runtime and reuses it on later runs. Installation uses npm with lifecycle scripts disabled. Do not run `npm install` in the user's project or in the installed skill directory.

The first render requires access to the npm registry; `--help` does not install anything. If installation or rendering fails, report the actual error and do not claim an output was created. Existing output is only replaced after rendering succeeds.

### SVG Output (Default)

```bash
# From file
node "/absolute/path/to/mermaid/scripts/render.mjs" diagram.mmd --output diagram.svg

# From stdin
printf '%s\n' 'graph LR' 'A-->B-->C' | node "/absolute/path/to/mermaid/scripts/render.mjs" --stdin --output flow.svg
```

### ASCII Output (Terminal)

```bash
# ASCII art for terminal display
node "/absolute/path/to/mermaid/scripts/render.mjs" diagram.mmd --ascii

# Pipe directly
printf '%s\n' 'graph TD' 'Start-->End' | node "/absolute/path/to/mermaid/scripts/render.mjs" --stdin --ascii
```

PowerShell, including Chinese text in Windows PowerShell 5.1:

```powershell
$previousOutputEncoding = $OutputEncoding
try {
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    @'
graph LR
A[开始]-->B[完成]
'@ | & node 'C:\absolute path\mermaid\scripts\render.mjs' --stdin --output '流程.svg'
    if ($LASTEXITCODE -ne 0) { throw "Mermaid renderer failed with exit code $LASTEXITCODE" }
} finally { $OutputEncoding = $previousOutputEncoding }
```

Use the resolved interpreter path instead of `node` when it is not on PATH. For file input, run `& node 'C:\absolute path\mermaid\scripts\render.mjs' '流程.mmd' --output '流程.svg'` with a UTF-8 source file.

Put the diagram header on its own line, followed by the edges/statements on later lines.

Output example:

```
┌───────┐     ┌─────┐
│ Start │────▶│ End │
└───────┘     └─────┘
```

## Supported Diagrams

| Type      | Syntax            | Best For                |
| --------- | ----------------- | ----------------------- |
| Flowchart | `graph TD/LR`     | Processes, decisions    |
| Sequence  | `sequenceDiagram` | API calls, interactions |
| State     | `stateDiagram-v2` | State machines          |
| Class     | `classDiagram`    | OOP design              |
| ER        | `erDiagram`       | Database schemas        |

## Theming (SVG only)

```bash
node "/absolute/path/to/mermaid/scripts/render.mjs" diagram.mmd --theme github-dark --output out.svg
```

An invalid theme produces an error listing the available themes; choose one and rerun.

## Resources

- `scripts/render.mjs` - Node.js rendering entry
- `scripts/runtime.mjs` - Isolated dependency installer and loader
- `scripts/render.ts` - Compatibility entry for existing TypeScript-runner callers
- `references/syntax.md` - Mermaid syntax quick reference

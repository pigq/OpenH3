#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadMermaid } from './runtime.mjs';

function parseArgs(args) {
  const options = { stdin: false, ascii: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--stdin') options.stdin = true;
    else if (arg === '--ascii') options.ascii = true;
    else if (arg === '--theme' || arg === '--output') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options[arg.slice(2)] = args[++i];
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (options.input) throw new Error('Provide exactly one input file.');
    else options.input = arg;
  }
  if (options.stdin && options.input) throw new Error('Use --stdin or an input file, not both.');
  return options;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Mermaid Diagram Renderer (beautiful-mermaid 1.1.3)

Usage:
  node /absolute/path/to/mermaid/scripts/render.mjs <file.mmd> [options]
  node /absolute/path/to/mermaid/scripts/render.mjs --stdin [options]

Options:
  --ascii          Output ASCII/Unicode art instead of SVG
  --theme <name>   SVG theme (e.g., github-dark, dracula, nord)
  --output <file>  Write to a file instead of stdout
  --stdin          Read UTF-8 Mermaid code from stdin
  -h, --help       Show this help without installing dependencies

Requires Node.js 18+ and npm for the first render. Installs pinned packages in
LOCALAPPDATA/OpenH3/mermaid on Windows, XDG_CACHE_HOME/OpenH3/mermaid (or
~/.cache/OpenH3/mermaid) elsewhere. Input/output paths resolve from your current
directory. No dependency is installed in that directory or the skill directory.`);
    return;
  }
  const options = parseArgs(args);
  let code;
  if (options.stdin) {
    process.stdin.setEncoding('utf8');
    code = '';
    for await (const chunk of process.stdin) code += chunk;
  } else if (options.input) code = readFileSync(resolve(options.input), 'utf8');
  else throw new Error('No input provided. Use --stdin or provide a file path.');
  if (!code.trim()) throw new Error('Empty Mermaid code.');

  const mermaid = await loadMermaid();
  let result;
  if (options.ascii) result = mermaid.renderMermaidAscii(code);
  else {
    const colors = options.theme ? mermaid.THEMES[options.theme] : undefined;
    if (options.theme && !colors) {
      throw new Error(`Unknown theme "${options.theme}". Available: ${Object.keys(mermaid.THEMES).join(', ')}`);
    }
    result = await mermaid.renderMermaid(code, colors);
  }
  if (typeof result !== 'string' || !result.trim()) throw new Error('Renderer returned empty output.');
  if (options.output) {
    writeFileSync(resolve(options.output), result, 'utf8');
    console.error(`Written to: ${resolve(options.output)}`);
  } else console.log(result);
}

main().catch(error => {
  console.error('Error rendering diagram:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

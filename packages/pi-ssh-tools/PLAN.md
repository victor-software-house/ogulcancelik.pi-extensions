# Plan: pi-render-core extraction + pi-ssh-tools pretty rendering

## Goal

Extract duplicated rendering primitives from `pi-diff` and `pi-pretty` into a
shared `pi-render-core` package, then use it to give all `ssh_*` tools
(including three new ones) the same rendering quality as their local
counterparts.

---

## Current state

### Duplication between pi-diff and pi-pretty

Both packages independently implement the same rendering foundation. The
overlap was copy-pasted — pi-pretty even comments `// Low-contrast fix (same as
pi-diff)`.

**Identical implementations:**

| Symbol | pi-diff | pi-pretty | Notes |
|:--|:--|:--|:--|
| `PrettifyConfig` | `render.ts` | `index.ts` | pi-diff is superset (has diff-specific fields) |
| `loadPrettifyConfig()` | `render.ts` | `index.ts` | Same structure, diff has more fields |
| `cfg` singleton | `render.ts` | `index.ts` | Same |
| `hlBlock()` | `render.ts` | `index.ts` | **Byte-identical** |
| `_touch()` LRU | `render.ts` | `index.ts` | **Byte-identical** |
| `_cache` Map | `render.ts` | `index.ts` | **Byte-identical** |
| `isLowContrastShikiFg()` | `render.ts` | `index.ts` | **Byte-identical** |
| `normalizeShikiContrast()` | `render.ts` | `index.ts` | Trivial variance (regex var name, color const name) |
| `shortPath()` | `render.ts` | `index.ts` | **Byte-identical** |
| `strip()` | `render.ts` | `index.ts` | **Byte-identical** |
| `parseAnsiRgb()` | `render.ts` | `index.ts` | **Byte-identical** |
| `termW()` | `render.ts` | `index.ts` | Trivial fallback variance |
| `lnum()` | `render.ts` | `index.ts` | pi-diff has nullable + fg param (superset) |
| `rule()` | `render.ts` | `index.ts` | pi-diff includes `BG_BASE` prefix |
| `lang()` + `EXT_LANG` | `render.ts` | `index.ts` | pi-pretty is superset (more languages, filename checks) |
| `RST`, `BOLD`, `DIM` | `render.ts` | `index.ts` | **Identical** |
| `BG_BASE`, `BG_DEFAULT` | `render.ts` | `index.ts` | **Identical** |
| `ESC_RE`, `ANSI_RE` | `render.ts` | `index.ts` | **Identical** |
| `resolveBaseBackground()` | inline in `resolveDiffColors()` | standalone function | Same logic |
| `@shikijs/cli` dep | `package.json` | `package.json` | Same version `^4.0.2` |

**Only in pi-pretty (not in pi-diff):**

| Symbol | Purpose |
|:--|:--|
| `FG_GREEN`, `FG_RED`, `FG_YELLOW`, `FG_BLUE`, `FG_CYAN`, `FG_MUTED`, `FG_ORANGE`, `FG_PURPLE` | Color palette for tool output |
| `ITALIC` | ANSI italic |
| `BG_STDERR` | Stderr tinting |
| `fileIcon()`, `dirIcon()`, `EXT_ICON`, `NAME_ICON` | Nerd Font file-type icons |
| `humanSize()` | Human-readable byte sizes |
| `detectImageProtocol()`, `renderIterm2Image()`, `renderKittyImage()`, `tmuxWrap()`, `getOuterTerminal()` | Terminal inline image rendering |
| `renderFileContent()` | Syntax-highlighted file with line numbers |
| `renderBashSummary()` | Colored exit status |
| `renderTree()` | Tree-view directory listing |
| `renderFindResults()` | Grouped file list with icons |
| `renderGrepResults()` | Highlighted grep matches |

**Only in pi-diff (not in pi-pretty):**

| Symbol | Purpose |
|:--|:--|
| Diff color palette (`FG_ADD`, `FG_DEL`, `BG_ADD`, `BG_DEL`, etc.) | Diff-specific colors |
| `DiffColors`, `DiffLine`, `ParsedDiff` types | Diff data structures |
| `parseDiff()`, `wordDiffAnalysis()` | Diff computation (uses `diff` npm package) |
| `renderSplit()`, `renderUnified()` | Split/unified diff views |
| `resolveDiffColors()`, `applyDiffPalette()`, `autoDeriveBgFromTheme()` | Theme-aware diff palette |
| `wrapAnsi()`, `fit()`, `ansiState()`, `injectBg()` | ANSI line manipulation for diff rendering |
| `summarize()` | "+N / -M" diff summary |

### Current pi-ssh-tools

4 tools: `ssh_read`, `ssh_write`, `ssh_edit`, `ssh_bash`.

- Simple `renderCall` (tool name + path/command + `[host]` label)
- `renderResult` delegates to SDK defaults (plain text)
- No `ssh_ls`, `ssh_find`, `ssh_grep`

### Downstream consumer: pi-morph

pi-morph imports from `pi-diff/render`:

```ts
import {
  cfg, type DiffColors, lang as diffLang, hlBlock,
  parseDiff, renderSplit, resolveDiffColors, shortPath, termW,
} from 'pi-diff/render';
```

This is the contract that must not break.

---

## Target architecture

### New package: `pi-render-core`

Repo: `victor-software-house/pi-render-core`
Dependency provider: `git+ssh://git@github.com/victor-software-house/pi-render-core.git`

Owns all shared rendering primitives. Single Shiki instance for the process.

### Dependency graph

```
pi-render-core              ← @shikijs/cli (sole owner)
    ↑
    ├── pi-diff              ← diff (keeps diff computation + diff rendering)
    │       ↑
    │       └── pi-morph     ← @morphllm/morphsdk (unchanged import path)
    │
    ├── pi-pretty            ← (keeps tool renderers: read/bash/ls/find/grep)
    │       ↑
    │       └── pi-ssh-tools ← (adds ssh transport + 5 ssh_* tools)
    │
    └── (future consumers)
```

---

## Phase 1 — Create `pi-render-core`

### 1.1 Create repo

Create `victor-software-house/pi-render-core` on GitHub (private or public,
same as pi-diff/pi-pretty).

### 1.2 Package structure

```
pi-render-core/
  src/
    config.ts
    ansi.ts
    highlight.ts
    layout.ts
    icons.ts
    images.ts
    index.ts
  package.json
  tsconfig.json
  biome.json
  LICENSE
  README.md
```

### 1.3 Module contents

**`src/config.ts`** — Configuration loading

```
Exports:
  type PrettifyConfig        — union of all config fields from both packages
  const PRETTIFY_DEFAULTS    — default values
  function loadPrettifyConfig() → PrettifyConfig
  const cfg                  — singleton instance
```

The `PrettifyConfig` type is the superset of both pi-diff's and pi-pretty's
fields:

```ts
interface PrettifyConfig {
  // shared
  theme: BundledTheme;
  maxPreviewLines: number;
  maxHighlightChars: number;
  cacheLimit: number;
  maxTermWidth: number;
  termMargin: number;
  imageMaxCols: number;
  // diff-specific (pi-diff reads these, pi-pretty ignores them)
  maxDiffLines: number;
  splitMinWidth: number;
  splitMinCodeWidth: number;
  wordDiffMinSimilarity: number;
  diffTheme: string | null;
  diffColors: Record<string, string>;
  maxWrapRows: number | null;
  // pretty-specific
  icons: string;
}
```

Source: merge `loadPrettifyConfig()` from pi-diff (superset) with pi-pretty's
`icons` field.

**`src/ansi.ts`** — ANSI constants and low-level utilities

```
Exports:
  // Style
  let RST                    — reset (updated by resolveBaseBackground)
  const BOLD, DIM, ITALIC

  // Foreground colors — superset from pi-pretty
  const FG_LNUM, FG_DIM, FG_RULE
  const FG_GREEN, FG_RED, FG_YELLOW, FG_BLUE, FG_CYAN
  const FG_MUTED, FG_ORANGE, FG_PURPLE

  // Background
  const BG_DEFAULT, BG_STDERR
  let BG_BASE                — updated by resolveBaseBackground

  // Regex
  const ESC_RE, ANSI_RE, ANSI_CAPTURE_RE

  // Functions
  function parseAnsiRgb(ansi) → { r, g, b } | null
  function resolveBaseBackground(theme) → void
  function isLowContrastShikiFg(params) → boolean
  function normalizeShikiContrast(ansi) → string
  function strip(s) → string
```

Use `let` for `FG_LNUM`, `FG_RULE`, `FG_MUTED` so pi-diff can override them
from its diff palette (it already does this via `applyDiffPalette()`). Export
setters or use mutable bindings.

**`src/highlight.ts`** — Shiki highlighting + language detection

```
Exports:
  const EXT_LANG             — extension → BundledLanguage map (pi-pretty superset)
  function lang(fp) → BundledLanguage | undefined   (pi-pretty version with filename checks)
  function hlBlock(code, language) → Promise<string[]>
```

Internal: `_cache` Map, `_touch()` LRU, Shiki pre-warm, `@shikijs/cli` import.

Use pi-pretty's `lang()` (superset — handles Dockerfile, Makefile, .env, etc.)
and pi-pretty's `EXT_LANG` (has `less`, `jsonc`, `mdx`, `dockerfile`, `make`,
`zig`, `nim`, `elixir`, `erb`, `hbs` that pi-diff lacks).

**`src/layout.ts`** — Terminal layout helpers

```
Exports:
  function termW() → number
  function shortPath(cwd, home, p) → string
  function rule(w) → string
  function lnum(n, w, fg?) → string    — pi-diff's superset signature (nullable n, optional fg)
  function humanSize(bytes) → string
```

Use pi-diff's `rule()` (includes `BG_BASE`), pi-diff's `lnum()` (superset
signature), and pi-pretty's `humanSize()`.

**`src/icons.ts`** — Nerd Font file-type icons

```
Exports:
  const EXT_ICON             — extension → ANSI+glyph
  const NAME_ICON            — filename → ANSI+glyph
  const NF_DIR, NF_DIR_OPEN, NF_DEFAULT
  function fileIcon(fp) → string
  function dirIcon() → string
```

Moved from pi-pretty unchanged. Depends on `cfg.icons` from config.ts and `RST`
from ansi.ts.

**`src/images.ts`** — Terminal inline image protocol

```
Exports:
  type ImageProtocol = "iterm2" | "kitty" | "none"
  function detectImageProtocol() → ImageProtocol
  function renderIterm2Image(base64Data, opts?) → string
  function renderKittyImage(base64Data, opts?) → string
  function tmuxWrap(seq) → string
  function getOuterTerminal() → string
```

Moved from pi-pretty unchanged.

**`src/index.ts`** — Re-export barrel

```ts
export * from "./config.js";
export * from "./ansi.js";
export * from "./highlight.js";
export * from "./layout.js";
export * from "./icons.js";
export * from "./images.js";
```

### 1.4 package.json

```json
{
  "name": "pi-render-core",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@shikijs/cli": "^4.0.2"
  },
  "peerDependencies": {
    "shiki": "*"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0",
    "@biomejs/biome": "^2.3.5",
    "shiki": "^4.0.0"
  }
}
```

No `pi` field — this is a library, not an extension.

### 1.5 Verification

```bash
bun install
bun run typecheck   # tsc --noEmit
bun run lint        # biome check src/
```

### 1.6 Mutable ANSI bindings

pi-diff's `applyDiffPalette()` mutates `FG_LNUM`, `FG_RULE`, and `FG_SAFE_MUTED`
at runtime based on user config. pi-render-core must support this.

Options:
- Export `let` bindings (ESM `let` exports are live bindings — mutations are
  visible to importers). This is the simplest approach.
- Or export setter functions: `setFgLnum(v)`, `setFgRule(v)`, etc.

**Decision:** Use `let` exports. ESM live bindings make mutations visible to all
importers. pi-diff's `applyDiffPalette()` would do:

```ts
import { FG_LNUM, FG_RULE, FG_MUTED } from 'pi-render-core';
// pi-diff re-exports a mutating function that writes to its own module-scoped
// vars — but since the source of truth is now in pi-render-core, it needs to
// call pi-render-core's setters instead.
```

**Correction:** ESM `let` exports are live bindings from the *exporting* module,
but importers cannot reassign them. Only the exporting module can mutate them.
So pi-render-core must expose setter functions:

```ts
// src/ansi.ts
export let FG_LNUM = "\x1b[38;2;100;100;100m";
export let FG_RULE = "\x1b[38;2;50;50;50m";
export let FG_MUTED = "\x1b[38;2;139;148;158m";

export function setFgLnum(v: string): void { FG_LNUM = v; }
export function setFgRule(v: string): void { FG_RULE = v; }
export function setFgMuted(v: string): void { FG_MUTED = v; }
```

pi-diff's `applyDiffPalette()` calls the setters. All consumers see the updated
values via live bindings.

Same pattern for `RST`, `BG_BASE`, `DIVIDER` — anything that pi-diff mutates
at runtime.

---

## Phase 2 — Rewire pi-diff

### 2.1 Add dependency

In pi-diff's `package.json`:

```json
{
  "dependencies": {
    "pi-render-core": "git+ssh://git@github.com/victor-software-house/pi-render-core.git",
    "diff": "^7.0.0"
  }
}
```

Remove `"@shikijs/cli": "^4.0.2"` from pi-diff's dependencies (now transitive
via pi-render-core).

### 2.2 Replace duplicated code in `src/render.ts`

Replace all identical/near-identical functions with imports from `pi-render-core`:

```ts
import {
  // config
  cfg, loadPrettifyConfig, type PrettifyConfig,
  // ansi
  RST, BOLD, DIM, BG_BASE, BG_DEFAULT, ANSI_RE, ESC_RE,
  parseAnsiRgb, resolveBaseBackground,
  isLowContrastShikiFg, normalizeShikiContrast, strip,
  FG_LNUM, FG_RULE, FG_MUTED,
  setFgLnum, setFgRule, setFgMuted,
  // highlight
  hlBlock, lang, EXT_LANG,
  // layout
  termW, shortPath, rule, lnum,
} from "pi-render-core";
```

**Delete from render.ts:**
- `PrettifyConfig` type definition
- `PRETTIFY_DEFAULTS`
- `loadPrettifyConfig()` function
- `cfg` singleton
- All ANSI constants that are now imported
- `parseAnsiRgb()`, `resolveBaseBackground()` (inline version)
- `isLowContrastShikiFg()`, `normalizeShikiContrast()`
- `strip()`
- `EXT_LANG` table, `lang()`
- `hlBlock()`, `_touch()`, `_cache`
- `termW()`, `shortPath()`, `rule()`, `lnum()`
- `@shikijs/cli` import and `codeToANSI` import

**Keep in render.ts (diff-specific):**
- Diff color system: `FG_ADD`, `FG_DEL`, `BG_ADD`, `BG_DEL`, etc.
- `DiffColors`, `DiffLine`, `ParsedDiff` types
- `parseDiff()`, `wordDiffAnalysis()`
- `renderSplit()`, `renderUnified()`
- `resolveDiffColors()` — still calls `resolveBaseBackground()` from core, then
  does diff-specific color resolution
- `applyDiffPalette()` — calls core setters (`setFgLnum`, `setFgRule`, etc.)
  for shared constants, keeps local diff palette mutations
- `wrapAnsi()`, `fit()`, `ansiState()`, `injectBg()`
- `summarize()`
- `shouldUseSplit()`
- All diff-specific ANSI bg/fg constants
- `diff` package import

### 2.3 Preserve pi-diff/render export contract

pi-diff's `exports["./render"]` must continue to expose every symbol that
pi-morph imports:

```ts
// pi-morph imports these:
cfg, DiffColors, lang, hlBlock, parseDiff, renderSplit,
resolveDiffColors, shortPath, termW
```

Some now come from pi-render-core. Re-export them:

```ts
// At the end of render.ts
export { cfg, hlBlock, lang, shortPath, termW } from "pi-render-core";
export { ANSI_RE } from "pi-render-core";
export { loadPrettifyConfig } from "pi-render-core";
export { normalizeShikiContrast } from "pi-render-core";
export type { PrettifyConfig } from "pi-render-core";
// diff-specific — still defined locally
export { parseDiff, renderSplit, renderUnified, resolveDiffColors, ... };
```

### 2.4 Verification

```bash
cd ~/workspace/victor/pi-diff
bun install
bun run typecheck
bun run lint
bun test            # if tests exist
```

Then verify pi-morph:

```bash
cd ~/workspace/victor/pi-morph
bun install
bun run typecheck
```

pi-morph's `import { ... } from 'pi-diff/render'` must resolve identically.

### 2.5 Commit

Branch: `refactor/use-render-core`
Commit: `refactor: replace duplicated rendering primitives with pi-render-core`

---

## Phase 3 — Rewire pi-pretty

### 3.1 Add dependency

In pi-pretty's `package.json`:

```json
{
  "dependencies": {
    "pi-render-core": "git+ssh://git@github.com/victor-software-house/pi-render-core.git"
  }
}
```

Remove `"@shikijs/cli": "^4.0.2"` from pi-pretty's dependencies.

### 3.2 Replace duplicated code in `src/index.ts`

Replace with imports from `pi-render-core`:

```ts
import {
  // config
  cfg,
  // ansi
  RST, BOLD, DIM, ITALIC, BG_BASE, BG_STDERR,
  FG_LNUM, FG_DIM, FG_RULE, FG_GREEN, FG_RED, FG_YELLOW,
  FG_BLUE, FG_CYAN, FG_MUTED, FG_ORANGE, FG_PURPLE,
  ANSI_RE, ANSI_CAPTURE_RE,
  parseAnsiRgb, resolveBaseBackground, strip,
  // highlight
  hlBlock, lang,
  // layout
  termW, shortPath, rule, lnum, humanSize,
  // icons
  fileIcon, dirIcon,
  // images
  detectImageProtocol, renderIterm2Image, renderKittyImage,
} from "pi-render-core";
```

**Delete from index.ts:**
- `PrettifyConfig` type, `PRETTIFY_DEFAULTS`, `loadPrettifyConfig()`, `cfg`
- All ANSI constants
- `parseAnsiRgb()`, `resolveBaseBackground()`
- `isLowContrastShikiFg()`, `normalizeShikiContrast()`
- `strip()`
- `EXT_LANG`, `lang()`
- `hlBlock()`, `_touch()`, `_cache`
- `termW()`, `shortPath()`, `rule()`, `lnum()`, `humanSize()`
- `fileIcon()`, `dirIcon()`, `EXT_ICON`, `NAME_ICON`, `NF_*` constants
- `detectImageProtocol()`, `renderIterm2Image()`, `renderKittyImage()`,
  `tmuxWrap()`, `getOuterTerminal()`
- `@shikijs/cli` import

**Keep in index.ts (tool-specific renderers + extension entry):**
- `renderFileContent()`
- `renderBashSummary()`
- `renderTree()`
- `renderFindResults()`
- `renderGrepResults()`
- `piPrettyExtension()` — tool registration wrappers

### 3.3 Add `exports["./render"]`

pi-pretty needs a secondary export so pi-ssh-tools can import the tool-specific
renderers.

In `package.json`:

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./render": "./src/render.ts"
  }
}
```

Create `src/render.ts`:

```ts
/**
 * pi-pretty/render — reusable tool renderers for pi tool output.
 *
 * Used by pi-ssh-tools and other extensions that need the same
 * pretty rendering for read/bash/ls/find/grep output.
 */

// Re-export pi-render-core primitives that consumers commonly need alongside
// tool renderers, so they don't need a direct pi-render-core dependency.
export {
  cfg,
  RST, BOLD, DIM, ITALIC,
  FG_DIM, FG_RULE, FG_GREEN, FG_RED, FG_YELLOW, FG_MUTED,
  resolveBaseBackground,
  hlBlock, lang,
  termW, shortPath, rule, lnum, humanSize,
  fileIcon, dirIcon,
} from "pi-render-core";

// Tool-specific renderers
export { renderFileContent } from "./index.js";
export { renderBashSummary } from "./index.js";
export { renderTree } from "./index.js";
export { renderFindResults } from "./index.js";
export { renderGrepResults } from "./index.js";
```

This means the tool-specific renderer functions in `src/index.ts` must be
exported (currently they are module-private). Add `export` to each:

```ts
export async function renderFileContent(...) { ... }
export function renderBashSummary(...) { ... }
export function renderTree(...) { ... }
export function renderFindResults(...) { ... }
export async function renderGrepResults(...) { ... }
```

### 3.4 Verification

```bash
cd ~/workspace/victor/pi-pretty
bun install
bun run typecheck
bun run lint
```

Live test in a pi session: `read`, `bash`, `ls`, `find`, `grep` must render
identically to before.

### 3.5 Commit

Branch: `refactor/use-render-core`
Commit: `refactor: replace duplicated primitives with pi-render-core, export tool renderers`

---

## Phase 4 — Update pi-ssh-tools

### 4.1 Add dependencies

In `packages/pi-ssh-tools/package.json`:

```json
{
  "dependencies": {
    "pi-pretty": "git+ssh://git@github.com/victor-software-house/pi-pretty.git"
  }
}
```

pi-render-core comes transitively through pi-pretty. No direct dep needed.

### 4.2 Add three new tools

**`ssh_ls`** — remote directory listing

- Parameters: same as SDK `createLsToolDefinition` (`path`, `limit`)
- Execute: `ssh <remote> 'ls -1 --group-directories-first -p <path>'` or
  delegate to SDK ls tool with remote read ops
- renderCall: `ssh_ls <path> [host]`
- renderResult: `renderTree()` from `pi-pretty/render`

**`ssh_find`** — remote file search

- Parameters: same as SDK `createFindToolDefinition` (`pattern`, `path`, `limit`)
- Execute: `ssh <remote> 'find <path> -name "<pattern>" ...'` or delegate to
  SDK find tool with remote ops
- renderCall: `ssh_find <pattern> [host]`
- renderResult: `renderFindResults()` from `pi-pretty/render`

**`ssh_grep`** — remote content search

- Parameters: same as SDK `createGrepToolDefinition` (`pattern`, `path`, `glob`,
  `ignoreCase`, `context`, `limit`, `literal`)
- Execute: `ssh <remote> 'rg ...'` or `grep -rn ...` with remote ops
- renderCall: `ssh_grep <pattern> [host]`
- renderResult: `renderGrepResults()` from `pi-pretty/render`

### 4.3 Wire pretty rendering for all 5 existing + new tools

For each tool, replace the SDK-default `renderResult` with a custom one that
uses pi-pretty's renderers:

**`ssh_read`:**

```ts
import { renderFileContent, resolveBaseBackground, termW, cfg } from "pi-pretty/render";

renderResult(result, _opt, theme, ctx) {
  resolveBaseBackground(theme);
  // Extract text content, filePath, offset from result
  // Async: call renderFileContent(), store in ctx.state, ctx.invalidate()
  // Same pattern as pi-pretty's read renderResult
}
```

**`ssh_bash`:**

```ts
import { renderBashSummary, rule, termW, cfg, resolveBaseBackground } from "pi-pretty/render";

renderResult(result, _opt, theme, ctx) {
  resolveBaseBackground(theme);
  // Extract text + exit code from result
  // Same pattern as pi-pretty's bash renderResult
}
```

**`ssh_ls`:**

```ts
import { renderTree, resolveBaseBackground } from "pi-pretty/render";

renderResult(result, _opt, theme, ctx) {
  resolveBaseBackground(theme);
  // renderTree(text, basePath)
}
```

**`ssh_find`:**

```ts
import { renderFindResults, resolveBaseBackground } from "pi-pretty/render";

renderResult(result, _opt, theme, ctx) {
  resolveBaseBackground(theme);
  // renderFindResults(text)
}
```

**`ssh_grep`:**

```ts
import { renderGrepResults, resolveBaseBackground } from "pi-pretty/render";

renderResult(result, _opt, theme, ctx) {
  resolveBaseBackground(theme);
  // Async: renderGrepResults(text, pattern), ctx.invalidate()
}
```

**`ssh_write` and `ssh_edit`:** Keep SDK defaults. pi-pretty does not enhance
write/edit — pi-diff does (separate concern, separate dependency chain).

### 4.4 Update constants and registration

Update `SSH_TOOL_NAMES`:

```ts
const SSH_TOOL_NAMES = [
  "ssh_read", "ssh_write", "ssh_edit", "ssh_bash",
  "ssh_ls", "ssh_find", "ssh_grep",
] as const;
```

Update `enableSshTools()` / `disableSshTools()` — already generic over
`SSH_TOOL_NAMES`, so adding entries is sufficient.

### 4.5 Update prompt snippets and guidelines

Add to `before_agent_start` system prompt injection:

```
Use ssh_read, ssh_write, ssh_edit, ssh_bash, ssh_ls, ssh_find, and ssh_grep
for remote work. Local read/write/edit/bash/ls/find/grep still operate on
the local machine.
```

Add prompt guidelines for the new tools:

- `ssh_ls`: "List directory contents on the active SSH host."
- `ssh_find`: "Find files by glob pattern on the active SSH host."
- `ssh_grep`: "Search file contents on the active SSH host."

### 4.6 Update package.json

```json
{
  "dependencies": {
    "pi-pretty": "git+ssh://git@github.com/victor-software-house/pi-pretty.git"
  }
}
```

Add `"files"` entry if needed for new source files.

### 4.7 Verification

```bash
cd ~/workspace/victor/ogulcancelik.pi-extensions
npm install   # or bun install at monorepo root
cd packages/pi-ssh-tools
# typecheck (if tsconfig exists, or use pi's jiti loading)
```

Live test in a pi session:
1. `/ssh victor-hostinger`
2. `ssh_read` a .ts file → should show syntax-highlighted output with line numbers
3. `ssh_bash` a command → should show colored exit status + formatted output
4. `ssh_ls` a directory → should show tree view with icons
5. `ssh_find` a pattern → should show grouped results with icons
6. `ssh_grep` a pattern → should show highlighted matches with line numbers
7. `/ssh off` → SSH tools should deactivate

### 4.8 Commit

Branch: `feat/pretty-rendering`
Commit: `feat: add ssh_ls, ssh_find, ssh_grep; wire pi-pretty rendering for all ssh tools`

---

## Rollback plan

Each phase is an independent branch. Rollback any phase without affecting others:

| Phase | Rollback |
|:--|:--|
| 1 (pi-render-core) | Delete repo. No consumers yet. |
| 2 (pi-diff) | Revert branch. pi-morph continues using old pi-diff. |
| 3 (pi-pretty) | Revert branch. Extension continues with self-contained code. |
| 4 (pi-ssh-tools) | Revert branch. SSH tools continue with SDK defaults. |

If a consumer breaks after merging:
- All packages use git SSH deps, so pinning to a specific commit is trivial:
  `"pi-render-core": "git+ssh://...#<commit-sha>"`
- No npm publishes are involved until everything is stable.

---

## Risk summary

| Risk | Likelihood | Impact | Mitigation |
|:--|:--|:--|:--|
| pi-morph breaks (import contract change) | Low | High | pi-diff re-exports all symbols pi-morph uses. Verified with `bun run typecheck` in pi-morph. |
| Shiki singleton conflict (two instances) | Low | Low | pi-render-core is the sole `@shikijs/cli` owner. Consumers remove their copy. |
| ESM mutable binding gotchas | Medium | Medium | Use setter functions for mutable ANSI constants. Tested in pi-diff's `applyDiffPalette()`. |
| pi-pretty rendering regression | Low | Medium | Live test all 5 tools in pi session before merging. Visual output must be identical. |
| git SSH dep resolution failure | Low | Low | Same pattern already works for pi-morph → pi-diff. |
| LRU cache shared across extensions | Low | Low | Single `_cache` instance is better — avoids duplicate Shiki work when both pi-pretty and pi-diff highlight the same file. |

---

## Execution order summary

```
Phase 1: Create pi-render-core         [zero blast radius]
Phase 2: Rewire pi-diff                [verify pi-morph contract]
Phase 3: Rewire pi-pretty              [verify tool rendering]
Phase 4: Update pi-ssh-tools           [the actual feature]
```

Each phase gate: typecheck + lint + live test before proceeding to next.

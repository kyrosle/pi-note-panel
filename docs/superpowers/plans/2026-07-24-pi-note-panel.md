# Pi Note Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish a project-scoped, agent-editable Markdown note panel that reserves a responsive right column in Pi, exposes its current layout budget to agents, and supports keyboard scrolling.

**Architecture:** A small TypeScript Pi extension separates filesystem state, Markdown section updates, layout calculations, and Pi TUI integration. A reversible split-layout adapter narrows the root Pi render width while a non-capturing overlay occupies the reserved right columns; unsupported TUI versions disable only the visual panel. Commands and tools share one controller so writes, external refreshes, viewport metrics, and redraws remain consistent.

**Tech Stack:** TypeScript ESM, Node.js built-in `node:test`, Pi 0.82 extension API, `@earendil-works/pi-tui`, `typebox`, npm.

---

## File map

- `index.ts` — package entry that exports the Pi extension.
- `src/extension.ts` — registers lifecycle hooks, commands, and agent tools.
- `src/controller.ts` — coordinates project state, note refreshes, layout metrics, and UI redraws.
- `src/types.ts` — shared preferences, dimensions, metrics, and tool-result types.
- `src/note-store.ts` — project path containment, UTF-8 reads, atomic writes, limits, and preferences.
- `src/sections.ts` — exact Markdown ATX heading section updates.
- `src/layout.ts` — display-width wrapping, viewport slicing, and capacity metrics.
- `src/sidebar.ts` — focusable scrollable Pi TUI component.
- `src/split-layout.ts` — reversible root-width adapter and right-side overlay lifecycle.
- `test/note-store.test.ts` — storage and safety tests.
- `test/sections.test.ts` — section-update tests.
- `test/layout.test.ts` — wrapping, capacity, and scrolling tests.
- `test/split-layout.test.ts` — adaptive-width install/restore tests with fake TUI.
- `test/extension.test.ts` — command/tool registration and headless behavior.
- `README.md` — installation, commands, tools, compatibility, and usage.
- `LICENSE` — MIT license.
- `package.json` — npm package metadata and Pi extension manifest.
- `tsconfig.json` — strict no-emit type checking.
- `.gitignore` — local dependencies, coverage, and generated output.

### Task 1: Package scaffold and shared contracts

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `index.ts`
- Create: `src/types.ts`

- [ ] **Step 1: Add npm and Pi package metadata**

Create `package.json` with a TypeScript source entry, Pi extension manifest,
strict scripts, optional Pi peer dependencies, and current development
dependencies:

```json
{
  "name": "pi-note-panel",
  "version": "0.1.0",
  "description": "Project-scoped Markdown note sidebar for the Pi coding agent",
  "type": "module",
  "license": "MIT",
  "author": "kyrosle",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/kyrosle/pi-note-panel.git"
  },
  "homepage": "https://github.com/kyrosle/pi-note-panel#readme",
  "bugs": {
    "url": "https://github.com/kyrosle/pi-note-panel/issues"
  },
  "keywords": ["pi-package", "pi", "pi-coding-agent", "notes", "sidebar", "markdown"],
  "exports": {
    ".": "./index.ts"
  },
  "files": ["index.ts", "src/**/*.ts", "README.md", "LICENSE"],
  "scripts": {
    "test": "node --experimental-strip-types --test test/*.test.ts",
    "typecheck": "tsc --noEmit",
    "check": "npm run typecheck && npm test"
  },
  "pi": {
    "extensions": ["./index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "peerDependenciesMeta": {
    "@earendil-works/pi-coding-agent": { "optional": true },
    "@earendil-works/pi-tui": { "optional": true },
    "typebox": { "optional": true }
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "0.82.0",
    "@earendil-works/pi-tui": "0.82.0",
    "@types/node": "^24.0.0",
    "typebox": "1.1.38",
    "typescript": "^5.9.0"
  }
}
```

- [ ] **Step 2: Add strict TypeScript configuration and ignored outputs**

Use:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["index.ts", "src/**/*.ts", "test/**/*.ts"]
}
```

Ignore only:

```gitignore
node_modules/
coverage/
*.tgz
```

- [ ] **Step 3: Define shared contracts**

Define these exact exported contracts in `src/types.ts`:

```ts
export const DEFAULT_PANEL_WIDTH = 36;
export const MIN_PANEL_WIDTH = 24;
export const MAX_PANEL_WIDTH = 80;
export const MIN_MAIN_WIDTH = 60;
export const NOTE_LIMIT_BYTES = 256 * 1024;

export interface PanelPreferences {
  enabled: boolean;
  width: number;
}

export interface TerminalDimensions {
  columns: number;
  rows: number;
}

export type NonNullHiddenReason =
  | "disabled"
  | "narrow-terminal"
  | "ui-unavailable"
  | "layout-conflict"
  | "unsupported-tui";

export type HiddenReason = NonNullHiddenReason | null;

export type VisibilityState =
  | { visible: true; hiddenReason: null }
  | { visible: false; hiddenReason: NonNullHiddenReason };

export type PanelMetrics = VisibilityState & {
  uiAvailable: boolean;
  terminal: TerminalDimensions | null;
  panel: {
    outerWidth: number | null;
    contentWidth: number | null;
    contentRows: number | null;
    scrollOffset: number;
  };
  note: {
    bytes: number;
    sourceLines: number;
    wrappedLines: number | null;
    visibleWrappedLines: number | null;
    hiddenWrappedLines: number | null;
  };
  format: {
    markdown: "plain";
    supportsHeadings: true;
    supportsLists: true;
    supportsCheckboxes: true;
    supportsTables: false;
  };
};
```

- [ ] **Step 4: Export the extension entry**

Create `index.ts`:

```ts
export { default } from "./src/extension.ts";
```

- [ ] **Step 5: Install dependencies and verify the scaffold**

Run: `npm install`

Expected: `package-lock.json` is created with no install failure.

Run: `npm run typecheck`

Expected: failure only because `src/extension.ts` has not been created yet.

### Task 2: Safe project note and preference storage

**Files:**
- Create: `src/note-store.ts`
- Create: `test/note-store.test.ts`

- [ ] **Step 1: Write failing tests for lazy reads and atomic writes**

Cover:

```ts
test("missing note reads as empty without creating .pi", async () => {
  const store = new NoteStore(project);
  assert.equal(await store.read(), "");
  assert.equal(existsSync(join(project, ".pi")), false);
});

test("replace creates NOTE.md and append preserves one separator", async () => {
  const store = new NoteStore(project);
  await store.replace("# Status");
  await store.append("- Ready");
  assert.equal(await store.read(), "# Status\n- Ready\n");
});
```

- [ ] **Step 2: Run storage tests and confirm the expected failure**

Run: `node --experimental-strip-types --test test/note-store.test.ts`

Expected: FAIL because `NoteStore` does not exist.

- [ ] **Step 3: Implement contained paths, reads, atomic replace, and append**

Implement:

```ts
export class NoteStore {
  readonly projectRoot: string;
  readonly piDir: string;
  readonly notePath: string;
  readonly preferencesPath: string;

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
    this.piDir = join(this.projectRoot, ".pi");
    this.notePath = join(this.piDir, "NOTE.md");
    this.preferencesPath = join(this.piDir, "note-panel.json");
  }

  async read(): Promise<string>;
  async replace(content: string): Promise<void>;
  async append(content: string): Promise<void>;
  async readPreferences(): Promise<PanelPreferences>;
  async writePreferences(value: PanelPreferences): Promise<void>;
}
```

Use `lstat`/`realpath` containment checks before writes, reject symlink escape,
validate `Buffer.byteLength(content, "utf8") <= NOTE_LIMIT_BYTES`, write a
same-directory temporary file with mode `0o600`, and rename it over the target.
Always clean the temporary file in `finally` only while its recorded device and
inode still match. This is a snapshot containment check for pre-existing unsafe
paths, not a sandbox against a malicious same-user process concurrently
replacing project directories.

- [ ] **Step 4: Add safety and preference tests**

Test oversized replacement rejection, outside-project symlinks, malformed
preference fallback, width validation, and successful preference persistence.
Also test same-instance concurrent appends, FIFO rejection without blocking,
project-root disappearance, and temporary-file identity changes during cleanup.
Defaults must be:

```ts
{ enabled: true, width: DEFAULT_PANEL_WIDTH }
```

- [ ] **Step 5: Run storage tests**

Run: `node --experimental-strip-types --test test/note-store.test.ts`

Expected: all tests pass and temporary directories contain no orphan temp files.

### Task 3: Markdown section updates

**Files:**
- Create: `src/sections.ts`
- Create: `test/sections.test.ts`

- [ ] **Step 1: Write failing section behavior tests**

Test exact case-insensitive title matching, same-or-higher heading boundaries,
append mode, missing-section creation, duplicate heading rejection, and
preservation of unrelated content.

Representative test:

```ts
test("replace stops at the next heading of the same or higher level", () => {
  const source = "# Root\n## Status\nold\n### Detail\nkeep?\n## Next\nsafe\n";
  assert.equal(
    updateSection(source, { heading: "status", content: "new", mode: "replace", level: 2 }),
    "# Root\n## Status\nnew\n## Next\nsafe\n",
  );
});
```

- [ ] **Step 2: Run section tests and confirm failure**

Run: `node --experimental-strip-types --test test/sections.test.ts`

Expected: FAIL because `updateSection` does not exist.

- [ ] **Step 3: Implement the updater**

Export:

```ts
export interface SectionUpdate {
  heading: string;
  content: string;
  mode: "replace" | "append";
  level?: number;
}

export function updateSection(markdown: string, update: SectionUpdate): string;
```

Parse only ATX headings matching `/^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/`.
Normalize title comparison with `trim().toLocaleLowerCase()`. Reject empty
headings, invalid levels, and duplicate exact matches. For a missing section,
append `\n${"#".repeat(level)} ${heading}\n${content}\n` with normalized
separating newlines.

- [ ] **Step 4: Run section tests**

Run: `node --experimental-strip-types --test test/sections.test.ts`

Expected: all section tests pass.

### Task 4: Width-aware layout and viewport calculations

**Files:**
- Create: `src/layout.ts`
- Create: `test/layout.test.ts`

- [ ] **Step 1: Write failing tests for CJK wrapping and viewport bounds**

Cover ASCII, full-width Chinese, ANSI-colored strings, empty lines, very narrow
widths, top/middle/end viewports, and resize clamping:

```ts
test("wraps CJK by terminal display width", () => {
  assert.deepEqual(wrapMarkdownLines(["中文测试"], 4), ["中文", "测试"]);
});

test("end viewport exposes the final wrapped lines", () => {
  const view = sliceViewport(["1", "2", "3", "4"], 2, Number.POSITIVE_INFINITY);
  assert.deepEqual(view.lines, ["3", "4"]);
  assert.equal(view.offset, 2);
});
```

- [ ] **Step 2: Run layout tests and confirm failure**

Run: `node --experimental-strip-types --test test/layout.test.ts`

Expected: FAIL because layout functions do not exist.

- [ ] **Step 3: Implement layout functions using Pi TUI width utilities**

Export:

```ts
export function shouldShowPanel(
  terminalWidth: number,
  panelWidth: number,
): boolean;

export function wrapMarkdownLines(lines: string[], width: number): string[];

export function sliceViewport(
  lines: string[],
  rows: number,
  requestedOffset: number,
): { lines: string[]; offset: number; hidden: number };

export function calculateContentRows(terminalRows: number): number;
```

Use `visibleWidth`, `sliceByColumn`, or equivalent functions from
`@earendil-works/pi-tui`; do not count JavaScript string length as terminal
width. Preserve an indivisible CJK or emoji grapheme on its own line when a
synthetic test width is narrower than that grapheme, even though that one line
must exceed the requested width. Reserve rows for the top border/title,
separator/status, and bottom border. `shouldShowPanel` requires
`terminalWidth >= MIN_MAIN_WIDTH + panelWidth + 1`.

- [ ] **Step 4: Run layout tests**

Run: `node --experimental-strip-types --test test/layout.test.ts`

Expected: all layout tests pass.

### Task 5: Scrollable sidebar and reversible split layout

**Files:**
- Create: `src/sidebar.ts`
- Create: `src/split-layout.ts`
- Create: `test/split-layout.test.ts`

- [ ] **Step 1: Implement the sidebar component**

Create `NoteSidebar` implementing Pi TUI `Component`:

```ts
export class NoteSidebar implements Component {
  private note = "";
  private terminal: TerminalDimensions | null = null;
  private scrollOffset = 0;
  private focused = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly onEscape: () => void,
  ) {}

  setNote(note: string): void;
  setTerminal(dimensions: TerminalDimensions): void;
  setFocused(focused: boolean): void;
  getMetrics(): PanelMetrics;
  handleInput(data: string): void;
  render(width: number): string[];
  invalidate(): void;
}
```

Render a border, title, visible wrapped lines, and a footer such as
`3-28/74`. Handle `Key.up`, `Key.down`, `Key.pageUp`, `Key.pageDown`,
`Key.home`, `Key.end`, and `Key.escape`; every state change calls
`tui.requestRender()`. Strip all terminal control sequences from note content
before layout, and cache sanitized/wrapped lines by note revision and content
width so repeated Pi render cycles do not reprocess the 256 KiB maximum note.

- [ ] **Step 2: Write failing split-layout adapter tests**

Use a fake TUI with `render`, `showOverlay`, and `requestRender`. Verify:

- visible panel changes root render width from 140 to 103 for width 36;
- narrow dimensions use the original width;
- disabling restores full width;
- disposal restores the exact original render function;
- a second adapter is rejected as `layout-conflict`;
- unsupported objects return `unsupported-tui` without mutation.

- [ ] **Step 3: Implement the adapter**

Export:

```ts
export interface SplitLayoutHandle {
  focus(): void;
  setEnabled(enabled: boolean): void;
  setPanelWidth(width: number): void;
  requestRender(): void;
  getDimensions(): TerminalDimensions | null;
  getHiddenReason(): HiddenReason;
  dispose(): void;
}

export function installSplitLayout(
  tui: TUI,
  sidebar: NoteSidebar,
  options: { enabled: boolean; panelWidth: number },
): SplitLayoutHandle;
```

Capture `originalRender = tui.render` and install a named wrapper marked by a
module-local `Symbol`. The wrapper calculates visibility from
`tui.terminal.columns` and calls `originalRender.call(tui, remainingWidth)`.
Create a `nonCapturing` right-side overlay with dynamic options:

```ts
{
  anchor: "top-right",
  width: panelWidth,
  maxHeight: terminal.rows,
  nonCapturing: true,
  visible: (width, height) => {
    sidebar.setTerminal({ columns: width, rows: height });
    return enabled && shouldShowPanel(width, panelWidth);
  }
}
```

On `focus()`, mark the component focused and call `overlay.focus()`. On escape,
call `overlay.unfocus()` and clear focused state. Restore the original render
only when the active function still carries this adapter's marker.

- [ ] **Step 4: Run split-layout and layout tests**

Run: `node --experimental-strip-types --test test/layout.test.ts test/split-layout.test.ts`

Expected: all tests pass.

### Task 6: Controller, commands, and five agent tools

**Files:**
- Create: `src/controller.ts`
- Create: `src/extension.ts`
- Create: `test/extension.test.ts`

- [ ] **Step 1: Implement the controller**

Create one controller per Pi session/project:

```ts
export class NotePanelController {
  static async create(ctx: ExtensionContext): Promise<NotePanelController>;
  async read(): Promise<{ content: string; metrics: PanelMetrics }>;
  async info(): Promise<PanelMetrics>;
  async replace(content: string): Promise<PanelMetrics>;
  async append(content: string): Promise<PanelMetrics>;
  async updateSection(update: SectionUpdate): Promise<PanelMetrics>;
  async setEnabled(enabled: boolean): Promise<void>;
  async setWidth(width: number): Promise<void>;
  async refresh(): Promise<void>;
  async edit(ctx: ExtensionContext): Promise<void>;
  focus(ctx: ExtensionContext): void;
  dispose(): void;
}
```

Use a trailing-debounced `fs.watch` on `.pi`, or temporarily on the project
root while `.pi` does not exist. Compare note metadata before reading, verify
metadata again after reading, and retry once when an external edit races the
read. Watchers must use `persistent: false` and be closed in `dispose()`.

- [ ] **Step 2: Write failing registration tests**

Create fake `ExtensionAPI` and contexts. Assert registration of:

```text
Commands:
note-panel

Tools:
note_panel_info
note_panel_read
note_panel_append
note_panel_replace
note_panel_update_section
```

Verify print mode registers tools without touching TUI APIs, and verify command
parsing for `on`, `off`, `width`, `refresh`, `edit`, and `focus`.

- [ ] **Step 3: Register tools with exact schemas**

Use `Type` from `typebox`. Each `execute` obtains the controller associated with
the current `ctx.cwd`, performs the operation, and returns a concise text block
plus structured `details`.

Schemas:

```ts
const EmptyParameters = Type.Object({});
const ContentParameters = Type.Object({ content: Type.String() });
const SectionParameters = Type.Object({
  heading: Type.String({ minLength: 1 }),
  content: Type.String(),
  mode: Type.Union([Type.Literal("replace"), Type.Literal("append")]),
  level: Type.Optional(Type.Integer({ minimum: 1, maximum: 6 })),
});
```

Tool descriptions must tell agents to call `note_panel_info` before designing a
compact visible layout and to use semantic Markdown instead of manual padding.

- [ ] **Step 4: Register the command and lifecycle**

`/note-panel` with no arguments prints current state and usage. Parse only:

```ts
type NotePanelCommand =
  | { kind: "on" }
  | { kind: "off" }
  | { kind: "width"; width: number }
  | { kind: "refresh" }
  | { kind: "edit" }
  | { kind: "focus" };
```

Create the TUI integration on `session_start` only when `ctx.mode === "tui"`.
Allow `/note-panel edit` whenever `ctx.hasUI` is true, including RPC mode.
Dispose controllers on `session_shutdown`. Recreate project state when a new
session starts with a different `ctx.cwd`.

- [ ] **Step 5: Run extension tests**

Run: `node --experimental-strip-types --test test/extension.test.ts`

Expected: all registrations, command parsing, and headless tests pass.

### Task 7: Documentation and package release surface

**Files:**
- Create: `README.md`
- Create: `LICENSE`
- Modify: `package.json`

- [ ] **Step 1: Write installation and usage documentation**

README must include:

```bash
pi install npm:pi-note-panel
```

and local Git testing:

```bash
pi install git:github.com/kyrosle/pi-note-panel
```

Document `.pi/NOTE.md`, `.pi/note-panel.json`, all six command actions, five
agent tools, scrolling keys, adaptive reflow, narrow-terminal behavior,
256 KiB limit, no automatic prompt injection, and right-sidebar conflict rules.

- [ ] **Step 2: Add MIT license**

Use the standard MIT text with:

```text
Copyright (c) 2026 kyrosle
```

- [ ] **Step 3: Verify npm package contents**

Run: `npm pack --dry-run`

Expected: package includes only `index.ts`, `src/**/*.ts`, `README.md`,
`LICENSE`, and package metadata; tests and design documents are excluded.

### Task 8: Full verification, live Pi smoke test, and release commit

**Files:**
- Modify only files required by failures found in this task.

- [ ] **Step 1: Run static and automated verification**

Run: `npm run check`

Expected: TypeScript typecheck and every test pass.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 2: Run a local Pi startup smoke test**

Run:

```bash
pi --extension ./index.ts -p "Call note_panel_info and summarize only whether UI is available."
```

Expected: Pi loads the extension in print mode, calls or sees the registered
tool, and exits without attempting TUI rendering.

- [ ] **Step 3: Perform interactive acceptance**

Launch `pi --extension ./index.ts` in a terminal at least 110 columns wide.
Verify:

- the right panel appears and the conversation/editor reflow left;
- `/note-panel width 48`, `off`, and `on` redraw correctly;
- `/note-panel focus` supports every required scrolling key and `Esc`;
- narrowing the terminal hides the panel and restores full-width rendering;
- external edits to `.pi/NOTE.md` refresh without restart;
- tool writes redraw and report updated metrics.

- [ ] **Step 4: Review the final diff against the design**

Check every goal and non-goal in
`docs/specs/2026-07-24-pi-note-panel-design.md`. Confirm no global notes,
automatic context injection, multiple-note abstraction, or unrelated feature
was added.

- [ ] **Step 5: Commit and push**

Run:

```bash
git add .gitignore LICENSE README.md index.ts package.json package-lock.json tsconfig.json src test docs
git commit -m "feat: add project note panel for Pi"
git push -u origin main
```

Expected: `origin/main` points to the new commit and `git status --short` is
empty.

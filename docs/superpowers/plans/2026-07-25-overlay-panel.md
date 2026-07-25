# Pi Note Panel Overlay Implementation Plan

> **Execution:** Use `subagent-driven-development` in the current session. The implementation is intentionally one integrated task because preferences, rendered metrics, overlay lifecycle, commands, and tests share the same state contract.

**Goal:** Replace the split-layout compositor with a passive, project-scoped Pi overlay whose enabled state, width, and height are persisted without changing Pi's conversation/editor width.

**Architecture:** Keep `NoteStore`, `NoteSidebar`, note sanitization, section editing, tools, and watchers. Replace `SplitLayoutHandle` with an `OverlayLayoutHandle` built only on `TUI.showOverlay()`. The controller owns serialized preference updates and exposes configured dimensions even without TUI; the overlay controller owns clamped rendered dimensions, visibility, focus, resize response, and disposal.

**Tech stack:** TypeScript, Node.js, Pi 0.82 extension API, `@earendil-works/pi-tui`, Node test runner.

---

## Task 1: Implement the approved overlay contract

**Files:**

- Modify: `src/types.ts`
- Modify: `src/note-store.ts`
- Create: `src/overlay-layout.ts`
- Delete: `src/split-layout.ts`
- Modify: `src/sidebar.ts`
- Modify: `src/controller.ts`
- Modify: `src/extension.ts`
- Modify: `test/note-store.test.ts`
- Create: `test/overlay-layout.test.ts`
- Delete: `test/split-layout.test.ts`
- Modify: `test/sidebar.test.ts`
- Modify: `test/controller.test.ts`
- Modify: `test/extension.test.ts`
- Modify: `README.md`
- Modify if required by release metadata: `package.json`, `package-lock.json`

### Step 1: Write preference and command tests that describe the new contract

Add failing tests for:

- defaults `{ enabled: false, width: 36, height: 20 }`;
- migration of a valid legacy preference file without `height`;
- integer width range `20..160` and height range `8..120`;
- atomic combined-size persistence;
- `/note-panel height` and `/note-panel size` parsing;
- rejection of invalid values and extra arguments without writing preferences;
- status output containing configured and rendered dimensions.

Run:

```bash
rtk npm test -- --test-name-pattern='preferences|note-panel command'
```

Expected: new assertions fail before implementation.

### Step 2: Implement preferences, serialized updates, and metrics types

In `src/types.ts`:

- add `DEFAULT_PANEL_HEIGHT`, `MIN_PANEL_HEIGHT`, and `MAX_PANEL_HEIGHT`;
- change width limits to `20..160`;
- add `height` to `PanelPreferences`;
- add `configuredWidth`, `configuredHeight`, and `outerHeight` to panel metrics;
- remove split-only hidden reasons such as `layout-conflict`.

In `src/note-store.ts`:

- default to disabled, width `36`, height `20`;
- accept a valid legacy object without `height` and supply the default height;
- validate the complete preference object before each atomic write;
- preserve lazy creation and one-warning malformed-file behavior.

In `src/controller.ts`:

- initialize the same defaults;
- serialize `setEnabled`, `setWidth`, `setHeight`, and atomic `setSize` through the existing queue;
- make headless metrics retain configured dimensions while rendered dimensions remain `null`.

Run:

```bash
rtk npm test -- --test-name-pattern='preferences|metrics'
```

Expected: preference and headless-metrics tests pass.

### Step 3: Replace split composition with the native overlay

Delete `src/split-layout.ts` and create `src/overlay-layout.ts` with:

- one `TUI.showOverlay()` call using `anchor: "right-center"`, numeric `width`, numeric `maxHeight`, and `nonCapturing: true`;
- no reads, writes, wrappers, symbols, or restoration logic involving `TUI.render`;
- separate configured and rendered dimensions;
- terminal clamping that does not mutate preferences;
- temporary hiding below `20x8`, automatic restoration on later visibility checks, and safe focus release;
- update methods for enabled state and complete size;
- best-effort focus, unfocus, redraw, resize, and disposal behavior;
- one actionable unavailable state when overlay creation is unsupported or fails.

Update `NoteSidebar` layout state and metrics to include width and height. Preserve scrolling, viewport clamping, sanitizer caching, and `Esc` focus restoration.

Replace split-layout tests with overlay tests proving:

- `TUI.render` identity never changes;
- options use `right-center`, configured/clamped dimensions, and `nonCapturing`;
- enabled, disabled, narrow, short, resize, restore, focus, and disposal states;
- setup/disposal failures do not leak focus or handles;
- sidebar visible rows and scroll offsets follow rendered height.

Run:

```bash
rtk npm test -- --test-name-pattern='overlay|sidebar|focus|scroll'
```

Expected: all overlay and sidebar tests pass.

### Step 4: Integrate commands, tools, and user-facing documentation

In `src/extension.ts`:

- update usage to include `width <20-160>`, `height <8-120>`, and `size <20-160> <8-120>`;
- add exact parsers and handlers for height and combined size;
- keep invalid or extra arguments side-effect free;
- make `focus` report disabled, terminal-size, unavailable, and non-TUI reasons concisely.

In `README.md`:

- describe the right-side overlay and explicitly state that it covers content without reflow;
- document default-off behavior, persisted width/height, all commands, focus/scroll controls, and agent-visible metrics;
- remove all current split/reflow/column-reservation claims.

If release metadata is changed, use a semver minor bump because the visual behavior and preference schema changed.

Run:

```bash
rtk npm test
rtk npm run typecheck
rtk npm run lint
```

Expected: command, tool, controller, and documentation-related checks pass.

### Step 5: Complete repository and Pi acceptance

Run:

```bash
rtk npm run check
rtk git diff --check
rtk npm pack --dry-run
rtk pi --version
rtk pi --print --no-session -e .
```

For interactive Pi 0.82 acceptance:

- start in a temporary project with no preference file and confirm the overlay is off;
- run `/note-panel on`, then exercise `width`, `height`, and `size`;
- restart and confirm persisted values;
- verify conversation/editor render width is unchanged while the panel covers the right side;
- verify scrolling and `Esc`;
- resize below and above minimum dimensions and confirm hide/restore without preference changes.

Expected:

- all automated checks pass;
- package dry-run contains only intended release files;
- print mode loads without TUI access;
- interactive behavior matches `docs/superpowers/specs/2026-07-25-overlay-panel-design.md`.

### Step 6: Review, commit, and publish

Request a `sol-reviewer` spec-compliance review, fix all blocking findings, then request a fresh `sol-reviewer` code-quality review.

After approval:

```bash
rtk git status --short --branch
rtk git diff --check
rtk git add --all
rtk git commit -m "feat: replace split panel with overlay"
rtk git push origin main
rtk git status --short --branch
rtk git rev-parse HEAD
rtk git ls-remote origin refs/heads/main
```

Expected: local and remote `main` SHAs match and the worktree is clean.

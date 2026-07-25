# Pi Note Panel Overlay Design

## Status

This specification replaces the split-layout behavior described in
`docs/specs/2026-07-24-pi-note-panel-design.md`. The note storage, safety,
sanitization, agent tools, Markdown section handling, and refresh behavior from
the earlier specification remain in effect unless changed here.

## Goal

Display the project note as a persistent, scrollable Pi overlay without
changing the width or wrapping of Pi's conversation and editor.

The overlay is disabled by default. Each project remembers whether it is
enabled and its configured width and height.

## Non-goals

- Reserving terminal columns for the note.
- Reflowing Pi's conversation or editor.
- Wrapping or replacing the root `TUI.render()` function.
- Detecting ownership of a root split-layout compositor.
- Percentage-based or content-dependent panel sizing.
- Global or cross-project display settings.

## Persisted preferences

Preferences remain project-scoped:

```text
<project-root>/.pi/note-panel.json
```

The schema is:

```json
{
  "enabled": false,
  "width": 36,
  "height": 20
}
```

Defaults:

- `enabled`: `false`
- `width`: `36`
- `height`: `20`

Validation:

- Width is an integer from 20 through 160.
- Height is an integer from 8 through 120.
- Existing valid preferences are preserved.
- A legacy preference file without `height` receives the default height.
- A missing or malformed preference file uses all defaults and retains the
  existing one-warning behavior.

Reading preferences does not create `.pi`. Preferences are created only after
an explicit display-setting command.

## Overlay behavior

The visual panel uses Pi's native `TUI.showOverlay()` API.

Overlay options:

- Anchor: `right-center`
- Width: current rendered width
- Maximum height: current rendered height
- `nonCapturing: true` during normal work
- Responsive `visible` callback based on terminal dimensions and enabled state

The overlay covers the terminal cells beneath it. Pi's conversation and editor
continue to render at the full terminal width.

The configured size and rendered size are separate:

- Configured width and height are persisted exactly.
- Rendered width and height are clamped to the currently available terminal
  space.
- The clamp does not modify persisted preferences.
- If the terminal cannot provide the minimum usable overlay size of 20 columns
  by 8 rows, the overlay is temporarily hidden.
- A temporarily hidden overlay returns automatically when enough space is
  available.

The overlay remains passive until `/note-panel focus` is used. Focused
scrolling retains the current controls:

- `Up` and `Down`: one wrapped line
- `PageUp` and `PageDown`: one content viewport
- `Home` and `End`: beginning or end
- `Esc`: return focus to the component that was active immediately before the
  overlay received focus

External focus changes, resize hiding, repeated focus, and disposal must restore
focus safely using Pi's `OverlayHandle` behavior.

## Commands

The command remains `/note-panel` and supports:

```text
/note-panel
/note-panel on
/note-panel off
/note-panel width <20-160>
/note-panel height <8-120>
/note-panel size <20-160> <8-120>
/note-panel refresh
/note-panel edit
/note-panel focus
```

Behavior:

- No arguments show current enabled state, configured size, rendered size, and
  visibility reason.
- `on` and `off` persist enabled state.
- `width` changes only configured width.
- `height` changes only configured height.
- `size` changes width and height in one atomic preference update.
- Invalid or extra arguments produce the updated usage message and do not
  modify preferences.
- `focus` reports a concise reason when the overlay is disabled, temporarily
  hidden, unavailable, or not running in TUI mode.

## Agent-visible layout information

`note_panel_info`, `note_panel_read`, and every successful write-tool result
continue to provide complete metrics in model-visible content and structured
details.

Panel metrics become:

```json
{
  "configuredWidth": 48,
  "configuredHeight": 28,
  "outerWidth": 48,
  "outerHeight": 28,
  "contentWidth": 44,
  "contentRows": 22,
  "scrollOffset": 0
}
```

Semantics:

- `configuredWidth` and `configuredHeight` are available in every mode.
- In TUI mode, `outerWidth` and `outerHeight` describe the clamped size the
  overlay would use, even while disabled.
- `contentWidth` and `contentRows` describe the usable space after borders,
  title, and footer.
- When disabled, wrapped capacity metrics are still calculated for the
  configured/clamped size; `visibleWrappedLines` is zero because nothing is
  displayed.
- When hidden only because of terminal size, the clamped dimensions and
  expected capacity remain available.
- In print, JSON, and RPC modes, rendered dimensions are `null`, while
  configured dimensions remain available.
- `visible` and `hiddenReason` continue to describe actual display state.

No note body is injected automatically into model context.

## Components

```text
Pi extension
├── NotePanelController
├── NoteStore
├── Markdown section updater
├── terminal-control sanitizer
├── layout and wrapping helpers
├── NoteSidebar
└── OverlayLayoutController
```

`OverlayLayoutController` replaces the existing split-layout adapter. It owns
only:

- overlay creation and disposal;
- configured and rendered dimensions;
- enabled and responsive visibility state;
- focus and unfocus;
- redraw requests.

It must not read, replace, wrap, mark, or restore `TUI.render()`.

## Data flow

Startup:

1. Read project preferences and note.
2. Register tools and commands in every mode.
3. In TUI mode, obtain the raw Pi TUI through the existing zero-height
   bootstrap component.
4. Create one passive overlay only when the TUI attachment succeeds.
5. Keep it hidden when `enabled` is false.

Preference change:

1. Serialize the preference read-modify-write through the controller queue.
2. Validate the complete next preference object.
3. Persist it atomically.
4. Update overlay options and sidebar metrics immediately.
5. Request one redraw.

Note change:

1. Retain the existing safe note write or external-file refresh flow.
2. Sanitize render text while preserving raw note metadata.
3. Recalculate wrapped content for the current rendered content width.
4. Clamp scroll offset and request a redraw.

## Compatibility and failure behavior

- TUI mode uses the official overlay API only.
- RPC keeps commands, tools, and dialog editing but does not install a visual
  overlay.
- Print and JSON modes keep tools and commands without any TUI access.
- Another overlay does not cause a root-layout conflict; Pi's overlay stack
  determines visual ordering.
- Failure to create an overlay disables only the visual panel and emits one
  actionable warning.
- Overlay focus, hide, resize, or disposal failures use best-effort cleanup and
  must not leak controller watchers or widgets.
- Removing the split-layout adapter must also remove its global owner symbols,
  wrapper recovery code, conflict warnings, and root-render compatibility tests.

## Testing

Automated tests must cover:

- New preference defaults and migration from a missing `height`.
- Width, height, and combined-size validation and atomic persistence.
- Command parsing for `height` and `size`, including invalid and extra input.
- Overlay creation with `right-center`, fixed dimensions, and
  `nonCapturing: true`.
- Proof that root `TUI.render()` remains unchanged before, during, and after
  overlay use.
- Enabled, disabled, narrow, short, clamped, resized, and restored states.
- Configured versus rendered metrics in TUI and headless modes.
- Scrolling and focus restoration after resize or external focus changes.
- Overlay setup and disposal failures without leaked state.
- Existing storage, sanitizer, Markdown, tool, watcher, and concurrency tests.

Manual Pi 0.82 acceptance must verify:

- Pi conversation and editor keep their original width.
- The note overlays the right side instead of causing reflow.
- Default startup does not show the panel.
- `on`, `off`, `width`, `height`, and `size` persist across restart.
- Focused scrolling works and `Esc` returns to Pi's editor.
- Resize clamps or hides the overlay without changing saved settings.

## Release impact

This is a behavior-changing minor release. README examples and compatibility
language must remove adaptive reflow and split-layout claims and document that
the overlay covers content beneath it.


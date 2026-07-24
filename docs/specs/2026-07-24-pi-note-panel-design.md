# Pi Note Panel Design

## Summary

Pi Note Panel is a project-scoped Markdown note sidebar for the Pi coding agent.
It keeps durable project context visible beside the conversation without
automatically adding that content to model prompts.

The extension stores one note at `<project>/.pi/NOTE.md`. Both the user and the
agent can edit it. The note panel is enabled by default, uses a 36-column right
sidebar, and hides automatically when the terminal is too narrow.

## Goals

- Keep high-value project notes continuously visible while working in Pi.
- Let users edit the note with their normal editor.
- Let agents read and update the same note through narrowly scoped tools.
- Let agents inspect the current panel capacity before designing note content.
- Keep note content out of model context unless an agent explicitly reads it.
- Keep notes isolated per project.
- Degrade safely when the terminal cannot display a sidebar.

## Non-goals

- Cross-project or global notes.
- Automatic prompt or system-message injection.
- A full Markdown editor or renderer.
- Knowledge-base search, embeddings, or long-term memory.
- Multiple note files in the first release.
- Remote synchronization beyond normal Git workflows.

## Project identity

- Product name: `Pi Note Panel`
- Repository: `kyrosle/pi-note-panel`
- npm package: `pi-note-panel`
- Extension command namespace: `/note-panel`

## Storage

The note is stored at:

```text
<project-root>/.pi/NOTE.md
```

The extension treats Pi's current working directory as the project root. A
missing note is a valid empty state. Startup and reads do not create the file;
the `.pi` directory and note are created lazily on the first write.

Display preferences are stored separately from note content. The initial
implementation stores them in:

```text
<project-root>/.pi/note-panel.json
```

Supported preferences:

```json
{
  "enabled": true,
  "width": 36
}
```

This keeps both note visibility and width project-specific and avoids modifying
Pi's shared settings.

## User interface

### Sidebar

When enabled and enough terminal width is available, the extension displays a
right-side panel titled `Project Notes`.

- Default width: 36 columns.
- Valid configured width: 24 to 80 columns.
- The conversation pane must retain at least 60 columns.
- While the panel is visible, Pi's main conversation and editor are rendered
  using the remaining left-side width, so content reflows instead of being
  covered by the panel.
- The panel hides when the terminal cannot satisfy both widths.
- The panel returns automatically when enough width becomes available.
- Hiding due to terminal width does not change the saved `enabled` preference.
- Content is line-wrapped to the available panel width.
- Markdown markers such as headings, lists, and checkboxes are preserved as
  plain text.
- Terminal escape and control sequences in the note are stripped before layout
  and rendering. Notes are Markdown data, never trusted terminal instructions.
- When content exceeds visible height, the panel becomes vertically scrollable
  and shows its current line range plus a compact scrollbar indicator.
- Missing or empty notes display a short empty-state hint.

The panel is passive and non-capturing during normal work. `/note-panel focus`
temporarily gives it keyboard focus:

- `Up` and `Down`: scroll one wrapped line.
- `PageUp` and `PageDown`: scroll one viewport.
- `Home` and `End`: jump to the beginning or end.
- `Esc`: return focus to Pi's editor.

The current scroll position is kept in memory only. It is clamped after resize
or content changes and is not written to project configuration. Mouse-wheel
support is optional and only enabled when Pi exposes a stable input sequence;
keyboard scrolling is the required behavior.

### Commands

```text
/note-panel on
/note-panel off
/note-panel width <24-80>
/note-panel refresh
/note-panel edit
/note-panel focus
```

- `on` and `off` update project preferences.
- `width` validates and persists the requested width.
- `refresh` reloads the note and redraws the sidebar.
- `edit` opens `.pi/NOTE.md` with Pi's supported editor mechanism or the
  configured `$EDITOR`. It creates the note lazily because editing is an
  explicit write intent.
- `focus` focuses the visible panel for scrolling. It reports why the panel is
  unavailable when disabled, hidden by width, headless, or in conflict.

Invalid command arguments produce a concise usage message without changing
state.

## Agent tools

The extension registers five tools:

### `note_panel_info`

Returns the panel's current layout budget without reading the note body. This
lets an agent design concise content for the space that is actually visible.

The result contains:

```json
{
  "uiAvailable": true,
  "visible": true,
  "hiddenReason": null,
  "terminal": {
    "columns": 144,
    "rows": 42
  },
  "panel": {
    "outerWidth": 36,
    "contentWidth": 32,
    "contentRows": 36,
    "scrollOffset": 0
  },
  "note": {
    "bytes": 1840,
    "sourceLines": 31,
    "wrappedLines": 39,
    "visibleWrappedLines": 36,
    "hiddenWrappedLines": 3
  },
  "format": {
    "markdown": "plain",
    "supportsHeadings": true,
    "supportsLists": true,
    "supportsCheckboxes": true,
    "supportsTables": false
  }
}
```

`contentWidth` and `contentRows` are the useful space after borders, title, and
overflow indicator. Terminal and panel dimensions are nullable when Pi is
running without an interactive UI. A disabled or narrow panel with an available
TUI retains its configured capacity budget, with zero visible wrapped lines;
unsupported layouts and headless operation keep capacity fields nullable.
`hiddenReason` distinguishes a user-disabled panel, a narrow terminal,
unavailable UI, and a layout conflict. Raw note bytes and source lines remain
raw-file metadata, while wrapped-line capacity uses sanitized render text.

Agents should use semantic Markdown rather than manually padding columns.
Wrapping and CJK display width are renderer responsibilities.

### `note_panel_read`

Reads the current project note. A missing file returns an empty note instead of
an error. Its result also includes the same compact panel and note-size metadata
as `note_panel_info`, allowing an agent to read and plan in one call when the
content itself is needed. The returned Markdown has terminal control sequences
removed; ordinary Markdown content is otherwise preserved.

### `note_panel_append`

Appends Markdown text to the note. It inserts one separating newline when
needed.

### `note_panel_replace`

Replaces the complete note with supplied Markdown. It cannot delete the note
file; empty content produces an empty file.

### `note_panel_update_section`

Updates a section selected by an exact, case-insensitive ATX Markdown heading.

Inputs:

- `heading`: heading title without `#` markers.
- `content`: replacement or appended Markdown.
- `mode`: `replace` or `append`.
- `level`: heading level used when a missing section is created; defaults to 2.

Section boundaries extend from the matched heading until the next heading of
the same or higher level. If the section is absent, the tool appends a new
section using the requested level. It rejects creation if the note ends inside
an unclosed fenced code block, so it never appends a section into user code.

All successful writes immediately update the sidebar.
Write-tool results include the post-write layout metadata so an agent can see
whether the revised note still fits without making another tool call.

## Context policy

The note is never injected automatically into system prompts, user messages, or
model context. Agents receive the registered tool descriptions and must call
`note_panel_read` when the task needs the note.

This policy avoids permanent context usage and model-specific compression
behavior. It also makes note access visible in the tool history.

## File safety

- Tools operate only on the resolved current project's `.pi/NOTE.md`.
- Writes reject a note path or `.pi` directory that resolves through a symlink
  outside the project root.
- This containment check protects against unsafe paths present when an
  operation begins. It is not a sandbox against a malicious same-user process
  replacing project directories concurrently; such a process can already edit
  the project's note directly.
- Writes use a temporary file in `.pi` followed by an atomic rename.
- Note content must be valid UTF-8 text.
- Rendering and `note_panel_read` remove terminal control sequences such as
  CSI, OSC, DCS, and APC so a project note cannot clear the screen, forge
  terminal UI, or modify the clipboard.
- The maximum note size is 256 KiB after a write.
- Failed validation leaves the existing note unchanged.
- The extension does not expose a tool that removes the note file.

## Refresh behavior

The panel refreshes:

- when the extension initializes;
- after a successful command or tool write;
- after `/note-panel refresh`;
- when a lightweight file modification check detects an external edit;
- when terminal dimensions change.

External-file checks are debounced and compare file metadata before reading.
They must not keep Pi alive during shutdown.

The sidebar captures current terminal width and height from Pi's overlay layout
callback on each render. The latest dimensions feed `note_panel_info`; no
separate terminal polling is required.

## Split-layout integration

Pi's public extension API supports floating overlays but does not expose a
first-class root split-layout slot. A normal right-side overlay would cover text
that Pi had rendered at full terminal width, which is not acceptable for this
extension.

Pi Note Panel therefore installs a narrow, reversible render-width adapter on
the current Pi `TUI` instance:

1. Preserve the original root `render(width)` function.
2. When the panel is visible, render Pi's normal children with
   `terminalWidth - panelWidth - separatorWidth`.
3. Composite the panel into the reserved right-side columns.
4. When the panel hides, immediately restore full-width rendering.
5. On extension disposal, restore the exact original function if the installed
   adapter is still the active wrapper.

This uses Pi TUI's public `render(width)`, `showOverlay()`, `OverlayHandle`, and
`requestRender()` surfaces, but the combination is an integration adapter rather
than a documented split-panel extension point. It must be isolated in one
module, covered by compatibility tests, and guarded by runtime capability
checks.

If the expected TUI capabilities are unavailable, the extension does not fall
back to a text-covering overlay. It disables only the visual sidebar, keeps
commands and agent tools available, and reports that the installed Pi version
does not support adaptive layout.

## Compatibility

The extension should coexist with status bars, usage widgets, subagent tools,
memory tools, and normal Pi widgets.

Only one extension should own the right-side terminal compositor. If Pi or
another extension already exposes an incompatible sidebar owner, Pi Note Panel
must disable its sidebar, keep commands and agent tools available, and report a
single actionable warning instead of crashing startup.

Headless and print modes must register non-UI functionality without attempting
terminal rendering.

## Components

```text
Pi extension entry
├── project path resolver
├── note store
│   ├── safe read
│   ├── atomic write
│   └── section updater
├── preference store
├── split-layout adapter
├── scrollable sidebar renderer/compositor
├── refresh coordinator
├── slash commands
└── agent tools
```

Core note and rendering logic remains independent of Pi UI APIs so it can be
unit tested without starting an interactive terminal.

## Error handling

- Missing note: return/display the empty state.
- Permission failure: report the affected project-relative path and preserve
  prior content.
- Invalid width or tool input: reject before writing.
- Oversized content: reject and report the 256 KiB limit.
- Malformed preference file: use defaults and show one warning.
- Sidebar conflict or unavailable UI: disable only the visual panel.
- Unsupported split-layout capability: do not show a covering overlay.
- External edit race: re-read metadata after loading and retry once; if it
  changes again, wait for the next refresh.

## Verification

### Automated tests

- Project path and symlink containment.
- Missing-file reads and lazy creation.
- Atomic replace and append behavior.
- Size-limit enforcement.
- Markdown section matching, replacement, append, and creation.
- Width validation, wrapping, and overflow indicator.
- Scroll bounds, page movement, resize clamping, and focus release.
- Adaptive main-pane width and restoration after hiding or disposal.
- Panel-info dimensions, capacity calculation, and headless null values.
- Preference defaults and malformed configuration recovery.
- Headless initialization without UI access.
- Tool and command registration.

### Manual acceptance

- Launch Pi in a project with and without `.pi/NOTE.md`.
- Confirm the panel remains visible beside the conversation.
- Resize below and above the visibility threshold.
- Confirm conversation and editor content reflow without being covered.
- Focus the panel and test line, page, top, and bottom scrolling.
- Press `Esc` and confirm input focus returns to Pi.
- Change width and enablement, then restart Pi.
- Edit the note externally and confirm refresh.
- Update the note through every agent tool and confirm immediate redraw.
- Verify another project uses a different note and preferences.
- Verify Pi starts safely when a conflicting sidebar is installed.

## Release scope

The first release includes the project note, persistent sidebar, six commands,
five agent tools, safe file handling, automated tests, README installation
instructions, and an MIT license.

Multiple notes, custom themes, global notes, and model context injection are
deferred.

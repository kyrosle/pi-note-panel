import { Key, matchesKey, sliceByColumn, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

import { calculateContentRows, sliceViewport, wrapMarkdownLines } from "./layout.ts";
import { rawNoteMetrics, sanitizeNoteMarkdown } from "./sanitize.ts";
import type {
  NonNullHiddenReason,
  PanelMetrics,
  TerminalDimensions,
  VisibilityState,
} from "./types.ts";

const EMPTY_NOTE_HINT = "No project notes yet.";

export interface SidebarLayoutState {
  terminal: TerminalDimensions | null;
  configuredWidth: number;
  configuredHeight: number;
  outerWidth: number | null;
  outerHeight: number | null;
  visibility: VisibilityState;
}

export interface NoteSidebarOptions {
  wrapMarkdownLines?: (lines: string[], width: number) => string[];
}

export class NoteSidebar implements Component {
  private readonly tui: Pick<TUI, "requestRender">;
  private readonly onEscape: () => void;
  private readonly wrapLines: (lines: string[], width: number) => string[];
  private rawNote = "";
  private sourceLinesCache: string[] = [];
  private noteRevision = 0;
  private wrappedLinesCache: { noteRevision: number; contentWidth: number; lines: string[] } | null = null;
  private terminal: TerminalDimensions | null = null;
  private scrollOffset = 0;
  private focused = false;
  private configuredWidth = 36;
  private configuredHeight = 20;
  private outerWidth: number | null = null;
  private outerHeight: number | null = null;
  private managedLayout = false;
  private requestedVisible = true;
  private hiddenReason: NonNullHiddenReason = "ui-unavailable";
  private escapeHandler: (() => void) | undefined;

  constructor(
    tui: Pick<TUI, "requestRender">,
    _theme: unknown,
    onEscape: () => void,
    options: NoteSidebarOptions = {},
  ) {
    this.tui = tui;
    this.onEscape = onEscape;
    this.wrapLines = options.wrapMarkdownLines ?? wrapMarkdownLines;
  }

  setNote(note: string): void {
    const sanitized = sanitizeNoteMarkdown(note);
    if (this.rawNote === note) {
      return;
    }

    this.rawNote = note;
    this.sourceLinesCache = sanitized === "" ? [] : sanitized.split(/\r\n|\n|\r/);
    this.noteRevision += 1;
    this.wrappedLinesCache = null;
    this.clampScrollOffset();
    this.tui.requestRender();
  }

  setTerminal(dimensions: TerminalDimensions): void {
    if (sameDimensions(this.terminal, dimensions)) {
      return;
    }

    this.terminal = { ...dimensions };
    if (!this.managedLayout) {
      this.outerHeight = dimensions.rows;
    }
    this.clampScrollOffset();
    this.tui.requestRender();
  }

  setLayoutState(state: SidebarLayoutState, requestRender = true): void {
    this.managedLayout = true;
    const nextTerminal = state.terminal === null ? null : { ...state.terminal };
    const nextHiddenReason = state.visibility.visible ? "ui-unavailable" : state.visibility.hiddenReason;
    if (
      sameDimensions(this.terminal, nextTerminal)
      && this.configuredWidth === state.configuredWidth
      && this.configuredHeight === state.configuredHeight
      && this.outerWidth === state.outerWidth
      && this.outerHeight === state.outerHeight
      && this.requestedVisible === state.visibility.visible
      && this.hiddenReason === nextHiddenReason
    ) {
      return;
    }

    this.terminal = nextTerminal;
    this.configuredWidth = state.configuredWidth;
    this.configuredHeight = state.configuredHeight;
    this.outerWidth = state.outerWidth;
    this.outerHeight = state.outerHeight;
    this.requestedVisible = state.visibility.visible;
    this.hiddenReason = nextHiddenReason;
    if (!state.visibility.visible) {
      this.focused = false;
    }
    this.clampScrollOffset();
    if (requestRender) {
      this.tui.requestRender();
    }
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) {
      return;
    }

    this.focused = focused;
    this.tui.requestRender();
  }

  setVisibility(visible: boolean, hiddenReason: NonNullHiddenReason = "ui-unavailable"): void {
    if (this.requestedVisible === visible && this.hiddenReason === hiddenReason) {
      return;
    }

    this.requestedVisible = visible;
    this.hiddenReason = hiddenReason;
    if (!visible) {
      this.focused = false;
    }
    this.tui.requestRender();
  }

  setEscapeHandler(handler: (() => void) | undefined): void {
    this.escapeHandler = handler;
  }

  getMetrics(): PanelMetrics {
    const visible = this.isVisible();
    const hasCapacity = this.outerWidth !== null && this.terminal !== null;
    const contentWidth = !hasCapacity || this.outerWidth === null ? null : Math.max(0, this.outerWidth - 4);
    const contentRows = !hasCapacity || this.outerHeight === null ? null : calculateContentRows(this.outerHeight);
    const wrappedLines = contentWidth === null ? null : this.wrappedLines(contentWidth);
    const viewport = !visible || wrappedLines === null || contentRows === null
      ? null
      : sliceViewport(wrappedLines, contentRows, this.scrollOffset);
    const rawMetrics = rawNoteMetrics(this.rawNote);

    const base = {
      uiAvailable: this.terminal !== null,
      terminal: this.terminal === null ? null : { ...this.terminal },
      panel: {
        configuredWidth: this.configuredWidth,
        configuredHeight: this.configuredHeight,
        outerWidth: this.outerWidth,
        outerHeight: this.outerHeight,
        contentWidth,
        contentRows,
        scrollOffset: visible ? viewport?.offset ?? this.scrollOffset : this.scrollOffset,
      },
      note: {
        bytes: rawMetrics.bytes,
        sourceLines: rawMetrics.sourceLines,
        wrappedLines: wrappedLines?.length ?? null,
        visibleWrappedLines: visible ? viewport?.lines.length ?? null : wrappedLines === null ? null : 0,
        hiddenWrappedLines: visible
          ? viewport === null || wrappedLines === null ? null : wrappedLines.length - viewport.lines.length
          : wrappedLines?.length ?? null,
      },
      format: {
        markdown: "plain" as const,
        supportsHeadings: true as const,
        supportsLists: true as const,
        supportsCheckboxes: true as const,
        supportsTables: false as const,
      },
    };

    return visible
      ? { ...base, visible: true, hiddenReason: null }
      : { ...base, visible: false, hiddenReason: this.hiddenReason };
  }

  handleInput(data: string): void {
    if (!this.focused) {
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.setFocused(false);
      this.onEscape();
      this.escapeHandler?.();
      return;
    }

    const contentRows = this.contentRows();
    let nextOffset: number | null = null;
    if (matchesKey(data, Key.up)) {
      nextOffset = this.scrollOffset - 1;
    } else if (matchesKey(data, Key.down)) {
      nextOffset = this.scrollOffset + 1;
    } else if (matchesKey(data, Key.pageUp)) {
      nextOffset = this.scrollOffset - contentRows;
    } else if (matchesKey(data, Key.pageDown)) {
      nextOffset = this.scrollOffset + contentRows;
    } else if (matchesKey(data, Key.home)) {
      nextOffset = 0;
    } else if (matchesKey(data, Key.end)) {
      nextOffset = Number.POSITIVE_INFINITY;
    }

    if (nextOffset === null) {
      return;
    }

    const offset = sliceViewport(this.wrappedLines(this.contentWidth()), contentRows, nextOffset).offset;
    if (offset !== this.scrollOffset) {
      this.scrollOffset = offset;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    this.outerWidth = Math.max(4, Number.isFinite(width) ? Math.floor(width) : 4);
    this.clampScrollOffset();

    const contentWidth = this.contentWidth();
    const contentRows = this.contentRows();
    const wrappedLines = this.wrappedLines(contentWidth);
    const viewport = sliceViewport(wrappedLines, contentRows, this.scrollOffset);
    this.scrollOffset = viewport.offset;
    const content = wrappedLines.length === 0
      ? [EMPTY_NOTE_HINT, ...Array(Math.max(0, contentRows - 1)).fill("")]
      : [...viewport.lines, ...Array(Math.max(0, contentRows - viewport.lines.length)).fill("")];

    return [
      `╭${"─".repeat(this.outerWidth - 2)}╮`,
      this.row("Project Notes"),
      `├${"─".repeat(this.outerWidth - 2)}┤`,
      ...content.map((line) => this.row(line)),
      `├${"─".repeat(this.outerWidth - 2)}┤`,
      this.row(this.footer(viewport, wrappedLines.length)),
      `╰${"─".repeat(this.outerWidth - 2)}╯`,
    ];
  }

  invalidate(): void {
    this.tui.requestRender();
  }

  private isVisible(): boolean {
    return this.requestedVisible && this.terminal !== null;
  }

  private contentWidth(): number {
    return this.outerWidth === null ? 0 : Math.max(0, this.outerWidth - 4);
  }

  private contentRows(): number {
    return this.outerHeight === null ? 0 : calculateContentRows(this.outerHeight);
  }

  private wrappedLines(contentWidth: number): string[] {
    if (contentWidth <= 0 || this.sourceLinesCache.length === 0) {
      return [];
    }
    if (
      this.wrappedLinesCache?.noteRevision === this.noteRevision
      && this.wrappedLinesCache.contentWidth === contentWidth
    ) {
      return this.wrappedLinesCache.lines;
    }

    const lines = this.wrapLines(this.sourceLinesCache, contentWidth);
    this.wrappedLinesCache = { noteRevision: this.noteRevision, contentWidth, lines };
    return lines;
  }

  private clampScrollOffset(): void {
    this.scrollOffset = sliceViewport(this.wrappedLines(this.contentWidth()), this.contentRows(), this.scrollOffset).offset;
  }

  private row(content: string): string {
    const width = this.contentWidth();
    const clipped = sliceByColumn(content, 0, width, true);
    return `│ ${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))} │`;
  }

  private footer(viewport: ReturnType<typeof sliceViewport>, total: number): string {
    if (total === 0) {
      return "Empty";
    }

    const start = viewport.lines.length === 0 ? 0 : viewport.offset + 1;
    const end = viewport.offset + viewport.lines.length;
    const before = viewport.offset > 0 ? "↑" : "";
    const after = end < total ? "↓" : "";
    return `${start}-${end}/${total}${before}${after}`;
  }
}

function sameDimensions(left: TerminalDimensions | null, right: TerminalDimensions | null): boolean {
  return left?.columns === right?.columns && left?.rows === right?.rows;
}

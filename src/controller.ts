import { existsSync, watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import { NoteStore } from "./note-store.ts";
import { rawNoteMetrics, sanitizeNoteMarkdown } from "./sanitize.ts";
import { updateSection, type SectionUpdate } from "./sections.ts";
import { NoteSidebar } from "./sidebar.ts";
import { installOverlayLayout, type OverlayLayoutHandle } from "./overlay-layout.ts";
import { DEFAULT_PANEL_HEIGHT, DEFAULT_PANEL_WIDTH, type PanelMetrics, type PanelPreferences } from "./types.ts";

const BOOTSTRAP_WIDGET_KEY = "pi-note-panel-bootstrap";
const WATCH_DEBOUNCE_MS = 75;

export interface NotePanelControllerOptions {
  readNote?: () => Promise<string>;
  readSignature?: () => Promise<string | null>;
  watchPath?: typeof watch;
}

export interface NotePanelStatus {
  enabled: boolean;
  configuredWidth: number;
  configuredHeight: number;
  renderedWidth: number | null;
  renderedHeight: number | null;
  hiddenReason: PanelMetrics["hiddenReason"];
}

export class NotePanelController {
  private readonly store: NoteStore;
  private readonly readNote: () => Promise<string>;
  private readonly readSignature: () => Promise<string | null>;
  private readonly watchPath: typeof watch;
  private preferences: PanelPreferences;
  private note = "";
  private noteSignature: string | null = null;
  private sidebar: NoteSidebar | undefined;
  private layout: OverlayLayoutHandle | undefined;
  private projectWatcher: FSWatcher | undefined;
  private piWatcher: FSWatcher | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private widgetContext: ExtensionContext | undefined;
  private warnedAboutVisualLayout = false;
  private closing = false;
  private disposed = false;
  private closePromise: Promise<void> | undefined;

  private constructor(cwd: string, ctx: ExtensionContext, options: NotePanelControllerOptions) {
    this.store = new NoteStore(cwd, {
      onWarning: (message) => ctx.ui.notify(message, "warning"),
    });
    this.readNote = options.readNote ?? (() => this.store.read());
    this.readSignature = options.readSignature ?? (() => this.readNoteSignature());
    this.watchPath = options.watchPath ?? watch;
    this.preferences = { enabled: false, width: DEFAULT_PANEL_WIDTH, height: DEFAULT_PANEL_HEIGHT };
  }

  static async create(ctx: ExtensionContext, options: NotePanelControllerOptions = {}): Promise<NotePanelController> {
    const controller = new NotePanelController(resolve(ctx.cwd), ctx, options);
    try {
      controller.preferences = await controller.store.readPreferences();
      await controller.refreshInternal();
      controller.ensureWatcher();
      controller.attach(ctx);
      return controller;
    } catch (error) {
      await controller.dispose();
      throw error;
    }
  }

  attach(ctx: ExtensionContext): void {
    if (this.closing || this.disposed || ctx.mode !== "tui" || this.widgetContext !== undefined) {
      return;
    }
    this.widgetContext = ctx;
    try {
      ctx.ui.setWidget(BOOTSTRAP_WIDGET_KEY, (tui, theme) => this.createBootstrap(tui, theme));
    } catch (error) {
      try {
        ctx.ui.setWidget(BOOTSTRAP_WIDGET_KEY, undefined);
      } catch {
        // The original context may already have rejected the partial widget.
      }
      this.widgetContext = undefined;
      throw error;
    }
  }

  async read(): Promise<{ content: string; metrics: PanelMetrics }> {
    await this.refresh();
    return { content: sanitizeNoteMarkdown(this.note), metrics: this.metrics() };
  }

  async info(): Promise<PanelMetrics> {
    return this.metrics();
  }

  async status(): Promise<NotePanelStatus> {
    const metrics = this.metrics();
    return {
      enabled: this.preferences.enabled,
      configuredWidth: this.preferences.width,
      configuredHeight: this.preferences.height,
      renderedWidth: metrics.panel.outerWidth,
      renderedHeight: metrics.panel.outerHeight,
      hiddenReason: metrics.hiddenReason,
    };
  }

  async replace(content: string): Promise<PanelMetrics> {
    return this.enqueue(async () => {
      await this.store.replace(content);
      await this.refreshInternal();
      this.ensureWatcher();
      return this.metrics();
    });
  }

  async append(content: string): Promise<PanelMetrics> {
    return this.enqueue(async () => {
      await this.store.append(content);
      await this.refreshInternal();
      this.ensureWatcher();
      return this.metrics();
    });
  }

  async updateSection(update: SectionUpdate): Promise<PanelMetrics> {
    return this.enqueue(async () => {
      await this.store.replace(updateSection(await this.store.read(), update));
      await this.refreshInternal();
      this.ensureWatcher();
      return this.metrics();
    });
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.enqueue(async () => {
      const preferences = { ...await this.store.readPreferences(), enabled };
      await this.store.writePreferences(preferences);
      this.preferences = preferences;
      this.layout?.setEnabled(enabled);
      await this.refreshInternal();
      this.ensureWatcher();
    });
  }

  async setWidth(width: number): Promise<void> {
    await this.enqueue(async () => {
      const preferences = { ...await this.store.readPreferences(), width };
      await this.store.writePreferences(preferences);
      this.preferences = preferences;
      this.layout?.setPanelSize(width, preferences.height);
      await this.refreshInternal();
      this.ensureWatcher();
    });
  }

  async setHeight(height: number): Promise<void> {
    await this.enqueue(async () => {
      const preferences = { ...await this.store.readPreferences(), height };
      await this.store.writePreferences(preferences);
      this.preferences = preferences;
      this.layout?.setPanelSize(preferences.width, height);
      await this.refreshInternal();
      this.ensureWatcher();
    });
  }

  async setSize(width: number, height: number): Promise<void> {
    await this.enqueue(async () => {
      const preferences = { ...await this.store.readPreferences(), width, height };
      await this.store.writePreferences(preferences);
      this.preferences = preferences;
      this.layout?.setPanelSize(width, height);
      await this.refreshInternal();
      this.ensureWatcher();
    });
  }

  async refresh(): Promise<void> {
    await this.enqueue(() => this.refreshInternal());
  }

  async edit(ctx: ExtensionContext): Promise<void> {
    this.assertOpen();
    if (!ctx.hasUI) {
      ctx.ui.notify("Note panel editing requires an available UI.", "warning");
      return;
    }
    const current = await this.store.read();
    const edited = await ctx.ui.editor("Project Notes", current);
    if (edited !== undefined) {
      await this.replace(edited);
    }
  }

  focus(ctx: ExtensionContext): void {
    const reason = this.layout?.getHiddenReason() ?? "ui-unavailable";
    if (reason === null) {
      this.layout?.focus();
      return;
    }
    const message = {
      disabled: "Note panel is disabled.",
      "narrow-terminal": "Note panel is hidden because the terminal is too small.",
      "ui-unavailable": "Note panel is unavailable outside TUI mode.",
      "unsupported-tui": "Note panel is unavailable in this TUI.",
    }[reason];
    ctx.ui.notify(message, "warning");
  }

  async dispose(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    this.closing = true;
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    const queued = this.queue;
    this.closePromise = queued.catch(() => {}).then(() => {
      this.disposed = true;
      try {
        this.projectWatcher?.close();
      } catch {
        // Continue cleaning all remaining resources.
      } finally {
        this.projectWatcher = undefined;
      }
      try {
        this.piWatcher?.close();
      } catch {
        // Continue cleaning all remaining resources.
      } finally {
        this.piWatcher = undefined;
      }
      try {
        this.layout?.dispose();
      } catch {
        // Overlay disposal is best-effort.
      } finally {
        this.layout = undefined;
        this.sidebar = undefined;
      }
      try {
        this.widgetContext?.ui.setWidget(BOOTSTRAP_WIDGET_KEY, undefined);
      } catch {
        // Widget cleanup must not retain the context on failure.
      } finally {
        this.widgetContext = undefined;
      }
    });
    return this.closePromise;
  }

  private createBootstrap(tui: TUI, theme: unknown): Component & { dispose(): void } {
    this.layout?.dispose();
    const sidebar = new NoteSidebar(tui, theme, () => {});
    sidebar.setNote(this.note);
    const layout = installOverlayLayout(tui, sidebar, {
      enabled: this.preferences.enabled,
      panelWidth: this.preferences.width,
      panelHeight: this.preferences.height,
      onUnavailable: () => this.warnUnavailableVisualLayout(),
    });
    this.sidebar = sidebar;
    this.layout = layout;
    return {
      render: () => [],
      invalidate: () => {},
      dispose: () => {
        if (this.layout === layout) {
          layout.dispose();
          this.layout = undefined;
          this.sidebar = undefined;
        }
      },
    };
  }

  private warnUnavailableVisualLayout(): void {
    if (this.warnedAboutVisualLayout) {
      return;
    }
    this.warnedAboutVisualLayout = true;
    const message = "Note panel overlay is unavailable in this TUI; commands and tools still work.";
    this.widgetContext?.ui.notify(message, "warning");
  }

  private async refreshInternal(): Promise<void> {
    if (this.closing || this.disposed) {
      return;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await this.readSignature();
      const content = await this.readNote();
      const after = await this.readSignature();
      if (before === after) {
        this.note = content;
        this.noteSignature = after;
        this.sidebar?.setNote(this.note);
        this.layout?.requestRender();
        return;
      }
    }
    this.scheduleRefresh();
  }

  private async readNoteSignature(): Promise<string | null> {
    try {
      const metadata = await stat(this.store.notePath);
      if (!metadata.isFile()) {
        return null;
      }
      return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private ensureWatcher(): void {
    if (this.closing || this.disposed) {
      return;
    }
    if (existsSync(this.store.piDir)) {
      this.projectWatcher?.close();
      this.projectWatcher = undefined;
      if (this.piWatcher === undefined) {
        this.piWatcher = this.openWatcher(this.store.piDir, () => {
          if (!existsSync(this.store.piDir)) {
            this.piWatcher?.close();
            this.piWatcher = undefined;
            this.ensureWatcher();
            return;
          }
          this.scheduleRefresh();
        });
      }
      return;
    }
    this.piWatcher?.close();
    this.piWatcher = undefined;
    if (this.projectWatcher === undefined) {
      this.projectWatcher = this.openWatcher(this.store.projectRoot, () => {
        this.ensureWatcher();
        this.scheduleRefresh();
      });
    }
  }

  private openWatcher(path: string, onChange: () => void): FSWatcher | undefined {
    try {
      const watcher = this.watchPath(path, { persistent: false }, onChange);
      watcher.on("error", () => {
        watcher.close();
        if (this.projectWatcher === watcher) this.projectWatcher = undefined;
        if (this.piWatcher === watcher) this.piWatcher = undefined;
        this.ensureWatcher();
      });
      return watcher;
    } catch {
      return undefined;
    }
  }

  private scheduleRefresh(): void {
    if (this.closing || this.disposed) {
      return;
    }
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.enqueue(async () => {
        this.ensureWatcher();
        const signature = await this.readSignature();
        if (signature !== this.noteSignature) {
          await this.refreshInternal();
        }
      }).catch(() => {});
    }, WATCH_DEBOUNCE_MS);
  }

  private metrics(): PanelMetrics {
    if (this.sidebar !== undefined) {
      return this.sidebar.getMetrics();
    }
    const rawMetrics = rawNoteMetrics(this.note);
    return {
      uiAvailable: false,
      visible: false,
      hiddenReason: "ui-unavailable",
      terminal: null,
      panel: {
        configuredWidth: this.preferences.width,
        configuredHeight: this.preferences.height,
        outerWidth: null,
        outerHeight: null,
        contentWidth: null,
        contentRows: null,
        scrollOffset: 0,
      },
      note: {
        bytes: rawMetrics.bytes,
        sourceLines: rawMetrics.sourceLines,
        wrappedLines: null,
        visibleWrappedLines: null,
        hiddenWrappedLines: null,
      },
      format: {
        markdown: "plain",
        supportsHeadings: true,
        supportsLists: true,
        supportsCheckboxes: true,
        supportsTables: false,
      },
    };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    try {
      this.assertOpen();
    } catch (error) {
      return Promise.reject(error);
    }
    const run = async (): Promise<T> => {
      this.assertOpen();
      return operation();
    };
    const next = this.queue.then(run, run);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private assertOpen(): void {
    if (this.closing || this.disposed) {
      throw new Error("Note panel is closing.");
    }
  }
}

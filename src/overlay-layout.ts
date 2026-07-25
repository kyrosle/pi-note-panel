import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";

import { NoteSidebar, type SidebarLayoutState } from "./sidebar.ts";
import {
  MIN_PANEL_HEIGHT,
  MIN_PANEL_WIDTH,
  type HiddenReason,
  type NonNullHiddenReason,
  type TerminalDimensions,
} from "./types.ts";

interface CompatibleTui {
  terminal: { columns: number; rows: number };
  showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
  requestRender(force?: boolean): void;
}

export interface OverlayLayoutHandle {
  focus(): void;
  setEnabled(enabled: boolean): void;
  setPanelSize(width: number, height: number): void;
  requestRender(): void;
  getDimensions(): TerminalDimensions | null;
  getHiddenReason(): HiddenReason;
  dispose(): void;
}

export function installOverlayLayout(
  tui: TUI,
  sidebar: NoteSidebar,
  options: { enabled: boolean; panelWidth: number; panelHeight: number; onUnavailable?: () => void },
): OverlayLayoutHandle {
  const candidate = tui as unknown;
  if (!isCompatibleTui(candidate)) {
    safely(() => options.onUnavailable?.(), undefined);
    return unavailableHandle(candidate, sidebar, options, "unsupported-tui");
  }

  let enabled = options.enabled;
  let panelWidth = options.panelWidth;
  let panelHeight = options.panelHeight;
  let overlay: OverlayHandle | undefined;
  let overlayOptions: OverlayOptions | undefined;
  let visualAvailable = true;
  let disposed = false;
  let focused = false;
  let unavailableReported = false;
  let focusReleaseGeneration = 0;
  let focusReleaseScheduled = false;
  let focusReleaseApplied = false;

  const dimensions = (): TerminalDimensions | null => readDimensions(candidate);
  const rendered = (current = dimensions()): { width: number; height: number } | null => current === null
    ? null
    : { width: Math.min(panelWidth, current.columns), height: Math.min(panelHeight, current.rows) };
  const hiddenReason = (current = dimensions()): HiddenReason => {
    if (!enabled) return "disabled";
    if (!visualAvailable) return "unsupported-tui";
    if (current === null) return "ui-unavailable";
    return current.columns < MIN_PANEL_WIDTH || current.rows < MIN_PANEL_HEIGHT ? "narrow-terminal" : null;
  };
  const releaseFocus = (): void => {
    const overlayFocused = safely(() => overlay?.isFocused() ?? false, false);
    sidebar.setFocused(false);
    focused = false;
    if (overlayFocused) safely(() => overlay?.unfocus(), undefined);
  };
  const releaseFocusOrPendingRestore = (): void => {
    sidebar.setFocused(false);
    focused = false;
    safely(() => overlay?.unfocus(), undefined);
  };
  const cancelScheduledFocusRelease = (): void => {
    focusReleaseGeneration += 1;
    focusReleaseScheduled = false;
  };
  const scheduleFocusRelease = (current: TerminalDimensions | null): void => {
    if (
      disposed
      || !enabled
      || hiddenReason(current) !== "narrow-terminal"
      || focusReleaseScheduled
      || focusReleaseApplied
      || overlay === undefined
    ) {
      return;
    }
    focusReleaseScheduled = true;
    const generation = focusReleaseGeneration;
    queueMicrotask(() => {
      focusReleaseScheduled = false;
      if (
        disposed
        || generation !== focusReleaseGeneration
        || !enabled
        || hiddenReason() !== "narrow-terminal"
        || overlay === undefined
      ) {
        return;
      }
      focusReleaseApplied = true;
      releaseFocusOrPendingRestore();
    });
  };
  const updateSidebar = (current = dimensions(), requestRender = false): HiddenReason => {
    const reason = hiddenReason(current);
    const size = rendered(current);
    const state: SidebarLayoutState = {
      terminal: current,
      configuredWidth: panelWidth,
      configuredHeight: panelHeight,
      outerWidth: size?.width ?? null,
      outerHeight: size?.height ?? null,
      visibility: reason === null ? { visible: true, hiddenReason: null } : { visible: false, hiddenReason: reason },
    };
    sidebar.setLayoutState(state, requestRender);
    if (reason !== "narrow-terminal") focusReleaseApplied = false;
    scheduleFocusRelease(current);
    return reason;
  };
  const createOverlay = (): { handle: OverlayHandle; options: OverlayOptions } => {
    const size = rendered();
    if (size === null) throw new Error("Terminal dimensions unavailable");
    const nextOverlayOptions: OverlayOptions = {
      anchor: "right-center",
      width: size.width,
      maxHeight: size.height,
      nonCapturing: true,
      visible: (columns, rows) => {
        if (disposed) return false;
        const current = { columns, rows };
        const currentSize = rendered(current);
        if (currentSize !== null) {
          nextOverlayOptions.width = currentSize.width;
          nextOverlayOptions.maxHeight = currentSize.height;
        }
        return updateSidebar(current) === null;
      },
    };
    return { handle: candidate.showOverlay(sidebar, nextOverlayOptions), options: nextOverlayOptions };
  };
  const reportUnavailable = (): void => {
    if (unavailableReported) return;
    unavailableReported = true;
    safely(() => options.onUnavailable?.(), undefined);
  };
  const replaceOverlay = (): boolean => {
    if (!visualAvailable || disposed) return false;
    let next: { handle: OverlayHandle; options: OverlayOptions };
    try {
      next = createOverlay();
    } catch {
      visualAvailable = false;
      cancelScheduledFocusRelease();
      releaseFocus();
      safely(() => overlay?.hide(), undefined);
      updateSidebar();
      reportUnavailable();
      return false;
    }
    safely(() => overlay?.hide(), undefined);
    overlay = next.handle;
    overlayOptions = next.options;
    if (!enabled) safely(() => next.handle.setHidden(true), undefined);
    return true;
  };

  if (!replaceOverlay()) {
    return unavailableHandle(candidate, sidebar, options, "unsupported-tui");
  }
  sidebar.setEscapeHandler(() => {
    releaseFocus();
    safely(() => candidate.requestRender(), undefined);
  });
  updateSidebar();

  return {
    focus(): void {
      if (disposed || updateSidebar() !== null || overlay === undefined) return;
      const previousOverlay = overlay;
      if (!safely(() => previousOverlay.isFocused(), false) && !replaceOverlay()) return;
      const activeOverlay = overlay;
      if (activeOverlay === undefined) return;
      if (safely(() => activeOverlay.isFocused(), false)) return;
      sidebar.setFocused(true);
      focused = true;
      try {
        focusReleaseApplied = false;
        activeOverlay.focus();
      } catch {
        focused = false;
        sidebar.setFocused(false);
      }
      safely(() => candidate.requestRender(), undefined);
    },
    setEnabled(nextEnabled: boolean): void {
      if (disposed || enabled === nextEnabled) return;
      enabled = nextEnabled;
      if (enabled) {
        replaceOverlay();
      } else {
        cancelScheduledFocusRelease();
        releaseFocus();
        safely(() => overlay?.setHidden(true), undefined);
      }
      updateSidebar();
      safely(() => candidate.requestRender(), undefined);
    },
    setPanelSize(width: number, height: number): void {
      if (disposed || (panelWidth === width && panelHeight === height)) return;
      panelWidth = width;
      panelHeight = height;
      const size = rendered();
      if (size !== null && overlayOptions !== undefined) {
        overlayOptions.width = size.width;
        overlayOptions.maxHeight = size.height;
      }
      updateSidebar();
      safely(() => candidate.requestRender(), undefined);
    },
    requestRender(): void {
      if (disposed) return;
      if (focused && !safely(() => overlay?.isFocused() ?? false, false)) {
        focused = false;
        sidebar.setFocused(false);
      }
      updateSidebar();
      safely(() => candidate.requestRender(), undefined);
    },
    getDimensions: () => cloneDimensions(dimensions()),
    getHiddenReason: () => hiddenReason(),
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelScheduledFocusRelease();
      safely(() => sidebar.setEscapeHandler(undefined), undefined);
      safely(() => overlay?.setHidden(true), undefined);
      releaseFocus();
      safely(() => overlay?.hide(), undefined);
      overlay = undefined;
      overlayOptions = undefined;
      safely(() => candidate.requestRender(), undefined);
    },
  };
}

function unavailableHandle(value: unknown, sidebar: NoteSidebar, options: { enabled: boolean; panelWidth: number; panelHeight: number; onUnavailable?: () => void }, unavailableReason: NonNullHiddenReason): OverlayLayoutHandle {
  let enabled = options.enabled;
  let panelWidth = options.panelWidth;
  let panelHeight = options.panelHeight;
  const reason = (): NonNullHiddenReason => enabled ? unavailableReason : "disabled";
  const refresh = (requestRender: boolean): TerminalDimensions | null => {
    const terminal = extractTerminalDimensions(value);
    const size = terminal === null ? null : { width: Math.min(panelWidth, terminal.columns), height: Math.min(panelHeight, terminal.rows) };
    sidebar.setLayoutState({
      terminal,
      configuredWidth: panelWidth,
      configuredHeight: panelHeight,
      outerWidth: size?.width ?? null,
      outerHeight: size?.height ?? null,
      visibility: { visible: false, hiddenReason: reason() },
    }, requestRender && hasRequestRender(value));
    return terminal;
  };
  refresh(false);
  return {
    focus() {},
    setEnabled(nextEnabled: boolean) { enabled = nextEnabled; refresh(true); },
    setPanelSize(width: number, height: number) { panelWidth = width; panelHeight = height; refresh(true); },
    requestRender() { refresh(true); },
    getDimensions: () => cloneDimensions(refresh(false)),
    getHiddenReason: () => reason(),
    dispose() {},
  };
}

function isCompatibleTui(value: unknown): value is CompatibleTui {
  return typeof value === "object" && value !== null
    && typeof (value as Partial<CompatibleTui>).showOverlay === "function"
    && typeof (value as Partial<CompatibleTui>).requestRender === "function"
    && readDimensions(value as CompatibleTui) !== null;
}

function hasRequestRender(value: unknown): boolean { return typeof (value as { requestRender?: unknown } | null)?.requestRender === "function"; }
function readDimensions(tui: CompatibleTui): TerminalDimensions | null { return extractTerminalDimensions(tui); }
function extractTerminalDimensions(value: unknown): TerminalDimensions | null {
  const terminal = (value as { terminal?: unknown } | null)?.terminal;
  if (typeof terminal !== "object" || terminal === null) return null;
  const { columns, rows } = terminal as { columns?: unknown; rows?: unknown };
  return typeof columns === "number" && typeof rows === "number" && Number.isInteger(columns) && Number.isInteger(rows) && columns >= 0 && rows >= 0 ? { columns, rows } : null;
}
function cloneDimensions(dimensions: TerminalDimensions | null): TerminalDimensions | null { return dimensions === null ? null : { ...dimensions }; }
function safely<T>(action: () => T, fallback: T): T { try { return action(); } catch { return fallback; } }

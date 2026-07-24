import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";

import { shouldShowPanel } from "./layout.ts";
import { NoteSidebar, type SidebarLayoutState } from "./sidebar.ts";
import type { HiddenReason, NonNullHiddenReason, TerminalDimensions, VisibilityState } from "./types.ts";

const ADAPTER_OWNER = Symbol.for("pi-note-panel.split-layout.owner");
const INITIAL_ROOT_RENDER = Symbol.for("pi-note-panel.split-layout.initial-root-render");
const WRAPPER_OWNER = Symbol.for("pi-note-panel.split-layout.wrapper-owner");
const WRAPPER_ORIGINAL = Symbol.for("pi-note-panel.split-layout.wrapper-original");
const WRAPPER_RETIRED = Symbol.for("pi-note-panel.split-layout.wrapper-retired");
const OWNER_ID = "pi-note-panel.split-layout";

type Render = (width: number) => string[];
type DimensionsReader = () => TerminalDimensions | null;

interface CompatibleTui {
  terminal: { columns: number; rows: number };
  render: Render;
  showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
  requestRender(force?: boolean): void;
}

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
): SplitLayoutHandle {
  const candidate = tui as unknown;
  const dimensionsReader = (): TerminalDimensions | null => extractTerminalDimensions(candidate);
  const canRequestRender = hasRequestRender(candidate);
  if (!isCompatibleTui(candidate)) {
    return unavailableHandle("unsupported-tui", dimensionsReader, sidebar, canRequestRender);
  }

  const compatible = candidate;
  if (!recoverRetiredWrapper(compatible) || hasLayoutConflict(compatible)) {
    return unavailableHandle("layout-conflict", () => readDimensions(compatible), sidebar, true);
  }

  let enabled = options.enabled;
  let panelWidth = options.panelWidth;
  let disposed = false;
  const originalRender = compatible.render;
  let overlay: OverlayHandle;

  const getDimensions = (): TerminalDimensions | null => readDimensions(compatible);
  const hiddenReason = (dimensions = getDimensions()): HiddenReason => {
    if (!enabled) {
      return "disabled";
    }
    if (dimensions === null) {
      return "ui-unavailable";
    }
    return shouldShowPanel(dimensions.columns, panelWidth, dimensions.rows) ? null : "narrow-terminal";
  };
  const releaseFocus = (): void => {
    const overlayFocused = isOverlayFocused(overlay);
    sidebar.setFocused(false);
    if (overlayFocused) {
      overlay.unfocus();
    }
  };
  const updateSidebar = (dimensions = getDimensions()): HiddenReason => {
    const reason = hiddenReason(dimensions);
    if (reason !== null) {
      releaseFocus();
    }
    sidebar.setLayoutState(layoutState(dimensions, panelWidth, reason));
    return reason;
  };

  const wrapper: Render = function renderWithReservedSidebar(width: number): string[] {
    if (disposed) {
      return originalRender.call(compatible, width);
    }
    const reason = updateSidebar();
    return originalRender.call(compatible, reason === null ? width - panelWidth - 1 : width);
  };
  setWrapperMetadata(wrapper, originalRender);
  const createOverlay = (): OverlayHandle => compatible.showOverlay(sidebar, {
    anchor: "top-right",
    width: panelWidth,
    maxHeight: "100%",
    nonCapturing: true,
    visible: (width, height) => updateSidebar({ columns: width, rows: height }) === null,
  });
  const rebuildOverlay = (): boolean => {
    let nextOverlay: OverlayHandle;
    try {
      nextOverlay = createOverlay();
    } catch {
      return false;
    }
    overlay.hide();
    overlay = nextOverlay;
    return true;
  };

  try {
    overlay = createOverlay();
  } catch {
    return unavailableHandle("unsupported-tui", getDimensions, sidebar, true);
  }

  try {
    setSharedProperty(compatible, INITIAL_ROOT_RENDER, originalRender);
    setSharedProperty(compatible, ADAPTER_OWNER, wrapper);
    compatible.render = wrapper;
  } catch {
    ignoreFailure(() => overlay.hide());
    ignoreFailure(() => clearSharedProperty(compatible, ADAPTER_OWNER, wrapper));
    ignoreFailure(() => clearSharedProperty(compatible, INITIAL_ROOT_RENDER, originalRender));
    return unavailableHandle("unsupported-tui", getDimensions, sidebar, true);
  }

  sidebar.setEscapeHandler(() => {
    releaseFocus();
    sidebar.setFocused(false);
    compatible.requestRender();
  });
  updateSidebar();

  return {
    focus(): void {
      if (disposed || updateSidebar() !== null) {
        return;
      }
      if (!isOverlayFocused(overlay) && !rebuildOverlay()) {
        return;
      }
      sidebar.setFocused(true);
      overlay.focus();
      compatible.requestRender();
    },
    setEnabled(nextEnabled: boolean): void {
      if (disposed || enabled === nextEnabled) {
        return;
      }
      enabled = nextEnabled;
      overlay.setHidden(!enabled);
      updateSidebar();
      compatible.requestRender();
    },
    setPanelWidth(nextPanelWidth: number): void {
      if (disposed || panelWidth === nextPanelWidth) {
        return;
      }
      const previousPanelWidth = panelWidth;
      panelWidth = nextPanelWidth;
      if (!rebuildOverlay()) {
        panelWidth = previousPanelWidth;
        return;
      }
      updateSidebar();
      compatible.requestRender();
    },
    requestRender(): void {
      if (disposed) {
        return;
      }
      updateSidebar();
      compatible.requestRender();
    },
    getDimensions,
    getHiddenReason(): HiddenReason {
      return hiddenReason();
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        ignoreFailure(() => sidebar.setEscapeHandler(undefined));
        ignoreFailure(releaseFocus);
        ignoreFailure(() => sidebar.setFocused(false));
        ignoreFailure(() => overlay.hide());
      } finally {
        let restored = false;
        if (compatible.render === wrapper) {
          try {
            compatible.render = originalRender;
            restored = true;
          } catch {
            restored = false;
          }
        }
        if (!restored) {
          ignoreFailure(() => setFunctionProperty(wrapper, WRAPPER_RETIRED, true));
        }
        ignoreFailure(() => clearSharedProperty(compatible, ADAPTER_OWNER, wrapper));
        ignoreFailure(() => clearSharedProperty(compatible, INITIAL_ROOT_RENDER, originalRender));
        ignoreFailure(() => compatible.requestRender());
      }
    },
  };
}

function ignoreFailure(action: () => void): void {
  try {
    action();
  } catch {
    // Disposal is best-effort: restoring the render ownership takes priority.
  }
}

function isCompatibleTui(value: unknown): value is CompatibleTui {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const tui = value as Partial<CompatibleTui>;
  return typeof tui.render === "function"
    && typeof tui.showOverlay === "function"
    && typeof tui.requestRender === "function"
    && readDimensions(tui as CompatibleTui) !== null;
}

function hasRequestRender(value: unknown): boolean {
  return typeof (value as { requestRender?: unknown } | null)?.requestRender === "function";
}

function recoverRetiredWrapper(tui: CompatibleTui): boolean {
  const wrapper = tui.render;
  if (!isRetiredOwnedWrapper(wrapper)) {
    return true;
  }
  const original = getFunctionProperty(wrapper, WRAPPER_ORIGINAL);
  if (typeof original !== "function") {
    return false;
  }
  try {
    tui.render = original as Render;
    clearSharedProperty(tui, ADAPTER_OWNER, wrapper);
    clearSharedProperty(tui, INITIAL_ROOT_RENDER, original);
    return true;
  } catch {
    return false;
  }
}

function hasLayoutConflict(tui: CompatibleTui): boolean {
  if (getSharedProperty(tui, ADAPTER_OWNER) !== undefined) {
    return true;
  }
  const initialRender = getSharedProperty(tui, INITIAL_ROOT_RENDER);
  if (initialRender !== undefined) {
    return initialRender !== tui.render;
  }
  const inheritedRender = findInheritedRender(tui);
  return inheritedRender !== undefined && inheritedRender !== tui.render;
}

function findInheritedRender(tui: CompatibleTui): Render | undefined {
  let prototype: object | null = Object.getPrototypeOf(tui);
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "render");
    if (typeof descriptor?.value === "function") {
      return descriptor.value as Render;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return undefined;
}

function layoutState(
  dimensions: TerminalDimensions | null,
  panelWidth: number,
  hiddenReason: HiddenReason,
): SidebarLayoutState {
  const visibility: VisibilityState = hiddenReason === null
    ? { visible: true, hiddenReason: null }
    : { visible: false, hiddenReason };
  return {
    terminal: dimensions,
    outerWidth: dimensions !== null && (hiddenReason === null || hiddenReason === "disabled" || hiddenReason === "narrow-terminal")
      ? panelWidth
      : null,
    visibility,
  };
}

function setUnavailableSidebarState(
  sidebar: NoteSidebar,
  dimensions: TerminalDimensions | null,
  reason: NonNullHiddenReason,
  requestRender: boolean,
): void {
  sidebar.setLayoutState({
    terminal: dimensions,
    outerWidth: null,
    visibility: { visible: false, hiddenReason: reason },
  }, requestRender);
}

function unavailableHandle(
  reason: NonNullHiddenReason,
  dimensionsReader: DimensionsReader,
  sidebar: NoteSidebar,
  canRequestRender: boolean,
): SplitLayoutHandle {
  const refresh = (requestRender: boolean): TerminalDimensions | null => {
    const dimensions = dimensionsReader();
    setUnavailableSidebarState(sidebar, dimensions, reason, requestRender && canRequestRender);
    return dimensions;
  };
  refresh(false);
  return {
    focus() {},
    setEnabled() {},
    setPanelWidth() {},
    requestRender() { refresh(true); },
    getDimensions: () => cloneDimensions(refresh(false)),
    getHiddenReason: () => reason,
    dispose() {},
  };
}

function readDimensions(tui: CompatibleTui): TerminalDimensions | null {
  return extractTerminalDimensions(tui);
}

function extractTerminalDimensions(value: unknown): TerminalDimensions | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const terminal = (value as { terminal?: unknown }).terminal;
  if (terminal === null || typeof terminal !== "object") {
    return null;
  }
  const { columns, rows } = terminal as { columns?: unknown; rows?: unknown };
  if (
    typeof columns !== "number"
    || typeof rows !== "number"
    || !Number.isInteger(columns)
    || !Number.isInteger(rows)
    || columns < 0
    || rows < 0
  ) {
    return null;
  }
  return { columns, rows };
}

function cloneDimensions(dimensions: TerminalDimensions | null): TerminalDimensions | null {
  return dimensions === null ? null : { ...dimensions };
}

function isOverlayFocused(overlay: OverlayHandle): boolean {
  try {
    return overlay.isFocused();
  } catch {
    return false;
  }
}

function setWrapperMetadata(wrapper: Render, original: Render): void {
  setFunctionProperty(wrapper, WRAPPER_OWNER, OWNER_ID);
  setFunctionProperty(wrapper, WRAPPER_ORIGINAL, original);
  setFunctionProperty(wrapper, WRAPPER_RETIRED, false);
}

function isRetiredOwnedWrapper(render: Render): boolean {
  return getFunctionProperty(render, WRAPPER_OWNER) === OWNER_ID
    && getFunctionProperty(render, WRAPPER_RETIRED) === true;
}

function getFunctionProperty(render: Render, key: symbol): unknown {
  return (render as unknown as Record<PropertyKey, unknown>)[key];
}

function setFunctionProperty(render: Render, key: symbol, value: unknown): void {
  Object.defineProperty(render, key, { configurable: true, value });
}

function getSharedProperty(target: object, key: symbol): unknown {
  return (target as Record<PropertyKey, unknown>)[key];
}

function setSharedProperty(target: object, key: symbol, value: unknown): void {
  Object.defineProperty(target, key, { configurable: true, value });
}

function clearSharedProperty(target: object, key: symbol, value: unknown): void {
  if (getSharedProperty(target, key) === value) {
    delete (target as Record<PropertyKey, unknown>)[key];
  }
}

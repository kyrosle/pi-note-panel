export const DEFAULT_PANEL_WIDTH = 36;
export const DEFAULT_PANEL_HEIGHT = 20;
export const MIN_PANEL_WIDTH = 20;
export const MAX_PANEL_WIDTH = 160;
export const MIN_PANEL_HEIGHT = 8;
export const MAX_PANEL_HEIGHT = 120;
export const NOTE_LIMIT_BYTES = 256 * 1024;

export interface PanelPreferences {
  enabled: boolean;
  width: number;
  height: number;
}

export interface TerminalDimensions {
  columns: number;
  rows: number;
}

export type NonNullHiddenReason =
  | "disabled"
  | "narrow-terminal"
  | "ui-unavailable"
  | "unsupported-tui";

export type HiddenReason = NonNullHiddenReason | null;

export type VisibilityState =
  | {
      visible: true;
      hiddenReason: null;
    }
  | {
      visible: false;
      hiddenReason: NonNullHiddenReason;
    };

interface PanelMetricsBase {
  uiAvailable: boolean;
  terminal: TerminalDimensions | null;
  panel: {
    configuredWidth: number;
    configuredHeight: number;
    outerWidth: number | null;
    outerHeight: number | null;
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
}

export type PanelMetrics = PanelMetricsBase & VisibilityState;

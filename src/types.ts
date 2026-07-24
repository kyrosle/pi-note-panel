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
}

export type PanelMetrics = PanelMetricsBase & VisibilityState;

import { sliceByColumn, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const PANEL_CHROME_ROWS = 6;

export function wrapMarkdownLines(lines: string[], width: number): string[] {
  if (!Number.isFinite(width) || !Number.isInteger(width) || width <= 0) {
    throw new RangeError("Width must be a positive finite integer");
  }
  if (lines.length === 0) {
    return [];
  }

  return cleanWrappedLines(wrapTextWithAnsi(lines.join("\n"), width), width);
}

function cleanWrappedLines(wrappedLines: string[], width: number): string[] {
  return wrappedLines
    .filter((wrappedLine, index) => {
      const nextLine = wrappedLines[index + 1];
      return visibleWidth(wrappedLine) > 0 || nextLine === undefined || visibleWidth(nextLine) <= width;
    })
    .map((wrappedLine) => {
      if (visibleWidth(wrappedLine) <= width) {
        return wrappedLine;
      }

      const sliced = sliceByColumn(wrappedLine, 0, width, true);
      return visibleWidth(sliced) === 0 ? wrappedLine : sliced;
    });
}

export function sliceViewport(
  lines: string[],
  rows: number,
  requestedOffset: number,
): { lines: string[]; offset: number; hidden: number } {
  const visibleRows = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
  const maximumOffset = Math.max(0, lines.length - visibleRows);
  const offset = requestedOffset === Number.POSITIVE_INFINITY
    ? maximumOffset
    : Math.min(maximumOffset, Math.max(0, Number.isFinite(requestedOffset) ? Math.floor(requestedOffset) : 0));
  const viewportLines = lines.slice(offset, offset + visibleRows);

  return {
    lines: viewportLines,
    offset,
    hidden: lines.length - viewportLines.length,
  };
}

export function calculateContentRows(terminalRows: number): number {
  if (!Number.isFinite(terminalRows)) {
    return 0;
  }

  return Math.max(0, Math.floor(terminalRows) - PANEL_CHROME_ROWS);
}

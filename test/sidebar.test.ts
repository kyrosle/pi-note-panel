import assert from "node:assert/strict";
import test from "node:test";

import { NoteSidebar } from "../src/sidebar.ts";
import { wrapMarkdownLines } from "../src/layout.ts";
import { sanitizeNoteMarkdown } from "../src/sanitize.ts";
import { NOTE_LIMIT_BYTES } from "../src/types.ts";

function createSidebar(note = ""): { sidebar: NoteSidebar; renders: () => number; escapes: () => number } {
  let renderCount = 0;
  let escapeCount = 0;
  const sidebar = new NoteSidebar(
    { requestRender: () => { renderCount += 1; } } as never,
    undefined,
    () => { escapeCount += 1; },
  );
  sidebar.setTerminal({ columns: 40, rows: 8 });
  sidebar.setNote(note);
  sidebar.render(12);
  return { sidebar, renders: () => renderCount, escapes: () => escapeCount };
}

test("scroll keys move by line or viewport and escape releases focus", () => {
  const { sidebar, renders, escapes } = createSidebar("1\n2\n3\n4\n5\n6");
  sidebar.setFocused(true);

  sidebar.handleInput("\u001B[B");
  assert.equal(sidebar.getMetrics().panel.scrollOffset, 1);
  sidebar.handleInput("\u001B[6~");
  assert.equal(sidebar.getMetrics().panel.scrollOffset, 3);
  sidebar.handleInput("\u001B[5~");
  assert.equal(sidebar.getMetrics().panel.scrollOffset, 1);
  sidebar.handleInput("\u001B[F");
  assert.equal(sidebar.getMetrics().panel.scrollOffset, 4);
  sidebar.handleInput("\u001B[H");
  assert.equal(sidebar.getMetrics().panel.scrollOffset, 0);
  sidebar.handleInput("\u001B[A");
  assert.equal(sidebar.getMetrics().panel.scrollOffset, 0);
  sidebar.handleInput("\u001B");
  assert.equal(escapes(), 1);
  assert.ok(renders() >= 7);
});

test("non-focused input does not change scroll state", () => {
  const { sidebar } = createSidebar("1\n2\n3\n4\n5");

  sidebar.handleInput("\u001B[B");
  sidebar.handleInput("\u001B[F");

  assert.equal(sidebar.getMetrics().panel.scrollOffset, 0);
});

test("resize and content changes clamp the in-memory scroll position", () => {
  const { sidebar } = createSidebar("1\n2\n3\n4\n5\n6");
  sidebar.setFocused(true);
  sidebar.handleInput("\u001B[F");
  assert.equal(sidebar.getMetrics().panel.scrollOffset, 4);

  sidebar.setTerminal({ columns: 40, rows: 10 });
  assert.equal(sidebar.getMetrics().panel.scrollOffset, 2);
  sidebar.setNote("short");
  assert.equal(sidebar.getMetrics().panel.scrollOffset, 0);
});

test("reports UTF-8 source, wrapped, visible, and hidden note metrics", () => {
  const { sidebar } = createSidebar("中文测试\nabcdef");
  sidebar.render(10);

  assert.deepEqual(sidebar.getMetrics(), {
    uiAvailable: true,
    visible: true,
    hiddenReason: null,
    terminal: { columns: 40, rows: 8 },
    panel: { configuredWidth: 36, configuredHeight: 20, outerWidth: 10, outerHeight: 8, contentWidth: 6, contentRows: 2, scrollOffset: 0 },
    note: {
      bytes: Buffer.byteLength("中文测试\nabcdef", "utf8"),
      sourceLines: 2,
      wrappedLines: 3,
      visibleWrappedLines: 2,
      hiddenWrappedLines: 1,
    },
    format: {
      markdown: "plain",
      supportsHeadings: true,
      supportsLists: true,
      supportsCheckboxes: true,
      supportsTables: false,
    },
  });
});

test("renders an empty-state hint and compact range footer for overflow", () => {
  const empty = createSidebar("").sidebar.render(28);
  assert.ok(empty.some((line) => line.includes("No project notes yet.")));
  assert.ok(empty.some((line) => line.includes("Empty")));

  const { sidebar } = createSidebar("1\n2\n3\n4\n5");
  const rendered = sidebar.render(12);
  assert.equal(rendered.length, 8);
  assert.ok(rendered.some((line) => line.includes("1-2/5")));
  assert.ok(rendered.some((line) => line.includes("↓")));
});

test("sanitizes terminal controls while preserving ordinary Markdown text, newlines, and tabs", () => {
  const note = "safe\ttext\nstart\u001B]52;c;secret\u0007mid\u001B[2Jend\u001B_payload\u001B\\done";
  const { sidebar } = createSidebar(note);
  const rendered = sidebar.render(28).join("\n");

  assert.ok(rendered.includes("safe\ttext"));
  assert.ok(rendered.includes("startmidenddone"));
  assert.equal(rendered.includes("\u001B"), false);
  assert.equal(sidebar.getMetrics().note.bytes, Buffer.byteLength(note, "utf8"));
});

test("string controls stop at C1 ST, CAN, or SUB and preserve following Markdown", () => {
  const note = "start\u001B]0;title\u009CafterOsc\u001BPdrop\u0018afterDcs\u001B_drop\u001AafterApc";
  const rendered = createSidebar(note).sidebar.render(36).join("\n");

  assert.ok(rendered.includes("startafterOscafterDcsafterApc"));
  assert.equal(rendered.includes("title"), false);
  assert.equal(rendered.includes("drop"), false);
});

test("ESC and C1 CSI stop at CAN or SUB without consuming following Markdown", () => {
  const note = "start\u001B[31\u0018afterEscCsi\u009B31\u001AafterC1Csi";
  const rendered = createSidebar(note).sidebar.render(36).join("\n");

  assert.ok(rendered.includes("startafterEscCsiafterC1Csi"));
  assert.equal(rendered.includes("31"), false);
});

test("strips C0 and every supported ESC or C1 terminal control family", () => {
  const note = "before\u0000c0\u001B[2J\u009B31m\u001B]0;osc\u0007\u009D52;c;c1osc\u009C\u001BPdcs\u001B\\\u0090c1dcs\u009C\u001B_apc\u001B\\\u009F c1apc\u009C\u001B^pm\u001B\\\u009E c1pm\u009C\u001BXsos\u001B\\\u0098c1sos\u009Cafter";

  assert.equal(sanitizeNoteMarkdown(note), "beforec0after");
});

test("reuses cached wrapping for a 256 KiB note until note or width changes", () => {
  let wrapCalls = 0;
  const sidebar = new NoteSidebar(
    { requestRender() {} } as never,
    undefined,
    () => {},
    {
      wrapMarkdownLines: (lines, width) => {
        wrapCalls += 1;
        return wrapMarkdownLines(lines, width);
      },
    },
  );
  sidebar.setTerminal({ columns: 140, rows: 40 });
  sidebar.setNote("x".repeat(NOTE_LIMIT_BYTES));

  sidebar.render(36);
  sidebar.getMetrics();
  sidebar.render(36);
  sidebar.getMetrics();
  assert.equal(wrapCalls, 1);

  sidebar.render(40);
  assert.equal(wrapCalls, 2);
});

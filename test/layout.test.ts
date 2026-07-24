import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
  calculateContentRows,
  shouldShowPanel,
  sliceViewport,
  wrapMarkdownLines,
} from "../src/layout.ts";

test("wraps ASCII text and long continuous text by terminal display width", () => {
  assert.deepEqual(wrapMarkdownLines(["one two", "abcdef"], 4), ["one", "two", "abcd", "ef"]);
});

test("wraps CJK by terminal display width", () => {
  assert.deepEqual(wrapMarkdownLines(["中文测试"], 4), ["中文", "测试"]);
});

test("preserves ANSI styling while wrapping", () => {
  const wrapped = wrapMarkdownLines(["\u001B[31mredtext\u001B[0m"], 4);

  assert.deepEqual(wrapped, ["\u001B[31mredt", "\u001B[31mext\u001B[0m"]);
  assert.ok(wrapped.every((line) => visibleWidth(line) <= 4));
});

test("reopens SGR styling across source lines", () => {
  assert.deepEqual(
    wrapMarkdownLines(["\u001B[31mred", "text\u001B[0m"], 10),
    ["\u001B[31mred", "\u001B[31mtext\u001B[0m"],
  );
});

test("reopens OSC 8 hyperlinks across source lines", () => {
  const open = "\u001B]8;;https://example.test\u001B\\";
  const close = "\u001B]8;;\u001B\\";

  assert.deepEqual(
    wrapMarkdownLines([`${open}link`, `more${close}`], 10),
    [`${open}link`, `${open}more${close}`],
  );
});

test("wraps emoji without splitting graphemes", () => {
  const wrapped = wrapMarkdownLines(["🙂🙂🙂"], 4);

  assert.deepEqual(wrapped, ["🙂🙂", "🙂"]);
  assert.ok(wrapped.every((line) => visibleWidth(line) <= 4));
});

test("keeps real grapheme clusters intact at narrow widths", () => {
  const family = "👨‍👩‍👧‍👦";
  const flag = "🇨🇳";

  assert.deepEqual(wrapMarkdownLines([`${family}${family}`], 1), [family, family]);
  assert.deepEqual(wrapMarkdownLines(["e\u0301e\u0301"], 1), ["e\u0301", "e\u0301"]);
  assert.deepEqual(wrapMarkdownLines([`${flag}${flag}`], 1), [flag, flag]);
});

test("preserves empty source lines", () => {
  assert.deepEqual(wrapMarkdownLines(["first", "", "last"], 10), ["first", "", "last"]);
});

test("preserves an empty source list", () => {
  assert.deepEqual(wrapMarkdownLines([], 10), []);
});

test("supports very narrow positive widths", () => {
  assert.deepEqual(wrapMarkdownLines(["abc"], 1), ["a", "b", "c"]);
});

test("keeps over-wide CJK and emoji graphemes intact at width one", () => {
  const cjk = wrapMarkdownLines(["中文测试"], 1);
  const emoji = wrapMarkdownLines(["🙂🙂"], 1);

  assert.deepEqual(cjk, ["中", "文", "测", "试"]);
  assert.deepEqual(emoji, ["🙂", "🙂"]);
  assert.ok([...cjk, ...emoji].every((line) => line.length > 0));
});

test("rejects every non-finite, non-positive, and non-integer wrapping width", () => {
  for (const width of [Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
    assert.throws(() => wrapMarkdownLines(["text"], width), /width must be a positive finite integer/i);
  }
});

test("starts a viewport at the requested top offset", () => {
  assert.deepEqual(sliceViewport(["1", "2", "3", "4"], 2, 0), {
    lines: ["1", "2"],
    offset: 0,
    hidden: 2,
  });
});

test("returns the middle viewport and total hidden lines", () => {
  assert.deepEqual(sliceViewport(["1", "2", "3", "4", "5"], 2, 2), {
    lines: ["3", "4"],
    offset: 2,
    hidden: 3,
  });
});

test("end viewport exposes the final wrapped lines", () => {
  const view = sliceViewport(["1", "2", "3", "4"], 2, Number.POSITIVE_INFINITY);

  assert.deepEqual(view, { lines: ["3", "4"], offset: 2, hidden: 2 });
});

test("clamps a viewport offset after resize", () => {
  assert.deepEqual(sliceViewport(["1", "2", "3", "4", "5"], 4, 3), {
    lines: ["2", "3", "4", "5"],
    offset: 1,
    hidden: 1,
  });
});

test("handles empty content and zero viewport rows", () => {
  assert.deepEqual(sliceViewport([], 3, 0), { lines: [], offset: 0, hidden: 0 });
  assert.deepEqual(sliceViewport(["1", "2"], 0, Number.POSITIVE_INFINITY), { lines: [], offset: 2, hidden: 2 });
});

test("fails closed for non-finite viewport rows", () => {
  for (const rows of [Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(sliceViewport(["1", "2"], rows, Number.POSITIVE_INFINITY), {
      lines: [],
      offset: 2,
      hidden: 2,
    });
  }
});

test("shows the panel only at the main-width threshold", () => {
  assert.equal(shouldShowPanel(96, 36), false);
  assert.equal(shouldShowPanel(97, 36), true);
});

test("calculates useful rows after the fixed panel chrome", () => {
  assert.equal(calculateContentRows(42), 36);
  assert.equal(calculateContentRows(6), 0);
  assert.equal(calculateContentRows(2), 0);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NotePanelController } from "../src/controller.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve: () => resolve?.() };
}

function context(cwd: string, options: { mode?: "tui" | "print" | "json" | "rpc"; hasUI?: boolean; editorResult?: string | undefined } = {}) {
  const notices: string[] = [];
  let factory: ((...args: unknown[]) => unknown) | undefined;
  const mode = options.mode ?? "print";
  return {
    cwd,
    mode,
    hasUI: options.hasUI ?? (mode === "tui" || mode === "rpc"),
    ui: {
      notify(message: string) { notices.push(message); },
      setWidget(_key: string, next: ((...args: unknown[]) => unknown) | undefined) { factory = next; },
      async editor() { return options.editorResult; },
    },
    notices,
    factory: () => factory,
  };
}

async function withProject(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-note-panel-controller-"));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
}

async function waitForWatch(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 180));
}

test("controllers are cwd-isolated and cancelled edits never write", async () => {
  const one = await mkdtemp(join(tmpdir(), "pi-note-panel-controller-"));
  const two = await mkdtemp(join(tmpdir(), "pi-note-panel-controller-"));
  try {
    const first = await NotePanelController.create(context(one) as never);
    const second = await NotePanelController.create(context(two) as never);
    await first.append("one");
    assert.equal((await first.read()).content, "one\n");
    assert.equal((await second.read()).content, "");
    await first.edit(context(one) as never);
    assert.equal((await first.read()).content, "one\n");
    await first.dispose();
    await second.dispose();
  } finally {
    await rm(one, { force: true, recursive: true });
    await rm(two, { force: true, recursive: true });
  }
});

test("note and preference read-modify-writes share the controller queue", async () => {
  await withProject(async (cwd) => {
    const controller = await NotePanelController.create(context(cwd) as never);
    await Promise.all([
      controller.append("# Status"),
      controller.updateSection({ heading: "Status", content: "Ready", mode: "replace" }),
      controller.setEnabled(false),
      controller.setWidth(40),
    ]);
    assert.equal((await controller.read()).content, "# Status\nReady\n");
    assert.deepEqual(JSON.parse(await readFile(join(cwd, ".pi", "note-panel.json"), "utf8")), { enabled: false, width: 40 });
    await controller.dispose();
  });
});

test("malformed preferences notify through the controller context once", async () => {
  await withProject(async (cwd) => {
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi", "note-panel.json"), "{", "utf8");
    const ctx = context(cwd);
    const controller = await NotePanelController.create(ctx as never);
    assert.equal(ctx.notices.length, 1);
    await controller.info();
    assert.equal(ctx.notices.length, 1);
    await controller.dispose();
  });
});

test("metadata changes during a refresh retry the note read once", async () => {
  await withProject(async (cwd) => {
    const signatures = ["base", "base", "before", "changed", "changed", "changed"];
    const notes = ["initial", "stale", "fresh"];
    const controller = await NotePanelController.create(context(cwd) as never, {
      readSignature: async () => signatures.shift() ?? "changed",
      readNote: async () => notes.shift() ?? "fresh",
    });
    await controller.refresh();
    assert.equal((await controller.info()).note.bytes, Buffer.byteLength("fresh"));
    await controller.dispose();
  });
});

test("headless reads sanitize body text while keeping raw note metadata", async () => {
  await withProject(async (cwd) => {
    const raw = "line\r\n\u009D52;c;clipboard\u009Cvisible";
    const controller = await NotePanelController.create(context(cwd) as never, {
      readSignature: async () => "stable",
      readNote: async () => raw,
    });

    const result = await controller.read();
    assert.equal(result.content, "line\nvisible");
    assert.equal(result.metrics.note.bytes, Buffer.byteLength(raw, "utf8"));
    assert.equal(result.metrics.note.sourceLines, 2);
    await controller.dispose();
  });
});

test("disabled and narrow TUI states retain capacity metrics through width changes and writes", async () => {
  await withProject(async (cwd) => {
    const ctx = context(cwd, { mode: "tui" });
    const controller = await NotePanelController.create(ctx as never);
    const factory = ctx.factory();
    const tui = {
      terminal: { columns: 96, rows: 8 }, render: (_width: number) => [], requestRender() {},
      showOverlay() {
        return {
          hide() {}, setHidden() {}, isHidden() { return false; },
          focus() {}, unfocus() {}, isFocused() { return false; },
        };
      },
    };
    factory?.(tui, undefined);

    let metrics = await controller.info();
    assert.equal(metrics.hiddenReason, "narrow-terminal");
    assert.deepEqual(metrics.panel, { outerWidth: 36, contentWidth: 32, contentRows: 2, scrollOffset: 0 });

    await controller.setWidth(40);
    metrics = await controller.info();
    assert.equal(metrics.hiddenReason, "narrow-terminal");
    assert.deepEqual(metrics.panel, { outerWidth: 40, contentWidth: 36, contentRows: 2, scrollOffset: 0 });

    await controller.setEnabled(false);
    metrics = await controller.info();
    assert.equal(metrics.hiddenReason, "disabled");
    assert.deepEqual(metrics.panel, { outerWidth: 40, contentWidth: 36, contentRows: 2, scrollOffset: 0 });

    await controller.replace("fits");
    metrics = await controller.info();
    assert.equal(metrics.note.visibleWrappedLines, 0);
    assert.equal(metrics.note.hiddenWrappedLines, metrics.note.wrappedLines);
    assert.ok((metrics.note.wrappedLines ?? Number.POSITIVE_INFINITY) <= (metrics.panel.contentRows ?? 0));
    await controller.dispose();
  });
});

test("root watch follows first .pi creation, uses trailing debounce, and stops after dispose", async () => {
  await withProject(async (cwd) => {
    const controller = await NotePanelController.create(context(cwd) as never);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi", "NOTE.md"), "first\n", "utf8");
    await waitForWatch();
    assert.equal((await controller.info()).note.bytes, Buffer.byteLength("first\n"));

    await writeFile(join(cwd, ".pi", "NOTE.md"), "middle\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 35));
    await writeFile(join(cwd, ".pi", "NOTE.md"), "final\n", "utf8");
    await waitForWatch();
    assert.equal((await controller.info()).note.bytes, Buffer.byteLength("final\n"));

    await controller.dispose();
    await writeFile(join(cwd, ".pi", "NOTE.md"), "after-dispose\n", "utf8");
    await waitForWatch();
    assert.equal((await controller.info()).note.bytes, Buffer.byteLength("final\n"));
  });
});

test("RPC edit uses available UI without attaching a TUI component", async () => {
  await withProject(async (cwd) => {
    const ctx = context(cwd, { mode: "rpc", hasUI: true, editorResult: "edited" });
    const controller = await NotePanelController.create(ctx as never);
    await controller.edit(ctx as never);
    assert.equal((await controller.read()).content, "edited");
    assert.equal(ctx.factory(), undefined);
    await controller.dispose();
  });
});

test("unsupported visual layout warns once while leaving commands and tools usable", async () => {
  await withProject(async (cwd) => {
    const ctx = context(cwd, { mode: "tui" });
    const controller = await NotePanelController.create(ctx as never);
    const factory = ctx.factory();
    assert.ok(factory);
    const unsupported = { terminal: { columns: 140, rows: 40 }, render() { return []; }, requestRender() {} };
    factory?.(unsupported, undefined);
    factory?.(unsupported, undefined);
    assert.equal(ctx.notices.filter((message) => message.includes("sidebar is unavailable")).length, 1);
    await controller.dispose();
  });
});

test("double metadata races retain the old note, then commit after a stable retry", async () => {
  await withProject(async (cwd) => {
    const signatures = ["base", "base", "one", "two", "three", "four", "stable", "stable"];
    const notes = ["initial", "stale-one", "stale-two", "fresh"];
    const controller = await NotePanelController.create(context(cwd) as never, {
      readSignature: async () => signatures.shift() ?? "stable",
      readNote: async () => notes.shift() ?? "fresh",
    });
    await controller.refresh();
    assert.equal((await controller.info()).note.bytes, Buffer.byteLength("initial"));
    await waitForWatch();
    assert.equal((await controller.info()).note.bytes, Buffer.byteLength("fresh"));
    await controller.dispose();
  });
});

test("dispose rejects new and queued writes after the active operation completes", async () => {
  await withProject(async (cwd) => {
    const started = deferred();
    const release = deferred();
    let blockReads = false;
    const controller = await NotePanelController.create(context(cwd) as never, {
      readSignature: async () => "stable",
      readNote: async () => {
        if (blockReads) {
          started.resolve();
          await release.promise;
        }
        return "stable";
      },
    });
    blockReads = true;
    const active = controller.refresh();
    await started.promise;
    const queued = controller.append("queued");
    const closing = controller.dispose();
    await assert.rejects(() => controller.append("new"), /Note panel is closing/);
    release.resolve();
    await active;
    await assert.rejects(() => queued, /Note panel is closing/);
    await closing;
    await assert.rejects(() => controller.refresh(), /Note panel is closing/);
  });
});

test("create cleans up its watcher when attach fails and can be retried", async () => {
  await withProject(async (cwd) => {
    let closes = 0;
    const watcher = { close() { closes += 1; }, on() { return watcher; } };
    const failing = context(cwd, { mode: "tui" });
    const widgetCalls: unknown[] = [];
    failing.ui.setWidget = (_key, widget) => {
      widgetCalls.push(widget);
      if (widget !== undefined) throw new Error("widget failed");
    };
    await assert.rejects(
      () => NotePanelController.create(failing as never, { watchPath: (() => watcher) as never }),
      /widget failed/,
    );
    assert.equal(closes, 1);
    assert.deepEqual(widgetCalls.map((widget) => widget === undefined), [false, true]);
    const rebuilt = await NotePanelController.create(context(cwd) as never);
    await rebuilt.dispose();
  });
});

test("controller dispose clears all references even when widget and layout cleanup throw", async () => {
  await withProject(async (cwd) => {
    const ctx = context(cwd, { mode: "tui" });
    let factory: ((...args: unknown[]) => unknown) | undefined;
    let cleanupCalls = 0;
    ctx.ui.setWidget = (_key, widget) => {
      if (widget === undefined) {
        cleanupCalls += 1;
        throw new Error("widget cleanup failed");
      }
      factory = widget;
    };
    const controller = await NotePanelController.create(ctx as never);
    const tui = {
      terminal: { columns: 140, rows: 40 }, render: (_width: number) => [], requestRender() {},
      showOverlay() {
        return {
          hide() { throw new Error("hide failed"); }, setHidden() {}, isHidden() { return false; },
          focus() {}, unfocus() {}, isFocused() { return false; },
        };
      },
    };
    factory?.(tui, undefined);
    await assert.doesNotReject(controller.dispose());
    await controller.dispose();
    assert.equal(cleanupCalls, 1);
  });
});

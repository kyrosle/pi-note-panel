import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerNotePanelExtension } from "../src/extension.ts";
import { NotePanelController } from "../src/controller.ts";
import { FileSystemPathError } from "../src/note-store.ts";
import { SectionInputError, UnclosedFenceError } from "../src/sections.ts";
import type { PanelMetrics } from "../src/types.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve: () => resolve?.() };
}

interface RegisteredTool {
  name: string;
  description: string;
  parameters: { type?: string; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
}

function metrics(): PanelMetrics {
  return {
    uiAvailable: false, visible: false, hiddenReason: "ui-unavailable", terminal: null,
    panel: { outerWidth: null, contentWidth: null, contentRows: null, scrollOffset: 0 },
    note: { bytes: 0, sourceLines: 0, wrappedLines: null, visibleWrappedLines: null, hiddenWrappedLines: null },
    format: { markdown: "plain", supportsHeadings: true, supportsLists: true, supportsCheckboxes: true, supportsTables: false },
  };
}

function fakeContext(cwd: string, mode: "tui" | "print" | "json" | "rpc" = "print", editorResult: string | undefined = undefined) {
  const notices: Array<{ message: string; type: string | undefined }> = [];
  let widgetFactory: ((...args: unknown[]) => unknown) | undefined;
  return {
    cwd, mode, hasUI: mode === "tui" || mode === "rpc",
    ui: {
      notify(message: string, type?: string) { notices.push({ message, type }); },
      setWidget(_key: string, factory: ((...args: unknown[]) => unknown) | undefined) { widgetFactory = factory; },
      async editor() { return editorResult; },
    },
    notices,
    widgetFactory: () => widgetFactory,
  };
}

function fakeApi() {
  const commands = new Map<string, { handler: (args: string, ctx: ReturnType<typeof fakeContext>) => Promise<void> }>();
  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, (event: unknown, ctx: ReturnType<typeof fakeContext>) => Promise<void>>();
  return {
    commands, tools, handlers,
    on(event: string, handler: (event: unknown, ctx: ReturnType<typeof fakeContext>) => Promise<void>) { handlers.set(event, handler); },
    registerCommand(name: string, command: { handler: (args: string, ctx: ReturnType<typeof fakeContext>) => Promise<void> }) { commands.set(name, command); },
    registerTool(tool: RegisteredTool) { tools.push(tool); },
  };
}

function fakeController(content = "") {
  let note = content;
  let disposed = 0;
  return {
    attach() {}, dispose() { disposed += 1; }, disposed: () => disposed,
    async info() { return metrics(); },
    async refresh() {},
    async read() { return { content: note, metrics: metrics() }; },
    async append(value: string) { note += value; return metrics(); },
    async replace(value: string) { note = value; return metrics(); },
    async updateSection() { return metrics(); },
    async setEnabled(_value: boolean) {}, async setWidth(_value: number) {}, async edit() {}, focus() {},
  };
}

async function withProject(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-note-panel-extension-"));
  try { await run(cwd); } finally { await rm(cwd, { force: true, recursive: true }); }
}

test("registers exact schemas and avoids TUI APIs outside tui mode", async () => {
  await withProject(async (cwd) => {
    const api = fakeApi();
    registerNotePanelExtension(api as never, async () => fakeController() as never);
    assert.deepEqual([...api.commands.keys()], ["note-panel"]);
    assert.deepEqual(api.tools.map((tool) => tool.name), ["note_panel_info", "note_panel_read", "note_panel_append", "note_panel_replace", "note_panel_update_section"]);
    assert.deepEqual(api.tools.map((tool) => tool.parameters.required ?? []), [[], [], ["content"], ["content"], ["heading", "content", "mode"]]);
    assert.ok(api.tools.every((tool) => tool.parameters.additionalProperties === false));
    for (const mode of ["print", "json", "rpc"] as const) {
      const ctx = fakeContext(cwd, mode);
      await api.handlers.get("session_start")?.({}, ctx);
      assert.equal(ctx.widgetFactory(), undefined);
    }
  });
});

test("tools expose complete compact metrics to the model and retain structured details", async () => {
  await withProject(async (cwd) => {
    const api = fakeApi();
    registerNotePanelExtension(api as never, async () => fakeController("# Status\n") as never);
    const ctx = fakeContext(cwd);
    const call = async (name: string, params: unknown) => api.tools.find((tool) => tool.name === name)?.execute("call", params, undefined, undefined, ctx);
    const info = await call("note_panel_info", {});
    const read = await call("note_panel_read", {});
    const write = await call("note_panel_append", { content: "Ready" });
    const section = await call("note_panel_update_section", { heading: "Status", content: "Ready", mode: "replace" });
    const expectedMetrics = JSON.stringify(metrics());
    assert.equal(info?.content[0]?.text, `Panel metrics: ${expectedMetrics}`);
    assert.equal(read?.content[0]?.text, `Project note:\n\n# Status\n\nPanel metrics: ${expectedMetrics}`);
    assert.equal("content" in (read?.details as object), false);
    assert.deepEqual(info?.details, { metrics: metrics() });
    assert.equal(write?.content[0]?.text, `Note updated; panel hidden (ui-unavailable).\nPanel metrics: ${expectedMetrics}`);
    assert.equal(section?.content[0]?.text, `Note updated; panel hidden (ui-unavailable).\nPanel metrics: ${expectedMetrics}`);

    const emptyApi = fakeApi();
    registerNotePanelExtension(emptyApi as never, async () => fakeController() as never);
    const empty = await emptyApi.tools.find((tool) => tool.name === "note_panel_read")?.execute("empty", {}, undefined, undefined, fakeContext(join(cwd, "empty")));
    assert.equal(empty?.content[0]?.text, `Project note is empty.\n\nPanel metrics: ${expectedMetrics}`);
    assert.equal("content" in (empty?.details as object), false);
  });
});

test("note_panel_read strips C1 OSC52, CSI, and APC from tool text", async () => {
  await withProject(async (cwd) => {
    const api = fakeApi();
    const raw = "safe\u009D52;c;clipboard\u009Cafter-osc\u009B31mafter-csi\u009Fapc\u009Cafter-apc";
    registerNotePanelExtension(api as never, async () => fakeController(raw) as never);

    const read = await api.tools.find((tool) => tool.name === "note_panel_read")?.execute(
      "read",
      {},
      undefined,
      undefined,
      fakeContext(cwd),
    );

    assert.equal(read?.content[0]?.text, `Project note:\n\nsafeafter-oscafter-csiafter-apc\n\nPanel metrics: ${JSON.stringify(metrics())}`);
  });
});

test("cold concurrent tool calls share one controller promise and failed creation is evicted", async () => {
  await withProject(async (cwd) => {
    const api = fakeApi();
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    registerNotePanelExtension(api as never, async () => {
      calls += 1;
      await gate;
      return fakeController() as never;
    });
    const info = api.tools.find((tool) => tool.name === "note_panel_info");
    const ctx = fakeContext(cwd);
    const first = info?.execute("one", {}, undefined, undefined, ctx);
    const second = info?.execute("two", {}, undefined, undefined, ctx);
    assert.equal(calls, 1);
    release?.();
    await Promise.all([first, second]);

    const retryApi = fakeApi();
    let attempts = 0;
    registerNotePanelExtension(retryApi as never, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("create failed at /tmp/private-note.tmp");
      return fakeController() as never;
    });
    const retry = retryApi.tools.find((tool) => tool.name === "note_panel_info");
    assert.ok(retry);
    await assert.rejects(
      () => retry.execute("one", {}, undefined, undefined, ctx),
      (error: unknown) => error instanceof Error
        && error.message === "Note panel operation failed."
        && !error.message.includes("/tmp"),
    );
    await retry?.execute("two", {}, undefined, undefined, ctx);
    assert.equal(attempts, 2);
  });
});

test("tools preserve safe domain errors and redact unsafe filesystem details", async () => {
  await withProject(async (cwd) => {
    const api = fakeApi();
    registerNotePanelExtension(api as never);
    const append = api.tools.find((tool) => tool.name === "note_panel_append");
    assert.ok(append);
    await assert.rejects(
      () => append.execute("limit", { content: "x".repeat(256 * 1024 + 1) }, undefined, undefined, fakeContext(cwd)),
      (error: unknown) => error instanceof Error && error.message === "Note content exceeds the 256 KiB limit",
    );

    const outside = await mkdtemp(join(tmpdir(), "pi-note-panel-outside-"));
    try {
      await symlink(outside, join(cwd, ".pi"));
      const unsafe = fakeApi();
      registerNotePanelExtension(unsafe as never);
      const unsafeAppend = unsafe.tools.find((tool) => tool.name === "note_panel_append");
      assert.ok(unsafeAppend);
      await assert.rejects(
        () => unsafeAppend.execute("unsafe", { content: "x" }, undefined, undefined, fakeContext(cwd)),
        (error: unknown) => error instanceof Error
          && error.message === "Unsafe note storage path: .pi is a symlink"
          && !error.message.includes(cwd)
          && !error.message.includes(outside),
      );
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

test("tools preserve fixed path and section input errors while unknown failures stay generic", async () => {
  await withProject(async (cwd) => {
    const permissionApi = fakeApi();
    const permissionCause = Object.assign(new Error("denied"), { code: "EACCES" });
    registerNotePanelExtension(
      permissionApi as never,
      async () => ({ ...fakeController(), async append() { throw new FileSystemPathError("write", ".pi/NOTE.md", permissionCause); } }) as never,
    );
    const permissionAppend = permissionApi.tools.find((tool) => tool.name === "note_panel_append");
    assert.ok(permissionAppend);
    await assert.rejects(
      () => permissionAppend.execute("permission", { content: "x" }, undefined, undefined, fakeContext(cwd)),
      (error: unknown) => error instanceof Error && error.message === "Unable to write .pi/NOTE.md (EACCES)",
    );

    const sectionApi = fakeApi();
    registerNotePanelExtension(
      sectionApi as never,
      async () => ({ ...fakeController(), async updateSection() { throw new SectionInputError("Heading must not be empty"); } }) as never,
    );
    const section = sectionApi.tools.find((tool) => tool.name === "note_panel_update_section");
    assert.ok(section);
    await assert.rejects(
      () => section.execute("section", { heading: "x", content: "", mode: "replace" }, undefined, undefined, fakeContext(cwd)),
      (error: unknown) => error instanceof Error && error.message === "Heading must not be empty",
    );

    const unclosedFenceApi = fakeApi();
    registerNotePanelExtension(
      unclosedFenceApi as never,
      async () => ({ ...fakeController(), async updateSection() { throw new UnclosedFenceError(); } }) as never,
    );
    const unclosedFence = unclosedFenceApi.tools.find((tool) => tool.name === "note_panel_update_section");
    assert.ok(unclosedFence);
    await assert.rejects(
      () => unclosedFence.execute("unclosed-fence", { heading: "x", content: "", mode: "replace" }, undefined, undefined, fakeContext(cwd)),
      (error: unknown) => error instanceof Error && error.message === "Cannot create section while a fenced code block is unclosed.",
    );
  });
});

test("session shutdown disposes only its cwd controller and permits later recreation", async () => {
  await withProject(async (cwd) => {
    const other = await mkdtemp(join(tmpdir(), "pi-note-panel-extension-other-"));
    try {
      const api = fakeApi();
      const created: ReturnType<typeof fakeController>[] = [];
      registerNotePanelExtension(api as never, async () => {
        const controller = fakeController();
        created.push(controller);
        return controller as never;
      });
      const first = fakeContext(cwd);
      const second = fakeContext(other);
      await api.handlers.get("session_start")?.({}, first);
      await api.handlers.get("session_start")?.({}, second);
      await api.handlers.get("session_shutdown")?.({}, first);
      assert.equal(created[0]?.disposed(), 1);
      assert.equal(created[1]?.disposed(), 0);
      await api.tools.find((tool) => tool.name === "note_panel_info")?.execute("two", {}, undefined, undefined, second);
      assert.equal(created.length, 2);
      await api.tools.find((tool) => tool.name === "note_panel_info")?.execute("one", {}, undefined, undefined, first);
      assert.equal(created.length, 3);
    } finally {
      await rm(other, { force: true, recursive: true });
    }
  });
});

test("session shutdown closes a running controller before a racing tool write can start", async () => {
  await withProject(async (cwd) => {
    const started = deferred();
    const release = deferred();
    let blockReads = false;
    const ctx = fakeContext(cwd);
    const controller = await NotePanelController.create(ctx as never, {
      readSignature: async () => "stable",
      readNote: async () => {
        if (blockReads) {
          started.resolve();
          await release.promise;
        }
        return "stable";
      },
    });
    const api = fakeApi();
    registerNotePanelExtension(api as never, async () => controller);
    await api.handlers.get("session_start")?.({}, ctx);
    blockReads = true;
    const active = controller.refresh();
    await started.promise;
    const shutdown = api.handlers.get("session_shutdown")?.({}, ctx);
    const append = api.tools.find((tool) => tool.name === "note_panel_append");
    assert.ok(append);
    await assert.rejects(
      () => append.execute("race", { content: "nope" }, undefined, undefined, ctx),
      (error: unknown) => error instanceof Error && error.message === "Note panel operation failed.",
    );
    release.resolve();
    await active;
    await shutdown;
  });
});

test("commands support every branch, RPC edit, and strict invalid arguments", async () => {
  await withProject(async (cwd) => {
    const api = fakeApi();
    const controller = fakeController();
    let editCalls = 0;
    const calls: string[] = [];
    controller.setEnabled = async (value: boolean) => { calls.push(`enabled:${value}`); };
    controller.setWidth = async (value: number) => { calls.push(`width:${value}`); };
    controller.refresh = async () => { calls.push("refresh"); };
    controller.focus = () => { calls.push("focus"); };
    controller.edit = async () => { editCalls += 1; };
    registerNotePanelExtension(api as never, async () => controller as never);
    const command = api.commands.get("note-panel");
    const rpc = fakeContext(cwd, "rpc", "edited");
    for (const args of ["", "on", "off", "width 24", "refresh", "focus"]) {
      await command?.handler(args, rpc);
    }
    await command?.handler("edit", rpc);
    await command?.handler("width 23", rpc);
    await command?.handler("width 24 extra", rpc);
    assert.deepEqual(calls, ["enabled:true", "enabled:false", "width:24", "refresh", "focus"]);
    assert.equal(editCalls, 1);
    assert.ok(rpc.notices.some((notice) => notice.message.startsWith("Usage:")));
  });
});

test("TUI bootstrap redraws after a write and component disposal is safe", async () => {
  await withProject(async (cwd) => {
    const api = fakeApi();
    const ctx = fakeContext(cwd, "tui");
    registerNotePanelExtension(api as never);
    await api.handlers.get("session_start")?.({}, ctx);
    const factory = ctx.widgetFactory();
    assert.ok(factory);
    let renders = 0;
    const tui = {
      terminal: { columns: 140, rows: 40 }, render: (_width: number) => [], requestRender() { renders += 1; },
      showOverlay() { return { hide() {}, setHidden() {}, isHidden() { return false; }, focus() {}, unfocus() {}, isFocused() { return false; } }; },
    };
    const component = factory?.(tui, undefined) as { render(width: number): string[]; dispose(): void };
    assert.deepEqual(component.render(80), []);
    const before = renders;
    await api.tools.find((tool) => tool.name === "note_panel_append")?.execute("write", { content: "visible" }, undefined, undefined, ctx);
    assert.ok(renders > before);
    component.dispose();
  });
});

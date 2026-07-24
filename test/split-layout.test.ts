import assert from "node:assert/strict";
import test from "node:test";

import { NoteSidebar } from "../src/sidebar.ts";
import { installSplitLayout } from "../src/split-layout.ts";

interface FakeOverlay {
  focusCalls: number;
  hideCalls: number;
  unfocusCalls: number;
  setHiddenCalls: boolean[];
}

function fakeTui(columns = 140, rows = 40, showOverlayThrows = false) {
  const overlay: FakeOverlay = { focusCalls: 0, hideCalls: 0, unfocusCalls: 0, setHiddenCalls: [] };
  const renderWidths: number[] = [];
  const originalRender = function (this: unknown, width: number): string[] {
    renderWidths.push(width);
    return [`main:${width}`];
  };
  const tui = {
    terminal: { columns, rows },
    render: originalRender,
    requestRenderCalls: 0,
    showOverlayCalls: 0,
    requestRender() { this.requestRenderCalls += 1; },
    overlayOptions: undefined as Record<string, unknown> | undefined,
    showOverlay(_component: unknown, options: Record<string, unknown>) {
      this.showOverlayCalls += 1;
      if (showOverlayThrows) {
        throw new Error("overlay unavailable");
      }
      this.overlayOptions = options;
      return {
        hide: () => { overlay.hideCalls += 1; },
        setHidden: (hidden: boolean) => { overlay.setHiddenCalls.push(hidden); },
        isHidden: () => false,
        focus: () => { overlay.focusCalls += 1; },
        unfocus: () => { overlay.unfocusCalls += 1; },
        isFocused: () => overlay.focusCalls > overlay.unfocusCalls,
      };
    },
  };
  return { tui, overlay, originalRender, renderWidths };
}

function sidebarFor(tui: object): NoteSidebar {
  return new NoteSidebar(tui as never, undefined, () => {});
}

test("reserves panel width, restores full width when narrow or disabled, and adapts width changes", () => {
  const { tui, renderWidths } = fakeTui();
  const sidebar = sidebarFor(tui);
  const layout = installSplitLayout(tui as never, sidebar, { enabled: true, panelWidth: 36 });
  sidebar.setNote("fits");

  assert.deepEqual(sidebar.getMetrics().panel, {
    outerWidth: 36,
    contentWidth: 32,
    contentRows: 34,
    scrollOffset: 0,
  });
  assert.equal(sidebar.getMetrics().hiddenReason, null);
  assert.deepEqual(tui.overlayOptions, {
    anchor: "top-right",
    width: 36,
    maxHeight: "100%",
    nonCapturing: true,
    visible: tui.overlayOptions?.visible,
  });
  const visible = tui.overlayOptions?.visible as ((width: number, height: number) => boolean);
  assert.equal(visible(140, 40), true);
  assert.equal(visible(96, 40), false);
  assert.equal(sidebar.getMetrics().hiddenReason, "narrow-terminal");
  assert.deepEqual(sidebar.getMetrics().panel, {
    outerWidth: 36,
    contentWidth: 32,
    contentRows: 34,
    scrollOffset: 0,
  });
  assert.deepEqual(sidebar.getMetrics().note, {
    bytes: 4,
    sourceLines: 1,
    wrappedLines: 1,
    visibleWrappedLines: 0,
    hiddenWrappedLines: 1,
  });

  tui.terminal.columns = 140;
  tui.render(140);
  assert.deepEqual(renderWidths, [103]);
  assert.equal(layout.getHiddenReason(), null);

  tui.terminal.columns = 96;
  tui.render(96);
  assert.equal(renderWidths.at(-1), 96);
  assert.equal(layout.getHiddenReason(), "narrow-terminal");

  tui.terminal.columns = 140;
  layout.setEnabled(false);
  tui.render(140);
  assert.equal(renderWidths.at(-1), 140);
  assert.equal(layout.getHiddenReason(), "disabled");
  assert.equal(sidebar.getMetrics().panel.outerWidth, 36);
  assert.equal(sidebar.getMetrics().note.visibleWrappedLines, 0);
  assert.equal(sidebar.getMetrics().note.hiddenWrappedLines, 1);

  layout.setPanelWidth(40);
  assert.deepEqual(sidebar.getMetrics().panel, {
    outerWidth: 40,
    contentWidth: 36,
    contentRows: 34,
    scrollOffset: 0,
  });

  layout.setEnabled(true);
  assert.deepEqual(sidebar.getMetrics().panel, {
    outerWidth: 40,
    contentWidth: 36,
    contentRows: 34,
    scrollOffset: 0,
  });
  assert.equal(tui.overlayOptions?.width, 40);
  assert.equal(tui.showOverlayCalls, 2);
  tui.render(140);
  assert.equal(renderWidths.at(-1), 99);
});

test("a disposed adapter left under a later wrapper no longer reserves width", () => {
  const { tui, originalRender, renderWidths } = fakeTui();
  const layout = installSplitLayout(tui as never, sidebarFor(tui), { enabled: true, panelWidth: 36 });
  const retiredWrapper = tui.render;
  tui.render = function laterExtensionWrapper(width: number): string[] {
    return retiredWrapper.call(this, width);
  };

  layout.dispose();
  tui.render(140);

  assert.equal(tui.render.name, "laterExtensionWrapper");
  assert.equal(renderWidths.at(-1), 140);
  assert.notEqual(tui.render, originalRender);
});

test("dispose restores the exact original function and second install reports a layout conflict", () => {
  const { tui, overlay, originalRender } = fakeTui();
  const first = installSplitLayout(tui as never, sidebarFor(tui), { enabled: true, panelWidth: 36 });
  const wrapper = tui.render;
  const secondSidebar = sidebarFor(tui);
  const showOverlayCalls = tui.showOverlayCalls;
  const requestRenderCalls = tui.requestRenderCalls;
  const second = installSplitLayout(tui as never, secondSidebar, { enabled: true, panelWidth: 36 });

  assert.notEqual(wrapper, originalRender);
  assert.equal(second.getHiddenReason(), "layout-conflict");
  assert.equal(secondSidebar.getMetrics().hiddenReason, "layout-conflict");
  assert.equal(tui.showOverlayCalls, showOverlayCalls);
  assert.equal(tui.requestRenderCalls, requestRenderCalls);
  assert.equal(tui.render, wrapper);
  first.dispose();
  assert.equal(tui.render, originalRender);
  assert.equal(overlay.hideCalls, 1);
});

test("unsupported TUIs do not mutate and overlay setup failures roll render back", () => {
  const unsupported = { render() { return []; } };
  const unsupportedSidebar = sidebarFor(unsupported);
  const unsupportedLayout = installSplitLayout(unsupported as never, unsupportedSidebar, { enabled: true, panelWidth: 36 });
  assert.equal(unsupportedLayout.getHiddenReason(), "unsupported-tui");
  assert.equal(unsupportedLayout.getDimensions(), null);
  assert.equal(unsupportedSidebar.getMetrics().hiddenReason, "unsupported-tui");

  const missingOverlay = {
    terminal: { columns: 140, rows: 40 },
    render: (_width: number) => [],
    requestRender() {},
  };
  const missingOverlaySidebar = sidebarFor(missingOverlay);
  const missingOverlayLayout = installSplitLayout(
    missingOverlay as never,
    missingOverlaySidebar,
    { enabled: true, panelWidth: 36 },
  );
  assert.equal(missingOverlayLayout.getHiddenReason(), "unsupported-tui");
  assert.deepEqual(missingOverlayLayout.getDimensions(), { columns: 140, rows: 40 });
  assert.deepEqual(missingOverlaySidebar.getMetrics().terminal, { columns: 140, rows: 40 });
  assert.equal(missingOverlaySidebar.getMetrics().uiAvailable, true);
  assert.deepEqual(missingOverlaySidebar.getMetrics().panel, {
    outerWidth: null,
    contentWidth: null,
    contentRows: null,
    scrollOffset: 0,
  });
  assert.equal(missingOverlaySidebar.getMetrics().hiddenReason, "unsupported-tui");
  missingOverlay.terminal.columns = 160;
  missingOverlay.terminal.rows = 50;
  missingOverlayLayout.requestRender();
  assert.deepEqual(missingOverlayLayout.getDimensions(), { columns: 160, rows: 50 });
  assert.deepEqual(missingOverlaySidebar.getMetrics().terminal, { columns: 160, rows: 50 });

  const { tui, originalRender } = fakeTui(140, 40, true);
  const failedLayout = installSplitLayout(tui as never, sidebarFor(tui), { enabled: true, panelWidth: 36 });
  assert.equal(failedLayout.getHiddenReason(), "unsupported-tui");
  assert.equal(tui.render, originalRender);
});

test("rows through six hide the panel and rows seven restore it without focusing", () => {
  for (const rows of [0, 6]) {
    const { tui, overlay } = fakeTui(140, rows);
    const layout = installSplitLayout(tui as never, sidebarFor(tui), { enabled: true, panelWidth: 36 });
    assert.equal(layout.getHiddenReason(), "narrow-terminal");
    layout.focus();
    assert.equal(overlay.focusCalls, 0);
  }

  const { tui, overlay } = fakeTui(140, 7);
  const layout = installSplitLayout(tui as never, sidebarFor(tui), { enabled: true, panelWidth: 36 });
  assert.equal(layout.getHiddenReason(), null);
  layout.focus();
  assert.equal(overlay.focusCalls, 1);
});

test("focus rebuilds the non-capturing overlay at entry and resize restores the current focus", () => {
  let currentFocus = "A";
  const overlays: Array<{ preFocus: string; focusCalls: number; hideCalls: number }> = [];
  const tui = {
    terminal: { columns: 140, rows: 40 },
    render: (_width: number) => [],
    requestRender() {},
    showOverlay() {
      const overlay = { preFocus: currentFocus, focusCalls: 0, hideCalls: 0 };
      overlays.push(overlay);
      return {
        hide: () => { overlay.hideCalls += 1; },
        setHidden() {},
        isHidden: () => false,
        focus: () => { overlay.focusCalls += 1; currentFocus = "sidebar"; },
        unfocus: () => { currentFocus = overlay.preFocus; },
        isFocused: () => currentFocus === "sidebar",
      };
    },
  };
  const sidebar = sidebarFor(tui);
  const layout = installSplitLayout(tui as never, sidebar, { enabled: true, panelWidth: 36 });

  currentFocus = "B";
  layout.focus();
  assert.equal(overlays.length, 2);
  layout.focus();
  assert.equal(overlays.length, 2);
  sidebar.handleInput("\u001B");
  assert.equal(currentFocus, "B");

  layout.focus();
  tui.terminal.rows = 6;
  tui.render(140);
  assert.equal(currentFocus, "B");

  tui.terminal.rows = 40;
  currentFocus = "B";
  layout.focus();
  currentFocus = "C";
  layout.focus();
  assert.equal(overlays.length, 5);
  sidebar.handleInput("\u001B");
  assert.equal(currentFocus, "C");
});

test("a retired owned wrapper can be unwrapped after an outer extension restores it", () => {
  const { tui, originalRender } = fakeTui();
  const first = installSplitLayout(tui as never, sidebarFor(tui), { enabled: true, panelWidth: 36 });
  const retiredWrapper = tui.render;
  tui.render = function outer(width: number): string[] { return retiredWrapper.call(this, width); };
  first.dispose();
  const layered = installSplitLayout(tui as never, sidebarFor(tui), { enabled: true, panelWidth: 36 });
  assert.equal(layered.getHiddenReason(), null);
  layered.dispose();
  tui.render = retiredWrapper;

  const second = installSplitLayout(tui as never, sidebarFor(tui), { enabled: true, panelWidth: 36 });
  assert.equal(second.getHiddenReason(), null);
  assert.notEqual(tui.render, retiredWrapper);
  assert.notEqual(tui.render, originalRender);
});

test("an existing prototype-root override and a shared cross-module owner both conflict without touching TUI", () => {
  class PrototypeTui {
    terminal = { columns: 140, rows: 40 };
    requestRenderCalls = 0;
    showOverlayCalls = 0;
    render(width: number): string[] { return [`base:${width}`]; }
    requestRender(): void { this.requestRenderCalls += 1; }
    showOverlay() {
      this.showOverlayCalls += 1;
      throw new Error("must not show");
    }
  }

  const overridden = new PrototypeTui();
  const injectedRender = function injectedRender(width: number): string[] { return [`other:${width}`]; };
  overridden.render = injectedRender;
  const overrideSidebar = sidebarFor(overridden);
  const overrideLayout = installSplitLayout(overridden as never, overrideSidebar, { enabled: true, panelWidth: 36 });
  assert.equal(overrideLayout.getHiddenReason(), "layout-conflict");
  assert.equal(overridden.render, injectedRender);
  assert.equal(overridden.showOverlayCalls, 0);
  assert.equal(overridden.requestRenderCalls, 0);
  assert.equal(overrideSidebar.getMetrics().hiddenReason, "layout-conflict");

  const { tui } = fakeTui();
  Object.defineProperty(tui, Symbol.for("pi-note-panel.split-layout.owner"), { value: { module: "other-copy" } });
  const ownerSidebar = sidebarFor(tui);
  const ownerLayout = installSplitLayout(tui as never, ownerSidebar, { enabled: true, panelWidth: 36 });
  assert.equal(ownerLayout.getHiddenReason(), "layout-conflict");
  assert.equal(tui.showOverlayCalls, 0);
  assert.equal(tui.requestRenderCalls, 0);
  assert.equal(ownerSidebar.getMetrics().hiddenReason, "layout-conflict");
});

test("focus and unfocus requests are forwarded without changing non-capturing overlay behavior", () => {
  const { tui, overlay } = fakeTui();
  const sidebar = sidebarFor(tui);
  const layout = installSplitLayout(tui as never, sidebar, { enabled: true, panelWidth: 36 });

  layout.focus();
  assert.equal(overlay.focusCalls, 1);
  assert.ok(tui.requestRenderCalls > 0);
  sidebar.handleInput("\u001B");
  assert.equal(overlay.unfocusCalls, 1);
  layout.dispose();
  assert.equal(overlay.hideCalls, 2);
});

test("dispose restores layout ownership even when overlay or render cleanup throws", () => {
  for (const failure of ["unfocus", "hide", "requestRender"] as const) {
    let disposing = false;
    let focused = false;
    const originalRender = (_width: number) => [];
    const tui = {
      terminal: { columns: 140, rows: 40 },
      render: originalRender,
      requestRender() {
        if (disposing && failure === "requestRender") throw new Error("render failed");
      },
      showOverlay() {
        return {
          hide() { if (disposing && failure === "hide") throw new Error("hide failed"); },
          setHidden() {},
          isHidden() { return false; },
          focus() { focused = true; },
          unfocus() {
            if (disposing && failure === "unfocus") throw new Error("unfocus failed");
            focused = false;
          },
          isFocused() { return focused; },
        };
      },
    };
    const layout = installSplitLayout(tui as never, sidebarFor(tui), { enabled: true, panelWidth: 36 });
    if (failure === "unfocus") layout.focus();
    disposing = true;
    assert.doesNotThrow(() => layout.dispose());
    disposing = false;
    assert.equal(tui.render, originalRender);
    const reinstalled = installSplitLayout(tui as never, sidebarFor(tui), { enabled: true, panelWidth: 36 });
    assert.equal(reinstalled.getHiddenReason(), null);
    reinstalled.dispose();
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import { installOverlayLayout } from "../src/overlay-layout.ts";
import { NoteSidebar } from "../src/sidebar.ts";

interface FakeOverlay {
  options: Record<string, unknown>;
  hidden: boolean;
  visible: boolean;
  focusCalls: number;
  unfocusCalls: number;
  hideCalls: number;
  setHiddenCalls: boolean[];
  preFocus: string;
  resolvedWidth: unknown;
  resolvedHeight: unknown;
}

interface FakeTuiOptions {
  renderOnUnfocus?: boolean;
  failHide?: boolean;
  failSetHidden?: boolean;
}

function fakeTui(columns = 140, rows = 40, options: FakeTuiOptions = {}) {
  let currentFocus = "A";
  let baseFocus = "A";
  let pendingPanelRestore = false;
  const overlays: FakeOverlay[] = [];
  const tui = {
    terminal: { columns, rows }, requestRenderCalls: 0, renderCalls: 0,
    requestRender() { this.requestRenderCalls += 1; },
    render() {
      this.renderCalls += 1;
      for (const overlay of overlays) {
        if (!overlay.hidden) {
          overlay.visible = (overlay.options.visible as ((width: number, height: number) => boolean) | undefined)?.(this.terminal.columns, this.terminal.rows) ?? true;
          if (overlay.visible) {
            overlay.resolvedWidth = overlay.options.width;
            overlay.resolvedHeight = overlay.options.maxHeight;
          }
        }
      }
      return ["main"];
    },
    hasOverlay() { return overlays.some((overlay) => !overlay.hidden && overlay.visible); },
    showOverlay(_component: unknown, overlayOptions: Record<string, unknown>) {
      const state: FakeOverlay = { options: overlayOptions, hidden: false, visible: true, focusCalls: 0, unfocusCalls: 0, hideCalls: 0, setHiddenCalls: [], preFocus: currentFocus, resolvedWidth: undefined, resolvedHeight: undefined };
      overlays.push(state);
      return {
        hide() {
          state.hideCalls += 1;
          if (options.failHide) throw new Error("hide failed");
          state.hidden = true;
          if (currentFocus === "sidebar") currentFocus = state.preFocus;
        },
        setHidden(hidden: boolean) {
          state.setHiddenCalls.push(hidden);
          if (options.failSetHidden) throw new Error("setHidden failed");
          state.hidden = hidden;
          if (hidden && currentFocus === "sidebar") currentFocus = state.preFocus;
        },
        isHidden() { return state.hidden; },
        focus() { state.focusCalls += 1; currentFocus = "sidebar"; },
        unfocus() {
          state.unfocusCalls += 1;
          if (currentFocus === "dialog") {
            pendingPanelRestore = false;
          } else {
            currentFocus = state.preFocus;
          }
          if (options.renderOnUnfocus) tui.render();
        },
        isFocused() { return currentFocus === "sidebar"; },
      };
    },
  };
  return {
    tui,
    overlays,
    focus: () => currentFocus,
    setFocus: (value: string) => { baseFocus = value; currentFocus = value; },
    openDialog: () => { pendingPanelRestore = currentFocus === "sidebar"; currentFocus = "dialog"; },
    closeDialog: () => { currentFocus = pendingPanelRestore ? "sidebar" : baseFocus; pendingPanelRestore = false; },
  };
}

function sidebarFor(tui: object): NoteSidebar { return new NoteSidebar(tui as never, undefined, () => {}); }

test("uses a passive right-center overlay without changing TUI.render", () => {
  const { tui, overlays } = fakeTui();
  const originalRender = tui.render;
  const layout = installOverlayLayout(tui as never, sidebarFor(tui), { enabled: true, panelWidth: 36, panelHeight: 20 });
  assert.equal(tui.render, originalRender);
  assert.deepEqual(overlays[0]?.options, {
    anchor: "right-center", width: 36, maxHeight: 20, nonCapturing: true, visible: overlays[0]?.options.visible,
  });
  layout.dispose();
  assert.equal(tui.render, originalRender);
});

test("responsive visible callback hides a too-small terminal and restores it through the TUI render path", () => {
  const { tui, overlays } = fakeTui(19, 7);
  const sidebar = sidebarFor(tui);
  const layout = installOverlayLayout(tui as never, sidebar, { enabled: true, panelWidth: 48, panelHeight: 28 });
  tui.render();
  assert.equal(overlays[0]?.hidden, false);
  assert.equal(overlays[0]?.visible, false);
  assert.deepEqual(overlays[0]?.setHiddenCalls, []);
  assert.equal(overlays[0]?.options.width, 19);
  assert.equal(overlays[0]?.options.maxHeight, 7);
  assert.equal(sidebar.getMetrics().hiddenReason, "narrow-terminal");
  tui.terminal.columns = 100;
  tui.terminal.rows = 40;
  tui.render();
  assert.equal(overlays[0]?.visible, true);
  assert.equal(overlays[0]?.options.width, 48);
  assert.equal(overlays[0]?.options.maxHeight, 28);
  assert.equal(overlays[0]?.resolvedWidth, 48);
  assert.equal(overlays[0]?.resolvedHeight, 28);
  assert.equal(sidebar.getMetrics().hiddenReason, null);
  assert.equal(sidebar.getMetrics().panel.outerWidth, 48);
  assert.equal(sidebar.getMetrics().panel.outerHeight, 28);
  assert.equal(layout.getHiddenReason(), null);
  tui.terminal.columns = 32;
  tui.terminal.rows = 12;
  tui.render();
  assert.equal(overlays[0]?.options.width, 32);
  assert.equal(overlays[0]?.options.maxHeight, 12);
  assert.equal(overlays[0]?.resolvedWidth, 32);
  assert.equal(overlays[0]?.resolvedHeight, 12);
  assert.equal(sidebar.getMetrics().panel.outerWidth, 32);
  assert.equal(sidebar.getMetrics().panel.outerHeight, 12);
});

test("clamps dimensions and disabled overlays retain capacity metrics", () => {
  const { tui, overlays } = fakeTui(24, 12);
  const sidebar = sidebarFor(tui);
  const layout = installOverlayLayout(tui as never, sidebar, { enabled: false, panelWidth: 48, panelHeight: 28 });
  assert.deepEqual(sidebar.getMetrics().panel, { configuredWidth: 48, configuredHeight: 28, outerWidth: 24, outerHeight: 12, contentWidth: 20, contentRows: 6, scrollOffset: 0 });
  assert.equal(sidebar.getMetrics().note.visibleWrappedLines, 0);
  assert.deepEqual(overlays[0]?.setHiddenCalls, [true]);
  layout.setEnabled(true);
  assert.deepEqual(overlays[0]?.setHiddenCalls, [true]);
  assert.equal(overlays.length, 2);
});

test("focus rebuild captures the immediately active focus target and Esc restores it", () => {
  const { tui, overlays, focus, setFocus } = fakeTui();
  const sidebar = sidebarFor(tui);
  const layout = installOverlayLayout(tui as never, sidebar, { enabled: true, panelWidth: 36, panelHeight: 20 });
  assert.equal(overlays[0]?.preFocus, "A");
  setFocus("B");
  layout.focus();
  assert.equal(overlays.length, 2);
  assert.equal(overlays[1]?.preFocus, "B");
  assert.equal(focus(), "sidebar");
  sidebar.handleInput("\u001B");
  assert.equal(focus(), "B");
});

test("a focused overlay resized within usable limits keeps its handle and focus", () => {
  const { tui, overlays, focus, setFocus } = fakeTui(140, 40);
  const sidebar = sidebarFor(tui);
  const layout = installOverlayLayout(tui as never, sidebar, { enabled: true, panelWidth: 120, panelHeight: 28 });
  setFocus("B");
  layout.focus();
  assert.equal(overlays.length, 2);
  tui.terminal.columns = 100;
  tui.terminal.rows = 30;
  layout.requestRender();
  assert.equal(overlays.length, 2);
  assert.equal(focus(), "sidebar");
  tui.render();
  assert.equal(overlays.length, 2);
  assert.equal(focus(), "sidebar");
  assert.equal(overlays[1]?.resolvedWidth, 100);
  assert.equal(overlays[1]?.resolvedHeight, 28);
});

test("setPanelSize updates mutable options without rebuilding a focused overlay", () => {
  const { tui, overlays, focus, setFocus } = fakeTui(140, 40);
  const sidebar = sidebarFor(tui);
  const layout = installOverlayLayout(tui as never, sidebar, { enabled: true, panelWidth: 36, panelHeight: 20 });
  setFocus("B");
  layout.focus();
  assert.equal(overlays.length, 2);
  layout.setPanelSize(48, 28);
  assert.equal(overlays.length, 2);
  assert.equal(focus(), "sidebar");
  assert.equal(overlays[1]?.options.width, 48);
  assert.equal(overlays[1]?.options.maxHeight, 28);
});

test("focused narrow resize releases asynchronously without visible-callback recursion", async () => {
  const { tui, overlays, focus, setFocus } = fakeTui(140, 40, { renderOnUnfocus: true });
  const sidebar = sidebarFor(tui);
  const layout = installOverlayLayout(tui as never, sidebar, { enabled: true, panelWidth: 48, panelHeight: 28 });
  setFocus("B");
  layout.focus();
  tui.terminal.columns = 19;
  tui.terminal.rows = 7;
  tui.render();
  assert.equal(focus(), "sidebar");
  assert.equal(overlays.at(-1)?.unfocusCalls, 0);
  await Promise.resolve();
  assert.equal(focus(), "B");
  assert.equal(overlays.at(-1)?.unfocusCalls, 1);
  assert.equal(tui.renderCalls, 2);
});

test("narrow release clears a pending panel restore while another dialog has focus", async () => {
  const { tui, overlays, focus, setFocus, openDialog, closeDialog } = fakeTui(140, 40, { renderOnUnfocus: true });
  const sidebar = sidebarFor(tui);
  const layout = installOverlayLayout(tui as never, sidebar, { enabled: true, panelWidth: 48, panelHeight: 28 });
  setFocus("B");
  layout.focus();
  openDialog();
  tui.terminal.columns = 19;
  tui.terminal.rows = 7;
  tui.render();
  await Promise.resolve();
  assert.equal(overlays.at(-1)?.unfocusCalls, 1);
  assert.equal(focus(), "dialog");
  closeDialog();
  tui.terminal.columns = 100;
  tui.terminal.rows = 40;
  tui.render();
  assert.equal(focus(), "B");
});

test("rebuild failure reports once and leaves commands usable without root-render changes", () => {
  const { tui } = fakeTui();
  const originalRender = tui.render;
  let warnings = 0;
  const layout = installOverlayLayout(tui as never, sidebarFor(tui), {
    enabled: true, panelWidth: 36, panelHeight: 20, onUnavailable: () => { warnings += 1; },
  });
  tui.showOverlay = () => { throw new Error("unavailable"); };
  layout.focus();
  layout.focus();
  assert.equal(warnings, 1);
  assert.equal(layout.getHiddenReason(), "unsupported-tui");
  assert.equal(tui.render, originalRender);
});

test("dispose makes a stale overlay invisible even when setHidden and hide fail", () => {
  const { tui, overlays } = fakeTui(140, 40, { failHide: true, failSetHidden: true });
  const sidebar = sidebarFor(tui);
  const layout = installOverlayLayout(tui as never, sidebar, { enabled: true, panelWidth: 36, panelHeight: 20 });
  assert.doesNotThrow(() => layout.dispose());
  assert.deepEqual(overlays[0]?.setHiddenCalls, [true]);
  tui.render();
  assert.equal(overlays[0]?.visible, false);
  assert.equal(tui.hasOverlay(), false);
});

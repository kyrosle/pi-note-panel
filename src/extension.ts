import { resolve } from "node:path";

import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { NotePanelController } from "./controller.ts";
import { FileSystemPathError, NoteLimitError, PreferencesValidationError, UnsafePathError } from "./note-store.ts";
import { sanitizeNoteMarkdown } from "./sanitize.ts";
import { DuplicateSectionError, SectionInputError, SectionLevelError, type SectionUpdate } from "./sections.ts";
import { MAX_PANEL_WIDTH, MIN_PANEL_WIDTH, type PanelMetrics } from "./types.ts";

const USAGE = "Usage: /note-panel [on|off|width <24-80>|refresh|edit|focus]";
const TOOL_DESCRIPTION = "Call note_panel_info first to plan visible space. Use semantic Markdown, not manual padding. Notes are not automatically injected into context.";

const EmptyParameters = Type.Object({}, { additionalProperties: false });
const ContentParameters = Type.Object({ content: Type.String() }, { additionalProperties: false });
const SectionParameters = Type.Object({
  heading: Type.String({ minLength: 1 }),
  content: Type.String(),
  mode: Type.Union([Type.Literal("replace"), Type.Literal("append")]),
  level: Type.Optional(Type.Integer({ minimum: 1, maximum: 6 })),
}, { additionalProperties: false });

type ToolDetails = { metrics: PanelMetrics };
export type ControllerFactory = (ctx: ExtensionContext) => Promise<NotePanelController>;

export default function notePanelExtension(pi: ExtensionAPI): void {
  registerNotePanelExtension(pi);
}

export function registerNotePanelExtension(pi: ExtensionAPI, createController: ControllerFactory = NotePanelController.create): void {
  const controllers = new Map<string, Promise<NotePanelController>>();

  const controllerFor = (ctx: ExtensionContext): Promise<NotePanelController> => {
    const key = resolve(ctx.cwd);
    const existing = controllers.get(key);
    if (existing !== undefined) {
      return existing.then((controller) => {
        controller.attach(ctx);
        return controller;
      });
    }
    const pending = createController(ctx);
    controllers.set(key, pending);
    return pending.then(
      (controller) => {
        controller.attach(ctx);
        return controller;
      },
      (error: unknown) => {
        if (controllers.get(key) === pending) {
          controllers.delete(key);
        }
        throw error;
      },
    );
  };

  const result = (text: string, details: ToolDetails): AgentToolResult<ToolDetails> => ({
    content: [{ type: "text", text }],
    details,
  });
  const tool = <T>(
    operation: (controller: NotePanelController, parameters: T) => Promise<ToolDetails>,
    summary: (details: ToolDetails) => string,
  ) => async (_id: string, parameters: T, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<AgentToolResult<ToolDetails>> => {
    try {
      const details = await operation(await controllerFor(ctx), parameters);
      return result(summary(details), details);
    } catch (error) {
      throw toolFailure(error);
    }
  };

  pi.registerTool({
    name: "note_panel_info",
    label: "Note panel info",
    description: `${TOOL_DESCRIPTION} Does not read the note body.`,
    parameters: EmptyParameters,
    execute: tool(async (controller) => ({ metrics: await controller.info() }), infoSummary),
  });
  pi.registerTool({
    name: "note_panel_read",
    label: "Read project note",
    description: `${TOOL_DESCRIPTION} Read the project note when its content is needed.`,
    parameters: EmptyParameters,
    execute: async (_id, _parameters, _signal, _onUpdate, ctx) => {
      try {
        const { content, metrics } = await controllerFor(ctx).then((controller) => controller.read());
        return result(readResultText(sanitizeNoteMarkdown(content), metrics), { metrics });
      } catch (error) {
        throw toolFailure(error);
      }
    },
  });
  pi.registerTool({
    name: "note_panel_append",
    label: "Append project note",
    description: `${TOOL_DESCRIPTION} Append Markdown to the project note.`,
    parameters: ContentParameters,
    execute: tool(async (controller, parameters) => ({ metrics: await controller.append(parameters.content) }), writeSummary),
  });
  pi.registerTool({
    name: "note_panel_replace",
    label: "Replace project note",
    description: `${TOOL_DESCRIPTION} Replace the complete project note with Markdown.`,
    parameters: ContentParameters,
    execute: tool(async (controller, parameters) => ({ metrics: await controller.replace(parameters.content) }), writeSummary),
  });
  pi.registerTool({
    name: "note_panel_update_section",
    label: "Update project note section",
    description: `${TOOL_DESCRIPTION} Update an exact Markdown heading section.`,
    parameters: SectionParameters,
    execute: tool(async (controller, parameters) => ({ metrics: await controller.updateSection(parameters as SectionUpdate) }), writeSummary),
  });

  pi.registerCommand("note-panel", {
    description: "Manage the project note panel",
    handler: async (args, ctx) => {
      const command = parseCommand(args);
      if (command === null) {
        ctx.ui.notify(USAGE, "warning");
        return;
      }
      try {
        const controller = await controllerFor(ctx);
        if (command.kind === "status") {
          ctx.ui.notify(`${USAGE}\n${infoSummary({ metrics: await controller.info() })}`, "info");
        } else if (command.kind === "on") {
          await controller.setEnabled(true);
          ctx.ui.notify("Note panel enabled.", "info");
        } else if (command.kind === "off") {
          await controller.setEnabled(false);
          ctx.ui.notify("Note panel disabled.", "info");
        } else if (command.kind === "width") {
          await controller.setWidth(command.width);
          ctx.ui.notify(`Note panel width set to ${command.width}.`, "info");
        } else if (command.kind === "refresh") {
          await controller.refresh();
          ctx.ui.notify("Note panel refreshed.", "info");
        } else if (command.kind === "edit") {
          if (!ctx.hasUI) {
            ctx.ui.notify("Note panel editing requires an available UI.", "warning");
            return;
          }
          await controller.edit(ctx);
        } else {
          controller.focus(ctx);
        }
      } catch (error) {
        ctx.ui.notify(`Note panel: ${conciseError(error)}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const controller = await controllerFor(ctx);
    controller.attach(ctx);
    await controller.refresh();
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const key = resolve(ctx.cwd);
    const pending = controllers.get(key);
    if (pending === undefined) {
      return;
    }
    try {
      await (await pending).dispose();
    } finally {
      if (controllers.get(key) === pending) {
        controllers.delete(key);
      }
    }
  });
}

type NotePanelCommand =
  | { kind: "status" }
  | { kind: "on" }
  | { kind: "off" }
  | { kind: "width"; width: number }
  | { kind: "refresh" }
  | { kind: "edit" }
  | { kind: "focus" };

function parseCommand(args: string): NotePanelCommand | null {
  const parts = args.trim() === "" ? [] : args.trim().split(/\s+/);
  if (parts.length === 0) return { kind: "status" };
  if (parts.length !== 1 && parts[0] !== "width") return null;
  if (parts.length === 1 && (parts[0] === "on" || parts[0] === "off" || parts[0] === "refresh" || parts[0] === "edit" || parts[0] === "focus")) {
    return { kind: parts[0] };
  }
  if (parts.length === 2 && parts[0] === "width" && /^\d+$/.test(parts[1] ?? "")) {
    const width = Number(parts[1]);
    return width >= MIN_PANEL_WIDTH && width <= MAX_PANEL_WIDTH ? { kind: "width", width } : null;
  }
  return null;
}

function infoSummary(details: ToolDetails): string {
  return `Panel metrics: ${metricsText(details.metrics)}`;
}

function readText(content: string): string {
  return content === "" ? "Project note is empty." : `Project note:\n\n${content}`;
}

function readResultText(content: string, metrics: PanelMetrics): string {
  const separator = content === "" || !content.endsWith("\n") ? "\n\n" : "\n";
  return `${readText(content)}${separator}Panel metrics: ${metricsText(metrics)}`;
}

function writeSummary(details: ToolDetails): string {
  const metrics = details.metrics;
  const summary = !metrics.visible
    ? `Note updated; panel hidden (${metrics.hiddenReason}).`
    : metrics.note.hiddenWrappedLines === 0
    ? "Note updated; it fits the visible panel."
    : `Note updated; ${metrics.note.hiddenWrappedLines} wrapped lines are hidden.`;
  return `${summary}\nPanel metrics: ${metricsText(metrics)}`;
}

function metricsText(metrics: PanelMetrics): string {
  return JSON.stringify(metrics);
}

function toolFailure(error: unknown): Error {
  if (
    error instanceof NoteLimitError
    || error instanceof FileSystemPathError
    || error instanceof UnsafePathError
    || error instanceof PreferencesValidationError
    || error instanceof SectionInputError
    || error instanceof SectionLevelError
    || error instanceof DuplicateSectionError
  ) {
    return new Error(error.message);
  }
  return new Error("Note panel operation failed.");
}

function conciseError(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "operation failed";
}

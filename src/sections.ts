export interface SectionUpdate {
  heading: string;
  content: string;
  mode: "replace" | "append";
  level?: number;
}

interface MarkdownHeading {
  level: number;
  title: string;
  start: number;
  bodyStart: number;
}

interface MarkdownParseResult {
  headings: MarkdownHeading[];
  hasUnclosedFence: boolean;
}

export class SectionInputError extends TypeError {}

export class SectionLevelError extends RangeError {
  constructor() {
    super("Level must be an integer from 1 to 6");
  }
}

export class DuplicateSectionError extends Error {
  constructor(heading: string) {
    super(`Multiple matching headings found for "${heading}"`);
  }
}

export class UnclosedFenceError extends SectionInputError {
  constructor() {
    super("Cannot create section while a fenced code block is unclosed.");
  }
}

export function updateSection(markdown: string, update: SectionUpdate): string {
  const heading = validateHeading(update.heading);
  const level = validateLevel(update.level);
  const mode = validateMode(update.mode);
  const content = trimBoundaryNewlines(update.content);
  const parsed = parseHeadings(markdown);
  const matches = parsed.headings.filter((candidate) => candidate.title === heading.comparison);

  if (matches.length > 1) {
    throw new DuplicateSectionError(heading.display);
  }

  const match = matches[0];
  if (match === undefined) {
    if (parsed.hasUnclosedFence) {
      throw new UnclosedFenceError();
    }
    return appendMissingSection(markdown, heading.display, content, level);
  }

  const boundary = parsed.headings.find((candidate) => candidate.start > match.start && candidate.level <= match.level)?.start ?? markdown.length;
  const existingBody = markdown.slice(match.bodyStart, boundary);
  const body = mode === "replace"
    ? replacementBody(content)
    : appendedBody(existingBody, content);
  const prefix = markdown.slice(0, match.bodyStart);
  const separator = body.length > 0 && !prefix.endsWith("\n") ? "\n" : "";

  return `${prefix}${separator}${body}${markdown.slice(boundary)}`;
}

function validateMode(value: string): SectionUpdate["mode"] {
  if (value !== "replace" && value !== "append") {
    throw new SectionInputError('Mode must be "replace" or "append"');
  }
  return value;
}

function validateHeading(value: string): { display: string; comparison: string } {
  if (typeof value !== "string") {
    throw new SectionInputError("Heading must be a string");
  }

  const display = value.trim();
  if (display.length === 0) {
    throw new SectionInputError("Heading must not be empty");
  }

  return { display, comparison: display.toLocaleLowerCase() };
}

function validateLevel(value: number | undefined): number {
  const level = value ?? 2;
  if (!Number.isInteger(level) || level < 1 || level > 6) {
    throw new SectionLevelError();
  }
  return level;
}

function parseHeadings(markdown: string): MarkdownParseResult {
  const headings: MarkdownHeading[] = [];
  let start = 0;
  let fence: { character: "`" | "~"; length: number } | undefined;

  while (start < markdown.length) {
    const newline = markdown.indexOf("\n", start);
    const lineEnd = newline === -1 ? markdown.length : newline;
    const rawLine = markdown.slice(start, lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (fence !== undefined) {
      if (isFenceCloser(line, fence)) {
        fence = undefined;
      }
    } else {
      const opener = parseFenceOpener(line);
      if (opener !== undefined) {
        fence = opener;
      } else {
        const heading = parseAtxHeading(line);
        if (heading !== undefined) {
          headings.push({
            level: heading.level,
            title: heading.title.toLocaleLowerCase(),
            start,
            bodyStart: newline === -1 ? markdown.length : newline + 1,
          });
        }
      }
    }

    if (newline === -1) {
      break;
    }
    start = newline + 1;
  }

  return { headings, hasUnclosedFence: fence !== undefined };
}

function parseAtxHeading(line: string): { level: number; title: string } | undefined {
  let cursor = 0;
  while (cursor < line.length && line[cursor] === " " && cursor < 3) {
    cursor += 1;
  }
  if (line[cursor] === " ") {
    return undefined;
  }

  const markerStart = cursor;
  while (line[cursor] === "#") {
    cursor += 1;
  }
  const level = cursor - markerStart;
  if (level < 1 || level > 6 || (cursor < line.length && line[cursor] !== " " && line[cursor] !== "\t")) {
    return undefined;
  }

  const title = line.slice(cursor).trim();
  return { level, title: title.replace(/[ \t]+#+[ \t]*$/, "") };
}

function parseFenceOpener(line: string): { character: "`" | "~"; length: number } | undefined {
  const match = /^( {0,3})(`+|~+)/.exec(line);
  const marker = match?.[2];
  if (marker === undefined || marker.length < 3) {
    return undefined;
  }
  return { character: marker[0] as "`" | "~", length: marker.length };
}

function isFenceCloser(line: string, fence: { character: "`" | "~"; length: number }): boolean {
  const match = /^( {0,3})(`+|~+)[ \t]*$/.exec(line);
  const marker = match?.[2];
  return marker !== undefined && marker[0] === fence.character && marker.length >= fence.length;
}

function appendMissingSection(markdown: string, heading: string, content: string, level: number): string {
  const section = `${"#".repeat(level)} ${heading}\n${replacementBody(content)}`;
  const current = trimTrailingNewlines(markdown);

  return current.length === 0 ? section : `${current}\n${section}`;
}

function replacementBody(content: string): string {
  return content.length === 0 ? "" : `${content}\n`;
}

function appendedBody(existing: string, addition: string): string {
  const current = trimTrailingNewlines(existing);

  if (current.length === 0) {
    return replacementBody(addition);
  }
  if (addition.length === 0) {
    return `${current}\n`;
  }
  return `${current}\n${addition}\n`;
}

function trimBoundaryNewlines(content: string): string {
  return content.replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, "");
}

function trimTrailingNewlines(content: string): string {
  return content.replace(/(?:\r?\n)+$/g, "");
}

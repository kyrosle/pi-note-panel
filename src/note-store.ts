import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import type { FileHandle as NodeFileHandle } from "node:fs/promises";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import {
  DEFAULT_PANEL_HEIGHT,
  DEFAULT_PANEL_WIDTH,
  MAX_PANEL_HEIGHT,
  MAX_PANEL_WIDTH,
  MIN_PANEL_HEIGHT,
  MIN_PANEL_WIDTH,
  NOTE_LIMIT_BYTES,
  type PanelPreferences,
} from "./types.ts";

const DEFAULT_PREFERENCES: PanelPreferences = {
  enabled: false,
  width: DEFAULT_PANEL_WIDTH,
  height: DEFAULT_PANEL_HEIGHT,
};

const NOTE_PROJECT_PATH = ".pi/NOTE.md";
const PREFERENCES_PROJECT_PATH = ".pi/note-panel.json";
const READ_OPEN_FLAGS = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW);

type ReadableFile = Pick<NodeFileHandle, "close" | "readFile" | "stat">;
interface FileHandle {
  close(): Promise<void>;
  stat(): Promise<Pick<Stats, "dev" | "ino">>;
  writeFile(content: string, options?: BufferEncoding | null): Promise<void>;
}
type OpenFile = (path: string, flags: number) => Promise<ReadableFile>;
type OpenTempFile = (path: string) => Promise<FileHandle>;
type LstatPath = (path: string) => Promise<Stats>;
type RenamePath = (from: string, to: string) => Promise<void>;
type UnlinkPath = (path: string) => Promise<void>;

interface TempIdentity {
  dev: number;
  ino: number;
}

export interface NoteStoreOptions {
  onWarning?: (warning: string) => void;
  tempNameFactory?: () => string;
  fileSystem?: {
    lstat?: LstatPath;
    openFile?: OpenFile;
    openTempFile?: OpenTempFile;
    rename?: RenamePath;
    unlink?: UnlinkPath;
  };
}

export class NoteStore {
  readonly projectRoot: string;
  readonly piDir: string;
  readonly notePath: string;
  readonly preferencesPath: string;

  private readonly onWarning: ((warning: string) => void) | undefined;
  private readonly lstatPath: LstatPath;
  private readonly openFile: OpenFile;
  private readonly openTempFile: OpenTempFile;
  private readonly renamePath: RenamePath;
  private readonly unlinkPath: UnlinkPath;
  private readonly tempNameFactory: () => string;
  private noteWriteQueue: Promise<void> = Promise.resolve();
  private warnedAboutMalformedPreferences = false;

  constructor(projectRoot: string, options: NoteStoreOptions = {}) {
    this.projectRoot = resolve(projectRoot);
    this.piDir = join(this.projectRoot, ".pi");
    this.notePath = join(this.piDir, "NOTE.md");
    this.preferencesPath = join(this.piDir, "note-panel.json");
    this.onWarning = options.onWarning;
    this.lstatPath = options.fileSystem?.lstat ?? lstat;
    this.openFile = options.fileSystem?.openFile ?? ((path, flags) => open(path, flags));
    this.openTempFile = options.fileSystem?.openTempFile ?? ((path) => open(path, "wx", 0o600));
    this.renamePath = options.fileSystem?.rename ?? rename;
    this.unlinkPath = options.fileSystem?.unlink ?? unlink;
    this.tempNameFactory = options.tempNameFactory ?? randomUUID;
  }

  async read(): Promise<string> {
    try {
      const projectRoot = await this.ensureSafePiDir(false);
      if (projectRoot === null) {
        return "";
      }

      return (await this.readOptionalFile(this.notePath, NOTE_PROJECT_PATH, projectRoot)) ?? "";
    } catch (error) {
      if (error instanceof FileSystemPathError || error instanceof UnsafePathError || error instanceof MalformedUtf8Error) {
        throw error;
      }
      if (getErrorCode(error) !== undefined) {
        throw this.fileSystemError("read", NOTE_PROJECT_PATH, error);
      }
      throw error;
    }
  }

  async replace(content: string): Promise<void> {
    this.assertUtf8Text(content);
    this.assertNoteSize(content);
    await this.enqueueNoteWrite(() => this.atomicWrite(this.notePath, NOTE_PROJECT_PATH, content));
  }

  async append(content: string): Promise<void> {
    this.assertUtf8Text(content);
    await this.enqueueNoteWrite(async () => {
      const next = this.appendText(await this.read(), content);
      this.assertNoteSize(next);
      await this.atomicWrite(this.notePath, NOTE_PROJECT_PATH, next);
    });
  }

  async readPreferences(): Promise<PanelPreferences> {
    let content: string | null;
    try {
      const projectRoot = await this.ensureSafePiDir(false);
      if (projectRoot === null) {
        return { ...DEFAULT_PREFERENCES };
      }
      content = await this.readOptionalFile(this.preferencesPath, PREFERENCES_PROJECT_PATH, projectRoot);
    } catch (error) {
      if (error instanceof MalformedUtf8Error) {
        return this.malformedPreferencesFallback();
      }
      if (error instanceof FileSystemPathError || error instanceof UnsafePathError) {
        throw error;
      }
      if (getErrorCode(error) !== undefined) {
        throw this.fileSystemError("read", PREFERENCES_PROJECT_PATH, error);
      }
      throw error;
    }

    if (content === null) {
      return { ...DEFAULT_PREFERENCES };
    }

    try {
      return this.parsePreferences(content);
    } catch {
      return this.malformedPreferencesFallback();
    }
  }

  async writePreferences(preferences: PanelPreferences): Promise<void> {
    const validPreferences = this.validatePreferences(preferences);
    await this.atomicWrite(
      this.preferencesPath,
      PREFERENCES_PROJECT_PATH,
      `${JSON.stringify(validPreferences, null, 2)}\n`,
    );
  }

  private async readOptionalFile(path: string, projectPath: string, resolvedProjectRoot: string): Promise<string | null> {
    if (process.platform === "win32" && !(await this.assertSafeFile(path, resolvedProjectRoot))) {
      return null;
    }

    let file: ReadableFile;
    try {
      file = await this.openFile(path, READ_OPEN_FLAGS);
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return null;
      }
      if (getErrorCode(error) === "ELOOP") {
        throw new UnsafePathError(`Unsafe note storage path: ${basename(path)} is a symlink`);
      }
      throw this.fileSystemError("read", projectPath, error);
    }

    let fileError: unknown;
    try {
      if (!(await file.stat()).isFile()) {
        throw new UnsafePathError(`Unsafe note storage path: ${basename(path)} must be a regular file`);
      }
      return this.decodeUtf8(await file.readFile());
    } catch (error) {
      fileError = error;
      if (getErrorCode(error) === "ENOENT") {
        return null;
      }
      if (error instanceof UnsafePathError || error instanceof MalformedUtf8Error) {
        throw error;
      }
      throw this.fileSystemError("read", projectPath, error);
    } finally {
      try {
        await file.close();
      } catch (error) {
        if (fileError === undefined) {
          throw this.fileSystemError("read", projectPath, error);
        }
      }
    }
  }

  private async atomicWrite(targetPath: string, projectPath: string, content: string): Promise<void> {
    let temporaryPath: string | null = null;
    let handle: FileHandle | null = null;
    let tempLinked = false;
    let tempIdentity: TempIdentity | null = null;
    let primaryError: unknown;
    try {
      const projectRoot = await this.ensureSafePiDir(true);
      if (projectRoot === null) {
        throw new Error("Unable to create the project .pi directory");
      }
      await this.assertSafeFile(targetPath, projectRoot);

      temporaryPath = join(this.piDir, `.${basename(targetPath)}.${this.tempName()}.tmp`);
      handle = await this.openTempFile(temporaryPath);
      tempLinked = true;
      const temporaryStats = await handle.stat();
      tempIdentity = { dev: temporaryStats.dev, ino: temporaryStats.ino };
      await handle.writeFile(content, "utf8");
      const handleToClose = handle;
      handle = null;
      await handleToClose.close();

      const verifiedProjectRoot = await this.ensureSafePiDir(true);
      if (verifiedProjectRoot === null) {
        throw new Error("Unable to create the project .pi directory");
      }
      await this.assertSafeFile(targetPath, verifiedProjectRoot);
      await this.renamePath(temporaryPath, targetPath);
      tempLinked = false;
    } catch (error) {
      primaryError = error instanceof UnsafePathError || error instanceof FileSystemPathError || error instanceof InvalidTempNameError
        ? error
        : this.fileSystemError("write", projectPath, error);
      throw primaryError;
    } finally {
      if (handle !== null) {
        const handleToClose = handle;
        handle = null;
        try {
          await handleToClose.close();
        } catch (error) {
          if (primaryError === undefined) {
            throw this.fileSystemError("write", projectPath, error);
          }
        }
      }
      if (tempLinked && temporaryPath !== null && tempIdentity !== null) {
        try {
          const currentStats = await this.lstatPath(temporaryPath);
          if (currentStats.dev === tempIdentity.dev && currentStats.ino === tempIdentity.ino) {
            await this.unlinkPath(temporaryPath);
          }
        } catch (error) {
          if (getErrorCode(error) !== "ENOENT" && primaryError === undefined) {
            throw this.fileSystemError("write", projectPath, error);
          }
        }
      }
    }
  }

  // This queue serializes note writes for one NoteStore instance only; it is not a cross-process lock.
  private enqueueNoteWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.noteWriteQueue.then(operation, operation);
    this.noteWriteQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private tempName(): string {
    const name = this.tempNameFactory();
    if (name.length === 0 || name === "." || name === ".." || name !== basename(name) || /[\\/]/.test(name)) {
      throw new InvalidTempNameError("tempNameFactory must return a basename");
    }
    return name;
  }

  /*
   * The safety boundary rejects symlink escapes that already exist when an operation starts.
   * It intentionally does not use openat/O_TMPFILE or claim protection from a same-user process
   * replacing directories between checks and rename; that process can already modify NOTE.md.
   */
  private async ensureSafePiDir(create: boolean): Promise<string | null> {
    const resolvedProjectRoot = await realpath(this.projectRoot);
    let piStats = await lstatIfPresent(this.piDir, this.lstatPath);

    if (piStats === null) {
      if (!create) {
        return null;
      }
      try {
        await mkdir(this.piDir, { mode: 0o700 });
      } catch (error) {
        if (getErrorCode(error) !== "EEXIST") {
          throw error;
        }
      }
      piStats = await lstatIfPresent(this.piDir, this.lstatPath);
    }

    if (piStats === null || piStats.isSymbolicLink()) {
      throw new UnsafePathError("Unsafe note storage path: .pi is a symlink");
    }
    if (!piStats.isDirectory()) {
      throw new UnsafePathError("Unsafe note storage path: .pi must be a real directory inside the project");
    }

    const resolvedPiDir = await realpath(this.piDir);
    this.assertContained(resolvedProjectRoot, resolvedPiDir, ".pi directory");
    return resolvedProjectRoot;
  }

  private async assertSafeFile(path: string, resolvedProjectRoot: string): Promise<boolean> {
    const stats = await lstatIfPresent(path, this.lstatPath);
    if (stats === null) {
      return false;
    }
    if (stats.isSymbolicLink()) {
      throw new UnsafePathError(`Unsafe note storage path: ${basename(path)} is a symlink`);
    }
    if (!stats.isFile()) {
      throw new UnsafePathError(`Unsafe note storage path: ${basename(path)} must be a regular file`);
    }

    this.assertContained(resolvedProjectRoot, await realpath(path), basename(path));
    return true;
  }

  private assertContained(projectRoot: string, target: string, label: string): void {
    const pathFromProject = relative(projectRoot, target);
    if (
      pathFromProject.length === 0 ||
      isAbsolute(pathFromProject) ||
      pathFromProject === ".." ||
      pathFromProject.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    ) {
      throw new UnsafePathError(`Unsafe note storage path: ${label} resolves outside the project`);
    }
  }

  private decodeUtf8(bytes: Uint8Array): string {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new MalformedUtf8Error();
    }
  }

  private appendText(current: string, addition: string): string {
    const currentContent = trimTrailingNewlines(current);
    const additionContent = trimBoundaryNewlines(addition);

    if (currentContent.length === 0) {
      return additionContent.length === 0 ? "" : `${additionContent}\n`;
    }
    if (additionContent.length === 0) {
      return `${currentContent}\n`;
    }
    return `${currentContent}\n${additionContent}\n`;
  }

  private assertUtf8Text(content: string): void {
    if (!isValidUnicodeString(content)) {
      throw new TypeError("Note content must be valid UTF-8 text");
    }
  }

  private assertNoteSize(content: string): void {
    if (Buffer.byteLength(content, "utf8") > NOTE_LIMIT_BYTES) {
      throw new NoteLimitError();
    }
  }

  private parsePreferences(content: string): PanelPreferences {
    const value = JSON.parse(content);
    if (isLegacyPreferences(value)) {
      return { ...value, height: DEFAULT_PANEL_HEIGHT };
    }
    return this.validatePreferences(value);
  }

  private validatePreferences(value: unknown): PanelPreferences {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as { enabled?: unknown }).enabled !== "boolean" ||
      !isValidWidth((value as { width?: unknown }).width) ||
      !isValidHeight((value as { height?: unknown }).height)
    ) {
      throw new PreferencesValidationError();
    }

    return {
      enabled: (value as { enabled: boolean }).enabled,
      width: (value as { width: number }).width,
      height: (value as { height: number }).height,
    };
  }

  private malformedPreferencesFallback(): PanelPreferences {
    if (!this.warnedAboutMalformedPreferences) {
      this.warnedAboutMalformedPreferences = true;
      this.onWarning?.("Ignoring malformed .pi/note-panel.json; using defaults.");
    }
    return { ...DEFAULT_PREFERENCES };
  }

  private fileSystemError(action: "read" | "write", projectPath: string, cause: unknown): FileSystemPathError {
    return new FileSystemPathError(action, projectPath, cause);
  }
}

export class UnsafePathError extends Error {}

export class NoteLimitError extends RangeError {
  constructor() {
    super("Note content exceeds the 256 KiB limit");
  }
}

export class PreferencesValidationError extends TypeError {
  constructor() {
    super(`Preferences width must be an integer from ${MIN_PANEL_WIDTH} to ${MAX_PANEL_WIDTH} and height from ${MIN_PANEL_HEIGHT} to ${MAX_PANEL_HEIGHT}`);
  }
}

class InvalidTempNameError extends Error {}

class MalformedUtf8Error extends Error {
  constructor() {
    super("Malformed UTF-8 text");
  }
}

export class FileSystemPathError extends Error {
  constructor(action: "read" | "write", projectPath: string, cause: unknown) {
    const code = getErrorCode(cause);
    super(`Unable to ${action} ${projectPath}${code === undefined ? "" : ` (${code})`}`, { cause });
  }
}

function trimBoundaryNewlines(content: string): string {
  return content.replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, "");
}

function trimTrailingNewlines(content: string): string {
  return content.replace(/(?:\r?\n)+$/g, "");
}

function isValidWidth(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_PANEL_WIDTH && value <= MAX_PANEL_WIDTH;
}

function isValidHeight(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_PANEL_HEIGHT && value <= MAX_PANEL_HEIGHT;
}

function isLegacyPreferences(value: unknown): value is { enabled: boolean; width: number } {
  return typeof value === "object"
    && value !== null
    && typeof (value as { enabled?: unknown }).enabled === "boolean"
    && isValidWidth((value as { width?: unknown }).width)
    && !Object.hasOwn(value, "height");
}

function isValidUnicodeString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      return false;
    }
  }
  return true;
}

async function lstatIfPresent(path: string, lstatPath: LstatPath): Promise<Stats | null> {
  try {
    return await lstatPath(path);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: string }).code
    : undefined;
}

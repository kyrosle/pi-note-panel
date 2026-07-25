import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { NoteStore } from "../src/note-store.ts";
import {
  DEFAULT_PANEL_HEIGHT,
  DEFAULT_PANEL_WIDTH,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  NOTE_LIMIT_BYTES,
} from "../src/types.ts";

const execFileAsync = promisify(execFile);

async function withProject(run: (projectRoot: string) => Promise<void>): Promise<void> {
  const projectRoot = await mkdtemp(join(tmpdir(), "pi-note-store-"));
  try {
    await run(projectRoot);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

function fileSystemError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

async function temporaryHandle(path: string, events: string[], failures: { close?: string; write?: string } = {}) {
  const file = await open(path, "wx", 0o600);
  return {
    close: async () => {
      events.push("close");
      await file.close();
      if (failures.close !== undefined) {
        throw fileSystemError(failures.close);
      }
    },
    stat: async () => file.stat(),
    writeFile: async (content: string) => {
      events.push("write");
      if (failures.write !== undefined) {
        throw fileSystemError(failures.write);
      }
      await file.writeFile(content, "utf8");
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve: () => resolve?.() };
}

test("missing notes read as empty without creating .pi", async () => {
  await withProject(async (projectRoot) => {
    const store = new NoteStore(projectRoot);

    assert.equal(await store.read(), "");
    await assert.rejects(() => readFile(store.notePath, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readdir(store.piDir), { code: "ENOENT" });
  });
});

test("missing preferences use default-off dimensions without creating .pi", async () => {
  await withProject(async (projectRoot) => {
    const store = new NoteStore(projectRoot);
    assert.deepEqual(await store.readPreferences(), { enabled: false, width: DEFAULT_PANEL_WIDTH, height: DEFAULT_PANEL_HEIGHT });
    await assert.rejects(() => readdir(store.piDir), { code: "ENOENT" });
  });
});

test("a missing project root is reported with the fixed note path", async () => {
  await withProject(async (projectRoot) => {
    const store = new NoteStore(projectRoot);
    await rm(projectRoot, { force: true, recursive: true });

    await assert.rejects(
      () => store.read(),
      (error: unknown) => error instanceof Error && error.message === "Unable to read .pi/NOTE.md (ENOENT)",
    );
  });
});

test("POSIX FIFO note and preference reads reject without blocking", { skip: process.platform === "win32" }, async () => {
  await withProject(async (projectRoot) => {
    const store = new NoteStore(projectRoot);
    await store.replace("");

    for (const [path, target] of [
      [store.notePath, "note"],
      [store.preferencesPath, "preferences"],
    ] as const) {
      await rm(path, { force: true });
      await execFileAsync("mkfifo", [path]);
      await execFileAsync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "--eval",
          `
            import { NoteStore } from ${JSON.stringify(new URL("../src/note-store.ts", import.meta.url).href)};
            const store = new NoteStore(process.env.PI_NOTE_TEST_ROOT);
            try {
              await (process.env.PI_NOTE_TEST_TARGET === "note" ? store.read() : store.readPreferences());
              process.exitCode = 1;
            } catch (error) {
              process.exitCode = error instanceof Error && /regular file/.test(error.message) ? 0 : 2;
            }
          `,
        ],
        {
          env: { ...process.env, PI_NOTE_TEST_ROOT: projectRoot, PI_NOTE_TEST_TARGET: target },
          killSignal: "SIGKILL",
          timeout: 1000,
        },
      );
    }
  });
});

test("replace and append maintain one separator and a trailing newline", async () => {
  await withProject(async (projectRoot) => {
    const store = new NoteStore(projectRoot);

    await store.replace("first");
    await store.append("second");
    await store.append("\nthird\n\n");

    assert.equal(await store.read(), "first\nsecond\nthird\n");
    assert.equal(await readFile(store.notePath, "utf8"), "first\nsecond\nthird\n");
  });
});

test("append operations are serialized within one NoteStore instance", async () => {
  await withProject(async (projectRoot) => {
    const renameEntered = deferred();
    const releaseRename = deferred();
    let blockFirstRename = true;
    let noteOpenedBeforeFirstRename = false;
    const store = new NoteStore(projectRoot, {
      fileSystem: {
        openFile: async (path, flags) => {
          if (path.endsWith("/.pi/NOTE.md") && blockFirstRename) {
            noteOpenedBeforeFirstRename = true;
          }
          return open(path, flags);
        },
        rename: async (from, to) => {
          if (blockFirstRename) {
            blockFirstRename = false;
            renameEntered.resolve();
            await releaseRename.promise;
          }
          await rename(from, to);
        },
      },
    });

    const first = store.append("first");
    await renameEntered.promise;
    const second = store.append("second");
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(noteOpenedBeforeFirstRename, false);
    releaseRename.resolve();
    await Promise.all([first, second]);

    assert.equal(await store.read(), "first\nsecond\n");
  });
});

test("oversized writes preserve the existing note", async () => {
  await withProject(async (projectRoot) => {
    const store = new NoteStore(projectRoot);
    await store.replace("keep");

    await assert.rejects(() => store.replace("a".repeat(NOTE_LIMIT_BYTES + 1)), /256 KiB/);

    assert.equal(await store.read(), "keep");
  });
});

test("writes reject .pi, note, and preferences symlinks outside the project", async () => {
  await withProject(async (projectRoot) => {
    const outside = await mkdtemp(join(tmpdir(), "pi-note-outside-"));
    try {
      const directoryStore = new NoteStore(projectRoot);
      await symlink(outside, directoryStore.piDir);
      await assert.rejects(() => directoryStore.replace("blocked"), /symlink|outside/i);
      await assert.rejects(() => directoryStore.writePreferences({ enabled: true, width: DEFAULT_PANEL_WIDTH, height: 20 }), /symlink|outside/i);

      await rm(directoryStore.piDir);
      await directoryStore.replace("safe");

      const noteStore = new NoteStore(projectRoot);
      await writeFile(join(outside, "NOTE.md"), "outside note", "utf8");
      await rm(noteStore.notePath);
      await symlink(join(outside, "NOTE.md"), noteStore.notePath);
      await assert.rejects(() => noteStore.replace("blocked"), /symlink|outside/i);
      assert.equal(await readFile(join(outside, "NOTE.md"), "utf8"), "outside note");

      await rm(noteStore.notePath);
      await symlink(join(outside, "note-panel.json"), noteStore.preferencesPath);
      await assert.rejects(() => noteStore.writePreferences({ enabled: true, width: DEFAULT_PANEL_WIDTH, height: 20 }), /symlink|outside/i);
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

test("note and preference reads reject symlink targets", async () => {
  await withProject(async (projectRoot) => {
    const store = new NoteStore(projectRoot);
    const outside = await mkdtemp(join(tmpdir(), "pi-note-read-outside-"));
    try {
      await store.replace("safe");
      await writeFile(join(outside, "NOTE.md"), "outside note", "utf8");
      await rm(store.notePath);
      await symlink(join(outside, "NOTE.md"), store.notePath);
      await assert.rejects(() => store.read(), /symlink|outside/i);

      await writeFile(join(outside, "note-panel.json"), '{"enabled":false,"width":48}', "utf8");
      await symlink(join(outside, "note-panel.json"), store.preferencesPath);
      await assert.rejects(() => store.readPreferences(), /symlink|outside/i);
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

test("malformed preferences return defaults", async () => {
  await withProject(async (projectRoot) => {
    const store = new NoteStore(projectRoot);
    await store.replace("");
    await writeFile(store.preferencesPath, "{not json", "utf8");

    assert.deepEqual(await store.readPreferences(), { enabled: false, width: DEFAULT_PANEL_WIDTH, height: 20 });
  });
});

test("legacy preferences receive the default height without being rewritten", async () => {
  await withProject(async (projectRoot) => {
    const store = new NoteStore(projectRoot);
    await store.replace("");
    await writeFile(store.preferencesPath, '{"enabled":true,"width":48}\n', "utf8");
    assert.deepEqual(await store.readPreferences(), { enabled: true, width: 48, height: DEFAULT_PANEL_HEIGHT });
    assert.equal(await readFile(store.preferencesPath, "utf8"), '{"enabled":true,"width":48}\n');
  });
});

test("malformed UTF-8 preferences return defaults and warn once", async () => {
  await withProject(async (projectRoot) => {
    const warnings: string[] = [];
    const store = new NoteStore(projectRoot, { onWarning: (warning) => warnings.push(warning) });
    await store.replace("");
    await writeFile(store.preferencesPath, Buffer.from([0xc3, 0x28]));

    assert.deepEqual(await store.readPreferences(), { enabled: false, width: DEFAULT_PANEL_WIDTH, height: 20 });
    assert.deepEqual(await store.readPreferences(), { enabled: false, width: DEFAULT_PANEL_WIDTH, height: 20 });
    assert.deepEqual(warnings, ["Ignoring malformed .pi/note-panel.json; using defaults."]);
  });
});

test("read returns empty when NOTE.md disappears after the directory check", async () => {
  await withProject(async (projectRoot) => {
    const writer = new NoteStore(projectRoot);
    await writer.replace("present before the race");
    let openCalls = 0;
    const store = new NoteStore(projectRoot, {
      fileSystem: {
        openFile: async () => {
          openCalls += 1;
          throw fileSystemError("ENOENT");
        },
      },
    });

    assert.equal(await store.read(), "");
    assert.equal(openCalls, 1);
  });
});

test("preference read filesystem errors are wrapped with a stable project-relative path", async () => {
  await withProject(async (projectRoot) => {
    const writer = new NoteStore(projectRoot);
    await writer.writePreferences({ enabled: true, width: DEFAULT_PANEL_WIDTH, height: 20 });

    for (const code of ["EACCES", "EIO"]) {
      const store = new NoteStore(projectRoot, {
        fileSystem: {
          openFile: async () => {
            throw fileSystemError(code);
          },
        },
      });

      await assert.rejects(
        () => store.readPreferences(),
        (error: unknown) => error instanceof Error && error.message === `Unable to read .pi/note-panel.json (${code})`,
      );
    }
  });
});

test("write errors use stable target paths instead of random temporary filenames", async () => {
  await withProject(async (projectRoot) => {
    let temporaryPath = "";
    const store = new NoteStore(projectRoot, {
      fileSystem: {
        openTempFile: async (path) => {
          temporaryPath = path;
          return temporaryHandle(path, [], { write: "EIO" });
        },
      },
    });

    await assert.rejects(
      () => store.replace("content"),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "Unable to write .pi/NOTE.md (EIO)" &&
        !error.message.includes(temporaryPath),
    );
  });
});

test("a colliding temporary filename is preserved when exclusive creation fails", async () => {
  await withProject(async (projectRoot) => {
    const writer = new NoteStore(projectRoot);
    await writer.replace("original");
    const collisionPath = join(writer.piDir, ".NOTE.md.collision.tmp");
    await writeFile(collisionPath, "belongs to another writer", "utf8");
    const events: string[] = [];

    const store = new NoteStore(projectRoot, {
      tempNameFactory: () => "collision",
      fileSystem: {
        unlink: async () => {
          events.push("unlink");
        },
      },
    });
    await assert.rejects(
      () => store.replace("replacement"),
      (error: unknown) => error instanceof Error && error.message === "Unable to write .pi/NOTE.md (EEXIST)",
    );

    assert.equal(await readFile(collisionPath, "utf8"), "belongs to another writer");
    assert.equal(await writer.read(), "original");
    assert.deepEqual(events, []);
  });
});

test("write failure closes and unlinks the owned temporary file", async () => {
  await withProject(async (projectRoot) => {
    const setup = new NoteStore(projectRoot);
    await setup.replace("old");
    const events: string[] = [];
    const store = new NoteStore(projectRoot, {
      fileSystem: {
        openTempFile: async (path) => temporaryHandle(path, events, { write: "EIO" }),
        unlink: async () => {
          events.push("unlink");
        },
      },
    });

    await assert.rejects(() => store.replace("new"), /Unable to write .pi\/NOTE.md \(EIO\)/);
    assert.deepEqual(events, ["write", "close", "unlink"]);
  });
});

test("close failure closes the temporary handle exactly once and unlinks it", async () => {
  await withProject(async (projectRoot) => {
    const setup = new NoteStore(projectRoot);
    await setup.replace("old");
    const events: string[] = [];
    const store = new NoteStore(projectRoot, {
      fileSystem: {
        openTempFile: async (path) => temporaryHandle(path, events, { close: "EIO" }),
        unlink: async () => {
          events.push("unlink");
        },
      },
    });

    await assert.rejects(() => store.replace("new"), /Unable to write .pi\/NOTE.md \(EIO\)/);
    assert.deepEqual(events, ["write", "close", "unlink"]);
  });
});

test("rename failure unlinks the owned temporary file", async () => {
  await withProject(async (projectRoot) => {
    const setup = new NoteStore(projectRoot);
    await setup.replace("old");
    const events: string[] = [];
    const store = new NoteStore(projectRoot, {
      fileSystem: {
        openTempFile: async (path) => temporaryHandle(path, events),
        rename: async () => {
          events.push("rename");
          throw fileSystemError("EIO");
        },
        unlink: async () => {
          events.push("unlink");
        },
      },
    });

    await assert.rejects(() => store.replace("new"), /Unable to write .pi\/NOTE.md \(EIO\)/);
    assert.deepEqual(events, ["write", "close", "rename", "unlink"]);
  });
});

test("successful rename never unlinks the replacement path", async () => {
  await withProject(async (projectRoot) => {
    const setup = new NoteStore(projectRoot);
    await setup.replace("old");
    const events: string[] = [];
    const store = new NoteStore(projectRoot, {
      fileSystem: {
        openTempFile: async (path) => temporaryHandle(path, events),
        rename: async () => {
          events.push("rename");
        },
        unlink: async () => {
          events.push("unlink");
        },
      },
    });

    await store.replace("new");
    assert.deepEqual(events, ["write", "close", "rename"]);
  });
});

test("a sentinel reusing the temporary name after rename is preserved", async () => {
  await withProject(async (projectRoot) => {
    const setup = new NoteStore(projectRoot);
    await setup.replace("old");
    const events: string[] = [];
    const store = new NoteStore(projectRoot, {
      tempNameFactory: () => "reused",
      fileSystem: {
        openTempFile: async (path) => temporaryHandle(path, events),
        rename: async (temporaryPath) => {
          events.push("rename");
          await writeFile(temporaryPath, "sentinel", "utf8");
        },
      },
    });
    const sentinelPath = join(store.piDir, ".NOTE.md.reused.tmp");

    await store.replace("new");
    assert.equal(await readFile(sentinelPath, "utf8"), "sentinel");
    assert.deepEqual(events, ["write", "close", "rename"]);
  });
});

test("a sentinel replacing a failed temporary file is not unlinked", async () => {
  await withProject(async (projectRoot) => {
    const setup = new NoteStore(projectRoot);
    await setup.replace("old");
    const store = new NoteStore(projectRoot, {
      tempNameFactory: () => "replaced-before-cleanup",
      fileSystem: {
        rename: async (temporaryPath) => {
          await rm(temporaryPath);
          await writeFile(temporaryPath, "sentinel", "utf8");
          throw fileSystemError("EIO");
        },
      },
    });
    const sentinelPath = join(store.piDir, ".NOTE.md.replaced-before-cleanup.tmp");

    await assert.rejects(() => store.replace("new"), /Unable to write .pi\/NOTE.md \(EIO\)/);
    assert.equal(await readFile(sentinelPath, "utf8"), "sentinel");
  });
});

test("temporary name factories reject path separators", async () => {
  await withProject(async (projectRoot) => {
    const store = new NoteStore(projectRoot, { tempNameFactory: () => "nested/name" });

    await assert.rejects(() => store.replace("content"), /basename/);
  });
});

test("cleanup failure never replaces the primary write failure", async () => {
  await withProject(async (projectRoot) => {
    const setup = new NoteStore(projectRoot);
    await setup.replace("old");
    const events: string[] = [];
    const store = new NoteStore(projectRoot, {
      fileSystem: {
        openTempFile: async (path) => temporaryHandle(path, events, { write: "EIO" }),
        unlink: async () => {
          events.push("unlink");
          throw fileSystemError("EPERM");
        },
      },
    });

    await assert.rejects(
      () => store.replace("new"),
      (error: unknown) => error instanceof Error && error.message === "Unable to write .pi/NOTE.md (EIO)",
    );
    assert.deepEqual(events, ["write", "close", "unlink"]);
  });
});

test("read wraps directory-check filesystem errors with the stable note path", async () => {
  await withProject(async (projectRoot) => {
    const writer = new NoteStore(projectRoot);
    await writer.replace("note");

    for (const code of ["EACCES", "EIO"]) {
      const store = new NoteStore(projectRoot, {
        fileSystem: {
          lstat: async () => {
            throw fileSystemError(code);
          },
        },
      });

      await assert.rejects(
        () => store.read(),
        (error: unknown) => error instanceof Error && error.message === `Unable to read .pi/NOTE.md (${code})`,
      );
    }
  });
});

test("invalid preference dimensions are rejected without writing", async () => {
  await withProject(async (projectRoot) => {
    const store = new NoteStore(projectRoot);

    await assert.rejects(() => store.writePreferences({ enabled: true, width: MIN_PANEL_WIDTH - 1, height: 20 }), /width/i);
    await assert.rejects(() => store.writePreferences({ enabled: false, width: MAX_PANEL_WIDTH + 1, height: 20 }), /width/i);
    await assert.rejects(() => store.writePreferences({ enabled: false, width: 36, height: 7 }), /height/i);
    await assert.rejects(() => readFile(store.preferencesPath, "utf8"), { code: "ENOENT" });
  });
});

test("valid preferences persist atomically without orphan temp files", async () => {
  await withProject(async (projectRoot) => {
    const store = new NoteStore(projectRoot);

    await store.writePreferences({ enabled: false, width: 48, height: 28 });

    assert.deepEqual(await store.readPreferences(), { enabled: false, width: 48, height: 28 });
    assert.deepEqual(await readdir(store.piDir), ["note-panel.json"]);
  });
});

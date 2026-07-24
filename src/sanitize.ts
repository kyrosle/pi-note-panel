export interface RawNoteMetrics {
  bytes: number;
  sourceLines: number;
}

export function sanitizeNoteMarkdown(note: string): string {
  let output = "";
  for (let index = 0; index < note.length; index += 1) {
    const code = note.charCodeAt(index);
    if (code === 0x1b) {
      index = skipEscapeSequence(note, index);
      continue;
    }
    if (code >= 0x80 && code <= 0x9f) {
      index = skipC1Sequence(note, index, code);
      continue;
    }
    if (code === 0x0a) {
      output += "\n";
    } else if (code === 0x0d) {
      output += "\n";
      if (note.charCodeAt(index + 1) === 0x0a) {
        index += 1;
      }
    } else if (code === 0x09) {
      output += "\t";
    } else if (code >= 0x20 && code !== 0x7f) {
      output += note[index];
    }
  }
  return output;
}

export function rawNoteMetrics(note: string): RawNoteMetrics {
  return {
    bytes: Buffer.byteLength(note, "utf8"),
    sourceLines: note === "" ? 0 : note.split(/\r\n|\n|\r/).length,
  };
}

function skipEscapeSequence(text: string, index: number): number {
  const next = text.charCodeAt(index + 1);
  if (next === 0x5b) {
    return skipCsi(text, index + 2);
  }
  if (next === 0x5d) {
    return skipStringControl(text, index + 2, true);
  }
  if (next === 0x50 || next === 0x5f || next === 0x5e || next === 0x58) {
    return skipStringControl(text, index + 2, false);
  }
  return Math.min(text.length - 1, index + 1);
}

function skipC1Sequence(text: string, index: number, code: number): number {
  if (code === 0x9b) {
    return skipCsi(text, index + 1);
  }
  if (code === 0x9d) {
    return skipStringControl(text, index + 1, true);
  }
  if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
    return skipStringControl(text, index + 1, false);
  }
  return index;
}

function skipCsi(text: string, index: number): number {
  for (let cursor = index; cursor < text.length; cursor += 1) {
    const code = text.charCodeAt(cursor);
    if (code === 0x18 || code === 0x1a) {
      return cursor;
    }
    if (code >= 0x40 && code <= 0x7e) {
      return cursor;
    }
  }
  return text.length - 1;
}

function skipStringControl(text: string, index: number, allowBell: boolean): number {
  for (let cursor = index; cursor < text.length; cursor += 1) {
    const code = text.charCodeAt(cursor);
    if (allowBell && code === 0x07) {
      return cursor;
    }
    if (code === 0x9c || code === 0x18 || code === 0x1a) {
      return cursor;
    }
    if (code === 0x1b && text.charCodeAt(cursor + 1) === 0x5c) {
      return cursor + 1;
    }
  }
  return text.length - 1;
}

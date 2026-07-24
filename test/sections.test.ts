import assert from "node:assert/strict";
import test from "node:test";

import { updateSection } from "../src/sections.ts";

test("matches ATX headings case-insensitively after trimming and accepts closing hashes", () => {
  const markdown = "# Overview\nkeep\n## Release Plan ###\nold\n";

  assert.equal(
    updateSection(markdown, { heading: "  release plan  ", content: "new", mode: "replace" }),
    "# Overview\nkeep\n## Release Plan ###\nnew\n",
  );
});

test("matches heading titles exactly rather than by prefix or substring", () => {
  const markdown = "## Targeted\nkeep this\n## Target\nreplace this\n";

  assert.equal(
    updateSection(markdown, { heading: "Target", content: "new", mode: "replace" }),
    "## Targeted\nkeep this\n## Target\nnew\n",
  );
});

test("replace removes the full section body through lower-level child headings", () => {
  const markdown = "# Top\noutside\n## Target\nold\n### Child\nremove me\n## Next\nstay\n";

  assert.equal(
    updateSection(markdown, { heading: "target", content: "replacement", mode: "replace" }),
    "# Top\noutside\n## Target\nreplacement\n## Next\nstay\n",
  );
});

test("a higher-level heading ends the matched section", () => {
  const markdown = "### Target\nreplace this\n## Parent\nkeep this\n";

  assert.equal(
    updateSection(markdown, { heading: "Target", content: "new", mode: "replace" }),
    "### Target\nnew\n## Parent\nkeep this\n",
  );
});

test("append keeps the section body and normalizes boundary newlines", () => {
  const markdown = "## Target\nold\n\n";

  assert.equal(
    updateSection(markdown, { heading: "Target", content: "\nnew\n\n", mode: "append" }),
    "## Target\nold\nnew\n",
  );
});

test("append stops before a same-level heading and preserves following content exactly", () => {
  const markdown = "## Target\nold\n### Child\nkeep child\n## Next\r\nkeep next  \r\n# Higher\r\nkeep higher\r\n";

  assert.equal(
    updateSection(markdown, { heading: "Target", content: "new", mode: "append" }),
    "## Target\nold\n### Child\nkeep child\nnew\n## Next\r\nkeep next  \r\n# Higher\r\nkeep higher\r\n",
  );
});

test("adds a missing section at the requested level while preserving unrelated content", () => {
  const markdown = "before\n\n# Existing\nkeep\n\n";

  assert.equal(
    updateSection(markdown, { heading: "Added", content: "body", mode: "replace", level: 3 }),
    "before\n\n# Existing\nkeep\n### Added\nbody\n",
  );
});

test("uses level two by default for a missing section, including an empty note", () => {
  assert.equal(
    updateSection("", { heading: "Added", content: "body", mode: "append" }),
    "## Added\nbody\n",
  );
});

test("does not treat non-ATX text as a section heading", () => {
  const markdown = "Target\n======\nkeep exactly\n";

  assert.equal(
    updateSection(markdown, { heading: "Target", content: "body", mode: "replace" }),
    "Target\n======\nkeep exactly\n## Target\nbody\n",
  );
});

test("rejects duplicate matching headings", () => {
  assert.throws(
    () => updateSection("## Target\none\n## target ###\ntwo\n", { heading: "target", content: "new", mode: "replace" }),
    /multiple matching headings/i,
  );
});

test("rejects empty headings and invalid levels", () => {
  assert.throws(
    () => updateSection("", { heading: " \t ", content: "body", mode: "replace" }),
    /heading must not be empty/i,
  );

  for (const level of [0, 7, 1.5]) {
    assert.throws(
      () => updateSection("", { heading: "Target", content: "body", mode: "replace", level }),
      /level must be an integer from 1 to 6/i,
    );
  }
});

test("rejects invalid section update modes at runtime", () => {
  const update = { heading: "Target", content: "body", mode: "merge" } as unknown as Parameters<typeof updateSection>[1];

  assert.throws(
    () => updateSection("", update),
    /mode must be "replace" or "append"/i,
  );
});

test("preserves text outside a matched section byte-for-byte", () => {
  const markdown = "preamble  \r\n## Target\r\nold\r\n# Elsewhere\r\ntrailing  \r\n";

  assert.equal(
    updateSection(markdown, { heading: "TARGET", content: "new", mode: "replace" }),
    "preamble  \r\n## Target\r\nnew\n# Elsewhere\r\ntrailing  \r\n",
  );
});

test("treats C# as a heading title and removes closing hashes only after whitespace", () => {
  const markdown = "## C#\nold csharp\n## C ###\nold c\n";

  assert.equal(
    updateSection(markdown, { heading: "C#", content: "new csharp", mode: "replace" }),
    "## C#\nnew csharp\n## C ###\nold c\n",
  );
  assert.equal(
    updateSection(markdown, { heading: "C", content: "new c", mode: "replace" }),
    "## C#\nold csharp\n## C ###\nnew c\n",
  );
});

test("recognizes ATX headings with up to three leading spaces but not four", () => {
  assert.equal(
    updateSection("   ## Target\r\nold\r\n", { heading: "Target", content: "new", mode: "replace" }),
    "   ## Target\r\nnew\n",
  );
  assert.equal(
    updateSection("    ## Target\nold\n", { heading: "Target", content: "new", mode: "replace" }),
    "    ## Target\nold\n## Target\nnew\n",
  );
});

test("ignores headings and section boundaries inside backtick and tilde fenced code", () => {
  const markdown = "```markdown\n## Target\n# Boundary\n```\n~~~\n## Target\n# Boundary\n~~~\n## Target\nold\n## Next\nstay\n";

  assert.equal(
    updateSection(markdown, { heading: "Target", content: "new", mode: "replace" }),
    "```markdown\n## Target\n# Boundary\n```\n~~~\n## Target\n# Boundary\n~~~\n## Target\nnew\n## Next\nstay\n",
  );
});

test("does not treat fenced duplicates or boundaries as real headings", () => {
  const markdown = "## Target\nold\n````\n## Target\n# Boundary\n`````\nkeep\n## Next\nstay\n";

  assert.equal(
    updateSection(markdown, { heading: "Target", content: "new", mode: "append" }),
    "## Target\nold\n````\n## Target\n# Boundary\n`````\nkeep\nnew\n## Next\nstay\n",
  );
});

test("rejects missing sections after unclosed backtick or tilde fences without changing the note", () => {
  const cases = [
    "```typescript\nconst hidden = true;\n",
    "~~~~markdown\n## Hidden\n",
    "````\nconst hidden = true;\n```\n",
    "~~~~~\nconst hidden = true;\n~~~~\n",
  ];

  for (const markdown of cases) {
    const before = markdown.slice();
    for (const mode of ["replace", "append"] as const) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        assert.throws(
          () => updateSection(markdown, { heading: "Missing", content: "new", mode }),
          /Cannot create section while a fenced code block is unclosed\./,
        );
      }
      assert.equal(markdown, before);
    }
  }
});

test("updates an existing section even when a later fence is unclosed", () => {
  const markdown = "## Target\nold\n```\n## Not a boundary\n";

  assert.equal(
    updateSection(markdown, { heading: "Target", content: "new", mode: "replace" }),
    "## Target\nnew\n",
  );
});

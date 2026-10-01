const { Point, Range, TextBuffer } = require("lumine");
const createBatch = require("../lib/formatting-batch");

describe("IPython formatting batches", () => {
  beforeEach(() => jasmine.useRealClock());
  const block = (row, text, restore = (value) => value) => ({
    range: new Range([row, 0], [row + 1, 0]),
    text,
    restore,
  });
  const options = (source = "") => ({ source, isCurrent: () => true });
  function prefix(batch) {
    return batch.text.match(/^# (__lumine_ipy_batch_[0-9]+_)begin_0/)[1];
  }

  it("uses a single body directly without adding synthetic statements or comments", async () => {
    const body = block(0, '"""Module documentation."""\nfrom __future__ import annotations\n');
    const batch = await createBatch([body], options(body.text));
    expect(batch.text).toBe(body.text);
    expect(batch.restore(body.text)).toEqual([{ range: body.range, text: body.text }]);
  });

  it("joins 1000 bodies with comments and restores every original range", async () => {
    const blocks = Array.from({ length: 1000 }, (_, index) =>
      block(index * 3, `value_${index}=1\n`),
    );
    const batch = await createBatch(blocks, options(blocks.map((body) => body.text).join("")));
    const restored = batch.restore(batch.text.replaceAll("=1", " = 1"));
    expect(restored.length).toBe(1000);
    for (let index = 0; index < blocks.length; index++) {
      expect(restored[index].range).toEqual(blocks[index].range);
      expect(restored[index].text).toBe(`value_${index} = 1\n`);
    }
    expect(batch.text).not.toMatch(/__lumine_ipy_batch_[0-9]+_.*\(/);
  });

  it("preserves module docstrings and future-import placement between bodies", async () => {
    const blocks = [
      block(0, '"""A module docstring."""\n'),
      block(3, "from __future__ import annotations\n"),
    ];
    const batch = await createBatch(blocks, options());
    expect(batch.text.split("\n").filter((line) => line && !line.startsWith("# "))).toEqual([
      '"""A module docstring."""',
      "from __future__ import annotations",
    ]);
    expect(batch.restore(batch.text)).toEqual(blocks.map(({ range, text }) => ({ range, text })));
  });

  it("selects intersecting bodies and does not include protected source", async () => {
    const blocks = [block(1, "first=1\n"), block(10, "last=1\n")];
    const batch = await createBatch(blocks, {
      ...options("# %% [raw]\nopaque <bytes>\n"),
      range: blocks[1].range,
    });
    expect(batch.text).toBe(blocks[1].text);
    expect(batch.text).not.toContain("opaque");
    expect(batch.restore("last = 1\n")).toEqual([{ range: blocks[1].range, text: "last = 1\n" }]);
  });

  it("avoids delimiters already present anywhere in the source", async () => {
    const blocks = [block(0, "x=1\n"), block(3, "y=1\n")];
    const first = await createBatch(blocks, options());
    const number = Number(prefix(first).match(/[0-9]+/)[0]);
    const collision = `__lumine_ipy_batch_${number + 1}_`;
    const batch = await createBatch(blocks, options(`raw source ${collision}begin_0`));
    expect(prefix(batch)).not.toBe(collision);
    expect(batch.restore(batch.text).length).toBe(2);
  });

  it("rejects missing, repeated, reordered and malformed delimiter comments atomically", async () => {
    const blocks = [block(0, "x=1\n"), block(3, "y=1\n")];
    const batch = await createBatch(blocks, options());
    const token = prefix(batch);
    const begin = `# ${token}begin_0\n`;
    for (const formatted of [
      batch.text.replace(begin, ""),
      batch.text.replace(begin, begin + begin),
      batch.text.replace("begin_0", "begin_1"),
      batch.text.replace(begin, `  ${begin}`),
      batch.text.replace(begin, begin.trimEnd() + " changed\n"),
      `unexpected = 1\n${batch.text}`,
    ])
      expect(batch.restore(formatted)).toBeNull();
  });

  it("rejects delimiters inside strings, f-string fields, brackets and continued lines", async () => {
    const batch = await createBatch([block(0, "x=1\n"), block(3, "y=1\n")], options());
    for (const formatted of [
      `"""\n${batch.text}"""\n`,
      `f"""{\n${batch.text}value\n}"""\n`,
      `(\n${batch.text})\n`,
      `value = \\\n${batch.text}`,
    ])
      expect(batch.restore(formatted)).toBeNull();
  });

  it("accepts closed strings and modern same-quote f-string expressions in bodies", async () => {
    const first = 'value = f"{ "quoted" }"\n';
    const second = 'value = f"""{f"{ "nested" }"!s:>{width}}"""\n';
    const batch = await createBatch([block(0, first), block(3, second)], options());
    expect(batch.restore(batch.text).map((item) => item.text)).toEqual([first, second]);
  });

  it("restores single-quoted strings with escaped CRLF and LF line continuations", async () => {
    const first = "value = 'a\\\r\nb'\r\n";
    const second = "value = 'a\\\nb'\n";
    const batch = await createBatch([block(0, first), block(3, second)], options());
    expect(batch.restore(batch.text).map((item) => item.text)).toEqual([first, second]);
  });

  it("returns no partial bodies when restoration fails or source becomes stale", async () => {
    let current = true;
    const batch = await createBatch([block(0, "x=1\n"), block(3, "y=1\n", () => null)], {
      source: "",
      isCurrent: () => current,
    });
    expect(batch.restore(batch.text)).toBeNull();
    current = false;
    expect(batch.restore(batch.text)).toBeNull();
    expect(
      await createBatch([block(0, "x=1\n")], { source: "", isCurrent: () => current }),
    ).toBeNull();
    expect(await createBatch([], options())).toBeNull();
  });

  it("builds a 1000-body edit plan using one scratch buffer and one native diff", async () => {
    const source = Array.from(
      { length: 1000 },
      (_, index) => `# %% Cell ${index}\nvalue_${index}=1\n`,
    ).join("");
    const bodies = Array.from({ length: 1000 }, (_, index) =>
      block(index * 2 + 1, `value_${index}=1\n`),
    );
    const batch = await createBatch(bodies, options(source));
    const checkpoints = spyOn(TextBuffer.prototype, "createCheckpoint").and.callThrough();
    const diffs = spyOn(TextBuffer.prototype, "getChangesToText").and.callThrough();
    const mutations = spyOn(TextBuffer.prototype, "setTextViaDiff").and.callThrough();
    const destroyed = spyOn(TextBuffer.prototype, "destroy").and.callThrough();
    const plan = await batch.getEditPlan(batch.text.replaceAll("=1", " = 1"));
    expect(plan.text).toBe(source.replaceAll("=1", " = 1"));
    expect(plan.fallback).toBe(false);
    expect(checkpoints).not.toHaveBeenCalled();
    expect(diffs).toHaveBeenCalledTimes(1);
    expect(mutations).not.toHaveBeenCalled();
    expect(destroyed).toHaveBeenCalledTimes(1);
    const apply = new TextBuffer({ text: source });
    try {
      for (const edit of [...plan.edits].sort((a, b) => b.oldRange.start.compare(a.oldRange.start)))
        apply.setTextInRange(edit.oldRange, edit.newText, { normalizeLineEndings: false });
      expect(apply.getText()).toBe(plan.text);
    } finally {
      apply.destroy();
    }
  });

  it("prepares 1000 Python-only bodies without a native diff or scratch mutation", async () => {
    const source = Array.from(
      { length: 1000 },
      (_, index) => `#%% Cell ${index}\nvalue_${index}=1\n`,
    ).join("");
    const blocks = Array.from({ length: 1000 }, (_, index) =>
      block(index * 2 + 1, `value_${index}=1\n`),
    );
    const batch = await createBatch(blocks, { ...options(source), allowWholeDocument: true });
    const diff = spyOn(TextBuffer.prototype, "getChangesToText").and.callThrough();
    const mutation = spyOn(TextBuffer.prototype, "setText").and.callThrough();
    const constructed = spyOn(TextBuffer.prototype, "setHistoryProvider").and.callThrough();
    const indices = spyOn(TextBuffer.prototype, "characterIndexForPosition").and.callThrough();
    const positions = spyOn(TextBuffer.prototype, "positionForCharacterIndex").and.callThrough();
    const plan = await batch.getEditPlan(batch.text.replaceAll("=1", " = 1"), [new Point(0, 0)]);
    expect(diff).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
    expect(constructed).not.toHaveBeenCalled();
    expect(indices).not.toHaveBeenCalled();
    expect(positions).not.toHaveBeenCalled();
    expect(plan.edits.length).toBe(1000);
    expect(plan.replaceWholeDocument).toBe(true);
    expect(plan.text).toBe(source.replaceAll("=1", " = 1"));
    expect(plan.edits.every((edit) => edit.oldRange.start.row % 2 === 1)).toBe(true);
  });

  it("refines only changed Python bodies containing a selection endpoint", async () => {
    const source = "#%% One\nfirst=1; middle=2\n#%% Two\nother=3; last=4\n";
    const batch = await createBatch(
      [block(1, "first=1; middle=2\n"), block(3, "other=3; last=4\n")],
      { ...options(source), allowWholeDocument: true },
    );
    const diff = spyOn(TextBuffer.prototype, "getChangesToText").and.callThrough();
    const plan = await batch.getEditPlan(batch.text.replaceAll("=", " = "), [
      new Point(1, 10),
      new Point(1, 16),
    ]);
    expect(diff).toHaveBeenCalledTimes(1);
    expect(plan.edits.filter((edit) => edit.oldRange.start.row === 1).length).toBe(4);
    expect(plan.edits.filter((edit) => edit.oldRange.start.row === 3).length).toBe(1);
    expect(plan.text).toBe(source.replaceAll("=", " = "));
  });

  it("returns original bytes and no edits for a current validated identity result", async () => {
    const source = "#%% Code\r\nvalue = 1\r\n";
    const body = block(1, "value = 1\r\n");
    const restore = spyOn(body, "restore").and.callThrough();
    let current = true;
    const batch = await createBatch([body], {
      source,
      allowWholeDocument: true,
      isCurrent: () => current,
    });
    const result = await batch.getEditPlan(batch.text);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(result.text).toBe(source);
    expect(result.edits).toEqual([]);
    current = false;
    expect(await batch.getEditPlan(batch.text)).toBeNull();
  });

  it("uses complete canonical Python input with exact header restoration and one-module semantics", async () => {
    const source = "# %% One\r\nfirst=1\r\n# %% Two\r\nlast=2\r\n";
    const bodies = [block(1, "first=1\r\n"), block(3, "last=2\r\n")];
    const geometry = bodies.map((body) => ({
      range: body.range,
      start: source.indexOf(body.text),
      end: source.indexOf(body.text) + body.text.length,
    }));
    const batch = await createBatch(bodies, {
      ...options(source),
      allowWholeDocument: true,
      sourceGeometry: geometry,
    });
    expect(batch.text).toBe(source);
    const formatted = source.replaceAll("=", " = ").replaceAll("\r\n", "\n");
    const plan = await batch.getEditPlan(formatted);
    expect(plan.text).toBe("# %% One\r\nfirst = 1\n# %% Two\r\nlast = 2\n");
    expect(plan.edits.every((edit) => [1, 3].includes(edit.oldRange.start.row))).toBe(true);
    for (const unsafe of [
      formatted.replace("# %% One", "# %% Changed"),
      formatted.replace("# %% One", "#%% One"),
      formatted.replace("# %% Two\n", ""),
      formatted.replace("# %% Two", "# %% Added\n# %% Two"),
      formatted.replace("# %% One", "# %% Two").replace(/# %% Two(?=\nlast)/, "# %% One"),
    ])
      expect(await batch.getEditPlan(unsafe)).toBeNull();
  });

  it("keeps noncanonical, duplicate, opaque and synthetic cases on the existing fenced path", async () => {
    for (const markers of [
      ["#%% One", "#%% Two"],
      ["# %% Same", "# %% Same"],
    ]) {
      const source = `${markers[0]}\nfirst=1\n${markers[1]}\nlast=2\n`;
      const bodies = [block(1, "first=1\n"), block(3, "last=2\n")];
      const geometry = bodies.map((body) => ({
        range: body.range,
        start: source.indexOf(body.text),
        end: source.indexOf(body.text) + body.text.length,
      }));
      const batch = await createBatch(bodies, {
        ...options(source),
        allowWholeDocument: true,
        sourceGeometry: geometry,
      });
      expect(batch.text).toContain("__lumine_ipy_batch_");
    }
    const source = "# %% One\nfirst=1\n# %% Two\n%pwd\n";
    const bodies = [block(1, "first=1\n"), block(3, "synthetic_command()\n")];
    const geometry = [
      { range: bodies[0].range, start: source.indexOf("first=1"), end: source.indexOf("# %% Two") },
      { range: bodies[1].range, start: source.indexOf("%pwd"), end: source.length },
    ];
    expect(
      (
        await createBatch(bodies, {
          ...options(source),
          allowWholeDocument: true,
          sourceGeometry: geometry,
        })
      ).text,
    ).toContain("__lumine_ipy_batch_");
    expect(
      (await createBatch(bodies, { ...options(source), sourceGeometry: geometry })).text,
    ).toContain("__lumine_ipy_batch_");
  });

  it("reuses the PEP701 lexer for host headers and ignores marker text inside bodies", async () => {
    const before =
      'value = f"""{f"{ "nested" }"!s:>{width}}\n# %% Quoted\n"""\nitems = [\n# %% Bracket\n1,\n]\nvalue = \\\n# %% Continued\n1\n';
    const header = "# %% One\n",
      middle = "# %% Two\n",
      after = "last=2\n";
    const source = header + before + middle + after;
    const buffer = new TextBuffer({ text: source });
    try {
      const bodies = [
        {
          range: new Range([1, 0], buffer.positionForCharacterIndex(header.length + before.length)),
          text: before,
          restore: (text) => text,
        },
        {
          range: new Range(
            buffer.positionForCharacterIndex(source.length - after.length),
            buffer.getEndPosition(),
          ),
          text: after,
          restore: (text) => text,
        },
      ];
      const geometry = bodies.map((body) => ({
        range: body.range,
        start: source.indexOf(body.text),
        end: source.indexOf(body.text) + body.text.length,
      }));
      const batch = await createBatch(bodies, {
        ...options(source),
        allowWholeDocument: true,
        sourceGeometry: geometry,
      });
      expect(batch.text).toBe(source);
      expect((await batch.getEditPlan(source.replace("last=2", "last = 2"))).text).toBe(
        source.replace("last=2", "last = 2"),
      );
      expect(await batch.getEditPlan(source.replace("last=2", "# %% Extra\nlast = 2"))).toBeNull();
    } finally {
      buffer.destroy();
    }
  });

  it("matches native original and target coordinates when body changes span lines and suffixes", async () => {
    const cases = [
      ["first=1\n# tail\n", "first = 1\n# tail\n"],
      ["value='😀'\r\n# tail\r\n", "value='😁'\r\n# tail\r\n"],
      ["first=1; last=2\r\n# tail\r\n", "first = 1\r\nlast = 2\r\n# tail\r\n"],
      ["first=(\n  1\n)\n", "first = 1\n"],
      ["first=1\rlast=2\n", "first = 1\rlast = 2\n"],
      ["last=1", "last = 1\n"],
    ];
    for (const [before, after] of cases) {
      const header = "#%% First\r\n",
        separator = "#%% Last\n",
        tail = "tail=1\n";
      const source = header + before + (/\n$/.test(before) ? separator + tail : "");
      const original = new TextBuffer({ text: source });
      try {
        const firstRange = new Range(
          original.positionForCharacterIndex(header.length),
          original.positionForCharacterIndex(header.length + before.length),
        );
        const bodies = [{ range: firstRange, text: before, restore: (text) => text }];
        if (/\n$/.test(before))
          bodies.push({
            range: new Range(
              original.positionForCharacterIndex(source.length - tail.length),
              original.getEndPosition(),
            ),
            text: tail,
            restore: (text) => text,
          });
        const batch = await createBatch(bodies, { ...options(source), allowWholeDocument: true });
        const plan = await batch.getEditPlan(
          batch.text.replace(before, after).replace("tail=1", "tail = 1"),
        );
        expect(plan).not.toBeNull();
        const target = new TextBuffer({ text: plan.text });
        try {
          let delta = 0;
          for (const edit of plan.edits) {
            const start = original.characterIndexForPosition(edit.oldRange.start),
              end = original.characterIndexForPosition(edit.oldRange.end);
            const mappedStart = target.positionForCharacterIndex(start + delta),
              mappedEnd = target.positionForCharacterIndex(start + delta + edit.newText.length);
            expect(edit.newRange).toEqual(new Range(mappedStart, mappedEnd));
            delta += edit.newText.length - (end - start);
          }
          for (const edit of plan.edits.toSorted((a, b) =>
            b.oldRange.start.compare(a.oldRange.start),
          ))
            original.setTextInRange(edit.oldRange, edit.newText, { normalizeLineEndings: false });
          expect(original.getText()).toBe(plan.text);
        } finally {
          target.destroy();
        }
      } finally {
        original.destroy();
      }
    }
  });

  it("caches scalar geometry without native buffers and checks supplied offsets against CRLF positions", async () => {
    const source = "#%% One\r\nname='😀'\r\n#%% Two\r\nvalue=1\r\n";
    const bodies = [block(1, "name='😀'\r\n"), block(3, "value=1\r\n")];
    const supplied = bodies.map((body) => ({
      range: body.range,
      start: source.indexOf(body.text),
      end: source.indexOf(body.text) + body.text.length,
    }));
    const batch = await createBatch(bodies, {
      ...options(source),
      allowWholeDocument: true,
      sourceGeometry: supplied,
    });
    const constructed = spyOn(TextBuffer.prototype, "setHistoryProvider").and.callThrough();
    const target = batch.text.replace("value=1", "value = 1");
    expect((await batch.getEditPlan(target)).text).toBe(source.replace("value=1", "value = 1"));
    expect((await batch.getEditPlan(target)).text).toBe(source.replace("value=1", "value = 1"));
    expect(constructed).not.toHaveBeenCalled();
    for (const scalar of [
      { ...supplied[0], start: -1 },
      { ...supplied[0], end: supplied[0].end + 1 },
    ]) {
      const invalid = await createBatch(bodies, {
        ...options(source),
        allowWholeDocument: true,
        sourceGeometry: [scalar, supplied[1]],
      });
      expect(await invalid.getEditPlan(invalid.text)).toBeNull();
    }
  });

  it("keeps UTF-16 surrogate pairs and CRLF intact at fast trim boundaries", async () => {
    const source = "value='😀'\r\n",
      target = "value='😁'\n";
    const body = { ...block(0, source), range: new Range([0, 0], [1, 0]) };
    const batch = await createBatch([body], { ...options(source), allowWholeDocument: true });
    const plan = await batch.getEditPlan(target);
    expect(plan.edits[0].oldRange.start).toEqual(new Point(0, 7));
    const copy = new TextBuffer({ text: source });
    try {
      for (const edit of plan.edits)
        copy.setTextInRange(edit.oldRange, edit.newText, { normalizeLineEndings: false });
      expect(copy.getText()).toBe(target);
    } finally {
      copy.destroy();
    }
  });

  it("matches buffer coordinates when source contains standalone carriage returns", async () => {
    const source = "value=1\rlast=2\r";
    const buffer = new TextBuffer({ text: source });
    try {
      const body = { range: buffer.getRange(), text: source, restore: (text) => text };
      const batch = await createBatch([body], { ...options(source), allowWholeDocument: true });
      const plan = await batch.getEditPlan(source.replaceAll("=", " = "));
      expect(plan?.text).toBe(source.replaceAll("=", " = "));
      for (const edit of plan?.edits || [])
        buffer.setTextInRange(edit.oldRange, edit.newText, { normalizeLineEndings: false });
      expect(buffer.getText()).toBe(plan?.text);
    } finally {
      buffer.destroy();
    }
  });

  it("preserves mixed line endings and opaque bytes while reconstructing the whole target", async () => {
    const source = "# %% First\r\nx=1\r\n# %% [raw]\npayload <😀>\r\n# %% Last\r\ny=2\r\n";
    const batch = await createBatch([block(1, "x=1\r\n"), block(5, "y=2\r\n")], options(source));
    const plan = await batch.getEditPlan(
      batch.text.replace("x=1", "x = 1").replace("y=2", "y = 2"),
    );
    expect(plan.text).toBe(source.replace("x=1", "x = 1").replace("y=2", "y = 2"));
    expect(plan.edits.every((edit) => [1, 5].includes(edit.oldRange.start.row))).toBe(true);
  });

  it("falls back safely when the native differ groups a hunk across a protected header", async () => {
    const source = "# %% First\nx=1\n# %% Last\ny=2\n";
    const batch = await createBatch([block(1, "x=1\n"), block(3, "y=2\n")], options(source));
    const original = TextBuffer.prototype.getChangesToText;
    let calls = 0;
    spyOn(TextBuffer.prototype, "getChangesToText").and.callFake(function (...args) {
      if (++calls === 1)
        return [{ oldRange: new Range([0, 0], [4, 0]), newText: "unsafe grouped replacement" }];
      return original.apply(this, args);
    });
    const plan = await batch.getEditPlan(
      batch.text.replace("x=1", "x = 1").replace("y=2", "y = 2"),
    );
    expect(plan.fallback).toBe(true);
    expect(plan.text).toBe(source.replace("x=1", "x = 1").replace("y=2", "y = 2"));
    expect(plan.edits.every((edit) => [1, 3].includes(edit.oldRange.start.row))).toBe(true);
  });

  it("rejects edits outside the captured selection and source changes during restoration", async () => {
    const source = "# %%\nx=1; y=2\n";
    const selected = new Range([1, 0], [1, 3]);
    const batch = await createBatch([block(1, "x=1; y=2\n")], {
      ...options(source),
      range: selected,
    });
    expect(await batch.getEditPlan("x = 1; y = 2\n")).toBeNull();
    let current = true;
    const stale = await createBatch(
      [
        block(1, "x=1; y=2\n", (text) => {
          current = false;
          return text;
        }),
      ],
      { source, isCurrent: () => current },
    );
    expect(await stale.getEditPlan("x = 1; y = 2\n")).toBeNull();
  });
});

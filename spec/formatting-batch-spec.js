const { Range } = require("lumine");
const createBatch = require("../lib/formatting-batch");

describe("IPython formatting batches", () => {
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
});

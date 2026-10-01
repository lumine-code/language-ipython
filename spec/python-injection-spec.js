const { TextBuffer } = require("lumine");
const pythonContent = require("../lib/python-injection");

describe("Native Python injection ranges", () => {
  let buffer;
  afterEach(() => buffer?.destroy());
  function node(source, children) {
    buffer = new TextBuffer({ text: source });
    return {
      startIndex: 0,
      endIndex: source.length,
      startPosition: buffer.getRange().start,
      endPosition: buffer.getRange().end,
      children,
    };
  }
  it("reuses an ordinary body node without reading or copying its source", () => {
    const body = node("value = 1\n", []);
    spyOn(buffer, "getText");
    expect(pythonContent(body, buffer)).toBe(body);
    expect(buffer.getText).not.toHaveBeenCalled();
  });
  it("subtracts entire assignment rows and merges adjacent magic exclusions", () => {
    const source = "before = (\n  1\n)\ncwd = %pwd\nfiles = !dir\nafter = 2\n";
    const body = node(source, [
      {
        type: "magic_expression",
        startPosition: { row: 3, column: 6 },
        endPosition: { row: 3, column: 10 },
      },
      {
        type: "shell_expression",
        startPosition: { row: 4, column: 8 },
        endPosition: { row: 4, column: 12 },
      },
    ]);
    const ranges = pythonContent(body, buffer);
    expect(ranges.map((range) => source.slice(range.startIndex, range.endIndex))).toEqual([
      "before = (\n  1\n)\n",
      "after = 2\n",
    ]);
    expect(ranges[1].startPosition.row).toBe(5);
  });
  it("clips a final magic row at EOF and returns no synthetic placeholder", () => {
    const body = node("cwd = %pwd", [
      {
        type: "magic_expression",
        startPosition: { row: 0, column: 6 },
        endPosition: { row: 0, column: 10 },
      },
    ]);
    expect(pythonContent(body, buffer)).toEqual([]);
  });
});

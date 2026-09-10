const { Point } = require("lumine");
const fs = require("fs");
const path = require("path");

const highlightsPath = path.join(__dirname, "..", "grammars", "python-highlights.scm");

const CTYPES_FIXTURE_ROWS = 12462;
const CTYPES_FIXTURE_COMMENT_ROWS = 9163;
const CTYPES_FIELDS_PER_CLASS = 96;

function buildCtypesFixture() {
  const lines = ["from ctypes import Structure, c_int"];
  let fieldIndex = 0;
  let classIndex = 0;

  while (fieldIndex < CTYPES_FIXTURE_COMMENT_ROWS) {
    const fieldCount = Math.min(CTYPES_FIELDS_PER_CLASS, CTYPES_FIXTURE_COMMENT_ROWS - fieldIndex);
    lines.push(`class C${classIndex}(Structure):`);
    lines.push("  _fields_ = [");
    for (let memberIndex = 0; memberIndex < fieldCount; memberIndex++, fieldIndex++) {
      lines.push(
        `    ("member_${classIndex}_${memberIndex}", c_int),  # generated ctypes field ${fieldIndex}`,
      );
    }
    lines.push("  ]");
    lines.push(`instance_${classIndex} = C${classIndex}()`);
    classIndex++;
  }

  while (lines.length < CTYPES_FIXTURE_ROWS) {
    lines.push(`PADDING_${String(lines.length).padStart(5, "0")} = 0`);
  }
  return lines.join("\r\n");
}

describe("IPython base Python highlights", () => {
  let editor;
  let languageMode;

  beforeEach(async () => {
    await lumine.packages.activatePackage("language-ipython");
  });

  afterEach(() => editor?.destroy());

  async function setUp(text) {
    editor = await lumine.workspace.open();
    editor.setText(text);
    lumine.grammars.assignLanguageMode(editor.getBuffer(), "source.python.ipy");
    languageMode = editor.getBuffer().languageMode;
    await languageMode.ready;
  }

  function columnFor(row, text, occurrence = 0) {
    const line = editor.lineTextForBufferRow(row);
    let column = -1;
    for (let i = 0; i <= occurrence; i++) column = line.indexOf(text, column + 1);
    expect(column).not.toBe(-1);
    return column;
  }

  function scopesAt(row, text, occurrence = 0) {
    return editor
      .scopeDescriptorForBufferPosition([row, columnFor(row, text, occurrence)])
      .getScopesArray();
  }

  function rawCaptures(startRow, endRow) {
    const layer = languageMode.rootLanguageLayer;
    const options =
      startRow == null
        ? undefined
        : {
            startPosition: new Point(startRow, 0),
            endPosition: new Point(endRow, 0),
          };
    return layer.queries.highlightsQuery.captures(layer.tree.rootNode, options);
  }

  it("keeps unbounded containers leaf-rooted", () => {
    const querySource = fs.readFileSync(highlightsPath, "utf8");
    expect(querySource).not.toMatch(
      /\((?:argument_list|dictionary|list|parameters|subscript|tuple|type_parameter)\s*\n\s*(?:"|\(pair)/,
    );
    expect(querySource).toContain("(#is? test.childOfType argument_list)");
    expect(querySource).toContain("(#is? test.childOfType dictionary)");
    expect(querySource).not.toContain("(string_content (escape_sequence)");
    expect(querySource).toContain("(#is? test.childOfType string_content)");
  });

  it("scopes Python container punctuation including subscripts", async () => {
    await setUp(`def function(a, b):
  function(a, b)
  tuple_value = (a, b)
  dictionary = {key: a, other: b}
  list_value = [a, b]
  item = obj[0]
  destructured_a, destructured_b = tuple_value
  lambda_value = lambda a, b: (a, b)

class Container[T]:
  pass`);

    expect(scopesAt(0, ",")).toContain("punctuation.separator.parameters.comma.python");
    expect(scopesAt(1, ",")).toContain("punctuation.separator.arguments.comma.python");
    expect(scopesAt(2, ",")).toContain("punctuation.separator.tuple.comma.python");
    expect(scopesAt(3, ":")).toContain("punctuation.separator.key-value.python");
    expect(scopesAt(3, ",")).toContain("punctuation.separator.dictionary.comma.python");
    expect(scopesAt(4, "[")).toContain("punctuation.definition.list.begin.bracket.square.python");
    expect(scopesAt(5, "[")).toContain(
      "punctuation.definition.subscript.begin.bracket.square.python",
    );
    expect(scopesAt(5, "]")).toContain(
      "punctuation.definition.subscript.end.bracket.square.python",
    );
    expect(scopesAt(6, ",")).toContain("punctuation.separator.destructuring.comma.python");
    expect(scopesAt(7, ",", 0)).toContain("punctuation.separator.parameters.comma.python");
    expect(scopesAt(7, ",", 1)).toContain("punctuation.separator.tuple.comma.python");
    expect(scopesAt(9, "[")).toContain("punctuation.definition.list.begin.bracket.square.python");
  });

  it("returns only local punctuation from multiline Python parents", async () => {
    await setUp(`def function(
  first,
  second,
):
  return function(
    first,
    second,
  )

mapping = {
  "first": 1,
  "second": 2,
}`);

    const ranges = [
      {
        startRow: 2,
        endRow: 4,
        family: ".parameters.",
        expected: [
          ["punctuation.separator.parameters.comma.python", 2],
          ["punctuation.definition.parameters.end.bracket.round.python", 3],
        ],
      },
      {
        startRow: 6,
        endRow: 8,
        family: ".arguments.",
        expected: [
          ["punctuation.separator.arguments.comma.python", 6],
          ["punctuation.definition.arguments.end.bracket.round.python", 7],
        ],
      },
      {
        startRow: 11,
        endRow: 13,
        family: null,
        expected: [
          ["punctuation.separator.key-value.python", 11],
          ["punctuation.definition.dictionary.end.bracket.curly.python", 12],
        ],
      },
    ];

    for (const { startRow, endRow, family, expected } of ranges) {
      const expectedNames = new Set(expected.map(([name]) => name));
      const captures = rawCaptures(startRow, endRow).filter(
        (capture) =>
          capture.name.startsWith("punctuation.") &&
          (family ? capture.name.includes(family) : expectedNames.has(capture.name)),
      );
      expect(
        captures.every(
          (capture) =>
            capture.node.startPosition.row >= startRow && capture.node.startPosition.row < endRow,
        ),
      ).toBe(true);
      for (const [name, row] of expected) {
        expect(
          captures.some(
            (capture) => capture.name === name && capture.node.startPosition.row === row,
          ),
        ).toBe(true);
      }
    }
  });

  it("preserves Python string and callee-specific function scopes", async () => {
    await setUp(`plain = "value"
raw = r'value'
formatted = f"""value {plain}"""
unfinished = """value
__len__(value)
obj.__len__(value)
wrapper(__len__)
len(value)
wrapper(len)
exec(value)
wrapper(exec)
def __len__(self):
  return 0`);

    expect(scopesAt(0, '"', 0)).toContain("punctuation.definition.string.begin.python");
    expect(scopesAt(0, '"', 1)).toContain("punctuation.definition.string.end.python");
    expect(scopesAt(1, "r'")).toContain("storage.type.string.python");
    expect(scopesAt(2, "{")).toContain("punctuation.section.embedded.begin.python");
    expect(scopesAt(2, '"""', 1)).toContain("punctuation.definition.string.end.python");
    expect(scopesAt(3, '"""')).toContain("punctuation.definition.string.begin.python");
    expect(scopesAt(4, "__len__")).toContain("support.function.magic.python");
    expect(scopesAt(5, "__len__")).toContain("support.function.magic.python");
    expect(scopesAt(6, "__len__")).not.toContain("support.function.magic.python");
    expect(scopesAt(7, "len")).toContain("support.function.builtin.python");
    expect(scopesAt(8, "len")).not.toContain("support.function.builtin.python");
    expect(scopesAt(11, "__len__")).toContain("entity.name.function.magic.python");

    const legacyCaptures = rawCaptures().filter(
      (capture) => capture.name === "keyword.other._TEXT_.python" && capture.node.text === "exec",
    );
    expect(legacyCaptures.map((capture) => capture.node.startPosition.row)).toEqual([9]);
  });

  it("uses the rebuilt parser that excludes CR from format specifiers", async () => {
    await setUp('value = f"""{item:>10\r\n}"""');

    const formatSpecifier =
      languageMode.rootLanguageLayer.tree.rootNode.descendantsOfType("format_specifier")[0];
    expect(formatSpecifier.text).toBe(":>10");
    expect(formatSpecifier.endPosition).toEqual(
      new Point(0, editor.lineTextForBufferRow(0).length),
    );
  });

  it("keeps raw capture counts bounded for a large CRLF ctypes fixture", async () => {
    const fixture = buildCtypesFixture();
    expect(fixture.split("\r\n").length).toBe(CTYPES_FIXTURE_ROWS);
    expect(fixture.match(/# generated ctypes field/g).length).toBe(CTYPES_FIXTURE_COMMENT_ROWS);
    await setUp(fixture);

    const fullCaptures = rawCaptures();
    const viewportCaptures = rawCaptures(3, 76);
    const tileCaptures = rawCaptures(3, 9);

    // The renderer never asks for the full file. Leaf-rooted candidates make
    // that diagnostic count larger, but keep tile cost independent of a
    // collection that began thousands of rows before the viewport.
    expect(fullCaptures.length).toBeGreaterThan(CTYPES_FIXTURE_ROWS);
    expect(fullCaptures.length).toBeLessThanOrEqual(220000);
    expect(viewportCaptures.length).toBeLessThanOrEqual(1650);
    expect(tileCaptures.length).toBeLessThanOrEqual(140);
  });

  it("keeps tile query work bounded inside a large dictionary parent", async () => {
    const lines = ["mapping = {"];
    for (let index = 0; index < 6000; index++) lines.push(`  "key_${index}": ${index},`);
    lines.push("}");
    await setUp(lines.join("\r\n"));

    expect(rawCaptures(3000, 3006).length).toBeLessThanOrEqual(64);
  });

  it("keeps escapes local inside a large triple-quoted string", async () => {
    const lines = ['value = """'];
    for (let index = 0; index < 6000; index++) lines.push(`  \\nvalue_${index}`);
    lines.push('"""');
    await setUp(lines.join("\r\n"));

    expect(scopesAt(3000, "\\n")).toContain("constant.character.escape.python");
    const captures = rawCaptures(3000, 3006).filter(
      ({ name }) => name === "constant.character.escape.python",
    );
    expect(captures.length).toBe(6);
    expect(
      captures.every(({ node }) => node.startPosition.row >= 3000 && node.startPosition.row < 3006),
    ).toBe(true);
  });
});

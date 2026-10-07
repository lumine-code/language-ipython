const fs = require("fs");
const path = require("path");

describe("IPython cell bodies", () => {
  let editor;
  let mode;
  const packagePath = (name) => {
    const sibling = path.resolve(__dirname, "..", "..", name);
    return fs.existsSync(sibling) ? sibling : name;
  };
  const scopesAt = (row, column = 0) =>
    editor.scopeDescriptorForBufferPosition([row, column]).getScopesArray();
  const root = () => mode.rootLanguageLayer.tree.rootNode;
  const bodyLayers = () =>
    mode
      .getAllInjectionLayers()
      .filter((layer) => layer.depth === 1 && layer.grammar.scopeName !== "source.python");
  const pythonLayer = () =>
    mode
      .getAllInjectionLayers()
      .find((layer) => layer.depth === 1 && layer.grammar.scopeName === "source.python");

  async function setUp(source) {
    editor = await lumine.workspace.open();
    editor.setText(source);
    lumine.grammars.assignLanguageMode(editor.getBuffer(), "source.python.ipy");
    mode = editor.getBuffer().getLanguageMode();
    await mode.ready;
    await mode.atGrammarSettlement();
  }

  beforeEach(async () => {
    for (const name of [
      "language-ipython",
      "language-python",
      "language-gfm",
      "language-html",
      "language-shellscript",
      "language-javascript",
    ]) {
      await lumine.packages.activatePackage(packagePath(name));
    }
  });

  afterEach(() => editor?.destroy());

  it("keeps nested marker text inside template-string interpolation", async () => {
    const source = (prefix) =>
      `value = ${prefix}"""{f"""\n# %% [raw] Inside\n"""}\n"""\n# %% Actual\nx=1\n`;
    await setUp(source("t"));
    const assertBoundaries = () => {
      expect(root().hasError).toBe(false);
      expect(
        root()
          .descendantsOfType("cell_marker")
          .map((node) => node.text),
      ).toEqual(["# %% Actual"]);
      expect(root().descendantsOfType("raw_cell").length).toBe(0);
      expect(bodyLayers().length).toBe(0);
    };
    assertBoundaries();
    let previous = "t";
    for (const prefix of ["T", "rt", "tr", "rT", "tR", "RT", "TR", "f", "F", "rf", "fr"]) {
      editor.getBuffer().setTextInRange(
        [
          [0, 8],
          [0, 8 + previous.length],
        ],
        prefix,
      );
      await mode.atGrammarSettlement();
      assertBoundaries();
      previous = prefix;
    }
  });

  it("treats compact and flagged navigation markers as code-cell headers", async () => {
    const headers = [
      "#%%",
      "#%%$#",
      "#%%$$p# Definitions",
      "#%%$$s*_<;# Strings",
      "#%%$$v+;_<# Variables",
      "#%%$$1-<_;# First word",
      "#%%?!_<;# Automatic",
      "#%%$$# [markdown] remains a title",
    ];
    await setUp(
      headers.map((header, index) => `${header}\r\nvalue_${index} = ${index}\r\n`).join("") +
        "#%%$$p#",
    );
    expect(root().hasError).toBe(false);
    const cells = root().namedChildren;
    expect(cells.map((node) => node.type)).toEqual(Array(headers.length + 1).fill("code_cell"));
    for (let index = 0; index < headers.length; index++) {
      const marker = cells[index].childForFieldName("marker");
      expect(marker.text).toBe(headers[index]);
      expect(marker.childForFieldName("marker").text).toBe("#%%");
      expect(marker.childForFieldName("metadata")).toBeNull();
      expect(cells[index].childForFieldName("body").text).toBe(`value_${index} = ${index}\r\n`);
      for (const column of [0, 1, headers[index].length - 1]) {
        expect(scopesAt(index * 2, column)).toContain(
          "comment.line.number-sign.cell-marker.ipython",
        );
      }
      expect(scopesAt(index * 2 + 1, 1)).toContain("source.python");
    }
    expect(cells.at(-1).childForFieldName("marker").text).toBe("#%%$$p#");
    expect(cells.at(-1).childForFieldName("body")).toBeNull();
    const python = pythonLayer();
    expect(python.tree.rootNode.hasError).toBe(false);
    expect(python.tree.rootNode.descendantsOfType("comment")).toEqual([]);
    expect(python.tree.rootNode.descendantsOfType("assignment").length).toBe(headers.length);
    expect(
      mode.getAllInjectionLayers().filter((layer) => layer.grammar.scopeName === "source.python")
        .length,
    ).toBe(1);
  });

  it("updates cell boundaries when adding or removing percent signs from a navigation marker", async () => {
    await setUp("#%%$# First\nbefore = 1\n#$$p# Later\nafter = 2\n");
    const python = pythonLayer();
    const parser = mode.getOrCreateParserForLanguage(python.language);
    expect(parser).toBeDefined();
    expect(root().namedChildren.length).toBe(1);
    expect(python.tree.rootNode.descendantsOfType("comment").map((node) => node.text)).toEqual([
      "#$$p# Later",
    ]);
    editor.setTextInBufferRange(
      [
        [2, 1],
        [2, 1],
      ],
      "%%",
    );
    await mode.atGrammarSettlement();
    expect(root().hasError).toBe(false);
    expect(root().namedChildren.length).toBe(2);
    expect(root().namedChild(1).childForFieldName("marker").text).toBe("#%%$$p# Later");
    expect(pythonLayer()).toBe(python);
    expect(mode.getOrCreateParserForLanguage(python.language)).toBe(parser);
    expect(python.tree.rootNode.descendantsOfType("comment")).toEqual([]);
    expect(scopesAt(2, 4)).toContain("comment.line.number-sign.cell-marker.ipython");
    editor.setTextInBufferRange(
      [
        [2, 1],
        [2, 3],
      ],
      "",
    );
    await mode.atGrammarSettlement();
    expect(root().hasError).toBe(false);
    expect(root().namedChildren.length).toBe(1);
    expect(pythonLayer()).toBe(python);
    expect(mode.getOrCreateParserForLanguage(python.language)).toBe(parser);
    expect(python.tree.rootNode.descendantsOfType("comment").map((node) => node.text)).toEqual([
      "#$$p# Later",
    ]);
  });

  it("preserves legacy navigation annotations beside literal and magic cells", async () => {
    await setUp(
      [
        "#%%$# Parent",
        "value = 1",
        "# %% [markdown] Notes",
        "# Heading",
        "#%%$$# Child",
        "%%time",
        "#$$p# Timed annotation",
        "timed = 2",
        "# %% [raw] Data",
        "raw <payload>",
        "#%%$$p!_<;# HTML annotation",
        "%%html",
        "<h1>Heading</h1>",
        "#%%$$v+<# Final",
        "final = 3 #$$v# Inline annotation",
        "",
      ].join("\n"),
    );
    expect(root().hasError).toBe(false);
    const legacy = root()
      .descendantsOfType("cell_marker")
      .filter((node) => node.childForFieldName("marker").text === "#%%");
    expect(legacy.map((node) => node.childForFieldName("name").text)).toEqual([
      "$# Parent",
      "$$# Child",
      "$$p!_<;# HTML annotation",
      "$$v+<# Final",
    ]);
    expect(legacy.map((node) => node.childForFieldName("metadata"))).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(legacy.map((node) => node.startPosition.row)).toEqual([0, 4, 10, 13]);
    expect(
      pythonLayer()
        .tree.rootNode.descendantsOfType("comment")
        .map((node) => node.text),
    ).toEqual(["#$$p# Timed annotation", "#$$v# Inline annotation"]);
    expect(root().descendantsOfType("markdown_cell")[0].childForFieldName("body").text).toBe(
      "# Heading\n",
    );
    expect(root().descendantsOfType("raw_cell")[0].childForFieldName("body").text).toBe(
      "raw <payload>\n",
    );
    expect(bodyLayers().map((layer) => layer.grammar.scopeName)).toEqual([
      "source.gfm",
      "text.html.basic",
    ]);
    expect(scopesAt(3, 2)).toContain("source.gfm");
    expect(scopesAt(9, 2)).toContain("text.plain");
    expect(scopesAt(12, 2)).toContain("text.html.basic");
  });

  it("injects each literal Markdown body once and isolates an unfinished fence", async () => {
    await setUp(
      "# %% [markdown] First\n# Heading\n```python\nvalue = 1\n# %% [markdown] Second\n# Next\n**bold**\n# %%\nafter = 2\n",
    );
    expect(root().hasError).toBe(false);
    expect(root().namedChildren.map((node) => node.type)).toEqual([
      "markdown_cell",
      "markdown_cell",
      "code_cell",
    ]);
    expect(bodyLayers().length).toBe(2);
    expect(scopesAt(1, 2)).toContain("source.gfm");
    expect(scopesAt(5, 2)).toContain("source.gfm");
    expect(scopesAt(6, 3).some((scope) => scope.includes("bold"))).toBe(true);
    expect(scopesAt(8, 1)).not.toContain("source.gfm");
  });

  it("keeps raw and unknown magic bodies plain without another parser", async () => {
    await setUp(
      "# %% [raw]\n# payload { <broken>\n# %%\n%%custom\nnot Python }\n# %%\nafter = 1\n",
    );
    expect(root().hasError).toBe(false);
    expect(scopesAt(1, 3)).toContain("text.plain");
    expect(scopesAt(4, 3)).toContain("text.plain");
    expect(bodyLayers().length).toBe(0);
    expect(root().namedChildren.at(-1).type).toBe("code_cell");
  });

  it("aligns large opaque edits without splitting injection or projection ownership", async () => {
    jasmine.useRealClock();
    for (const [kind, row] of [
      ["raw", "# x\n"],
      ["markdown", "# Notes\n"],
    ]) {
      editor?.destroy();
      const header = `# %% [${kind}]\n`;
      const bodyPrefix = kind === "markdown" ? "```\n" : "";
      const bodySuffix = kind === "markdown" ? "```\n" : "";
      const bodyText = bodyPrefix + row.repeat(Math.ceil(1048576 / row.length)) + bodySuffix;
      await setUp(header + bodyText + "# %% Next\nafter = 1\n");
      const layer = mode.rootLanguageLayer;
      expect(layer.queries.parseBoundariesQuery).toBeDefined();
      const parser = mode.getOrCreateParserForLanguage(layer.language);
      let lexed = 0;
      parser.setLogger((message) => {
        if (message.startsWith("lexed_lookahead")) lexed++;
      });
      const calls = [];
      const original = mode.parseAsync.bind(mode);
      const spy = spyOn(mode, "parseAsync").and.callFake((language, oldTree, ranges, options) => {
        if (language === layer.language && oldTree) calls.push(ranges);
        return original(language, oldTree, ranges, options);
      });
      try {
        const editRow = kind === "markdown" ? 2 : 1;
        editor.setTextInBufferRange(
          [
            [editRow, row.length - 1],
            [editRow, row.length - 1],
          ],
          "\n",
        );
        await editor.whenGrammarSettled();
      } finally {
        parser.setLogger(null);
        spy.and.callThrough();
      }
      expect(lexed).toBeLessThan(24);
      expect(calls.length).toBeGreaterThan(0);
      const hints = calls.at(-1);
      expect(hints.length).toBeGreaterThan(200);
      for (let index = 1; index < hints.length; index++)
        expect(hints[index - 1].endIndex).toBe(hints[index].startIndex);
      expect(root().hasError).toBe(false);
      const body = root().namedChild(0).childForFieldName("body");
      const insertionIndex = bodyPrefix.length + row.length - 1;
      expect(body.text).toBe(
        bodyText.slice(0, insertionIndex) + "\n" + bodyText.slice(insertionIndex),
      );
      if (kind === "markdown") {
        expect(bodyLayers().length).toBe(1);
        expect(bodyLayers()[0].tree.getIncludedRanges().length).toBe(1);
        expect(scopesAt(3, 0)).toContain("source.gfm");
      } else expect(bodyLayers().length).toBe(0);
      const projection = await lumine.packages
        .getActivePackage("language-ipython")
        .mainModule.provideIPythonSource()
        .project(editor);
      expect(projection.isPythonPosition([3, 0])).toBe(false);
      const blocks = await projection.getFormattingBlocks();
      expect(blocks.length).toBe(1);
      expect(blocks[0].text).toBe("after = 1\n");
      expect(blocks[0].restore(blocks[0].text)).toBe("after = 1\n");
      spy.and.callThrough();
    }
  });

  it("keeps trailing header whitespace out of literal and magic bodies", async () => {
    await setUp("# %% [raw] \t \r\npayload\r\n# %%\r\n%%html \t \r\n<h1>Heading</h1>\r\n");
    expect(root().hasError).toBe(false);
    expect(root().namedChild(0).childForFieldName("body").text).toBe("payload\r\n");
    expect(bodyLayers().length).toBe(1);
    expect(scopesAt(4, 2)).toContain("text.html.basic");
  });

  it("injects original language packages into foreign magic bodies", async () => {
    await setUp(
      "%%bash -x\necho hello\n# %%\n%%html\n<h1>Hi</h1>\n# %%\n%%javascript\nconst value = 1;\n# %%\n%%python3\nanswer = 42\n",
    );
    expect(root().hasError).toBe(false);
    expect(bodyLayers().map((layer) => layer.grammar.scopeName)).toEqual([
      "source.shell",
      "text.html.basic",
      "source.js",
    ]);
    expect(scopesAt(0, 3)).toContain("support.function.magic.ipython");
    expect(scopesAt(1, 2)).toContain("source.shell");
    expect(scopesAt(4, 2)).toContain("text.html.basic");
    expect(scopesAt(7, 2)).toContain("source.js");
    expect(scopesAt(10, 2)).toContain("source.python");
  });

  it("preserves symbols and Python parsing under Python cell magics", async () => {
    await setUp(
      "%%capture output\nvalue = 1\ndef work():\n    return value\n# %% Next\nafter = 2\n",
    );
    expect(root().hasError).toBe(false);
    expect(root().descendantsOfType("cell_magic")[0].childForFieldName("body").type).toBe(
      "python_cell_body",
    );
    const groups = await editor.getGrammarQueryCaptureGroups("tagsQuery");
    const definitions = groups
      .flatMap((group) => group.captures)
      .filter((capture) => capture.name === "definition.constant");
    expect(definitions.map((capture) => capture.node.text)).toEqual(["value = 1", "after = 2"]);
    expect(bodyLayers().length).toBe(0);
    expect(pythonLayer().grammar.scopeName).toBe("source.python");
  });

  it("rebuilds injections after changing a raw marker to Markdown", async () => {
    await setUp("# %% [raw]\n# Heading\n# %%\nafter = 1\n");
    expect(bodyLayers().length).toBe(0);
    editor.setTextInBufferRange(
      [
        [0, 6],
        [0, 9],
      ],
      "markdown",
    );
    await mode.atGrammarSettlement();
    expect(root().hasError).toBe(false);
    expect(root().namedChild(0).type).toBe("markdown_cell");
    expect(bodyLayers().length).toBe(1);
    expect(scopesAt(1, 3)).toContain("source.gfm");
  });

  it("uses static language rules without adding duplicate registrations after reactivation", async () => {
    const grammar = lumine.grammars.grammarForScopeName("source.python.ipy");
    expect(grammar.injectionPointsByType.markdown_cell).toBeUndefined();
    expect(grammar.injectionPointsByType.cell_magic).toBeUndefined();
    expect(grammar.injectionPointsByType.python_cell_body).toBeUndefined();
    await lumine.packages.deactivatePackage("language-ipython");
    expect(grammar.injectionPointsByType.markdown_cell).toBeUndefined();
    expect(grammar.injectionPointsByType.cell_magic).toBeUndefined();
    expect(grammar.injectionPointsByType.python_cell_body).toBeUndefined();
    const pack = await lumine.packages.activatePackage(packagePath("language-ipython"));
    expect(pack.mainModule).toBeDefined();
    expect(grammar.injectionPointsByType.markdown_cell).toBeUndefined();
    expect(grammar.injectionPointsByType.cell_magic).toBeUndefined();
    expect(grammar.injectionPointsByType.python_cell_body).toBeUndefined();
    await setUp("# %% [markdown]\n# Heading\n# %%\n%%html\n<h1>Hi</h1>\n# %%\nvalue = 1\n");
    expect(bodyLayers().map((layer) => layer.grammar.scopeName)).toEqual([
      "source.gfm",
      "text.html.basic",
    ]);
    expect(pythonLayer().grammar.scopeName).toBe("source.python");
  });

  it("uses one native Python module across ordinary cells, wrappers and interpreter aliases", async () => {
    await setUp(
      "before = 1\n# %% Timed\n%%time\ndef work():\n    return before\n# %% Interpreter\n%%python3\nafter = work()\n# %% Final\nlast = after\n",
    );
    expect(root().hasError).toBe(false);
    expect(
      root().descendantsOfType(["assignment", "function_definition", "identifier"]).length,
    ).toBe(0);
    const layers = mode
      .getAllInjectionLayers()
      .filter((layer) => layer.depth === 1 && layer.grammar.scopeName === "source.python");
    expect(layers.length).toBe(1);
    expect(layers[0].grammar).toBe(lumine.grammars.grammarForScopeName("source.python"));
    expect(layers[0].tree.rootNode.hasError).toBe(false);
    expect(
      layers[0].tree.rootNode.descendantsOfType("function_definition")[0].childForFieldName("name")
        .text,
    ).toBe("work");
    expect(
      layers[0].tree.rootNode
        .descendantsOfType("assignment")
        .map((node) => node.childForFieldName("left").text),
    ).toEqual(["before", "after", "last"]);
  });

  it("omits complete magic rows from native parsing without losing preceding multiline code", async () => {
    await setUp(
      "total = (\n    1 + 2\n)\ncwd = %pwd\nfiles = !dir\n%matplotlib inline\n!echo hello\n?total\nlast = total\n",
    );
    expect(root().hasError).toBe(false);
    const python = pythonLayer();
    expect(python.tree.rootNode.hasError).toBe(false);
    expect(
      python.tree.rootNode
        .descendantsOfType("assignment")
        .map((node) => node.childForFieldName("left").text),
    ).toEqual(["total", "last"]);
    // Layer containment includes range endpoints; probe within each omitted
    // row rather than at the preceding code range's endpoint.
    for (let row = 3; row <= 7; row++) expect(python.containsPoint({ row, column: 1 })).toBe(false);
    expect(scopesAt(3, 8)).toContain("support.function.magic.ipython");
    expect(scopesAt(4, 10)).toContain("string.unquoted.shell.ipython");
  });

  it("keeps the scaffold valid when native Python must recover from an omitted magic-only suite", async () => {
    await setUp("if enabled:\n    %pwd\n# %% Later\nlast = 1\n");
    expect(root().hasError).toBe(false);
    expect(root().descendantsOfType("magic_statement").length).toBe(1);
    expect(pythonLayer().containsPoint({ row: 1, column: 4 })).toBe(false);
    expect(
      pythonLayer()
        .tree.rootNode.descendantsOfType("assignment")
        .some((node) => node.childForFieldName("left").text === "last"),
    ).toBe(true);
  });

  it("uses native Python indentation and folding inside the document scaffold", async () => {
    await setUp(
      "# %% Code\ndef work():\n    value = 1\n    return value\n# %% [raw]\n    raw payload\n",
    );
    expect(editor.suggestedIndentForBufferRow(2)).toBe(1);
    expect(editor.isFoldableAtBufferRow(1)).toBe(true);
    expect(editor.isFoldableAtBufferRow(0)).toBe(true);
    expect(pythonLayer().containsPoint({ row: 5, column: 4 })).toBe(false);
  });
});

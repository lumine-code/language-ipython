const path = require("path");

describe("IPython magic command highlights", () => {
  let editor;
  let nativeEditor;
  let mode;

  const root = () => mode.rootLanguageLayer.tree.rootNode;
  const scopesAt = (row, column) =>
    editor.scopeDescriptorForBufferPosition([row, column]).getScopesArray();
  const pythonScopes = (scopes) => scopes.filter((scope) => scope.endsWith(".python"));

  beforeEach(async () => {
    await lumine.packages.activatePackage(path.resolve(__dirname, "..", "..", "language-python"));
    await lumine.packages.activatePackage(path.resolve(__dirname, ".."));
  });

  afterEach(() => {
    editor?.destroy();
    nativeEditor?.destroy();
  });

  async function setUp(source) {
    editor = await lumine.workspace.open();
    editor.setText(source);
    lumine.grammars.assignLanguageMode(editor.getBuffer(), "source.python.ipy");
    mode = editor.getBuffer().getLanguageMode();
    await editor.whenGrammarSettled();
  }

  function columnFor(row, text, occurrence = 0) {
    const line = editor.lineTextForBufferRow(row);
    let column = -1;
    for (let index = 0; index <= occurrence; index++) column = line.indexOf(text, column + 1);
    expect(column).not.toBe(-1);
    return column;
  }

  function scopesFor(row, text, occurrence = 0) {
    return scopesAt(row, columnFor(row, text, occurrence));
  }

  async function expectNativePython(row, source, tokens) {
    nativeEditor?.destroy();
    nativeEditor = lumine.workspace.buildTextEditor();
    nativeEditor.setText(source);
    lumine.grammars.assignLanguageMode(nativeEditor.getBuffer(), "source.python");
    await nativeEditor.whenGrammarSettled();
    const payloadStart = columnFor(row, source);
    let referenceHasTokenScopes = false;
    for (const token of tokens) {
      const column = source.indexOf(token);
      expect(column).not.toBe(-1);
      const scopes = scopesAt(row, payloadStart + column);
      const reference = nativeEditor.scopeDescriptorForBufferPosition([0, column]).getScopesArray();
      referenceHasTokenScopes ||= pythonScopes(reference).some(
        (scope) => scope !== "source.python",
      );
      expect(scopes).toContain("source.python");
      expect(pythonScopes(scopes)).toEqual(pythonScopes(reference));
      expect(scopes).not.toContain("support.function.magic.ipython");
      expect(scopes).not.toContain("string.unquoted.arguments.ipython");
    }
    expect(referenceHasTokenScopes).toBe(true);
  }

  it("uses native Python highlights for the expression following timeit", async () => {
    const source = "prs.nodes_dissup(151, name='sample') if enabled else obj.VALUE + len(items)";
    await setUp(`%timeit ${source}\n`);

    expect(root().hasError).toBe(false);
    expect(scopesFor(0, "timeit")).toContain("support.function.magic.ipython");
    expect(scopesAt(0, 0)).toContain("punctuation.definition.magic.ipython");
    await expectNativePython(0, source, [
      "prs",
      ".",
      "nodes_dissup",
      "(",
      "151",
      ",",
      "name",
      "=",
      "'sample'",
      "if",
      "else",
      "VALUE",
      "+",
      "len",
    ]);
  });

  it("highlights documentation queries as help without creating magic body injections", async () => {
    await setUp("%%timeit?\nnp.*?\nitems[0]??\n# %% Next\nvalue = 1\n");
    expect(root().hasError).toBe(false);
    expect(
      root()
        .descendantsOfType("help_statement")
        .map((node) => node.text),
    ).toEqual(["%%timeit?", "np.*?", "items[0]??"]);
    expect(root().descendantsOfType("cell_magic").length).toBe(0);
    for (const [row, text] of [
      [0, "timeit"],
      [1, "np.*"],
      [2, "items"],
    ]) {
      expect(scopesFor(row, text)).toContain("keyword.operator.help.ipython");
      expect(scopesFor(row, text)).not.toContain("support.function.magic.ipython");
    }
    expect(scopesFor(4, "1")).toContain("constant.numeric.integer.python");
  });

  it("keeps shell continuations opaque and injects executable code after continued timeit options", async () => {
    const join = "\\\r\n";
    await setUp(
      "!echo one " + join + "  two\r\n%timeit -n " + join + "  2 work(9)\r\nafter = 1\r\n",
    );
    expect(root().hasError).toBe(false);
    expect(root().descendantsOfType("shell_statement")[0].text).toBe("!echo one " + join + "  two");
    expect(scopesFor(1, "two")).toContain("string.unquoted.shell.ipython");
    expect(scopesFor(1, "two")).not.toContain("source.python");
    await expectNativePython(3, "work(9)", ["work", "9"]);
    expect(scopesFor(4, "1")).toContain("constant.numeric.integer.python");
  });

  it("distinguishes the Python tails of other built-in magics", async () => {
    const expression = "obj.calculate(9) + 2";
    const configuration = "InlineBackend.figure_format = 'retina'";
    await setUp(
      [
        `%time ${expression}`,
        `%prun ${expression}`,
        `%debug ${expression}`,
        `%config ${configuration}`,
        "",
      ].join("\n"),
    );

    expect(root().hasError).toBe(false);
    for (let row = 0; row < 3; row++) {
      expect(scopesAt(row, 1)).toContain("support.function.magic.ipython");
      await expectNativePython(row, expression, ["calculate", "9", "+", "2"]);
    }
    await expectNativePython(3, configuration, ["figure_format", "=", "'retina'"]);
  });

  it("keeps spaced, attached, grouped and quoted options outside the Python expression", async () => {
    const expression = "prs.spt(9)";
    const options = ["-n 10 -r 3 -q", "-n10 -r3 -q", "-qr3 -n10", "-n \"10\" -r '3'", "--"];
    await setUp(
      options.map((argumentsText) => `%timeit ${argumentsText} ${expression}\n`).join(""),
    );

    expect(root().hasError).toBe(false);
    for (let row = 0; row < options.length; row++) {
      const start = columnFor(row, options[row]);
      for (let offset = 0; offset < options[row].length; offset++) {
        if (/\s/.test(options[row][offset])) continue;
        const scopes = scopesAt(row, start + offset);
        expect(scopes).toContain("string.unquoted.arguments.ipython");
        expect(scopes).not.toContain("source.python");
        expect(scopes).not.toContain("support.function.magic.ipython");
      }
      await expectNativePython(row, expression, ["spt", "9"]);
    }
  });

  it("keeps profiling options and their quoted values separate from the code", async () => {
    const argumentsText = '-l 10 -s "cumulative" -D "profile dump.prof"';
    const expression = "work(151)";
    await setUp(`%prun ${argumentsText} ${expression}\n`);

    expect(root().hasError).toBe(false);
    for (const token of ["-l", "10", "-s", "cumulative", "-D", "profile", "dump.prof"]) {
      const scopes = scopesFor(0, token);
      expect(scopes).toContain("string.unquoted.arguments.ipython");
      expect(scopes).not.toContain("source.python");
      expect(scopes).not.toContain("support.function.magic.ipython");
    }
    await expectNativePython(0, expression, ["work", "151"]);
  });

  it("distinguishes time and debugger options from the Python expression", async () => {
    const expression = "work(151)";
    const cases = [
      ["time", "--no-raise-error"],
      ["debug", '-b "module name.py:12"'],
      ["debug", '--breakpoint "module name.py:12"'],
      ["debug", '--breakpoint="module name.py:12"'],
      ["debug", "--breakpoint='module name.py:12'"],
    ];
    await setUp(
      cases.map(([name, argumentsText]) => `%${name} ${argumentsText} ${expression}\n`).join(""),
    );

    expect(root().hasError).toBe(false);
    for (let row = 0; row < cases.length; row++) {
      const [, argumentsText] = cases[row];
      const start = columnFor(row, argumentsText);
      for (let offset = 0; offset < argumentsText.length; offset++) {
        if (/\s/.test(argumentsText[offset])) continue;
        const scopes = scopesAt(row, start + offset);
        expect(scopes).toContain("string.unquoted.arguments.ipython");
        expect(scopes).not.toContain("source.python");
        expect(scopes).not.toContain("support.function.magic.ipython");
      }
      await expectNativePython(row, expression, ["work", "151"]);
    }
  });

  it("leaves malformed and unknown options raw rather than highlighting them as Python", async () => {
    const cases = [
      ["timeit", "--unknown work(1)"],
      ["timeit", "-n 10 -z work(1)"],
      ["timeit", "-n"],
      ["prun", "--unknown work(1)"],
      ["debug", "--breakpoint"],
      ["debug", "-b 'module name.py:12 work(1)"],
    ];
    await setUp(cases.map(([name, argumentsText]) => `%${name} ${argumentsText}\n`).join(""));

    expect(root().hasError).toBe(false);
    expect(root().descendantsOfType("python_magic_body")).toEqual([]);
    for (let row = 0; row < cases.length; row++) {
      const [, argumentsText] = cases[row];
      const start = columnFor(row, argumentsText);
      for (let offset = 0; offset < argumentsText.length; offset++) {
        if (/\s/.test(argumentsText[offset])) continue;
        const scopes = scopesAt(row, start + offset);
        expect(scopes).toContain("string.unquoted.arguments.ipython");
        expect(scopes).not.toContain("source.python");
        expect(scopes).not.toContain("support.function.magic.ipython");
      }
    }
  });

  it("treats unary minus after time and debug as Python rather than a magic option", async () => {
    const expressions = ["-1", "-value", "-1 + obj.value"];
    const commands = ["time", "debug"];
    await setUp(
      commands
        .flatMap((command) => expressions.map((expression) => `%${command} ${expression}\n`))
        .join("") + "%debug --value\n",
    );

    expect(root().hasError).toBe(false);
    for (let command = 0; command < commands.length; command++) {
      const startRow = command * expressions.length;
      await expectNativePython(startRow, expressions[0], ["-", "1"]);
      await expectNativePython(startRow + 1, expressions[1], ["-", "value"]);
      await expectNativePython(startRow + 2, expressions[2], ["-", "1", "+", ".", "value"]);
    }
    const doubleUnaryRow = commands.length * expressions.length;
    await expectNativePython(doubleUnaryRow, "--value", ["-", "value"]);
    expect(scopesAt(doubleUnaryRow, columnFor(doubleUnaryRow, "--value") + 1)).toContain(
      "keyword.operator.arithmetic.python",
    );
  });

  it("leaves paths, CLI arguments and unknown magic payloads as arguments", async () => {
    const cases = [
      ["cd", '"C:/work/project"'],
      ["run", '-i "script name.py" --count 9'],
      ["matplotlib", "inline"],
      ["pip", "install numpy"],
      ["custom_magic", "obj.calculate(9)"],
    ];
    await setUp(cases.map(([name, argumentsText]) => `%${name} ${argumentsText}\n`).join(""));

    expect(root().hasError).toBe(false);
    for (let row = 0; row < cases.length; row++) {
      const [name, argumentsText] = cases[row];
      expect(scopesFor(row, name)).toContain("support.function.magic.ipython");
      const start = columnFor(row, argumentsText);
      for (let offset = 0; offset < argumentsText.length; offset++) {
        if (/\s/.test(argumentsText[offset])) continue;
        const scopes = scopesAt(row, start + offset);
        expect(scopes).toContain("string.unquoted.arguments.ipython");
        expect(scopes).not.toContain("source.python");
        expect(scopes).not.toContain("support.function.magic.ipython");
      }
    }
  });

  it("handles commands without code and options-only invocations", async () => {
    await setUp("%timeit\n%timeit -n 10 -r 3\n%time\n%prun -q\n%debug\n%config\nafter = 2\n");

    expect(root().hasError).toBe(false);
    expect(root().descendantsOfType("python_magic_body")).toEqual([]);
    for (let row = 0; row < 6; row++) {
      expect(scopesAt(row, 1)).toContain("support.function.magic.ipython");
      expect(scopesAt(row, 1)).not.toContain("source.python");
    }
    expect(scopesFor(1, "10")).toContain("string.unquoted.arguments.ipython");
    expect(scopesFor(3, "-q")).toContain("string.unquoted.arguments.ipython");
    expect(scopesFor(6, "2")).toContain("constant.numeric.integer.python");
  });

  it("highlights a magic assignment's payload without parsing its assignment prefix as Python", async () => {
    const expression = "prs.spt(9)";
    await setUp(`result = %timeit -o ${expression}\nafter = 2\n`);

    expect(root().hasError).toBe(false);
    expect(root().descendantsOfType("magic_expression").length).toBe(1);
    expect(scopesFor(0, "result")).not.toContain("source.python");
    expect(scopesFor(0, "timeit")).toContain("support.function.magic.ipython");
    expect(scopesFor(0, "-o")).toContain("string.unquoted.arguments.ipython");
    await expectNativePython(0, expression, ["spt", "9"]);
    const definitions = (await editor.getGrammarQueryCaptureGroups("tagsQuery"))
      .flatMap((group) => group.captures)
      .filter((capture) => capture.name === "definition.constant");
    expect(definitions.map((capture) => capture.node.text)).toEqual(["after = 2"]);
  });

  it("keeps Python payload positions correct under indentation and CRLF", async () => {
    const expression = "prs.spt_dissup(1, 151)";
    await setUp(`if enabled:\r\n    %timeit -n 10 ${expression}\r\nafter = 2\r\n`);

    expect(root().hasError).toBe(false);
    expect(scopesFor(1, "timeit")).toContain("support.function.magic.ipython");
    expect(scopesFor(1, "-n")).toContain("string.unquoted.arguments.ipython");
    await expectNativePython(1, expression, ["spt_dissup", "1", ",", "151"]);
    expect(scopesFor(2, "2")).toContain("constant.numeric.integer.python");
  });

  it("preserves comments, strings and modulo expressions containing magic-like text", async () => {
    await setUp(
      [
        "# %timeit prs.spt(9)",
        'message = "%timeit prs.spt(9)"',
        'multiline = """',
        "%timeit prs.spt(9)",
        '"""',
        "remainder = value % divisor",
        "%timeit prs.spt(9) # measured",
        "",
      ].join("\n"),
    );

    expect(root().hasError).toBe(false);
    expect(root().descendantsOfType("magic_statement").length).toBe(1);
    expect(scopesFor(0, "timeit")).toContain("comment.line.number-sign.python");
    expect(scopesFor(1, "timeit")).toContain("string.quoted.double.single-line.python");
    expect(scopesFor(3, "timeit")).toContain("string.quoted.triple.block.python");
    expect(scopesFor(5, "%")).toContain("keyword.operator.arithmetic.python");
    for (const row of [0, 1, 3, 5]) {
      expect(scopesFor(row, row === 5 ? "%" : "timeit")).not.toContain(
        "support.function.magic.ipython",
      );
    }
    expect(scopesFor(6, "# measured")).toContain("comment.line.number-sign.python");
    expect(scopesFor(6, "# measured")).not.toContain("support.function.magic.ipython");
  });

  it("highlights Python setup code in timeit, prun and debug cell headers", async () => {
    const setups = ["items = list(range(3))", "work(151)", "work(9)"];
    await setUp(
      [
        `%%timeit -n 10 ${setups[0]}`,
        "sum(items)",
        "# %% Profile",
        `%%prun -q ${setups[1]}`,
        "work(2)",
        "# %% Debug",
        `%%debug ${setups[2]}`,
        "work(3)",
        "",
      ].join("\n"),
    );

    expect(root().hasError).toBe(false);
    expect(scopesFor(0, "timeit")).toContain("support.function.magic.ipython");
    expect(scopesFor(0, "10")).toContain("string.unquoted.arguments.ipython");
    await expectNativePython(0, setups[0], ["items", "=", "list", "range", "3"]);
    await expectNativePython(3, setups[1], ["work", "151"]);
    await expectNativePython(6, setups[2], ["work", "9"]);
    expect(scopesFor(1, "sum")).toContain("support.function.builtin.python");
    expect(scopesFor(4, "2")).toContain("constant.numeric.integer.python");
    expect(scopesFor(7, "3")).toContain("constant.numeric.integer.python");
  });

  it("preserves nested magic and shell escapes inside Python-running magics", async () => {
    const expression = "sum(range(3))";
    await setUp(
      [
        `%timeit %time ${expression}`,
        "%time !echo hello",
        "%time values = !echo hi",
        "%time measured = %timeit -o func()",
        "%time np.mean?",
        "",
      ].join("\n"),
    );

    expect(root().hasError).toBe(false);
    expect(scopesFor(0, "timeit")).toContain("support.function.magic.ipython");
    expect(scopesFor(0, "time", 1)).toContain("support.function.magic.ipython");
    await expectNativePython(0, expression, ["sum", "range", "3"]);
    expect(scopesFor(1, "time")).toContain("support.function.magic.ipython");
    expect(scopesFor(1, "echo")).toContain("string.unquoted.shell.ipython");
    expect(scopesFor(1, "echo")).not.toContain("support.function.magic.ipython");
    expect(scopesFor(2, "time")).toContain("support.function.magic.ipython");
    expect(scopesFor(2, "echo")).toContain("string.unquoted.shell.ipython");
    expect(scopesFor(2, "echo")).not.toContain("support.function.magic.ipython");
    expect(scopesFor(3, "timeit")).toContain("support.function.magic.ipython");
    expect(scopesFor(3, "-o")).toContain("string.unquoted.arguments.ipython");
    await expectNativePython(3, "func()", ["func", "("]);
    expect(scopesFor(4, "np.mean")).toContain("keyword.operator.help.ipython");
    expect(scopesFor(4, "?")).toContain("keyword.operator.help.ipython");
    expect(scopesFor(4, "np.mean")).not.toContain("support.function.magic.ipython");
  });

  it("updates argument and Python scopes after editing a magic command", async () => {
    const expression = "prs.spt(9)";
    await setUp(`%custom_magic ${expression}\nafter = 2\n`);
    expect(scopesFor(0, "spt")).toContain("string.unquoted.arguments.ipython");
    expect(scopesFor(0, "spt")).not.toContain("source.python");

    editor.setTextInBufferRange(
      [
        [0, 1],
        [0, 13],
      ],
      "timeit",
    );
    await editor.whenGrammarSettled();
    expect(root().hasError).toBe(false);
    await expectNativePython(0, expression, ["spt", "9"]);

    editor.setTextInBufferRange(
      [
        [0, 1],
        [0, 7],
      ],
      "cd",
    );
    await editor.whenGrammarSettled();
    expect(root().hasError).toBe(false);
    expect(scopesFor(0, "spt")).toContain("string.unquoted.arguments.ipython");
    expect(scopesFor(0, "spt")).not.toContain("source.python");
    expect(scopesFor(0, "spt")).not.toContain("support.function.magic.ipython");
    expect(scopesFor(1, "2")).toContain("constant.numeric.integer.python");
  });
});

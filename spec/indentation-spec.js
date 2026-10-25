const source =
  "doc.i(r'granice obciążonego odcinka wykresu parcia ponad stykiem, w eksploatacji', [rf'z_1_T={z_1_Q:,3:m}', rf'z_2_T={z_2_Q:,3:m}'])";

describe("IPython newline indentation", () => {
  let editor;

  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-python");
    await lumine.packages.activatePackage("language-ipython");
    editor = await lumine.workspace.open();
    editor.update({ tabLength: 4, softTabs: true, autoIndent: true });
    lumine.grammars.assignLanguageMode(editor.getBuffer(), "source.python.ipy");
  });

  afterEach(() => editor?.destroy());

  for (const prefix of ["", "# %%\n", "if True:\n    "]) {
    it(`keeps the cursor at its inherited indentation after formatted strings (${JSON.stringify(prefix)})`, async () => {
      const text = prefix + source;
      const indent = prefix.endsWith("    ") ? 4 : 0;
      editor.setText(text);
      await editor.whenGrammarSettled();
      editor.setCursorBufferPosition([Infinity, Infinity]);
      editor.getBuffer().clearUndoStack();
      const row = editor.getLastBufferRow() + 1;
      const positions = [];
      const subscription = editor.onDidChangeCursorPosition(({ newBufferPosition }) => {
        if (newBufferPosition.row === row) positions.push(newBufferPosition.column);
      });
      try {
        editor.insertText("\n");
        expect(editor.getCursorBufferPosition().toArray()).toEqual([row, indent]);
        await new Promise(requestAnimationFrame);
        await editor.whenGrammarSettled();
        await new Promise(requestAnimationFrame);
        expect(editor.getText()).toBe(text + "\n" + " ".repeat(indent));
        expect(editor.getCursorBufferPosition().toArray()).toEqual([row, indent]);
        expect(positions.every((column) => column === indent)).toBe(true);
        editor.undo();
        await editor.whenGrammarSettled();
        expect(editor.getText()).toBe(text);
        expect(editor.getCursorBufferPosition().toArray()).toEqual([
          row - 1,
          (row === 1 ? text : text.slice(text.lastIndexOf("\n") + 1)).length,
        ]);
      } finally {
        subscription.dispose();
      }
    });
  }
});

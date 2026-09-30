const FOREIGN_MAGICS = new Map([
  ["python", "python"],
  ["python2", "python"],
  ["python3", "python"],
  ["pypy", "python"],
  ["bash", "bash"],
  ["sh", "shell"],
  ["sx", "shell"],
  ["system", "shell"],
  ["!", "shell"],
  ["html", "html"],
  ["HTML", "html"],
  ["markdown", "markdown"],
  ["latex", "latex"],
  ["javascript", "javascript"],
  ["js", "javascript"],
  ["svg", "xml"],
  ["SVG", "xml"],
  ["perl", "perl"],
  ["ruby", "ruby"],
]);

let injectionRegistrations = [];

exports.activate = function () {
  injectionRegistrations.push(
    lumine.grammars.addInjectionPoint("source.python.ipy", {
      type: "markdown_cell",
      language: () => "markdown",
      content: (node) => node.childForFieldName("body"),
      includeChildren: true,
      coverShallowerScopes: true,
    }),
    lumine.grammars.addInjectionPoint("source.python.ipy", {
      type: "cell_magic",
      language(node) {
        if (node.childForFieldName("body")?.type !== "cell_body") return null;
        return FOREIGN_MAGICS.get(node.childForFieldName("name")?.text) ?? null;
      },
      content: (node) => node.childForFieldName("body"),
      includeChildren: true,
      coverShallowerScopes: true,
    }),
  );
};

exports.deactivate = function () {
  for (const registration of injectionRegistrations.splice(0)) registration.dispose();
};

exports.consumeHyperlinkInjection = (hyperlink) => {
  return hyperlink.addInjectionPoint("source.python.ipy", {
    types: ["comment", "cell_marker_name", "string_content"],
  });
};

exports.consumeTodoInjection = (todo) => {
  return todo.addInjectionPoint("source.python.ipy", {
    types: ["comment", "cell_marker_name"],
  });
};

const FOREIGN_MAGICS = require("./cell-languages");
const pythonContent = require("./python-injection");

let injectionRegistrations = [];
let sourceProjection;

exports.activate = function () {
  injectionRegistrations.push(
    lumine.grammars.addInjectionPoint("source.python.ipy", {
      type: "python_cell_body",
      language: () => "python",
      content: pythonContent,
      combined: true,
      includeChildren: true,
      newlinesBetween: true,
      coverShallowerScopes: true,
    }),
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
  sourceProjection?.dispose();
  sourceProjection = null;
  for (const registration of injectionRegistrations.splice(0)) registration.dispose();
};

exports.provideIPythonSource = function () {
  sourceProjection ??= new (require("./source-projection").SourceProjectionService)();
  return sourceProjection;
};

exports.consumeHyperlinkInjection = (hyperlink) => {
  return hyperlink.addInjectionPoint("source.python.ipy", {
    types: ["cell_marker_name"],
  });
};

exports.consumeTodoInjection = (todo) => {
  return todo.addInjectionPoint("source.python.ipy", {
    types: ["cell_marker_name"],
  });
};

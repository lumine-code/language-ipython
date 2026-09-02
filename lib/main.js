exports.activate = function () {};

exports.consumeHyperlinkInjection = (hyperlink) => {
  hyperlink.addInjectionPoint("source.python.ipy", {
    types: ["comment", "cell_marker_name", "string_content"],
  });
};

exports.consumeTodoInjection = (todo) => {
  todo.addInjectionPoint("source.python.ipy", {
    types: ["comment", "cell_marker_name"],
  });
};

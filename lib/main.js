exports.activate = function () {};

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

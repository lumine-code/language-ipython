exports.collect = async (context, { gcOwned = false } = {}, { signal }) => {
  const root = context.getRootSyntaxNode();
  const cursors = new Set();
  let walks = 0,
    steps = 0,
    deletes = 0,
    records = 0;
  const wrapNode = (node) =>
    node &&
    new Proxy(node, {
      get(target, property) {
        if (["child", "namedChild", "children", "namedChildren"].includes(property))
          throw new Error("Projection must walk linearly instead of indexing children");
        if (property === "tree") return tree;
        if (property === "childForFieldName")
          return (name) => wrapNode(target.childForFieldName(name));
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const tree = new Proxy(root.tree, {
    get(target, property) {
      if (property === "rootNode") return wrapNode(target.rootNode);
      if (property === "walk")
        return () => {
          walks++;
          const raw = target.walk();
          cursors.add(raw);
          return new Proxy(raw, {
            get(cursor, key) {
              if (key === "currentNode") return wrapNode(cursor.currentNode);
              if (key === "delete")
                return gcOwned
                  ? undefined
                  : () => {
                      deletes++;
                      cursors.delete(cursor);
                      cursor.delete();
                    };
              const value = Reflect.get(cursor, key, cursor);
              return typeof value === "function"
                ? (...args) => {
                    steps++;
                    return value.apply(cursor, args);
                  }
                : value;
            },
          });
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    const result = await require("../../lib/source-projection-structure").collect(
      {
        ...context,
        getRootSyntaxNode: () => wrapNode(root),
        getLanguageLayers() {
          throw new Error("Projection must not inspect Python injections");
        },
      },
      {},
      {
        signal,
        emit: async (packet) => {
          records += packet.records.length;
        },
      },
    );
    return {
      walks,
      steps,
      deletes,
      records,
      ...result,
      pythonLayers: context
        .getLanguageLayers()
        .filter((layer) => layer.scopeName === "source.python").length,
    };
  } finally {
    for (const cursor of cursors) cursor.delete?.();
  }
};

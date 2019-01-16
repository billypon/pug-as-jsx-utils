import jsc from 'jscodeshift';

const reservedWords = ['JSON'];
const isReactElement = node => node.parent.parent.node.type === 'JSXElement' && node.node.name.search(/^[a-z]/) === 0;
const arrayUnique = myArray => myArray.filter((v, i, a) => a.indexOf(v) === i);
const analyzeJsx = (jsxOutput, options = {}) => {
  const jsxRoot = jsc(jsxOutput);

  const varsToIgnore = [
    ...reservedWords,
    ...(options.ignore || []),
  ];

  // Remove the use of local parameters.
  jsxRoot
    .find(jsc.ArrowFunctionExpression)
    .replaceWith((nodePath) => {
      // Get a list of function param names.
      const funcParamNames = jsc(nodePath.node.params)
        .nodes()
        .reduce((prev, param) => {
          if (param.type === 'ObjectPattern' && param.properties) {
            return [
              ...prev,
              ...param.properties
                .filter(p => p.type === 'Property' && p.key)
                .map(p => p.key.name),
              ...param.properties
                .filter(p => p.type === 'RestElement' && p.argument && p.argument.type === 'Identifier' && p.argument.name)
                .map(p => p.argument.name),
            ];
          }
          if (param.type === 'Identifier' && param.name) {
            return [...prev, param.name];
          }
          return prev;
        }, []);

      nodePath.node.params = [];

      // Remove function parameter usage.
      jsc(nodePath.node.body)
        .find(jsc.MemberExpression)
        .filter((me) => {
          if (me.node.object && funcParamNames.indexOf(me.node.object.name) !== -1) {
            return true;
          }
          return false;
        })
        .remove();
      jsc(nodePath.node.body)
        .find(jsc.Identifier)
        .filter((p) => {
          const parentNodeType = p.parent.node.type;
          return parentNodeType !== 'JSXAttribute'
            && !(parentNodeType === 'MemberExpression' && p.parent.node.computed === false)
            && funcParamNames.indexOf(p.node.name) !== -1;
        })
        .remove();
      // console.log(jsc(nodePath).toSource());
      return nodePath.node;
    });

  // Remove this pattern: const { props1, props2 } = params;
  jsxRoot
    .find(jsc.VariableDeclaration)
    .filter(p => p.node.declarations[0].init.name === 'params')
    .remove();

  const useThis = jsxRoot
    .find(jsc.MemberExpression, {
      object: { type: 'ThisExpression' },
      property: { type: 'Identifier' },
    })
    .nodes().length > 0;

  // Get used variable names.
  let variables = [];
  jsxRoot
    .find(jsc.Identifier)
    .filter((p) => {
      if (p.parent.node.type === 'MemberExpression'
        && p.parent.node.object === p.node
      ) {
        return true;
      }
      if (p.parent.node.type === 'JSXExpressionContainer'
        && p.parent.node.expression === p.node
      ) {
        return true;
      }
      if (p.parent.node.type === 'Property'
        && p.parent.parent.node.type === 'ObjectExpression'
        && ['CallExpression', 'JSXExpressionContainer'].indexOf(p.parent.parent.parent.node.type) !== -1
        && p.parent.node.key === p.node
      ) {
        return false;
      }
      // exclude nested JSXElement. ex) Modal.Body
      if (p.parent.node.type === 'JSXMemberExpression' && p.parent.node.property === p.node) {
        return false;
      }
      if (isReactElement(p)
        || p.parent.node.type === 'JSXAttribute'
        || (p.parent.node.type === 'MemberExpression' && p.parent.node.computed === false)
      ) {
        return false;
      }
      return true;
    })
    .forEach((p) => {
      variables = [...variables, p.node.name];
    });

  return {
    useThis,
    variables: arrayUnique(variables.filter(e => varsToIgnore.indexOf(e) === -1)).sort(),
  };
};

const hashCode = (str) => {
  let hash = 0;
  if (typeof str === 'object' && str !== null) {
    str = JSON.stringify(str);
  }
  if (!str || str.length === 0) {
    return hash;
  }
  let i = 0;
  const len = str.length;
  while (i < len) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
    i += 1;
  }
  const base16 = hash.toString(16).replace(/[^a-z0-9]/g, '');
  const base36 = hash.toString(36).replace(/[^a-z0-9]/g, '');
  hash = (parseInt(base16.substr(0, 1), 16) + 10).toString(36) + base36;
  return hash;
};

function entries(object) {
  return Object.keys(object).map(key => [key, object[key]]);
}

function values(object) {
  return Object.keys(object).map(key => object[key]);
}

function gerResolveDict(resolveOpt = {}) {
  const resolveDict = entries(resolveOpt).map(([moduleName, detail]) => {
    const options = typeof detail === 'string' ? { name: detail } : detail;
    let member = options.member || {};
    if (Array.isArray(member)) {
      member = member
        .filter(memberName => memberName && typeof memberName === 'string')
        .reduce((prev, memberName) => ({ ...prev, [memberName]: memberName }), {});
    }
    return {
      ...options,
      moduleName,
      member: entries(member).reduce((prev, [alias, memberName]) => ({
        ...prev,
        [alias]: memberName && typeof memberName === 'string' ? memberName : alias,
      }), {}),
    };
  });

  return resolveDict.reduce((prev, { moduleName, name, member }) => {
    const next = { ...prev };
    if (name) {
      next[name] = { moduleName, type: 'name', name };
    }
    entries(member).forEach(([alias, memberName]) => {
      next[alias] = { moduleName, type: 'member', name: memberName };
      if (alias !== memberName) {
        next[alias].alias = alias;
      }
    });
    return next;
  }, {});
}

function getImports(variables, resolveOpt = {}) {
  const resolveDict = gerResolveDict(resolveOpt);
  const { used, imports } = variables.reduce((prev, each) => {
    const matched = resolveDict[each];
    if (!matched) {
      return prev;
    }
    const next = { ...prev };
    next.used.push(each);
    const item = prev[matched.moduleName] || { moduleName: matched.moduleName };
    if (matched.type === 'name') {
      item.name = matched.name;
    }
    if (matched.type === 'member') {
      const newMember = { name: matched.name };
      if (matched.alias) {
        newMember.alias = matched.alias;
      }
      item.member = [...(item.member || []), newMember];
    }
    return {
      ...next,
      imports: {
        ...next.imports,
        [item.moduleName]: { ...(next.imports[item.moduleName] || {}), ...item },
      },
    };
  }, { used: [], imports: {} });

  return { used, imports: values(imports) };
}

function removeDupAttrs(pugCode) {
  return pugCode.replace(/\(([^()]{0,}?)\)/g, (whole, p1) => {
    const matched = ` ${p1.replace(/\n/g, ' ')}`.match(/[a-zA-Z0-9_-]+(='.*?'){1,}/g);
    if (!matched) {
      return whole;
    }
    const attrs = matched
      .map((e) => {
        const [key, ...rest] = e.split('=');
        const value = rest.join('=');
        return { key, value };
      })
      .reduce((prev, { key, value }) => {
        const next = { ...prev };
        if (next[key]) {
          delete next[key];
        }
        return { ...next, [key]: value };
      }, {});

    const replacement = Object.entries(attrs)
      .map(([k, v]) => (v ? `${k}=${v}` : k))
      .join(', ');
    return `(${replacement})`;
  });
}

function removeIndent(source) {
  const lines = source.split(/\n/);
  const minIndent = lines.reduce((indentSize, curr) => {
    const indent = Array(curr.search(/[^\s]/) + 1).join(' ');
    if (curr.trim() && (indentSize === null || indent.length < indentSize)) {
      return indent.length;
    }
    return indentSize;
  }, null);
  return lines.map(e => e.substr(minIndent || 0)).join('\n').trim();
}

function removePugComment(pugCode) {
  return pugCode.split(/\n/).reduce((prev, curr) => {
    const indentSize = curr.match(/^\s*/)[0].length;
    if (prev.commentIndentSize !== null && prev.commentIndentSize < indentSize) {
      return prev;
    }

    const hasCommentSymbol = !!curr.match(/^\s*\/\//) && !curr.match(/^\/\/\s+@/);
    if (hasCommentSymbol) {
      return { ...prev, commentIndentSize: indentSize };
    }

    return {
      commentIndentSize: null,
      lines: [...prev.lines, curr],
    };
  }, { commentIndentSize: null, lines: [] }).lines.join('\n');
}

export {
  analyzeJsx,
  hashCode,
  getImports,
  removeDupAttrs,
  removeIndent,
  removePugComment,
};
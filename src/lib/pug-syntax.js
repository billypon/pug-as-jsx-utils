const lex = require('pug-lexer');
const parse = require('pug-parser');
const walk = require('pug-walk');

import { hashCode } from './util';

const transform = function (ast) {
  const nodes = [];
  walk(ast, (node, replace) => {
    let replacement
    switch (node.type) {
      case 'Tag':
        node.attrs.forEach(attr => {
          let { name, val } = attr;
          if (name.startsWith('...')) {
            attr.name = `{${attr.name}}`;
            attr.val = '"__rest"';
          } else {
            if (name.startsWith('@')) {
              attr.name = name.substr(1);
              val = `($event => ${val.substr(1, val.length - 2)})`;
            }
            if (!/^(['"]).*\1$/.test(val)) {
              val = !/^\(.*\)$/.test(val) ? val : val.substring(1, val.length - 1);
              val = transformGetFn(val);
              attr.val = `"{${!val.replace ? val : val.replace(/"/g, '\\"')}}"`;
              attr.mustEscape = false;
            }
          }
        });
        break;
      case 'Code':
        const { type } = nodes[0] || {};
        node.val = transformGetFn(node.val);
        node.val = !(type && [ 'Conditional', 'Each', 'Case' ].includes(type)) ? `"{${node.val}}"` : `"${node.val}"`;
        node.mustEscape = false;
        return;
      case 'Conditional':
        {
          const getNodes = (node) => {
            const { type, test, consequent, line, column } = node;
            if (type !== 'Conditional') {
              return [
                { type: 'Text', val: '(', line, column },
                node,
                { type: 'Text', val: '\n)', line, column },
              ];
            }
            consequent.nodes = isFragmentRequired(consequent.nodes) ? wrapInFragment(consequent.nodes) : consequent.nodes;
            node.alternate = node.alternate || {
              type: 'Block',
              nodes: [ { type: 'Text', val: '', line, column } ],
              line,
            }
            if (node.alternate.nodes) {
              node.alternate.nodes = isFragmentRequired(node.alternate.nodes) ? wrapInFragment(node.alternate.nodes) : node.alternate.nodes;
            }
            nodes.unshift(node);
            const alternate = getNodes(node.alternate);
            nodes.shift();
            const result = [
              { type: 'Text', val: `${transformGetFn(node.test)} ? `, line, column },
              ...[
                { type: 'Text', val: '(', line, column },
                consequent,
                { type: 'Text', val: ')', line, column },
              ],
              { type: 'Text', val: ' : ', line, column },
              ...alternate,
            ];
            return isBracketsRequired(nodes) ? wrapInBrackets(result) : result;
          }
          replacement = getNodes(node);
          replace(replacement);
          node._last = replacement[replacement.length - 1];
          replacement = null;
        }
        break;
      case 'Each':
        {
          const { obj, val, key, block, line, column } = node;
          replacement = [
            { type: 'Text', val: `__macro.for(${transformGetFn(obj)}).map((${val}${key ? `, ${key}` : ''}) => (`, line, column },
            block,
            { type: 'Text', val: '))', line, column },
          ];
        }
        break;
      case 'Case':
        {
          const { type, expr, block, line, column } = node;
          replacement = [
            { type: 'Text', val: '(() => {\n', line, column },
            { type: 'Text', val: `switch (${transformGetFn(expr)}) {\n`, line, column },
            ...block.nodes.map(node => {
              node.block.nodes = isFragmentRequired(node.block.nodes) ? wrapInFragment(node.block.nodes) : node.block.nodes;
              return [
                node.expr !== 'default' ? { type: 'Text', val: `case ${node.expr}:\n`, line, column } : { type: 'Text', val: 'default:\n', line, column },
                { type: 'Text', val: 'return (', line, column },
                node.block,
                { type: 'Text', val: ');\n', line, column },
              ]
            }),
            { type: 'Text', val: '}\n', line, column },
            { type: 'Text', val: 'return null;\n', line, column },
            { type: 'Text', val: '})()', line, column },
          ];
        }
        break;
      default:
        return;
    }
    if (replacement) {
      replace(isBracketsRequired(nodes) ? wrapInBrackets(replacement) : replacement);
      node._last = replacement[replacement.length - 1];
      replacement = null;
    }
    nodes.unshift(node);
  }, node => {
    switch (node.type) {
      case 'Tag':
        nodes.shift();
        break;
      default:
        if (nodes[0] && (nodes[0] === node || nodes[0]._last === node)) {
          nodes.shift();
        }
        break;
    }
  });
  return ast;
}

const transformString = function (src) {
  const options = { src };
  const tokens = lex(src, options);
  const ast = parse(tokens, options);
  return transform(ast);
}

function transformGetFn(str) {
  const dict = {};
  while (str.includes && str.includes('_get(')) {
    str = str.replace(/_get\([^.()\n]+(\.[^.()\n]+)+\)/, match => {
      const [ , path, value ] = match.split(/_get\(|\)|, ?/);
      const array = path.split(/[.\[\]]/).filter(Boolean);
      const key = hashCode(match);
      dict[key] = `_get(${array[0]}, '${array.slice(1).join('.').replace(/'/g, '\\\'')}'${value ? `, ${value}` : ''})`;
      return `_${key}_`;
    });
  }
  Object.entries(dict)
    .reverse()
    .forEach(([ key, value ]) => {
      str = str.replace(new RegExp(`_${key}_`, 'g'), value);
    });
  return str;
}

export { transform, transformString, transformGetFn };

function isBracketsRequired(nodes) {
  const { type } = nodes[0] || {};
  return !type || type === 'Tag';
}

function wrapInBrackets(nodes) {
  return [
    { type: 'Text', val: '{' },
    ...nodes,
    { type: 'Text', val: '}' },
  ];
}

function isFragmentRequired(nodes) {
  const [ node ] = nodes
  return nodes.length > 1 || (node && node.type === 'Text')
}

function wrapInFragment(nodes) {
  return [
    {
      type: 'Tag',
      name: 'Fragment',
      block: { type: 'Block', nodes },
      attrs: [],
      attributeBlocks: [],
    }
  ];
}

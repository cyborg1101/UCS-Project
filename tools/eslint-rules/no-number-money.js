/**
 * [check:money] K01-T02 / K-15 gate.
 * Money must never be an IEEE-754 `number`. Use Money from @ucs/shared.
 */
'use strict';

const MONEY_NAME =
  /(amount|money|price|balance|subtotal|fee|cost|salary|payment|refund|discount|vat)/i;

function isMoneyy(node) {
  if (!node) return false;
  if (node.type === 'Identifier') return MONEY_NAME.test(node.name);
  if (node.type === 'MemberExpression' && node.property.type === 'Identifier') {
    return MONEY_NAME.test(node.property.name);
  }
  return false;
}

const ARITH = new Set(['+', '-', '*', '/', '%', '**']);
const COERCIONS = new Set(['Number', 'parseFloat', 'parseInt', 'toFixed']);

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow IEEE-754 number arithmetic/coercion on monetary values; use Money from @ucs/shared',
    },
    schema: [],
    messages: {
      arithmetic:
        'Money must not use `number` arithmetic (operator `{{op}}`). Use Money from @ucs/shared.',
      coercion:
        'Money must not be coerced with {{fn}}(). Construct Money from a decimal string instead.',
    },
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (!ARITH.has(node.operator)) return;
        if (isMoneyy(node.left) || isMoneyy(node.right)) {
          context.report({ node, messageId: 'arithmetic', data: { op: node.operator } });
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        let name = null;
        if (callee.type === 'Identifier') name = callee.name;
        else if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
          name = callee.property.name;
        }
        if (!name || !COERCIONS.has(name)) return;
        if (node.arguments.some(isMoneyy)) {
          context.report({ node, messageId: 'coercion', data: { fn: name } });
        }
      },
    };
  },
};

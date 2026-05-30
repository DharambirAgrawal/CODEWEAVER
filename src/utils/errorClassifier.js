// src/utils/errorClassifier.js
// Turns any error string into a typed classification + targeted fix guidance.

'use strict';

const KNOWN_WRONG_DOCX_HELPERS = [
  'helpers.',
  'newTableCell',
  'newTableRow',
  'newParagraph',
  'createCell',
  'createRow',
  'createParagraph',
  'createHeading',
  'makeTable',
  'buildTable',
  'styledParagraph',
];

// ── Classification ────────────────────────────────────────────────────────────

/**
 * @param {string} errorText
 * @param {{ language?: string, library?: string }} context
 * @returns {{ type: string, fixable: boolean, scope: string } | null}
 */
function classifyError(errorText, context = {}) {
  const e = (errorText || '').toLowerCase();
  const language = context.language || '';
  const library = context.library || '';

  // Python execution errors
  if (/syntaxerror/.test(e)) return { type: 'syntax', fixable: true, scope: 'step' };
  if (/nameerror/.test(e)) return { type: 'name', fixable: true, scope: 'step' };
  if (/typeerror/.test(e)) return { type: 'type', fixable: true, scope: 'step' };
  if (/indentationerror/.test(e)) return { type: 'indent', fixable: true, scope: 'step' };
  if (/importerror|modulenotfounderror/.test(e)) return { type: 'import', fixable: true, scope: 'imports' };
  if (/attributeerror/.test(e)) return { type: 'attribute', fixable: true, scope: 'step' };
  if (/filenotfounderror/.test(e)) return { type: 'file_path', fixable: true, scope: 'save_step' };
  if (/permissionerror/.test(e)) return { type: 'permission', fixable: false, scope: 'env' };

  // Output quality errors
  if (/too.?short|underproduced|word.?count/.test(e)) return { type: 'content_short', fixable: true, scope: 'content_steps' };
  if (/row.?count|not enough row/.test(e)) return { type: 'row_short', fixable: true, scope: 'data_step' };

  // Invented helper functions (docx)
  const matchFn = errorText.match(/([A-Za-z0-9_.]+)\s+is not a function/i);
  if (matchFn) {
    const fnName = matchFn[1];
    const wrongHelper = KNOWN_WRONG_DOCX_HELPERS.some(h =>
      fnName.includes(h) || e.includes(h.toLowerCase()),
    );
    if (wrongHelper) return { type: 'invented_helper', fixable: true, scope: 'step' };
    return { type: 'undefined_function', fixable: true, scope: 'step' };
  }

  const matchUndefined = errorText.match(/([A-Za-z0-9_.]+)\s+is not defined/i);
  if (matchUndefined) return { type: 'name', fixable: true, scope: 'step' };

  if (/cannot read prop/.test(e)) return { type: 'null_access', fixable: true, scope: 'step' };

  return { type: 'unknown', fixable: false, scope: 'full' };
}

// ── Fix instruction builders ──────────────────────────────────────────────────

/**
 * Build a targeted fix instruction based on error type.
 * @param {string} errorType
 * @param {string} errorMessage
 * @param {object} step    - plan step object with fn, do, words, rows
 * @param {number} errorLine
 * @returns {string}
 */
function buildFixInstruction(errorType, errorMessage, step, errorLine) {
  switch (errorType) {
    case 'SyntaxError':
    case 'syntax':
      return `Fix the syntax error${errorLine ? ` at line ${errorLine}` : ''}. Do not change anything else.`;

    case 'IndentationError':
    case 'indent':
      return 'Fix the indentation error. Use 4 spaces consistently. No tabs.';

    case 'NameError':
    case 'name': {
      const nameMatch = errorMessage.match(/'([^']+)' is not defined|name '([^']+)'/);
      const missing = nameMatch?.[1] || nameMatch?.[2];
      if (missing) {
        return (
          `"${missing}" is not defined. ` +
          'Either it needs to be imported (check the imports block) ' +
          'or it should be a local variable defined inside this function. ' +
          'Do not use names from outside the function unless they are parameters.'
        );
      }
      return `Fix the NameError: ${errorMessage}`;
    }

    case 'TypeError':
    case 'type':
      return `Fix the TypeError: ${errorMessage}. Check that you are passing the correct types to functions.`;

    case 'content_too_short':
    case 'content_short': {
      const estimated = errorMessage.match(/~(\d+) words/)?.[1] || '?';
      return (
        `Function produces only ~${estimated} words but needs ${step.words || '?'}. ` +
        `Add more paragraphs covering all topics: ${step.do || 'as specified'}`
      );
    }

    case 'ImportError':
    case 'import': {
      const pkg = errorMessage.match(/No module named '([^']+)'/)?.[1];
      return pkg
        ? `Module "${pkg}" is not available. Use only the packages listed in the imports block.`
        : `Fix the import error: ${errorMessage}`;
    }

    case 'wrong_name':
      return `Rename the function to exactly match the required signature: ${step.fn || step.fnParsed?.name}`;

    case 'prohibited_pattern':
      return errorMessage;

    case 'invented_helper': {
      const fnName = errorMessage.match(/([A-Za-z0-9_.]+)\s+is not/i)?.[1];
      return fnName
        ? `${fnName} does not exist. Use the actual library APIs as shown in the skill reference.`
        : `Use only real library APIs, not invented helper functions.`;
    }

    default:
      return `Fix the error: ${errorMessage}`;
  }
}

/**
 * Classify + format an error into a retryable prompt string.
 * Kept for backward compatibility with existing orchestrator code.
 */
function formatErrorForRetry(error, context = {}) {
  const base = String(error || '').trim();
  const cls = classifyError(base, context);
  if (!cls) return base;

  const language = context.language || '';
  const library = context.library || '';

  let explanation = null;

  if (cls.type === 'invented_helper') {
    const matchFn = base.match(/([A-Za-z0-9_.]+)\s+is not a function/i);
    const fnName = matchFn?.[1] || '(unknown)';
    explanation = library === 'python-docx' || language === 'python'
      ? `${fnName} does not exist. Use python-docx APIs like document.add_paragraph() and document.add_table() directly.`
      : `${fnName} does not exist. Use docx constructors like new Paragraph({ ... }) and new Table({ ... }).`;
  } else if (cls.type === 'undefined_function') {
    const matchFn = base.match(/([A-Za-z0-9_.]+)\s+is not a function/i);
    explanation = `${matchFn?.[1] || '(unknown)'} is not defined. Only use the data provided and the allowed library APIs.`;
  } else if (cls.type === 'name') {
    const matchUndefined = base.match(/([A-Za-z0-9_.]+)\s+is not defined/i);
    explanation = `${matchUndefined?.[1] || '(unknown)'} was not defined in this scope. All data must come from the section data provided.`;
  } else if (cls.type === 'null_access') {
    explanation = 'You accessed a property on undefined. Check array bounds and object structure before reading properties.';
  } else if (cls.type === 'wrong_constructor') {
    const matchCtor = base.match(/([A-Za-z0-9_.]+)\s+is not a constructor/i);
    const name = matchCtor?.[1] || '(unknown)';
    explanation = library === 'python-docx' || language === 'python'
      ? `${name} is not a constructor in python-docx. Use document.add_paragraph(), document.add_heading(), document.add_table().`
      : `${name} is not a constructor in docx. Use new Paragraph(...), new Table(...), new TableRow(...), new TableCell(...).`;
  }

  if (!explanation) return base;
  return `${base}\n\nError category: ${cls.type}\n${explanation}`;
}

module.exports = {
  classifyError,
  buildFixInstruction,
  formatErrorForRetry,
  KNOWN_WRONG_DOCX_HELPERS,
};

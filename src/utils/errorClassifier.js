// src/utils/errorClassifier.js
// Categorize common execution errors and add targeted guidance before retry.

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

function classifyError(error, context = {}) {
  const text = String(error || '');
  const lower = text.toLowerCase();
  const language = context.language || '';
  const library = context.library || '';

  let category = null;
  let explanation = null;

  const matchFn = text.match(/([A-Za-z0-9_\.]+)\s+is not a function/i);
  const matchCtor = text.match(/([A-Za-z0-9_\.]+)\s+is not a constructor/i);
  const matchUndefined = text.match(/([A-Za-z0-9_\.]+)\s+is not defined/i);

  if (lower.includes('syntaxerror')) {
    category = 'syntax';
    explanation = language === 'python'
      ? 'Your code has a syntax error. Return only valid Python function code.'
      : 'Your code has a syntax error. Return only a valid JavaScript function.';
  } else if (matchFn) {
    const fnName = matchFn[1];
    const wrongHelper = KNOWN_WRONG_DOCX_HELPERS.some(h => fnName.includes(h) || lower.includes(h.toLowerCase()));
    if (wrongHelper) {
      category = 'invented_helper';
      if (library === 'python-docx' || language === 'python') {
        explanation = `${fnName} does not exist. Use python-docx APIs like document.add_paragraph() and document.add_table() directly.`;
      } else {
        explanation = `${fnName} does not exist. Use docx constructors like new Paragraph({ ... }) and new TableCell({ children: [...] }).`;
      }
    } else {
      category = 'undefined_function';
      explanation = `${fnName} is not defined. Only use the data provided in the section and the allowed library APIs.`;
    }
  } else if (matchUndefined) {
    const name = matchUndefined[1];
    category = 'undefined_variable';
    explanation = `${name} was not defined in this scope. All data must come from the section data provided.`;
  } else if (lower.includes('cannot read properties of undefined') || lower.includes('cannot read property')) {
    category = 'null_access';
    explanation = 'You accessed a property on undefined. Check array bounds and object structure before reading properties.';
  } else if (matchCtor) {
    const name = matchCtor[1];
    category = 'wrong_constructor';
    if (library === 'python-docx' || language === 'python') {
      explanation = `${name} is not a constructor in python-docx. Use document.add_paragraph(), document.add_heading(), and document.add_table().`;
    } else {
      explanation = `${name} is not a constructor in docx. Use new Paragraph(...), new Table(...), new TableRow(...), new TableCell(...).`;
    }
  }

  if (!category) return null;

  return { category, explanation };
}

function formatErrorForRetry(error, context = {}) {
  const base = String(error || '').trim();
  const classified = classifyError(base, context);
  if (!classified) return base;

  return `${base}\n\nError category: ${classified.category}\n${classified.explanation}`;
}

module.exports = { classifyError, formatErrorForRetry, KNOWN_WRONG_DOCX_HELPERS };

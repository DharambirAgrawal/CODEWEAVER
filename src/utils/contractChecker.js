// src/utils/contractChecker.js
// Enforces strict section-function contract before execution.

const { KNOWN_WRONG_DOCX_HELPERS } = require('./errorClassifier');

const DEFAULT_DOCX_ALLOWED_CONSTRUCTORS = [
  'Paragraph',
  'TextRun',
  'Table',
  'TableRow',
  'TableCell',
];

function checkSectionContract(options) {
  const {
    code,
    expectedFunctionName,
    language,
    allowedConstructors = DEFAULT_DOCX_ALLOWED_CONSTRUCTORS,
  } = options;

  const errors = [];
  const source = String(code || '');
  const lower = source.toLowerCase();

  if (!expectedFunctionName) {
    errors.push('Missing expected function name for contract check.');
  } else if (language === 'python') {
    const fnPattern = new RegExp(`def\\s+${expectedFunctionName}\\s*\\(\\s*document\\s*\\)`, 'm');
    if (!fnPattern.test(source)) {
      errors.push(`Function signature must be: def ${expectedFunctionName}(document):`);
    }
  } else {
    const fnPattern = new RegExp(`function\\s+${expectedFunctionName}\\s*\\(`, 'm');
    if (!fnPattern.test(source)) {
      errors.push(`Function signature must be: function ${expectedFunctionName}() { ... }`);
    }
  }

  if (!/return\s*\[/.test(source)) {
    errors.push('Function must return an array (use "return [ ... ]").');
  }

  if (language === 'python') {
    if (/\bimport\s+/.test(source)) errors.push('Do not include import statements in the section function.');
    if (/\bDocument\s*\(/.test(source)) errors.push('Do not instantiate Document() inside a section function.');
    if (/\.save\s*\(/.test(source)) errors.push('Do not save the document inside a section function.');
  } else {
    if (/require\s*\(/.test(source)) errors.push('Do not include require() in the section function.');
    if (/\bimport\s+/.test(source)) errors.push('Do not include import statements in the section function.');
    if (/\bPacker\s*\./.test(source)) errors.push('Do not call Packer in a section function.');
    if (/\bDocument\s*\(/.test(source)) errors.push('Do not instantiate Document() inside a section function.');
    if (/\bfs\s*\./.test(source)) errors.push('Do not use fs in a section function.');
  }

  const wrongHelper = KNOWN_WRONG_DOCX_HELPERS.find(h => lower.includes(h.toLowerCase()));
  if (wrongHelper) {
    errors.push(`Invented helper detected: ${wrongHelper}. Use only library APIs.`);
  }

  if (language !== 'python') {
    const ctorMatches = [...source.matchAll(/\bnew\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)];
    ctorMatches.forEach(match => {
      const ctor = match[1];
      if (!allowedConstructors.includes(ctor)) {
        errors.push(`Constructor not allowed in section function: ${ctor}`);
      }
    });
  }

  if (errors.length > 0) {
    return {
      ok: false,
      message: `Section function contract failed: ${errors.join(' ')}`,
      errors,
    };
  }

  return { ok: true };
}

module.exports = { checkSectionContract, DEFAULT_DOCX_ALLOWED_CONSTRUCTORS };

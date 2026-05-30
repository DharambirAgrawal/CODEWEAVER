// src/pipeline/planParser.js
// Parses the Markdown plan that the planner LLM produces.
// Input:  raw string from LLM (Markdown with ## headings)
// Output: { header, imports, steps[] } where each step has fn, fnParsed, do, words, rows, points

'use strict';

/**
 * Parse the fn: signature string into a structured object.
 * Handles:  "fn: add_section(doc) → doc"
 *           "fn: setup() → config"
 *           "fn: save_file(wb, path) → None"
 */
function parseFnSignature(fnStr) {
  if (!fnStr) return null;
  const s = fnStr.trim();

  // Extract return values after → or ->
  const arrowMatch = s.match(/[→>]\s*(.+)$/);
  const outputs = arrowMatch
    ? arrowMatch[1].split(',').map(o => o.trim()).filter(Boolean)
    : [];

  // Extract function name and inputs
  const callMatch = s.replace(/[→>].*$/, '').match(/^(\w+)\s*\(\s*([^)]*)\s*\)/);
  if (!callMatch) return { name: s.replace(/\W+/g, '_'), inputs: [], outputs };

  const name = callMatch[1];
  const inputs = callMatch[2]
    ? callMatch[2].split(',').map(i => i.trim()).filter(Boolean)
    : [];

  return { name, inputs, outputs };
}

/**
 * Parse a single step block (lines after a ## step_N heading).
 */
function parseStepBlock(title, lines) {
  const step = {
    title,
    fn: null,
    fnParsed: null,
    do: null,
    words: null,
    rows: null,
    points: null,
  };

  for (const line of lines) {
    const kv = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const val = kv[2].trim();

    if (key === 'fn') {
      step.fn = val;
      step.fnParsed = parseFnSignature(val);
    } else if (key === 'do') {
      step.do = val;
    } else if (key === 'words') {
      const n = parseInt(val, 10);
      if (!isNaN(n)) step.words = n;
    } else if (key === 'rows') {
      const n = parseInt(val, 10);
      if (!isNaN(n)) step.rows = n;
    } else if (key === 'points') {
      const n = parseInt(val, 10);
      if (!isNaN(n)) step.points = n;
    }
  }

  return step;
}

/**
 * Parse the header block (lines before the first ## step heading).
 */
function parseHeader(lines) {
  const header = {};
  for (const line of lines) {
    const kv = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase().replace(/_/g, '');
    const val = kv[2].trim();
    if (key === 'task') header.task = val;
    else if (key === 'output') header.output = val;
    else if (key === 'totalwords') header.total_words = parseInt(val, 10) || null;
    else if (key === 'totalrows') header.total_rows = parseInt(val, 10) || null;
    else if (key === 'sections') header.sections = parseInt(val, 10) || null;
  }
  return header;
}

/**
 * Main entry point.
 * @param {string} raw  - raw Markdown text from the planner LLM
 * @returns {{ header: object, imports: string, steps: object[] }}
 */
function parsePlan(raw) {
  const result = { header: {}, imports: '', steps: [] };
  if (!raw || typeof raw !== 'string') return result;

  // Strip the outer "# plan" block start if present
  const text = raw.replace(/^#\s+plan\s*/i, '').trim();
  const lines = text.split('\n');

  let currentSection = 'header';
  let buffer = [];

  function flush() {
    if (currentSection === 'header') {
      result.header = parseHeader(buffer);
    } else if (currentSection === 'imports') {
      result.imports = buffer.join('\n').trim();
    } else if (currentSection.startsWith('step_')) {
      result.steps.push(parseStepBlock(currentSection, buffer));
    }
    buffer = [];
  }

  for (const line of lines) {
    // ## heading detection
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      flush();
      const heading = h2[1].trim().toLowerCase().replace(/\s+/g, '_');
      currentSection = heading;
      continue;
    }
    buffer.push(line);
  }
  flush();

  return result;
}

/**
 * Validate that the parsed plan has all required fields.
 * Returns { valid: boolean, errors: string[] }
 */
function validateParsedPlan(plan) {
  const errors = [];
  if (!plan.steps || plan.steps.length === 0) {
    errors.push('Plan has no steps');
    return { valid: false, errors };
  }

  for (const step of plan.steps) {
    if (!step.fn) {
      errors.push(`Step "${step.title}" has no fn: field`);
    }
    if (!step.do) {
      errors.push(`Step "${step.title}" has no do: field`);
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { parsePlan, parseFnSignature, validateParsedPlan };

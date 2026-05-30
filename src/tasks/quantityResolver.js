// src/tasks/quantityResolver.js
// Converts a raw user prompt + task type into hard numeric targets that flow
// through every stage of the pipeline (refiner → planner → codegen → validation).

'use strict';

/**
 * Extract numbers from text, e.g. "10-page" → 10, "60 rows" → 60
 */
function extractNumber(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Build the instruction sentences that get injected into prompts so the LLM
 * knows the hard targets without needing to re-derive them.
 */
function buildInstructions(quantities) {
  const instructions = {};

  if (quantities.total_words) {
    instructions.section_instruction =
      `The document must contain ${quantities.total_words} words across ` +
      `${quantities.sections} sections (~${quantities.words_per_section} words per section).`;
  } else {
    instructions.section_instruction = '';
  }

  if (quantities.total_rows) {
    instructions.row_instruction =
      `The spreadsheet must contain exactly ${quantities.total_rows} data rows ` +
      `(not counting headers). Use a loop — do not write rows manually.`;
  } else {
    instructions.row_instruction = '';
  }

  if (quantities.data_points) {
    instructions.point_instruction =
      `The chart must plot exactly ${quantities.data_points} data points.`;
  } else {
    instructions.point_instruction = '';
  }

  return instructions;
}

/**
 * Core resolver — call once per job after taskAnalyzer, before anything else.
 *
 * @param {string} taskType   - 'word' | 'excel' | 'chart' | 'csv' | 'pdf'
 * @param {string} rawPrompt  - original user message
 * @param {object} [volume]   - optional pre-computed volume from taskAnalyzer
 * @returns {object} quantities
 */
function resolveQuantity(taskType, rawPrompt, volume = {}) {
  const lower = (rawPrompt || '').toLowerCase();

  const qty = {
    // Word / report targets
    total_words: null,
    total_pages: null,
    sections: null,
    words_per_section: null,

    // Excel / CSV targets
    total_rows: null,
    min_columns: null,
    column_hints: [],

    // Chart targets
    data_points: null,

    // Injected instruction sentences (set at end)
    section_instruction: '',
    row_instruction: '',
    point_instruction: '',
  };

  if (taskType === 'word' || taskType === 'pdf') {
    // Pages
    const pages =
      volume.estimatedPages ||
      extractNumber(lower, [
        /(\d+)\s*[-–]?\s*page/,
        /(\d+)\s*pages/,
        /page[s]?\s*[=:]\s*(\d+)/,
      ]) ||
      (lower.includes('short') ? 3 : lower.includes('long') ? 10 : 5);

    // Words (roughly 250 words per page in a normal Word doc)
    const words =
      volume.estimatedWords ||
      extractNumber(lower, [
        /(\d+)\s*words/,
        /word[s]?\s*count\s*[=:]\s*(\d+)/,
      ]) ||
      pages * 250;

    // Sections
    const sections =
      volume.estimatedSections ||
      extractNumber(lower, [
        /(\d+)\s*sections/,
        /(\d+)\s*chapters/,
        /(\d+)\s*parts/,
      ]) ||
      Math.max(3, Math.ceil(pages * 0.8));

    qty.total_pages = pages;
    qty.total_words = words;
    qty.sections = sections;
    qty.words_per_section = Math.floor(words / sections);
  }

  if (taskType === 'excel' || taskType === 'csv') {
    const rows =
      volume.estimatedRows ||
      extractNumber(lower, [
        /(\d+)\s*rows/,
        /(\d+)\s*records/,
        /(\d+)\s*entries/,
        /(\d+)\s*data\s*points/,
      ]) ||
      50;

    // Minimum columns: look for explicit column hints in prompt
    const colHints = [];
    const colPatterns = [
      /columns?[:\s]+([^.]+)/i,
      /fields?[:\s]+([^.]+)/i,
      /headers?[:\s]+([^.]+)/i,
    ];
    for (const pat of colPatterns) {
      const m = lower.match(pat);
      if (m) {
        const names = m[1].split(/[,;|]/);
        names.forEach(n => {
          const trimmed = n.trim().replace(/and\s+/i, '');
          if (trimmed.length > 1 && trimmed.length < 40) colHints.push(trimmed);
        });
        break;
      }
    }

    const minCols =
      extractNumber(lower, [
        /(\d+)\s*columns/,
        /(\d+)\s*fields/,
      ]) ||
      Math.max(colHints.length, 3);

    qty.total_rows = rows;
    qty.min_columns = minCols;
    qty.column_hints = colHints.slice(0, 12);
  }

  if (taskType === 'chart') {
    const points =
      volume.estimatedRows ||
      extractNumber(lower, [
        /(\d+)\s*data\s*points/,
        /(\d+)\s*points/,
        /(\d+)\s*years/,
        /(\d+)\s*months/,
        /from\s+\d{4}\s+to\s+\d{4}/,
      ]);

    if (!points) {
      // Try to derive from year range e.g. "1980 to 2023"
      const yearRange = lower.match(/(\d{4})\s*(?:to|–|-)\s*(\d{4})/);
      qty.data_points = yearRange
        ? parseInt(yearRange[2]) - parseInt(yearRange[1]) + 1
        : 12;
    } else {
      qty.data_points = points;
    }
  }

  // Attach instruction sentences
  const instructions = buildInstructions(qty);
  Object.assign(qty, instructions);

  return qty;
}

/**
 * Build a formatted quantity block for LLM prompts (planner, blueprint, etc.)
 * Shows only the fields relevant to the current task type.
 */
function buildQuantityBlock(quantities, taskType) {
  const lines = [];

  if (taskType === 'word' || taskType === 'pdf') {
    if (quantities.total_pages) lines.push(`Pages: ${quantities.total_pages}`);
    if (quantities.total_words) lines.push(`Total words: ${quantities.total_words}`);
    if (quantities.sections) lines.push(`Sections: ${quantities.sections}`);
    if (quantities.words_per_section) {
      lines.push(`Words per section: ${quantities.words_per_section}–${quantities.words_per_section + 60}`);
    }
  }

  if (taskType === 'excel' || taskType === 'csv') {
    if (quantities.total_rows) lines.push(`Data rows: ${quantities.total_rows} (REQUIRED — use a loop)`);
    if (quantities.min_columns) lines.push(`Minimum columns: ${quantities.min_columns}`);
    if (quantities.column_hints?.length) {
      lines.push(`Column hints: ${quantities.column_hints.join(', ')}`);
    }
  }

  if (taskType === 'chart') {
    if (quantities.data_points) lines.push(`Data points: ${quantities.data_points}`);
  }

  if (!lines.length) return '(no specific quantity constraints)';
  return lines.join('\n');
}

module.exports = { resolveQuantity, buildQuantityBlock };

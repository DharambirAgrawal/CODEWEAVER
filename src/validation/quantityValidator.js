// src/validation/quantityValidator.js
// Validates that a parsed plan meets quantity targets.
// Returns { valid, corrections } where corrections is a formatted string
// ready to paste into a plan-correction LLM prompt.

'use strict';

/**
 * @param {object} parsedPlan  - output of planParser.parsePlan()
 * @param {object} quantities  - output of quantityResolver.resolveQuantity()
 * @returns {{ valid: boolean, errors: object[], corrections: string }}
 */
function validatePlanQuantities(parsedPlan, quantities) {
  const errors = [];

  if (!parsedPlan || !Array.isArray(parsedPlan.steps)) {
    return {
      valid: false,
      errors: [{ type: 'no_steps', detail: 'Plan has no steps array' }],
      corrections: '1. The plan has no steps. Re-generate the full plan.',
    };
  }

  // ── Every content step must have fn: and do: ──────────────────────────────
  for (const step of parsedPlan.steps) {
    if (!step.fn) {
      errors.push({
        type: 'missing_fn',
        step: step.title,
        detail: `Step "${step.title}" has no fn: field`,
      });
    }
    if (!step.do) {
      errors.push({
        type: 'missing_do',
        step: step.title,
        detail: `Step "${step.title}" has no do: field`,
      });
    }
  }

  // ── Word: check word count sum ─────────────────────────────────────────────
  if (quantities.total_words) {
    const sum = parsedPlan.steps
      .filter(s => s.words)
      .reduce((a, s) => a + s.words, 0);

    if (sum < quantities.total_words * 0.75) {
      errors.push({
        type: 'word_shortfall',
        detail: `Steps total ${sum} words but target is ${quantities.total_words}. ` +
          `Need ${quantities.total_words - sum} more words across steps.`,
      });
    }

    // Content steps without word target
    for (const step of parsedPlan.steps) {
      const title = (step.title || '').toLowerCase();
      const isContentStep = step.fn &&
        !title.includes('import') &&
        !title.includes('setup') &&
        !title.includes('save');

      if (isContentStep && !step.words) {
        errors.push({
          type: 'missing_word_target',
          step: step.title,
          detail: `Step "${step.title}" is a content step but has no words: field. ` +
            `Add: words: ${Math.ceil(quantities.words_per_section || 300)}`,
        });
      }
    }
  }

  // ── Excel/CSV: check row count ─────────────────────────────────────────────
  if (quantities.total_rows) {
    const hasRows = parsedPlan.steps.some(
      s => s.rows && s.rows >= quantities.total_rows * 0.9,
    );
    if (!hasRows) {
      errors.push({
        type: 'row_missing',
        detail: `No step has rows: ${quantities.total_rows}. ` +
          `Add rows: ${quantities.total_rows} to the data-population step.`,
      });
    }
  }

  // ── Function signature dependency check ──────────────────────────────────
  const defined = new Set();
  for (const step of parsedPlan.steps) {
    if (!step.fnParsed) continue;
    for (const inp of (step.fnParsed.inputs || [])) {
      if (inp && !defined.has(inp)) {
        errors.push({
          type: 'undefined_input',
          step: step.title,
          detail: `"${inp}" used as input in "${step.title}" but not returned by any earlier step`,
        });
      }
    }
    for (const out of (step.fnParsed.outputs || [])) {
      defined.add(out);
    }
  }

  // ── Build corrections string ───────────────────────────────────────────────
  const corrections = errors
    .map((e, i) => `${i + 1}. ${e.detail}`)
    .join('\n');

  return {
    valid: errors.length === 0,
    errors,
    corrections,
  };
}

module.exports = { validatePlanQuantities };

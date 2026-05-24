// src/utils/jsonExtract.js
// Extract and parse a single top-level JSON object from LLM output.
// Greedy /{[\s\S]*}/ breaks on nested objects + trailing junk; brace-depth
// parsing respects string literals and escapes.

/**
 * @param {string} s
 * @returns {string|null}
 */
function extractFirstJsonObject(s) {
  const start = s.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let i = start;
  let inString = false;
  let escape = false;

  while (i < s.length) {
    const c = s[i];

    if (!inString) {
      if (c === '"') {
        inString = true;
        i++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
      i++;
      continue;
    }

    if (escape) {
      escape = false;
      if (c === 'u' && /^[0-9a-fA-F]{4}/.test(s.slice(i + 1, i + 5))) {
        i += 4;
      }
      i++;
      continue;
    }
    if (c === '\\') {
      escape = true;
      i++;
      continue;
    }
    if (c === '"') {
      inString = false;
    }
    i++;
  }

  return null;
}

/**
 * Strip markdown fences and extract the first balanced `{ ... }` block, then JSON.parse.
 * @param {string} raw
 * @returns {{ ok: true, value: unknown, extracted: string } | { ok: false, error: string, extracted: string | null }}
 */
function parseJsonFromLlm(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'empty response', extracted: null };
  }

  let cleaned = raw
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  const extracted = extractFirstJsonObject(cleaned) || extractFirstJsonObject(raw);
  if (!extracted) {
    return { ok: false, error: 'no JSON object found', extracted: null };
  }

  try {
    return { ok: true, value: JSON.parse(extracted), extracted };
  } catch (e) {
    return { ok: false, error: e.message || String(e), extracted };
  }
}

module.exports = { extractFirstJsonObject, parseJsonFromLlm };

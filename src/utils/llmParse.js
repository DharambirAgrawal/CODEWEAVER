// src/utils/llmParse.js
// Unified parser for LLM structured output — supports YAML (preferred) and JSON fallback.
// YAML is ~40% fewer tokens than JSON for the same data, and LLMs produce it more reliably
// because there are no trailing-comma or unclosed-brace failure modes.

const YAML = require('yaml');
const { parseJsonFromLlm } = require('./jsonExtract');

const FENCE_RE = /```(?:ya?ml|json)?\s*\n?([\s\S]*?)```/i;
const YAML_DOC_RE = /^---\s*\n([\s\S]*?)(?:\n\.\.\.\s*$|\n---\s*$)/m;

function stripFences(raw) {
  const m = raw.match(FENCE_RE);
  return m ? m[1].trim() : raw.trim();
}

function tryYaml(text) {
  try {
    const value = YAML.parse(text);
    if (value && typeof value === 'object') return { ok: true, value };
  } catch {}
  return { ok: false };
}

function tryYamlDoc(raw) {
  const m = raw.match(YAML_DOC_RE);
  if (m) {
    const result = tryYaml(m[1]);
    if (result.ok) return result;
  }
  return { ok: false };
}

/**
 * Parse structured LLM output. Tries in order:
 * 1. YAML document markers (---)
 * 2. Fenced code block content as YAML
 * 3. Raw text as YAML
 * 4. JSON fallback (brace-balanced extraction)
 *
 * @param {string} raw - raw LLM response
 * @returns {{ ok: true, value: any, format: string } | { ok: false, error: string }}
 */
function parseLlmOutput(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'empty response' };
  }

  // 1. YAML document markers
  const docResult = tryYamlDoc(raw);
  if (docResult.ok) return { ...docResult, format: 'yaml-doc' };

  // 2. Fenced block
  const stripped = stripFences(raw);
  const yamlResult = tryYaml(stripped);
  if (yamlResult.ok) return { ...yamlResult, format: 'yaml' };

  // 3. Raw text as YAML (no fences)
  if (stripped !== raw.trim()) {
    const rawYaml = tryYaml(raw.trim());
    if (rawYaml.ok) return { ...rawYaml, format: 'yaml-raw' };
  }

  // 4. JSON fallback
  const jsonResult = parseJsonFromLlm(raw);
  if (jsonResult.ok) return { ok: true, value: jsonResult.value, format: 'json' };

  return { ok: false, error: jsonResult.error || 'no structured data found' };
}

module.exports = { parseLlmOutput, stripFences };

// src/skills/loader.js
// Select and inject domain skills into LLM prompts by task type, language, and phase.

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const SKILLS_DIR = path.join(__dirname, '../../skills');
const INDEX_PATH = path.join(SKILLS_DIR, 'index.json');
const DEFAULT_MAX_CHARS = parseInt(process.env.SKILL_MAX_CHARS || '12000', 10);

/** @type {object | null} */
let _indexCache = null;
/** @type {Map<string, { meta: object, body: string }>} */
const _fileCache = new Map();

const RUNTIME_HINTS = {
  docTest: `
DOC TEST HARNESS (these rules override the generic skill where they differ):
- Step 1 defines setupImports() returning helpers: createHeading, createPara, createCell, createRow, createTable.
- Middle steps MUST start with helpers.createHeading("<sectionHeading>", 1) — validation requires this exact pattern.
- Do NOT use HeadingLevel directly; use helpers.createHeading(text, 1|2).
- NEVER use /workspace/ paths — that is for Execify only. The final step uses fs.writeFileSync(OUTPUT_PATH, buffer).
- OUTPUT_PATH is already defined by the harness; do not hardcode output_123.docx or similar filenames.
- Helpers (fixed template): createHeading, createPara, createSpacer, createTable(headers[], rows[][]), createBulletList, createNumberedList — tables use WidthType.DXA full width.
- createBulletList / createNumberedList return arrays: always spread in return [...] as ...helpers.createBulletList([...])
- NEVER use bare new Table() — use helpers.createTable() only.
`.trim(),
  excelTest: `
EXCEL TEST HARNESS (overrides generic skill where they differ):
- Step 1 is setupExcel() (fixed) — returns helpers.sheetPayload(sheetName, rows).
- Middle steps: return helpers.sheetPayload("Exact Sheet Name", [[headers...], [data...]]).
- NEVER use /workspace/ — final step uses OUTPUT_PATH (injected by harness).
- Do NOT call XLSX.writeFile in middle steps — only assembleAndSave writes the file.
- Helpers: sheetPayload(name, rows, formulas), withRevenueColumn, withMarginPercentColumn, formula(cell, f).
- Transaction detail: use withRevenueColumn. Catalog: withMarginPercentColumn. Analysis: sheetPayload + SUM/AVERAGE/SUMIF formulas.
`.trim(),
};

function loadIndex() {
  if (_indexCache) return _indexCache;
  if (!fs.existsSync(INDEX_PATH)) {
    _indexCache = { skills: [] };
    return _indexCache;
  }
  _indexCache = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  return _indexCache;
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw.trim() };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    meta[key] = val;
  }
  return { meta, body: match[2].trim() };
}

function loadSkillFile(filename) {
  const filePath = path.join(SKILLS_DIR, filename);
  if (_fileCache.has(filePath)) return _fileCache.get(filePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Skill file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = parseFrontmatter(raw);
  const entry = { meta: parsed.meta, body: parsed.body, filePath };
  _fileCache.set(filePath, entry);
  return entry;
}

function normalizeList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

/**
 * @param {object} entry - skill index entry
 * @param {{ taskType?: string, language?: string, library?: string }} context
 */
function skillMatches(entry, context) {
  const match = entry.match || {};
  const taskTypes = normalizeList(match.taskTypes);
  const languages = normalizeList(match.languages);
  const libraries = normalizeList(match.libraries);

  if (taskTypes.length && context.taskType && !taskTypes.includes(context.taskType)) return false;
  if (languages.length && context.language && !languages.includes(context.language)) return false;
  if (libraries.length && context.library) {
    const lib = String(context.library).toLowerCase();
    const allowed = libraries.map(l => l.toLowerCase());
    if (!allowed.includes(lib)) return false;
  }
  return true;
}

/**
 * Pick skills for the current job context.
 * @param {{ taskType?: string, language?: string, library?: string, phase?: string }} context
 */
function selectSkills(context = {}) {
  const index = loadIndex();
  return (index.skills || []).filter(entry => skillMatches(entry, context));
}

function getPhaseMode(entry, phase) {
  const phases = entry.phases || {};
  if (phase && phases[phase]) return phases[phase];
  if (phases.codegen) return phases.codegen;
  return 'full';
}

/**
 * Extract markdown sections by ## heading (case-insensitive start match).
 */
function extractSections(body, titles) {
  if (!titles?.length) return null;
  const wanted = titles.map(t => t.toLowerCase());
  const sections = [];
  const lines = body.split('\n');
  let current = null;
  let buf = [];

  function flush() {
    if (current && buf.length) {
      sections.push({ title: current, text: buf.join('\n').trim() });
    }
    buf = [];
  }

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      flush();
      const title = h2[1].trim();
      const key = title.toLowerCase();
      if (wanted.includes(key) || wanted.some(w => key.startsWith(w))) {
        current = title;
      } else {
        current = null;
      }
      continue;
    }
    if (current) buf.push(line);
  }
  flush();

  if (!sections.length) return null;
  return sections.map(s => `## ${s.title}\n\n${s.text}`).join('\n\n');
}

function resolveSectionTitles(entry, mode, phase) {
  if (mode === 'full') return null;
  if (mode === 'summary') {
    return entry.phaseSections?.summary || ['CodeWeaver execution model', 'Common mistakes'];
  }
  if (mode === 'sections' && phase) {
    const byPhase = entry.phaseSections?.sections?.[phase];
    if (byPhase) return byPhase;
  }
  return entry.phaseSections?.summary || ['CodeWeaver execution model'];
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[... skill truncated for token budget ...]`;
}

/**
 * Load skill body for one index entry.
 */
function getSkillContent(entry, context = {}) {
  const phase = context.phase || 'codegen';
  const mode = getPhaseMode(entry, phase);
  const { body } = loadSkillFile(entry.file);
  const sectionTitles = resolveSectionTitles(entry, mode, phase);
  let content = sectionTitles ? extractSections(body, sectionTitles) : null;
  if (!content) content = body;
  return truncate(content, context.maxChars || DEFAULT_MAX_CHARS);
}

/**
 * Build prompt block for all matching skills.
 * @param {{ taskType?: string, language?: string, library?: string, phase?: string, runtime?: string }} context
 */
function buildSkillPromptBlock(context = {}) {
  if (process.env.SKILLS_ENABLED === '0') return '';

  const runtime = context.runtime;
  const selected = selectSkills(context);
  const runtimeOnly = (runtime === 'docTest' || runtime === 'excelTest') && context.phase === 'assembly';

  if (!selected.length && !(runtime && RUNTIME_HINTS[runtime])) return '';

  const parts = runtimeOnly
    ? []
    : selected.map(entry => {
      const content = getSkillContent(entry, context);
      const label = entry.id || entry.file;
      return `### Skill: ${label}\n${content}`;
    });

  let block = '';
  if (parts.length) {
    block = [
      '',
      '---',
      'REFERENCE SKILLS (follow these patterns; do not invent APIs or helpers outside what the harness allows):',
      parts.join('\n\n'),
      '---',
      '',
    ].join('\n');
  }

  if (runtime && RUNTIME_HINTS[runtime]) {
    block += `\n---\nRUNTIME (${runtime}):\n${RUNTIME_HINTS[runtime]}\n---\n`;
  }

  logger.debug('Skills', `Injected ${selected.map(s => s.id).join(', ')} phase=${context.phase || 'codegen'}`);
  return block;
}

/** Human-readable summary for logs */
function describeSelectedSkills(context = {}) {
  return selectSkills(context).map(s => s.id).join(', ') || '(none)';
}

function clearSkillCache() {
  _indexCache = null;
  _fileCache.clear();
}

/**
 * Lightweight catalog for prompt refinement (names + descriptions only).
 */
function getSkillCatalog() {
  const index = loadIndex();
  const { TASK_TYPES } = require('../tasks/taskTypes');

  const skills = (index.skills || []).map(entry => ({
    id: entry.id || entry.file,
    description: entry.description || entry.id || entry.file,
    taskTypes: normalizeList(entry.match?.taskTypes),
    languages: normalizeList(entry.match?.languages),
    libraries: normalizeList(entry.match?.libraries),
  }));

  const taskTypes = Object.entries(TASK_TYPES).map(([type, def]) => ({
    type,
    label: def.label,
    extensions: def.extensions || [def.defaultExtension].filter(Boolean),
  }));

  return { skills, taskTypes };
}

// ── New: section-level extraction for the new pipeline ───────────────────────

/**
 * Parse a full skill file body into named sections keyed by ## heading.
 * Used by the new step-level code generator to inject only the relevant section.
 *
 * @param {string} skillRaw  - full skill file content (without frontmatter)
 * @returns {object}  { overview: string, imports: string, setup: string, ... }
 */
function extractSkillSections(skillRaw) {
  const sections = {};
  let current = 'overview';
  sections[current] = [];

  for (const line of (skillRaw || '').split('\n')) {
    const h2 = line.match(/^##\s+(.+)/);
    const h3 = line.match(/^###\s+(.+)/);
    const heading = (h2 || h3)?.[1]?.toLowerCase().replace(/\s+/g, '_');
    if (heading) {
      current = heading;
      if (!sections[current]) sections[current] = [];
    } else {
      if (!sections[current]) sections[current] = [];
      sections[current].push(line);
    }
  }

  return Object.fromEntries(
    Object.entries(sections).map(([k, v]) => [k, v.join('\n').trim()]),
  );
}

/**
 * Pick the most relevant skill section for a given step.
 * Keeps token usage focused on what the LLM actually needs.
 *
 * @param {object} step          - plan step with title and do fields
 * @param {object} skillSections - output of extractSkillSections()
 * @param {string} taskType      - 'word' | 'excel' | 'chart' | etc.
 * @param {string} [skillRaw]    - full raw skill text (fallback)
 * @returns {string}
 */
function pickSkillSection(step, skillSections, taskType, skillRaw) {
  const title = (step.title || '').toLowerCase();
  const doText = (step.do || '').toLowerCase();
  const fallback = skillSections.overview || (skillRaw || '').slice(0, 1500);

  // Imports step
  if (title === 'imports' || title.includes('import')) {
    return skillSections.imports || skillSections.dependencies || fallback;
  }

  // Setup / init step
  if (title.includes('setup') || title.includes('create') || title.includes('init')) {
    return skillSections.setup || skillSections.document_setup || fallback;
  }

  // Word content steps
  if (taskType === 'word') {
    if (doText.includes('table')) {
      return skillSections.tables || fallback;
    }
    if (doText.includes('image') || doText.includes('picture')) {
      return skillSections.images || fallback;
    }
    if (doText.includes('heading') || doText.includes('section')) {
      return skillSections.headings || skillSections.paragraphs || fallback;
    }
    return skillSections.paragraphs || fallback;
  }

  // Excel steps
  if (taskType === 'excel') {
    if (doText.includes('header') || doText.includes('style') || doText.includes('format')) {
      return skillSections.styling || skillSections.formatting || fallback;
    }
    if (doText.includes('formula') || doText.includes('sum') || doText.includes('average')) {
      return skillSections.formulas || fallback;
    }
    if (doText.includes('chart') || doText.includes('graph')) {
      return skillSections.charts || fallback;
    }
    return skillSections.writing_data || skillSections.bulk_data || skillSections.large_tables || fallback;
  }

  // Chart steps
  if (taskType === 'chart') {
    return skillSections.chart_types || skillSections.styling || fallback;
  }

  return fallback;
}

/**
 * Load a skill file by task type + runtime and return its extracted sections.
 * @param {string} taskType  - 'word' | 'excel' | 'chart' | 'csv'
 * @param {string} language  - 'python' | 'node'
 * @param {string} library   - e.g. 'openpyxl', 'docx'
 * @returns {{ skill_raw: string, skill_sections: object } | null}
 */
function loadSkillForTask(taskType, language, library) {
  const index = loadIndex();
  const context = { taskType, language, library };
  const matches = (index.skills || []).filter(entry => skillMatches(entry, context));

  if (!matches.length) return null;

  try {
    const entry = matches[0];
    const { body } = loadSkillFile(entry.file);
    return {
      skill_raw: body,
      skill_sections: extractSkillSections(body),
    };
  } catch {
    return null;
  }
}

module.exports = {
  selectSkills,
  buildSkillPromptBlock,
  describeSelectedSkills,
  getSkillContent,
  getSkillCatalog,
  clearSkillCache,
  extractSkillSections,
  pickSkillSection,
  loadSkillForTask,
  SKILLS_DIR,
};

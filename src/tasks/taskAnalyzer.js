// src/tasks/taskAnalyzer.js
// Unified Phase 0: single LLM call replaces promptRefiner + taskParser.
// Produces a complete task spec with data-driven complexity and volume estimates.
// Also pre-computes quantities so every downstream stage has hard targets.

const { getSkillCatalog } = require('../skills/loader');
const { TASK_TYPES } = require('./taskTypes');
const { parseLlmOutput } = require('../utils/llmParse');
const { resolveQuantity } = require('./quantityResolver');
const logger = require('../utils/logger');

function buildAnalyzerPrompt(rawMessage) {
  // Keep the prompt compact — the analyzer is sent to smaller/faster models.
  return `Analyze this file-generation request and return YAML only (no fences, no explanation).

REQUEST: """
${rawMessage.slice(0, 3000)}
"""

Return exactly:
task_type: excel|word|pdf|csv|text|chart
complexity: low|medium|high
output_file: filename.ext or null
refined_prompt: one-paragraph detailed spec
requirements:
  - requirement 1
  - requirement 2
data_description: brief summary
volume:
  estimated_rows: null or number
  estimated_pages: null or number
  estimated_sections: null or number
  estimated_words: null or number
  sheets: null
  sections: null
step_budget:
  min_steps: 2
  max_steps: 12
  rationale: brief reason`;
}

function resolveOutputFile(name, taskType) {
  if (!name || typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed === 'null') return null;

  const taskDef = taskType ? TASK_TYPES[taskType] : null;
  if (!taskDef) return /\.\w{2,5}$/i.test(trimmed) ? trimmed : null;

  const lower = trimmed.toLowerCase();
  if (taskDef.extensions.some(ext => lower.endsWith(ext))) return trimmed;
  if (!/\.\w{2,5}$/i.test(trimmed)) return `${trimmed}${taskDef.defaultExtension}`;
  return null;
}

function estimateComplexityFromVolume(volume) {
  const rows = volume?.estimated_rows || 0;
  const pages = volume?.estimated_pages || 0;
  const sections = volume?.estimated_sections || 0;
  const words = volume?.estimated_words || 0;
  const sheets = Array.isArray(volume?.sheets) ? volume.sheets.length : 0;

  if (rows > 500 || pages > 8 || sections > 8 || words > 5000 || sheets > 4) return 'high';
  if (rows > 100 || pages > 3 || sections > 4 || words > 1500 || sheets > 2) return 'medium';
  return 'low';
}

function computeStepBudget(complexity, volume) {
  const base = { low: 2, medium: 4, high: 6 }[complexity] || 3;
  const sheets = Array.isArray(volume?.sheets) ? volume.sheets.length : 0;
  const sections = volume?.estimated_sections || 0;

  // Each sheet or major section may warrant its own step
  const contentDriven = Math.max(sheets, Math.ceil(sections / 2));
  const adjusted = Math.max(base, contentDriven + 1); // +1 for setup or assembly
  return Math.min(adjusted, 12);
}

/**
 * Single LLM call that replaces both promptRefiner and parseWithLLM.
 * @param {string} rawMessage
 * @param {{ complete: Function }} llmClient
 * @returns {Promise<object>} task spec
 */
async function analyzeTask(rawMessage, llmClient) {
  const raw = String(rawMessage || '').trim();
  const fallback = buildFallback(raw);

  if (!raw) return fallback;
  if (process.env.TASK_ANALYZER_ENABLED === '0') return fallback;

  const prompt = buildAnalyzerPrompt(raw);

  try {
    const response = await llmClient.complete(prompt, {
      maxTokens: 1500,
      temperature: 0.15,
    });

    const parsed = parseLlmOutput(response);
    if (!parsed.ok) throw new Error(parsed.error);
    const data = parsed.value;

    const taskType = TASK_TYPES[data.task_type] ? data.task_type : detectTaskType(raw);
    const taskDef = TASK_TYPES[taskType];
    const volume = data.volume || {};
    const complexity = ['low', 'medium', 'high'].includes(data.complexity)
      ? data.complexity
      : estimateComplexityFromVolume(volume);

    const refinedPrompt = String(data.refined_prompt || raw).trim() || raw;
    const requirements = Array.isArray(data.requirements)
      ? data.requirements.map(String).filter(Boolean)
      : [];
    const outputFile = resolveOutputFile(data.output_file, taskType)
      || `output_${Date.now()}${taskDef.defaultExtension}`;

    const stepBudget = data.step_budget || {};
    const estimatedChunks = computeStepBudget(complexity, volume);

    logger.info(
      'TaskAnalyzer',
      `Analyzed: type=${taskType} complexity=${complexity} steps=${estimatedChunks} (${raw.length} → ${refinedPrompt.length} chars)`,
    );

    const resolvedVolume = {
      estimatedRows: volume.estimated_rows || null,
      estimatedPages: volume.estimated_pages || null,
      estimatedSections: volume.estimated_sections || null,
      estimatedWords: volume.estimated_words || null,
      sheets: Array.isArray(volume.sheets) ? volume.sheets : null,
      sections: Array.isArray(volume.sections) ? volume.sections : null,
    };

    // Pre-compute hard quantity targets so all downstream stages share the same numbers
    const quantities = resolveQuantity(taskType, raw, resolvedVolume);

    return {
      type: taskType,
      label: taskDef.label,
      language: taskDef.language,
      preferredLibrary: taskDef.preferredLibrary,
      outputFile,
      complexity,
      estimatedChunks,
      rawMessage: raw,
      refinedMessage: refinedPrompt,
      requirements,
      dataDescription: String(data.data_description || refinedPrompt).trim(),
      volume: resolvedVolume,
      quantities,
      stepBudget: {
        min: Math.max(2, parseInt(stepBudget.min_steps) || 2),
        max: Math.min(12, parseInt(stepBudget.max_steps) || 12),
        rationale: String(stepBudget.rationale || '').trim(),
      },
      // Legacy compat fields
      estimatedRows: volume.estimated_rows || null,
      estimatedPages: volume.estimated_pages || null,
      sheets: Array.isArray(volume.sheets) ? volume.sheets : null,
      sections: Array.isArray(volume.sections) ? volume.sections : null,
    };
  } catch (err) {
    logger.warn('TaskAnalyzer', 'LLM analysis failed, using local fallback', err.message);
    return fallback;
  }
}

function detectTaskType(message) {
  const lower = message.toLowerCase();
  if (/excel|xlsx|spreadsheet|worksheet|workbook/.test(lower)) return 'excel';
  if (/word|docx|document|report|letter|doc\b/.test(lower)) return 'word';
  if (/pdf/.test(lower)) return 'pdf';
  if (/csv|comma.separated/.test(lower)) return 'csv';
  if (/chart|graph|plot|visualization|diagram/.test(lower)) return 'chart';
  if (/text|txt|plain/.test(lower)) return 'text';
  return 'word';
}

function buildFallback(raw) {
  const type = detectTaskType(raw);
  const taskDef = TASK_TYPES[type];
  const volume = {
    estimatedRows: null,
    estimatedPages: null,
    estimatedSections: null,
    estimatedWords: null,
    sheets: null,
    sections: null,
  };
  return {
    type,
    label: taskDef.label,
    language: taskDef.language,
    preferredLibrary: taskDef.preferredLibrary,
    outputFile: `output_${Date.now()}${taskDef.defaultExtension}`,
    complexity: 'medium',
    estimatedChunks: 3,
    rawMessage: raw,
    refinedMessage: raw,
    requirements: [],
    dataDescription: raw,
    volume,
    quantities: resolveQuantity(type, raw, volume),
    stepBudget: { min: 2, max: 6, rationale: '' },
    estimatedRows: null,
    estimatedPages: null,
    sheets: null,
    sections: null,
  };
}

module.exports = { analyzeTask, buildAnalyzerPrompt, detectTaskType };

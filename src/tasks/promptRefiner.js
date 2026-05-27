// src/tasks/promptRefiner.js
// Phase 0: expand vague user prompts using skill catalog context before task parse / plan.

const { getSkillCatalog } = require('../skills/loader');
const { TASK_TYPES } = require('./taskTypes');
const { parseJsonFromLlm } = require('../utils/jsonExtract');
const logger = require('../utils/logger');

function buildPromptRefinerPrompt(rawMessage) {
  const { skills, taskTypes } = getSkillCatalog();

  const skillLines = skills.length
    ? skills
      .map(s => {
        const types = (s.taskTypes || []).join(', ') || 'any';
        return `- ${s.id}: ${s.description} (types: ${types})`;
      })
      .join('\n')
    : '(no domain skills registered)';

  const taskLines = taskTypes
    .map(t => `- ${t.type}: ${t.label} (${(t.extensions || []).join(', ')})`)
    .join('\n');

  return `You prepare user requests for an automated file-generation pipeline.

The user message may be short or ambiguous. Expand it into a clear specification and pick the best output type.

USER REQUEST:
"""
${rawMessage}
"""

SUPPORTED OUTPUT TYPES:
${taskLines}

DOMAIN SKILLS (match taskType to the deliverable; skills are injected during planning/codegen):
${skillLines}

Return ONLY valid JSON, no markdown:
{
  "refinedPrompt": "Detailed actionable spec (2-8 sentences): deliverable, structure, data volume, formatting, sheets/sections/charts as relevant. Stay faithful — do not add features the user rejected.",
  "taskType": "excel|word|pdf|csv|text|chart",
  "complexity": "low|medium|high",
  "outputFileName": "filename with correct extension, or null to auto-generate",
  "requirements": ["concrete requirement 1", "requirement 2"]
}

Rules:
- refinedPrompt is the single source of truth for downstream planning
- If the user was already detailed, reorganize and clarify; do not invent unrelated scope
- taskType must match the deliverable (chart for plots/images, excel for spreadsheets, word for documents/reports)
- requirements: short, testable bullets`;
}

/**
 * Expand a user message into a detailed spec + task hints.
 * @param {string} rawMessage
 * @param {{ complete: Function }} llmClient
 */
async function refineUserPrompt(rawMessage, llmClient) {
  const raw = String(rawMessage || '').trim();
  const fallback = {
    refinedPrompt: raw,
    taskType: null,
    complexity: null,
    outputFileName: null,
    requirements: [],
    rawMessage: raw,
  };

  if (!raw) return fallback;
  if (process.env.PROMPT_REFINE_ENABLED === '0') return fallback;

  const prompt = buildPromptRefinerPrompt(raw);

  try {
    const response = await llmClient.complete(prompt, {
      maxTokens: 1200,
      jsonObject: true,
      temperature: 0.2,
    });
    const parsed = parseJsonFromLlm(response);
    if (!parsed.ok) throw new Error(parsed.error);
    const data = parsed.value;

    const taskType = TASK_TYPES[data.taskType] ? data.taskType : null;
    const complexity = ['low', 'medium', 'high'].includes(data.complexity)
      ? data.complexity
      : null;
    const refinedPrompt = String(data.refinedPrompt || raw).trim() || raw;
    const requirements = Array.isArray(data.requirements)
      ? data.requirements.map(String).filter(Boolean)
      : [];
    const outputFileName = resolveOutputFileName(data.outputFileName, taskType);

    logger.info(
      'PromptRefiner',
      `Refined prompt (${raw.length} → ${refinedPrompt.length} chars) taskType=${taskType || 'auto'}`,
    );

    return {
      refinedPrompt,
      taskType,
      complexity,
      outputFileName,
      requirements,
      rawMessage: raw,
    };
  } catch (err) {
    logger.warn('PromptRefiner', 'LLM refine failed, using raw message', err.message);
    return fallback;
  }
}

function resolveOutputFileName(name, taskType) {
  if (!name || typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;

  const taskDef = taskType ? TASK_TYPES[taskType] : null;
  if (!taskDef) {
    return /\.\w{2,5}$/i.test(trimmed) ? trimmed : null;
  }

  const lower = trimmed.toLowerCase();
  if (taskDef.extensions.some(ext => lower.endsWith(ext))) return trimmed;
  if (!/\.\w{2,5}$/i.test(trimmed)) return `${trimmed}${taskDef.defaultExtension}`;
  return null;
}

module.exports = { refineUserPrompt, buildPromptRefinerPrompt, resolveOutputFileName };

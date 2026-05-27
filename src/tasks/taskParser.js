// src/tasks/taskParser.js
// Converts raw user message into a structured task object using LLM

const { detectTaskType, estimateComplexity, estimateChunks, TASK_TYPES } = require('./taskTypes');
const logger = require('../utils/logger');
const { parseJsonFromLlm } = require('../utils/jsonExtract');

function resolveOutputFileName(name, taskDef) {
  if (!name || typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (taskDef.extensions.some(ext => lower.endsWith(ext))) return trimmed;
  if (!/\.\w{2,5}$/i.test(trimmed)) return `${trimmed}${taskDef.defaultExtension}`;
  return null;
}

// Quick local parse — runs before LLM to give initial structure
function quickParse(message, overrides = {}) {
  const type = overrides.taskType && TASK_TYPES[overrides.taskType]
    ? overrides.taskType
    : detectTaskType(message);
  const complexity = overrides.complexity || estimateComplexity(message);
  const estimatedChunks = estimateChunks(complexity);
  const taskDef = TASK_TYPES[type];

  const timestamp = Date.now();
  const outputFile = resolveOutputFileName(overrides.outputFileName, taskDef)
    || `output_${timestamp}${taskDef.defaultExtension}`;

  return {
    type,
    label: taskDef.label,
    language: taskDef.language,
    preferredLibrary: taskDef.preferredLibrary,
    outputFile,
    complexity,
    estimatedChunks,
    rawMessage: overrides.rawMessage || message,
    refinedMessage: overrides.refinedMessage || message,
    requirements: overrides.requirements || [],
  };
}

// Full LLM-based parse — extracts structured requirements from message
// Returns enhanced task object with requirements array
// options.refinement — output from refineUserPrompt (refinedPrompt, taskType, etc.)
async function parseWithLLM(message, llmClient, options = {}) {
  const refinement = options.refinement;
  const parseMessage = refinement?.refinedPrompt || message;
  const base = quickParse(parseMessage, {
    taskType: refinement?.taskType,
    complexity: refinement?.complexity,
    outputFileName: refinement?.outputFileName,
    requirements: refinement?.requirements,
    rawMessage: message,
    refinedMessage: parseMessage,
  });

  const prompt = `You are a task parser for a file generation system.

User request: "${parseMessage}"

Extract the requirements for generating this file. Return ONLY valid JSON, no markdown, no explanation.

Return this exact structure:
{
  "type": "${base.type}",
  "outputFile": "${base.outputFile}",
  "complexity": "${base.complexity}",
  "requirements": ["requirement 1", "requirement 2", "requirement 3"],
  "dataDescription": "brief description of the data/content needed",
  "estimatedRows": null,
  "estimatedPages": null,
  "sheets": null,
  "sections": null
}

Rules:
- requirements: list of specific things the file must contain or do
- estimatedRows: number if user mentioned rows/records, else null
- estimatedPages: number if user mentioned pages, else null
- sheets: array of sheet names if Excel with multiple sheets, else null
- sections: array of section names if Word doc with sections, else null
- Keep requirements concrete and actionable`;

  try {
    const response = await llmClient.complete(prompt, {
      maxTokens: 500,
      jsonObject: true,
      temperature: 0.1,
    });
    const parsed = parseJsonFromLlm(response);
    if (!parsed.ok) throw new Error(parsed.error);
    const data = parsed.value;

    const mergedRequirements = [
      ...(base.requirements || []),
      ...(data.requirements || []),
    ].filter((r, i, arr) => arr.indexOf(r) === i);

    return {
      ...base,
      requirements: mergedRequirements.length ? mergedRequirements : (data.requirements || []),
      dataDescription: data.dataDescription || parseMessage,
      estimatedRows: data.estimatedRows || null,
      estimatedPages: data.estimatedPages || null,
      sheets: data.sheets || null,
      sections: data.sections || null,
    };
  } catch (err) {
    logger.warn('TaskParser', 'LLM parse failed, using quick parse', err.message);
    return { ...base, dataDescription: parseMessage };
  }
}

module.exports = { quickParse, parseWithLLM, resolveOutputFileName };

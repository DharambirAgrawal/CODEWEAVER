// src/orchestrator.js
// The brain — manages the full plan → generate → execute → verify loop

const { llmComplete } = require('./llm/client');
const {
  buildPlannerPrompt,
  buildCodeGenPrompt,
  buildRetryPrompt,
  buildValidationFixPrompt,
  buildSectionPrompt,
  buildSectionStructurePrompt,
} = require('./llm/prompts');
const { parseWithLLM } = require('./tasks/taskParser');
const { parseJsonFromLlm } = require('./utils/jsonExtract');
const execify = require('./execify/client');
const { validateResult, formatErrorForLLM } = require('./execify/validator');
const { extractContent } = require('./content/extractor');
const { buildBlueprint } = require('./content/blueprint');
const { formatErrorForRetry } = require('./utils/errorClassifier');
const { checkSectionContract, DEFAULT_DOCX_ALLOWED_CONSTRUCTORS } = require('./utils/contractChecker');
const { TASK_TYPES } = require('./tasks/taskTypes');
const logger = require('./utils/logger');

const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '5');
const DOCX_SECTION_IMPORTS = [
  'Document',
  'Paragraph',
  'TextRun',
  'Table',
  'TableRow',
  'TableCell',
  'HeadingLevel',
  'AlignmentType',
  'BorderStyle',
  'WidthType',
];

// ─── JOB STATE ────────────────────────────────────────────────────────────────
// In-memory job store — replace with Redis for production
const jobs = new Map();

function createJob(jobId, message) {
  const job = {
    id: jobId,
    message,
    status: 'pending', // pending | running | done | failed
    currentStep: 0,
    totalSteps: 0,
    stepName: '',
    task: null,
    plan: null,
    content: null,
    blueprint: null,
    sessionId: null,
    outputFile: null,
    outputData: null, // base64 file data
    outputMime: null,
    error: null,
    log: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // SSE subscribers
    _subscribers: [],
  };
  jobs.set(jobId, job);
  return job;
}

function updateJob(job, updates) {
  Object.assign(job, updates, { updatedAt: Date.now() });
  // Notify SSE subscribers
  if (job._subscribers.length > 0) {
    const event = buildProgressEvent(job);
    job._subscribers.forEach(send => {
      try { send(event); } catch {}
    });
  }
}

function buildProgressEvent(job) {
  return {
    status: job.status,
    currentStep: job.currentStep,
    totalSteps: job.totalSteps,
    stepName: job.stepName,
    message: job.log[job.log.length - 1] || '',
  };
}

function getJob(jobId) {
  return jobs.get(jobId) || null;
}

function subscribeToJob(jobId, sendFn) {
  const job = jobs.get(jobId);
  if (!job) return false;
  job._subscribers.push(sendFn);
  return true;
}

function unsubscribeFromJob(jobId, sendFn) {
  const job = jobs.get(jobId);
  if (!job) return;
  job._subscribers = job._subscribers.filter(s => s !== sendFn);
}

// ─── MAIN ORCHESTRATION LOOP ──────────────────────────────────────────────────
async function runJob(jobId) {
  const job = getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  updateJob(job, { status: 'running' });
  addLog(job, 'Starting job...');

  try {
    // ── PHASE 1: Parse task ──────────────────────────────────────────────────
    addLog(job, 'Understanding your request...');
    const parsedTask = await parseWithLLM(job.message, { complete: llmComplete });
    const task = resolveRuntimeTask(parsedTask);
    updateJob(job, { task });
    addLog(job, `Task type: ${task.label} | Complexity: ${task.complexity}`);

    if (task.type === 'word') {
      await runWordJobV2({ job, task, jobId });
    } else {
      await runPlannedJob({ job, task, jobId });
    }

    // ── PHASE 5: Cleanup & complete ──────────────────────────────────────────
    try {
      await execify.deleteSession(job.sessionId);
    } catch {}

    updateJob(job, { status: 'done' });
    addLog(job, 'Done! Your file is ready to download.');
    logger.info('Orchestrator', `Job ${jobId} completed successfully`);

  } catch (err) {
    logger.error('Orchestrator', `Job ${jobId} failed`, err.message);
    updateJob(job, { status: 'failed', error: err.message });
    addLog(job, `Failed: ${err.message}`);

    // Cleanup session on failure
    if (job.sessionId) {
      try { await execify.deleteSession(job.sessionId); } catch {}
    }
  }
}

// ─── NON-WORD TASK FLOW (PLANNED) ───────────────────────────────────────────
async function runPlannedJob({ job, task, jobId }) {
  // ── PHASE 2: Plan ────────────────────────────────────────────────────────
  addLog(job, 'Planning the code structure...');
  const planPrompt = buildPlannerPrompt(task);
  const planRaw = await llmComplete(planPrompt, {
    maxTokens: 2000,
    jsonObject: true,
    temperature: 0.15,
  });
  const plan = parsePlan(planRaw, task);

  updateJob(job, { plan, totalSteps: plan.steps.length });
  addLog(job, `Plan ready: ${plan.steps.length} steps — ${plan.steps.map(s => s.name).join(' → ')}`);

  // ── PHASE 3: Create Execify session ─────────────────────────────────────
  addLog(job, 'Setting up execution environment...');
  const session = await execify.createSession();
  updateJob(job, { sessionId: session.session_id });
  logger.info('Orchestrator', `Session created: ${session.session_id}`);

  // ── PHASE 4: Chunked code generation + execution ─────────────────────────
  const verifiedFunctions = [];

  for (let i = 0; i < plan.steps.length; i++) {
    const step = { ...plan.steps[i], isLast: i === plan.steps.length - 1 };

    updateJob(job, { currentStep: i + 1, stepName: step.name });
    addLog(job, `Step ${i + 1}/${plan.steps.length}: ${step.description}`);
    logger.step(jobId, i + 1, plan.steps.length, step.name, 'starting');

    const result = await executeStep({
      job,
      task,
      plan,
      step,
      verifiedFunctions,
      sessionId: session.session_id,
    });

    if (!result.success) {
      throw new Error(`Step "${step.name}" failed after ${MAX_RETRIES} attempts: ${result.error}`);
    }

    verifiedFunctions.push({
      step: step.step,
      functionName: step.functionName,
      returns: step.returns,
      description: step.description,
    });

    logger.step(jobId, i + 1, plan.steps.length, step.name, 'done ✓');

    // If last step — capture the output file
    if (step.isLast && result.outputFile) {
      updateJob(job, {
        outputFile: result.outputFile.name,
        outputData: result.outputFile.data,
        outputMime: getMimeType(task.type),
      });
      addLog(job, `File ready: ${result.outputFile.name}`);
    }
  }
}

// ─── WORD TASK FLOW (V2) ────────────────────────────────────────────────────
async function runWordJobV2({ job, task, jobId }) {
  addLog(job, 'Extracting document content...');
  const content = await extractContent({ message: job.message, task, complete: llmComplete });
  updateJob(job, { content });

  addLog(job, 'Building blueprint...');
  const blueprint = buildBlueprint(content, {
    outputFile: task.outputFile,
    language: task.language,
    library: task.preferredLibrary,
  });

  updateJob(job, { blueprint, totalSteps: blueprint.sections.length + 1 });
  addLog(job, `Blueprint ready: ${blueprint.sections.length} sections`);

  addLog(job, 'Setting up execution environment...');
  const session = await execify.createSession();
  updateJob(job, { sessionId: session.session_id });
  logger.info('Orchestrator', `Session created: ${session.session_id}`);

  const sectionFunctions = new Map();

  for (let i = 0; i < blueprint.sections.length; i++) {
    const section = blueprint.sections[i];
    const functionName = buildSectionFunctionName(section.id, task.language);

    updateJob(job, { currentStep: i + 1, stepName: section.id });
    addLog(job, `Section ${i + 1}/${blueprint.sections.length}: ${section.type} (${section.id})`);

    const result = await generateSectionFunction({
      job,
      task,
      section,
      functionName,
      sessionId: session.session_id,
      errorContext: null,
    });

    sectionFunctions.set(section.id, {
      functionName,
      code: result.code,
    });
  }

  // Final assembly + execution (deterministic)
  const maxFinalAttempts = Math.min(2, MAX_RETRIES);
  let lastFinalError = null;

  for (let attempt = 1; attempt <= maxFinalAttempts; attempt++) {
    updateJob(job, { currentStep: blueprint.sections.length + 1, stepName: 'assemble_and_save' });
    addLog(job, `Assembling document (attempt ${attempt}/${maxFinalAttempts})...`);

    const assemblyCode = buildAssemblyScript({
      task,
      blueprint,
      sectionFunctions,
    });

    let execResult;
    try {
      execResult = await execify.execute({
        language: task.language,
        code: assemblyCode,
        sessionId: session.session_id,
      });
    } catch (err) {
      lastFinalError = `Execution request failed: ${err.message}`;
      continue;
    }

    const structuralBlueprint = execify.isMock ? null : blueprint;
    const validation = await validateResult(execResult, task, { isLast: true }, structuralBlueprint);
    if (validation.valid) {
      updateJob(job, {
        outputFile: validation.file.name,
        outputData: validation.file.data,
        outputMime: getMimeType(task.type),
      });
      addLog(job, `File ready: ${validation.file.name}`);
      return;
    }

    // Structural or runtime failure — retry targeted sections if possible
    if (validation.type === 'validation_error' && validation.details) {
      lastFinalError = validation.message;
      addLog(job, `  Validation failed: ${validation.message}`);
      const retryIds = selectSectionsForRetry(blueprint, validation.details);
      if (retryIds.length === 0) break;
      await regenerateSections({
        job,
        task,
        blueprint,
        sectionIds: retryIds,
        sectionFunctions,
        sessionId: session.session_id,
        errorContext: validation.message,
      });
      continue;
    }

    lastFinalError = formatErrorForRetry(formatErrorForLLM(execResult), {
      language: task.language,
      library: task.preferredLibrary,
    });

    const failingId = findFailingSectionId(lastFinalError, sectionFunctions);
    if (failingId) {
      await regenerateSections({
        job,
        task,
        blueprint,
        sectionIds: [failingId],
        sectionFunctions,
        sessionId: session.session_id,
        errorContext: lastFinalError,
      });
      continue;
    }

    break;
  }

  throw new Error(`Final assembly failed: ${lastFinalError || 'unknown error'}`);
}

// ─── EXECUTE A SINGLE STEP WITH RETRY ────────────────────────────────────────
async function executeStep({ job, task, plan, step, verifiedFunctions, sessionId }) {
  let lastError = null;
  let useValidationFix = false;
  let lastValidationResult = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const prompt = attempt === 1
      ? buildCodeGenPrompt(task, plan, step, verifiedFunctions)
      : useValidationFix
        ? buildValidationFixPrompt(task, plan, step, verifiedFunctions, lastValidationResult)
        : buildRetryPrompt(task, plan, step, verifiedFunctions, lastError, attempt);

    // Generate code
    addLog(job, attempt > 1
      ? `  Retry ${attempt}/${MAX_RETRIES} for step "${step.name}"...`
      : `  Generating code for "${step.name}"...`
    );

    let code;
    try {
      code = await llmComplete(prompt, { maxTokens: 4096, temperature: attempt === 1 ? 0.2 : 0.4 });
      code = cleanCode(code);
    } catch (llmErr) {
      lastError = `LLM generation failed: ${llmErr.message}`;
      logger.warn('Orchestrator', lastError);
      continue;
    }

    // Execute on Execify
    addLog(job, `  Executing step "${step.name}"...`);
    let execResult;
    try {
      execResult = await execify.execute({ language: task.language, code, sessionId });
    } catch (execErr) {
      lastError = formatErrorForRetry(`Execution request failed: ${execErr.message}`, {
        language: task.language,
        library: task.preferredLibrary,
      });
      logger.warn('Orchestrator', lastError);
      continue;
    }

    // Validate result
    const validation = await validateResult(execResult, task, step);

    if (validation.valid) {
      return {
        success: true,
        code,
        outputFile: validation.file || null,
      };
    }

    if (validation.type === 'validation_error') {
      lastError = validation.message;
      lastValidationResult = validation;
      useValidationFix = true;
      addLog(job, `  Validation failed: ${validation.message}`);
    } else {
      lastError = formatErrorForRetry(formatErrorForLLM(execResult), {
        language: task.language,
        library: task.preferredLibrary,
      });
      useValidationFix = false;
      lastValidationResult = null;
      addLog(job, `  Error: ${execResult.stderr?.split('\n').slice(-2).join(' ') || 'execution failed'}`);
    }

    // Non-retryable error — break early
    if (!validation.retryable) {
      logger.warn('Orchestrator', `Non-retryable error in step "${step.name}": ${lastError}`);
      break;
    }
  }

  return { success: false, error: lastError };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function resolveRuntimeTask(task) {
  const taskDef = TASK_TYPES[task.type];
  if (!taskDef) return task;
  const isMock = execify.isMock === true;
  const language = isMock
    ? (taskDef.testLanguage || taskDef.language || task.language)
    : (taskDef.productionLanguage || taskDef.language || task.language);
  const preferredLibrary = isMock
    ? (taskDef.testLibrary || taskDef.preferredLibrary || task.preferredLibrary)
    : (taskDef.productionLibrary || taskDef.preferredLibrary || task.preferredLibrary);

  return { ...task, language, preferredLibrary };
}

function sanitizeFunctionId(value) {
  const base = String(value || '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  if (!base) return 'section';
  return /^[A-Za-z_]/.test(base) ? base : `section_${base}`;
}

function buildSectionFunctionName(sectionId, language) {
  const safeId = sanitizeFunctionId(sectionId);
  return language === 'python' ? `build_section_${safeId}` : `buildSection_${safeId}`;
}

async function generateSectionFunction({ job, task, section, functionName, sessionId, errorContext }) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const structure = await verifySectionStructure(section, task);
    const basePrompt = buildSectionPrompt({
      section,
      functionName,
      language: task.language,
      library: task.preferredLibrary,
      imports: DOCX_SECTION_IMPORTS,
      structure,
      taskType: task.type,
    });

    const errorNote = errorContext || lastError
      ? `\nPREVIOUS ATTEMPT FAILED WITH THIS ERROR:\n${errorContext || lastError}\nFix the issue in your new attempt.\n`
      : '';

    const prompt = `${basePrompt}${errorNote}`;

    addLog(job, attempt > 1
      ? `  Retry ${attempt}/${MAX_RETRIES} for section "${section.id}"...`
      : `  Generating section "${section.id}"...`
    );

    let code;
    try {
      code = await llmComplete(prompt, { maxTokens: 2048, temperature: attempt === 1 ? 0.2 : 0.4 });
      code = cleanCode(code);
    } catch (err) {
      lastError = `LLM generation failed: ${err.message}`;
      continue;
    }

    const contract = checkSectionContract({
      code,
      expectedFunctionName: functionName,
      language: task.language,
      allowedConstructors: DEFAULT_DOCX_ALLOWED_CONSTRUCTORS,
    });

    if (!contract.ok) {
      lastError = contract.message;
      continue;
    }

    const runtimeCheck = await runSectionCheck({
      task,
      code,
      functionName,
      sessionId,
    });

    if (!runtimeCheck.success) {
      lastError = runtimeCheck.error;
      continue;
    }

    return { code };
  }

  throw new Error(`Section "${section.id}" failed after ${MAX_RETRIES} attempts: ${lastError}`);
}

async function verifySectionStructure(section, task) {
  if (!section || (section.type !== 'table' && section.type !== 'nested_list')) return null;
  const prompt = buildSectionStructurePrompt(section);

  try {
    const raw = await llmComplete(prompt, { maxTokens: 200, jsonObject: true, temperature: 0.1 });
    const parsed = parseJsonFromLlm(raw);
    if (parsed.ok && typeof parsed.value === 'object') {
      return {
        rows: Number(parsed.value.rows || 0),
        cols: Number(parsed.value.cols || 0),
        hasNesting: Boolean(parsed.value.hasNesting),
      };
    }
  } catch {
    // Fall through to local inference
  }

  if (section.type === 'table') {
    const headerCount = Array.isArray(section.headers) ? section.headers.length : 0;
    const rowCount = Array.isArray(section.rows) ? section.rows.length + (headerCount ? 1 : 0) : 0;
    const colCount = headerCount || (Array.isArray(section.rows) && section.rows[0] ? section.rows[0].length : 0);
    return { rows: rowCount, cols: colCount, hasNesting: false };
  }

  const items = Array.isArray(section.items) ? section.items : [];
  const hasNesting = items.some(item => Array.isArray(item?.items) && item.items.length > 0);
  const maxCols = items.reduce((max, item) => {
    const size = Array.isArray(item?.items) ? item.items.length : 0;
    return Math.max(max, size);
  }, 0);

  return { rows: items.length, cols: maxCols, hasNesting };
}

async function runSectionCheck({ task, code, functionName, sessionId }) {
  const checkScript = buildSectionCheckScript({
    language: task.language,
    code,
    functionName,
  });

  let execResult;
  try {
    execResult = await execify.execute({
      language: task.language,
      code: checkScript,
      sessionId,
    });
  } catch (err) {
    return {
      success: false,
      error: formatErrorForRetry(`Execution request failed: ${err.message}`, {
        language: task.language,
        library: task.preferredLibrary,
      }),
    };
  }

  if (!execResult.success) {
    return {
      success: false,
      error: formatErrorForRetry(formatErrorForLLM(execResult), {
        language: task.language,
        library: task.preferredLibrary,
      }),
    };
  }

  return { success: true };
}

function buildSectionCheckScript({ language, code, functionName }) {
  if (language === 'python') {
    return `from docx import Document\n\n${code}\n\n_document = Document()\n_result = ${functionName}(_document)\nif not isinstance(_result, list):\n    raise Exception("${functionName}() must return a list")\nif len(_result) == 0:\n    raise Exception("${functionName}() returned an empty list")\n`;
  }

  return `const { ${DOCX_SECTION_IMPORTS.join(', ')} } = require('docx');\n\n${code}\n\nconst result = ${functionName}();\nif (!Array.isArray(result)) { throw new Error('${functionName}() must return an array'); }\nif (result.length === 0) { throw new Error('${functionName}() returned an empty array'); }\n`;
}

function buildAssemblyScript({ task, blueprint, sectionFunctions }) {
  const ordered = blueprint.sections.map(section => ({
    ...section,
    fn: sectionFunctions.get(section.id),
  })).filter(section => section.fn);

  const functionsCode = ordered.map(section => section.fn.code).join('\n\n');

  if (task.language === 'python') {
    const calls = ordered.map(section => `  ${section.fn.functionName}(document)`).join('\n');
    return `from docx import Document\n\n${functionsCode}\n\ndef main():\n  document = Document()\n${calls}\n  document.save("/workspace/${task.outputFile}")\n  print("SUCCESS: saved /workspace/${task.outputFile}")\n\nif __name__ == "__main__":\n  main()\n`;
  }

  const callLines = ordered.map(section => `  allSections.push(...${section.fn.functionName}());`).join('\n');

  return `const { Document, Packer, ${DOCX_SECTION_IMPORTS.filter(name => name !== 'Document').join(', ')} } = require('docx');\nconst fs = require('fs');\n\n${functionsCode}\n\nasync function main() {\n  const allSections = [];\n${callLines}\n\n  const doc = new Document({ sections: [{ children: allSections }] });\n  const buffer = await Packer.toBuffer(doc);\n  fs.writeFileSync("/workspace/${task.outputFile}", buffer);\n  console.log("SUCCESS: saved /workspace/${task.outputFile}");\n}\n\nmain().catch(err => { console.error(err); process.exit(1); });\n`;
}

function selectSectionsForRetry(blueprint, details) {
  const sections = blueprint.sections || [];
  const selected = new Set();

  if (Array.isArray(details.missingHeadings) && details.missingHeadings.length > 0) {
    details.missingHeadings.forEach(missing => {
      const match = sections.find(sec =>
        (sec.type === 'heading1' || sec.type === 'heading2') &&
        String(sec.text || '').toLowerCase() === String(missing || '').toLowerCase()
      );
      if (match) selected.add(match.id);
    });
  }

  if (details.expectedTables > 0 && details.foundTables < details.expectedTables) {
    sections.filter(sec => sec.type === 'table').forEach(sec => selected.add(sec.id));
  }

  if (details.expectedLists > 0 && details.foundLists < details.expectedLists) {
    sections.filter(sec => sec.type === 'list' || sec.type === 'nested_list').forEach(sec => selected.add(sec.id));
  }

  if (details.expectedParagraphs > 0 && details.foundParagraphs < Math.floor(details.expectedParagraphs * 0.8)) {
    sections.filter(sec => sec.type === 'paragraph' || sec.type === 'title').forEach(sec => selected.add(sec.id));
  }

  return Array.from(selected);
}

async function regenerateSections({ job, task, blueprint, sectionIds, sectionFunctions, sessionId, errorContext }) {
  if (!sectionIds.length) return;
  addLog(job, `Regenerating sections: ${sectionIds.join(', ')}`);

  for (const sectionId of sectionIds) {
    const section = (blueprint.sections || []).find(sec => sec.id === sectionId);
    if (!section) continue;
    const functionName = buildSectionFunctionName(section.id, task.language);
    const result = await generateSectionFunction({
      job,
      task,
      section,
      functionName,
      sessionId,
      errorContext,
    });
    sectionFunctions.set(section.id, { functionName, code: result.code });
  }
}

function findFailingSectionId(errorText, sectionFunctions) {
  const text = String(errorText || '');
  for (const [sectionId, fn] of sectionFunctions.entries()) {
    if (text.includes(fn.functionName)) return sectionId;
  }
  return null;
}

function parsePlan(raw, task) {
  const extracted = parseJsonFromLlm(raw);
  if (extracted.ok && extracted.value?.steps && Array.isArray(extracted.value.steps)) {
    return extracted.value;
  }

  const detail = extracted.ok ? 'missing steps array' : extracted.error;
  try {
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!parsed.steps || !Array.isArray(parsed.steps)) throw new Error('No steps array');
    return parsed;
  } catch (err) {
    logger.warn('Orchestrator', `Failed to parse plan JSON (${detail}), using fallback plan`, err.message);
    // Fallback: simple 2-step plan
    return {
      language: task.language,
      library: task.preferredLibrary,
      outputFile: task.outputFile,
      steps: [
        {
          step: 1,
          name: 'setup',
          functionName: 'setup',
          description: 'Import libraries and define helper data',
          returns: 'config dict',
          dependsOn: [],
        },
        {
          step: 2,
          name: 'generate_and_save',
          functionName: 'generate_and_save',
          description: `Generate ${task.label} and save to /workspace/${task.outputFile}`,
          returns: 'filepath string',
          dependsOn: [1],
        },
      ],
    };
  }
}

function cleanCode(raw) {
  // Remove markdown code fences the LLM might have added
  return raw
    .replace(/^```python\n?/m, '')
    .replace(/^```node\n?/m, '')
    .replace(/^```javascript\n?/m, '')
    .replace(/^```\n?/m, '')
    .replace(/```$/m, '')
    .trim();
}

function getMimeType(taskType) {
  const mimes = {
    excel: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    word: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pdf: 'application/pdf',
    csv: 'text/csv',
    text: 'text/plain',
    chart: 'image/png',
  };
  return mimes[taskType] || 'application/octet-stream';
}

function addLog(job, message) {
  job.log.push(message);
  logger.info(`job:${job.id.slice(0, 8)}`, message);
}

module.exports = { runJob, createJob, getJob, subscribeToJob, unsubscribeFromJob };

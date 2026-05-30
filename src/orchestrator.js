// src/orchestrator.js
// The brain — manages the full plan → generate → execute → verify loop.
// Implements the deep retry logic from PLAN_DEEP.md:
//   • quantity injection at every stage
//   • targeted plan corrections (not full regeneration)
//   • per-step probes + targeted fix prompts
//   • output-size validation with step-level retry

'use strict';

const { llmComplete } = require('./llm/client');
const {
  buildPlannerPrompt,
  buildCodeGenPrompt,
  buildRetryPrompt,
  buildValidationFixPrompt,
  buildSectionPrompt,
  buildSectionStructurePrompt,
  buildRefinerPrompt,
  buildNewPlannerPrompt,
  buildPlanCorrectionPrompt,
  buildImportsPrompt,
  buildStepCodePrompt,
  buildStepFixPrompt,
  buildContentExpansionPrompt,
} = require('./llm/prompts');
const { analyzeTask } = require('./tasks/taskAnalyzer');
const { resolveQuantity } = require('./tasks/quantityResolver');
const { parseLlmOutput } = require('./utils/llmParse');
const { parseJsonFromLlm } = require('./utils/jsonExtract');
const execify = require('./execify/client');
const { validateResult, formatErrorForLLM } = require('./execify/validator');
const { extractContent } = require('./content/extractor');
const { buildBlueprint } = require('./content/blueprint');
const { formatErrorForRetry, classifyError, buildFixInstruction } = require('./utils/errorClassifier');
const { checkSectionContract, DEFAULT_DOCX_ALLOWED_CONSTRUCTORS } = require('./utils/contractChecker');
const { TASK_TYPES, resolveRuntimeTask } = require('./tasks/taskTypes');
const { loadSkillForTask } = require('./skills/loader');
const { validatePlanQuantities } = require('./validation/quantityValidator');
const { runStepProbes, validateRefined } = require('./validation/stepValidator');
const { validateAssembly } = require('./validation/assemblyValidator');
const { assembleScript } = require('./pipeline/assembler');
const { parsePlan: parseMarkdownPlan } = require('./pipeline/planParser');
const { MAX_RETRIES, DOCX_SECTION_IMPORTS } = require('./config');
const logger = require('./utils/logger');

const MAX_PLAN_RETRIES   = parseInt(process.env.MAX_PLAN_RETRIES || '3', 10);
const MAX_STEP_RETRIES   = parseInt(process.env.MAX_RETRIES || '3', 10);
const MAX_OUTPUT_RETRIES = parseInt(process.env.MAX_OUTPUT_RETRIES || '2', 10);

// ─── JOB STATE ────────────────────────────────────────────────────────────────
const jobs = new Map();

function createJob(jobId, message) {
  const job = {
    id: jobId,
    message,
    status: 'pending',
    currentStep: 0,
    totalSteps: 0,
    stepName: '',
    task: null,
    plan: null,
    content: null,
    blueprint: null,
    sessionId: null,
    outputFile: null,
    outputData: null,
    outputMime: null,
    error: null,
    log: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    _subscribers: [],
  };
  jobs.set(jobId, job);
  return job;
}

function updateJob(job, updates) {
  Object.assign(job, updates, { updatedAt: Date.now() });
  if (job._subscribers.length > 0) {
    const event = buildProgressEvent(job);
    job._subscribers.forEach(send => {
      try { send(event); } catch {}
    });
  }
}

function buildProgressEvent(job) {
  return {
    jobId: job.id,
    status: job.status,
    stage: job._currentStage || job.status,
    pct: job._pct || 0,
    currentStep: job.currentStep,
    totalSteps: job.totalSteps,
    stepName: job.stepName,
    msg: job.log[job.log.length - 1] || '',
    ts: Date.now(),
  };
}

function emitProgress(job, { stage, pct, msg, detail }) {
  job._currentStage = stage;
  job._pct = pct;
  addLog(job, msg);
  if (job._subscribers.length > 0) {
    const event = { ...buildProgressEvent(job), stage, pct, msg, detail: detail || null, ts: Date.now() };
    job._subscribers.forEach(send => {
      try { send(event); } catch {}
    });
  }
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
  const jlog = logger.createJobLogger(jobId, process.env.CW_OUTPUT_DIR || 'tests/output');

  try {
    emitProgress(job, { stage: 'analyzing', pct: 5, msg: 'Analyzing your request…' });

    const parsedTask = await analyzeTask(job.message, { complete: llmComplete });
    const execRuntime = execify.isMock === true ? 'test' : 'production';
    const task = resolveRuntimeTask(parsedTask, execRuntime);
    updateJob(job, { task });
    addLog(job, `Task type: ${task.label} | Complexity: ${task.complexity}`);

    // ── Quantity resolution ────────────────────────────────────────────────
    emitProgress(job, { stage: 'quantities', pct: 10, msg: 'Calculating targets (pages, rows, data points)…' });
    const quantities = resolveQuantity(task.type, job.message, task.volume || {});
    jlog.quantities(quantities);

    // ── Skill loading ──────────────────────────────────────────────────────
    const skillData = loadSkillForTask(task.type, task.language, task.preferredLibrary);

    // Build a shared context object that flows through the pipeline
    const context = {
      raw_prompt: job.message,
      task_type: task.type,
      output_filename: task.outputFile,
      runtime: task.language,
      quantities,
      refined_text: null,
      skill_raw: skillData?.skill_raw || '',
      skill_sections: skillData?.skill_sections || {},
      plan_raw: null,
      plan: null,
      generated: { imports_code: '', functions: {}, defined_names: [], full_script: '' },
      output_path: `/workspace/${task.outputFile}`,
      execution_log: '',
      output_stats: null,
    };

    if (task.type === 'word') {
      await runWordJobV2({ job, task, jobId, context, jlog });
    } else {
      await runPlannedJob({ job, task, jobId, context, jlog });
    }

    try { await execify.deleteSession(job.sessionId); } catch {}

    updateJob(job, { status: 'done' });
    addLog(job, 'Done! Your file is ready to download.');
    logger.info('Orchestrator', `Job ${jobId} completed successfully`);

  } catch (err) {
    logger.error('Orchestrator', `Job ${jobId} failed`, err.message);
    updateJob(job, { status: 'failed', error: err.message });
    addLog(job, `Failed: ${err.message}`);
    if (job.sessionId) {
      try { await execify.deleteSession(job.sessionId); } catch {}
    }
  }
}

// ─── NON-WORD TASK FLOW (PLANNED PIPELINE) ────────────────────────────────────
async function runPlannedJob({ job, task, jobId, context, jlog }) {
  // ── Stage: Refine prompt ───────────────────────────────────────────────────
  emitProgress(job, { stage: 'refined', pct: 15, msg: 'Refining prompt…' });
  context.refined_text = await refineWithRetry(context, jlog);
  jlog.refined(context.refined_text);
  addLog(job, `Prompt refined (${context.refined_text.split(' ').length} words)`);

  // ── Stage: Plan ────────────────────────────────────────────────────────────
  emitProgress(job, { stage: 'planning', pct: 25, msg: 'Building plan…' });
  await buildPlanWithRetry(context, job, jlog);
  jlog.plan_accepted(context.plan);

  // If the plan structure is not available (no fnParsed steps), fall back to legacy planned flow
  const hasNewPlan = context.plan?.steps?.some(s => s.fnParsed);
  if (!hasNewPlan) {
    return runLegacyPlannedJob({ job, task, jobId });
  }

  // ── Stage: Setup Execify session ──────────────────────────────────────────
  emitProgress(job, { stage: 'setup', pct: 30, msg: 'Setting up execution environment…' });
  const session = await execify.createSession();
  updateJob(job, { sessionId: session.session_id });

  // ── Stage: Generate imports ───────────────────────────────────────────────
  emitProgress(job, { stage: 'codegen_imports', pct: 32, msg: 'Generating imports…' });
  const importsCode = await generateImportsWithRetry(context, jlog);
  context.generated.imports_code = importsCode;

  // ── Stage: Generate each step ─────────────────────────────────────────────
  const steps = context.plan.steps.filter(s => s.fnParsed?.name);
  updateJob(job, { totalSteps: steps.length });

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const pct = 32 + Math.floor((i / steps.length) * 38);
    emitProgress(job, { stage: 'codegen_step', pct, msg: `Writing: ${step.title}…`, detail: step.title });
    updateJob(job, { currentStep: i + 1, stepName: step.title });

    jlog.step_prompt(step, '');
    const code = await generateStepWithRetry(step, context, jlog);
    context.generated.functions[step.title] = code;
    if (step.fnParsed?.name) context.generated.defined_names.push(step.fnParsed.name);
    jlog.step_code(step, code);
  }

  // ── Stage: Assemble ───────────────────────────────────────────────────────
  emitProgress(job, { stage: 'assembling', pct: 72, msg: 'Assembling script…' });
  const fullScript = assembleScript(context);
  const assemblyErrors = validateAssembly(fullScript, context.plan, context.runtime);

  if (assemblyErrors.length > 0) {
    for (const err of assemblyErrors) {
      if (err.includes('missing from the assembled script')) {
        const missingName = err.match(/"([^"]+)"/)?.[1];
        const missingStep = context.plan.steps.find(s => s.fnParsed?.name === missingName);
        if (missingStep) {
          emitProgress(job, { stage: 'assembly_fix', pct: 73, msg: `Re-generating missing function: ${missingName}…` });
          context.generated.functions[missingStep.title] = await generateStepWithRetry(missingStep, context, jlog);
        }
      }
    }
  }
  context.generated.full_script = assembleScript(context);
  jlog.full_script(context.generated.full_script);

  // ── Stage: Execute ────────────────────────────────────────────────────────
  emitProgress(job, { stage: 'executing', pct: 78, msg: 'Running script…' });
  let execResult;
  try {
    execResult = await execify.execute({
      language: task.language,
      code: context.generated.full_script,
      sessionId: session.session_id,
    });
    jlog.exec_stdout(execResult?.stdout || '');
  } catch (execErr) {
    emitProgress(job, { stage: 'exec_error', pct: 79, msg: 'Script crashed, diagnosing…' });
    jlog.exec_error(execErr.message);
    const fixed = await fixCrashedScript(execErr.message, context, jlog);
    context.generated.full_script = fixed;
    execResult = await execify.execute({
      language: task.language,
      code: context.generated.full_script,
      sessionId: session.session_id,
    });
  }

  const finalValidation = await validateResult(execResult, task, { isLast: true });
  if (!finalValidation.valid) {
    throw new Error(`Output validation failed: ${finalValidation.message}`);
  }

  updateJob(job, {
    outputFile: finalValidation.file?.name || task.outputFile,
    outputData: finalValidation.file?.data,
    outputMime: getMimeType(task.type),
  });
  emitProgress(job, { stage: 'done', pct: 100, msg: 'File ready.' });
  jlog.done(context.output_path);
}

// ─── LEGACY PLANNED JOB (YAML plan, Execify step execution) ──────────────────
// Used as fallback when the new MD plan cannot be parsed, or for task types
// that were working fine before (Excel, chart, CSV in production).
async function runLegacyPlannedJob({ job, task, jobId }) {
  addLog(job, 'Planning the code structure (legacy mode)…');
  const planPrompt = buildPlannerPrompt(task);
  const planRaw = await llmComplete(planPrompt, { maxTokens: 3500, temperature: 0.15 });
  const plan = parseLegacyPlan(planRaw, task);

  updateJob(job, { plan, totalSteps: plan.steps.length });
  addLog(job, `Plan ready: ${plan.steps.length} steps`);

  addLog(job, 'Setting up execution environment…');
  const session = await execify.createSession();
  updateJob(job, { sessionId: session.session_id });

  const verifiedFunctions = [];

  for (let i = 0; i < plan.steps.length; i++) {
    const step = { ...plan.steps[i], isLast: i === plan.steps.length - 1 };
    updateJob(job, { currentStep: i + 1, stepName: step.name });
    addLog(job, `Step ${i + 1}/${plan.steps.length}: ${step.description}`);

    const result = await executeStep({ job, task, plan, step, verifiedFunctions, sessionId: session.session_id });

    if (!result.success) {
      throw new Error(`Step "${step.name}" failed after ${MAX_RETRIES} attempts: ${result.error}`);
    }

    verifiedFunctions.push({
      step: step.step,
      functionName: step.functionName,
      function_name: step.function_name,
      returns: step.returns,
      description: step.description,
    });

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
async function runWordJobV2({ job, task, jobId, context, jlog }) {
  emitProgress(job, { stage: 'refined', pct: 15, msg: 'Extracting document content…' });
  const content = await extractContent({
    message: task.refinedMessage || job.message,
    task,
    complete: llmComplete,
  });
  updateJob(job, { content });

  emitProgress(job, { stage: 'planning', pct: 22, msg: 'Building blueprint…' });
  const blueprint = buildBlueprint(content, {
    outputFile: task.outputFile,
    language: task.language,
    library: task.preferredLibrary,
  });

  updateJob(job, { blueprint, totalSteps: blueprint.sections.length + 1 });
  addLog(job, `Blueprint ready: ${blueprint.sections.length} sections`);

  emitProgress(job, { stage: 'setup', pct: 28, msg: 'Setting up execution environment…' });
  const session = await execify.createSession();
  updateJob(job, { sessionId: session.session_id });
  logger.info('Orchestrator', `Session created: ${session.session_id}`);

  const sectionFunctions = new Map();

  for (let i = 0; i < blueprint.sections.length; i++) {
    const section = blueprint.sections[i];
    const functionName = buildSectionFunctionName(section.id, task.language);

    updateJob(job, { currentStep: i + 1, stepName: section.id });
    const pct = 30 + Math.floor((i / blueprint.sections.length) * 45);
    emitProgress(job, {
      stage: 'codegen_step',
      pct,
      msg: `Section ${i + 1}/${blueprint.sections.length}: ${section.type} (${section.id})`,
      detail: section.id,
    });

    const result = await generateSectionFunction({
      job, task, section, functionName, sessionId: session.session_id, errorContext: null,
    });

    sectionFunctions.set(section.id, { functionName, code: result.code });
  }

  const maxFinalAttempts = Math.min(2, MAX_RETRIES);
  let lastFinalError = null;

  for (let attempt = 1; attempt <= maxFinalAttempts; attempt++) {
    updateJob(job, { currentStep: blueprint.sections.length + 1, stepName: 'assemble_and_save' });
    emitProgress(job, {
      stage: 'assembling',
      pct: 78,
      msg: `Assembling document (attempt ${attempt}/${maxFinalAttempts})…`,
    });

    const assemblyCode = buildAssemblyScript({ task, blueprint, sectionFunctions });

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
      emitProgress(job, { stage: 'done', pct: 100, msg: 'File ready.' });
      return;
    }

    if (validation.type === 'validation_error' && validation.details) {
      lastFinalError = validation.message;
      addLog(job, `  Validation failed: ${validation.message}`);
      const retryIds = selectSectionsForRetry(blueprint, validation.details);
      if (retryIds.length === 0) break;
      await regenerateSections({
        job, task, blueprint, sectionIds: retryIds,
        sectionFunctions, sessionId: session.session_id, errorContext: validation.message,
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
        job, task, blueprint, sectionIds: [failingId],
        sectionFunctions, sessionId: session.session_id, errorContext: lastFinalError,
      });
      continue;
    }
    break;
  }

  throw new Error(`Final assembly failed: ${lastFinalError || 'unknown error'}`);
}

// ─── REFINER WITH RETRY ──────────────────────────────────────────────────────
async function refineWithRetry(context, jlog) {
  let result = context.raw_prompt; // fallback = raw prompt
  for (let attempt = 1; attempt <= 2; attempt++) {
    result = await llmComplete(buildRefinerPrompt(context), { maxTokens: 400, temperature: 0.2 });
    const errors = validateRefined(result);
    if (errors.length === 0) return result;

    const shortfall = errors.find(e => e.type === 'too_short');
    if (shortfall && attempt < 2) {
      context._refiner_extra =
        `Your previous response was only ${result.split(' ').length} words. ` +
        'Expand with more specific detail. Minimum 100 words.';
      if (jlog) jlog.step_retry({ title: 'refiner' }, attempt);
      continue;
    }
    break;
  }
  return result;
}

// ─── PLAN WITH RETRY (targeted corrections) ───────────────────────────────────
async function buildPlanWithRetry(context, job, jlog) {
  let planRaw = '';

  for (let attempt = 1; attempt <= MAX_PLAN_RETRIES; attempt++) {
    if (attempt === 1) {
      planRaw = await llmComplete(buildNewPlannerPrompt(context), { maxTokens: 2000, temperature: 0.15 });
    } else {
      // Targeted correction — do NOT regenerate from scratch
      const { corrections } = validatePlanQuantities(
        parseMarkdownPlan(planRaw),
        context.quantities,
      );
      emitProgress(job, {
        stage: 'plan_retry',
        pct: 26,
        msg: `Fixing plan issues (attempt ${attempt})…`,
      });
      jlog?.plan_errors?.([corrections]);
      planRaw = await llmComplete(
        buildPlanCorrectionPrompt(planRaw, corrections),
        { maxTokens: 2000, temperature: 0.2 },
      );
    }

    if (jlog) jlog.plan_attempt(attempt, planRaw);

    const parsed = parseMarkdownPlan(planRaw);
    context.plan_raw = planRaw;
    context.plan = parsed;

    const { valid } = validatePlanQuantities(parsed, context.quantities);
    if (valid) return;

    if (attempt === MAX_PLAN_RETRIES) {
      emitProgress(job, { stage: 'plan_warn', pct: 27, msg: 'Plan partially corrected, continuing with best plan…' });
    }
  }
}

// ─── IMPORTS GENERATION WITH RETRY ───────────────────────────────────────────
async function generateImportsWithRetry(context, jlog) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const code = await llmComplete(buildImportsPrompt(context), { maxTokens: 300, temperature: 0.1 });
    const clean = code.replace(/^```[^\n]*\n?/m, '').replace(/```\s*$/m, '').trim();
    // Basic validation: must contain at least one import line
    const hasImports = /^(import|from|const|require)/m.test(clean);
    if (hasImports) return clean;
    if (jlog) jlog.step_retry({ title: 'imports' }, attempt);
  }
  // Return a safe minimal fallback
  return context.runtime === 'node'
    ? "const fs = require('fs');\nconst path = require('path');"
    : 'import os\nimport pathlib';
}

// ─── PER-STEP GENERATOR WITH FULL VALIDATION + RETRY ─────────────────────────
async function generateStepWithRetry(step, context, jlog, overridePrompt = null) {
  let prompt = overridePrompt || buildStepCodePrompt(step, context);
  let code = '';

  for (let attempt = 1; attempt <= MAX_STEP_RETRIES; attempt++) {
    if (jlog) jlog.step_retry(step, attempt);

    code = await llmComplete(prompt, { maxTokens: 4096, temperature: attempt === 1 ? 0.2 : 0.35 });
    code = code.replace(/^```[^\n]*\n?/m, '').replace(/```\s*$/m, '').trim();

    const probeResult = await runStepProbes(code, step, context.runtime);
    if (probeResult.valid) return code;

    if (jlog) jlog.step_error(step, probeResult.error_message);

    if (attempt === MAX_STEP_RETRIES) return code; // Accept last attempt

    // Build a targeted fix prompt based on the exact probe error
    prompt = buildStepFixPrompt(step, code, probeResult, context);
  }

  return code;
}

// ─── CRASH DIAGNOSIS + FIX ────────────────────────────────────────────────────
async function fixCrashedScript(errorText, context, jlog) {
  const cls = classifyError(errorText, { language: context.runtime });

  if (!cls || !cls.fixable) return context.generated.full_script;

  if (cls.scope === 'imports') {
    // Re-run imports codegen with note about missing package
    const pkg = errorText.match(/No module named '([^']+)'/)?.[1] || '';
    const hint = pkg ? `\nAdd "${pkg}" to the import list.` : '';
    context._imports_hint = hint;
    const newImports = await generateImportsWithRetry(context, jlog);
    context.generated.imports_code = newImports;
    return assembleScript(context);
  }

  if (cls.scope === 'step' || cls.scope === 'save_step') {
    // Try to find which step owns this error
    const nameMatch = errorText.match(/'([A-Za-z_][A-Za-z0-9_]*)' is not defined/);
    if (nameMatch) {
      const missing = nameMatch[1];
      const ownerStep = context.plan?.steps?.find(s =>
        s.fnParsed?.outputs?.includes(missing) || s.fnParsed?.name === missing,
      );
      if (ownerStep) {
        const fixPrompt = buildStepFixPrompt(
          ownerStep,
          context.generated.functions[ownerStep.title] || '',
          { error_type: 'NameError', error_message: errorText },
          context,
        );
        const fixed = await llmComplete(fixPrompt, { maxTokens: 2048, temperature: 0.3 });
        context.generated.functions[ownerStep.title] = fixed.replace(/^```[^\n]*\n?/m, '').replace(/```\s*$/m, '').trim();
        return assembleScript(context);
      }
    }
  }

  return context.generated.full_script;
}

// ─── EXECUTE A SINGLE STEP WITH RETRY (legacy) ────────────────────────────────
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

    addLog(job, attempt > 1
      ? `  Retry ${attempt}/${MAX_RETRIES} for step "${step.name}"…`
      : `  Generating code for "${step.name}"…`);

    let code;
    try {
      code = await llmComplete(prompt, { maxTokens: 4096, temperature: attempt === 1 ? 0.2 : 0.4 });
      code = cleanCode(code);
    } catch (llmErr) {
      lastError = `LLM generation failed: ${llmErr.message}`;
      logger.warn('Orchestrator', lastError);
      continue;
    }

    addLog(job, `  Executing step "${step.name}"…`);
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

    const validation = await validateResult(execResult, task, step);

    if (validation.valid) {
      return { success: true, code, outputFile: validation.file || null };
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

    if (!validation.retryable) {
      logger.warn('Orchestrator', `Non-retryable error in step "${step.name}": ${lastError}`);
      break;
    }
  }

  return { success: false, error: lastError };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

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
      ? `  Retry ${attempt}/${MAX_RETRIES} for section "${section.id}"…`
      : `  Generating section "${section.id}"…`);

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

    const runtimeCheck = await runSectionCheck({ task, code, functionName, sessionId });
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
  } catch {}

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
  const checkScript = task.language === 'python'
    ? `from docx import Document\n\n${code}\n\n_document = Document()\n_result = ${functionName}(_document)\nif not isinstance(_result, list):\n    raise Exception("${functionName}() must return a list")\nif len(_result) == 0:\n    raise Exception("${functionName}() returned an empty list")\n`
    : `const { ${DOCX_SECTION_IMPORTS.join(', ')} } = require('docx');\n\n${code}\n\nconst result = ${functionName}();\nif (!Array.isArray(result)) { throw new Error('${functionName}() must return an array'); }\nif (result.length === 0) { throw new Error('${functionName}() returned an empty array'); }\n`;

  let execResult;
  try {
    execResult = await execify.execute({ language: task.language, code: checkScript, sessionId });
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

function buildAssemblyScript({ task, blueprint, sectionFunctions }) {
  const ordered = blueprint.sections
    .map(section => ({ ...section, fn: sectionFunctions.get(section.id) }))
    .filter(section => section.fn);

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
        String(sec.text || '').toLowerCase() === String(missing || '').toLowerCase(),
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
    const result = await generateSectionFunction({ job, task, section, functionName, sessionId, errorContext });
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

function parseLegacyPlan(raw, task) {
  const parsed = parseLlmOutput(raw);
  if (parsed.ok) {
    const data = parsed.value;
    const planData = data.plan || data;
    const steps = planData.steps;
    if (Array.isArray(steps) && steps.length > 0) {
      return {
        language: planData.language || task.language,
        library: planData.library || task.preferredLibrary,
        outputFile: planData.output_file || planData.outputFile || task.outputFile,
        steps: steps.map(normalizePlanStep),
      };
    }
  }

  const jsonResult = parseJsonFromLlm(raw);
  if (jsonResult.ok && jsonResult.value?.steps && Array.isArray(jsonResult.value.steps)) {
    return { ...jsonResult.value, steps: jsonResult.value.steps.map(normalizePlanStep) };
  }

  logger.warn('Orchestrator', `Failed to parse plan, using fallback`);
  return {
    language: task.language,
    library: task.preferredLibrary,
    outputFile: task.outputFile,
    steps: [
      normalizePlanStep({
        step: 1,
        name: 'setup',
        function_name: 'setup',
        description: 'Import libraries and define helper data/config',
        returns: { type: 'dict', shape: 'config object' },
        lines_budget: 50,
        depends_on: [],
      }),
      normalizePlanStep({
        step: 2,
        name: 'generate_and_save',
        function_name: 'generate_and_save',
        description: `Generate ${task.label} and save to /workspace/${task.outputFile}`,
        returns: { type: 'string', shape: 'filepath' },
        lines_budget: 120,
        depends_on: [1],
      }),
    ],
  };
}

function normalizePlanStep(step) {
  return {
    step: step.step,
    name: step.name,
    functionName: step.function_name || step.functionName,
    description: step.description,
    contentSpec: step.content_spec || step.contentSpec || null,
    returns: step.returns || 'unknown',
    linesBudget: step.lines_budget || step.linesBudget || 120,
    dependsOn: step.depends_on || step.dependsOn || [],
    function_name: step.function_name || step.functionName,
    content_spec: step.content_spec || step.contentSpec || null,
    lines_budget: step.lines_budget || step.linesBudget || 120,
    depends_on: step.depends_on || step.dependsOn || [],
  };
}

function cleanCode(raw) {
  let code = raw.trim();
  code = code.replace(/^```\w*\s*\n?/, '');
  code = code.replace(/\n?```\s*$/, '');
  return code.trim();
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

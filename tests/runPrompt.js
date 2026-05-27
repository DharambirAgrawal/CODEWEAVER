// tests/runPrompt.js
// Single-prompt local runner: reads tests/prompt.py, plans + generates code, and executes locally.

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');
const { llmComplete, llmCompleteBestOfN, getProviderChain, providerHasKey } = require('../src/llm/client');
const { parseWithLLM } = require('../src/tasks/taskParser');
const { refineUserPrompt } = require('../src/tasks/promptRefiner');
const { buildPlannerPrompt, buildCodeGenPrompt, buildRetryPrompt, setAvailableLibraries } = require('../src/llm/prompts');
const { parseJsonFromLlm } = require('../src/utils/jsonExtract');
const { TASK_TYPES, resolveRuntimeTask } = require('../src/tasks/taskTypes');
const { describeSelectedSkills } = require('../src/skills/loader');
const {
  buildNodeDocxAssemblyScript,
  getCodegenSteps,
  getSectionSteps,
  stripNodeStepBoilerplate,
  usesNodeDocxAssembly,
} = require('../src/utils/nodeAssembly');
const logger = require('../src/utils/logger');

const REPO_ROOT = path.join(__dirname, '..');

const PROMPT_FILE = process.env.CW_PROMPT_FILE || path.join(__dirname, 'prompt.py');
const OUTPUT_DIR = process.env.CW_OUTPUT_DIR || path.join(__dirname, 'output');
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);
const CODE_GEN_MAX_TOKENS = Math.min(
  16384,
  Math.max(2048, parseInt(process.env.CW_CODE_GEN_MAX_TOKENS || '6000', 10)),
);
const PARALLEL_MODELS = Math.max(1, parseInt(process.env.LLM_PARALLEL_MODELS || '3', 10));
const PARALLEL_TIMEOUT_MS = parseInt(process.env.LLM_PARALLEL_TIMEOUT_MS || '35000', 10);

function shouldUseParallelForStep(task) {
  if (process.env.LLM_PARALLEL_ENABLED === '0') return false;
  if (PARALLEL_MODELS <= 1) return false;
  return getProviderChain().some(providerHasKey);
}

function extractPromptFromPython(text) {
  const direct = text.match(/\bPROMPT\s*=\s*("""|''')([\s\S]*?)\1/);
  if (direct && direct[2]) return direct[2].trim();

  const alias = text.match(/\bPROMPT\s*=\s*([A-Z0-9_]+)/);
  if (alias && alias[1]) {
    const name = alias[1];
    const re = new RegExp(`\\b${name}\\s*=\\s*("""|''')([\\s\\S]*?)\\1`);
    const match = text.match(re);
    if (match && match[2]) return match[2].trim();
  }

  return null;
}

function readPrompt() {
  if (!fs.existsSync(PROMPT_FILE)) {
    throw new Error(`Prompt file not found: ${PROMPT_FILE}`);
  }
  const text = fs.readFileSync(PROMPT_FILE, 'utf8');
  const extracted = PROMPT_FILE.endsWith('.py') ? extractPromptFromPython(text) : null;
  const prompt = (extracted || text).trim();
  if (!prompt) throw new Error('Prompt file is empty');
  return prompt;
}

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function pickPython() {
  const venvPython = path.join(__dirname, '..', 'venv', 'bin', 'python');
  if (process.env.CW_PYTHON) return process.env.CW_PYTHON;
  if (fs.existsSync(venvPython)) return venvPython;
  return 'python3';
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
    logger.warn('LocalRunner', `Failed to parse plan JSON (${detail}), using fallback plan`, err.message);
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
  return raw
    .replace(/^```python\n?/m, '')
    .replace(/^```node\n?/m, '')
    .replace(/^```javascript\n?/m, '')
    .replace(/^```\n?/m, '')
    .replace(/```$/m, '')
    .trim();
}

function normalizeOutputPaths(code, outputPath) {
  const outputFileName = path.basename(outputPath);
  const nodeOutput = `path.join(__dirname, ${JSON.stringify(outputFileName)})`;
  const pyOutput = `os.path.join(os.path.dirname(os.path.abspath(__file__)), ${JSON.stringify(outputFileName)})`;
  let result = code;
  result = result.replace(/(['"])\/workspace\/[^'"]+\1/g, (_match, quote) => `${quote}${outputFileName}${quote}`);
  result = result.replace(
    /(['"])tests\/output\/([^'"]+)\1/gi,
    (_match, _quote, file) => `path.join(__dirname, ${JSON.stringify(file)})`,
  );
  result = result.replace(
    /const OUTPUT_PATH = ['"][^'"]+['"];/,
    `const OUTPUT_PATH = ${nodeOutput};`,
  );
  result = result.replace(
    /OUTPUT_PATH = ['"][^'"]+['"]/,
    `OUTPUT_PATH = ${pyOutput}`,
  );
  return result;
}

function hasFunction(code, name, language) {
  if (language === 'python') return new RegExp(`\\bdef\\s+${name}\\s*\\(`).test(code);
  return new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(code);
}

function validateStepSyntax(code, step, language) {
  if (language !== 'node') return null;
  try {
    new vm.Script(code, { filename: `step_${step.step}_${step.functionName}.js` });
    return null;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return `JavaScript syntax error in step "${step.name}": ${message}`;
  }
}

function validateNodeWordSemantics(code, step, task) {
  if (!usesNodeDocxAssembly(task)) return null;
  const isSetup = /setup|imports|constants|config/i.test(`${step.name} ${step.functionName}`);
  if (!isSetup && /docxConstructors/.test(code)) {
    return `Invalid pattern in step "${step.name}": do not use setup().docxConstructors. Use top-level docx constructors directly (Paragraph, TextRun, Table, etc).`;
  }
  return null;
}

async function generateStepCode(task, plan, step, verifiedFunctions) {
  let lastError = null;
  const parallelEnabled = shouldUseParallelForStep(task);
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const prompt = lastError
      ? buildRetryPrompt(task, plan, step, verifiedFunctions, lastError, attempt)
      : buildCodeGenPrompt(task, plan, step, verifiedFunctions, lastError);
    try {
      const completionOptions = {
        maxTokens: CODE_GEN_MAX_TOKENS,
        temperature: attempt === 1 ? 0.2 : 0.35,
      };
      let code = parallelEnabled
        ? await llmCompleteBestOfN(prompt, completionOptions, {
          count: PARALLEL_MODELS,
          timeoutMs: PARALLEL_TIMEOUT_MS,
          scope: process.env.LLM_PARALLEL_SCOPE || 'all',
          rateLimitRetries: 1,
        })
        : await llmComplete(prompt, completionOptions);
      code = cleanCode(code);
      if (usesNodeDocxAssembly(task)) {
        code = stripNodeStepBoilerplate(code);
      }
      if (!hasFunction(code, step.functionName, task.language)) {
        lastError = `Missing function ${step.functionName}()`;
        continue;
      }
      const syntaxError = validateStepSyntax(code, step, task.language);
      if (syntaxError) {
        lastError = syntaxError;
        continue;
      }
      const semanticError = validateNodeWordSemantics(code, step, task);
      if (semanticError) {
        lastError = semanticError;
        continue;
      }
      return code;
    } catch (err) {
      lastError = err.message || String(err);
    }
  }
  throw new Error(`Step ${step.name} failed after ${MAX_RETRIES} attempts: ${lastError}`);
}

function buildPythonScript(plan, stepCodes, outputPath) {
  const lastStep = plan.steps[plan.steps.length - 1];
  const outputFileName = path.basename(outputPath);
  const lines = [
    'import os',
    `OUTPUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ${JSON.stringify(outputFileName)})`,
    '',
    ...stepCodes,
    '',
    'if __name__ == "__main__":',
    `    ${lastStep.functionName}()`,
  ];
  return lines.join('\n');
}

function buildNodeScript(plan, stepCodes, outputPath) {
  const lastStep = plan.steps[plan.steps.length - 1];
  const outputFileName = path.basename(outputPath);
  const lines = [
    "const path = require('path');",
    `const OUTPUT_PATH = path.join(__dirname, ${JSON.stringify(outputFileName)});`,
    '',
    ...stepCodes,
    '',
    '(async () => {',
    `  const result = ${lastStep.functionName}();`,
    '  if (result && typeof result.then === "function") await result;',
    '})().catch(err => { console.error(err); process.exit(1); });',
  ];
  return lines.join('\n');
}

function validateOutput(taskType, outputPath) {
  if (!fs.existsSync(outputPath)) {
    throw new Error(`Output file not found: ${outputPath}`);
  }
  const size = fs.statSync(outputPath).size;
  const minSize = TASK_TYPES[taskType]?.validation?.minSizeBytes || 10;
  if (size < minSize) {
    throw new Error(`Output file too small (${size} bytes). Expected >= ${minSize}.`);
  }
}

async function main() {
  console.log('\n' + '═'.repeat(70));
  console.log('  CodeWeaver — Single Prompt Local Runner');
  console.log('═'.repeat(70));

  if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY && !process.env.OPENROUTER_API_KEY) {
    throw new Error('No LLM API key. Set GEMINI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY in .env');
  }

  const promptText = readPrompt();
  ensureOutputDir();

  setAvailableLibraries({
    python: ['openpyxl', 'pandas', 'python-docx', 'matplotlib', 'seaborn', 'csv', 'json', 'os', 'pathlib'],
    node: ['fs', 'path', 'xlsx', 'docx'],
  });

  console.log('Refining prompt...');
  const refinement = await refineUserPrompt(promptText, { complete: llmComplete });
  if (refinement.refinedPrompt !== promptText) {
    console.log(`Refined (${promptText.length} → ${refinement.refinedPrompt.length} chars)`);
    if (refinement.taskType) console.log(`Suggested type: ${refinement.taskType}`);
    console.log('');
  }

  let task = await parseWithLLM(promptText, { complete: llmComplete }, { refinement });
  task = resolveRuntimeTask(task, 'local');
  const outputPath = path.resolve(OUTPUT_DIR, task.outputFile);

  console.log(`Prompt file: ${PROMPT_FILE}`);
  console.log(`Task: ${task.label} (${task.type})`);
  console.log(`Language: ${task.language} | Library: ${task.preferredLibrary}`);
  console.log(`Skills: ${describeSelectedSkills({ taskType: task.type, language: task.language, library: task.preferredLibrary, phase: 'plan' })}`);
  if (shouldUseParallelForStep(task)) {
    const providers = getProviderChain().filter(providerHasKey);
    const scope = process.env.LLM_PARALLEL_SCOPE || 'all';
    const timeoutLabel = PARALLEL_TIMEOUT_MS <= 0 ? 'no timeout' : `${PARALLEL_TIMEOUT_MS}ms timeout`;
    console.log(`Step generation: parallel best-of-${PARALLEL_MODELS} (${scope}; ${providers.join(', ')}; ${timeoutLabel})`);
  }
  console.log(`Output: ${outputPath}`);
  console.log('');

  if (task.language !== 'python' && task.language !== 'node') {
    throw new Error(`Local runner supports python and node only. Task language: ${task.language}`);
  }

  const planRaw = await llmComplete(buildPlannerPrompt(task), {
    maxTokens: 2500,
    jsonObject: true,
    temperature: 0.15,
  });
  const plan = parsePlan(planRaw, task);

  console.log(`Plan steps: ${plan.steps.length}`);
  plan.steps.forEach(s => {
    const deps = Array.isArray(s.dependsOn) && s.dependsOn.length ? s.dependsOn.join(',') : '-';
    console.log(`  - ${s.step}. ${s.name} (${s.functionName}) deps:[${deps}]`);
  });
  console.log('');

  const codegenSteps = getCodegenSteps(plan, task);
  const stepCodes = [];
  const verified = [];
  const runStart = Date.now();
  for (const step of codegenSteps) {
    const stepStart = Date.now();
    console.log(`Generating step ${step.step}/${codegenSteps.length}: ${step.name}`);
    const code = await generateStepCode(task, plan, step, verified);
    stepCodes.push(code);
    verified.push({ functionName: step.functionName, returns: step.returns });
    const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
    const totalElapsed = ((Date.now() - runStart) / 1000).toFixed(1);
    console.log(`Completed step ${step.step}/${codegenSteps.length}: ${step.name} (${elapsed}s, total ${totalElapsed}s)`);
  }

  const isNode = task.language === 'node';
  let finalScript;
  if (usesNodeDocxAssembly(task)) {
    finalScript = buildNodeDocxAssemblyScript({ plan, stepCodes, outputPath });
    const skipped = plan.steps.length - codegenSteps.length;
    console.log(
      `Assembly: shared docx imports + ${getSectionSteps(plan).length} section(s)`
      + (skipped > 0 ? ` (${skipped} save/assembly step(s) omitted from codegen)` : ''),
    );
  } else if (isNode) {
    finalScript = buildNodeScript(plan, stepCodes, outputPath);
  } else {
    finalScript = buildPythonScript(plan, stepCodes, outputPath);
  }
  finalScript = normalizeOutputPaths(finalScript, outputPath);

  const scriptPath = path.join(OUTPUT_DIR, isNode ? 'final_generate.js' : 'final_generate.py');
  fs.writeFileSync(scriptPath, finalScript);

  console.log(`\nRunning: ${scriptPath}`);
  if (isNode) {
    execSync(`node --check "${scriptPath}"`, { stdio: 'inherit', cwd: REPO_ROOT });
    execSync(`node "${scriptPath}"`, { stdio: 'inherit', cwd: REPO_ROOT });
  } else {
    const pythonExe = pickPython();
    execSync(`${pythonExe} "${scriptPath}"`, { stdio: 'inherit' });
  }

  validateOutput(task.type, outputPath);
  console.log(`\nSUCCESS: file saved at ${outputPath}`);
}

main().catch(err => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});

// tests/runPrompt.js
// Single-prompt local runner: reads tests/prompt.js, plans + generates code, and executes locally.

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const YAML = require('yaml');
const { execSync } = require('child_process');
const { llmComplete, llmCompleteBestOfN, getProviderChain, providerHasKey } = require('../src/llm/client');
const { analyzeTask } = require('../src/tasks/taskAnalyzer');
const { buildPlannerPrompt, buildCodeGenPrompt, buildRetryPrompt, setAvailableLibraries } = require('../src/llm/prompts');
const { parseLlmOutput } = require('../src/utils/llmParse');
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

const PROMPT_FILE = process.env.CW_PROMPT_FILE || path.join(__dirname, 'prompt.js');
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

function extractPromptFromJsModule(filePath) {
  try {
    const resolved = require.resolve(filePath);
    delete require.cache[resolved];
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(filePath);
    if (typeof mod === 'string') return mod.trim();
    if (mod && typeof mod.PROMPT === 'string') return mod.PROMPT.trim();
    if (mod && mod.default && typeof mod.default.PROMPT === 'string') return mod.default.PROMPT.trim();
    if (mod && typeof mod.default === 'string') return mod.default.trim();
    return null;
  } catch {
    return null;
  }
}

function readPrompt() {
  const defaultJs = path.join(__dirname, 'prompt.js');
  let promptPath = PROMPT_FILE;

  // If env var points to old prompt.py (or any missing file), fall back to prompt.js
  if (!fs.existsSync(promptPath)) {
    if (process.env.CW_PROMPT_FILE) {
      console.warn(`CW_PROMPT_FILE points to missing file: ${promptPath}. Falling back to ${defaultJs}`);
    }
    promptPath = defaultJs;
  }

  if (!(promptPath.endsWith('.js') || promptPath.endsWith('.cjs') || promptPath.endsWith('.mjs'))) {
    // If user still has CW_PROMPT_FILE=tests/prompt.py, guide them cleanly.
    throw new Error(
      `Prompt file must be a JS module exporting PROMPT. Got: ${promptPath}. ` +
      `Fix by unsetting CW_PROMPT_FILE or setting it to tests/prompt.js`,
    );
  }

  if (!fs.existsSync(promptPath)) {
    throw new Error(`Prompt file not found: ${promptPath}`);
  }

  const prompt = (extractPromptFromJsModule(promptPath) || '').trim();
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

function parsePlan(raw, task) {
  // Try YAML first, then JSON
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

  // Heuristic YAML salvage:
  // Some models occasionally wrap YAML with extra text/braces that break the main parser.
  // Try extracting from the first "plan:" occurrence and parse that fragment directly.
  try {
    const planStart = String(raw || '').search(/\bplan\s*:/);
    if (planStart >= 0) {
      const fragment = String(raw).slice(planStart).trim();
      const salvage = YAML.parse(fragment);
      const planData = salvage?.plan || salvage;
      const steps = planData?.steps;
      if (Array.isArray(steps) && steps.length > 0) {
        logger.info('LocalRunner', `Recovered plan via YAML salvage (${steps.length} steps)`);
        return {
          language: planData.language || task.language,
          library: planData.library || task.preferredLibrary,
          outputFile: planData.output_file || planData.outputFile || task.outputFile,
          steps: steps.map(normalizePlanStep),
        };
      }
    }
  } catch {}

  const jsonResult = parseJsonFromLlm(raw);
  if (jsonResult.ok && jsonResult.value?.steps && Array.isArray(jsonResult.value.steps)) {
    return {
      ...jsonResult.value,
      steps: jsonResult.value.steps.map(normalizePlanStep),
    };
  }

  logger.warn('LocalRunner', `Failed to parse plan (${parsed.error || 'no steps'}), using fallback`);
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

function cleanCode(raw) {
  let code = raw.trim();
  code = code.replace(/^```\w*\s*\n?/, '');
  code = code.replace(/\n?```\s*$/, '');
  return code.trim();
}

function normalizeOutputPaths(code, outputPath) {
  const outputFileName = path.basename(outputPath);
  const escapedOutputFileName = outputFileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  // Replace os.environ.get('OUTPUT_PATH', '/workspace/...') or os.getenv defaults
  result = result.replace(
    /os\.environ\.get\(\s*['"]OUTPUT_PATH['"]\s*,\s*['"][^'"']+['"]\s*\)/g,
    'os.environ.get("OUTPUT_PATH", OUTPUT_PATH)',
  );
  result = result.replace(
    /os\.getenv\(\s*['"]OUTPUT_PATH['"]\s*,\s*['"][^'"']+['"]\s*\)/g,
    'os.getenv("OUTPUT_PATH", OUTPUT_PATH)',
  );
  result = result.replace(/OUTPUT_PATH\s*=\s*setup\(\)\s*\[\s*['"]OUTPUT_PATH['"]\s*\]/g, 'OUTPUT_PATH = OUTPUT_PATH');
  result = result.replace(/setup\(\)\s*\[\s*['"]OUTPUT_PATH['"]\s*\]/g, 'OUTPUT_PATH');
  result = result.replace(/setup\(\)\.get\(\s*['"]OUTPUT_PATH['"]\s*\)/g, 'OUTPUT_PATH');
  result = result.replace(/setup\(\)\.get\(\s*['"]OUTPUT_PATH['"]\s*,\s*[^\)]*\)/g, 'OUTPUT_PATH');
  result = result.replace(/['"]\/workspace\/[^'"]+['"]/g, 'OUTPUT_PATH');
  result = result.replace(
    new RegExp(`(filepath|output_path|output_file|save_path)\\s*=\\s*['"]${escapedOutputFileName}['"]`, 'gi'),
    '$1 = OUTPUT_PATH',
  );
  result = result.replace(
    new RegExp(`save\\(\\s*['"]${escapedOutputFileName}['"]\\s*\\)`, 'gi'),
    'save(OUTPUT_PATH)',
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

function validateSemantics(code, step, task, plan) {
  const errors = [];
  const isNodeWord = usesNodeDocxAssembly(task);
  const isSetup = /^setup$|^setup_/i.test(step.functionName || step.name);

  if (isNodeWord && !isSetup) {
    if (/docxConstructors/.test(code)) {
      errors.push('Do not use setup().docxConstructors — use Paragraph, TextRun, Table directly.');
    }
    // Ban mutating docx objects after construction — the #1 cause of runtime crashes
    if (/\.rows\.push\s*\(/.test(code)) {
      errors.push('Do not mutate table.rows after construction. Build ALL rows inside new Table({ rows: [...] }).');
    }
    if (/\.children\.push\s*\(/.test(code)) {
      errors.push('Do not mutate .children after construction. Pass all children in the constructor.');
    }
    if (/\.cells\.push\s*\(/.test(code)) {
      errors.push('Do not mutate .cells after construction. Pass all cells in the constructor.');
    }
    if (/new\s+Paragraph\s*\(\s*\{[^}]*numbering\s*:\s*\{[^}]*config\s*:/.test(code)) {
      errors.push('numbering.config belongs on Document, not on Paragraph. Use numbering: { reference, level } on Paragraph.');
    }
    // Ban iterating over setup() results — setup() only returns scalars, not arrays
    if (/setup\(\)\s*[\.\[]/m.test(code) || /(?:const|let|var)\s*\{[^}]+\}\s*=\s*setup\(\)/.test(code)) {
      // Check if any destructured variable from setup() is then iterated
      const setupDestructure = code.match(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*setup\(\)/);
      if (setupDestructure) {
        const keys = setupDestructure[1].split(',').map(k => k.trim().split(':')[0].trim()).filter(Boolean);
        for (const key of keys) {
          if (new RegExp(`\\b${key}\\s*\\.\\s*(?:forEach|map|filter|reduce|find|some|every|flat)\\b`).test(code)) {
            errors.push(`Do not iterate over setup() result '${key}'. setup() returns scalars only. Hardcode all content arrays inside this function.`);
          }
        }
      }
    }
  }

  if (task.language === 'node') {
    if (/WidthType\.PERCENTAGE/.test(code) && isNodeWord) {
      errors.push('Use WidthType.DXA for table widths, not WidthType.PERCENTAGE.');
    }
  }

  if (task.language === 'python') {
    // These imports/APIs are invalid in common openpyxl versions and repeatedly cause retries.
    if (/from\s+openpyxl\.styles\s+import\s+[^;\n]*(?:FontProperties|NumberFormat)\b/m.test(code)) {
      errors.push(
        'Invalid openpyxl styles import: FontProperties and NumberFormat do not exist. ' +
        'Use Font for font styling and assign literal strings to cell.number_format.',
      );
    }
    if (/\bNumberFormatDescriptor\s*\.\s*from_str\s*\(/m.test(code)) {
      errors.push(
        'Invalid openpyxl API: NumberFormatDescriptor.from_str does not exist. ' +
        'Assign literal strings to cell.number_format, e.g. "$#,##0.00" or "0.0%".',
      );
    }
    if (/from\s+openpyxl\.formatting\.number\s+import\s+/m.test(code)) {
      errors.push(
        'Invalid openpyxl import: use "from openpyxl.styles.numbers import FORMAT_CURRENCY_USD_SIMPLE" ' +
        'or use explicit number formats as strings (e.g., "$#,##0.00").',
      );
    }
    if (/from\s+openpyxl\.formatting\.number_format\s+import\s+/m.test(code)) {
      errors.push(
        'Invalid openpyxl import: use "from openpyxl.styles.numbers import FORMAT_CURRENCY_USD_SIMPLE" ' +
        'or use explicit number formats as strings (e.g., "$#,##0.00").',
      );
    }

    // Ensure steps do not reference missing keys from setup(). If generated
    // code accesses config['key'] or setup().get('key'), require that the
    // plan's setup content_spec includes that key. This prevents LLMs from
    // assuming undocumented keys without hardcoding defaults in the probe.
    try {
      const setupStep = (plan && Array.isArray(plan.steps))
        ? plan.steps.find(s => (s.functionName || s.function_name) === 'setup')
        : null;
      const setupSpec = setupStep && (setupStep.contentSpec || setupStep.content_spec);
      const setupText = setupSpec ? JSON.stringify(setupSpec) : '';
      const keyPattern = /(?:setup\(\)\s*\[\s*['"]([^'"]+)['"]\s*\])|(?:setup\(\)\.get\(\s*['"]([^'"]+)['"]\s*\))|(?:config\[\s*['"]([^'"]+)['"]\s*\])|(?:config\.get\(\s*['"]([^'"]+)['"]\s*\))/g;
      const missingKeys = new Set();
      let m;
      while ((m = keyPattern.exec(code)) !== null) {
        const key = m[1] || m[2] || m[3] || m[4];
        if (key && setupText && !setupText.includes(key)) {
          missingKeys.add(key);
        }
      }
      if (missingKeys.size) {
        errors.push(
          `Step "${step.name}" references setup keys not declared in the plan's setup content_spec: ${Array.from(missingKeys).join(', ')}. ` +
          'Add these keys to `setup()` or avoid referencing undocumented keys.'
        );
      }
    } catch (e) {
      // Non-fatal — best-effort check only
    }
  }

  if (errors.length) {
    return `Semantic errors in step "${step.name}": ${errors.join(' ')}`;
  }
  return null;
}

/**
 * Runtime probe: actually execute the step function in a VM to catch
 * errors like table.rows.push, undefined properties, wrong return type.
 * Works for ALL Node task types, not just word+docx.
 */
async function validateNodeRuntime(code, step, task, verifiedFunctions) {
  if (task.language !== 'node') return null;

  const functionName = step.function_name || step.functionName;
  if (!functionName) return 'Missing function name for runtime validation.';

  const isSetup = /^setup$|^setup_/i.test(functionName);
  const isNodeWord = usesNodeDocxAssembly(task);

  const priorCode = (verifiedFunctions || [])
    .map(v => v.code)
    .filter(Boolean)
    .join('\n\n');

  // Build probe imports based on task type
  let importLine = '';
  if (isNodeWord) {
    importLine = "const { Document, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType, LevelFormat, PageBreak } = require('docx');";
  } else if (task.type === 'excel') {
    importLine = "const XLSX = require('xlsx');";
  }

  // If setup() is not yet in priorCode (content steps before step-1 is verified,
  // which shouldn't happen in normal flow but defend anyway), inject a Proxy stub
  // so the probe doesn't crash on property access — we want to catch the content
  // function's own bugs, not probe environment gaps.
  const priorFunctionNames = (verifiedFunctions || []).map(v => v.function_name || v.functionName).filter(Boolean);
  const setupInPrior = priorFunctionNames.includes('setup');

  // Safety stub: if setup() hasn't been verified yet (shouldn't happen in normal
  // sequential flow) return a safe object so the probe can still test the current
  // step's structural correctness (Table API usage, return type etc.)
  const setupSafetyWrap = (isNodeWord && !isSetup && !setupInPrior)
    ? `function setup() {
  // probe stub: returns safe defaults for any property so destructuring works
  return new Proxy({}, {
    get(_, k) {
      return typeof k === 'string' ? '' : undefined;
    }
  });
}`
    : '';

  // For non-setup steps in word mode, verify it returns an array
  const checkReturn = (isNodeWord && !isSetup)
    ? `if (!Array.isArray(out)) throw new Error('${functionName}() must return an array, got ' + typeof out);`
    : '';

  const probeSource = `
${importLine}
const fs = require('fs');
const path = require('path');
${setupSafetyWrap}
${priorCode}
${code}
(async () => {
  const out = typeof ${functionName} === 'function' ? await ${functionName}() : undefined;
  ${checkReturn}
})();
`;

  try {
    const script = new vm.Script(probeSource, { filename: `probe_${step.step}_${functionName}.js` });
    const context = vm.createContext({
      require,
      console: { log() {}, error() {}, warn() {} },
      process: { env: {}, cwd: () => __dirname },
      setTimeout,
      clearTimeout,
    });
    const result = script.runInContext(context);
    if (result && typeof result.then === 'function') {
      await Promise.race([
        result,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Runtime probe timed out after 8s')), 8000)),
      ]);
    }
    return null;
  } catch (err) {
    // Surface full stack so the retry prompt has something actionable
    const msg = err.message || String(err);
    const stack = err.stack ? err.stack.split('\n').slice(0, 5).join(' | ') : '';
    const detail = stack ? `${msg} [stack: ${stack}]` : msg;
    return `Runtime probe failed for step "${step.name}": ${detail}`;
  }
}

/**
 * Runtime probe for Python steps via subprocess.
 */
async function validatePythonRuntime(code, step, task, verifiedFunctions, outputPath) {
  if (task.language !== 'python') return null;

  const functionName = step.function_name || step.functionName;
  if (!functionName) return null;

  const priorCode = (verifiedFunctions || [])
    .map(v => v.code)
    .filter(Boolean)
    .join('\n\n');

  const normalizedCode = outputPath ? normalizeOutputPaths(code, outputPath) : code;

  const probeScript = `
import sys, os, pathlib
from datetime import date, datetime, timedelta
from pathlib import Path
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill, Border, Side, Alignment, Protection
from openpyxl.chart import BarChart, LineChart, PieChart, Reference
from openpyxl.utils import get_column_letter
OUTPUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ${JSON.stringify(path.basename(outputPath || path.join(OUTPUT_DIR, 'output.xlsx')))} )
${priorCode}
${normalizedCode}
try:
    result = ${functionName}()
    print("PROBE_OK")
except Exception as e:
    print(f"PROBE_FAIL: {e}", file=sys.stderr)
    sys.exit(1)
`;

  const tmpFile = path.join(OUTPUT_DIR, `_probe_${step.step}.py`);
  try {
    fs.writeFileSync(tmpFile, probeScript);
    const pythonExe = pickPython();
    execSync(`${pythonExe} "${tmpFile}"`, {
      stdio: 'pipe',
      timeout: 10000,
      cwd: OUTPUT_DIR,
      env: { ...process.env, OUTPUT_PATH: path.basename(outputPath || path.join(OUTPUT_DIR, 'output.xlsx')) },
    });
    return null;
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : (err.message || String(err));
    const lastLines = stderr.split('\n').slice(-3).join(' ');
    return `Runtime probe failed for step "${step.name}": ${lastLines} (probe saved: ${tmpFile})`;
  } finally {
    try {
      if (process.env.CLEAN_PROBE === '0') {
        // Keep probe file for debugging
      } else {
        fs.unlinkSync(tmpFile);
      }
    } catch {}
  }
}

async function generateStepCode(task, plan, step, verifiedFunctions, outputPath) {
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
        logger.warn('LocalRunner', `Step ${step.name} attempt ${attempt}: ${lastError}`);
        continue;
      }
      const syntaxError = validateStepSyntax(code, step, task.language);
      if (syntaxError) {
        lastError = syntaxError;
        logger.warn('LocalRunner', `Step ${step.name} attempt ${attempt}: syntax error`);
        continue;
      }
      const semanticError = validateSemantics(code, step, task, plan);
      if (semanticError) {
        lastError = semanticError;
        logger.warn('LocalRunner', `Step ${step.name} attempt ${attempt}: ${semanticError}`);
        continue;
      }
      // Runtime probe — actually execute the function to catch API misuse
      const runtimeError = task.language === 'node'
        ? await validateNodeRuntime(code, step, task, verifiedFunctions)
        : await validatePythonRuntime(code, step, task, verifiedFunctions, outputPath);
      if (runtimeError) {
        lastError = runtimeError;
        logger.warn('LocalRunner', `Step ${step.name} attempt ${attempt}: ${runtimeError}`);
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
    'import pathlib',
    'from datetime import date, datetime, timedelta',
    'from pathlib import Path',
    'from openpyxl import Workbook, load_workbook',
    'from openpyxl.styles import Font, PatternFill, Border, Side, Alignment, Protection',
    'from openpyxl.chart import BarChart, LineChart, PieChart, Reference',
    'from openpyxl.utils import get_column_letter',
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

  if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY && !process.env.OPENROUTER_API_KEY && !process.env.NVIDIA_API_KEY) {
    throw new Error('No LLM API key. Set GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, or NVIDIA_API_KEY in .env');
  }

  const promptText = readPrompt();
  ensureOutputDir();

  setAvailableLibraries({
    python: ['openpyxl', 'pandas', 'python-docx', 'matplotlib', 'seaborn', 'csv', 'json', 'os', 'pathlib'],
    node: ['fs', 'path', 'xlsx', 'docx'],
  });

  console.log('Analyzing task...');
  let task = await analyzeTask(promptText, { complete: llmComplete });
  task = resolveRuntimeTask(task, 'local');
  if (task.refinedMessage !== promptText) {
    console.log(`Refined (${promptText.length} → ${task.refinedMessage.length} chars)`);
  }
  if (task.volume) {
    const vol = Object.entries(task.volume).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    if (vol.length) console.log(`Volume: ${vol.join(' | ')}`);
  }
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

  console.log('Planning...');
  const planRaw = await llmComplete(buildPlannerPrompt(task), {
    maxTokens: 3500,
    temperature: 0.15,
  });

  // Save raw plan so user can always inspect what the LLM produced
  const planSavePath = path.join(OUTPUT_DIR, 'plan.yaml');
  fs.writeFileSync(planSavePath, planRaw);
  console.log(`Plan saved to: ${planSavePath}`);

  const plan = parsePlan(planRaw, task);

  console.log(`\nPlan: ${plan.steps.length} steps`);
  console.log('─'.repeat(70));
  plan.steps.forEach(s => {
    const deps = Array.isArray(s.dependsOn) && s.dependsOn.length ? s.dependsOn.join(',') : '-';
    const budget = s.linesBudget || s.lines_budget || '?';
    const ret = typeof s.returns === 'object'
      ? `${s.returns.type || '?'}${s.returns.shape ? ': ' + s.returns.shape : ''}`
      : (s.returns || '?');
    const desc = typeof s.description === 'string' ? s.description.slice(0, 100) : '';
    const spec = s.contentSpec || s.content_spec;
    const specPreview = spec
      ? (typeof spec === 'string' ? spec : JSON.stringify(spec)).slice(0, 120)
      : '';
    console.log(`  ${s.step}. ${s.functionName}()  ~${budget}L  deps:[${deps}]  → ${ret}`);
    if (desc) console.log(`     ${desc}`);
    if (specPreview) console.log(`     spec: ${specPreview}${specPreview.length >= 120 ? '...' : ''}`);
  });
  console.log('─'.repeat(70));
  console.log('');

  const codegenSteps = getCodegenSteps(plan, task);
  const stepCodes = [];
  const verified = [];
  const runStart = Date.now();
  for (let i = 0; i < codegenSteps.length; i++) {
    const step = codegenSteps[i];
    const stepStart = Date.now();
    console.log(`Generating step ${i + 1}/${codegenSteps.length}: ${step.name}`);
    const code = await generateStepCode(task, plan, step, verified, outputPath);
    stepCodes.push(code);
    verified.push({
      functionName: step.functionName,
      function_name: step.function_name,
      returns: step.returns,
      code,
    });
    const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
    const totalElapsed = ((Date.now() - runStart) / 1000).toFixed(1);
    console.log(`Completed step ${i + 1}/${codegenSteps.length}: ${step.name} (${elapsed}s, total ${totalElapsed}s)`);
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
    execSync(`${pythonExe} "${scriptPath}"`, {
      stdio: 'inherit',
      cwd: OUTPUT_DIR,
      env: { ...process.env, OUTPUT_PATH: path.basename(outputPath) },
    });
  }

  validateOutput(task.type, outputPath);
  console.log(`\nSUCCESS: file saved at ${outputPath}`);
}

main().catch(err => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});

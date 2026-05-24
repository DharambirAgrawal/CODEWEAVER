// tests/docTest.js
// Real end-to-end test — LLM generates actual JS code for a Word doc,
// code is syntax-checked, written to disk, assembled, and ready to run.
//
// Usage:
//   npm run test:doc              # default scenario: techcorp
//   npm run test:doc:brief        # product launch brief
//   DOC_TEST_SCENARIO=product-brief node tests/docTest.js
//
// At the end it prints:
//   node tests/output/final_generate.js
// Run that and you get a real .docx file.

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { llmComplete, getProviderChain } = require('../src/llm/client');
const { setAvailableLibraries } = require('../src/llm/prompts');
const { buildSkillPromptBlock, describeSelectedSkills } = require('../src/skills/loader');
const { getScenario, listScenarios } = require('./docScenarios');
const { buildFixedSetupImports, buildFixedAssembleAndSave } = require('./docSetupTemplate');
const { auditGeneratedCode } = require('./docSkillAudit');
const logger = require('../src/utils/logger');
const { parseJsonFromLlm } = require('../src/utils/jsonExtract');

const scenario = getScenario(process.env.DOC_TEST_SCENARIO);
const TEST_REQUEST = scenario.request;
const DOC_PLAN_SECTIONS = scenario.planSections;

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const OUTPUT_DIR = path.join(__dirname, 'output');
const FINAL_FILE = path.join(OUTPUT_DIR, 'final_generate.js');
const DOC_OUTPUT = path.join(OUTPUT_DIR, scenario.outputBasename);
// The placeholder the LLM uses — replaced at assembly with the real output path.
// This prevents the user's real filesystem path from appearing in LLM prompts or generated code.
const OUTPUT_PATH_PLACEHOLDER = 'OUTPUT_PATH';
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '5', 10);
/**
 * Max concurrent LLM calls for middle steps (1 = sequential).
 * Default 1 — Groq free tier hits TPM 429 quickly when set to 2+.
 */
const DOC_TEST_PARALLEL_LIMIT = Math.min(
  4,
  Math.max(1, parseInt(process.env.DOC_TEST_PARALLEL_LIMIT || '1', 10)),
);
const DOC_TEST_CODE_GEN_MAX_TOKENS = Math.min(
  16384,
  Math.max(2048, parseInt(process.env.DOC_TEST_CODE_GEN_MAX_TOKENS || '8192', 10)),
);


const PLAN_WARNINGS_ENABLED = true;
const PLAN_PARSE_ATTEMPTS = 3;

function buildDeterministicPlan() {
  const steps = [
    {
      step: 1,
      name: 'setup_imports',
      functionName: 'setupImports',
      description:
        'Top-level require() lines and shared helper factories (test uses a fixed template for this step).',
      returns: 'helpers object',
      dependsOn: [],
    },
  ];
  let n = 2;
  for (const sec of DOC_PLAN_SECTIONS) {
    steps.push({
      step: n,
      name: sec.name,
      functionName: sec.functionName,
      description: sec.description,
      returns: 'array of docx elements (Paragraph, Table, …)',
      dependsOn: [1],
      sectionHeading: sec.sectionHeading,
    });
    n++;
  }
  const contentSteps = DOC_PLAN_SECTIONS.map((_, i) => i + 2);
  steps.push({
    step: n,
    name: 'assemble_and_save',
    functionName: 'assembleAndSave',
    description:
      'Call each builder once, assemble Document with all sections in order, await Packer.toBuffer, fs.writeFileSync(OUTPUT_PATH).',
    returns: 'Promise<void>',
    dependsOn: [1, ...contentSteps],
  });
  return { steps, totalSteps: steps.length };
}

function isValidDocPlan(plan) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length < 3) return false;
  const first = plan.steps[0];
  const last = plan.steps[plan.steps.length - 1];
  const low = v => String(v || '').toLowerCase();
  if (!low(first.functionName).includes('setup') && !low(first.name).includes('setup')) return false;
  if (!low(last.functionName).includes('assemble') && !low(last.name).includes('assemble')) return false;
  for (const s of plan.steps) {
    if (s.step == null || typeof s.name !== 'string' || !s.name.trim()) return false;
    if (typeof s.functionName !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s.functionName)) return false;
    if (typeof s.description !== 'string' || !s.description.trim()) return false;
    if (!Array.isArray(s.dependsOn)) return false;
  }
  return true;
}

/** Scenario harness: middle steps match exact Heading-1 titles in order. */
function planMatchesScenarioSpec(plan) {
  if (!isValidDocPlan(plan)) return false;
  const wantTitles = DOC_PLAN_SECTIONS.map(s => s.sectionHeading);
  const middle = plan.steps.slice(1, -1);
  if (middle.length !== wantTitles.length) return false;
  const firstStepNo = plan.steps[0].step;
  for (let i = 0; i < wantTitles.length; i++) {
    const s = middle[i];
    if ((s.sectionHeading || '').trim() !== wantTitles[i]) return false;
    if (!Array.isArray(s.dependsOn) || !s.dependsOn.includes(firstStepNo)) return false;
  }
  return true;
}

/** Fix dependsOn: middle steps → [setup]; final → all prior step ids. */
function normalizePlanDependencies(plan) {
  if (!plan?.steps?.length) return;
  const steps = plan.steps;
  const firstNo = steps[0].step;
  for (let i = 0; i < steps.length; i++) {
    if (i === 0) steps[i].dependsOn = [];
    else if (i === steps.length - 1) steps[i].dependsOn = steps.slice(0, -1).map(s => s.step);
    else steps[i].dependsOn = [firstNo];
  }
}

// ─── SETUP ────────────────────────────────────────────────────────────────────
function setup() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  // Clean previous run
  fs.readdirSync(OUTPUT_DIR).forEach(f => fs.unlinkSync(path.join(OUTPUT_DIR, f)));

  setAvailableLibraries({
    python: [],
    node: ['docx', 'fs', 'path'],
  });
}

function validatePlan(plan) {
  if (!PLAN_WARNINGS_ENABLED) return plan;

  const warnings = [];
  if (!plan?.steps || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    warnings.push('plan.steps is missing or empty');
  } else {
    const first = plan.steps[0] || {};
    const last = plan.steps[plan.steps.length - 1] || {};
    const firstName = String(first.name || '').toLowerCase();
    const firstFn = String(first.functionName || '').toLowerCase();
    const lastName = String(last.name || '').toLowerCase();
    const lastFn = String(last.functionName || '').toLowerCase();

    if (!firstName.includes('setup') && !firstFn.includes('setup')) {
      warnings.push('first step is not setup_imports');
    }
    if (!lastName.includes('assemble') && !lastFn.includes('assemble')) {
      warnings.push('last step is not assemble_and_save');
    }

    const missingFields = plan.steps.filter(step => !step.name || !step.functionName);
    if (missingFields.length > 0) {
      warnings.push('one or more steps are missing name or functionName');
    }

    const nonFinalSteps = plan.steps.slice(0, -1);
    const documentStepHints = nonFinalSteps.filter(step => {
      const haystack = `${step.name || ''} ${step.description || ''}`.toLowerCase();
      return haystack.includes('document') || haystack.includes('assemble') || haystack.includes('save') || haystack.includes('packer');
    });
    if (documentStepHints.length > 0) {
      warnings.push('non-final steps appear to create/assemble/save the document');
    }
  }

  if (warnings.length > 0) {
    logger.warn('Test', `Plan validation warning: ${warnings.join(' | ')}`);
  }

  return plan;
}


// ─── SYNTAX CHECK ─────────────────────────────────────────────────────────────
function syntaxCheck(code, label) {
  const tmpFile = path.join(OUTPUT_DIR, `_syntax_check_${Date.now()}.js`);
  try {
    fs.writeFileSync(tmpFile, code);
    execSync(`node --check "${tmpFile}"`, { stdio: 'pipe' });
    return { valid: true };
  } catch (err) {
    const errorOutput = err.stderr?.toString() || err.stdout?.toString() || err.message;
    // Clean up path from error message to make it readable
    const cleanError = errorOutput.replace(tmpFile, `<${label}>`);
    return { valid: false, error: cleanError };
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

// ─── RUNTIME CHECK ────────────────────────────────────────────────────────────
// Builds a complete runnable script from all verified functions + current step,
// executes it in a child process, and returns any runtime error.
function runtimeCheck(plan, verifiedFunctions, currentStep, currentCode, isLast) {
  const tmpScript = path.join(OUTPUT_DIR, `_runtime_check_${Date.now()}.js`);
  const isFirst = currentStep.step === plan.steps[0].step;

  // Assemble: OUTPUT_PATH const + all previously verified code + current step's code
  const outPath = scenario.outputBasename;
  const allCode = [
    `const OUTPUT_PATH = require('path').join(__dirname, ${JSON.stringify(outPath)});`,
    ...verifiedFunctions.map(f => f.code),
    currentCode,
  ].join('\n\n');

  let runner;
  if (isLast) {
    // Run the full async save — this produces the actual docx file
    runner = `${currentStep.functionName}()
  .then(() => process.exit(0))
  .catch(err => { process.stderr.write(String(err.stack || err.message)); process.exit(1); });`;
  } else if (isFirst) {
    // Step 1 returns a helpers object — just call it and make sure it doesn't throw
    runner = `(async () => {
  try {
    const result = ${currentStep.functionName}();
    if (result === null || result === undefined) throw new Error('${currentStep.functionName}() returned null/undefined');
    if (typeof result !== 'object' || Array.isArray(result)) throw new Error(\`${currentStep.functionName}() must return a helpers object, got: \${Array.isArray(result) ? 'array' : typeof result}\`);
    const helperNames = ['createHeading', 'createPara', 'createCell', 'createRow', 'createTable'];
    helperNames.forEach(name => {
      if (typeof result[name] !== 'function') throw new Error(\`${currentStep.functionName}() missing helper: \${name}()\`);
    });
    const probeHeading = result.createHeading('Financial Highlights', 1);
    const probeMeta = (typeof headingMeta !== 'undefined' && headingMeta && typeof headingMeta.get === 'function')
      ? headingMeta.get(probeHeading)
      : null;
    const probeText = probeMeta ? probeMeta.text : probeHeading._cwHeading;
    if (String(probeText || '').trim() !== 'Financial Highlights') {
      throw new Error(\`${currentStep.functionName}() heading normalization is incorrect. Expected "Financial Highlights", got "\${probeText}"\`);
    }
    process.exit(0);
  } catch(err) { process.stderr.write(String(err.stack || err.message)); process.exit(1); }
})();`;
  } else {
    // Middle steps: must return a flat array of docx objects (Paragraphs, Tables, etc.)
    runner = `(async () => {
  try {
    const result = ${currentStep.functionName}();
    if (!Array.isArray(result)) throw new Error(\`${currentStep.functionName}() must return an array, got: \${typeof result}\`);
    if (result.length === 0) throw new Error('${currentStep.functionName}() returned empty array');
    const flat = [];
    result.forEach(el => {
      if (Array.isArray(el)) flat.push(...el);
      else flat.push(el);
    });
    flat.forEach((el, idx) => {
      if (Array.isArray(el)) throw new Error(\`Element [\${idx}] is a nested array — use ...helpers.createBulletList([...]) in return [...]\`);
      if (el === null || el === undefined) throw new Error(\`Element [\${idx}] is null/undefined\`);
    });
    const requiredHeadings = ${JSON.stringify({
      section: currentStep.sectionHeading || null,
      sub: currentStep.subHeading || null,
    })};
    if (requiredHeadings.section || requiredHeadings.sub) {
      const headings = flat
        .map(el => {
          const meta = (typeof headingMeta !== 'undefined' && headingMeta && typeof headingMeta.get === 'function')
            ? headingMeta.get(el)
            : null;
          const text = meta ? meta.text : (el && el._cwHeading);
          const level = meta ? meta.level : (el && el._cwHeadingLevel);
          return text ? { text: String(text).trim(), level } : null;
        })
        .filter(Boolean);
      if (requiredHeadings.section) {
        const hasSection = headings.some(h => h.text === requiredHeadings.section && h.level === 1);
        if (!hasSection) throw new Error(\`Missing required section heading: \${requiredHeadings.section}\`);
      }
      if (requiredHeadings.sub) {
        const hasSub = headings.some(h => h.text === requiredHeadings.sub && h.level === 2);
        if (!hasSub) throw new Error(\`Missing required sub-heading: \${requiredHeadings.sub}\`);
      }
    }
    process.exit(0);
  } catch(err) { process.stderr.write(String(err.stack || err.message)); process.exit(1); }
})();`;
  }

  const script = `'use strict';\n${allCode}\n\n${runner}`;

  try {
    fs.writeFileSync(tmpScript, script);
    execSync(`node "${tmpScript}"`, { stdio: 'pipe', timeout: 15000 });
    return { valid: true };
  } catch (err) {
    const errorOutput = err.stderr?.toString() || err.stdout?.toString() || err.message;
    return { valid: false, error: errorOutput.replace(new RegExp(tmpScript.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), `<${currentStep.name}>`) };
  } finally {
    if (fs.existsSync(tmpScript)) fs.unlinkSync(tmpScript);
  }
}

function docTestSkillContext(phase) {
  const ctx = {
    taskType: 'word',
    language: 'node',
    library: 'docx',
    phase,
    runtime: 'docTest',
  };
  // Smaller skill block on codegen to avoid Groq 413 (full skill still in fixed helpers)
  if (phase === 'codegen' || phase === 'retry') {
    ctx.maxChars = parseInt(process.env.DOC_TEST_SKILL_MAX_CHARS || '4500', 10);
  }
  return ctx;
}

// ─── PLAN PROMPT ──────────────────────────────────────────────────────────────
function buildPlanPrompt(request) {
  const headings = DOC_PLAN_SECTIONS.map((s, i) => `${i + 1}. "${s.sectionHeading}"`).join('\n');
  const skills = buildSkillPromptBlock(docTestSkillContext('plan'));
  return `You are a code planner. Output a step plan for a JavaScript file using the 'docx' npm package.
${skills}
FULL TASK (read entirely — do not invent different sections):
"""
${request}
"""

STRUCTURE YOU MUST FOLLOW FOR THIS TASK:
- Total steps = 1 (setup) + ${DOC_PLAN_SECTIONS.length} (content) + 1 (assemble) = ${DOC_PLAN_SECTIONS.length + 2}.
- Step 1: name "setup_imports", functionName "setupImports", dependsOn [].
- Middle steps: exactly ${DOC_PLAN_SECTIONS.length}, in this order, each with ONE Heading-1 section. The "sectionHeading" string MUST match exactly (character-for-character):
${headings}
- Each middle step: dependsOn must be [1] (the setup step number — use the numeric id of step 1 from your "step" field, which must be 1).
- Final step: name "assemble_and_save", functionName "assembleAndSave", dependsOn listing every prior step number in order [1,2,...,last-1].
- Only the final step creates Document and writes OUTPUT_PATH.
- Pick camelCase functionName per middle step (unique, descriptive). description: one short sentence of what content that function will emit.

Return ONLY valid JSON (no markdown, no commentary) with this shape:
{
  "steps": [
    {"step": 1, "name": "setup_imports", "functionName": "setupImports", "description": "...", "returns": "helpers object", "dependsOn": []},
    {"step": 2, "name": "...", "functionName": "...", "description": "...", "returns": "array of docx elements", "dependsOn": [1], "sectionHeading": "Executive Summary"},
    ...
  ],
  "totalSteps": ${DOC_PLAN_SECTIONS.length + 2}
}

Rules: short technical strings only; no prose or user-message paste inside JSON values. Output ONLY the JSON object.`;
}

// ─── CODE GEN PROMPT ──────────────────────────────────────────────────────────
function buildCodeGenPrompt(request, plan, currentStep, verifiedFunctions, lastError) {
  const isFirst = currentStep.step === plan.steps[0].step;
  const isLast = currentStep.step === plan.steps[plan.steps.length - 1].step;
  const skillPhase = lastError
    ? 'retry'
    : (isFirst ? 'setup' : (isLast ? 'assembly' : 'codegen'));
  const skills = buildSkillPromptBlock(docTestSkillContext(skillPhase));
  // Use a safe placeholder — the real path is injected by the assembler, never exposed to the LLM
  const outVar = OUTPUT_PATH_PLACEHOLDER;

  // Context strategy: showing the previous step's full code caused late-step hallucinations (wrong helpers,
  // truncated copies). Middle steps only need setupImports. Assemble only needs setup body + names of builders.
  let verifiedContext = '';
  if (verifiedFunctions.length > 0) {
    verifiedContext = '\n// ── ALREADY-WRITTEN FUNCTIONS (DO NOT REWRITE; call only as documented) ──\n';
    const setup = verifiedFunctions[0];
    if (isLast) {
      verifiedContext += `\n${setup.code}\n`;
      for (let i = 1; i < verifiedFunctions.length; i++) {
        const fn = verifiedFunctions[i];
        verifiedContext += `// ${fn.functionName}() — defined in this file; returns a flat array of docx elements for its section\n`;
      }
    } else if (!isFirst) {
      verifiedContext += `\n${setup.code}\n`;
      verifiedContext +=
        '// Other section functions exist in the file but are omitted here — do not read or mimic them; only use setupImports() for helpers.\n';
    }
  }

  const errorContext = lastError
    ? `\n// !! PREVIOUS ATTEMPT FAILED — FIX THIS ERROR:\n// ${lastError.replace(/\n/g, '\n// ')}\n`
    : '';

  const deps = currentStep.dependsOn.map(d => {
    const found = plan.steps.find(s => s.step === d);
    return found ? `${found.functionName}()` : `step${d}`;
  });

  const importRules = isFirst
    ? `STEP 1 RULES — This step owns ALL imports for the entire file:
- Write all require() calls at the TOP (outside any function): const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, AlignmentType, BorderStyle, WidthType } = require('docx'); const fs = require('fs'); const path = require('path');
- Step 1 is provided by a fixed template in the test harness (you normally do not regenerate it). If you do write it, return helpers: createHeading, createPara, createSpacer, createTable(headers, rows), createBulletList, createNumberedList`
    : `IMPORT RULES — THIS IS CRITICAL:
- NEVER write require() or import statements — ALL imports are already at the top of the file from Step 1
- NEVER redeclare Document, Packer, Paragraph, fs, path, or any other already-imported name
- All docx classes (Paragraph, TextRun, Table, etc.) are already in scope — use them directly
- Call setupImports() to get the helpers object if you need factory functions (e.g. const helpers = setupImports();)
- Do NOT use HeadingLevel directly; use helpers.createHeading('Title', 1) or helpers.createHeading('Sub', 2)`;

  return `You are generating ONE function that will be placed inside a larger JavaScript file.
This file already has all require() at the top. DO NOT add any require() or imports.
${skills}
Document being built:
"${request}"
${verifiedContext}
${errorContext}
${importRules}

YOUR TASK: Write ONLY the function for Step ${currentStep.step} — "${currentStep.name}"
Function name: ${currentStep.functionName}
What it does: ${currentStep.description}
Returns: ${currentStep.returns}
${deps.length ? `Must call: ${deps.join(', ')}` : ''}
${currentStep.sectionHeading
    ? `SECTION TITLE — REQUIRED FOR VALIDATION (do not skip or substitute):
- The FIRST expression in your returned array MUST be exactly:
  helpers.createHeading(${JSON.stringify(currentStep.sectionHeading)}, 1)
- The string argument must match character-for-character (including "&" vs "and").
- Do NOT use new Paragraph({ text: "..." }) or new Paragraph({ heading: ... }) for this section title — the test harness only detects helpers.createHeading(..., 1).
- You may use Heading 2 via helpers.createHeading("...", 2) for sub-parts after that.`
    : ''}
${currentStep.subHeading ? `Sub-heading (Heading 2): "${currentStep.subHeading}" — include once for this step via helpers.createHeading(..., 2).` : ''}

${isLast ? `FINAL STEP — You MUST:
1. Call each content-builder function EXACTLY ONCE to get its elements array
   - Do NOT call the same function more than once
   - Do NOT call a function that itself already calls another builder (avoid double-counting)
2. Spread all arrays into one flat allElements array: const allElements = [...step2result, ...step3result, ...];
3. Create a new Document({ sections: [{ children: allElements }] })
4. const buffer = await Packer.toBuffer(doc)
5. fs.writeFileSync(${outVar}, buffer)
6. console.log("Document saved to " + ${outVar})
7. This function must be async and export nothing (it is called directly)` :
isFirst ? `` :
`This is a MIDDLE step. Return a FLAT array of docx elements (Paragraphs, Tables).
CONTENT REQUIREMENTS — YOU MUST FOLLOW THESE:
- First line inside the function: const helpers = setupImports();
- Generate content ONLY for this step's section: "${currentStep.name}". Do NOT include any other section titles or content.
- Define ONLY the function ${currentStep.functionName}(). Do NOT define any other functions or helpers.
- Use helpers.createPara() for all body paragraphs so they can be validated.
- Write ALL the content specified for your sections — no skipping, no summarizing
- Every paragraph must be 2-5 sentences of real business content (not filler like "This is important")
- ALL tables MUST use helpers.createTable(['Header1','Header2',...], [['cell','cell'], ...]) — NEVER use bare new Table()
- Tables must have ALL rows listed in the spec with realistic numbers
- If the section calls for 3 products, write all 3 with full detail
- If the section calls for 5 risks, write all 5 with full mitigation details
- NEVER truncate or say "...add more content here" — write it all now
- NEVER nest arrays: wrong: [helpers.createBulletList([...])] right: [...helpers.createBulletList([...])]
- Every top-level return item must be a docx object (Paragraph, Table, etc.)
- No file I/O in this step`}

FORMATTING (skills/word-node.md — enforced by helpers):
- Heading 1: helpers.createHeading("Title", 1) — includes spacing
- Heading 2: helpers.createHeading("Sub", 2)
- Body: helpers.createPara("two to four sentences of real content...")
- Spacer: helpers.createSpacer()
- Table: helpers.createTable(['Col A','Col B'], [['r1a','r1b'], ['r2a','r2b']]) — full US Letter width, styled header row
- Bullets: ...helpers.createBulletList(['item one', 'item two']) — MUST use leading ... (spread); createBulletList returns an array
- Numbered: ...helpers.createNumberedList(['goal one', 'goal two']) — MUST use leading ...
- NEVER use bare new Table({ rows: ... }) — it breaks layout (no DXA widths)

API DISCIPLINE:
- Helpers available: createHeading, createPara, createSpacer, createTable, createBulletList, createNumberedList, createCell, createRow
- Do not invent other helper methods
- Do not use HeadingLevel directly

Return ONLY raw JavaScript code. No markdown fences. No explanation.`;
}


/** Reject or fix paths copied from Execify skill examples. */
function sanitizeAssembleSavePaths(code) {
  if (!code) return code;
  let out = code;
  out = out.replace(
    /fs\.writeFileSync\s*\(\s*(['"`])\/workspace\/[^'"`]+\1/g,
    'fs.writeFileSync(OUTPUT_PATH',
  );
  out = out.replace(
    /fs\.writeFileSync\s*\(\s*`\/workspace\/[^`]+`/g,
    'fs.writeFileSync(OUTPUT_PATH',
  );
  if (/\/workspace\//.test(out)) {
    out = out.replace(/\/workspace\/[A-Za-z0-9_.-]+/g, 'OUTPUT_PATH');
  }
  return out;
}

function assembleStepUsesWrongPath(code) {
  return /\/workspace\//.test(code) || /writeFileSync\s*\(\s*['"][^'"]*\.docx['"]/.test(code);
}

// ─── STRIP CODE FENCES + STRAY REQUIRES ──────────────────────────────────────
function cleanCode(raw, isFirstStep) {
  let code = raw
    .replace(/^```javascript\s*/m, '')
    .replace(/^```js\s*/m, '')
    .replace(/^```\s*/m, '')
    .replace(/```\s*$/m, '')
    .trim();

  // For steps 2+, strip any stray require() lines the LLM snuck in
  if (!isFirstStep) {
    code = code
      .split('\n')
      .filter(line => !/^\s*(const|let|var)\s+.+?=\s*require\s*\(/.test(line))
      .join('\n');
  }

  return code;
}

/** createBulletList / createNumberedList return arrays — must be spread into return [...] */
function normalizeListSpreads(code) {
  return code
    .replace(/(?<!\.\.\.)helpers\.createBulletList\s*\(/g, '...helpers.createBulletList(')
    .replace(/(?<!\.\.\.)helpers\.createNumberedList\s*\(/g, '...helpers.createNumberedList(');
}

function listHelpersMissingSpread(code) {
  if (/(?<!\.\.\.)helpers\.createBulletList\s*\(/.test(code)) {
    return 'createBulletList() returns an array. Inside return [...] you MUST write: ...helpers.createBulletList([...])';
  }
  if (/(?<!\.\.\.)helpers\.createNumberedList\s*\(/.test(code)) {
    return 'createNumberedList() returns an array. Inside return [...] you MUST write: ...helpers.createNumberedList([...])';
  }
  return null;
}

function codeHasForbiddenApiGuesses(code) {
  if (/\bnewTableCell\b/i.test(code)) {
    return 'Do not use newTableCell — use helpers.createCell(text, bold) or new TableCell({ children: [...] }).';
  }
  if (/\bcreateTableCell\b/i.test(code)) {
    return 'createTableCell does not exist — use helpers.createCell or new TableCell({ children: [...] }).';
  }
  const helperCalls = code.match(/\bhelpers\.create[A-Za-z0-9_]+\b/g) || [];
  const allowed = new Set([
    'helpers.createHeading',
    'helpers.createPara',
    'helpers.createSpacer',
    'helpers.createCell',
    'helpers.createRow',
    'helpers.createTable',
    'helpers.createBulletList',
    'helpers.createNumberedList',
  ]);
  for (const h of helperCalls) {
    if (!allowed.has(h)) {
      return `${h} is not defined on helpers — use createHeading, createPara, createTable, createBulletList, createNumberedList, etc.`;
    }
  }
  if (/\bnew Table\s*\(/.test(code)) {
    return 'Use helpers.createTable([headers], [[row cells], ...]) instead of new Table() — required for proper spacing and column widths.';
  }
  if (/[•\u2022]/.test(code)) {
    return 'Do not use unicode bullet characters — use helpers.createBulletList([...]).';
  }
  return null;
}

async function mapPool(items, concurrency, iterator) {
  if (!items.length) return [];
  if (concurrency < 2 || items.length === 1) {
    const acc = [];
    for (let i = 0; i < items.length; i++) acc.push(await iterator(items[i], i));
    return acc;
  }
  let cursor = 0;
  const results = new Array(items.length);
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await iterator(items[idx], idx);
    }
  }
  const workers = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

/**
 * @param {{ plan: object, step: object, verifiedForPrompt: Array<{step:number,functionName:string,code:string}>, verifiedForRuntime: Array<{step:number,functionName:string,code:string}>, isLast: boolean }} opts
 */
async function generateStepWithRetries(opts) {
  const { plan, step, verifiedForPrompt, verifiedForRuntime, isLast } = opts;
  let lastError = null;
  let finalCode = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) {
      logger.warn('Test', `  Retry ${attempt}/${MAX_RETRIES} — fixing error...`);
    }

    logger.info('Test', `  Calling LLM...`);
    let code;
    try {
      const prompt = buildCodeGenPrompt(TEST_REQUEST, plan, step, verifiedForPrompt, lastError);
      code = await llmComplete(prompt, {
        maxTokens: DOC_TEST_CODE_GEN_MAX_TOKENS,
        temperature: attempt === 1 ? 0.2 : 0.35,
      });
      code = cleanCode(code, false);
      if (!isLast) {
        code = normalizeListSpreads(code);
        const spreadErr = listHelpersMissingSpread(code);
        if (spreadErr) {
          lastError = spreadErr;
          logger.warn('Test', `  ✗ ${spreadErr}`);
          continue;
        }
      }
      if (isLast) {
        code = sanitizeAssembleSavePaths(code);
        if (assembleStepUsesWrongPath(code)) {
          lastError =
            'Final step must use fs.writeFileSync(OUTPUT_PATH, buffer) only — not /workspace/ or hardcoded .docx paths.';
          logger.warn('Test', `  ✗ ${lastError}`);
          continue;
        }
      }

      const functionMatches = [...code.matchAll(/\b(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g)];
      const functionNames = functionMatches.map(match => match[1]);
      if (!functionNames.includes(step.functionName)) {
        lastError = `Missing required function definition: ${step.functionName}()`;
        logger.warn('Test', `  ✗ Missing function ${step.functionName}()`);
        continue;
      }
      if (functionNames.length > 1) {
        lastError = `Only one function definition is allowed in this step. Found: ${functionNames.join(', ')}`;
        logger.warn('Test', `  ✗ Multiple functions detected: ${functionNames.join(', ')}`);
        continue;
      }
      if (/\bHeadingLevel\b/.test(code)) {
        lastError =
          'Do not reference HeadingLevel directly. Use helpers.createHeading("Title", 1) or helpers.createHeading("Sub", 2).';
        logger.warn('Test', '  ✗ HeadingLevel usage detected');
        continue;
      }
      const badApi = codeHasForbiddenApiGuesses(code);
      if (badApi) {
        lastError = badApi;
        logger.warn('Test', `  ✗ ${badApi}`);
        continue;
      }
    } catch (err) {
      lastError = `LLM error: ${err.message}`;
      logger.warn('Test', `  LLM failed: ${err.message}`);
      continue;
    }

    logger.info('Test', `  Generated ${code.split('\n').length} lines of code`);

    const stepFile = path.join(OUTPUT_DIR, `step_${step.step}_${step.name}.js`);
    fs.writeFileSync(stepFile, code);

    logger.info('Test', `  Syntax checking...`);
    const syntax = syntaxCheck(code, step.name);

    if (syntax.valid) {
      logger.info('Test', `  ✓ Syntax OK`);
      logger.info('Test', `  Runtime checking...`);
      const runtime = runtimeCheck(plan, verifiedForRuntime, step, code, isLast);
      if (!runtime.valid) {
        logger.warn('Test', `  ✗ Runtime error:\n${runtime.error}`);
        lastError = `Runtime error — the code ran but crashed:\n${runtime.error}`;
        fs.writeFileSync(
          stepFile,
          `// RUNTIME ERROR on attempt ${attempt}:\n// ${runtime.error.replace(/\n/g, '\n// ')}\n\n${code}`,
        );
        continue;
      }
      logger.info('Test', `  ✓ Runtime OK`);
      finalCode = code;
      break;
    } else {
      logger.warn('Test', `  ✗ Syntax error:\n${syntax.error}`);
      lastError = `Syntax error in JavaScript code:\n${syntax.error}`;
      fs.writeFileSync(
        stepFile,
        `// SYNTAX ERROR on attempt ${attempt}:\n// ${syntax.error.replace(/\n/g, '\n// ')}\n\n${code}`,
      );
    }
  }

  if (!finalCode) {
    throw new Error(`Step "${step.name}" failed after ${MAX_RETRIES} attempts`);
  }

  return {
    step: step.step,
    name: step.name,
    functionName: step.functionName,
    code: finalCode,
    lines: finalCode.split('\n').length,
  };
}

// ─── ASSEMBLE FINAL FILE ──────────────────────────────────────────────────────
// Step 1's code goes at the TOP LEVEL (its require() lines are file-scoped).
// Steps 2+ are pure functions — they never have their own require() calls.
// The entry point just calls the final async function.
function assembleFinalFile(plan, verifiedFunctions) {
  const lastStep = plan.steps[plan.steps.length - 1];
  const outPath = scenario.outputBasename;
  const requestSnippet = TEST_REQUEST.replace(/\s+/g, ' ').trim();

  const header = [
    `// CodeWeaver — Generated Document Script`,
    `// Request: ${requestSnippet.slice(0, 120)}...`,
    `// Generated: ${new Date().toISOString()}`,
    `// Run with: node "${FINAL_FILE.replace(/\\/g, '/')}"`,
    ``,
    `'use strict';`,
    `// Output path is injected here — not hardcoded by the LLM`,
    `const OUTPUT_PATH = require('path').join(__dirname, ${JSON.stringify(outPath)});`,
    ``,
  ];

  const body = [];
  verifiedFunctions.forEach(fn => {
    body.push(`// ── Step ${fn.step}: ${fn.functionName} ──`);
    body.push(fn.code);
    body.push('');
  });

  const entryPoint = [
    `// ── Entry Point ──`,
    `${lastStep.functionName}()`,
    `  .then(() => console.log('Done!'))`,
    `  .catch(err => { console.error('Failed:', err.message); process.exit(1); });`,
  ];

  return [...header, ...body, ...entryPoint].join('\n');
}

// ─── MAIN TEST ────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '═'.repeat(65));
  console.log('  CodeWeaver — Real Doc Generation Test');
  console.log('═'.repeat(65));
  console.log(`  Scenario: ${scenario.id} — ${scenario.label}`);
  console.log(`  Request: "${TEST_REQUEST.slice(0, 80)}..."`);
  console.log(`  Other scenarios: ${listScenarios().map(s => s.id).join(', ')}`);
  console.log(`  LLM: ${process.env.LLM_PROVIDER || 'gemini'} (fallback chain: ${getProviderChain().join(' → ')})`);
  console.log(`  Skills: ${describeSelectedSkills(docTestSkillContext('codegen'))}`);
  console.log(`  Output dir: ${OUTPUT_DIR}`);
  console.log(`  Code-gen max tokens: ${DOC_TEST_CODE_GEN_MAX_TOKENS} | Middle-step LLM concurrency: ${DOC_TEST_PARALLEL_LIMIT}`);
  console.log('═'.repeat(65) + '\n');

  if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY && !process.env.OPENROUTER_API_KEY) {
    logger.error('Test', 'No LLM API key. Set GEMINI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY in .env');
    process.exit(1);
  }

  setup();

  // ── STEP 1: Plan (LLM with structured JSON + deterministic fallback) ─────
  let plan;
  let planSource = 'deterministic';

  if (process.env.DOC_TEST_DETERMINISTIC_PLAN === '1') {
    plan = buildDeterministicPlan();
    logger.info('Test', 'Phase 1: Using deterministic plan (DOC_TEST_DETERMINISTIC_PLAN=1)');
  } else {
    logger.info('Test', 'Phase 1: Asking LLM to plan the document generation (json_object mode)...');
    const basePlanPrompt = buildPlanPrompt(TEST_REQUEST);
    let lastPlanSnippet = '';

    for (let attempt = 1; attempt <= PLAN_PARSE_ATTEMPTS; attempt++) {
      const retryHint =
        attempt > 1
          ? `\n\nThe previous plan was rejected. Output exactly ONE JSON object. You MUST have ${DOC_PLAN_SECTIONS.length} middle steps in this exact order with "sectionHeading" exactly (copy-paste these strings):\n${DOC_PLAN_SECTIONS.map((s, i) => `  Step ${i + 2}: sectionHeading = "${s.sectionHeading}"`).join('\n')}\nEach middle step: "dependsOn": [1]. Final step dependsOn: [1,2,...,${DOC_PLAN_SECTIONS.length + 1}]. Short technical English only in strings.`
          : '';
      const planRaw = await llmComplete(basePlanPrompt + retryHint, {
        maxTokens: 4500,
        temperature: attempt === 1 ? 0.05 : 0,
        jsonObject: true,
      });
      lastPlanSnippet = planRaw.slice(0, 500);
      const parsed = parseJsonFromLlm(planRaw);
      if (parsed.ok && isValidDocPlan(parsed.value)) {
        const candidate = JSON.parse(JSON.stringify(parsed.value));
        normalizePlanDependencies(candidate);
        if (planMatchesScenarioSpec(candidate)) {
          plan = candidate;
          planSource = 'llm';
          break;
        }
      }
      const reason = parsed.ok
        ? `failed ${scenario.id} spec (middle steps, exact sectionHeading order, setup+assemble anchors)`
        : parsed.error;
      logger.warn('Test', `Plan attempt ${attempt}/${PLAN_PARSE_ATTEMPTS} unusable: ${reason}`);
    }

    if (!plan) {
      plan = buildDeterministicPlan();
      logger.warn(
        'Test',
        `LLM plan did not match the ${scenario.id} section spec after retries — using deterministic plan`,
        lastPlanSnippet,
      );
    }
  }

  normalizePlanDependencies(plan);

  logger.info('Test', `Plan source: ${planSource} (${plan.steps.length} steps)`);
  plan = validatePlan(plan);

  logger.info('Test', `Plan ready: ${plan.steps.length} steps`);
  plan.steps.forEach(s => {
    console.log(`   Step ${s.step}: ${s.name} — ${s.description}`);
  });
  console.log('');

  // Save plan
  fs.writeFileSync(path.join(OUTPUT_DIR, 'plan.json'), JSON.stringify(plan, null, 2));

  // ── STEP 2: Generate + verify each step ───────────────────────────────────
  const verifiedFunctions = [];
  const stepResults = [];

  const setupStep = plan.steps[0];
  const middleSteps = plan.steps.slice(1, -1);
  const lastStep = plan.steps[plan.steps.length - 1];

  logger.info('Test', `${'─'.repeat(55)}`);
  logger.info('Test', `Step 1/${plan.steps.length}: ${setupStep.name}`);
  logger.info('Test', `  ${setupStep.description}`);

  const fixedCode = buildFixedSetupImports(setupStep.functionName);
  const step1File = path.join(OUTPUT_DIR, `step_${setupStep.step}_${setupStep.name}.js`);
  fs.writeFileSync(step1File, fixedCode);
  logger.info('Test', `  Generated ${fixedCode.split('\n').length} lines of code`);
  logger.info('Test', `  Syntax checking...`);
  const s1syntax = syntaxCheck(fixedCode, setupStep.name);
  if (!s1syntax.valid) {
    logger.warn('Test', `  ✗ Syntax error:\n${s1syntax.error}`);
    logger.error('Test', `Step "${setupStep.name}" failed with invalid fixed setup code`);
    process.exit(1);
  }
  logger.info('Test', `  ✓ Syntax OK`);
  logger.info('Test', `  Runtime checking...`);
  const s1runtime = runtimeCheck(plan, verifiedFunctions, setupStep, fixedCode, false);
  if (!s1runtime.valid) {
    logger.warn('Test', `  ✗ Runtime error:\n${s1runtime.error}`);
    logger.error('Test', `Step "${setupStep.name}" failed with invalid fixed setup code`);
    process.exit(1);
  }
  logger.info('Test', `  ✓ Runtime OK`);
  verifiedFunctions.push({ step: setupStep.step, functionName: setupStep.functionName, code: fixedCode });
  stepResults.push({ step: setupStep.step, name: setupStep.name, status: 'OK', lines: fixedCode.split('\n').length });
  logger.info('Test', `  ✓ Step ${setupStep.step} verified and locked in`);

  const setupOnly = [verifiedFunctions[0]];

  try {
    if (middleSteps.length >= 2 && DOC_TEST_PARALLEL_LIMIT > 1) {
      logger.info(
        'Test',
        `Middle steps: generating up to ${DOC_TEST_PARALLEL_LIMIT} sections in parallel (same rate limit as sequential; fewer round-trips).`,
      );
      const builtMiddles = await mapPool(middleSteps, DOC_TEST_PARALLEL_LIMIT, async step => {
        logger.info('Test', `${'─'.repeat(55)}`);
        const idx = plan.steps.findIndex(s => s.step === step.step) + 1;
        logger.info('Test', `Step ${idx}/${plan.steps.length}: ${step.name}`);
        logger.info('Test', `  ${step.description}`);
        return generateStepWithRetries({
          plan,
          step,
          verifiedForPrompt: setupOnly,
          verifiedForRuntime: setupOnly,
          isLast: false,
        });
      });
      builtMiddles.sort((a, b) => a.step - b.step);
      for (const built of builtMiddles) {
        verifiedFunctions.push({ step: built.step, functionName: built.functionName, code: built.code });
        stepResults.push({ step: built.step, name: built.name, status: 'OK', lines: built.lines });
        logger.info('Test', `  ✓ Step ${built.step} verified and locked in`);
      }
    } else {
      for (const step of middleSteps) {
        logger.info('Test', `${'─'.repeat(55)}`);
        const idx = plan.steps.findIndex(s => s.step === step.step) + 1;
        logger.info('Test', `Step ${idx}/${plan.steps.length}: ${step.name}`);
        logger.info('Test', `  ${step.description}`);
        const built = await generateStepWithRetries({
          plan,
          step,
          verifiedForPrompt: setupOnly,
          verifiedForRuntime: setupOnly,
          isLast: false,
        });
        verifiedFunctions.push({ step: built.step, functionName: built.functionName, code: built.code });
        stepResults.push({ step: built.step, name: built.name, status: 'OK', lines: built.lines });
        logger.info('Test', `  ✓ Step ${built.step} verified and locked in`);
      }
    }

    logger.info('Test', `${'─'.repeat(55)}`);
    logger.info('Test', `Step ${plan.steps.length}/${plan.steps.length}: ${lastStep.name}`);
    logger.info('Test', `  ${lastStep.description}`);
    logger.info('Test', '  Using fixed assemble template (OUTPUT_PATH — no LLM for final save)');
    const fixedAssemble = buildFixedAssembleAndSave(plan, lastStep.functionName);
    const stepFile = path.join(OUTPUT_DIR, `step_${lastStep.step}_${lastStep.name}.js`);
    fs.writeFileSync(stepFile, fixedAssemble);
    logger.info('Test', '  Syntax checking...');
    const asmSyntax = syntaxCheck(fixedAssemble, lastStep.name);
    if (!asmSyntax.valid) {
      throw new Error(`Fixed assemble step has syntax error:\n${asmSyntax.error}`);
    }
    logger.info('Test', '  ✓ Syntax OK');
    logger.info('Test', '  Runtime checking...');
    const asmRuntime = runtimeCheck(plan, verifiedFunctions, lastStep, fixedAssemble, true);
    if (!asmRuntime.valid) {
      throw new Error(`Fixed assemble step runtime error:\n${asmRuntime.error}`);
    }
    logger.info('Test', '  ✓ Runtime OK');
    verifiedFunctions.push({
      step: lastStep.step,
      functionName: lastStep.functionName,
      code: fixedAssemble,
    });
    stepResults.push({
      step: lastStep.step,
      name: lastStep.name,
      status: 'OK (fixed template)',
      lines: fixedAssemble.split('\n').length,
    });
    logger.info('Test', `  ✓ Step ${lastStep.step} verified and locked in`);
  } catch (err) {
    logger.error('Test', err.message || String(err));
    console.error(err);
    process.exit(1);
  }

  // ── STEP 3: Assemble final runnable file ──────────────────────────────────
  logger.info('Test', `${'─'.repeat(55)}`);
  logger.info('Test', `Assembling final script...`);

  const finalCode = assembleFinalFile(plan, verifiedFunctions);
  fs.writeFileSync(FINAL_FILE, finalCode);

  // Final syntax check on assembled file
  const finalSyntax = syntaxCheck(finalCode, 'final_generate.js');
  if (!finalSyntax.valid) {
    logger.error('Test', `Final assembled file has syntax error:\n${finalSyntax.error}`);
    // Still save it but warn
  } else {
    logger.info('Test', `✓ Final file syntax OK`);
  }

  const skillAudit = auditGeneratedCode(verifiedFunctions);
  logger.info('Test', `${'─'.repeat(55)}`);
  logger.info('Test', 'Skill compliance audit (static check on generated code):');
  skillAudit.passes.forEach(p => logger.info('Test', `  ✓ ${p}`));
  skillAudit.issues.forEach(i => logger.warn('Test', `  ✗ ${i}`));
  if (skillAudit.skillLikelyApplied) {
    logger.info('Test', '  → Skill patterns appear applied in generated code');
  } else {
    logger.warn('Test', '  → Re-run after changes; raw new Table() or missing DXA widths mean skill was not followed');
  }

  // ── SUMMARY ───────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(65));
  console.log('  TEST SUMMARY');
  console.log('═'.repeat(65));
  stepResults.forEach(r => {
    console.log(`  ${r.status === 'OK' ? '✓' : '✗'} Step ${r.step}: ${r.name} ${r.lines ? `(${r.lines} lines)` : ''}`);
  });
  console.log('');
  console.log(`  Files written to: ${OUTPUT_DIR}/`);
  console.log(`    plan.json              — LLM-generated plan`);
  plan.steps.forEach(s => {
    console.log(`    step_${s.step}_${s.name}.js`);
  });
  console.log(`    final_generate.js      — assembled runnable script`);
  console.log('');
  console.log('═'.repeat(65));
  console.log('  TO GENERATE THE DOCUMENT, RUN:');
  console.log('');
  console.log(`  node "${FINAL_FILE.replace(/\\/g, '/')}"`);
  console.log('');
  console.log(`  Output will be: ${DOC_OUTPUT}`);
  console.log('═'.repeat(65) + '\n');
}

main().catch(err => {
  logger.error('Test', 'Test crashed', err.message);
  console.error(err);
  process.exit(1);
});

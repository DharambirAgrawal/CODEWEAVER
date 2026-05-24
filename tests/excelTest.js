// tests/excelTest.js — real .xlsx via local Node + xlsx (like test:doc)
// Usage: npm run test:excel
// Then:  node tests/output/excel/final_generate.js

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { llmComplete, getProviderChain } = require('../src/llm/client');
const { setAvailableLibraries } = require('../src/llm/prompts');
const { buildSkillPromptBlock, describeSelectedSkills } = require('../src/skills/loader');
const { getScenario, listScenarios } = require('./excelScenarios');
const { buildFixedSetupExcel, buildFixedAssembleAndSave } = require('./excelSetupTemplate');
const logger = require('../src/utils/logger');
const { parseJsonFromLlm } = require('../src/utils/jsonExtract');

const scenario = getScenario(process.env.EXCEL_TEST_SCENARIO);
const TEST_REQUEST = scenario.request;
const PLAN_SECTIONS = scenario.planSections;
const OUTPUT_DIR = path.join(__dirname, 'output', 'excel');
const FINAL_FILE = path.join(OUTPUT_DIR, 'final_generate.js');
const OUTPUT_FILE = path.join(OUTPUT_DIR, scenario.outputBasename);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '5', 10);
const EXCEL_TEST_CODE_GEN_MAX_TOKENS = Math.min(
  16384,
  Math.max(4096, parseInt(process.env.EXCEL_TEST_CODE_GEN_MAX_TOKENS || '8192', 10)),
);

function excelSkillContext(phase) {
  const ctx = { taskType: 'excel', language: 'node', library: 'xlsx', phase, runtime: 'excelTest' };
  if (phase === 'codegen' || phase === 'retry') ctx.maxChars = parseInt(process.env.EXCEL_TEST_SKILL_MAX_CHARS || '4000', 10);
  return ctx;
}

function buildDeterministicPlan() {
  const steps = [{ step: 1, name: 'setup_excel', functionName: 'setupExcel', description: 'Fixed xlsx helpers', returns: 'helpers', dependsOn: [] }];
  let n = 2;
  for (const sec of PLAN_SECTIONS) {
    steps.push({
      step: n,
      name: sec.name,
      functionName: sec.functionName,
      description: sec.description,
      returns: '{ sheetName, rows, formulas? }',
      dependsOn: [1],
      sheetName: sec.sheetName,
      minRows: sec.minRows || 5,
    });
    n++;
  }
  steps.push({ step: n, name: 'assemble_and_save', functionName: 'assembleAndSave', description: 'Write workbook', returns: 'void', dependsOn: steps.slice(0, -1).map(s => s.step) });
  return { steps, totalSteps: steps.length };
}

function buildCodeGenPrompt(step, lastError) {
  const skills = buildSkillPromptBlock(excelSkillContext(lastError ? 'retry' : 'codegen'));
  const err = lastError ? `\nPREVIOUS ERROR:\n${lastError}\n` : '';
  return `Generate ONE JavaScript function for an xlsx build (SheetJS).
${skills}
${err}
Task: ${TEST_REQUEST}

Function: ${step.functionName}
Sheet name (exact): "${step.sheetName}"
${step.description}

Rules:
- Output ONLY the function ${step.functionName}() { ... } — no code outside the function.
- First line INSIDE the function: const helpers = setupExcel();
- CRITICAL: Include at least ${step.minRows || 5} DATA rows after the header (not counting the header row). If the task says 12 products, rows.length must be >= 13.
- Count before return: if (rows.length - 1 < ${step.minRows || 5}) add more data rows until you meet the minimum.
- Helpers available:
  - helpers.sheetPayload(name, rows, formulas?) — formulas: [{ cell: 'B2', f: "SUM('Sales Transactions'!G2:G31)" }]
  - helpers.withRevenueColumn(name, rows) — for transaction detail with Revenue = Units * Unit Price
  - helpers.withMarginPercentColumn(name, rows) — for catalog with Margin % = (List-Cost)/List
  - helpers.formula(cell, f) — build formula entries
- Cross-sheet refs: use single-quoted sheet names, e.g. 'Sales Transactions'!G2:G31
- Use numbers for numeric cells in rows; use formulas array for calculated KPIs and aggregates.
- Do NOT call XLSX.writeFile.
- Do NOT add require() or const helpers outside the function.

Return ONLY raw JavaScript.`;
}

function cleanCode(raw) {
  return raw
    .replace(/^```\w*\n?/m, '')
    .replace(/```\s*$/m, '')
    .replace(/^\s*module\.exports\s*=.*$/gm, '')
    .replace(/^\s*export\s+.*$/gm, '')
    .trim();
}

/** LLM often puts helpers at file scope — that breaks when steps are concatenated. */
function normalizeStepCode(code, functionName) {
  let c = cleanCode(code);
  c = c.replace(/^\s*const\s+helpers\s*=\s*setupExcel\(\)\s*;\s*\n+/m, '');
  const fnOpen = new RegExp(`(function\\s+${functionName}\\s*\\(\\s*\\)\\s*\\{)`);
  if (!fnOpen.test(c)) return c;
  if (!new RegExp(`function\\s+${functionName}[\\s\\S]*?const\\s+helpers\\s*=\\s*setupExcel\\s*\\(`).test(c)) {
    c = c.replace(fnOpen, `$1\n  const helpers = setupExcel();`);
  }
  return c;
}

function helpersOutsideFunction(code) {
  const beforeFn = code.split(/^\s*function\s+/m)[0] || '';
  return /const\s+helpers\s*=\s*setupExcel\s*\(/.test(beforeFn);
}

function syntaxCheck(code, label) {
  const tmp = path.join(OUTPUT_DIR, `_syn_${Date.now()}.js`);
  try {
    fs.writeFileSync(tmp, code);
    execSync(`node --check "${tmp}"`, { stdio: 'pipe' });
    return { valid: true };
  } catch (e) {
    return { valid: false, error: (e.stderr || e.message).toString() };
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

function runtimeCheck(verified, step, code) {
  const tmp = path.join(OUTPUT_DIR, `_rt_${Date.now()}.js`);
  const script = [
    `const OUTPUT_PATH = ${JSON.stringify(OUTPUT_FILE)};`,
    ...verified.map(f => f.code),
    code,
    `const r = ${step.functionName}();`,
    `if (!r || typeof r.sheetName !== 'string') throw new Error('Must return { sheetName, rows }');`,
    `if (!Array.isArray(r.rows) || r.rows.length < 2) throw new Error('rows needs header + data');`,
    `const minRows = ${step.minRows || 5};`,
    `if (r.rows.length - 1 < minRows) throw new Error('Need at least '+minRows+' data rows, got '+(r.rows.length-1));`,
    `r.rows.forEach((row,i)=>{ if(!Array.isArray(row)) throw new Error('row '+i+' not array'); });`,
    `if (r.formulas && !Array.isArray(r.formulas)) throw new Error('formulas must be an array');`,
  ].join('\n\n');
  try {
    fs.writeFileSync(tmp, script);
    execSync(`node "${tmp}"`, { stdio: 'pipe', timeout: 15000 });
    return { valid: true };
  } catch (e) {
    return { valid: false, error: (e.stderr || e.message).toString() };
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

async function generateStep(step, verified, lastError) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      let code = await llmComplete(buildCodeGenPrompt(step, lastError), {
        maxTokens: EXCEL_TEST_CODE_GEN_MAX_TOKENS,
        temperature: attempt === 1 ? 0.2 : 0.35,
      });
      code = normalizeStepCode(code, step.functionName);
      if (!new RegExp(`function\\s+${step.functionName}\\s*\\(`).test(code)) {
        lastError = `Missing function ${step.functionName}()`;
        continue;
      }
      if (helpersOutsideFunction(code)) {
        lastError = 'Move const helpers = setupExcel() inside the function body only';
        continue;
      }
      if (/XLSX\.writeFile/.test(code)) {
        lastError = 'Do not write file in this step';
        continue;
      }
      const syn = syntaxCheck(code, step.name);
      if (!syn.valid) { lastError = syn.error; continue; }
      const rt = runtimeCheck(verified, step, code);
      if (!rt.valid) {
        lastError = rt.error;
        if (/Need at least \d+ data rows/.test(rt.error)) {
          lastError += `\nAdd more rows to meet the minimum of ${step.minRows} data rows (plus header). Do not return until rows.length - 1 >= ${step.minRows}.`;
        }
        continue;
      }
      return code;
    } catch (e) {
      lastError = e.message;
    }
    logger.warn('Test', `  retry ${attempt}/${MAX_RETRIES}`);
  }
  throw new Error(`Step ${step.name} failed: ${lastError}`);
}

async function main() {
  console.log('\nCodeWeaver — Real Excel Test');
  console.log(`Scenario: ${scenario.id} — ${scenario.label}`);
  console.log(`LLM: ${process.env.LLM_PROVIDER || 'gemini'} (${getProviderChain().join(' → ')})`);
  console.log(`Skills: ${describeSelectedSkills(excelSkillContext('codegen'))}`);
  console.log(`Scenarios: ${listScenarios().map(s => s.id).join(', ')}`);
  console.log(`\n  Output folder (not tests/output/): ${OUTPUT_DIR}/`);
  console.log('  Doc tests write to tests/output/ — Excel tests write to tests/output/excel/\n');

  if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY && !process.env.OPENROUTER_API_KEY) {
    console.error('Set GEMINI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY in .env');
    process.exit(1);
  }

  setAvailableLibraries({ python: [], node: ['xlsx', 'fs', 'path'] });
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.readdirSync(OUTPUT_DIR).forEach(f => { try { fs.unlinkSync(path.join(OUTPUT_DIR, f)); } catch {} });

  const plan = buildDeterministicPlan();
  fs.writeFileSync(path.join(OUTPUT_DIR, 'plan.json'), JSON.stringify(plan, null, 2));

  const verified = [];
  const setup = plan.steps[0];
  const fixedSetup = buildFixedSetupExcel(setup.functionName);
  fs.writeFileSync(path.join(OUTPUT_DIR, `step_1_${setup.name}.js`), fixedSetup);
  verified.push({ code: fixedSetup });

  for (const step of plan.steps.slice(1, -1)) {
    logger.info('Test', `Step ${step.step}: ${step.name}`);
    const code = await generateStep(step, verified, null);
    fs.writeFileSync(path.join(OUTPUT_DIR, `step_${step.step}_${step.name}.js`), code);
    verified.push({ code });
    logger.info('Test', `  ✓ ${step.functionName}`);
  }

  const last = plan.steps[plan.steps.length - 1];
  const assemble = buildFixedAssembleAndSave(plan, last.functionName);
  verified.push({ code: assemble });

  const header = [`'use strict';`, `const OUTPUT_PATH = require('path').join(__dirname, ${JSON.stringify(scenario.outputBasename)});`, `const XLSX = require('xlsx');`, ''];
  const body = verified.map((f, i) => `// step ${i + 1}\n${f.code}\n`);
  const finalCode = [...header, ...body, `${last.functionName}();`].join('\n');
  fs.writeFileSync(FINAL_FILE, finalCode);

  const finalSyntax = syntaxCheck(finalCode, 'final_generate.js');
  if (!finalSyntax.valid) {
    throw new Error(`final_generate.js syntax error: ${finalSyntax.error}`);
  }

  console.log('\n' + '═'.repeat(55));
  console.log('  Files written:');
  fs.readdirSync(OUTPUT_DIR).sort().forEach(f => console.log(`    ${OUTPUT_DIR}/${f}`));
  console.log('═'.repeat(55));

  console.log('\n  Generating .xlsx...');
  try {
    execSync(`node "${FINAL_FILE}"`, { stdio: 'inherit', cwd: OUTPUT_DIR });
  } catch (e) {
    console.error('\n  Script saved but run failed. Run manually:\n');
    console.log(`  node "${FINAL_FILE}"\n`);
    process.exit(1);
  }

  if (fs.existsSync(OUTPUT_FILE)) {
    const size = fs.statSync(OUTPUT_FILE).size;
    console.log(`\n  ✓ Excel ready: ${OUTPUT_FILE} (${size} bytes)\n`);
  } else {
    console.error(`\n  ✗ Expected file missing: ${OUTPUT_FILE}\n`);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });

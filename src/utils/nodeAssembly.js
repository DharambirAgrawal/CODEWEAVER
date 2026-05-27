// src/utils/nodeAssembly.js
// Deterministic assembly for local Node + docx chunked plans.

const DOCX_PLANNED_IMPORTS = [
  'Document',
  'Packer',
  'Paragraph',
  'TextRun',
  'Table',
  'TableRow',
  'TableCell',
  'HeadingLevel',
  'AlignmentType',
  'BorderStyle',
  'WidthType',
  'ShadingType',
  'LevelFormat',
  'PageBreak',
];

function isAssemblyStep(step) {
  if (!step) return false;
  const text = `${step.name || ''} ${step.description || ''} ${step.functionName || ''}`.toLowerCase();
  return /final.*document|assemble|assembly|packer|write.*file|save.*docx|generate_and_save|create_final/.test(text);
}

function isSetupStep(step) {
  if (!step) return false;
  const text = `${step.name || ''} ${step.functionName || ''}`.toLowerCase();
  return /setup|imports|constants|config/.test(text);
}

/** Steps whose return value is spread into the document body. */
function getSectionSteps(plan) {
  return (plan.steps || []).filter(s => !isAssemblyStep(s) && !isSetupStep(s));
}

/** Steps sent to the LLM for codegen (no redundant final assembly step). */
function getCodegenSteps(plan, task) {
  if (task?.language !== 'node' || task?.type !== 'word') return plan.steps || [];
  return (plan.steps || []).filter(s => !isAssemblyStep(s));
}

function stripNodeStepBoilerplate(code) {
  return String(code || '')
    .replace(/^\s*const\s*\{[\s\S]*?\}\s*=\s*require\s*\(\s*['"]docx['"]\s*\)\s*;?\s*$/gm, '')
    .replace(/^\s*const\s+fs\s*=\s*require\s*\(\s*['"]fs['"]\s*\)\s*;?\s*$/gm, '')
    .replace(/^\s*module\.exports\s*=\s*[\s\S]*?;?\s*$/gm, '')
    .replace(/^\s*exports\.\w+\s*=\s*[\s\S]*?;?\s*$/gm, '')
    .trim();
}

/**
 * Build a runnable script: shared imports, section functions, deterministic main().
 */
function buildNodeDocxAssemblyScript({ plan, stepCodes, outputPath }) {
  const codegenSteps = getCodegenSteps(plan, { language: 'node', type: 'word' });
  const sectionSteps = getSectionSteps(plan);

  if (stepCodes.length !== codegenSteps.length) {
    throw new Error(
      `Step code count (${stepCodes.length}) does not match plan (${codegenSteps.length})`,
    );
  }

  const sanitized = stepCodes.map(stripNodeStepBoilerplate);
  const blocks = sanitized.map((body, i) => ({
    step: codegenSteps[i],
    body,
  }));

  const pathMod = require('path');
  const outputFileName = pathMod.basename(outputPath);

  const importBlock = [
    "const fs = require('fs');",
    "const path = require('path');",
    `const { ${DOCX_PLANNED_IMPORTS.join(', ')} } = require('docx');`,
  ].join('\n');

  const callLines = sectionSteps.map(step => {
    const fn = step.functionName;
    return `  await pushBlocks(allSections, ${fn});`;
  }).join('\n');

  return `${importBlock}

const OUTPUT_PATH = path.join(__dirname, ${JSON.stringify(outputFileName)});

async function pushBlocks(allSections, fn) {
  let blocks = fn();
  if (blocks && typeof blocks.then === 'function') blocks = await blocks;
  if (!Array.isArray(blocks)) {
  throw new Error((fn.name || 'section') + ' must return an array of docx block elements');
  }
  allSections.push(...blocks);
}

${blocks.map(b => b.body).join('\n\n')}

const __cwDocxConstructors = {
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
  WidthType,
  ShadingType,
  LevelFormat,
  PageBreak,
};

function __cwDecorateSetupPayload(payload) {
  if (payload && typeof payload === 'object' && !payload.docxConstructors) {
    payload.docxConstructors = __cwDocxConstructors;
  }
  return payload;
}

if (typeof setup === 'function') {
  const __cwSetupOriginal = setup;
  setup = function setupWithDocxConstructors(...args) {
    const value = __cwSetupOriginal(...args);
    if (value && typeof value.then === 'function') {
      return value.then(__cwDecorateSetupPayload);
    }
    return __cwDecorateSetupPayload(value);
  };
}

async function main() {
  const allSections = [];
${callLines || '  // no section steps'}
  const doc = new Document({ sections: [{ children: allSections }] });
  const buffer = await Packer.toBuffer(doc);
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, buffer);
  console.log('SUCCESS: saved ' + OUTPUT_PATH);
}

main().catch(err => { console.error(err); process.exit(1); });
`;
}

function usesNodeDocxAssembly(task) {
  return task?.language === 'node' && task?.type === 'word';
}

module.exports = {
  DOCX_PLANNED_IMPORTS,
  isAssemblyStep,
  isSetupStep,
  getSectionSteps,
  getCodegenSteps,
  stripNodeStepBoilerplate,
  buildNodeDocxAssemblyScript,
  usesNodeDocxAssembly,
};

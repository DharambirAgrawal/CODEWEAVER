// src/utils/nodeAssembly.js
// Deterministic assembly for local Node + docx chunked plans.

const { DOCX_PLANNED_IMPORTS } = require('../config');

function isAssemblyStep(step) {
  if (!step) return false;
  // Only check name and functionName, NOT description — descriptions often contain
  // words like "final" or "assemble" in non-assembly steps.
  const name = (step.name || '').toLowerCase();
  const fn = (step.functionName || '').toLowerCase();
  const assembly = /^(assemble|assembly|save|pack|write_file|generate_and_save|create_final|final_assembly|assemble_and_save|save_document|format_and_save)$/;
  if (assembly.test(name) || assembly.test(fn)) return true;
  const combined = `${name} ${fn}`;
  return /assemble.*save|save.*file|pack.*doc|write.*docx|final.*assem|generate_and_save/.test(combined);
}

function isSetupStep(step) {
  if (!step) return false;
  const name = (step.name || '').toLowerCase();
  const fn = (step.functionName || '').toLowerCase();
  // Only match step 1 names, not things like "buildConfigSection"
  return /^setup$|^setup_/.test(name) || /^setup$|^setup_/.test(fn) ||
    (step.step === 1 && /setup|imports|constants/.test(name));
}

/** Steps whose return value is spread into the document body. */
function getSectionSteps(plan) {
  return (plan.steps || []).filter(s => !isAssemblyStep(s) && !isSetupStep(s));
}

/** Steps sent to the LLM for codegen (no redundant final assembly step). */
function getCodegenSteps(plan, task) {
  if (task?.language !== 'node' || task?.type !== 'word') return plan.steps || [];
  const all = plan.steps || [];
  const filtered = all.filter(s => !isAssemblyStep(s));
  const skipped = all.filter(s => isAssemblyStep(s));
  if (skipped.length > 0) {
    const logger = require('../utils/logger');
    logger.info('NodeAssembly', `Skipping assembly step(s): ${skipped.map(s => s.name || s.functionName).join(', ')}`);
  }
  return filtered;
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

  const helperBlock = `
// ─── Harness helpers (use these — do NOT redefine) ─────────────────────────
const __cwBorder = { style: BorderStyle.SINGLE, size: 1, color: 'BBBBBB' };
const __cwBorders = { top: __cwBorder, bottom: __cwBorder, left: __cwBorder, right: __cwBorder };
const __cwContentWidth = 9360;

function cwHeading1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 320, after: 160 },
    children: [new TextRun({ text, bold: true, size: 32, font: 'Arial' })],
  });
}

function cwHeading2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 120 },
    children: [new TextRun({ text, bold: true, size: 28, font: 'Arial' })],
  });
}

function cwPara(text, opts = {}) {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    spacing: { before: 60, after: 120 },
    children: [new TextRun({ text, size: 22, font: 'Arial', ...opts })],
  });
}

function cwCenter(text, opts = {}) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 80, after: 80 },
    children: [new TextRun({ text, size: 22, font: 'Arial', ...opts })],
  });
}

function cwBullet(text, bold = false) {
  return new Paragraph({
    numbering: { reference: 'bullet-list', level: 0 },
    spacing: { before: 40, after: 40 },
    children: [new TextRun({ text, size: 22, font: 'Arial', bold })],
  });
}

function cwNumber(text) {
  return new Paragraph({
    numbering: { reference: 'numbered-list', level: 0 },
    spacing: { before: 40, after: 40 },
    children: [new TextRun({ text, size: 22, font: 'Arial' })],
  });
}

function cwSpacer(after = 200) {
  return new Paragraph({ spacing: { after }, children: [] });
}

function cwPageBreak() {
  return new Paragraph({ children: [new PageBreak()] });
}

function cwDivider() {
  return new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'AAAAAA' } },
    spacing: { before: 160, after: 160 },
    children: [],
  });
}

/** rows: string[][] — first row is header */
function cwTable(rows) {
  const cols = rows[0].length;
  const colWidth = Math.floor(__cwContentWidth / cols);
  const columnWidths = Array(cols).fill(colWidth);
  return new Table({
    width: { size: __cwContentWidth, type: WidthType.DXA },
    columnWidths,
    rows: rows.map((row, ri) => new TableRow({
      children: row.map(cell => new TableCell({
        borders: __cwBorders,
        width: { size: colWidth, type: WidthType.DXA },
        shading: ri === 0 ? { fill: 'D0E4F7', type: ShadingType.CLEAR } : undefined,
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({
          children: [new TextRun({ text: String(cell), size: 22, font: 'Arial', bold: ri === 0 })],
        })],
      })),
    })),
  });
}
`;

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
${helperBlock}

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
  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: 'Arial', size: 22 } },
      },
      paragraphStyles: [
        {
          id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 32, bold: true, font: 'Arial', color: '1F4E79' },
          paragraph: { spacing: { before: 320, after: 160 }, outlineLevel: 0 },
        },
        {
          id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 28, bold: true, font: 'Arial', color: '2F5496' },
          paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 },
        },
      ],
    },
    numbering: {
      config: [
        {
          reference: 'numbered-list',
          levels: [
            {
              level: 0,
              format: 'decimal',
              text: '%1.',
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
            {
              level: 1,
              format: 'lowerLetter',
              text: '%2.',
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 1440, hanging: 360 } } },
            },
          ],
        },
        {
          reference: 'bullet-list',
          levels: [
            {
              level: 0,
              format: 'bullet',
              text: '\\u2022',
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
            {
              level: 1,
              format: 'bullet',
              text: '\\u25E6',
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 1440, hanging: 360 } } },
            },
          ],
        },
        {
          reference: 'numbering',
          levels: [
            {
              level: 0,
              format: 'decimal',
              text: '%1.',
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      children: allSections,
    }],
  });
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

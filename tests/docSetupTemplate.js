// tests/docSetupTemplate.js
// Fixed setup + assemble templates — encode skills/word-node.md formatting rules.

function buildFixedSetupImports(functionName) {
  return `const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType, LevelFormat } = require('docx');
const fs = require('fs');
const path = require('path');
const headingMeta = new WeakMap();

// US Letter content width with 1" margins (from word-node skill)
const TABLE_WIDTH_DXA = 9360;
const CELL_MARGIN = { top: 80, bottom: 80, left: 120, right: 120 };
const TABLE_BORDER = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
const TABLE_BORDERS = { top: TABLE_BORDER, bottom: TABLE_BORDER, left: TABLE_BORDER, right: TABLE_BORDER };

function ${functionName}() {
  const normalizeText = (text) => String(text || '').replace(/\\s+/g, ' ').trim();

  const makeCell = (text, { bold = false, widthDxa, shadingFill } = {}) => {
    const cellOpts = {
      borders: TABLE_BORDERS,
      margins: CELL_MARGIN,
      children: [new Paragraph({ children: [new TextRun({ text: normalizeText(text), bold, font: 'Arial', size: 24 })] })],
    };
    if (widthDxa) cellOpts.width = { size: widthDxa, type: WidthType.DXA };
    if (shadingFill) cellOpts.shading = { fill: shadingFill, type: ShadingType.CLEAR };
    return new TableCell(cellOpts);
  };

  const helpers = {
    createHeading: (text, level = 1) => {
      const headingText = normalizeText(text);
      const paragraph = new Paragraph({
        heading: level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
        spacing: { before: level === 1 ? 360 : 240, after: 180 },
        children: [new TextRun({ text: headingText, bold: true, font: 'Arial', size: level === 1 ? 32 : 28 })],
      });
      headingMeta.set(paragraph, { text: headingText, level });
      try {
        paragraph._cwHeading = headingText;
        paragraph._cwHeadingLevel = level;
      } catch {}
      return paragraph;
    },
    createPara: (text, opts = {}) => {
      const paragraphText = normalizeText(text);
      const paragraph = new Paragraph({
        spacing: { after: 160 },
        children: [new TextRun({ text: paragraphText, font: 'Arial', size: 24, ...opts })],
      });
      paragraph._cwText = paragraphText;
      return paragraph;
    },
    createSpacer: () => new Paragraph({ spacing: { after: 120 }, children: [] }),
    createCell: (text, bold = false) => makeCell(text, { bold }),
    createRow: (cells) => new TableRow({ children: cells }),
    /** headers: string[]; rows: string[][] — skill-compliant full-width table */
    createTable: (headers, rows = []) => {
      const colCount = headers.length;
      const colWidth = Math.floor(TABLE_WIDTH_DXA / Math.max(colCount, 1));
      const columnWidths = headers.map(() => colWidth);
      const headerRow = new TableRow({
        children: headers.map((h, i) => makeCell(h, { bold: true, widthDxa: columnWidths[i], shadingFill: 'D5E8F0' })),
      });
      const bodyRows = rows.map(row => new TableRow({
        children: row.map((cell, i) => makeCell(cell, { widthDxa: columnWidths[i] || colWidth })),
      }));
      return new Table({
        width: { size: TABLE_WIDTH_DXA, type: WidthType.DXA },
        columnWidths,
        rows: [headerRow, ...bodyRows],
      });
    },
    createBulletList: (items) => {
      const list = Array.isArray(items) ? items : [];
      return list.map(item => new Paragraph({
        spacing: { after: 80 },
        bullet: { level: 0 },
        children: [new TextRun({ text: normalizeText(item), font: 'Arial', size: 24 })],
      }));
    },
    createNumberedList: (items) => {
      const list = Array.isArray(items) ? items : [];
      return list.map((item, idx) => new Paragraph({
        spacing: { after: 80 },
        children: [new TextRun({ text: \`\${idx + 1}. \${normalizeText(item)}\`, font: 'Arial', size: 24 })],
      }));
    },
  };

  return helpers;
}

/** Flatten one level — sections may use ...helpers.createBulletList() but LLM sometimes forgets spread */
function flattenBlocks(items) {
  const out = [];
  (items || []).forEach(item => {
    if (Array.isArray(item)) out.push(...item);
    else out.push(item);
  });
  return out;
}
`;
}

function buildFixedAssembleAndSave(plan, functionName = 'assembleAndSave') {
  const middleSteps = plan.steps.slice(1, -1);
  const callLines = middleSteps
    .map(s => `  allElements.push(...flattenBlocks(${s.functionName}()));`)
    .join('\n');

  return `async function ${functionName}() {
  const allElements = [];
${callLines}
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: 'Arial', size: 24 },
          paragraph: { spacing: { after: 160 } },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      children: allElements,
    }],
  });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(OUTPUT_PATH, buffer);
  console.log('Document saved to ' + OUTPUT_PATH);
}`;
}

module.exports = { buildFixedSetupImports, buildFixedAssembleAndSave };

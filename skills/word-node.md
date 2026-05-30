---
name: word-node
description: "CodeWeaver skill for creating new Word documents (.docx) with the Node.js `docx` npm package. Use for chunked generation in Execify (JavaScript). Creation only — not for editing existing .docx, PDF conversion, or XML unpack/repack."
---

# Word document creation (Node.js `docx`)

Reference for CodeWeaver when generating **new** `.docx` files with the `docx` npm package in Node.

## CodeWeaver execution model

| Topic | Rule |
|--------|------|
| **Scope** | Create new documents only. Do not edit existing `.docx`, unpack XML, or run LibreOffice/pandoc conversion commands. |
| **Output path** | Save the final file under **`/workspace/<outputFile>`**. In Execify, `/workspace` is the process working directory (same as “current directory” in the sandbox). Example: `fs.writeFileSync("/workspace/output_1716567890123.docx", buffer)`. |
| **Output filename** | Use the filename from the task (e.g. `output_<timestamp>.docx`). Do not invent a different name unless the task explicitly specifies one. |
| **Success log** | After saving, print: `SUCCESS: saved /workspace/<outputFile>` |
| **Library** | Use only `docx` and Node built-ins (`fs`, `path`). Do not call scripts under `scripts/office/`, `extract-text`, `validate.py`, etc. |
| **Install** | `docx` is already available in the environment. Do not run `npm install`. |

### Two codegen modes

**1. Section functions (Word V2 — most production Node paths)**

- One function per section; orchestrator assembles the final script.
- Signature: `function buildSectionName() { ... }`
- **Return** an array of block elements: `return [ cwHeading2('Title'), cwPara('...'), cwTable([...]) ]`
- **Do not** include `require()`, `import`, `Document()`, `Packer`, or `fs` in section code.
- **Do not** save files in section functions.
- **Use harness helpers** injected by the runner — do NOT redefine them:
  - `cwHeading1(text)`, `cwHeading2(text)` — section headings with spacing
  - `cwPara(text, opts?)` — body paragraph, justified, Arial 11pt
  - `cwCenter(text, opts?)` — centered text (cover page titles)
  - `cwBullet(text, bold?)`, `cwNumber(text)` — lists (uses pre-defined numbering)
  - `cwTable(rows)` — `rows` is `string[][]`, first row = header
  - `cwSpacer(after?)`, `cwPageBreak()`, `cwDivider()` — layout
- Do NOT hand-write full `new TableCell({...})` blocks when `cwTable()` works.
- Do NOT invent custom helpers with different names — use the `cw*` helpers only.

**2. Final assembly step (or single-shot scripts)**

- Only the **last** step creates `Document`, calls `Packer.toBuffer`, and writes the file.
- Pattern:

```javascript
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType,
        LevelFormat, PageBreak } = require('docx');
const fs = require('fs');

async function main() {
  const children = [
    // ... or spread results from section builders ...
  ];
  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync('/workspace/output_1234567890.docx', buffer); // use task outputFile
  console.log('SUCCESS: saved /workspace/output_1234567890.docx');
}

main().catch(err => { console.error(err); process.exit(1); });
```

Replace `output_1234567890.docx` with the actual `task.outputFile` value from the job.

---

## Planning (for the planner LLM)

When writing a Markdown plan for Word Node (section-functions mode), follow these rules exactly:

| Rule | Detail |
|------|--------|
| **step_1** | `setup() → config` — plain object with titles, dates, KPI labels, region lists, product names. NO Document, NO docx constructors. |
| **step_2+** | One function per document section. Signature: `buildSectionName() → blocks`. Returns array of Paragraph/Table elements. |
| **Never** | `addX(doc) → doc` chaining, `finalizeDocument`, `save`, `assemble`, or `Packer` steps — the harness handles assembly. |
| **do:** | Must copy exact KPI names, column headers, paragraph counts, and section titles from user requirements. Vague `do:` lines produce bad code. |
| **table:** | `columns=[A,B,C] rows=N` — copy exact column names and row counts from requirements. |
| **heading:** | `1` for major sections, `2` for subsections. |
| **page_break:** | `false` for cover; `true` only for major section starts — NOT before every table (avoid one-table-per-page layout) |
| **paragraphs:** | Exact count for prose sections (e.g. executive summary: `paragraphs: 6`). |
| **words:** | Per-section word target; sum must meet `total_words`. |
| **Lists** | In codegen use `reference: 'numbered-list'` or `'bullet-list'` — never unicode bullets, never invent numbering config. |

Library version: **docx v9** (docx-js). Use `HeadingLevel`, `WidthType.DXA`, half-point font sizes (`size: 24` = 12pt).

---

## Overview

A `.docx` file is a ZIP archive of XML parts. CodeWeaver builds it with **docx-js** (`docx` on npm), then Execify runs the script and validates the output file exists under `/workspace/`.

---

## Page size

```javascript
// docx-js defaults to A4 — set explicitly for US Letter
sections: [{
  properties: {
    page: {
      size: { width: 12240, height: 15840 }, // US Letter in DXA (1440 DXA = 1 inch)
      margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
    },
  },
  children: [/* content */],
}]
```

| Paper | Width | Height | Content width (1" margins) |
|-------|-------|--------|----------------------------|
| US Letter | 12,240 | 15,840 | 9,360 |
| A4 (default) | 11,906 | 16,838 | 9,026 |

Landscape: pass portrait dimensions and set `orientation: PageOrientation.LANDSCAPE` (docx-js swaps width/height in XML).

---

## Headings and styles

```javascript
new Paragraph({
  heading: HeadingLevel.HEADING_1,
  children: [new TextRun({ text: 'Section Title', bold: true })],
})
```

For custom document styles (TOC, etc.), override built-in IDs exactly: `"Heading1"`, `"Heading2"`, and include `outlineLevel` on paragraph styles when needed.

Default font: prefer **Arial** in style definitions for broad compatibility.

---

## Spacing and font sizes

docx-js `TextRun({ size: N })` uses **half-points**: `size: 24` = 12pt, `size: 32` = 16pt.

| Element | size (half-pt) | Notes |
|---------|----------------|-------|
| Cover title | 52–56 | bold, centered |
| Heading 1 | 32 | bold, use `HeadingLevel.HEADING_1` |
| Heading 2 | 28 | bold, use `HeadingLevel.HEADING_2` |
| Body | 24 | normal weight |
| Caption / footnote | 20 | italic optional |

Paragraph spacing (twips; 240 twips ≈ one line):

```javascript
// Body paragraph
new Paragraph({
  spacing: { after: 200 },
  children: [new TextRun({ text: 'Body text', size: 24 })],
})

// Section heading with extra gap after
new Paragraph({
  heading: HeadingLevel.HEADING_1,
  spacing: { before: 400, after: 200 },
  children: [new TextRun({ text: 'Section Title', bold: true, size: 32 })],
})

// Gap between major sections (alternative to page break)
new Paragraph({ spacing: { after: 400 }, children: [] })
```

Section pattern for multi-section documents:
1. Optional page break: `new Paragraph({ pageBreakBefore: true, children: [] })`
2. H1 heading with `spacing: { after: 200 }`
3. Body paragraphs with `spacing: { after: 200 }`
4. Tables with cell margins: `{ top: 80, bottom: 80, left: 120, right: 120 }`

---

## Lists (never use unicode bullets)

In **section-functions mode** (Word V2 / most production paths) the Document constructor is built by the harness — do NOT define numbering config yourself. Use the pre-defined harness references only:

| List type | reference string | notes |
|-----------|-----------------|-------|
| Numbered (1. 2. 3.) | `'numbered-list'` | Use this for goal lists, ordered steps |
| Bullets (• ○) | `'bullet-list'` | Use this for unordered items |
| Legacy alias | `'numbering'` | Also supported, maps to decimal numbers |

```javascript
// CORRECT — section function using pre-defined harness references
function buildGoals() {
  return [
    new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Q3 Goals')] }),
    new Paragraph({ numbering: { reference: 'numbered-list', level: 0 }, children: [new TextRun('Reach $5M ARR')] }),
    new Paragraph({ numbering: { reference: 'numbered-list', level: 0 }, children: [new TextRun('Hire 20 engineers')] }),
    new Paragraph({ numbering: { reference: 'bullet-list', level: 0 }, children: [new TextRun('Review strategy')] }),
  ];
}

// WRONG — never define numbering config in section functions
// (there is no Document constructor here to put it in)
const doc = new Document({ numbering: { config: [...] } });  // ← WRONG in section mode
```

In **single-shot scripts** (one standalone file), you must define the config in the Document constructor:

```javascript
const doc = new Document({
  numbering: {
    config: [
      { reference: 'numbered-list',
        levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: 'bullet-list',
        levels: [{ level: 0, format: 'bullet', text: '\u2022', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ],
  },
  sections: [{ children: [...paragraphsWithNumbering] }],
});
```

---

## Tables

Set **both** table `columnWidths` and each cell `width`. Use **`WidthType.DXA`** only (not `PERCENTAGE`).

```javascript
const border = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
const borders = { top: border, bottom: border, left: border, right: border };

new Table({
  width: { size: 9360, type: WidthType.DXA },
  columnWidths: [4680, 4680],
  rows: [
    new TableRow({
      children: [
        new TableCell({
          borders,
          width: { size: 4680, type: WidthType.DXA },
          shading: { fill: 'D5E8F0', type: ShadingType.CLEAR },
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          children: [new Paragraph({ children: [new TextRun('Cell')] })],
        }),
      ],
    }),
  ],
})
```

Table width must equal the sum of `columnWidths`. For US Letter with 1" margins, content width is typically **9360 DXA**.

---

## Images

`ImageRun` requires a `type` field (`png`, `jpg`, `jpeg`, `gif`, `bmp`, `svg`):

```javascript
new Paragraph({
  children: [new ImageRun({
    type: 'png',
    data: fs.readFileSync('/workspace/image.png'),
    transformation: { width: 200, height: 150 },
    altText: { title: 'Title', description: 'Desc', name: 'Name' },
  })],
})
```

Only reference files that exist under `/workspace/` in the same Execify session.

---

## Page breaks

```javascript
new Paragraph({ children: [new PageBreak()] })
// or
new Paragraph({ pageBreakBefore: true, children: [new TextRun('New page')] })
```

`PageBreak` must be inside a `Paragraph`.

---

## Hyperlinks, footnotes, headers/footers, TOC

Use standard docx-js patterns (`ExternalHyperlink`, `InternalHyperlink`, `Bookmark`, document `footnotes`, `headers`/`footers`, `TableOfContents`). For TOC, heading paragraphs must use **`HeadingLevel` only** (not ad-hoc styles).

---

## Critical rules (docx-js)

- Set page size explicitly when US Letter is required (default is A4).
- Never use `\n` for line breaks — use separate `Paragraph` elements.
- Never use unicode bullet characters — use `LevelFormat.BULLET` numbering.
- `PageBreak` must be inside a `Paragraph`.
- `ImageRun` must include `type`.
- Tables: dual widths, `WidthType.DXA`, `ShadingType.CLEAR` (not `SOLID`).
- Do not use tables as horizontal rules; use paragraph borders instead.
- TOC headings must use `HeadingLevel` with proper `outlineLevel` in styles when customizing.

---

## Common mistakes in CodeWeaver

| Mistake | Fix |
|---------|-----|
| Saving to `doc.docx` or cwd-relative path | Use `/workspace/<task.outputFile>` |
| `require()` inside a section function | Imports only in setup/assembly; sections return arrays only |
| `createHeading()` or other invented helpers | `new Paragraph({ heading: HeadingLevel.HEADING_1, ... })` |
| `Document` / `Packer` in section code | Only in final assembly |
| Sync save without `await Packer.toBuffer` | Use `async function main()` and `await` |
| Empty section array | Return at least one element |

Validation is handled by CodeWeaver (contract check + Execify execution + DOCX structure checks), not by external `validate.py` scripts.

---

## quantity_patterns

These patterns are injected when a step has a hard word-count target. Follow them exactly.

### Writing to a word target

When a step has `words: N`, write N–N+60 words of real content. Do not stop early.

```javascript
// WRONG — stops after one paragraph:
function addIntro() {
  return [new Paragraph({ children: [new TextRun({ text: 'Brief overview.', size: 24 })] })];
}

// CORRECT — writes to word target with multiple paragraphs:
function addIntro() {
  return [
    new Paragraph({ children: [new TextRun({ text: 'Paragraph one with detailed content spanning multiple sentences covering the first topic in depth.', size: 24 })] }),
    new Paragraph({ children: [new TextRun({ text: 'Paragraph two continues the discussion with specific data points, examples, and analysis.', size: 24 })] }),
    new Paragraph({ children: [new TextRun({ text: 'Paragraph three concludes this section with forward-looking statements and connections to the next topic.', size: 24 })] }),
  ];
}
```

### Structure rule for multi-section docs

Every content step must:
1. Start with a heading paragraph (`HeadingLevel.HEADING_1` or `HEADING_2`)
2. Follow with at least 3 body paragraphs
3. Include realistic text (not `"Lorem ipsum"` or `"Content here"`)

```javascript
function addSection() {
  return [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Section Title', size: 32, bold: true })] }),
    new Paragraph({ children: [new TextRun({ text: 'First detailed paragraph...', size: 24 })], spacing: { after: 200 } }),
    new Paragraph({ children: [new TextRun({ text: 'Second detailed paragraph...', size: 24 })], spacing: { after: 200 } }),
    new Paragraph({ children: [new TextRun({ text: 'Third detailed paragraph...', size: 24 })], spacing: { after: 200 } }),
  ];
}
```

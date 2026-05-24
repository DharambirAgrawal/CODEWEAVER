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
- Signature: `function renderSectionName() { ... }`
- **Return** an array of block elements: `return [ new Paragraph(...), new Table(...) ]`
- **Do not** include `require()`, `import`, `Document()`, `Packer`, or `fs` in section code.
- **Do not** save files in section functions.
- Use only constructors from the allowed list: `Paragraph`, `TextRun`, `Table`, `TableRow`, `TableCell` (plus enums like `HeadingLevel`, `AlignmentType`, `BorderStyle`, `WidthType` passed via outer imports).
- **Do not invent helpers** (e.g. `createHeading`, `newParagraph`, `styledParagraph`). Use `docx` APIs only.

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

## Lists (never use unicode bullets)

```javascript
// WRONG
new Paragraph({ children: [new TextRun('• Item')] })

// CORRECT — numbering config
const doc = new Document({
  numbering: {
    config: [
      { reference: 'bullets',
        levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ],
  },
  sections: [{
    children: [
      new Paragraph({
        numbering: { reference: 'bullets', level: 0 },
        children: [new TextRun('Bullet item')],
      }),
    ],
  }],
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

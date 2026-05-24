---
name: excel-node
description: "CodeWeaver skill for creating new Excel workbooks (.xlsx) with the Node.js `xlsx` package (SheetJS). Use for chunked generation in Execify (JavaScript). Creation only — not for editing existing files, macros, or CSV export unless requested."
---

# Excel spreadsheet creation (Node.js `xlsx`)

Reference for CodeWeaver when generating **new** `.xlsx` files with the **`xlsx`** npm package (SheetJS community edition) in Node.

## CodeWeaver execution model

| Topic | Rule |
|--------|------|
| **Scope** | Create new workbooks only. Do not read/transform existing `.xlsx` unless the task explicitly requires import-then-export. |
| **Output path** | Save under **`/workspace/<outputFile>`** (Execify working directory). Example: `XLSX.writeFile(workbook, '/workspace/output_1716567890.xlsx')`. |
| **Output filename** | Use the task’s `outputFile` (e.g. `output_<timestamp>.xlsx`). Do not invent a different name. |
| **Success log** | Print: `SUCCESS: saved /workspace/<outputFile>` |
| **Library** | Use only `xlsx` plus Node built-ins (`fs`, `path`). Do not use `exceljs`, `node-xlsx`, or Python libraries in Node jobs. |
| **Install** | `xlsx` is already available. Do not run `npm install`. |

### Two codegen modes

**1. Data / sheet builder functions (planned pipeline)**

- One function per step; orchestrator runs them in a session.
- Return **sheet data** the next step can use — not a saved file.
- Typical returns:
  - `array of arrays` (AOA) for `XLSX.utils.aoa_to_sheet`
  - `{ sheetName: 'Sales', rows: [[...], [...]] }`
- **Do not** call `XLSX.writeFile` except in the **final** step.
- **Do not** `require('xlsx')` in middle steps if setup already did imports (match orchestrator conventions).

**2. Final assembly step**

- Build workbook, append all sheets, write once:

```javascript
const XLSX = require('xlsx');

function main() {
  const workbook = XLSX.utils.book_new();

  const salesRows = buildSalesData(); // from prior step
  const salesSheet = XLSX.utils.aoa_to_sheet(salesRows);
  XLSX.utils.book_append_sheet(workbook, salesSheet, 'Sales');

  const summaryRows = buildSummaryData();
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');

  const out = '/workspace/output_1234567890.xlsx'; // use task outputFile
  XLSX.writeFile(workbook, out);
  console.log('SUCCESS: saved ' + out);
}

main();
```

---

## Core API (SheetJS)

```javascript
const XLSX = require('xlsx');

const workbook = XLSX.utils.book_new();
const worksheet = XLSX.utils.aoa_to_sheet([
  ['Region', 'Revenue', 'Growth %'],
  ['North', 1200000, 0.12],
  ['South', 980000, 0.08],
]);
XLSX.utils.book_append_sheet(workbook, worksheet, 'Q3 Sales');
XLSX.writeFile(workbook, '/workspace/report.xlsx');
```

| Task | API |
|------|-----|
| New workbook | `XLSX.utils.book_new()` |
| Array-of-arrays → sheet | `XLSX.utils.aoa_to_sheet(aoa)` |
| Array of objects → sheet | `XLSX.utils.json_to_sheet(rows)` |
| Add sheet | `XLSX.utils.book_append_sheet(wb, ws, name)` |
| Save file | `XLSX.writeFile(wb, path)` |
| Column width | set `ws['!cols']` (see below) |

---

## Sheet layout rules

### Header row

- Row 0 = column headers (strings).
- Put **numeric data as numbers**, not strings (`1200000` not `"1,200,000"` unless display formatting is required).
- Use realistic sample data — no `"TODO"` or `"..."` placeholders.

### Column widths

```javascript
worksheet['!cols'] = [
  { wch: 18 },
  { wch: 14 },
  { wch: 10 },
];
```

Set after `aoa_to_sheet`. `wch` ≈ character width.

### Multiple sheets

- Sheet names **≤ 31 characters**, no `: \ / ? * [ ]`.
- Avoid duplicate sheet names.
- Order sheets logically (e.g. Summary first, Detail second) when the task specifies.

### Large tables

- If the task asks for hundreds of rows, generate with loops in code — do not paste 500 manual rows.
- Keep each step’s function focused (one sheet or one transformation per step when possible).

---

## Formatting (basic)

Community `xlsx` supports limited styling via cell objects when needed:

```javascript
const ws = XLSX.utils.aoa_to_sheet([['Amount'], [1000]]);
const addr = XLSX.utils.encode_cell({ r: 0, c: 0 });
if (!ws[addr]) ws[addr] = { t: 's', v: 'Amount' };
ws[addr].s = { font: { bold: true } };
```

Prefer **structure first** (correct rows/columns/sheets). Add styling only when the task asks for bold headers or number formats.

For currency display without full styling, a header row plus numeric cells is acceptable.

---

## Formulas

Use cell formulas only when requested:

```javascript
// After aoa_to_sheet, set a formula cell
const totalRow = 10;
ws[XLSX.utils.encode_cell({ r: totalRow, c: 1 })] = { t: 'n', f: 'SUM(B2:B9)' };
```

Do not invent Excel functions that do not exist. Prefer computing totals in JavaScript and writing numeric results when formulas are not required.

---

## Common patterns

### Report with one data sheet

```javascript
function buildSalesSheet() {
  const rows = [
    ['Product', 'Units', 'Revenue'],
    ['Widget A', 420, 12600],
    ['Widget B', 310, 9300],
  ];
  return rows;
}
```

### Multiple regions on one sheet (stacked sections)

Use blank spacer rows between sections (empty array `[]` or `['']` row) and a bold section title row — or split into multiple sheets if clearer.

### Summary + detail

- Sheet 1: `Summary` — KPIs as two-column AOA `[['Metric', 'Value'], ...]`.
- Sheet 2: `Detail` — full table.

---

## Critical rules (`xlsx`)

- Always call `book_new()` before `book_append_sheet`.
- Use `aoa_to_sheet` or `json_to_sheet` — do not manually build XML.
- **Never** write CSV content into a `.xlsx` path without using SheetJS APIs.
- **Never** use `fs.writeFile` with made-up ZIP/binary strings for xlsx.
- Sheet names must be valid Excel names (length + forbidden characters).
- Final step must call `XLSX.writeFile(workbook, '/workspace/<outputFile>')` or `XLSX.write` + `fs.writeFileSync` with `type: 'buffer'`.
- Do not call `XLSX.readFile` in create-only tasks.

---

## Common mistakes in CodeWeaver

| Mistake | Fix |
|---------|-----|
| Saving to `report.xlsx` in cwd | Use `/workspace/<task.outputFile>` |
| `writeFile` in every step | Only the final step writes the workbook |
| Strings for numbers | Use numeric types for math columns |
| `workbook.Sheets['name'] = ws` without append | Use `book_append_sheet` |
| Sheet name too long | Truncate to 31 chars |
| Invented APIs (`workbook.addSheet`, `XLSX.createSheet`) | Use `utils.book_append_sheet` only |
| Returning workbook from middle step | Return AOA data; assembly builds the book |
| One giant step for 10 sheets | Split per plan step when orchestrator chunks |

---

## Validation expectations

Execify checks that:

- Output file exists under `/workspace/`
- File size is above minimum for `.xlsx`
- Optional row-count hints match task requirements

Generated code must actually run `XLSX.writeFile` (or equivalent) in the final step so the file appears in `/workspace/`.

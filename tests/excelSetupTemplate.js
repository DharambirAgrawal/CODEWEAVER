// tests/excelSetupTemplate.js — skill-aligned SheetJS helpers (skills/excel-node.md)

function buildFixedSetupExcel(functionName) {
  return `function ${functionName}() {
  const normalizeSheetName = (name) => String(name || 'Sheet').replace(/[\\\\/*?:\\[\\]]/g, '').slice(0, 31);

  return {
    /**
     * @param {string} sheetName
     * @param {Array<Array>} rows - array of arrays, row 0 = headers
     * @param {Array<{cell:string,f:string}>} [formulas]
     */
    sheetPayload: (sheetName, rows, formulas) => {
      const name = normalizeSheetName(sheetName);
      if (!Array.isArray(rows) || rows.length < 2) {
        throw new Error('sheetPayload requires header + at least one data row');
      }
      rows.forEach((row, i) => {
        if (!Array.isArray(row)) throw new Error('Row ' + i + ' must be an array');
      });
      return { sheetName: name, rows, formulas: formulas || [] };
    },

    /** Units col E (index 4), Price col F (index 5) → Revenue col G with row formulas */
    withRevenueColumn: (sheetName, rows) => {
      const name = normalizeSheetName(sheetName);
      const header = [...rows[0], 'Revenue'];
      const body = rows.slice(1).map(row => [...row, null]);
      const formulas = [];
      for (let i = 0; i < body.length; i++) {
        const r = i + 2;
        formulas.push({ cell: 'G' + r, f: 'E' + r + '*F' + r });
      }
      return { sheetName: name, rows: [header, ...body], formulas };
    },

    /** List Price col B, Cost col C → Margin % col D as (B-C)/B */
    withMarginPercentColumn: (sheetName, rows) => {
      const name = normalizeSheetName(sheetName);
      const header = [...rows[0], 'Margin %'];
      const body = rows.slice(1).map(row => [...row, null]);
      const formulas = [];
      for (let i = 0; i < body.length; i++) {
        const r = i + 2;
        formulas.push({ cell: 'D' + r, f: '(B' + r + '-C' + r + ')/B' + r });
      }
      return { sheetName: name, rows: [header, ...body], formulas };
    },

    /** Shorthand for one formula cell */
    formula: (cell, f) => ({ cell, f }),

    normalizeSheetName,
  };
}
`;
}

function buildFixedAssembleAndSave(plan, functionName = 'assembleAndSave') {
  const middleSteps = plan.steps.slice(1, -1);
  const callLines = middleSteps
    .map(s => `  appendSheet(workbook, ${s.functionName}());`)
    .join('\n');

  return `function appendSheet(workbook, payload) {
  if (!payload || !payload.sheetName || !Array.isArray(payload.rows)) {
    throw new Error('Each builder must return { sheetName, rows }');
  }
  const ws = XLSX.utils.aoa_to_sheet(payload.rows);
  const colCount = payload.rows[0]?.length || 1;
  ws['!cols'] = Array(colCount).fill(null).map((_, i) => ({ wch: i === 0 ? 14 : 16 }));

  (payload.formulas || []).forEach(({ cell, f }) => {
    if (!cell || !f) return;
    ws[cell] = { t: 'n', f };
  });

  XLSX.utils.book_append_sheet(workbook, ws, payload.sheetName);
}

function ${functionName}() {
  const workbook = XLSX.utils.book_new();
${callLines}
  XLSX.writeFile(workbook, OUTPUT_PATH);
  console.log('SUCCESS: saved ' + OUTPUT_PATH);
}
`;
}

module.exports = { buildFixedSetupExcel, buildFixedAssembleAndSave };

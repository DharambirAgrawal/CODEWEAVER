// tests/docSkillAudit.js
// Checks generated step code against word-node skill expectations (static analysis).

function auditGeneratedCode(verifiedFunctions) {
  const code = verifiedFunctions.map(f => f.code).join('\n\n');
  const issues = [];
  const passes = [];

  if (/WidthType\.DXA/.test(code) || /TABLE_WIDTH_DXA/.test(code) || /helpers\.createTable\s*\(/.test(code)) {
    passes.push('Tables use skill-aligned helpers or DXA widths');
  }

  const rawTables = [...code.matchAll(/\bnew Table\s*\(/g)];
  if (rawTables.length > 0) {
    issues.push(
      `Found ${rawTables.length} bare new Table() — skill requires helpers.createTable() with DXA columnWidths (see skills/word-node.md).`,
    );
  }

  if (/new Document\s*\(\s*\{\s*sections:\s*\[\s*\{\s*children:/.test(code)) {
    issues.push('Document assembled without page size/margins — use fixed assemble template.');
  }

  if (/[•\u2022]/.test(code)) {
    issues.push('Unicode bullet characters detected — use helpers.createBulletList().');
  }

  if (/helpers\.createTable\s*\(/.test(code)) {
    passes.push('helpers.createTable() used');
  }

  if (/spacing:\s*\{/.test(code) || /TABLE_WIDTH_DXA/.test(code)) {
    passes.push('Paragraph/table spacing or width constants present');
  }

  ['newParagraph', 'styledParagraph', 'newTableCell', 'createTableCell'].forEach(name => {
    if (new RegExp(`\\b${name}\\b`).test(code)) {
      issues.push(`Possible invented API: ${name}`);
    }
  });

  return {
    ok: issues.length === 0,
    issues,
    passes,
    skillLikelyApplied: issues.length === 0 && passes.length >= 2,
  };
}

module.exports = { auditGeneratedCode };

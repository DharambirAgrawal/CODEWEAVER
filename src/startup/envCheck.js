// src/startup/envCheck.js
// Run on server startup to detect missing packages / API keys early.
// Returns { ok: boolean, warnings: string[], errors: string[] }

'use strict';

const { execSync } = require('child_process');

async function checkEnvironment(requiredTypes = []) {
  const results = { ok: true, warnings: [], errors: [] };

  const needsPython = requiredTypes.some(t =>
    ['excel', 'chart', 'csv', 'pdf'].includes(t),
  );

  // ── Python check ───────────────────────────────────────────────────────────
  if (needsPython || requiredTypes.length === 0) {
    try {
      const v = execSync('python --version 2>&1', { timeout: 5000 }).toString().trim();
      results.warnings.push(`Python available: ${v}`);
    } catch {
      try {
        const v = execSync('python3 --version 2>&1', { timeout: 5000 }).toString().trim();
        results.warnings.push(`Python3 available: ${v}`);
      } catch {
        results.errors.push(
          'Python not found. Excel/chart/CSV generation will fail. ' +
          'Install Python 3.8+ and create a venv with openpyxl, matplotlib, python-docx.',
        );
        results.ok = false;
      }
    }

    // Python package checks
    const pyPackages = [
      { name: 'openpyxl', import: 'openpyxl', forTypes: ['excel'] },
      { name: 'matplotlib', import: 'matplotlib', forTypes: ['chart'] },
      { name: 'python-docx', import: 'docx', forTypes: ['word'] },
      { name: 'Pillow', import: 'PIL', forTypes: ['chart'] },
    ];

    const relevantPackages = requiredTypes.length === 0
      ? pyPackages
      : pyPackages.filter(p => p.forTypes.some(t => requiredTypes.includes(t)));

    for (const pkg of relevantPackages) {
      try {
        execSync(`python -c "import ${pkg.import}" 2>&1`, { stdio: 'pipe', timeout: 5000 });
      } catch {
        results.warnings.push(
          `Python package "${pkg.name}" not installed. Run: pip install ${pkg.name}`,
        );
      }
    }
  }

  // ── Node package checks ────────────────────────────────────────────────────
  if (requiredTypes.includes('word') || requiredTypes.length === 0) {
    try {
      require.resolve('docx');
    } catch {
      results.errors.push(
        '"docx" npm package not installed. Run: npm install docx',
      );
      results.ok = false;
    }
  }

  // ── LLM key check ─────────────────────────────────────────────────────────
  const llmKeys = [
    'GEMINI_API_KEY',
    'GROQ_API_KEY',
    'OPENROUTER_API_KEY',
    'NVIDIA_API_KEY',
  ];

  if (!llmKeys.some(k => process.env[k])) {
    results.errors.push(
      'No LLM API key found. Set at least one: GEMINI_API_KEY, GROQ_API_KEY, ' +
      'OPENROUTER_API_KEY, or NVIDIA_API_KEY in .env',
    );
    results.ok = false;
  }

  return results;
}

module.exports = { checkEnvironment };

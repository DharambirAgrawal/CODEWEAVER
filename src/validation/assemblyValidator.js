// src/validation/assemblyValidator.js
// Checks that the assembled full script contains all planned functions and calls them.

'use strict';

/**
 * @param {string} fullScript  - the assembled script text
 * @param {object} parsedPlan  - plan from planParser
 * @param {string} runtime     - 'python' | 'node'
 * @returns {string[]} array of error strings (empty = valid)
 */
function validateAssembly(fullScript, parsedPlan, runtime) {
  const errors = [];

  if (!fullScript || !parsedPlan?.steps?.length) return errors;

  for (const step of parsedPlan.steps) {
    if (!step.fnParsed?.name) continue;
    const name = step.fnParsed.name;

    // Check definition exists
    const defined = runtime === 'python'
      ? new RegExp(`^def\\s+${name}\\s*\\(`, 'm')
      : new RegExp(`function\\s+${name}\\s*\\(|const\\s+${name}\\s*=`, 'm');

    if (!defined.test(fullScript)) {
      errors.push(
        `Function "${name}" is in the plan but missing from the assembled script`,
      );
    }

    // Check it is called somewhere (Python only — Node uses async main())
    if (runtime === 'python' && !fullScript.includes(`${name}(`)) {
      errors.push(`main() does not call "${name}"`);
    }
  }

  // Check save pattern is present
  const savePatterns = {
    docx: runtime === 'python' ? /\.save\(/ : /Packer\.toBuffer|\.generate\(/,
    xlsx: /\.save\(|XLSX\.writeFile/,
    csv: runtime === 'python' ? /\.writerow|to_csv/ : /fs\.writeFile/,
    png: /\.savefig\(/,
  };

  // We check the last function (save step) for relevant patterns
  // This is best-effort — we don't block on missing patterns, just warn
  const hasSave = Object.values(savePatterns).some(re => re.test(fullScript));
  if (!hasSave) {
    errors.push(
      'No file-save pattern detected (expected .save(), XLSX.writeFile, savefig, etc.)',
    );
  }

  return errors;
}

module.exports = { validateAssembly };

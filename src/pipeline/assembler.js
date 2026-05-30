// src/pipeline/assembler.js
// Deterministic assembler — no LLM calls.
// Concatenates imports + function bodies + a main() call chain.

'use strict';

/**
 * Build the Python main() function that calls every planned function in order,
 * chaining outputs through the call graph derived from fnParsed.
 */
function buildPythonMain(steps, outputPath) {
  const lines = ['def main():'];
  const definedVars = new Set();

  for (const step of steps) {
    if (!step.fnParsed?.name) continue;
    const fn = step.fnParsed;

    // Filter inputs to only those that are actually defined (passed from prior steps)
    const callArgs = fn.inputs
      .filter(i => definedVars.has(i))
      .join(', ');

    const outAssign = fn.outputs.length
      ? `${fn.outputs.join(', ')} = `
      : '';

    lines.push(`    ${outAssign}${fn.name}(${callArgs})`);
    fn.outputs.forEach(o => definedVars.add(o));
  }

  if (outputPath) {
    lines.push(`    # Output: ${outputPath}`);
  }
  return lines.join('\n');
}

/**
 * Build the Node async main() equivalent.
 */
function buildNodeMain(steps, outputPath) {
  const lines = ['async function main() {'];
  const definedVars = new Set();

  for (const step of steps) {
    if (!step.fnParsed?.name) continue;
    const fn = step.fnParsed;

    const callArgs = fn.inputs
      .filter(i => definedVars.has(i))
      .join(', ');

    const outAssign = fn.outputs.length
      ? `  const ${fn.outputs.join(', ')} = await `
      : '  await ';

    lines.push(`${outAssign}${fn.name}(${callArgs});`);
    fn.outputs.forEach(o => definedVars.add(o));
  }

  if (outputPath) {
    lines.push(`  // Output: ${outputPath}`);
  }
  lines.push('}');
  lines.push('');
  lines.push("main().catch(err => { console.error(err); process.exit(1); });");
  return lines.join('\n');
}

/**
 * Assemble a full Python script from context.
 * @param {object} context  - job context with generated.imports_code, generated.functions, plan
 * @returns {string} complete Python script
 */
function assemblePython(context) {
  const { plan, generated } = context;
  const parts = [];

  // 1. Imports block
  if (generated.imports_code) {
    parts.push(generated.imports_code.trim());
    parts.push('');
  }

  // 2. Functions in plan order
  for (const step of plan.steps) {
    if (!step.fnParsed?.name) continue;
    const code = generated.functions[step.title];
    if (code) {
      parts.push(code.trim());
      parts.push('');
    }
  }

  // 3. main() with call chain
  parts.push(buildPythonMain(plan.steps, context.output_path));
  parts.push('');

  // 4. Entry point
  parts.push("if __name__ == '__main__':");
  parts.push('    main()');

  return parts.join('\n');
}

/**
 * Assemble a full Node.js script from context.
 */
function assembleNode(context) {
  const { plan, generated } = context;
  const parts = [];

  if (generated.imports_code) {
    parts.push(generated.imports_code.trim());
    parts.push('');
  }

  for (const step of plan.steps) {
    if (!step.fnParsed?.name) continue;
    const code = generated.functions[step.title];
    if (code) {
      parts.push(code.trim());
      parts.push('');
    }
  }

  parts.push(buildNodeMain(plan.steps, context.output_path));

  return parts.join('\n');
}

/**
 * Main export — picks Python or Node based on context.runtime.
 */
function assembleScript(context) {
  const runtime = context.runtime || 'python';
  if (runtime === 'node') return assembleNode(context);
  return assemblePython(context);
}

module.exports = { assembleScript, buildPythonMain, buildNodeMain };

// src/validation/stepValidator.js
// All per-step code probes: syntax, signature, pattern, content-length.
// Each probe returns { valid: boolean, error_type: string, error_message: string }

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── Probe 1: Python syntax check ──────────────────────────────────────────────
async function pythonSyntaxCheck(code, step) {
  const tmpPath = path.join(require('os').tmpdir(), `cw_probe_${Date.now()}.py`);
  try {
    fs.writeFileSync(tmpPath, code, 'utf8');
    execSync(`python -m py_compile "${tmpPath}" 2>&1`, { stdio: 'pipe', timeout: 8000 });
    return { valid: true };
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString() : (err.stdout ? err.stdout.toString() : err.message);
    const lineMatch = msg.match(/line (\d+)/);
    return {
      valid: false,
      error_type: 'SyntaxError',
      error_message: msg.trim(),
      error_line: lineMatch ? parseInt(lineMatch[1], 10) : null,
    };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

// ── Probe 1b: Node syntax check ───────────────────────────────────────────────
async function nodeSyntaxCheck(code, step) {
  const tmpPath = path.join(require('os').tmpdir(), `cw_probe_${Date.now()}.js`);
  try {
    fs.writeFileSync(tmpPath, code, 'utf8');
    execSync(`node --check "${tmpPath}" 2>&1`, { stdio: 'pipe', timeout: 8000 });
    return { valid: true };
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString() : (err.stdout ? err.stdout.toString() : err.message);
    return {
      valid: false,
      error_type: 'SyntaxError',
      error_message: msg.trim(),
    };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

// ── Probe 2: Python function signature check ──────────────────────────────────
function pythonSignatureCheck(code, step) {
  if (!step.fnParsed?.name) return { valid: true };

  const defMatch = code.match(/^def\s+(\w+)\s*\(/m);
  if (!defMatch) {
    return {
      valid: false,
      error_type: 'missing_function',
      error_message: `No function definition found. Expected: def ${step.fnParsed.name}(...)`,
    };
  }

  if (defMatch[1] !== step.fnParsed.name) {
    return {
      valid: false,
      error_type: 'wrong_name',
      error_message: `Function named "${defMatch[1]}" but should be "${step.fnParsed.name}"`,
    };
  }

  return { valid: true };
}

// ── Probe 2b: Node function signature check ───────────────────────────────────
function nodeSignatureCheck(code, step) {
  if (!step.fnParsed?.name) return { valid: true };

  const fnMatch = code.match(/(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s+)?\()/);
  const found = fnMatch?.[1] || fnMatch?.[2];

  if (!found) {
    return {
      valid: false,
      error_type: 'missing_function',
      error_message: `No function definition found. Expected: ${step.fnParsed.name}`,
    };
  }

  if (found !== step.fnParsed.name) {
    return {
      valid: false,
      error_type: 'wrong_name',
      error_message: `Function is "${found}" but should be "${step.fnParsed.name}"`,
    };
  }

  return { valid: true };
}

// ── Probe 3: Prohibited patterns ──────────────────────────────────────────────
function pythonPatternCheck(code) {
  const banned = [
    {
      re: /if\s+__name__\s*==\s*['"]__main__['"]/,
      msg: 'Contains __main__ block — remove it from the function body',
    },
    {
      re: /^import\s+|^from\s+.+\s+import\s+/m,
      msg: 'Contains import statements inside function — move all imports to the imports step',
    },
    {
      re: /\[add.*here\]|\[content\]|\[\.\.\.]/i,
      msg: 'Contains placeholder text like [add content here] — write the actual content',
    },
    {
      re: /^pass\s*$|^\s*\.\.\.\s*$/m,
      msg: 'Contains unfinished placeholder (pass or ...) — write the actual implementation',
    },
  ];

  for (const { re, msg } of banned) {
    if (re.test(code)) {
      return { valid: false, error_type: 'prohibited_pattern', error_message: msg };
    }
  }
  return { valid: true };
}

function nodePatternCheck(code) {
  const banned = [
    {
      re: /\[add.*here\]|\[content\]|\[\.\.\.]/i,
      msg: 'Contains placeholder text — write the actual content',
    },
    {
      re: /throw new Error\(['"]TODO/i,
      msg: 'Contains TODO placeholder — implement the function',
    },
  ];

  for (const { re, msg } of banned) {
    if (re.test(code)) {
      return { valid: false, error_type: 'prohibited_pattern', error_message: msg };
    }
  }
  return { valid: true };
}

// ── Probe 4: Content length estimate ─────────────────────────────────────────
// Count string literals > 20 chars as content. Rough words = chars / 5.5
function estimateContentLength(code, step) {
  if (!step.words) return { valid: true };

  const strings = [...code.matchAll(/"([^"]{20,})"|'([^']{20,})'/g)];
  const totalChars = strings.reduce((sum, m) => sum + (m[1] || m[2]).length, 0);
  const estimated = Math.floor(totalChars / 5.5);

  if (estimated < step.words * 0.45) {
    return {
      valid: false,
      error_type: 'content_too_short',
      error_message:
        `Estimated ~${estimated} words of content but step needs ${step.words}. ` +
        `Write more paragraphs covering: ${step.do || 'all required topics'}`,
      estimated,
    };
  }
  return { valid: true };
}

// ── Validated refiner output ──────────────────────────────────────────────────
function validateRefined(text) {
  const errors = [];
  const words = (text || '').trim().split(/\s+/).length;

  if (words < 80) {
    errors.push({ type: 'too_short', detail: `Only ${words} words, need 80+` });
  }

  const vague = [
    'appropriate', 'relevant', 'some information', 'various',
    'related content', 'and more', 'etc.', 'among others',
  ];
  for (const v of vague) {
    if (text.toLowerCase().includes(v)) {
      errors.push({ type: 'vague_language', detail: `Contains "${v}" — too vague` });
    }
  }

  return errors;
}

// ── Run all probes for a step ─────────────────────────────────────────────────
async function runStepProbes(code, step, runtime) {
  const probes = runtime === 'python'
    ? [
        () => pythonSyntaxCheck(code, step),
        () => Promise.resolve(pythonSignatureCheck(code, step)),
        () => Promise.resolve(pythonPatternCheck(code)),
        () => Promise.resolve(estimateContentLength(code, step)),
      ]
    : [
        () => nodeSyntaxCheck(code, step),
        () => Promise.resolve(nodeSignatureCheck(code, step)),
        () => Promise.resolve(nodePatternCheck(code)),
      ];

  for (const probe of probes) {
    const result = await probe();
    if (!result.valid) return result;
  }
  return { valid: true };
}

module.exports = {
  pythonSyntaxCheck,
  nodeSyntaxCheck,
  pythonSignatureCheck,
  nodeSignatureCheck,
  pythonPatternCheck,
  nodePatternCheck,
  estimateContentLength,
  validateRefined,
  runStepProbes,
};

// src/llm/prompts.js
// All system prompts and prompt builders for the orchestration loop

const { buildSkillPromptBlock } = require('../skills/loader');

// Injected once at startup from Execify /installed-modules
let availableLibraries = {
  python: ['openpyxl', 'pandas', 'python-docx', 'reportlab', 'fpdf2', 'matplotlib', 'csv', 'json', 'os', 'pathlib'],
  node: ['fs', 'path', 'xlsx', 'docx'],
};

function setAvailableLibraries(libs) {
  availableLibraries = libs;
}

function skillBlockForTask(task, phase, extra = {}) {
  return buildSkillPromptBlock({
    taskType: task.type,
    language: task.language,
    library: task.preferredLibrary,
    phase,
    ...extra,
  });
}

// ─── PLANNER PROMPT ──────────────────────────────────────────────────────────
function buildPlannerPrompt(task) {
  const libs = availableLibraries[task.language] || [];
  const skills = skillBlockForTask(task, 'plan');

  return `You are an expert software planner. Your job is to break down a file generation task into small, independently testable steps.
${skills}

TASK:
- Type: ${task.label}
- Output file: ${task.outputFile}
- Language: ${task.language}
- Preferred library: ${task.preferredLibrary}
- Complexity: ${task.complexity}
- Requirements: ${task.requirements.join(', ') || task.refinedMessage || task.rawMessage}
- Data description: ${task.dataDescription || task.refinedMessage || task.rawMessage}
${task.estimatedRows ? `- Estimated rows: ${task.estimatedRows}` : ''}
${task.estimatedPages ? `- Estimated pages: ${task.estimatedPages}` : ''}
${task.sheets ? `- Sheets: ${task.sheets.join(', ')}` : ''}
${task.sections ? `- Sections: ${task.sections.join(', ')}` : ''}

AVAILABLE LIBRARIES: ${libs.join(', ')}

${task.language === 'node' && task.type === 'word'
    ? `Plan exactly ${task.estimatedChunks} to ${task.estimatedChunks + 2} steps:
1. One setup step: plain JavaScript config/constants only (NO require(), NO docx constructors)
2. Content steps: each returns an array of docx block elements for one document section
Do NOT add a final assembly, save, pack, or write-file step — the runner assembles the .docx automatically.`
    : `Break this into ${task.estimatedChunks} to ${task.estimatedChunks + 2} steps. Each step must be ONE ${task.language === 'node' ? 'JavaScript' : 'Python'} function.`}

Rules:
- Each step is a single function, independently testable
${task.language === 'node' && task.type === 'word'
    ? `- Step 1 (setup): return a plain config object only — strings, numbers, nested data; no Paragraph/Table/Document
- Content steps: function returns an array of docx elements; no require(), Document(), Packer, or fs
- Do NOT include a step that saves or assembles the file`
    : `- Step 1 MUST set up imports and define constants/config
- The LAST step MUST call all previous functions and save final file to /workspace/${task.outputFile}`}
- Steps should be small enough that a good developer could write each in under 150 lines
- Use ONLY libraries from the available list above
- No step should depend on anything not produced by a previous step

Return ONLY valid JSON, no markdown:
{
  "language": "${task.language}",
  "library": "${task.preferredLibrary}",
  "outputFile": "${task.outputFile}",
  "steps": [
    {
      "step": 1,
      "name": "setup_and_imports",
      "functionName": "setup",
      "description": "what this step does in one sentence",
      "returns": "what value/object this function returns",
      "dependsOn": []
    }
  ]
}`;
}

// ─── CODE GENERATION PROMPT ──────────────────────────────────────────────────
function buildCodeGenPrompt(task, plan, currentStep, verifiedFunctions, lastError = null) {
  const libs = availableLibraries[task.language] || [];
  const isLastStep = currentStep.step === plan.steps[plan.steps.length - 1].step;

  // Build the verified functions context — signatures only
  let functionsContext = '';
  if (verifiedFunctions.length > 0) {
    functionsContext = '\n# VERIFIED FUNCTIONS FROM PREVIOUS STEPS (DO NOT REWRITE THESE):\n';
    verifiedFunctions.forEach(fn => {
      functionsContext += `\n# ${fn.functionName}() -> ${fn.returns || 'unknown'}\n`;
    });
  }

  const errorContext = lastError
    ? `\nPREVIOUS ATTEMPT FAILED WITH THIS ERROR:\n${lastError}\nFix the issue in your new attempt.\n`
    : '';

  const nodeWord = task.language === 'node' && task.type === 'word';
  const isSetup = nodeWord && /setup|imports|constants|config/i.test(`${currentStep.name} ${currentStep.functionName}`);
  const skillPhase = nodeWord ? (isSetup ? 'setup' : 'codegen') : (isLastStep ? 'assembly' : 'codegen');
  const skills = skillBlockForTask(task, skillPhase);

  return `You are an expert ${task.language} developer generating code for a file generation system.
${skills}
TASK: Generate a ${task.label} — ${task.dataDescription || task.refinedMessage || task.rawMessage}
OUTPUT FILE: /workspace/${task.outputFile}
AVAILABLE LIBRARIES: ${libs.join(', ')}
${functionsContext}
${errorContext}
YOUR JOB NOW: Write ONLY the function for Step ${currentStep.step}: "${currentStep.name}"
Function name: ${currentStep.functionName}
What it does: ${currentStep.description}
Returns: ${currentStep.returns}
Depends on: ${currentStep.dependsOn.length ? currentStep.dependsOn.map(d => {
    const dep = plan.steps.find(s => s.step === d);
    return dep ? `${dep.functionName}()` : `step ${d}`;
  }).join(', ') : 'nothing'}

${nodeWord && isSetup ? `This is the SETUP step. Return a plain configuration object only.
- NO require(), import, Document, Packer, Paragraph, Table, or fs
- Use plain strings/numbers/arrays for titles, labels, and sample data other steps may read via ${currentStep.functionName}()
- Do NOT return docxConstructors and do NOT add constructor maps in setup output
` : nodeWord ? `This is a CONTENT section step for docx.
- Return an array of block elements: [ new Paragraph(...), new Table(...), ... ]
- NO require(), Document(), Packer, or fs — imports are provided by the runner
- You may call ${verifiedFunctions.map(f => f.functionName + '()').join(', ') || 'setup()'} for shared config
- Never read setup().docxConstructors; use Paragraph/TextRun/Table directly
` : isLastStep ? `CRITICAL: This is the FINAL step. You MUST:
1. Call all previous verified functions
2. Assemble the complete output
3. Save the final file to /workspace/${task.outputFile}
4. Print "SUCCESS: saved /workspace/${task.outputFile}" as the last line
` : `This is NOT the final step. Do NOT save the final file yet.
Return the data/object as specified in "Returns" above.
`}

Rules:
- Write ONLY one function named ${currentStep.functionName} — no require/import lines${nodeWord ? ' (runner hoists docx imports)' : ', plus imports at the top if needed'}
- Implement ONLY this step. Do NOT generate code for any other step or section
- Do NOT include a main() block, module.exports, or if __name__ == '__main__'
- The function must be callable with no required arguments (use defaults)
- If generating data (rows, paragraphs, etc), use realistic-looking sample data, not placeholders
- Do NOT assume helpers beyond the verified signatures listed above
- Do NOT use libraries not in the available list
- Code must be complete and correct — it will be executed immediately

Return ONLY raw ${task.language} code. No markdown. No explanation. No backticks.`;
}

// ─── RETRY PROMPT ────────────────────────────────────────────────────────────
function buildRetryPrompt(task, plan, currentStep, verifiedFunctions, error, attemptNum) {
  // Same as code gen but with stronger retry framing
  const base = buildCodeGenPrompt(task, plan, currentStep, verifiedFunctions, error);
  return `${base}

This is retry attempt ${attemptNum}. The previous attempt had an error. Read the error carefully and fix it.
Do not repeat the same mistake. Return ONLY raw ${task.language} code.`;
}

// ─── VALIDATION FEEDBACK PROMPT ──────────────────────────────────────────────
function buildValidationFixPrompt(task, plan, currentStep, verifiedFunctions, validationResult) {
  const base = buildCodeGenPrompt(task, plan, currentStep, verifiedFunctions);
  return `${base}

The previous attempt executed without error BUT failed output validation:
${JSON.stringify(validationResult, null, 2)}

Fix the code so the output meets these requirements. Return ONLY raw ${task.language} code.`;
}

// ─── SECTION RENDERING PROMPTS (V2) ─────────────────────────────────────────
function buildSectionStructurePrompt(section) {
  const payload = section.type === 'table'
    ? { headers: section.headers || [], rows: section.rows || [] }
    : { items: section.items || [] };

  return `Given this ${section.type} data:
${JSON.stringify(payload)}

Confirm the structure. Return ONLY valid JSON:
{ "rows": N, "cols": N, "hasNesting": true|false }`;
}

function buildSectionPrompt({ section, functionName, language, library, imports, structure, taskType = 'word' }) {
  const sectionData = JSON.stringify(section, null, 2);
  const structureNote = structure
    ? `\nConfirmed structure: rows=${structure.rows}, cols=${structure.cols}, hasNesting=${structure.hasNesting}\n`
    : '';
  const typeNotes = buildSectionTypeNotes(section, language);
  const skills = buildSkillPromptBlock({
    taskType,
    language,
    library,
    phase: 'section',
  });

  if (language === 'python') {
    return `You are generating one section of a Word document in Python using ${library}.
${skills}
Your job: write a function that renders ONLY this section.

Section data:
${sectionData}
${structureNote}
Function signature: def ${functionName}(document):
Returns: list of docx elements added by this section

Section-specific rules:
${typeNotes}

Rules:
- Return a list, even if it contains one element
- Do not import anything (imports are handled externally)
- Do not save files (saving is handled externally)
- Do not create Document() inside this function
- Use only the "document" parameter and ${library} APIs
- No async code

Return raw Python only. No markdown. No explanation.`;
  }

  const importList = Array.isArray(imports) ? imports.join(', ') : '';

  return `You are generating one section of a Word document in JavaScript using the docx npm package.
${skills}
Available imports (already done): ${importList}

Your job: write a function that returns the docx elements for this section only.

Section data:
${sectionData}
${structureNote}
Function signature: function ${functionName}() { ... }
Returns: array of docx block elements (Table, Paragraph, etc.)

Section-specific rules:
${typeNotes}

Rules:
- Return an array, even if it contains one element
- Do not import anything (imports are handled externally)
- Do not save files (saving is handled externally)
- Use only the imports listed above
- No async, no Packer, no Document wrapper

Return raw JavaScript only. No markdown. No explanation.`;
}

function buildSectionTypeNotes(section, language) {
  const type = section?.type || '';
  const lines = [];

  if (type === 'title') {
    if (language === 'python') lines.push('- Use document.add_heading(text, level=0) for the title');
    else lines.push('- Use HeadingLevel.TITLE and center alignment for the title paragraph');
  }

  if (type === 'heading1') {
    if (language === 'python') lines.push('- Use document.add_heading(text, level=1)');
    else lines.push('- Use HeadingLevel.HEADING_1 for the heading');
  }

  if (type === 'heading2') {
    if (language === 'python') lines.push('- Use document.add_heading(text, level=2)');
    else lines.push('- Use HeadingLevel.HEADING_2 for the heading');
  }

  if (type === 'list') {
    if (language === 'python') {
      lines.push('- Render each item with document.add_paragraph(item, style="List Bullet")');
    } else {
      lines.push('- Render each item as a bullet paragraph: new Paragraph({ text, bullet: { level: 0 } })');
    }
  }

  if (type === 'nested_list') {
    if (language === 'python') {
      lines.push('- Render each title as a bold paragraph, then subitems with style "List Bullet 2"');
    } else {
      lines.push('- Render each title as a bold paragraph, then subitems as bullet paragraphs with level 1');
    }
  }

  if (type === 'table') {
    lines.push('- Table headers must be bold; ensure row/column counts match the provided data');
  }

  if (lines.length === 0) return '- No special formatting requirements.';
  return lines.join('\n');
}

module.exports = {
  setAvailableLibraries,
  buildPlannerPrompt,
  buildCodeGenPrompt,
  buildRetryPrompt,
  buildValidationFixPrompt,
  buildSectionPrompt,
  buildSectionStructurePrompt,
};

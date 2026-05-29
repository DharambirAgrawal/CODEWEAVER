// src/llm/prompts.js
// All prompt builders for the orchestration loop.
// Plans use YAML output — ~40% fewer tokens than JSON, more reliable for LLMs.

const { buildSkillPromptBlock } = require('../skills/loader');

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

function formatVolume(task) {
  const parts = [];
  if (task.volume?.estimatedRows) parts.push(`~${task.volume.estimatedRows} rows`);
  if (task.volume?.estimatedPages) parts.push(`~${task.volume.estimatedPages} pages`);
  if (task.volume?.estimatedSections) parts.push(`~${task.volume.estimatedSections} sections`);
  if (task.volume?.estimatedWords) parts.push(`~${task.volume.estimatedWords} words`);
  if (task.volume?.sheets?.length) parts.push(`sheets: ${task.volume.sheets.join(', ')}`);
  if (task.volume?.sections?.length) parts.push(`sections: ${task.volume.sections.join(', ')}`);
  // Legacy fields
  if (!parts.length && task.estimatedRows) parts.push(`~${task.estimatedRows} rows`);
  if (!parts.length && task.estimatedPages) parts.push(`~${task.estimatedPages} pages`);
  if (!parts.length && task.sheets?.length) parts.push(`sheets: ${task.sheets.join(', ')}`);
  if (!parts.length && task.sections?.length) parts.push(`sections: ${task.sections.join(', ')}`);
  return parts.length ? parts.join(' | ') : 'not specified';
}

function formatRequirementsForCodegen(task, maxChars = 600) {
  const reqs = Array.isArray(task.requirements) ? task.requirements.filter(Boolean) : [];
  if (reqs.length) {
    let text = reqs.map(r => `- ${r}`).join('\n');
    if (text.length > maxChars) text = `${text.slice(0, maxChars).trim()}...`;
    return text;
  }
  const fallback = (task.dataDescription || task.refinedMessage || task.rawMessage || '').trim();
  return fallback.length > maxChars ? `${fallback.slice(0, maxChars).trim()}...` : fallback;
}

function formatContentSpec(step) {
  const spec = step.content_spec || step.contentSpec;
  if (!spec) return '';
  if (typeof spec === 'string') return spec.trim();
  if (typeof spec === 'object') {
    const lines = [];
    if (spec.heading_level != null || spec.headingLevel != null) {
      lines.push(`heading_level: ${spec.heading_level ?? spec.headingLevel}`);
    }
    if (spec.page_break_before != null || spec.pageBreakBefore != null) {
      lines.push(`page_break_before: ${spec.page_break_before ?? spec.pageBreakBefore}`);
    }
    if (spec.data) lines.push(`data: ${spec.data}`);
    if (spec.table) lines.push(`table: ${typeof spec.table === 'string' ? spec.table : JSON.stringify(spec.table)}`);
    if (spec.formatting) lines.push(`formatting: ${spec.formatting}`);
    if (spec.connects_to || spec.connectsTo) {
      lines.push(`connects_to: ${spec.connects_to ?? spec.connectsTo}`);
    }
    const extra = Object.keys(spec).filter(k => ![
      'heading_level', 'headingLevel', 'page_break_before', 'pageBreakBefore',
      'data', 'table', 'formatting', 'connects_to', 'connectsTo',
    ].includes(k));
    extra.forEach(k => lines.push(`${k}: ${typeof spec[k] === 'string' ? spec[k] : JSON.stringify(spec[k])}`));
    return lines.join('\n');
  }
  return String(spec);
}

// ─── PLANNER PROMPT ──────────────────────────────────────────────────────────
function buildPlannerPrompt(task) {
  const libs = availableLibraries[task.language] || [];
  const skills = skillBlockForTask(task, 'plan');
  const lang = task.language === 'node' ? 'JavaScript' : 'Python';
  const stepMin = task.stepBudget?.min || 2;
  const stepMax = task.stepBudget?.max || 12;
  const isNodeWord = task.language === 'node' && task.type === 'word';
  const isExcel = task.type === 'excel';

  const nodeWordRules = isNodeWord
    ? `
WORD-DOCX SPECIAL RULES:
- Step 1: setup — return a plain config object (strings/numbers/arrays). NO require, NO docx constructors.
- Content steps: each returns an array of docx block elements. NO require, NO Document, NO Packer, NO fs.
- Do NOT add a final assembly/save/pack step — the runner handles assembly automatically.
- Each content step handles ONE document section (heading + body + tables/lists for that section).
- You MUST create one step per numbered section in requirements. Do NOT merge or skip sections.
- In content_spec for each section step include: heading_level (1 or 2), page_break_before (true/false), exact data to generate, table schema if applicable.`
    : '';

  const excelRules = isExcel
    ? `
EXCEL SPECIAL RULES:
- You MUST create one step per sheet listed in requirements. Do NOT merge or skip sheets.
- In content_spec include: sheet name, column headers, row count, formula patterns, formatting.`
    : '';

  const contentSpecExample = isNodeWord
    ? `        heading_level: 1
        page_break_before: true
        data: >
          Exact content: section title, paragraph topics, KPI names from requirements,
          realistic fictional values, tone notes.
        table:
          columns: [Col1, Col2, Col3]
          rows: 12
          column_widths: [3120, 3120, 3120]
        formatting: H1 size 32, body size 24, spacing after 200, cell margins 80/120
        connects_to: references setup() keys and prior section themes`
    : isExcel
      ? `        data: >
          Sheet name, exact column headers, row count, sample value ranges, formulas.
        formatting: currency/percent formats, header bold, freeze panes if needed
        connects_to: references prior sheets or setup config keys`
      : `        data: >
          Exact content, counts, column names, value ranges from requirements.
        formatting: styles, colors, layout rules
        connects_to: how this step links to setup or prior steps`;

  return `You are an expert software architect creating a DETAILED execution blueprint.
Your plan must be so precise that a weak LLM can implement each step WITHOUT seeing the original user prompt.
${skills}

TASK:
  type: ${task.label}
  output: ${task.outputFile}
  language: ${lang} (${task.language})
  library: ${task.preferredLibrary}
  complexity: ${task.complexity}
  volume: ${formatVolume(task)}
  requirements:
${(task.requirements || []).map(r => `    - ${r}`).join('\n') || `    - ${task.refinedMessage || task.rawMessage}`}
  data: ${task.dataDescription || task.refinedMessage || task.rawMessage}

AVAILABLE LIBRARIES: ${libs.join(', ')}
${nodeWordRules}${excelRules}

PLAN RULES:
- Generate ${stepMin} to ${stepMax} steps. Each step is ONE ${lang} function.
- Step 1 MUST be setup: shared config/constants. Returns a config object.
- CRITICAL: Create ONE step for EACH section/sheet in requirements. Do NOT merge, skip, or combine sections.
- Each step ≤ 120 lines of code. If a section is large, split into sub-section steps but keep all required content.
- Every step needs a PRECISE contract: function name, return type, data shape.
- content_spec is the PRIMARY instruction for codegen — put ALL detail there (exact KPI names, column headers, paragraph counts, topics).
- Do NOT use example fields with code snippets — use content_spec instead.
- For tables: specify exact column names, row counts, and column_widths summing to 9360 (word) or sheet layout (excel).
- For word docs: cover page gets page_break_before false; each major section after cover gets page_break_before true.
- Use heading_level 1 for major sections, 2 for subsections.
- Steps must be independently testable — no side effects except the final save.
- NAMING: step names MUST NOT contain "assemble", "assembly", "save", "pack", "final" unless it is the actual last save step.
- All content steps MUST depend on step 1 (setup). Set depends_on: [1].
${task.language !== 'node' || task.type !== 'word'
    ? `- The LAST step MUST assemble everything and save to /workspace/${task.outputFile}`
    : ''}

Return ONLY YAML. No markdown fences. No explanation before or after.

plan:
  language: ${task.language}
  library: ${task.preferredLibrary}
  output_file: ${task.outputFile}
  steps:
    - step: 1
      name: setup
      function_name: setup
      description: Shared config, constants, and metadata used by all sections
      content_spec:
        data: >
          List every config key other steps need: titles, dates, region lists,
          product names, KPI labels, section titles — copy exact names from requirements.
      returns:
        type: object
        shape: "{ key: type, key2: type }"
      lines_budget: 40
      depends_on: []
    - step: 2
      name: descriptive_section_name
      function_name: buildSectionName
      description: One-line summary of this section's purpose
      content_spec:
${contentSpecExample}
      returns:
        type: array
        shape: "array of docx block elements or sheet data per task type"
      lines_budget: 80
      depends_on: [1]`;
}

// ─── CODE GENERATION PROMPT ──────────────────────────────────────────────────
function buildCodeGenPrompt(task, plan, currentStep, verifiedFunctions, lastError = null) {
  const libs = availableLibraries[task.language] || [];
  const isLastStep = currentStep.step === plan.steps[plan.steps.length - 1].step;

  let functionsContext = '';
  if (verifiedFunctions.length > 0) {
    functionsContext = '\nVERIFIED FUNCTIONS (already defined — do NOT rewrite):';
    verifiedFunctions.forEach(fn => {
      const returnInfo = fn.returns
        ? (typeof fn.returns === 'object'
          ? ` -> ${fn.returns.type || 'unknown'}: ${fn.returns.shape || ''}`
          : ` -> ${fn.returns}`)
        : '';
      functionsContext += `\n  ${fn.functionName}()${returnInfo}`;
    });
    // Expose the actual setup() return shape so content functions don't try to destructure
    // properties that don't exist and cause runtime crashes
    const setupFn = verifiedFunctions.find(f => (f.functionName || f.function_name) === 'setup');
    if (setupFn?.returns && typeof setupFn.returns === 'object' && setupFn.returns.shape) {
      functionsContext += `\n  setup() returns exactly: ${setupFn.returns.shape}`;
    }
    functionsContext += '\n';
  }

  const errorContext = lastError
    ? `\nPREVIOUS ATTEMPT FAILED:\n${lastError}\nFix the issue. Do not repeat the mistake.\n`
    : '';

  const nodeWord = task.language === 'node' && task.type === 'word';
  const isSetup = nodeWord && /setup|imports|constants|config/i.test(`${currentStep.name} ${currentStep.function_name || currentStep.functionName}`);
  // codegen phase now uses targeted sections (Tables, Lists, Critical rules) — not full skill
  const skillPhase = nodeWord ? (isSetup ? 'setup' : 'codegen') : (isLastStep ? 'assembly' : 'codegen');
  const skills = skillBlockForTask(task, skillPhase);

  const stepName = currentStep.function_name || currentStep.functionName;
  const stepReturns = currentStep.returns;
  const returnSpec = stepReturns
    ? (typeof stepReturns === 'object'
      ? `Returns: ${stepReturns.type || 'unknown'}\n  Shape: ${stepReturns.shape || 'unspecified'}`
      : `Returns: ${stepReturns}`)
    : 'Returns: see description';

  const linesBudget = currentStep.lines_budget || currentStep.linesBudget || 120;
  const deps = (currentStep.depends_on || currentStep.dependsOn || []);
  const requirementsBlock = formatRequirementsForCodegen(task, 600);
  const contentSpecBlock = formatContentSpec(currentStep);
  const contentSpecSection = contentSpecBlock
    ? `\nCONTENT SPEC (follow exactly — primary instruction):\n${contentSpecBlock}\n`
    : '';

  const wordFormattingBlock = nodeWord && !isSetup
    ? `
FORMATTING (apply consistently):
- Title text: size 52 (26pt), bold, centered
- Section headings: HeadingLevel.HEADING_1, TextRun size 32 (16pt), bold
- Subsection headings: HeadingLevel.HEADING_2, TextRun size 28 (14pt)
- Body text: TextRun size 24 (12pt)
- Paragraph spacing: spacing: { after: 200 } for body; { after: 400 } after section headings
- Page break: if content_spec.page_break_before is true, start with new Paragraph({ pageBreakBefore: true, children: [] })
- Tables: width 9360 DXA; columnWidths MUST sum to 9360; cell margins { top: 80, bottom: 80, left: 120, right: 120 }
- Header row shading: fill D5E8F0, ShadingType.CLEAR; borders BorderStyle.SINGLE color CCCCCC
`
    : '';

  return `You are an expert ${task.language} developer. Write EXACTLY one function.
${skills}
TASK: ${task.label}
REQUIREMENTS:
${requirementsBlock}
OUTPUT: /workspace/${task.outputFile}
LIBS: ${libs.join(', ')}
${functionsContext}${errorContext}

CURRENT STEP ${currentStep.step}: "${currentStep.name}"
  Function: ${stepName}()
  ${currentStep.description}
  ${returnSpec}
  Lines budget: ~${linesBudget} lines (do not exceed significantly)
  Depends on: ${deps.length ? deps.map(d => {
    const dep = plan.steps.find(s => s.step === d);
    return dep ? `${dep.function_name || dep.functionName}()` : `step ${d}`;
  }).join(', ') : 'nothing'}
${contentSpecSection}${wordFormattingBlock}
${nodeWord && isSetup ? `SETUP STEP: Return a plain config object only.
- NO require, import, Document, Packer, Paragraph, Table, or fs
- Plain strings/numbers/arrays only
- Other steps will call ${stepName}() to get this config
` : nodeWord ? `CONTENT STEP for docx:
- Return an array of block elements: [new Paragraph(...), new Table(...), ...]
- NO require, Document, Packer, or fs — imports provided by runner
- You MAY call setup() ONLY for scalar config values: title, company name, date, confidentiality text.
- NEVER loop, map, or forEach over anything returned by setup(). setup() returns scalars only.
- ALL section content (KPIs, metrics, paragraphs, table rows, list items) MUST be written as hardcoded inline arrays/objects inside this function, not derived from setup().
- Wrong pattern: "const { kpis } = setup(); kpis.forEach(...)" — setup() does not return arrays.
- Correct: hardcode content arrays inside this function: const kpis = [{ name: 'ARR', value: '...' }, ...]

CRITICAL DOCX RULES (violations = instant rejection):
- NEVER mutate after construction: table.rows.push(), .children.push(), .cells.push() are FORBIDDEN
- Build ALL rows inside new Table({ rows: [new TableRow({ children: [...] }), ...] })
- Build ALL cells inside new TableRow({ children: [new TableCell({ children: [...] }), ...] })
- Build ALL content inside constructors, never push/splice/append after creation
- numbering.config belongs on Document, NOT on Paragraph — only use { numbering: { reference, level } } on Paragraph
- Use WidthType.DXA, not WidthType.PERCENTAGE
- shading goes on TableCell, NEVER on TableRow
` : isLastStep ? `FINAL STEP: You MUST:
1. Call all previous verified functions
2. Assemble the complete output
3. Save to /workspace/${task.outputFile}
4. Print "SUCCESS: saved /workspace/${task.outputFile}"
` : `INTERMEDIATE STEP: Do NOT save the file. Return the data as specified.
`}

RULES:
- Write ONLY the function ${stepName} — no imports unless ${task.language === 'python' ? 'needed at the top' : 'this is not a node word step'}
- Follow the return type/shape contract EXACTLY
- Use realistic data, not placeholders
- Keep within ~${linesBudget} lines
- Do NOT use libraries not in the available list
- Code must be complete and correct — it runs immediately
- Your code WILL be executed in a runtime probe. If it throws, it will be rejected and you must retry.

Return ONLY raw ${task.language === 'node' ? 'JavaScript' : 'Python'} code. No markdown. No backticks. No explanation.`;
}

// ─── RETRY PROMPT ────────────────────────────────────────────────────────────
function buildRetryPrompt(task, plan, currentStep, verifiedFunctions, error, attemptNum) {
  const base = buildCodeGenPrompt(task, plan, currentStep, verifiedFunctions, error);
  return `${base}

RETRY ${attemptNum}: The previous attempt failed. Read the error carefully and fix it.
Do not repeat the same mistake. Return ONLY raw code.`;
}

// ─── VALIDATION FEEDBACK PROMPT ──────────────────────────────────────────────
function buildValidationFixPrompt(task, plan, currentStep, verifiedFunctions, validationResult) {
  const base = buildCodeGenPrompt(task, plan, currentStep, verifiedFunctions);
  const details = typeof validationResult === 'object'
    ? JSON.stringify(validationResult, null, 2)
    : String(validationResult);

  return `${base}

VALIDATION FAILED (code ran but output was wrong):
${details}

Fix the code to meet requirements. Return ONLY raw code.`;
}

// ─── SECTION RENDERING PROMPTS (V2 Word) ─────────────────────────────────────
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

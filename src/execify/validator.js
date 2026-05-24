// src/execify/validator.js
// Validates execution output — not just "did it run" but "is the output correct"

const { TASK_TYPES } = require('../tasks/taskTypes');
const logger = require('../utils/logger');
const JSZip = require('jszip');

// Validate an execution result against the task requirements
async function validateResult(execResult, task, currentStep, blueprint = null) {
  const { success, stdout, stderr, outputFiles, errorType, retryable } = execResult;
  const isLastStep = currentStep.isLast;

  // Basic execution failure
  if (!success) {
    return {
      valid: false,
      type: 'execution_error',
      errorType: errorType || 'runtime_error',
      retryable: retryable !== false,
      message: stderr || 'Execution failed with no error message',
    };
  }

  // For intermediate steps — just check it ran successfully
  if (!isLastStep) {
    return {
      valid: true,
      type: 'intermediate_ok',
      message: stdout || 'Step completed successfully',
    };
  }

  // For the final step — check the output file
  return await validateOutputFile(outputFiles, task, stdout, blueprint);
}

async function validateOutputFile(outputFiles, task, stdout, blueprint) {
  const taskDef = TASK_TYPES[task.type];
  if (!taskDef) {
    return { valid: true, type: 'unknown_type', message: 'Unknown task type, skipping file validation' };
  }

  const expectedExt = taskDef.defaultExtension;
  const minSize = taskDef.validation.minSizeBytes;

  // Check if any output file was returned
  if (!outputFiles || outputFiles.length === 0) {
    return {
      valid: false,
      type: 'validation_error',
      errorType: 'runtime_error',
      retryable: true,
      message: `No output file was created. Expected a ${expectedExt} file in /workspace/. Make sure your code saves the file to /workspace/${task.outputFile}`,
    };
  }

  // Find the expected file
  const outputFile = outputFiles.find(f =>
    f.name.endsWith(expectedExt) || f.name === task.outputFile
  ) || outputFiles[0];

  // Check file size
  const fileSize = outputFile.size || (outputFile.data ? Buffer.from(outputFile.data, 'base64').length : 0);

  if (fileSize < minSize) {
    return {
      valid: false,
      type: 'validation_error',
      errorType: 'runtime_error',
      retryable: true,
      message: `Output file is too small (${fileSize} bytes, minimum ${minSize} bytes). The file may be empty or incomplete.`,
    };
  }

  // Check stdout for success message
  const hasSuccessMsg = stdout && stdout.toLowerCase().includes('success');

  // Type-specific checks
  const typeChecks = runTypeChecks(task, outputFile, stdout);
  if (!typeChecks.valid) return typeChecks;

  // Structural validation for Word documents (blueprint-driven)
  if (task.type === 'word' && blueprint && outputFile.data) {
    const buffer = Buffer.from(outputFile.data, 'base64');
    const structural = await validateStructure(buffer, blueprint);
    if (!structural.valid) {
      return {
        valid: false,
        type: 'validation_error',
        errorType: 'structure_mismatch',
        retryable: true,
        message: structural.message,
        details: structural.details,
      };
    }
  }

  logger.info('Validator', `File validated: ${outputFile.name} (${fileSize} bytes)`);

  return {
    valid: true,
    type: 'output_ok',
    file: outputFile,
    fileSize,
    message: `File generated successfully: ${outputFile.name} (${fileSize} bytes)`,
  };
}

function runTypeChecks(task, outputFile, stdout) {
  // Excel — check for row count if specified
  if (task.type === 'excel' && task.estimatedRows) {
    const rowMatch = stdout && stdout.match(/(\d+)\s*rows?/i);
    if (rowMatch) {
      const actualRows = parseInt(rowMatch[1]);
      const expectedRows = parseInt(task.estimatedRows);
      const tolerance = 0.1; // 10% tolerance
      if (actualRows < expectedRows * (1 - tolerance)) {
        return {
          valid: false,
          type: 'validation_error',
          errorType: 'runtime_error',
          retryable: true,
          message: `Row count mismatch: expected ~${expectedRows} rows but got ${actualRows}. Generate the full dataset.`,
        };
      }
    }
  }

  // Word — check for page count if specified
  if (task.type === 'word' && task.estimatedPages) {
    // Can't easily check page count from base64 without parsing docx
    // Future: implement docx page count check
  }

  return { valid: true };
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function extractDocumentXml(buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const entry = zip.file('word/document.xml');
    if (!entry) return null;
    return await entry.async('string');
  } catch {
    return null;
  }
}

function countParagraphs(xml) {
  return (xml.match(/<w:p[\s>]/g) || []).length;
}

function countTables(xml) {
  return (xml.match(/<w:tbl[\s>]/g) || []).length;
}

function countListItems(xml) {
  const numPr = (xml.match(/<w:numPr[\s>]/g) || []).length;
  const listStyle = (xml.match(/w:pStyle[^>]*w:val="ListParagraph"/g) || []).length;
  return Math.max(numPr, listStyle);
}

function extractHeadings(xml) {
  const headings = [];
  const paragraphRegex = /<w:p[\s\S]*?<\/w:p>/g;
  let match;
  while ((match = paragraphRegex.exec(xml)) !== null) {
    const para = match[0];
    const styleMatch = para.match(/<w:pStyle[^>]*w:val="([^"]+)"/);
    if (!styleMatch) continue;
    const style = styleMatch[1];
    let level = null;
    if (style === 'Heading1' || style === 'Heading 1') level = 1;
    if (style === 'Heading2' || style === 'Heading 2') level = 2;
    if (!level) continue;

    const textMatches = [...para.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)];
    const text = normalizeText(textMatches.map(m => decodeXmlEntities(m[1])).join(''));
    if (text) headings.push({ text, level });
  }
  return headings;
}

async function validateStructure(buffer, blueprint) {
  const xml = await extractDocumentXml(buffer);
  if (!xml) {
    return {
      valid: false,
      message: 'Structural validation failed: unable to read document.xml from docx.',
      details: { parseError: true },
    };
  }

  const paragraphCount = countParagraphs(xml);
  const tableCount = countTables(xml);
  const listCount = countListItems(xml);
  const headings = extractHeadings(xml);
  const foundHeadings = headings.map(h => normalizeText(h.text)).filter(Boolean);

  const expectedHeadings = (blueprint?.sections || [])
    .filter(s => s.type === 'heading1' || s.type === 'heading2')
    .map(s => normalizeText(s.text))
    .filter(Boolean);

  const expectedParagraphs = (blueprint?.sections || []).length;

  const expectedTables = (blueprint?.sections || []).filter(s => s.type === 'table').length;
  const expectedLists = (blueprint?.sections || []).filter(s => s.type === 'list' || s.type === 'nested_list').length;

  const foundHeadingSet = new Set(foundHeadings.map(h => h.toLowerCase()));
  const missingHeadings = expectedHeadings.filter(h => !foundHeadingSet.has(h.toLowerCase()));
  const headingMatchRatio = expectedHeadings.length
    ? (expectedHeadings.length - missingHeadings.length) / expectedHeadings.length
    : 1;

  const paragraphMin = Math.floor(expectedParagraphs * 0.8);
  const paragraphOk = expectedParagraphs === 0
    ? true
    : paragraphCount >= paragraphMin;

  const issues = [];
  if (expectedTables > 0 && tableCount < expectedTables) {
    issues.push(`- Expected ${expectedTables} tables (from blueprint), found ${tableCount}`);
  }
  if (expectedLists > 0 && listCount < expectedLists) {
    issues.push(`- Expected ${expectedLists} list sections (from blueprint), found ${listCount}`);
  }
  if (expectedHeadings.length > 0 && headingMatchRatio < 0.8) {
    issues.push(`- Expected headings: ${JSON.stringify(expectedHeadings)}\n  Found headings: ${JSON.stringify(foundHeadings)}`);
  }
  if (!paragraphOk) {
    issues.push(`- Paragraph count: expected ~${expectedParagraphs}, found ${paragraphCount}`);
  }

  if (issues.length > 0) {
    return {
      valid: false,
      message: `Structural validation failed:\n${issues.join('\n')}`,
      details: {
        expectedTables,
        foundTables: tableCount,
        expectedLists,
        foundLists: listCount,
        expectedHeadings,
        foundHeadings,
        missingHeadings,
        expectedParagraphs,
        foundParagraphs: paragraphCount,
      },
    };
  }

  return { valid: true, details: { paragraphCount, tableCount, listCount } };
}

// Parse error from execution result into a clean message for LLM
function formatErrorForLLM(execResult) {
  const { stderr, stdout, errorType } = execResult;

  let error = stderr || 'Unknown execution error';

  // Trim very long tracebacks — keep last 30 lines which has the actual error
  const lines = error.split('\n');
  if (lines.length > 30) {
    error = '...(truncated)\n' + lines.slice(-30).join('\n');
  }

  return `Error type: ${errorType || 'runtime_error'}\n${error}`;
}

module.exports = { validateResult, formatErrorForLLM, validateStructure };

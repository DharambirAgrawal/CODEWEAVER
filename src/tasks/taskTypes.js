// src/tasks/taskTypes.js
// Defines known output types, their libraries, validation rules, and file extensions

const TASK_TYPES = {
  excel: {
    label: 'Excel Spreadsheet',
    extensions: ['.xlsx', '.xls'],
    defaultExtension: '.xlsx',
    language: 'python',
    testLanguage: 'python',
    productionLanguage: 'python',
    libraries: ['openpyxl', 'pandas', 'xlsxwriter', 'xlsx'],
    preferredLibrary: 'openpyxl',
    testLibrary: 'openpyxl',
    productionLibrary: 'openpyxl',
    validation: {
      minSizeBytes: 1000,
      checks: ['file_exists', 'file_size', 'row_count'],
    },
  },
  word: {
    label: 'Word Document',
    extensions: ['.docx'],
    defaultExtension: '.docx',
    language: 'python',
    testLanguage: 'node',
    productionLanguage: 'python',
    libraries: ['python-docx', 'docx'],
    preferredLibrary: 'python-docx',
    testLibrary: 'docx',
    productionLibrary: 'python-docx',
    validation: {
      minSizeBytes: 2000,
      checks: ['file_exists', 'file_size'],
    },
  },
  pdf: {
    label: 'PDF Document',
    extensions: ['.pdf'],
    defaultExtension: '.pdf',
    language: 'python',
    testLanguage: 'python',
    productionLanguage: 'python',
    libraries: ['reportlab', 'fpdf2'],
    preferredLibrary: 'reportlab',
    validation: {
      minSizeBytes: 1000,
      checks: ['file_exists', 'file_size'],
    },
  },
  csv: {
    label: 'CSV File',
    extensions: ['.csv'],
    defaultExtension: '.csv',
    language: 'python',
    testLanguage: 'python',
    productionLanguage: 'python',
    libraries: ['csv', 'pandas'],
    preferredLibrary: 'csv',
    validation: {
      minSizeBytes: 100,
      checks: ['file_exists', 'file_size', 'row_count'],
    },
  },
  text: {
    label: 'Text File',
    extensions: ['.txt', '.md'],
    defaultExtension: '.txt',
    language: 'python',
    testLanguage: 'python',
    productionLanguage: 'python',
    libraries: [],
    preferredLibrary: null,
    validation: {
      minSizeBytes: 10,
      checks: ['file_exists', 'file_size'],
    },
  },
  chart: {
    label: 'Chart / Image',
    extensions: ['.png', '.jpg'],
    defaultExtension: '.png',
    language: 'python',
    testLanguage: 'python',
    productionLanguage: 'python',
    libraries: ['matplotlib', 'seaborn', 'plotly'],
    preferredLibrary: 'matplotlib',
    validation: {
      minSizeBytes: 5000,
      checks: ['file_exists', 'file_size'],
    },
  },
};

// Detect task type from user message keywords
function detectTaskType(message) {
  const lower = message.toLowerCase();

  if (/excel|xlsx|spreadsheet|worksheet|workbook/.test(lower)) return 'excel';
  if (/word|docx|document|report|letter|doc/.test(lower)) return 'word';
  if (/pdf/.test(lower)) return 'pdf';
  if (/csv|comma.separated/.test(lower)) return 'csv';
  if (/chart|graph|plot|visualization|diagram/.test(lower)) return 'chart';
  if (/text|txt|plain/.test(lower)) return 'text';

  // Default to word doc for generic "create a report/file" requests
  return 'word';
}

// Estimate complexity from message
function estimateComplexity(message) {
  const lower = message.toLowerCase();

  // High complexity signals
  if (
    /1000|thousands|many pages|10 page|20 page|complex|detailed|comprehensive/.test(lower) ||
    /multiple sheets|multiple sections|table of contents|charts and/.test(lower)
  ) return 'high';

  // Low complexity signals
  if (
    /simple|basic|quick|small|short|just a/.test(lower) ||
    /one page|single page|few rows/.test(lower)
  ) return 'low';

  return 'medium';
}

// Estimate number of chunks needed based on complexity
function estimateChunks(complexity) {
  return { low: 2, medium: 3, high: 5 }[complexity] || 3;
}

/**
 * Pick language/library for the execution environment.
 * @param {object} task - parsed task
 * @param {'production'|'local'|'test'} runtime
 */
function resolveRuntimeTask(task, runtime = 'production') {
  const taskDef = TASK_TYPES[task.type];
  if (!taskDef) return task;

  const useTestRuntime = runtime === 'local' || runtime === 'test';
  const language = useTestRuntime
    ? (taskDef.testLanguage || taskDef.language || task.language)
    : (taskDef.productionLanguage || taskDef.language || task.language);
  const preferredLibrary = useTestRuntime
    ? (taskDef.testLibrary || taskDef.preferredLibrary || task.preferredLibrary)
    : (taskDef.productionLibrary || taskDef.preferredLibrary || task.preferredLibrary);

  return { ...task, language, preferredLibrary };
}

module.exports = {
  TASK_TYPES,
  detectTaskType,
  estimateComplexity,
  estimateChunks,
  resolveRuntimeTask,
};

// src/config.js
// Centralized configuration — no more hardcoded constants scattered across files.

const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '5', 10);
const MAX_CHUNKS = parseInt(process.env.MAX_CHUNKS || '10', 10);
const CHUNK_TIMEOUT_MS = parseInt(process.env.CHUNK_TIMEOUT_MS || '30000', 10);

const DOCX_SECTION_IMPORTS = [
  'Document',
  'Paragraph',
  'TextRun',
  'Table',
  'TableRow',
  'TableCell',
  'HeadingLevel',
  'AlignmentType',
  'BorderStyle',
  'WidthType',
];

const DOCX_PLANNED_IMPORTS = [
  ...DOCX_SECTION_IMPORTS,
  'Packer',
  'ShadingType',
  'LevelFormat',
  'PageBreak',
];

const DEFAULT_LIBRARIES = {
  python: ['openpyxl', 'pandas', 'python-docx', 'reportlab', 'fpdf2', 'matplotlib', 'seaborn', 'csv', 'json', 'os', 'pathlib'],
  node: ['fs', 'path', 'xlsx', 'docx'],
};

module.exports = {
  MAX_RETRIES,
  MAX_CHUNKS,
  CHUNK_TIMEOUT_MS,
  DOCX_SECTION_IMPORTS,
  DOCX_PLANNED_IMPORTS,
  DEFAULT_LIBRARIES,
};

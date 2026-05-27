// src/content/extractor.js
// Extracts structured content from the user request before any planning or codegen.

const { parseJsonFromLlm } = require('../utils/jsonExtract');
const logger = require('../utils/logger');

const SECTION_TYPES = new Set(['paragraphs', 'paragraph', 'table', 'list', 'nested_list']);

function buildContentExtractionPrompt(task, message) {
  const requirements = Array.isArray(task.requirements) && task.requirements.length
    ? task.requirements.join(', ')
    : task.refinedMessage || task.rawMessage || message;
  const sectionHints = Array.isArray(task.sections) && task.sections.length
    ? `\nUser mentioned sections: ${task.sections.join(', ')}`
    : '';

  return `You are a content extraction assistant for a document generator.

USER REQUEST:
"""
${message}
"""

Task details:
- Document type: ${task.label}
- Requirements: ${requirements}
${sectionHints}

Return ONLY valid JSON, no markdown, no explanation.

Your job:
- Extract the content that should appear in the document.
- Do NOT write code.
- Do NOT decide formatting beyond the content type per section.
- If the user input is sparse, generate realistic, plausible content consistent with the request.

Return this exact structure:
{
  "title": "Document title",
  "sections": [
    {
      "id": "exec_summary",
      "heading": "Executive Summary",
      "type": "paragraphs",
      "content": ["Paragraph 1", "Paragraph 2"]
    },
    {
      "id": "financials",
      "heading": "Financial Highlights",
      "type": "table",
      "content": {
        "headers": ["Quarter", "Revenue"],
        "rows": [["Q1 2024", "$3.8M"], ["Q2 2024", "$4.0M"]]
      }
    },
    {
      "id": "risks",
      "heading": "Key Risks & Mitigations",
      "type": "list",
      "content": ["Risk 1 - Mitigation", "Risk 2 - Mitigation"]
    }
  ]
}

Rules:
- Use snake_case for section ids.
- "type" must be one of: paragraphs, table, list, nested_list.
- paragraphs: content is an array of paragraph strings.
- table: content has headers (array) and rows (array of arrays).
- list: content is an array of strings.
- nested_list: content is an array of { "title": string, "items": [string, ...] }.
`;
}

function toSnakeId(value, fallback) {
  const base = String(value || '').trim().toLowerCase();
  const cleaned = base.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function normalizeSection(section, index) {
  const normalized = { ...section };
  const fallbackId = `section_${index + 1}`;
  normalized.id = toSnakeId(normalized.id || normalized.heading, fallbackId);
  normalized.heading = String(normalized.heading || '').trim();

  let type = normalized.type;
  if (!SECTION_TYPES.has(type)) type = null;

  if (!type) {
    const content = normalized.content;
    if (content && typeof content === 'object' && content.headers && content.rows) {
      type = 'table';
    } else if (Array.isArray(content)) {
      if (content.length === 0) type = 'paragraphs';
      else if (typeof content[0] === 'string') type = 'list';
      else type = 'nested_list';
    } else {
      type = 'paragraphs';
    }
  }

  normalized.type = type;

  if (type === 'paragraph' || type === 'paragraphs') {
    const raw = normalized.content;
    if (typeof raw === 'string') normalized.content = [raw];
    if (!Array.isArray(normalized.content)) normalized.content = [];
    normalized.type = 'paragraphs';
  }

  if (type === 'list') {
    const items = Array.isArray(normalized.content) ? normalized.content : [];
    normalized.content = items.map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const risk = String(item.risk || item.title || '').trim();
        const mitigation = String(item.mitigation || item.detail || '').trim();
        if (risk && mitigation) return `${risk} - ${mitigation}`;
        if (risk) return risk;
      }
      return String(item || '').trim();
    }).filter(Boolean);
  }

  if (type === 'nested_list') {
    const items = Array.isArray(normalized.content) ? normalized.content : [];
    normalized.content = items.map(item => ({
      title: String(item?.title || item?.heading || '').trim(),
      items: Array.isArray(item?.items) ? item.items.map(v => String(v || '').trim()).filter(Boolean) : [],
    }));
  }

  if (type === 'table') {
    const content = normalized.content && typeof normalized.content === 'object' ? normalized.content : {};
    const headers = Array.isArray(content.headers) ? content.headers.map(v => String(v || '').trim()) : [];
    const rows = Array.isArray(content.rows)
      ? content.rows.map(row => Array.isArray(row) ? row.map(v => String(v || '').trim()) : [])
      : [];
    normalized.content = { headers, rows };
  }

  return normalized;
}

function normalizeContent(raw, task) {
  const title = String(raw?.title || task?.dataDescription || task?.refinedMessage || task?.rawMessage || 'Untitled Document').trim();
  const sections = Array.isArray(raw?.sections) ? raw.sections : [];

  return {
    title,
    sections: sections.map(normalizeSection),
  };
}

async function extractContent({ message, task, complete }) {
  const prompt = buildContentExtractionPrompt(task, message);

  try {
    const raw = await complete(prompt, {
      maxTokens: 2000,
      jsonObject: true,
      temperature: 0.2,
    });

    const parsed = parseJsonFromLlm(raw);
    if (!parsed.ok) throw new Error(parsed.error);

    return normalizeContent(parsed.value, task);
  } catch (err) {
    logger.warn('ContentExtractor', 'LLM content extraction failed, using fallback', err.message);
    return {
      title: String(task?.dataDescription || task?.refinedMessage || task?.rawMessage || 'Untitled Document').trim(),
      sections: [
        {
          id: 'overview',
          heading: 'Overview',
          type: 'paragraphs',
          content: [String(task?.refinedMessage || task?.rawMessage || message || '').trim()].filter(Boolean),
        },
      ],
    };
  }
}

module.exports = { extractContent };

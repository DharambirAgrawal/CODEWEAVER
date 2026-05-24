// src/content/blueprint.js
// Builds a deterministic blueprint from extracted content.

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sanitizeId(value, fallback) {
  const base = normalizeText(value).toLowerCase();
  const cleaned = base.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function uniqueId(baseId, used) {
  let id = baseId;
  let counter = 2;
  while (used.has(id)) {
    id = `${baseId}_${counter}`;
    counter++;
  }
  used.add(id);
  return id;
}

function coerceListItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map(item => {
    if (typeof item === 'string') return normalizeText(item);
    if (item && typeof item === 'object') {
      const risk = normalizeText(item.risk || item.title || '');
      const mitigation = normalizeText(item.mitigation || item.detail || '');
      if (risk && mitigation) return `${risk} - ${mitigation}`;
      if (risk) return risk;
    }
    return normalizeText(item);
  }).filter(Boolean);
}

function buildBlueprint(content, options = {}) {
  const used = new Set();
  const sections = [];

  const outputFile = options.outputFile || 'output.docx';
  const language = options.language || 'node';
  const library = options.library || (language === 'python' ? 'python-docx' : 'docx');

  const titleText = normalizeText(content?.title || 'Untitled Document');
  if (titleText) {
    sections.push({
      id: uniqueId('title', used),
      type: 'title',
      text: titleText,
    });
  }

  const sourceSections = Array.isArray(content?.sections) ? content.sections : [];

  sourceSections.forEach((section, index) => {
    const baseId = sanitizeId(section?.id || section?.heading, `section_${index + 1}`);
    const headingText = normalizeText(section?.heading || `Section ${index + 1}`);
    const contentType = section?.type || 'paragraphs';

    const headingId = uniqueId(`${baseId}_heading`, used);
    sections.push({
      id: headingId,
      type: 'heading1',
      text: headingText,
    });

    if (contentType === 'table') {
      const headers = Array.isArray(section?.content?.headers)
        ? section.content.headers.map(normalizeText)
        : [];
      const rows = Array.isArray(section?.content?.rows)
        ? section.content.rows.map(row => Array.isArray(row) ? row.map(normalizeText) : [])
        : [];

      sections.push({
        id: uniqueId(`${baseId}_table`, used),
        type: 'table',
        headers,
        rows,
      });
      return;
    }

    if (contentType === 'list') {
      sections.push({
        id: uniqueId(`${baseId}_list`, used),
        type: 'list',
        items: coerceListItems(section?.content),
      });
      return;
    }

    if (contentType === 'nested_list') {
      const items = Array.isArray(section?.content)
        ? section.content.map(item => ({
          title: normalizeText(item?.title || item?.heading || ''),
          items: Array.isArray(item?.items) ? item.items.map(normalizeText) : [],
        }))
        : [];

      sections.push({
        id: uniqueId(`${baseId}_nested_list`, used),
        type: 'nested_list',
        items,
      });
      return;
    }

    const paragraphs = Array.isArray(section?.content)
      ? section.content.map(normalizeText)
      : [normalizeText(section?.content)];

    paragraphs.filter(Boolean).forEach((paragraph, i) => {
      sections.push({
        id: uniqueId(`${baseId}_para_${i + 1}`, used),
        type: 'paragraph',
        text: paragraph,
      });
    });
  });

  return {
    outputFile,
    language,
    library,
    sections,
  };
}

module.exports = { buildBlueprint };

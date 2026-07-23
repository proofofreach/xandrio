const DEFAULT_REPEATED_LINE_MIN_PAGES = 3;

function emptyDiagnostics() {
  return {
    hyphenJoins: 0,
    spacedCapsFixes: 0,
    pageNumberLinesRemoved: 0,
    repeatedHeaderFooterLinesRemoved: 0,
    paragraphLineJoins: 0,
    ligatureFixes: 0,
    whitespaceFixes: 0,
    ocrRepairsApplied: 0,
    ocrRepairCandidatesSkipped: 0,
    ocrRepairExamples: []
  };
}

function addDiagnostics(target, source) {
  for (const key of Object.keys(emptyDiagnostics())) {
    if (Array.isArray(target[key])) {
      target[key].push(...(source?.[key] || []));
      target[key] = target[key].slice(0, 20);
    } else {
      target[key] += source?.[key] || 0;
    }
  }
  return target;
}

function normalizeLineEndings(text, diagnostics) {
  let result = String(text || '');
  const before = result;
  result = result
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\t/g, ' ');
  if (result !== before) diagnostics.whitespaceFixes++;
  return result;
}

function normalizeLigatures(text, diagnostics) {
  const before = text;
  const result = text
    .replace(/\ufb00/g, 'ff')
    .replace(/\ufb01/g, 'fi')
    .replace(/\ufb02/g, 'fl')
    .replace(/\ufb03/g, 'ffi')
    .replace(/\ufb04/g, 'ffl')
    .replace(/\ufb05/g, 'st')
    .replace(/\ufb06/g, 'st');
  if (result !== before) {
    diagnostics.ligatureFixes += countChangedChars(before, result);
  }
  return result;
}

function countChangedChars(before, after) {
  return Math.max(1, Math.abs(String(before).length - String(after).length));
}

function removePageNumberLines(text, diagnostics) {
  return text.split('\n').filter(line => {
    if (/^\s*(?:page\s*)?\d{1,5}\s*$/i.test(line) ||
        /^\s*(?:page\s*)?\d{1,5}\s+(?:of|\/)\s+\d{1,5}\s*$/i.test(line) ||
        /^\s*[-–—]?\s*\d{1,5}\s*[-–—]\s*$/.test(line)) {
      diagnostics.pageNumberLinesRemoved++;
      return false;
    }
    return true;
  }).join('\n');
}

function normalizeRepeatedLine(line) {
  return String(line || '')
    .trim()
    .replace(/\b\d{1,5}\b/g, '#')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function findRepeatedHeaderFooterLines(pages, options = {}) {
  const minPages = options.minPages || DEFAULT_REPEATED_LINE_MIN_PAGES;
  const counts = new Map();

  for (const page of pages) {
    const lines = String(page.text || '').split('\n').map(line => line.trim()).filter(Boolean);
    const candidates = [
      ...lines.slice(0, 4),
      ...lines.slice(Math.max(0, lines.length - 4))
    ];
    const seen = new Set();
    for (const line of candidates) {
      const normalized = normalizeRepeatedLine(line);
      if (!isHeaderFooterCandidate(normalized) || seen.has(normalized)) continue;
      seen.add(normalized);
      counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }
  }

  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count >= minPages)
      .map(([line]) => line)
  );
}

function isHeaderFooterCandidate(line) {
  if (!line) return false;
  if (line.length > 80) return false;
  if (/^\d+$/.test(line)) return false;
  return /[a-z]/i.test(line);
}

function removeRepeatedHeaderFooterLines(text, repeatedLines, diagnostics) {
  if (!repeatedLines || repeatedLines.size === 0) return text;
  return text.split('\n').filter(line => {
    const normalized = normalizeRepeatedLine(line);
    if (repeatedLines.has(normalized)) {
      diagnostics.repeatedHeaderFooterLinesRemoved++;
      return false;
    }
    return true;
  }).join('\n');
}

function joinHyphenatedLineWraps(text, diagnostics) {
  return text.replace(/(\p{L}{2,})-\n(\p{Ll}{2,})/gu, (_match, left, right) => {
    diagnostics.hyphenJoins++;
    return `${left}${right}`;
  });
}

function collapseSpacedCaps(text, diagnostics) {
  return text.replace(/\b(?:[A-Z]\s+){2,}[A-Z]\b/g, match => {
    diagnostics.spacedCapsFixes++;
    return match.replace(/\s+/g, '');
  });
}

function isLikelyPdfHeadingLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.length > 120) return false;
  return /^(?:chapter\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|the\s+first)\b|(?:part|book|volume)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five)\b|(?:prologue|epilogue|preface|introduction|afterword|acknowledg(?:e)?ments?)\b)/i.test(trimmed);
}

function collapseSoftLineBreaks(text, diagnostics) {
  const paragraphs = text.split(/\n{2,}/);
  const collapsed = paragraphs.map(paragraph => {
    const lines = paragraph.split('\n');
    if (lines.length <= 1) return paragraph;
    let result = lines[0];
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1];
      const current = lines[i];
      if (isLikelyPdfHeadingLine(prev) || isLikelyPdfHeadingLine(current) || /^\s*[-*•]\s/.test(current)) {
        result += `\n${current}`;
      } else {
        diagnostics.paragraphLineJoins++;
        result += ` ${current}`;
      }
    }
    return result;
  });
  return collapsed.join('\n\n');
}

function cleanWhitespace(text, diagnostics) {
  const before = text;
  const result = text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([([{])\s+/g, '$1')
    .replace(/\s+([)\]}])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (result !== before) diagnostics.whitespaceFixes++;
  return result;
}

const OCR_REPAIR_RULES = [
  { from: '1s', to: 'is' },
  { from: 'th1s', to: 'this' },
  { from: 'w1th', to: 'with' },
  { from: 'rnay', to: 'may' },
  { from: 'sorne', to: 'some' },
  { from: 'frorn', to: 'from' },
  { from: 'hght', to: 'light' }
];

function preserveCase(replacement, original) {
  if (original.toUpperCase() === original) return replacement.toUpperCase();
  if (original[0] && /[A-Z]/.test(original[0])) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function isSafeOcrContext(text, start, end, token) {
  const before = text.slice(Math.max(0, start - 24), start);
  const after = text.slice(end, Math.min(text.length, end + 24));
  if (!/(?:^|[\s,.;:!?('"“‘-])$/.test(before)) return false;
  if (!/^(?:$|[\s,.;:!?')”’;-])/.test(after)) return false;
  if (/\d/.test(before.slice(-2)) || /\d/.test(after.slice(0, 2))) return false;

  const context = `${before} ${after}`.toLowerCase();
  if (token === 'hght') {
    return /\b(?:the|a|of|in|natural|changing|low|high|more|less|much|bright|window|room|sun|day)\b/.test(context);
  }
  return /[a-z]{2,}/i.test(before) && /[a-z]{2,}/i.test(after);
}

function repairPdfOcrText(text, diagnostics) {
  let result = String(text || '');
  for (const rule of OCR_REPAIR_RULES) {
    const pattern = new RegExp(`\\b${rule.from}\\b`, 'gi');
    result = result.replace(pattern, (match, offset, fullText) => {
      const safe = isSafeOcrContext(fullText, offset, offset + match.length, rule.from);
      if (!safe) {
        diagnostics.ocrRepairCandidatesSkipped++;
        return match;
      }
      const replacement = preserveCase(rule.to, match);
      diagnostics.ocrRepairsApplied++;
      if (diagnostics.ocrRepairExamples.length < 20) {
        diagnostics.ocrRepairExamples.push({
          from: match,
          to: replacement,
          context: fullText.slice(Math.max(0, offset - 32), Math.min(fullText.length, offset + match.length + 32)).replace(/\s+/g, ' ').trim()
        });
      }
      return replacement;
    });
  }
  return result;
}

function normalizePdfText(text, options = {}) {
  const diagnostics = emptyDiagnostics();
  let result = normalizeLineEndings(text, diagnostics);
  result = normalizeLigatures(result, diagnostics);
  result = removePageNumberLines(result, diagnostics);
  if (options.repeatedLines) {
    result = removeRepeatedHeaderFooterLines(result, options.repeatedLines, diagnostics);
  }
  result = joinHyphenatedLineWraps(result, diagnostics);
  result = collapseSpacedCaps(result, diagnostics);
  result = collapseSoftLineBreaks(result, diagnostics);
  if (options.ocrRepair !== false) {
    result = repairPdfOcrText(result, diagnostics);
  }
  result = cleanWhitespace(result, diagnostics);
  return { text: result, diagnostics };
}

function normalizePdfPages(pages, options = {}) {
  const inputPages = Array.isArray(pages) ? pages : [];
  const normalizedForRepeatDetection = inputPages.map((page, index) => ({
    pageNumber: page.pageNumber || index + 1,
    text: normalizeLineEndings(page.text || '', emptyDiagnostics())
  }));
  const repeatedLines = findRepeatedHeaderFooterLines(normalizedForRepeatDetection, options);
  const diagnostics = emptyDiagnostics();
  const normalizedPages = inputPages.map((page, index) => {
    const normalized = normalizePdfText(page.text || '', { ...options, repeatedLines });
    addDiagnostics(diagnostics, normalized.diagnostics);
    return {
      ...page,
      pageNumber: page.pageNumber || index + 1,
      rawChars: String(page.text || '').length,
      text: normalized.text
    };
  });

  return {
    pages: normalizedPages,
    diagnostics: {
      ...diagnostics,
      repeatedHeaderFooterCandidates: repeatedLines.size
    }
  };
}

module.exports = {
  normalizePdfText,
  normalizePdfPages,
  __test: {
    findRepeatedHeaderFooterLines,
    emptyDiagnostics,
    isLikelyPdfHeadingLine,
    repairPdfOcrText
  }
};

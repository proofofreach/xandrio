function calculateQualityScore(result) {
  let score = 0;
  const format = result.format.toUpperCase();

  if (format === 'EPUB') {
    score = 5.0;
  } else if (format === 'MOBI' || format === 'AZW3' || format === 'AZW' || format === 'PRC') {
    score = 4.0;
  } else if (format === 'PDF') {
    score = 1.5;
  } else {
    score = 1.0;
  }

  const sizeBytes = parseSizeToBytes(result.size);
  if (sizeBytes > 0) {
    if (sizeBytes < 100 * 1024) {
      score -= 1.0;
    } else if (sizeBytes < 500 * 1024) {
      score -= 0.5;
    }
  }

  const hasGoodMetadata = result.title &&
    result.author && result.author !== 'Unknown' &&
    result.publisher && result.publisher !== '';
  if (hasGoodMetadata) {
    score += 0.5;
  }

  const yearMatch = result.publisher && result.publisher.match(/20\d{2}|19\d{2}/);
  if (yearMatch) {
    const year = parseInt(yearMatch[0], 10);
    if (year >= 2020) {
      score += 0.5;
    }
  }

  score = Math.round(score * 2) / 2;
  return Math.max(1, Math.min(5, score));
}

/**
 * Penalty derived from the source file's original path/name (when available
 * from Anna's Archive search cards) plus title markers. Format-conversion
 * dumps (RTF/DOC/TXT/HTML re-saved as EPUB, OCR scans) produce broken
 * chapter structure, drop-cap artifacts, and missing TOCs; retail and
 * curated releases (publisher names, ePubLibre) are reliably clean.
 *
 * Returns { penalty, labels }. Negative penalty = bonus.
 */
function sourceFileQualityPenalty(result) {
  const haystack = `${result?.filePath || ''} ${result?.title || ''}`.toLowerCase();
  if (!haystack.trim()) return { penalty: 0, labels: [] };

  let penalty = 0;
  const labels = [];
  const junkMarkers = [
    { name: 'rtf-conversion', pattern: /\(rtf\)|\brtf\b/i, value: 45 },
    { name: 'doc-conversion', pattern: /\(docx?\)|\bmsword\b|\bdocx\b/i, value: 40 },
    { name: 'txt-conversion', pattern: /\(txt\)|\bplain ?text\b/i, value: 40 },
    { name: 'html-conversion', pattern: /\(html?\)|\bhtmlz\b/i, value: 35 },
    { name: 'ocr-scan', pattern: /\bocr\b|\bscanned\b|\babbyy\b/i, value: 40 },
    { name: 'split-conversion', pattern: /_split_|_split\b/i, value: 30 },
    { name: 'warez-dump', pattern: /\b0day\b|\bflatline\b/i, value: 10 },
    { name: 'calibre-library', pattern: /calibre library|calibre_library/i, value: 10 }
  ];
  for (const marker of junkMarkers) {
    if (marker.pattern.test(haystack)) {
      penalty += marker.value;
      labels.push(marker.name);
    }
  }

  const cleanMarkers = [
    { name: 'curated-release', pattern: /epublibre|standard ?ebooks/i, value: 15 },
    { name: 'retail', pattern: /\bretail\b/i, value: 15 }
  ];
  for (const marker of cleanMarkers) {
    if (marker.pattern.test(haystack)) {
      penalty -= marker.value;
      labels.push(marker.name);
    }
  }

  return { penalty, labels };
}

function selectBestResult(results) {
  if (!results || results.length === 0) return null;

  const scoredResults = results.map(result => ({
    ...result,
    qualityScore: calculateQualityScore(result)
  }));

  scoredResults.sort((a, b) => {
    const aIsPdf = String(a.format || '').toUpperCase() === 'PDF';
    const bIsPdf = String(b.format || '').toUpperCase() === 'PDF';
    if (aIsPdf !== bIsPdf) return aIsPdf ? 1 : -1;

    if (b.qualityScore !== a.qualityScore) {
      return b.qualityScore - a.qualityScore;
    }
    return parseSizeToBytes(b.size) - parseSizeToBytes(a.size);
  });

  return scoredResults[0];
}

function parseSizeToBytes(sizeStr) {
  if (!sizeStr) return 0;
  const match = sizeStr.match(/([\d.]+)\s*(KB|MB|GB)/i);
  if (!match) return 0;

  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();

  if (unit === 'KB') return value * 1024;
  if (unit === 'MB') return value * 1024 * 1024;
  if (unit === 'GB') return value * 1024 * 1024 * 1024;
  return 0;
}

function parseAnnasResults(stdout) {
  const results = [];
  const bookBlocks = stdout.split(/Book \d+:/);

  for (const block of bookBlocks) {
    if (!block.trim()) continue;

    const lines = block.trim().split('\n');
    const bookData = {};

    for (const line of lines) {
      if (line.startsWith('Title: ')) {
        bookData.title = line.substring(7).trim();
      } else if (line.startsWith('Authors: ')) {
        bookData.author = line.substring(9).trim();
      } else if (line.startsWith('Publisher: ')) {
        bookData.publisher = line.substring(11).trim();
      } else if (line.startsWith('Language: ')) {
        bookData.language = line.substring(10).trim();
      } else if (line.startsWith('Format: ')) {
        bookData.format = line.substring(8).trim().toUpperCase();
      } else if (line.startsWith('Size: ')) {
        bookData.size = line.substring(6).trim();
      } else if (line.startsWith('URL: ')) {
        bookData.url = line.substring(5).trim();
      } else if (line.startsWith('Hash: ')) {
        bookData.hash = line.substring(6).trim();
      }
    }

    if (bookData.title && bookData.hash) {
      results.push({
        title: bookData.title || 'Unknown Title',
        author: bookData.author || 'Unknown',
        format: bookData.format || 'EPUB',
        size: bookData.size || '',
        hash: bookData.hash,
        publisher: bookData.publisher || '',
        language: bookData.language || '',
        url: bookData.url || ''
      });
    }
  }

  const minBookSize = 100 * 1024;
  const validResults = results.filter(result => {
    const sizeBytes = parseSizeToBytes(result.size);
    return sizeBytes === 0 || sizeBytes >= minBookSize;
  });

  const formatPriority = {
    EPUB: 1,
    MOBI: 2,
    AZW: 2,
    AZW3: 2,
    PRC: 2,
    PDF: 9
  };

  validResults.sort((a, b) => {
    const aPriority = formatPriority[a.format] || 99;
    const bPriority = formatPriority[b.format] || 99;
    if (aPriority !== bPriority) return aPriority - bPriority;

    const aSizeBytes = parseSizeToBytes(a.size);
    const bSizeBytes = parseSizeToBytes(b.size);
    if (aSizeBytes !== bSizeBytes) return bSizeBytes - aSizeBytes;

    return a.title.localeCompare(b.title);
  });

  return validResults;
}

module.exports = {
  calculateQualityScore,
  selectBestResult,
  sourceFileQualityPenalty,
  parseSizeToBytes,
  parseAnnasResults
};

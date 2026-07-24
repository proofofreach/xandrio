const path = require('path');
const { requestRemote, readBoundedBuffer } = require('./remote-fetch');
const { boundedQueryTypoEvidence } = require('./search-fuzzy-matching');

const METADATA_TIMEOUT_MS = 10000;
const MAX_METADATA_JSON_BYTES = 2 * 1024 * 1024;
const METADATA_USER_AGENT = 'Xandrio-Audiobook-Player/1.0';

function remoteOptions(options = {}, timeoutMs = METADATA_TIMEOUT_MS) {
  return {
    fetchImpl: options.fetchImpl,
    lookupImpl: options.lookupImpl,
    timeoutMs,
    maxRedirects: 3,
    headersForUrl: () => ({
      'Accept': 'application/json',
      'User-Agent': METADATA_USER_AGENT
    })
  };
}

async function readRemoteJson(response) {
  // The json() fallback preserves the lightweight response doubles used by
  // callers' tests; production responses always take the bounded body path.
  if (!response?.body && typeof response?.arrayBuffer !== 'function' && typeof response?.json === 'function') {
    return response.json();
  }
  return JSON.parse((await readBoundedBuffer(response, MAX_METADATA_JSON_BYTES)).toString('utf8'));
}

async function fetchMetadataJson(url, options = {}, timeoutMs = METADATA_TIMEOUT_MS) {
  const remote = await requestRemote(url, remoteOptions(options, timeoutMs));
  try {
    if (!remote.response.ok) {
      throw new Error(`Metadata request failed: ${remote.response.status} ${remote.response.statusText}`);
    }
    return await readRemoteJson(remote.response);
  } finally {
    remote.close();
  }
}

function isGarbageTitle(title) {
  if (!title) return true;
  const trimmed = String(title).trim();
  if (/^(?:[A-Za-z]\s+){2,}[A-Za-z]$/.test(trimmed)) return true;
  if (/^[a-f0-9]{32}$/i.test(trimmed)) return true;
  if (/^[a-f0-9]{40,64}$/i.test(trimmed)) return true;
  if (/\.(epub|pdf|mobi|azw3?|prc|fb2|fbz|txtz?|rtf|docx?|odt|htmlz?)$/i.test(title)) return true;
  if (/^[A-Za-z0-9_-]+\.(epub|pdf|mobi|azw3?|prc|fb2|fbz|txtz?|rtf|docx?|odt|htmlz?)$/i.test(title)) return true;
  if (title.includes('_') && title.split('_').length > 2) return true;
  if (!/\s/.test(title) && /^[A-Z][a-z]+([A-Z][a-z]+){2,}$/.test(title.replace(/[^A-Za-z]/g, ''))) return true;
  if (!title.includes(' ') && title.split('-').length >= 3) return true;
  if (/\(Ver\d+\)|\(v\d+\)|_Ver\d+/i.test(title)) return true;
  if (/\(c-?\d+\)|\(z-lib/i.test(title)) return true;
  return false;
}

function isGarbageAuthor(author) {
  if (!author) return true;
  const lower = author.toLowerCase().trim();
  if (lower === 'unknown' || lower === 'unknown author' || lower === '') return true;
  if (lower === 'calibre' || lower === 'calibre ebook manager') return true;
  if (lower === 'n/a' || lower === 'none' || lower === 'anonymous') return true;
  return false;
}

function normalizeMetadataText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(the|a|an|and|of|to|in|for|with|why|how|is|are|on|by)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleTokenOverlap(a, b) {
  const aTokens = new Set(normalizeMetadataText(a).split(' ').filter(token => token.length > 2));
  const bTokens = new Set(normalizeMetadataText(b).split(' ').filter(token => token.length > 2));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let matches = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) matches++;
  }
  return matches / Math.min(aTokens.size, bTokens.size);
}

function balancedTitleTokenOverlap(a, b) {
  const aTokens = new Set(normalizeMetadataText(a).split(' ').filter(token => token.length > 2));
  const bTokens = new Set(normalizeMetadataText(b).split(' ').filter(token => token.length > 2));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let matches = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) matches++;
  }
  return matches / Math.max(aTokens.size, bTokens.size);
}

function normalizeIsbn(value) {
  return String(value || '').replace(/[^0-9Xx]/g, '').toUpperCase();
}

function normalizeIsbnList(value) {
  const raw = Array.isArray(value) ? value : [value];
  return [...new Set(raw.map(normalizeIsbn).filter(isbn => isbn.length === 10 || isbn.length === 13))];
}

function normalizeLanguageCode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const bracketCode = raw.match(/\[([a-z]{2,3})\]/);
  const first = (bracketCode?.[1] || raw)
    .replace(/^\/languages\//, '')
    .replace(/_/g, '-')
    .replace(/[^a-z-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .find(Boolean) || raw;
  const code = first.split('-')[0];
  const map = {
    en: 'en', eng: 'en', english: 'en',
    de: 'de', ger: 'de', deu: 'de', german: 'de', deutsch: 'de',
    es: 'es', spa: 'es', spanish: 'es',
    fr: 'fr', fre: 'fr', fra: 'fr', french: 'fr',
    it: 'it', ita: 'it', italian: 'it',
    pt: 'pt', por: 'pt', portuguese: 'pt',
    ru: 'ru', rus: 'ru', russian: 'ru',
    zh: 'zh', chi: 'zh', zho: 'zh', chinese: 'zh',
    ja: 'ja', jpn: 'ja', japanese: 'ja'
  };
  return map[code] || map[raw] || code;
}

function normalizeLanguageCodes(value) {
  const raw = Array.isArray(value) ? value : [value];
  return [...new Set(raw.map(normalizeLanguageCode).filter(Boolean))];
}

function cleanTitleForIdentity(title, author) {
  const cleaned = String(title || '')
    .replace(/\s*\/\s*A\s+Dramatization\b.*$/i, '')
    .replace(/\s*:\s*(?:a\s+)?novel\s*$/i, '')
    .replace(/(.+?)\s*,\s*((?:1[5-9]\d{2}|20\d{2})\s*[-–—]\s*\d{2,4})\s*$/i, '$1')
    .replace(/\s*[-–—]\s*\(?\s*(illus|illustrated|annotated|abridged|adapted|summary|study guide)\s*\)?\s*$/i, '')
    .replace(/\s*:\s*(?:a\s+)?(?:classic\s+)?(?:illustrated|annotated|abridged|adapted|summary|study guide)\b.*$/i, '')
    .replace(/\s*\([^)]*(?:illustrated|annotated|abridged|adapted|summary|study guide|dramatization)[^)]*\)\s*/gi, ' ')
    .replace(/\s*\[[^\]]*\]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const dashParts = cleaned.split(/\s+[-–—]\s+/).map(part => part.trim()).filter(Boolean);
  if (author && dashParts.length > 1 && titleTokenOverlap(dashParts[0], author) >= 0.8) {
    return dashParts.slice(1).join(' - ');
  }
  return cleaned;
}

function cleanAuthorForIdentity(author) {
  return String(author || '')
    .replace(/\s*\[[^\]]*\]\s*/g, ' ')
    .replace(/\s*,?\s*\b(?:1[5-9]\d{2}|20\d{2})\s*[-–—]\s*(?:1[5-9]\d{2}|20\d{2})?\b\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAuthorForDisplay(author) {
  const cleaned = cleanAuthorForIdentity(author);
  if (!cleaned || /[;&/]|\band\b/i.test(cleaned)) return cleaned;

  const catalogOrder = cleaned.match(/^([^,]{2,80}),\s*([^,]{2,80})$/u);
  if (!catalogOrder) return cleaned;
  const familyName = catalogOrder[1].trim();
  const givenNames = catalogOrder[2].trim();
  if (!/[\p{L}]/u.test(familyName) || !/[\p{L}]/u.test(givenNames)) return cleaned;
  return `${givenNames} ${familyName}`.replace(/\s+/g, ' ').trim();
}

function buildOpenLibraryTitleQuery(title, author) {
  const queryTitle = String(title || '').replace(/\s+/g, ' ').trim();
  const queryAuthor = String(author || '').replace(/\s+/g, ' ').trim();
  if (!queryTitle) return '';
  return queryAuthor ? `${queryTitle} ${queryAuthor}` : queryTitle;
}

function addOpenLibrarySearch(searches, q, matchedFrom) {
  const query = String(q || '').replace(/\s+/g, ' ').trim();
  if (!query) return;
  const key = query.toLowerCase();
  if (searches.some(search => search.key === key)) return;
  searches.push({ q: query, matchedFrom, key });
}

function buildOpenLibrarySearches(input = {}, isbns = normalizeIsbnList(input.isbn || input.isbns)) {
  const searches = [];
  const title = input.title;
  const author = cleanAuthorForIdentity(input.author);
  const cleanTitle = cleanTitleForIdentity(title, author);
  const queryTitle = input.queryTitle || input.searchedTitle;
  const queryAuthor = cleanAuthorForIdentity(input.queryAuthor || input.searchedAuthor);
  const explicitQuery = input.query || input.openLibraryQuery || input.searchQuery;

  if (isbns.length > 0) {
    addOpenLibrarySearch(searches, `isbn:${isbns[0]}`, 'isbn');
  }
  addOpenLibrarySearch(searches, explicitQuery, 'query');
  addOpenLibrarySearch(searches, buildOpenLibraryTitleQuery(title, author), 'raw');
  addOpenLibrarySearch(searches, buildOpenLibraryTitleQuery(title, null), 'title');
  if (cleanTitle && cleanTitle !== title) {
    addOpenLibrarySearch(searches, buildOpenLibraryTitleQuery(cleanTitle, author), 'cleaned');
    addOpenLibrarySearch(searches, buildOpenLibraryTitleQuery(cleanTitle, null), 'cleaned-title');
  }
  if (queryTitle && queryTitle !== title && queryTitle !== cleanTitle) {
    addOpenLibrarySearch(searches, buildOpenLibraryTitleQuery(queryTitle, queryAuthor || author), 'query');
  }

  return searches.map(({ q, matchedFrom }) => ({ q, matchedFrom }));
}

function parseBookFilename(filename) {
  if (!filename) return {};
  const noExt = path.basename(filename).replace(/\.(epub|pdf|mobi|azw3?|prc)$/i, '');
  const normalized = noExt
    .replace(/[_]+/g, ' ')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s*\[[^\]]*\]\s*/g, ' ')
    .replace(/\b(ver|v)\d+\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const dashParts = normalized.split(/\s+-\s+/).map(part => part.trim()).filter(Boolean);
  if (dashParts.length >= 2) {
    return {
      title: dashParts.slice(0, -1).join(' - '),
      author: dashParts[dashParts.length - 1]
    };
  }

  return { title: normalized };
}

function resolveMetadataSeed(metadata, fallbackTitle, fallbackAuthor, filename) {
  const filenameMetadata = parseBookFilename(filename);
  const embeddedTitle = metadata?.title;
  const embeddedAuthor = metadata?.author;
  const filenameTitle = isGarbageTitle(filenameMetadata.title) ? undefined : filenameMetadata.title;
  const filenameAuthor = filenameMetadata.author;
  const trustedTitle = filenameTitle || (!isGarbageTitle(fallbackTitle) ? fallbackTitle : undefined);
  const embeddedLooksWrong = embeddedTitle && trustedTitle &&
    !isGarbageTitle(embeddedTitle) &&
    titleTokenOverlap(embeddedTitle, trustedTitle) < 0.25;

  return {
    title: embeddedLooksWrong
      ? trustedTitle
      : pickBestTitle(embeddedTitle, trustedTitle, filename),
    author: embeddedLooksWrong
      ? (filenameAuthor || fallbackAuthor || pickBestAuthor(embeddedAuthor, null))
      : (filenameAuthor || pickBestAuthor(embeddedAuthor, fallbackAuthor)),
    embeddedLooksWrong,
    filenameMetadata
  };
}

function trustedEnrichedTitle(enrichedTitle, seedTitle, metadataSeed) {
  if (!enrichedTitle) return undefined;
  if (!metadataSeed?.embeddedLooksWrong) return enrichedTitle;
  return titleTokenOverlap(enrichedTitle, seedTitle) >= 0.25 ? enrichedTitle : undefined;
}

function pickBestTitle(epubTitle, searchTitle, filename) {
  if (epubTitle && !isGarbageTitle(epubTitle)) return epubTitle;
  if (searchTitle && !isGarbageTitle(searchTitle)) return searchTitle;

  if (filename) {
    let clean = filename
      .replace(/\.(epub|pdf|mobi|azw3?|prc|fb2|fbz|txtz?|rtf|docx?|odt|htmlz?)$/i, '')
      .replace(/_/g, ' ')
      .replace(/\s*\([^)]*\)\s*/g, ' ')
      .replace(/\s*\[[^\]]*\]\s*/g, ' ')
      .replace(/\bVer\d+\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    clean = clean
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

    const dashParts = clean.split(/\s+-\s+|\s{2,}/);
    if (dashParts.length >= 2) {
      return dashParts.slice(1).join(' ').trim() || dashParts[0];
    }

    const origNoExt = filename.replace(/\.(epub|pdf|mobi|azw3?|prc|fb2|fbz|txtz?|rtf|docx?|odt|htmlz?)$/i, '');
    const hyphenParts = origNoExt.split(/-/);
    if (hyphenParts.length >= 3) {
      for (let i = 1; i < hyphenParts.length; i++) {
        const part = hyphenParts[i];
        if (/[a-z][A-Z]/.test(part) || (i >= 2 && part.length > 4)) {
          const titleParts = hyphenParts.slice(i).join(' ')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
            .replace(/\s*\([^)]*\)/g, '')
            .replace(/\bVer\d+\b/gi, '')
            .trim();
          if (titleParts) return titleParts;
        }
      }
    }

    const underParts = origNoExt.split(/_/);
    if (underParts.length >= 3) {
      for (let i = 1; i < underParts.length; i++) {
        const part = underParts[i];
        if (/[a-z][A-Z]/.test(part) || (i >= 2 && part.length > 4 && /^[A-Z]/.test(part))) {
          const titleParts = underParts.slice(i).join(' ')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
            .replace(/\s*\([^)]*\)/g, '')
            .replace(/\bVer\d+\b/gi, '')
            .trim();
          if (titleParts) return titleParts;
        }
      }
    }

    return clean;
  }

  return epubTitle || 'Unknown Title';
}

function pickBestAuthor(epubAuthor, searchAuthor) {
  if (epubAuthor && !isGarbageAuthor(epubAuthor)) return epubAuthor;
  if (searchAuthor && !isGarbageAuthor(searchAuthor)) return searchAuthor;
  return null;
}

async function enrichMetadataFromOpenLibrary(title, author, options = {}) {
  try {
    if (!title) return {};

    const cleanTitle = title
      .replace(/\s*\([^)]*\)\s*/g, '')
      .replace(/\s*\[[^\]]*\]\s*/g, '')
      .trim();

    const searchQuery = author ? `${cleanTitle} ${author}` : cleanTitle;
    const searchUrl = `https://openlibrary.org/search.json?q=${encodeURIComponent(searchQuery)}&limit=1`;
    const data = await fetchMetadataJson(searchUrl, options);

    if (!data.docs || data.docs.length === 0) return {};

    const book = data.docs[0];
    return {
      title: book.title,
      author: book.author_name ? book.author_name.join(', ') : undefined,
      publisher: book.publisher ? book.publisher[0] : undefined,
      publishedDate: book.first_publish_year,
      description: book.subtitle || undefined,
      subjects: book.subject ? book.subject.slice(0, 5) : []
    };
  } catch (err) {
    console.error('Open Library metadata enrichment error:', err.message);
    return {};
  }
}

function scoreOpenLibraryDoc(doc, query = {}) {
  const requestedTitle = normalizeMetadataText(query.title);
  const titleOverlap = requestedTitle
    ? balancedTitleTokenOverlap(cleanTitleForIdentity(query.title, query.author), cleanTitleForIdentity(doc?.title || ''))
    : 0;
  const requestedAuthor = normalizeMetadataText(cleanAuthorForIdentity(query.author));
  const docAuthors = Array.isArray(doc?.author_name) ? doc.author_name.join(' ') : '';
  const authorOverlap = requestedAuthor ? titleTokenOverlap(requestedAuthor, docAuthors) : 0;
  const queryIsbns = normalizeIsbnList(query.isbn || query.isbns);
  const docIsbns = normalizeIsbnList(doc?.isbn || []);
  const isbnMatch = queryIsbns.length > 0 && docIsbns.some(isbn => queryIsbns.includes(isbn));
  const queryLanguages = normalizeLanguageCodes(query.language || query.languages);
  const docLanguages = normalizeLanguageCodes(doc?.language);
  const languageMatch = queryLanguages.length > 0 && docLanguages.some(lang => queryLanguages.includes(lang));
  const hasWork = Boolean(doc?.key);
  const hasEdition = Array.isArray(doc?.edition_key) && doc.edition_key.length > 0;
  let score = 0;

  if (isbnMatch) score += 0.55;
  score += Math.min(0.3, titleOverlap * 0.3);
  if (requestedAuthor) score += Math.min(0.25, authorOverlap * 0.25);
  if (languageMatch) score += 0.05;
  if (hasWork) score += 0.05;
  if (hasEdition) score += 0.03;
  score = Math.min(1, Number(score.toFixed(3)));

  let level = 'low';
  const warnings = [];
  if (isbnMatch || (titleOverlap >= 0.95 && requestedAuthor && authorOverlap >= 0.8)) {
    level = 'high';
    score = Math.max(score, 0.75);
  } else if (titleOverlap >= 0.8 && (!requestedAuthor || authorOverlap >= 0.6)) {
    level = score >= 0.75 ? 'high' : 'medium';
  } else if ((requestedTitle && titleOverlap < 0.25) || (requestedAuthor && authorOverlap < 0.2)) {
    level = 'conflict';
  } else if (score >= 0.45) {
    level = 'medium';
  }

  if (requestedTitle && titleOverlap < 0.25) warnings.push(`Open Library title mismatch: "${doc?.title || 'Unknown'}"`);
  if (requestedAuthor && authorOverlap < 0.2) warnings.push(`Open Library author mismatch: "${docAuthors || 'Unknown'}"`);
  if (queryLanguages.length > 0 && docLanguages.length > 0 && !languageMatch) warnings.push(`Open Library language mismatch: ${[...new Set(docLanguages)].join(', ')}`);

  return { score, level, titleOverlap, authorOverlap, isbnMatch, languageMatch: Boolean(languageMatch), warnings };
}

function openLibraryDocToIdentity(doc, confidence, requestedLanguage) {
  const editionKey = Array.isArray(doc?.edition_key) && doc.edition_key[0]
    ? `/books/${doc.edition_key[0]}`
    : undefined;
  const primaryAuthor = Array.isArray(doc?.author_name) ? doc.author_name[0] : undefined;
  const docLanguages = normalizeLanguageCodes(doc?.language);
  const requestedLanguages = normalizeLanguageCodes(requestedLanguage);
  const selectedLanguage = requestedLanguages.find(language => docLanguages.includes(language)) || docLanguages[0];
  return {
    source: 'openlibrary',
    openLibraryWorkKey: doc?.key,
    openLibraryEditionKey: editionKey,
    title: doc?.title,
    author: Array.isArray(doc?.author_name) ? doc.author_name.join(', ') : undefined,
    primaryAuthor,
    publishYear: doc?.first_publish_year,
    language: selectedLanguage,
    isbn: normalizeIsbnList(doc?.isbn || []).slice(0, 10),
    coverId: doc?.cover_i,
    confidence,
    warnings: confidence?.warnings || []
  };
}

async function resolveOpenLibraryIdentity(input = {}, options = {}) {
  const warnings = [];
  try {
    const title = input.title;
    const cleanTitle = cleanTitleForIdentity(title, input.author);
    const queryTitle = input.queryTitle || input.searchedTitle;
    const queryAuthor = input.queryAuthor || input.searchedAuthor;
    const isbns = normalizeIsbnList(input.isbn || input.isbns);
    const searches = buildOpenLibrarySearches(input, isbns);
    if (searches.length === 0) {
      return { matchedFrom: null, confidence: { score: 0, level: 'low' }, warnings: ['Open Library skipped: no title, ISBN, or query'] };
    }

    const timeoutMs = options.timeoutMs || 8000;
    const docs = [];
    for (const search of searches) {
      const q = search.q;
      const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=5`;
      try {
        const remote = await requestRemote(url, remoteOptions(options, timeoutMs));
        try {
          if (!remote.response.ok) {
            warnings.push(`Open Library ${search.matchedFrom} search failed (${remote.response.status})`);
            continue;
          }
          const data = await readRemoteJson(remote.response);
          docs.push(...(data.docs || []).map(doc => ({
            ...doc,
            _matchedFrom: search.matchedFrom
          })));
        } finally {
          remote.close();
        }
      } catch (err) {
        warnings.push(`Open Library ${search.matchedFrom} search unavailable: ${err.message}`);
        continue;
      }
    }

    if (docs.length === 0) {
      return { matchedFrom: null, confidence: { score: 0, level: 'low' }, warnings: warnings.length ? warnings : ['No Open Library match'] };
    }

    const ranked = docs
      .map(doc => ({
        doc,
        confidence: scoreOpenLibraryDoc(doc, {
          ...input,
          title: doc._matchedFrom === 'cleaned' || doc._matchedFrom === 'cleaned-title'
            ? cleanTitle
            : (input.title || queryTitle || input.query || input.openLibraryQuery || input.searchQuery),
          // A broader search query may discover a candidate, but it may not
          // replace the provider listing's own author when we score identity.
          author: cleanAuthorForIdentity(input.author || (!input.title ? queryAuthor : ''))
        })
      }))
      .sort((a, b) => b.confidence.score - a.confidence.score);
    const best = ranked[0];
    return {
      ...openLibraryDocToIdentity(best.doc, best.confidence, input.language || input.languages),
      matchedFrom: best.doc._matchedFrom,
      warnings: [...new Set([...warnings, ...(best.confidence.warnings || [])])]
    };
  } catch (err) {
    return {
      matchedFrom: null,
      confidence: { score: 0, level: 'low' },
      warnings: [`Open Library unavailable: ${err.message}`]
    };
  }
}

async function resolveSearchQueryCorrection(input = {}, options = {}) {
  const query = String(input.query || '').replace(/\s+/g, ' ').trim();
  if (!query) return { warnings: ['Search correction skipped: no query'] };
  try {
    const params = new URLSearchParams({
      action: 'query',
      list: 'search',
      srsearch: query,
      srlimit: '5',
      srinfo: 'suggestion',
      format: 'json',
      origin: '*'
    });
    const data = await fetchMetadataJson(
      `https://en.wikipedia.org/w/api.php?${params}`,
      options,
      options.timeoutMs || 4000
    );
    const suggestion = String(data?.query?.searchinfo?.suggestion || '').replace(/\s+/g, ' ').trim();
    if (!suggestion || !boundedQueryTypoEvidence(query, suggestion)) {
      return { warnings: ['No bounded spelling suggestion'] };
    }

    const identity = await resolveOpenLibraryIdentity({
      query: suggestion,
      language: input.language
    }, options);
    if (!identity.openLibraryWorkKey) {
      return {
        ...identity,
        warnings: [...new Set([...(identity.warnings || []), 'Spelling suggestion was not validated by Open Library'])]
      };
    }
    return { ...identity, spellingSuggestion: suggestion };
  } catch (error) {
    return { warnings: [`Search correction unavailable: ${error.message}`] };
  }
}

async function enrichMetadataFromGoogleBooks(title, author, options = {}) {
  try {
    if (!title) return {};
    const query = author ? `intitle:${title} inauthor:${author}` : title;
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=5`;
    const data = await fetchMetadataJson(url, options);
    const items = data.items || [];
    if (items.length === 0) return {};

    const normalizedAuthor = normalizeMetadataText(author);
    const candidates = items
      .map(item => item.volumeInfo || {})
      .map(info => {
        const authors = (info.authors || []).join(', ');
        return {
          info,
          score: titleTokenOverlap(title, info.title || '') +
            (normalizedAuthor && normalizeMetadataText(authors).includes(normalizedAuthor) ? 1 : 0)
        };
      })
      .sort((a, b) => b.score - a.score);

    const best = candidates[0]?.info;
    if (!best) return {};

    return {
      title: best.title,
      author: best.authors ? best.authors.join(', ') : undefined,
      publisher: best.publisher,
      publishedDate: best.publishedDate ? parseInt(best.publishedDate, 10) : undefined,
      description: best.description,
      subjects: best.categories || []
    };
  } catch (err) {
    console.error('Google Books metadata enrichment error:', err.message);
    return {};
  }
}

async function enrichBookMetadata(title, author, options = {}) {
  const [google, openLibrary] = await Promise.all([
    enrichMetadataFromGoogleBooks(title, author, options),
    enrichMetadataFromOpenLibrary(title, author, options)
  ]);

  return {
    ...openLibrary,
    ...google,
    subjects: google.subjects?.length ? google.subjects : (openLibrary.subjects || [])
  };
}

module.exports = {
  isGarbageTitle,
  isGarbageAuthor,
  normalizeMetadataText,
  titleTokenOverlap,
  normalizeIsbn,
  normalizeIsbnList,
  normalizeLanguageCode,
  normalizeLanguageCodes,
  cleanTitleForIdentity,
  cleanAuthorForIdentity,
  normalizeAuthorForDisplay,
  buildOpenLibrarySearches,
  parseBookFilename,
  resolveMetadataSeed,
  trustedEnrichedTitle,
  pickBestTitle,
  pickBestAuthor,
  scoreOpenLibraryDoc,
  resolveOpenLibraryIdentity,
  resolveSearchQueryCorrection,
  enrichMetadataFromOpenLibrary,
  enrichMetadataFromGoogleBooks,
  enrichBookMetadata
};

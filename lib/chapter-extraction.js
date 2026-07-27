// EPUB chapter extraction: TOC-driven spine merging, anchor splitting,
// title normalization, and duration estimation.
//
// Extracted verbatim from server.js so tests can require the real
// implementation instead of slicing server.js source by string offsets
// (the old test/extract-helper.js approach).

const { stripHTML, normalizeAllCapsTitle } = require('./chapter-utils');
const { parseEpub } = require('./epub-parser');

function romanNumeralToNumber(value = '') {
  const roman = String(value).toUpperCase();
  if (!roman || !/^[IVXLCDM]+$/.test(roman)) return null;
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  for (let i = 0; i < roman.length; i++) {
    const current = values[roman[i]];
    const next = values[roman[i + 1]] || 0;
    total += current < next ? -current : current;
  }
  return total > 0 ? total : null;
}

function chapterNumberFromTocTitle(title = '') {
  const match = String(title).trim().match(/^chapter\s+(\d{1,3}|[ivxlcdm]+)\b/i);
  if (!match) return null;
  if (/^\d+$/.test(match[1])) return Number(match[1]);
  return romanNumeralToNumber(match[1]);
}

function numberedTocPlan(tocEntries = []) {
  const numbered = tocEntries.map(entry => ({
    number: chapterNumberFromTocTitle(entry.title),
    title: entry.title
  }));
  if (numbered.length < 5 || numbered.some(entry => !entry.number)) return null;
  const numbers = numbered.map(entry => entry.number);
  if (numbers.some((number, index) => index > 0 && number <= numbers[index - 1])) return null;
  const expectedCount = numbers[numbers.length - 1];
  const missingCount = expectedCount - numbers.length;
  if (
    numbers[0] !== 1 ||
    expectedCount < 5 ||
    expectedCount > 20 ||
    missingCount < 0 ||
    missingCount > 2
  ) {
    return null;
  }
  return {
    expectedCount,
    titleByNumber: new Map(numbered.map(entry => [entry.number, entry.title]))
  };
}

function meaningfulWords(text = '') {
  return new Set(
    (String(text).toLocaleLowerCase('en').match(/[\p{L}\p{N}]{4,}/gu) || [])
  );
}

function wordOverlapRatio(referenceWords, text = '') {
  const words = meaningfulWords(text);
  if (words.size === 0) return 0;
  let overlap = 0;
  for (const word of words) {
    if (referenceWords.has(word)) overlap++;
  }
  return overlap / words.size;
}

function normalizedMarkupSignature(markup = '') {
  return String(markup)
    .replace(/<\/([a-z0-9]+)\s*>/gi, '</$1>')
    .replace(/<([a-z0-9]+)\b[^>]*>/gi, '<$1>')
    .replace(/&(?:nbsp|#160);/gi, ' ')
    .replace(/\s+/g, '')
    .replace(/[^<>]+/g, 'T');
}

function pageNumberFromImageSource(source = '') {
  const indexPage = String(source).match(/index-(\d+)/i);
  if (indexPage) return Number(indexPage[1]);
  const genericPage = String(source).match(/(\d+)(?:[_-]\d+)?(?:\.[^./?#]+)?(?:[?#].*)?$/);
  return genericPage ? Number(genericPage[1]) : null;
}

function scoreCandidateSequence(sequence, expectedCount) {
  if (sequence.length < 2) return null;
  const missingCount = expectedCount - sequence.length;
  if (missingCount < 0 || missingCount > 1) return null;
  const hasOrderedPages = sequence.every((candidate, index) =>
    Number.isFinite(candidate.pageNumber) &&
    (index === 0 || candidate.pageNumber > sequence[index - 1].pageNumber)
  );
  const values = sequence.map(candidate => hasOrderedPages ? candidate.pageNumber : candidate.pos);
  const baseGap = (values[values.length - 1] - values[0]) / (expectedCount - 1);
  if (!(baseGap > 0)) return null;
  const gaps = values.slice(1).map((value, index) => value - values[index]);
  const regularErrors = gaps.map(gap => ((gap / baseGap) - 1) ** 2);
  const missingGapIndexes = [];
  if (missingCount === 1) {
    let bestIndex = -1;
    let bestDelta = Infinity;
    for (let i = 0; i < gaps.length; i++) {
      const doubleError = ((gaps[i] / baseGap) - 2) ** 2;
      const delta = doubleError - regularErrors[i];
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) return null;
    regularErrors[bestIndex] += bestDelta;
    missingGapIndexes.push(bestIndex);
  }
  return {
    score: regularErrors.reduce((sum, error) => sum + error, 0) / gaps.length,
    missingGapIndexes
  };
}

function chooseCandidateSequence(candidates, expectedCount) {
  if (
    candidates.length < expectedCount - 1 ||
    candidates.length > expectedCount + 4
  ) {
    return null;
  }
  let best = null;
  for (const targetLength of [expectedCount, expectedCount - 1]) {
    if (targetLength < 2 || targetLength > candidates.length) continue;
    const innerNeeded = targetLength - 2;
    const chosen = [candidates[0]];

    function visit(startIndex) {
      if (chosen.length === innerNeeded + 1) {
        const sequence = [...chosen, candidates[candidates.length - 1]];
        const scored = scoreCandidateSequence(sequence, expectedCount);
        if (scored && (!best || scored.score < best.score)) {
          best = { sequence, ...scored };
        }
        return;
      }
      const remainingNeeded = innerNeeded + 1 - chosen.length;
      const lastInnerIndex = candidates.length - 2;
      for (let index = startIndex; index <= lastInnerIndex - remainingNeeded + 1; index++) {
        chosen.push(candidates[index]);
        visit(index + 1);
        chosen.pop();
      }
    }

    if (innerNeeded === 0) {
      const sequence = [candidates[0], candidates[candidates.length - 1]];
      const scored = scoreCandidateSequence(sequence, expectedCount);
      if (scored && (!best || scored.score < best.score)) {
        best = { sequence, ...scored };
      }
    } else {
      visit(1);
    }
  }
  return best && best.score <= 0.2 ? best : null;
}

function recoverScannedChapterBundle({ sourceItem, html, tocEntries, tocChapters }) {
  const plan = numberedTocPlan(tocEntries);
  if (!plan || sourceItem.text.length < 100000 || !html) return null;
  if (tocChapters.length !== tocEntries.length) return null;
  const tocTextLength = tocChapters.reduce((sum, chapter) => sum + chapter.text.length, 0);
  if (tocTextLength <= 0 || tocTextLength > sourceItem.text.length * 0.08) return null;
  const sourceWords = meaningfulWords(sourceItem.text);
  const overlaps = tocChapters.map(chapter => wordOverlapRatio(sourceWords, chapter.text));
  if (overlaps.some(overlap => overlap < 0.55)) {
    return null;
  }

  const images = [...html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)]
    .map(match => ({
      pos: match.index,
      end: match.index + match[0].length,
      source: match[1],
      pageNumber: pageNumberFromImageSource(match[1])
    }));
  if (images.length < plan.expectedCount) return null;
  const bolds = [...html.matchAll(/<b\b[^>]*>([\s\S]*?)<\/b>/gi)]
    .map(match => ({
      pos: match.index,
      text: stripHTML(match[1]).replace(/\s+/g, ' ').trim()
    }))
    .filter(match => {
      const words = match.text.split(/\s+/).filter(Boolean);
      return match.text.length >= 8 && match.text.length <= 80 && words.length >= 2 && words.length <= 12;
    });

  const signatureGroups = new Map();
  let boldIndex = 0;
  for (let imageIndex = 0; imageIndex < images.length; imageIndex++) {
    const image = images[imageIndex];
    const nextImagePos = images[imageIndex + 1]?.pos ?? html.length;
    while (boldIndex < bolds.length && bolds[boldIndex].pos <= image.end) boldIndex++;
    const bold = bolds[boldIndex];
    if (!bold || bold.pos >= nextImagePos || bold.pos - image.end > 250) continue;
    const signature = normalizedMarkupSignature(html.slice(image.end, bold.pos));
    if (!signature) continue;
    if (!signatureGroups.has(signature)) signatureGroups.set(signature, []);
    signatureGroups.get(signature).push({ ...image, heading: bold.text });
  }
  let selected = null;
  for (const candidates of signatureGroups.values()) {
    const choice = chooseCandidateSequence(candidates, plan.expectedCount);
    if (choice && (!selected || choice.score < selected.score)) selected = choice;
  }
  if (!selected) return null;

  const boundaries = [...selected.sequence];
  for (const gapIndex of selected.missingGapIndexes) {
    const left = selected.sequence[gapIndex];
    const right = selected.sequence[gapIndex + 1];
    const midpoint = left.pos + ((right.pos - left.pos) / 2);
    const inferred = images
      .filter(image => image.pos > left.pos && image.pos < right.pos)
      .sort((a, b) => Math.abs(a.pos - midpoint) - Math.abs(b.pos - midpoint))[0];
    if (!inferred) return null;
    boundaries.push(inferred);
  }
  boundaries.sort((a, b) => a.pos - b.pos);
  if (boundaries.length !== plan.expectedCount) return null;

  const chapters = [];
  for (let index = 0; index < boundaries.length; index++) {
    const start = boundaries[index].pos;
    const end = boundaries[index + 1]?.pos ?? html.length;
    const text = stripHTML(html.slice(start, end)).trim();
    if (text.length < 500) return null;
    const chapterNumber = index + 1;
    chapters.push({
      title: plan.titleByNumber.get(chapterNumber) || `Chapter ${chapterNumber}`,
      text,
      originalIndex: sourceItem.spineIndex,
      fromToc: true,
      recoveredFromScannedBundle: true
    });
  }

  const prefixText = stripHTML(html.slice(0, boundaries[0].pos)).trim();
  const prefix = prefixText.length >= 50
    ? {
        title: sourceItem.title || sourceItem.heading || 'Introduction',
        text: prefixText,
        originalIndex: sourceItem.spineIndex,
        fromToc: false
      }
    : null;
  return prefix ? [prefix, ...chapters] : chapters;
}

async function extractChapters(epubPath) {
  const epub = await parseEpub(epubPath);
  try {
      const flow = epub.flow;
      
      // --- Step 1: Extract text for every spine item ---
      const spineItems = [];
      for (let i = 0; i < flow.length; i++) {
        const item = flow[i];
        const html = await getChapterHtml(epub, item.id);
        const text = stripHTML(html).trim();
        // First real heading in the file — used as a title source when the
        // TOC is unusable (e.g. single-entry "Start" TOCs from RTF conversions).
        let heading = '';
        const headingMatch = html.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i);
        if (headingMatch) {
          heading = stripHTML(headingMatch[1]).replace(/\s+/g, ' ').trim();
        }
        const href = item.href ? item.href.split('#')[0].split('/').pop() : '';
        spineItems.push({ spineIndex: i, id: item.id, href, title: item.title || '', heading, text: text.trim() });
      }
      
      // --- Step 2: Build href → spine index map ---
      const hrefToSpineIdx = {};
      for (const si of spineItems) {
        if (si.href && hrefToSpineIdx[si.href] === undefined) {
          hrefToSpineIdx[si.href] = si.spineIndex;
        }
        const decodedHref = decodeEpubHref(si.href);
        if (decodedHref && hrefToSpineIdx[decodedHref] === undefined) {
          hrefToSpineIdx[decodedHref] = si.spineIndex;
        }
      }
      
      // --- Step 3: TOC-driven merge strategy ---
      // Use the TOC as the authoritative chapter list. Each TOC entry owns
      // all spine items from its target up to (but not including) the next
      // TOC entry's target. This correctly handles Calibre-split EPUBs where
      // a single chapter spans multiple spine files.
      
      let tocChapters = null;
      
      if (epub.toc && epub.toc.length > 0) {
        // Resolve each TOC entry to a spine index
        const tocEntries = [];
        for (const tocEntry of epub.toc) {
          if (!tocEntry.title || !tocEntry.href) continue;
          const title = stripHTML(tocEntry.title).replace(/\s+/g, ' ').trim();
          if (!title) continue;
          const hrefParts = tocEntry.href.split('#');
          const href = hrefParts[0].split('/').pop();
          const decodedHref = decodeEpubHref(href);
          const fragment = hrefParts[1] || null;
          const spineIdx = hrefToSpineIdx[href] ?? hrefToSpineIdx[decodedHref];
          if (spineIdx !== undefined) {
            tocEntries.push({ title, spineIdx, fragment });
          }
        }

        // Drop TOC entries whose target an earlier entry already claimed.
        // Broken TOCs point several entries at one anchor (e.g. six "Day N"
        // entries all at a footnote ref) — identical targets would otherwise
        // emit the same content once per entry.
        const claimedTargets = new Set();
        for (let i = 0; i < tocEntries.length; i++) {
          const key = `${tocEntries[i].spineIdx}#${tocEntries[i].fragment || ''}`;
          if (claimedTargets.has(key)) {
            tocEntries.splice(i, 1);
            i--;
          } else {
            claimedTargets.add(key);
          }
        }

        // Deduplicate: if multiple TOC entries point to the same spine item,
        // decide whether to keep just one (the part header) or all of them
        // (individual chapters within the same file, differentiated by #anchors).
        // Heuristic: if a spine item has many TOC entries (>=3), they're likely
        // chapters within a single HTML file — keep them all. If only 2,
        // keep the more specific one (skip part/book/volume headers).
        const spineGroups = {};
        for (const entry of tocEntries) {
          if (!spineGroups[entry.spineIdx]) spineGroups[entry.spineIdx] = [];
          spineGroups[entry.spineIdx].push(entry);
        }

        const dedupedToc = [];
        const isPartTitle = (t) => /^(part|book|volume)\s+/i.test(t);

        for (const spineIdx of Object.keys(spineGroups).map(Number).sort((a, b) => a - b)) {
          const group = spineGroups[spineIdx];
          if (group.length === 1) {
            dedupedToc.push(group[0]);
          } else if (group.length >= 3) {
            // Many entries for same spine item = chapters within a single file.
            // Keep chapter-level entries, skip part/book headers.
            // Preserve each filtered part/book title on the next chapter after it.
            let pendingContext = [];
            const kept = [];
            for (const e of group) {
              if (isPartTitle(e.title)) {
                // A new Part/Book supersedes the previous one at the same level
                // (consecutive part entries otherwise pile up as context on the
                // next chapter — e.g. an appendix inheriting nine Parts).
                if (/^part\s+/i.test(e.title)) {
                  pendingContext = pendingContext.filter(c => !/^part\s+/i.test(c));
                } else {
                  pendingContext = pendingContext.filter(c => !/^(book|volume)\s+/i.test(c));
                }
                pendingContext.push(e.title);
              } else {
                if (pendingContext.length > 0) {
                  e.parentContext = [...pendingContext];
                  pendingContext = [];
                }
                kept.push(e);
              }
            }
            if (kept.length > 0) {
              dedupedToc.push(...kept);
            } else {
              dedupedToc.push(group[0]); // fallback: keep first
            }
          } else {
            // 2 entries — keep the more specific one (non-part title)
            const partEntry = group.find(e => isPartTitle(e.title));
            const specific = group.find(e => !isPartTitle(e.title));
            if (specific) {
              // Preserve the part title as context
              if (partEntry) specific.parentContext = [partEntry.title];
              dedupedToc.push(specific);
            } else {
              dedupedToc.push(group[0]);
            }
          }
        }
        
        // Only use TOC-driven merge if the TOC covers a meaningful portion
        // of the spine (at least 30% of content spine items are referenced)
        const contentSpineCount = spineItems.filter(s => s.text.length >= 50).length;
        const tocCoverage = dedupedToc.length / Math.max(contentSpineCount, 1);
        
        if (dedupedToc.length >= 3 && tocCoverage >= 0.3) {
          // First pass: build raw chapter entries.
          // Handle two patterns:
          //   A) TOC entries point to different spine items → merge spine range per entry
          //   B) Multiple TOC entries point to same spine item via #anchors → split by anchor
          const MAX_MERGE_CHARS = 80000;
          const rawTocChapters = [];

          // Pre-fetch raw HTML for spine items that have multiple TOC entries (for anchor splitting)
          const spineHtmlCache = {};
          async function getSpineHtml(spineIdx) {
            if (spineHtmlCache[spineIdx] !== undefined) return spineHtmlCache[spineIdx];
            const item = flow[spineIdx];
            const html = await getChapterHtml(epub, item.id);
            spineHtmlCache[spineIdx] = html;
            return html;
          }

          function tagStartBefore(html, index) {
            const tagStart = html.lastIndexOf('<', index);
            const tagEnd = html.lastIndexOf('>', index);
            return tagStart > tagEnd ? tagStart : index;
          }

          for (let ti = 0; ti < dedupedToc.length; ti++) {
            const entry = dedupedToc[ti];
            const nextEntry = dedupedToc[ti + 1];

            // Check if this entry and the next share the same spine item
            // (same-spine-index means chapters within one HTML file). The
            // first entry may lack a fragment — it then owns the file start
            // up to the next entry's anchor.
            if (nextEntry && nextEntry.spineIdx === entry.spineIdx && (entry.fragment || nextEntry.fragment)) {
              // Collect all consecutive entries pointing to the same spine item
              const sameSpineEntries = [entry];
              let peek = ti + 1;
              while (peek < dedupedToc.length && dedupedToc[peek].spineIdx === entry.spineIdx) {
                sameSpineEntries.push(dedupedToc[peek]);
                peek++;
              }
              // Skip ahead past these entries (minus 1 because the for loop increments)
              ti = peek - 1;

              // The TOC entry that follows this same-spine group (if any) —
              // the last chunk in the group owns everything up to its target.
              const nextGroupEntry = dedupedToc[peek];

              // Split the spine item's HTML by anchor IDs
              try {
                const html = await getSpineHtml(entry.spineIdx);
                for (let ei = 0; ei < sameSpineEntries.length; ei++) {
                  const e = sameSpineEntries[ei];
                  const nextE = sameSpineEntries[ei + 1];
                  let chunkHtml;
                  if (e.fragment) {
                    // Find content from this anchor to the next anchor
                    const anchorPattern = new RegExp(`id=["']${e.fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i');
                    const startMatch = html.search(anchorPattern);
                    if (startMatch >= 0) {
                      const startPos = tagStartBefore(html, startMatch);
                      let endPos = html.length;
                      if (nextE && nextE.fragment) {
                        const nextPattern = new RegExp(`id=["']${nextE.fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i');
                        const nextMatch = html.substring(startMatch + 1).search(nextPattern);
                        if (nextMatch >= 0) {
                          endPos = tagStartBefore(html, startMatch + 1 + nextMatch);
                        }
                      }
                      chunkHtml = html.substring(startPos, endPos);
                    } else {
                      chunkHtml = ''; // anchor not found
                    }
                  } else {
                    // No fragment — this entry owns the file start up to the
                    // next anchor (a failed anchor search must fall back to
                    // the whole file, not substring(0, -1)).
                    let noFragEnd = html.length;
                    if (nextE && nextE.fragment) {
                      const nextPattern = new RegExp(`id=["']${nextE.fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i');
                      const p = html.search(nextPattern);
                      if (p >= 0) noFragEnd = tagStartBefore(html, p);
                    }
                    chunkHtml = html.substring(0, noFragEnd);
                  }
                  // The group's last chunk owns all content up to the next TOC
                  // entry's target — a chapter's text often continues into the
                  // following spine file(s) when the next anchor sits mid-file
                  // (Gutenberg-split EPUBs lose the whole tail otherwise).
                  if (!nextE && chunkHtml) {
                    const nextSpineIdx = nextGroupEntry ? nextGroupEntry.spineIdx : flow.length;
                    for (let si = entry.spineIdx + 1; si < nextSpineIdx; si++) {
                      chunkHtml += '\n' + await getSpineHtml(si);
                    }
                    // If the next entry starts at a mid-file anchor AND will be
                    // processed by this anchor-split path (its own group), the
                    // head of its file before that anchor is ours. (The
                    // standard path emits whole files, so appending there
                    // would duplicate content.)
                    const nextIsAnchorGroup = nextGroupEntry && nextGroupEntry.fragment &&
                      dedupedToc[peek + 1] && dedupedToc[peek + 1].spineIdx === nextGroupEntry.spineIdx;
                    if (nextIsAnchorGroup) {
                      const nextHtml = await getSpineHtml(nextGroupEntry.spineIdx);
                      const nextAnchor = new RegExp(`id=["']${nextGroupEntry.fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i');
                      const nextPos = nextHtml.search(nextAnchor);
                      if (nextPos > 0) {
                        chunkHtml += '\n' + nextHtml.substring(0, tagStartBefore(nextHtml, nextPos));
                      }
                    }
                  }
                  const text = stripHTML(chunkHtml).trim();
                  const chEntry = {
                    title: e.title,
                    text,
                    originalIndex: entry.spineIdx,
                    fromToc: true,
                    // Keep the anchor chunk's own HTML so the oversized-chapter
                    // heading split operates on this chunk only — re-splitting
                    // the whole spine file duplicates content outside the chunk.
                    chunkHtml
                  };
                  // Carry each entry's own parentContext through to the chapter
                  if (e.parentContext) {
                    chEntry.parentContext = e.parentContext;
                  }
                  rawTocChapters.push(chEntry);
                }
              } catch (err) {
                // Fallback: emit the whole spine item as one chapter
                rawTocChapters.push({
                  title: entry.title,
                  text: spineItems[entry.spineIdx].text,
                  originalIndex: entry.spineIdx,
                  fromToc: true,
                  parentContext: entry.parentContext
                });
              }
              continue;
            }

            // Standard case: TOC entry spans spine items until next TOC entry
            const startSpine = entry.spineIdx;
            const endSpine = nextEntry ? nextEntry.spineIdx : spineItems.length;

            // Collect spine items in this TOC entry's range
            const rangeItems = [];
            for (let si = startSpine; si < endSpine; si++) {
              if (spineItems[si].text.length > 0) {
                rangeItems.push(spineItems[si]);
              }
            }

            const totalChars = rangeItems.reduce((sum, si) => sum + si.text.length, 0);

            if (totalChars > MAX_MERGE_CHARS && rangeItems.length > 1) {
              // Too large to merge — emit each spine item as its own chapter
              for (let ri = 0; ri < rangeItems.length; ri++) {
                const si = rangeItems[ri];
                let title;
                if (ri === 0) {
                  title = entry.title;
                } else {
                  title = si.title;
                  if (!title) {
                    const firstLine = si.text.split(/[.\n]/)[0].trim().substring(0, 80);
                    title = (firstLine.length > 2 && firstLine.length < 80) ? firstLine : `${entry.title} (continued)`;
                  }
                }
                const chEntry = {
                  title,
                  text: si.text,
                  originalIndex: si.spineIndex,
                  fromToc: true
                };
                if (ri === 0 && entry.parentContext) chEntry.parentContext = entry.parentContext;
                rawTocChapters.push(chEntry);
              }
            } else {
              // Normal merge
              const mergedText = rangeItems.map(si => si.text).join('\n\n').trim();
              const chEntry = {
                title: entry.title,
                text: mergedText,
                originalIndex: entry.spineIdx,
                fromToc: true
              };
              if (entry.parentContext) chEntry.parentContext = entry.parentContext;
              rawTocChapters.push(chEntry);
            }
          }
          
          // Second pass: fix empty chapters caused by image-only title pages
          // Pattern in Calibre-split EPUBs: [empty chapter title page] → [section divider with actual text]
          // When a chapter has no text, its content was absorbed into the next entry.
          // Detect: if entry[i] is empty and entry[i+1] is an ALL-CAPS section divider
          // with large text, the section divider contains entry[i]'s chapter text.
          // Solution: give the text to the empty chapter, mark the divider as empty.
          for (let i = 0; i < rawTocChapters.length - 1; i++) {
            const curr = rawTocChapters[i];
            const next = rawTocChapters[i + 1];
            
            if (curr.text.length === 0 && next.text.length > 500) {
              // Current is empty, next has substantial text
              // Check if next looks like a section divider (ALL-CAPS short title)
              const nextIsSection = /^[A-Z\s]{2,30}$/.test(next.title.trim());
              // Or check if current looks like a numbered chapter
              const currIsChapter = /^\d+\s+\w/.test(curr.title) || /^[A-Z]\s+\w/.test(curr.title) || /^chapter\s+/i.test(curr.title);
              
              if (nextIsSection || currIsChapter) {
                // Transfer text from section divider to the empty chapter
                curr.text = next.text;
                next.text = '';
              }
            }
          }
          
          // The authored TOC is the semantic boundary. Do not promote h1-h3
          // descendants inside a TOC chapter: publishers routinely use those
          // tags for subsections, quotations, statutes, and page furniture.
          // Unstructured giant spine items are repaired later by
          // splitOversizedChapters without inventing semantic headings.
          const splitChapters = rawTocChapters;

          // Forward-fill Part context across spine boundaries.
          // When one spine has PART II and the next spine has Book V but no PART,
          // carry the Part forward so disambiguation works correctly.
          let lastPartCtx = null;
          for (const ch of splitChapters) {
            if (ch.parentContext) {
              const part = ch.parentContext.find(c => /^part\s+/i.test(c));
              if (part) {
                lastPartCtx = part;
              } else if (lastPartCtx) {
                // Has context (e.g., Book) but no Part — prepend last known Part
                ch.parentContext = [lastPartCtx, ...ch.parentContext];
              }
            } else if (lastPartCtx) {
              ch.parentContext = [lastPartCtx];
            }
          }

          // Filter out entries with no text
          tocChapters = splitChapters.filter(ch => ch.text.length > 0);
          
          // Prepend any spine items before the first TOC entry (front matter)
          if (dedupedToc.length > 0 && dedupedToc[0].spineIdx > 0) {
            const preTocTexts = [];
            for (let si = 0; si < dedupedToc[0].spineIdx; si++) {
              if (spineItems[si].text.length >= 50) {
                preTocTexts.push(spineItems[si]);
              }
            }
            // Add each pre-TOC item as its own chapter with a derived title.
            // Some scanned conversions put the entire book in one oversized
            // pre-TOC file, then point their numbered TOC at tiny duplicate
            // stubs. When the page/title markup and TOC numbering agree,
            // recover those authored chapter boundaries from the giant file.
            let recoveredBundle = null;
            const oversizedPreToc = preTocTexts
              .filter(si => si.text.length >= 100000)
              .sort((a, b) => b.text.length - a.text.length)[0];
            if (oversizedPreToc) {
              recoveredBundle = recoverScannedChapterBundle({
                sourceItem: oversizedPreToc,
                html: await getSpineHtml(oversizedPreToc.spineIndex),
                tocEntries: dedupedToc,
                tocChapters
              });
            }

            const preTocChapters = preTocTexts.flatMap(si => {
              if (recoveredBundle && si === oversizedPreToc) {
                return recoveredBundle;
              }
              let title = si.title;
              if (!title) {
                title = si.heading;
              }
              if (!title) {
                const firstLine = si.text.split(/[.\n]/)[0].trim().substring(0, 80);
                title = (firstLine.length > 2 && firstLine.length < 80) ? firstLine : 'Front Matter';
              }
              return [{ title, text: si.text, originalIndex: si.spineIndex, fromToc: false }];
            });
            tocChapters = recoveredBundle
              ? preTocChapters
              : [...preTocChapters, ...tocChapters];
          }
        }
      }
      
      // --- Step 4: Fallback — spine-based extraction (no usable TOC) ---
      let rawChapters;
      if (tocChapters) {
        rawChapters = tocChapters;
      } else {
        // Build a simple TOC lookup by href
        const tocByHref = {};
        if (epub.toc) {
          for (const tocEntry of epub.toc) {
            if (tocEntry.href && tocEntry.title) {
              const hrefKey = tocEntry.href.split('#')[0].split('/').pop();
              if (!tocByHref[hrefKey]) tocByHref[hrefKey] = tocEntry.title;
              const decodedHrefKey = decodeEpubHref(hrefKey);
              if (!tocByHref[decodedHrefKey]) tocByHref[decodedHrefKey] = tocEntry.title;
            }
          }
        }
        
        rawChapters = spineItems.map((si, i) => {
          let title = si.title || tocByHref[si.href] || '';
          if (!title && si.heading && si.heading.length <= 80) {
            // In-file heading (h1-h4) — the most reliable source when the TOC
            // is unusable. Bare chapter numbers become "Chapter N".
            title = /^\d{1,3}$/.test(si.heading) ? `Chapter ${si.heading}` : si.heading;
          }
          if (!title) {
            const cleanText = si.text.trim();
            if (cleanText.length > 0 && cleanText.length < 100) {
              title = cleanText.replace(/\s+/g, ' ').substring(0, 80);
            } else if (cleanText.length >= 100) {
              const firstLine = cleanText.split(/[.\n]/)[0].trim().substring(0, 80);
              title = (firstLine.length > 2 && firstLine.length < 80) ? firstLine : `Section ${i + 1}`;
            } else {
              title = `Section ${i + 1}`;
            }
          }
          return { title, text: si.text, originalIndex: si.spineIndex, fromToc: false };
        }).filter(ch => ch.text.length >= 50 || isTitleLikeText(ch.text));
        // Sub-50-char items that read like a title ("Fiat Homo", "PART TWO")
        // are kept: Step 4b merges them forward as parentContext + spoken
        // divider text instead of silently deleting the book's part structure.
      }
      
      // --- Step 4b: Merge short chapters into next substantial chapter ---
      // Chapters under 500 chars are typically section dividers ("PART ONE"),
      // epigraphs, or formatting artifacts. Merge them forward, preserving
      // their titles as parentContext for disambiguation.
      const mergedChapters = [];
      let pendingShort = [];
      for (let i = 0; i < rawChapters.length; i++) {
        const ch = rawChapters[i];
        if (ch.text.length < 500 && !ch.fromToc) {
          pendingShort.push(ch);
        } else {
          // Attach any pending short chapters to this one
          if (pendingShort.length > 0) {
            const shortTitles = pendingShort
              .map(s => s.title)
              .filter(t => t && t.length > 0);
            const shortTexts = pendingShort
              .map(s => s.text)
              .filter(t => t.length > 0);
            if (shortTitles.length > 0) {
              ch.parentContext = [...(ch.parentContext || []), ...shortTitles];
            }
            if (shortTexts.length > 0) {
              ch.text = shortTexts.join('\n\n') + '\n\n' + ch.text;
            }
            pendingShort = [];
          }
          mergedChapters.push(ch);
        }
      }
      // If trailing short chapters remain, keep them as-is (often backmatter)
      for (const s of pendingShort) {
        mergedChapters.push(s);
      }
      rawChapters = mergedChapters;

      // --- Step 5: Classify chapter types ---
      const totalChapterCount = rawChapters.length;
      const identifiedChapters = rawChapters.map((ch, index) => {
        let chapterType = 'content';
        const t = ch.title;
        const positionRatio = totalChapterCount > 0 ? index / totalChapterCount : 0;

        if (/^(cover|title page)$/i.test(t)) {
          chapterType = 'cover';
        } else if (/^(copyright|publisher|isbn)/i.test(t)) {
          chapterType = 'copyright';
        } else if (/^(table of contents|contents)$/i.test(t)) {
          chapterType = 'toc';
        } else if (/^(preface|foreword|introduction)$/i.test(t)) {
          chapterType = 'frontmatter';
        } else if (/^prologue$/i.test(t)) {
          chapterType = ch.text.length > 500 ? 'content' : 'frontmatter';
        } else if (/^(about the author|author'?s? note|about the authors?)$/i.test(t)) {
          chapterType = 'author';
        } else if (/^(dedication|acknowledgments?|epilogue|afterword|bibliography|selected bibliography|index|glossary|appendix|scripture index|general index|source notes?|works cited|further reading|suggestions? for further reading|recommended reading|reading group guide|discussion questions?|permissions?|credits?)/i.test(t)) {
          chapterType = 'backmatter';
        } else if (/^notes?$/i.test(t) && positionRatio > 0.7) {
          // "Notes" / "Note" in the last 30% of the book → endnotes, not a chapter
          chapterType = 'backmatter';
        } else if (/^chapter\s+/i.test(t) || /^CHAPTER\s+/i.test(t)) {
          chapterType = 'chapter';
        } else if (/^(part|book|volume)\s+/i.test(t) && ch.text.length < 500) {
          chapterType = 'divider';
        } else if (/^section\s+/i.test(t) && ch.text.length < 500) {
          chapterType = 'divider';
        } else if (/^[A-Z\s]{2,30}$/.test(t) && ch.text.length < 500) {
          // ALL-CAPS short title with little text = section divider (e.g., RELATIONSHIPS, SOUL)
          chapterType = 'divider';
        } else if (/^\d+\s+\w/.test(t) || /^chapter\s+/i.test(t)) {
          chapterType = 'chapter';
        } else if (/^[A-Z]\s+/.test(t) && /appendix|resource/i.test(t)) {
          chapterType = 'backmatter';
        } else if (ch.text.length < 100) {
          chapterType = 'divider';
        }
        
        const result = {
          index,
          title: ch.title,
          text: ch.text,
          type: chapterType,
          originalIndex: ch.originalIndex
        };
        if (ch.fromToc) result.fromToc = true;
        if (ch.parentContext) result.parentContext = ch.parentContext;
        return result;
      });
      
      // --- Step 6: Disambiguate duplicate chapter titles ---
      // Books like Crime & Punishment have "Chapter 2" in Part 1, Part 2, etc.
      // War & Peace has Book One > Part 1 > Chapter I, Book Two > Part 1 > Chapter I.
      // Track both book-level and part-level context for multi-level nesting.
      const titleCounts = {};
      identifiedChapters.forEach(ch => {
        titleCounts[ch.title] = (titleCounts[ch.title] || 0) + 1;
      });
      const hasDupes = Object.values(titleCounts).some(c => c > 1);

      if (hasDupes) {
        // Use an ordered context stack to handle both Part > Book (Brothers Karamazov)
        // and Book > Part (War and Peace) hierarchies.
        let contextStack = [];  // e.g. ["PART I", "Book II"] or ["BOOK ONE", "Part 1"]
        for (const ch of identifiedChapters) {
          const t = ch.title.trim();

          // parentContext from dedup/heading-split preserves hierarchy order
          if (ch.parentContext) {
            contextStack = [...ch.parentContext];
          }

          const isBookHeader = /^book\s+/i.test(t);
          const isVolumeHeader = /^volume\s+/i.test(t);
          const isPartHeader = /^part\s+/i.test(t);
          const isAnyHeader = isBookHeader || isVolumeHeader || isPartHeader;

          // Update context from actual chapter titles
          if (isPartHeader) {
            const idx = contextStack.findIndex(c => /^part\s+/i.test(c));
            if (idx >= 0) {
              contextStack[idx] = t;
              contextStack = contextStack.slice(0, idx + 1);
            } else {
              contextStack = [t];
            }
          } else if (isBookHeader || isVolumeHeader) {
            const idx = contextStack.findIndex(c => /^(book|volume)\s+/i.test(c));
            if (idx >= 0) {
              contextStack[idx] = t;
              contextStack = contextStack.slice(0, idx + 1);
            } else {
              contextStack.push(t);
            }
          } else if (ch.type === 'divider') {
            // Generic divider — treat as innermost context level
            const idx = contextStack.findIndex(c => c === t);
            if (idx < 0) contextStack.push(t);
          }

          // If this title is duplicated and we have context, prepend it
          if (titleCounts[ch.title] > 1 && !isAnyHeader && ch.type !== 'divider') {
            const prefix = contextStack.join(' — ');
            if (prefix) {
              ch.title = `${prefix} — ${ch.title}`;
            }
          }
        }
      }
      
      // --- Step 6c: Remaining duplicates take their own first-line heading ---
      // When context prefixing couldn't disambiguate (e.g. two TOC entries with
      // the same section-page title pointing at different chapters), the
      // chapter's opening line is usually its real heading — use it if it
      // looks like a title rather than prose.
      {
        const counts = {};
        identifiedChapters.forEach(ch => {
          counts[ch.title] = (counts[ch.title] || 0) + 1;
        });
        for (const ch of identifiedChapters) {
          if (counts[ch.title] < 2) continue;
          const firstLine = (ch.text || '').split('\n')[0].trim();
          if (!firstLine || firstLine === ch.title) continue;
          const letters = (firstLine.match(/[a-zA-Z]/g) || []).length;
          const headingLike = firstLine.length >= 3 && firstLine.length <= 80 &&
            letters >= 2 && !/[.!?,;]$/.test(firstLine) &&
            !/^[a-z]/.test(firstLine) && firstLine.split(/\s+/).length <= 12;
          if (headingLike) ch.title = firstLine;
        }
      }

      // --- Step 6b: Normalize ALL-CAPS titles ---
      for (const ch of identifiedChapters) {
        ch.title = normalizeAllCapsTitle(ch.title);
      }

      // --- Step 7: Filter out truly empty items (< 50 chars with divider/cover type) ---
      // Keep them in the array but mark them so the UI can skip/dim them
      for (const ch of identifiedChapters) {
        if (ch.text.length < 50 && ['divider', 'cover', 'toc'].includes(ch.type)) {
          ch.empty = true;
        }
      }

      // --- Step 8: Estimate chapter durations ---
      // ~825 chars/min at 1x TTS speed (calibrated against actual TTS output)
      for (const ch of identifiedChapters) {
        ch.estimatedDuration = Math.round(ch.text.length / 825 * 60);
      }

    return identifiedChapters;
  } catch (error) {
    throw error;
  }
}

// A short spine item that reads like a standalone title/part divider
// ("Fiat Homo", "PART TWO") rather than stray markup or page furniture.
function isTitleLikeText(text) {
  const t = (text || '').trim().replace(/\s+/g, ' ');
  if (t.length < 2 || t.length > 60) return false;
  const letters = (t.match(/\p{L}/gu) || []).length;
  if (letters < 2 || letters / t.length < 0.5) return false;
  if (/[.!?;:,]$/.test(t)) return false;
  return t.split(' ').length <= 8;
}

function decodeEpubHref(href) {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

async function getChapterHtml(epubInstance, chapterId) {
  const html = await epubInstance.getChapter(chapterId);

  if (html && html.trim()) {
    return html;
  }

  if (typeof epubInstance.getChapterRaw === 'function') {
    let rawHtml = '';
    try {
      rawHtml = await epubInstance.getChapterRaw(chapterId);
    } catch {}
    if (rawHtml && rawHtml.trim()) {
      return rawHtml;
    }
  }

  const manifestItem = epubInstance.manifest && epubInstance.manifest[chapterId];
  if (!manifestItem || !manifestItem.href || typeof epubInstance.readFile !== 'function') {
    return '';
  }

  const hrefs = [manifestItem.href, decodeEpubHref(manifestItem.href)]
    .filter((href, index, arr) => href && arr.indexOf(href) === index);

  for (const href of hrefs) {
    let rawHtml = '';
    try {
      rawHtml = await epubInstance.readFile(href, 'utf8');
    } catch {}
    if (rawHtml && rawHtml.trim()) {
      return rawHtml;
    }
  }

  return '';
}

async function getChapterText(epubInstance, chapterId) {
  const html = await getChapterHtml(epubInstance, chapterId);
  return stripHTML(html).trim();
}

module.exports = { extractChapters, decodeEpubHref, getChapterHtml, getChapterText };

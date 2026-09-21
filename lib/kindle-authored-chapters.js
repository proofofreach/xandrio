'use strict';

const { estimateDuration } = require('./chapters/text-sanitization');

function markers(text) {
  return [...text.matchAll(/^[ \t]*CHAPTER[ \t]+(\d+|[IVXLCDM]+|THE LAST)\.?[ \t]*$/gmi)];
}
function number(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const roman = value.toUpperCase();
  if (!/^(?=[IVXLCDM]+$)M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/.test(roman)) return NaN;
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  return [...roman].reduce((sum, c, i) => sum + (values[c] < (values[roman[i + 1]] || 0) ? -values[c] : values[c]), 0);
}
function recoverKindleAuthoredChapters(chapters) {
  const contents = chapters.filter(c => c.type === 'toc').map(c => markers(c.text || '')).filter(ms => ms.length >= 3);
  if (contents.length !== 1) return chapters;
  const reference = contents[0].map(m => m[1].toUpperCase());
  if (!reference.every((label, i) => number(label) === i + 1 || (i === reference.length - 1 && label === 'THE LAST'))) return chapters;
  const output = [];
  let changed = false;
  for (let start = 0; start < chapters.length;) {
    const isBody = c => ['chapter', 'content'].includes(c.type) && !/^\s*\*\*\*\s*(?:END|START) OF/i.test(c.text || '');
    if (!isBody(chapters[start])) { output.push(chapters[start++]); continue; }
    let end = start + 1;
    while (end < chapters.length && isBody(chapters[end]) && !chapters[end].authoredBoundary) end++;
    const group = chapters.slice(start, end);
    const text = group.map(c => c.text || '').join('\n\n');
    const found = markers(text);
    const agrees = found.length === reference.length && found.every((m, i) => m[1].toUpperCase() === reference[i]);
    if (!agrees || group.length >= found.length || found.some((m, i) => (found[i + 1]?.index ?? text.length) - m.index < 300)) {
      output.push(...group); start = end; continue;
    }
    const recovered = found.map((m, i) => {
      const value = text.slice(i === 0 ? 0 : m.index, found[i + 1]?.index ?? text.length).replace(/\n\n$/, '');
      return { ...group[0], title: `Chapter ${m[1]}`, text: value, estimatedDuration: estimateDuration(value),
        type: 'chapter', authoredBoundary: true, fromToc: true, boundarySource: 'source-toc-markers-v1',
        recoveredSourceSpineIds: [...new Set(group.map(c => c.sourceSpineId).filter(id => id !== undefined))] };
    });
    if (recovered.map(c => c.text).join('\n\n') !== text) {
      output.push(...group);
    } else { output.push(...recovered); changed = true; }
    start = end;
  }
  return changed ? output.map((chapter, index) => ({ ...chapter, index })) : chapters;
}
module.exports = { recoverKindleAuthoredChapters };

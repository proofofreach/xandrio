#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizePdfText, normalizePdfPages, __test } = require('../lib/pdf-text-normalizer');
const { shouldFilterChapter } = require('../lib/chapters/classification');
const root = path.resolve(process.argv[2] || 'data/benchmarks/real-books');
const repairOnly = process.argv.find(arg => arg.startsWith('--repairs-only='))?.split('=')[1];
if (repairOnly && !['alice', 'darwin', 'walden', 'frankenstein'].includes(repairOnly)) throw new Error('Unknown work');
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const cases = [], excluded = [];
const split = name => ['darwin','alice'].includes(name) ? 'development' : 'challenge';
const add = (book, category, item) => cases.push({ id: `${book}-${category}-${cases.length}`, family: book, split: split(book), category, ...item });
for (const book of repairOnly ? [repairOnly] : ['darwin', 'walden']) {
  const raw = fs.readFileSync(path.join(root, `${book}.raw-layout.txt`),'utf8');
  const pages = raw.split('\f').map((text,i)=>({pageNumber:i+1,text}));
  const normalized = normalizePdfPages(pages).pages;
  const epub = read(`${book}.epub.extraction.json`);
  const pdfHash = read(`${book}.pdf.extraction.json`).sha256;
  const reference = epub.import.chapters.map(c=>c.text).join(' ').toLowerCase().replace(/[^a-z-]+/g,' ').trim();
  const aligned = [];
  for (const page of pages.filter(p=>p.pageNumber>=16)) {
    for (const match of page.text.matchAll(/\b([A-Za-z]{2,})-[ \t]*\n[ \t]*([a-z]{2,})/g)) {
      const [original,left,right]=match, at=match.index;
      const before = (page.text.slice(Math.max(0,at-80),at).toLowerCase().match(/[a-z]+/g)||[]).slice(-3);
      const after = (page.text.slice(at+original.length,at+original.length+80).toLowerCase().match(/[a-z]+/g)||[]).slice(0,3);
      if(before.length!==3||after.length!==3) continue;
      const joined=left+right, hyphen=left+'-'+right;
      const joinFound=reference.includes([...before,joined.toLowerCase(),...after].join(' '));
      const keepFound=reference.includes([...before,hyphen.toLowerCase(),...after].join(' '));
      if(joinFound===keepFound) continue;
      const start=page.text.lastIndexOf('\n',at-1)+1;
      const nextEnd=page.text.indexOf('\n',at+original.length);
      const end=nextEnd<0?page.text.length:nextEnd;
      const text=page.text.slice(start,end);
      const local=at-start;
      const choicesText=[joined,hyphen].map(word=>normalizePdfText(text.slice(0,local)+word+text.slice(local+original.length)).text);
      const base=normalizePdfText(text).text;
      // Keep only cases where snippet normalization is visible in actual page output.
      if(!normalized[page.pageNumber-1].text.includes(base)) continue;
      const values=[...new Set([...choicesText,base])];
      // Counterbalance option order using a stable source hash, before any model call.
      if(parseInt(hash(`${book}:${page.pageNumber}:${at}`).slice(0,2),16)%2) values.reverse();
      const choices=Object.fromEntries(values.map((value,i)=>[`option${i+1}`,value]));
      const key=value=>Object.keys(choices).find(k=>choices[k]===value);
      aligned.push({ order:hash(`${book}:${page.pageNumber}:${at}`), preserve:keepFound,
        source:{ filename:`${book}.pdf`,sha256:pdfHash,pageNumber:page.pageNumber,offset:at,original,referenceFilename:`${book}.epub`,referenceSha256:epub.sha256,referenceContext:[...before,keepFound?hyphen.toLowerCase():joined.toLowerCase(),...after].join(' ') },
        expected:key(choicesText[keepFound?1:0]),baselineRecorded:key(base),
        input:{text,choices}, rationale:'Exactly one joined/hyphenated spelling matches the same-work EPUB with three surrounding words on each side; exact raw span and reference retained.' });
    }
  }
  for(const preserve of [false,true]) {
    const pool=aligned.filter(x=>x.preserve===preserve).sort((a,b)=>a.order.localeCompare(b.order));
    for(const item of pool.slice(0,12)) { delete item.order;add(book,'repair',item); }
  }
  if (repairOnly) continue;
  const normLine=line=>line.trim().replace(/\b\d{1,5}\b/g,'#').replace(/\s+/g,' ').toLowerCase();
  const repeats=[...__test.findRepeatedHeaderFooterLines(pages)];
  for(const targetPattern of repeats.filter((_,i)=>i%Math.max(1,Math.floor(repeats.length/6))===0).slice(0,6)) {
    const occurrences=pages.filter(p=>p.text.split('\n').some(l=>normLine(l)===targetPattern));
    const target=occurrences[0].text.split('\n').find(l=>normLine(l)===targetPattern).trim();
    const base=normalized.some(p=>p.text.includes(target))?'keep':'remove';
    add(book,'cleanup',{source:{filename:`${book}.pdf`,pageNumbers:occurrences.map(p=>p.pageNumber)},expected:'remove',baselineRecorded:base,
      input:{target,pages:occurrences.slice(0,3).map(p=>({pageNumber:p.pageNumber,text:p.text.slice(0,2600)}))},rationale:'Repeated running chapter/book title with printed page number at page edge; source page positions retained.'});
  }
}
const labels={
 alice:[[0,'cover'],[2,'toc'],[3,'chapter'],[8,'chapter'],[14,'chapter'],[15,'copyright']],
 darwin:[[3,'toc'],[4,'toc'],[5,'content'],[6,'chapter'],[14,'chapter'],[20,'backmatter'],[21,'copyright']],
 walden:[[1,'toc'],[3,'content'],[8,'content'],[15,'content'],[21,'content'],[22,'copyright']],
 frankenstein:[[1,'toc'],[2,'content'],[5,'content'],[6,'chapter'],[18,'chapter'],[29,'chapter'],[30,'copyright']]
};
for(const [book,entries] of repairOnly ? [] : Object.entries(labels)) {
 const doc=read(`${book}.epub.extraction.json`);
 for(const [index,expected] of entries) {
  const chapter=doc.import.chapters[index];
  add(book,'classification',{source:{filename:`${book}.epub`,sha256:doc.sha256,chapterIndex:index},expected,baselineRecorded:chapter.type,
    effect:{baselineFiltered:shouldFilterChapter(chapter),expectedFiltered:shouldFilterChapter({...chapter,type:expected})},
    input:{chapter:{...chapter,text:chapter.text.slice(0,8000)},work:{title:book}},rationale:'Source section content: numbered chapter, main prose, contents/index, title page, or explicit full Gutenberg license. Type accuracy and filtering effect are separate.'});
 }
 const kindle=read(`${book}.azw3.extraction.json`);
 const candidates=kindle.candidates.filter(c=>c.ok).map(c=>({...c,id:c.name}));
 add(book,'selection',{source:{filename:`${book}.azw3`,sha256:kindle.sha256},expected:book==='darwin'?'kf8-primary':'neither',baselineRecorded:kindle.selected,
  input:{format:'kindle',candidates},rationale:book==='darwin'?'KF8 contains the work; fallback is a 40-character cover fragment.':'Both candidates omit book prose: KF8 chapter load failures leave only contents; MOBI fallback is a 40-character cover fragment.'});
 for(const candidate of candidates) add(book,'quality',{source:{filename:`${book}.azw3`,candidate:candidate.name},expected:book==='darwin'&&candidate.name==='kf8-primary'?'ready':'review',baselineRecorded:require('../lib/kindle-extraction').__test.classifyKindleExtractionStatus(candidate).status==='ready'?'ready':'review',input:{format:'kindle',candidate},rationale:'Full candidate audit against source: complete coherent Darwin KF8, otherwise no substantive book prose.'});
}
for(const book of repairOnly ? [] : ['darwin','walden']) {
 const doc=read(`${book}.pdf.extraction.json`);const candidate=doc.candidates.find(c=>c.name===doc.selected);
 add(book,'quality',{source:{filename:`${book}.pdf`,sha256:doc.sha256},expected:'review',baselineRecorded:doc.status.status==='ready'?'ready':'review',input:{format:'pdf',candidate},rationale:'Actual scanned text contains visible OCR/merged-word damage and rejected chapter structure.'});
 excluded.push({book,category:'selection',reason:'PDF candidates differ in layout/structure and OCR; no page-aligned completeness adjudication establishes a unique winner. No selection benefit claimed.'});
}
const result={schemaVersion:1,kind:'real-book-diagnostic',createdAt:new Date().toISOString(),sampling:'Darwin/Alice development; Walden/Frankenstein challenge. Repair: up to 12 hash-selected joined and up to 12 hyphen-preserved aligned spans per PDF; actual eligible counts vary by book. This is stratified, not natural error prevalence. Labels frozen before inference; EPUB transcription is a silver reference, not an independent human gold standard.',excluded,cases};
const target=path.join(root,repairOnly ? `frozen-repairs-${repairOnly}.json` : 'frozen-cases.json');fs.writeFileSync(target,JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({target,sha256:hash(fs.readFileSync(target)),counts:cases.reduce((o,c)=>(o[c.category]=(o[c.category]||0)+1,o),{})}));

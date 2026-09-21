#!/usr/bin/env node
'use strict';
// Live production-path validation. Public-domain sources only in this fixture corpus.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {createJevPdfRepair}=require('../lib/jev-pdf-repair');
const {extractPdfResult,reprocessPdfSourceDocument}=require('../lib/pdf-extraction');
const {exactNarrationIntegrity,proveArtifactRecovery}=require('../lib/extraction-recovery');
(async()=>{
 if(!process.argv.includes('--live'))throw Error('Explicit --live required');
 const root=path.resolve('data/benchmarks/real-books');
 const output=path.join(root,'production-path-live.json');
 try{await fs.access(output);throw Error('Output exists')}catch(e){if(e.code!=='ENOENT')throw e;}
 const rows=[];
 for(const book of ['darwin','walden','frankenstein']){
  const baseline=JSON.parse(await fs.readFile(path.join(root,`${book}.pdf.extraction.json`),'utf8'));
  const epub=JSON.parse(await fs.readFile(path.join(root,`${book}.epub.extraction.json`),'utf8'));
  const reference=epub.import.chapters.map(c=>c.text).join(' ').toLowerCase().replace(/[^a-z-]+/g,' ');
  const source=path.join(root,`${book}.pdf`);
  const sha256=crypto.createHash('sha256').update(await fs.readFile(source)).digest('hex');
  if(sha256!==baseline.sha256)throw Error('Source mismatch');
  const started=Date.now();
  const result=await extractPdfResult(source,{warn:false,repairPages:createJevPdfRepair({enabled:true,acknowledged:true,apiKey:process.env.AI_GATEWAY_API_KEY||''})});
  const doc=JSON.parse(JSON.stringify(result.sourceDocument));
  const checks=(doc.jevRepairs?.accepted||[]).map(item=>{
   const raw=doc.rawPages[item.pageIndex].text;
   const before=(raw.slice(Math.max(0,item.offset-80),item.offset).toLowerCase().match(/[a-z]+/g)||[]).slice(-3);
   const after=(raw.slice(item.offset+item.original.length,item.offset+item.original.length+80).toLowerCase().match(/[a-z]+/g)||[]).slice(0,3);
   const context=[...before,item.replacement.toLowerCase(),...after].join(' ');
   return {...item,referenceContext:context,referenceMatched:reference.includes(context)};
  });
  const rebuilt=await reprocessPdfSourceDocument(doc,{warn:false});
  const recovery=await proveArtifactRecovery({sourceFormat:'pdf',acceptedChapters:result.chapters,sourceDocument:doc});
  if (doc.pages.length!==baseline.sourceDocument.pages.length) throw Error('Page count changed');
  let insertedHyphens=0;
  for (const [index,page] of doc.pages.entries()) {
    const old=baseline.sourceDocument.pages[index];
    if(page.pageNumber!==old.pageNumber)throw Error('Page order changed');
    let i=0,j=0;
    while(j<page.text.length){
      if(i<old.text.length&&old.text[i]===page.text[j]){i++;j++;}
      else if(page.text[j]==='-'){insertedHyphens++;j++;}
      else throw Error('Unaccounted text edit');
    }
    if(i!==old.text.length)throw Error('Source text removed');
  }
  if(insertedHyphens!==checks.length)throw Error('Edit count differs from accepted decisions');
  if(!checks.every(c=>c.referenceMatched))throw Error('Accepted edit failed reference alignment');
  if(exactNarrationIntegrity(result.chapters).hash!==exactNarrationIntegrity(rebuilt).hash)throw Error('Rebuild changed narration');
  if(checks.length&&recovery.proven)throw Error('Accepted repair must retain original');
  if(doc.jevRepairs?.truncated)throw Error('Incomplete judgment pass');
  const row={book,sha256,elapsedMs:Date.now()-started,decisions:doc.jevRepairs,checks,recovery,
    textDiff:{onlyRecordedHyphensInserted:true,insertedHyphens},
    integrity:exactNarrationIntegrity(result.chapters),rebuildIntegrity:exactNarrationIntegrity(rebuilt)};
  rows.push(row);
  await fs.writeFile(path.join(root,`${book}.production-path.json`),JSON.stringify(result),{flag:'wx',mode:0o600});
  await fs.writeFile(output,JSON.stringify({createdAt:new Date().toISOString(),complete:rows.length===3,rows},null,2),{mode:0o600});
  console.log(JSON.stringify({book,attempts:doc.jevRepairs?.attempts.length,accepted:checks.length,referenceMatched:checks.filter(c=>c.referenceMatched).length,cost:doc.jevRepairs?.costUsd,elapsedMs:row.elapsedMs,rebuildMatches:row.integrity.hash===row.rebuildIntegrity.hash}));
 }
})().catch(e=>{console.error(e.message);process.exitCode=1;});

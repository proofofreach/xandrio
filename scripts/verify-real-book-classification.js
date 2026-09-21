#!/usr/bin/env node
'use strict';
// E2E source-file extraction regression: preserve every text byte and narrative
// type, while correctly labeling actual standalone Gutenberg license sections.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {createBookDocument}=require('../lib/book-document');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
(async()=>{
 const root=path.resolve(process.argv[2]||'data/benchmarks/real-books');
 const output=path.resolve(process.argv[3]||path.join(root,'classification-e2e.json'));
 const rows=[];
 for(const book of ['alice','darwin','walden','frankenstein']){
  const source=path.join(root,`${book}.epub`);
  const before=JSON.parse(await fs.readFile(`${source}.extraction.json`,'utf8'));
  if(hash(await fs.readFile(source))!==before.sha256)throw Error('Source hash mismatch');
  const doc=createBookDocument({log:{log(){},warn(){},error(){}}});
  const after=await doc.extractResult(source);
  const licenses=after.chapters.filter(c=>/^The Full Project Gutenberg[™]? License$/i.test(c.title));
  const textUnchanged=JSON.stringify(before.import.chapters.map(c=>c.text))===JSON.stringify(after.chapters.map(c=>c.text));
  const unrelatedTypesUnchanged=after.chapters.length===before.import.chapters.length&&after.chapters.every((c,i)=>/^The Full Project Gutenberg[™]? License$/i.test(c.title)||c.type===before.import.chapters[i].type);
  const correct=licenses.length===1&&licenses[0].type==='copyright';
  rows.push({book,sourceSha256:before.sha256,chapters:after.chapters.length,textSha256:hash(after.chapters.map(c=>c.text).join('\n\n')),textUnchanged,unrelatedTypesUnchanged,licenseType:licenses[0]?.type,pass:textUnchanged&&unrelatedTypesUnchanged&&correct});
 }
 const report={createdAt:new Date().toISOString(),scope:'Real EPUB files through createBookDocument, not HTTP or persistence transaction',rows,pass:rows.every(r=>r.pass)};
 await fs.writeFile(output,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify(report,null,2));if(!report.pass)process.exitCode=1;
})().catch(e=>{console.error(e.message);process.exitCode=1;});

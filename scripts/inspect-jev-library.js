#!/usr/bin/env node
'use strict';
// Local-only coverage inventory. No inference, source mutation or application cache writes.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {createBookDocument}=require('../lib/book-document');
(async()=>{
 const root=path.resolve('data/benchmarks/jev-expanded');const rows=[];const seen=new Set();
 const doc=createBookDocument({log:{log(){},warn(){},error(){}}});
 for(const file of (await fs.readdir('cache')).filter(x=>/\.(epub|mobi)$/i.test(x))){
  const source=path.resolve('cache',file);const sha=crypto.createHash('sha256').update(await fs.readFile(source)).digest('hex');if(seen.has(sha))continue;seen.add(sha);
  try{const result=await doc.extractResult(source);const cs=result.chapters;rows.push({file,sha,format:path.extname(file),chapters:cs.length,chars:cs.reduce((n,c)=>n+c.text.length,0),types:cs.reduce((o,c)=>(o[c.type]=(o[c.type]||0)+1,o),{}),generic:cs.filter(c=>/^Chapter \d+$/i.test(c.title)).length,short:cs.filter(c=>c.text.length<300).length,long:cs.filter(c=>c.text.length>90000).length,sections:cs.map(c=>({title:c.title,type:c.type,chars:c.text.length,fromToc:c.fromToc,titleSource:c.titleSource}))});}
  catch(e){rows.push({file,sha,error:e.code||e.message})}
 }
 await fs.writeFile(path.join(root,'local-library-inventory.json'),JSON.stringify({createdAt:new Date().toISOString(),scope:'Local inspection only; no excerpts uploaded',rows},null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify(rows.map(({sections,...r})=>r),null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1});

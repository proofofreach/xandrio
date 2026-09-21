#!/usr/bin/env node
'use strict';
// Failure case: a valid, newer v30 cache bypasses corrected source classification.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {createBookDocument}=require('../lib/book-document');
(async()=>{
 const root=path.resolve('data/benchmarks/real-books');
 const scratch=await fs.mkdtemp(path.join(root,'cache-migration-'));
 const source=path.join(scratch,'alice.epub');await fs.copyFile(path.join(root,'alice.epub'),source);
 const old=JSON.parse(await fs.readFile(path.join(root,'alice.epub.extraction.json'),'utf8')).import.chapters;
 const doc=createBookDocument({log:{log(){},warn(){},error(){}}});
 const cache=doc.getChapterCachePath(source);
 await fs.writeFile(cache,JSON.stringify({_cacheVersion:30,chapters:old}));
 const future=new Date(Date.now()+10000);await fs.utimes(cache,future,future);
 const chapters=await doc.getChaptersCached(source);
 assert.equal(chapters.find(c=>/^The Full Project Gutenberg[™]? License$/i.test(c.title)).type,'copyright');
 assert.equal(JSON.parse(await fs.readFile(cache,'utf8'))._cacheVersion,31);
 assert.deepEqual(chapters.map(c=>c.text),old.map(c=>c.text));
 const output=path.join(root,'cache-migration-e2e.json');await fs.writeFile(output,JSON.stringify({pass:true,source,cache,textUnchanged:true,createdAt:new Date().toISOString()},null,2),{flag:'wx'});console.log(output);
})().catch(e=>{console.error(e.message);process.exitCode=1;});

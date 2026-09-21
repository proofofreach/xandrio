#!/usr/bin/env node
'use strict';
// Run this in a fresh Node process after the importer transaction verification.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {createBookDocument}=require('../lib/book-document');
const {createXBookStore}=require('../lib/xbook-store');
const {exactNarrationIntegrity}=require('../lib/extraction-recovery');
const {repairTextArtifacts}=require('../lib/chapters/text-sanitization');
const {planNarration}=require('../lib/tts-text');
(async()=>{
 const root=path.resolve('data/benchmarks/real-books');
 const imported=JSON.parse(await fs.readFile(path.join(root,'import-transaction-e2e.json'),'utf8'));
 let networkCalls=0;globalThis.fetch=async()=>{networkCalls++;throw Error('Network forbidden during restart/read verification');};
 const rows=[];
 for(const item of imported.retention){
  const cacheDir=path.dirname(item.artifactPath);
  const identity=async p=>{const s=await fs.stat(p);return {mtimeMs:s.mtimeMs,size:s.size};};
  const store=createXBookStore({cacheDir,xbookVersion:2,getFileIdentity:identity});
  const document=createBookDocument({getXBookStore:()=>store,getFileIdentity:identity,log:{log(){},warn(){},error(){}}});
  const artifact=JSON.parse(await fs.readFile(item.artifactPath,'utf8'));
  const chapters=await document.getChaptersCached(item.artifactPath);
  const reread=await document.extractChapters(item.artifactPath);
  const stored=exactNarrationIntegrity(artifact.chapters);
  const playbackExpected=exactNarrationIntegrity(artifact.chapters.map(c=>({...c,text:repairTextArtifacts(c.text)})));
  assert.deepEqual(exactNarrationIntegrity(chapters),playbackExpected,'cold read must apply only existing playback normalization');
  const warm=await document.getChaptersCached(item.artifactPath);
  assert.deepEqual(exactNarrationIntegrity(warm),playbackExpected);
  for(const decision of artifact.sourceDocument?.jevRepairs?.accepted||[])assert.ok(chapters.some(c=>c.text.includes(decision.replacement)),'accepted compound survives playback');
  assert.deepEqual(exactNarrationIntegrity(reread),stored,'fresh extraction adapter must preserve accepted narration');
  const chunks=chapters.flatMap(c=>planNarration(c.text,{maxChars:4000}).chunks||[]);
  assert.ok(chunks.length>0&&chunks.every(c=>String(c.text||'').length<=4000));
  rows.push({book:item.book,integrity:stored,playbackIntegrity:playbackExpected,chunks:chunks.length,accepted:item.accepted,pass:true});
 }
 assert.equal(networkCalls,0);
 const output=path.join(root,'restart-e2e.json');await fs.writeFile(output,JSON.stringify({createdAt:new Date().toISOString(),pid:process.pid,networkCalls,rows,pass:true},null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify({output,pass:true,networkCalls}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});

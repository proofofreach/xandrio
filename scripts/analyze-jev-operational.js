#!/usr/bin/env node
'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {exactNarrationIntegrity}=require('../lib/extraction-recovery');
(async()=>{
 const root=path.resolve('data/benchmarks/jev-expanded'),f=JSON.parse(await fs.readFile(path.join(root,'frozen-operational.json'),'utf8')),r=JSON.parse(await fs.readFile(path.join(root,'operational-live.json'),'utf8'));assert.equal(r.complete,true);assert.equal(r.rows.length,32);
 const books=[];
 for(const format of ['epub','mobi']){
  const cs=JSON.parse(await fs.readFile(path.join(root,`carol.${format}.extraction.json`),'utf8')).import.chapters;
  const decisions=r.rows.filter(x=>x.format===format),accepted=new Set(decisions.filter(x=>x.accepted&&x.hybrid).map(x=>f.boundaries.find(y=>y.id===x.id).chapterIndex));
  const rebuilt=[];
  for(const [i,c] of cs.entries()){
   if(accepted.has(i)&&rebuilt.length){const prior=rebuilt[rebuilt.length-1];prior.text+='\n\n'+c.text;prior.sourceIndices.push(i);}else rebuilt.push({...c,sourceIndices:[i]});
  }
  assert.deepEqual(exactNarrationIntegrity(rebuilt),exactNarrationIntegrity(cs));
  const expected=format==='epub'?[[8,9],[10,11],[12,13],[14,15],[16]]:[[5,6],[7],[8,9],[10],[11,12]];
  const narrative=new Set(expected.flat()),actual=rebuilt.filter(c=>c.sourceIndices.some(i=>narrative.has(i))).map(c=>c.sourceIndices);
  books.push({format,originalSections:cs.length,finalSections:rebuilt.length,baselineNarrativeSections:expected.flat().length,finalNarrativeSections:actual.length,expectedGroups:expected,actualGroups:actual,completeFiveStaveRecovery:JSON.stringify(actual)===JSON.stringify(expected),acceptedMergeIndices:[...accepted],sourceTextUnchanged:true,decisions:decisions.length,rawCorrect:decisions.filter(x=>x.predicted===x.expected).length,hybridCorrect:decisions.filter(x=>x.hybrid===x.expected).length,corrections:decisions.filter(x=>x.baseline!==x.expected&&x.hybrid===x.expected).length,wrongMerges:decisions.filter(x=>!x.expected&&x.hybrid).length});
 }
 const report={createdAt:new Date().toISOString(),scope:'All adjacent pairs in one previously unqueried work, two formats. Simultaneous offline merge replay for new-import structure only; no saved-position/audio migration claim.',books,requestMs:r.batches.reduce((n,b)=>n+b.elapsedMs,0),timingScope:'Successful request sum includes replayed calls; observedWallMs measures final resume only, not the original failed attempt or intervening wait.',observedWallMs:(await fs.stat(path.join(root,'operational-live.json'))).mtimeMs-Date.parse(r.createdAt),costUsd:r.batches.reduce((n,b)=>n+b.costUsd,0),inputTokens:r.batches.reduce((n,b)=>n+b.usage.inputTokens,0)};
 await fs.writeFile(path.join(root,'operational-replay.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1});

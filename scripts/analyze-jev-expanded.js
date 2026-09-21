#!/usr/bin/env node
'use strict';
// Replay measured decisions through existing UI and guide-input consumers.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {splitChapterText,STRUCTURAL_TYPES,DEFAULT_SEGMENT_CHARS}=require('../lib/book-guide-service');
const {findPreferredAudioStartChapterIndex}=require('../lib/chapters/classification');
const {exactNarrationIntegrity}=require('../lib/extraction-recovery');
(async()=>{
 const root=path.resolve('data/benchmarks/jev-expanded'),f=JSON.parse(await fs.readFile(path.join(root,'frozen-structure.json'),'utf8')),r=JSON.parse(await fs.readFile(path.join(root,'structure-live.json'),'utf8'));
 assert.equal(r.complete,true);assert.equal(r.rows.length,f.roles.length+f.boundaries.length);
 const {findPreferredStartChapterIndex,chapterProgressContext}=await import('../public/js/util/chapter-labels.mjs');
 const metrics=rows=>({n:rows.length,baselineCorrect:rows.filter(x=>x.baseline===x.expected).length,rawCorrect:rows.filter(x=>x.predicted===x.expected).length,hybridCorrect:rows.filter(x=>x.hybrid===x.expected).length,corrections:rows.filter(x=>x.baseline!==x.expected&&x.hybrid===x.expected).length,regressions:rows.filter(x=>x.baseline===x.expected&&x.hybrid!==x.expected).length,abstentions:rows.filter(x=>!x.accepted).length});
 const excludedIds=['prince-mobi-37'];
 const counts={};for(const kind of ['roles','boundaries'])for(const format of ['epub','mobi'])for(const split of ['dev','test'])counts[`${kind}-${format}-${split}`]=metrics(r.rows.filter(x=>!excludedIds.includes(x.id)&&x.kind===kind&&x.format===format&&x.split===split));
 const groups=new Set(f.roles.map(x=>x.work+'.'+x.format));const consumers=[];
 const segments=cs=>cs.filter(c=>!STRUCTURAL_TYPES.has(c.type)).reduce((n,c)=>n+splitChapterText(c.text,DEFAULT_SEGMENT_CHARS).length,0);
 for(const key of groups){
  const before=JSON.parse(await fs.readFile(path.join(root,key+'.extraction.json'),'utf8')).import.chapters;
  const after=structuredClone(before);const changes=[];
  for(const item of f.roles.filter(x=>x.work+'.'+x.format===key)){
   const row=r.rows.find(x=>x.id===item.id),c=after[item.chapterIndex];
   if(excludedIds.includes(item.id))continue;
   if(row.accepted&&row.hybrid!==row.baseline){c.type=({main:'content',rights:'copyright',toc:'toc',aux:['frontmatter','backmatter','author','cover'].includes(c.type)?c.type:/notes|glossary|bibliography/i.test(c.title)?'backmatter':'frontmatter',divider:'divider'})[row.hybrid];changes.push({id:row.id,title:c.title,before:before[item.chapterIndex].type,after:c.type,correct:row.hybrid===row.expected,guideIncludedBefore:!STRUCTURAL_TYPES.has(before[item.chapterIndex].type),guideIncludedAfter:!STRUCTURAL_TYPES.has(c.type),progressBefore:chapterProgressContext(before,item.chapterIndex),progressAfter:chapterProgressContext(after,item.chapterIndex)});}
  }
  assert.deepEqual(exactNarrationIntegrity(after),exactNarrationIntegrity(before));
  consumers.push({book:key,changes,preferredStartBefore:findPreferredStartChapterIndex(before),preferredStartAfter:findPreferredStartChapterIndex(after),warmupStartBefore:findPreferredAudioStartChapterIndex(before),warmupStartAfter:findPreferredAudioStartChapterIndex(after),playableBefore:before.filter(c=>c.text.trim()).length,playableAfter:after.filter(c=>c.text.trim()).length,guideSegmentsBefore:segments(before),guideSegmentsAfter:segments(after),guideEligible:['meditations','liberty','souls','prince'].some(b=>key.startsWith(b+'.')),textUnchanged:true});
 }
 const boundaryRows=r.rows.filter(x=>x.kind==='boundaries');const merges=[];
 for(const row of boundaryRows.filter(x=>x.accepted&&x.hybrid)){
  const item=f.boundaries.find(x=>x.id===row.id),key=item.work+'.'+item.format;
  const cs=JSON.parse(await fs.readFile(path.join(root,key+'.extraction.json'),'utf8')).import.chapters;const i=item.chapterIndex;
  const merged=[...cs.slice(0,i-1),{...cs[i-1],text:cs[i-1].text+'\n\n'+cs[i].text},...cs.slice(i+1)];
  assert.deepEqual(exactNarrationIntegrity(merged),exactNarrationIntegrity(cs));
  merges.push({id:row.id,correct:row.expected,chaptersBefore:cs.length,chaptersAfter:merged.length,mergedChars:merged[i-1].text.length,textUnchanged:true});
 }
 const report={createdAt:new Date().toISOString(),scope:'Offline consumer replay, no import integration or TTS/audio quality claim',primaryExclusions:excludedIds,exclusionReason:'Post-freeze independent review found overlapping rights/aux criteria; original frozen label and raw results preserved.',allProbeCounts:metrics(r.rows),counts,consumers,merges,costUsd:r.batches.reduce((n,b)=>n+(b.costUsd||0),0),inputTokens:r.batches.reduce((n,b)=>n+(b.usage?.inputTokens||0),0),requestLatencyMs:r.batches.map(b=>b.elapsedMs),pacingExcluded:true};
 await fs.writeFile(path.join(root,'consumer-replay.json'),JSON.stringify(report,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1});

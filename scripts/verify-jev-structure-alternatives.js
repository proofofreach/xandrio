#!/usr/bin/env node
'use strict';
// Real source alternatives: test whether available markup already solves the problem.
// Failure gates: missing/duplicate markers, changed text, invented reference boundaries.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {exactNarrationIntegrity}=require('../lib/extraction-recovery');
const {parseEpub}=require('../lib/epub-parser');
const {getChapterHtml}=require('../lib/chapter-extraction');
const {stripHTML}=require('../lib/chapter-utils');
(async()=>{
 const root=path.resolve('data/benchmarks/jev-expanded');
 const mobi=JSON.parse(await fs.readFile(path.join(root,'huck.mobi.extraction.json'),'utf8')).import.chapters;
 const epub=JSON.parse(await fs.readFile(path.join(root,'huck.epub.extraction.json'),'utf8')).import.chapters;
 const body=mobi.slice(5,21),text=body.map(c=>c.text).join('\n\n');
 const markers=[...text.matchAll(/^[ \t]*CHAPTER (?:[IVXLCDM]+\.|THE LAST\.?)[ \t]*$/gm)];
 assert.equal(markers.length,43,'source must expose all 43 authored chapters');
 const reference=epub.filter(c=>/^Chapter (?:[IVXLCDM]+\.|The Last)$/i.test(c.title));
 assert.equal(reference.length,43);assert.equal(new Set(markers.map(m=>m[0])).size,43);
 // Existing narrative prefix belongs to the first chapter; no text is discarded.
 const rebuilt=markers.map((m,i)=>({title:m[0],text:text.slice(i===0?0:m.index,i+1<markers.length?markers[i+1].index:text.length).replace(/\n\n$/,'')}));
 // Removing exactly one separator per boundary restores the same narration join.
 assert.deepEqual(exactNarrationIntegrity(rebuilt),exactNarrationIntegrity(body));
 const source=await parseEpub(path.join(root,'leaves.epub'));let blocks=0,flattened=0;const examples=[];
 for(const item of source.flow){
  const html=await getChapterHtml(source,item.id);
  for(const m of html.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi)){
   const before=m[1].split(/\n/).map(x=>x.trim()).filter(Boolean);if(before.length<2)continue;blocks++;
   const after=stripHTML(m[0]).split(/\n/).map(x=>x.trim()).filter(Boolean);
   if(after.length<before.length){flattened++;if(examples.length<2)examples.push({spineId:item.id,beforeLines:before.length,afterLines:after.length});}
  }
 }
 const report={createdAt:new Date().toISOString(),huck:{baselineNarrativeSections:body.length,sourceAuthoredChapters:43,reconstructedChapters:rebuilt.length,textUnchanged:true,jevCallsNeeded:0,reason:'All boundaries are explicit unique CHAPTER markers; EPUB independently confirms43.'},leaves:{preBlocks:blocks,blocksLosingExplicitLineBreaks:flattened,examples,jevCallsNeeded:0,reason:'Original pre markup already contains exact authored line breaks; no semantic inference is needed to preserve them.'},scope:'Offline source reconstruction diagnostic only; no production edits or measured audio-quality improvement'};
 await fs.writeFile(path.join(root,'deterministic-structure-e2e.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1});

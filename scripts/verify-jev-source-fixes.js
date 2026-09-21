#!/usr/bin/env node
'use strict';
// Source E2E failure gates written before implementation: narration loss/reorder,
// TOC mismatch, repeated markers, existing authored cuts, script leakage, ordinary wraps.
const fs=require('node:fs/promises'),assert=require('node:assert/strict'),path=require('node:path');
const {stripHTML}=require('../lib/chapter-utils');
const {recoverKindleAuthoredChapters}=require('../lib/kindle-authored-chapters');
const {exactNarrationIntegrity}=require('../lib/extraction-recovery');
(async()=>{
 assert.equal(stripHTML('<p>one\ntwo</p>'),'one two');
 assert.equal(stripHTML('<pre>one\ntwo\n\nthree</pre>'),'one\ntwo\n\nthree');
 assert.ok(!stripHTML('<pre>one<script>evil()</script>\ntwo</pre>').includes('evil'));
 const root=path.resolve('data/benchmarks/jev-expanded');const d=JSON.parse(await fs.readFile(path.join(root,'huck.mobi.extraction.json'),'utf8')),cs=d.import.chapters;
 const out=recoverKindleAuthoredChapters(cs);assert.deepEqual(exactNarrationIntegrity(out),exactNarrationIntegrity(cs));assert.equal(out.filter(x=>x.boundarySource==='source-toc-markers-v1').length,43);
 const bad=structuredClone(cs);bad[3].text=bad[3].text.replace('CHAPTER II.','CHAPTER V.');assert.deepEqual(recoverKindleAuthoredChapters(bad),bad);
 const protectedCuts=structuredClone(cs);protectedCuts[6].authoredBoundary=true;assert.deepEqual(recoverKindleAuthoredChapters(protectedCuts),protectedCuts);
 const {parseEpub}=require('../lib/epub-parser'),{getChapterHtml}=require('../lib/chapter-extraction');const epub=await parseEpub(path.join(root,'leaves.epub'));let checked=0;
 for(const entry of epub.flow){const html=await getChapterHtml(epub,entry.id);for(const match of html.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi)){const lines=match[1].split('\n').map(x=>stripHTML(x)).filter(Boolean);if(lines.length<2)continue;const actual=stripHTML(match[0]).split('\n').filter(x=>x.trim());assert.ok(actual.length>=lines.length);checked++;}}
 const report={createdAt:new Date().toISOString(),huck:{authoredChapters:43,narrationUnchanged:true,mismatchedTocRejected:true,authoredCutsPreserved:true},leaves:{preBlocksChecked:checked},ordinaryHtmlWrapPreserved:true,scriptsRemoved:true};await fs.writeFile(path.join(root,'source-fixes-e2e.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
})().catch(e=>{console.error(e);process.exitCode=1});

#!/usr/bin/env node
'use strict';
// Post-diagnosis deterministic comparator, frozen before start-selection inference.
// Uses source markers, not gold labels. This is not a production implementation.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {findPreferredAudioStartChapterIndex}=require('../lib/chapters/classification');
function choose(chapters){
 const eligible=chapters.map((c,i)=>({c,i})).filter(({c})=>!['toc','copyright','cover'].includes(c.type)&&c.text.trim().length>=100&&!/^The Project Gutenberg eBook/i.test(c.text.trim())&&!/^\*\*\* END OF/i.test(c.text.trim()));
 for(const {c,i} of eligible){const opening=c.text.slice(0,600);if(/\b(?:chapter|stave|book)\s+(?:one|1|i)\b|\b(?:his|the) first book\b|^\s*I\.\s/i.test(opening))return i;}
 for(const {c,i} of eligible){if(['content','chapter'].includes(c.type)&&!/^\s*(?:illustrations|introduction|preface|forethought|dedication)\b/i.test(c.title))return i;}
 return findPreferredAudioStartChapterIndex(chapters);
}
(async()=>{
 const root=path.resolve('data/benchmarks/jev-expanded'),f=JSON.parse(await fs.readFile(path.join(root,'frozen-start.json'),'utf8'));const rows=[];
 for(const r of f.rows){const cs=JSON.parse(await fs.readFile(path.join(root,r.id.replace(/-(epub|mobi)$/,'.$1')+'.extraction.json'),'utf8')).import.chapters;const predicted=choose(cs.slice(0,24));rows.push({id:r.id,predicted,expected:r.expected,correct:r.expected.includes(predicted)});}
 const report={createdAt:new Date().toISOString(),scope:'Adaptive marker-based comparator, frozen before Jev start inference. Not a held-out generalization result or shipped fix.',scriptSha256:crypto.createHash('sha256').update(await fs.readFile(__filename)).digest('hex'),rows,correct:rows.filter(r=>r.correct).length};await fs.writeFile(path.join(root,'start-rule-comparator.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1});

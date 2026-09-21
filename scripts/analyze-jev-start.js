#!/usr/bin/env node
'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve('data/benchmarks/jev-expanded'),read=async name=>JSON.parse(await fs.readFile(path.join(root,name+'.json'),'utf8'));
 const f=await read('frozen-start'),r=await read('start-live'),rules=await read('start-rule-comparator');assert.ok(r.rows.length>0&&r.rows.length<=18);
 const tested=new Set(r.rows.map(x=>x.id)),matchedRules=rules.rows.filter(x=>tested.has(x.id));
 for(const row of f.rows)assert.ok(row.expected.every(i=>row.sections.some(s=>s.index===i)));
 const counts=rows=>Object.fromEntries(['baseline','warmupBaseline','predicted','hybrid','warmupHybrid'].map(k=>[k,rows.filter(x=>x.expected.includes(x[k])).length]));
 const report={createdAt:new Date().toISOString(),scope:'Adaptive preferred-start diagnostic on 9 public works in paired formats; not independent held-out evidence.',complete:r.complete,planned:f.rows.length,count:r.rows.length,unrun:f.rows.filter(x=>!tested.has(x.id)).map(x=>x.id),correct:counts(r.rows),byFormat:Object.fromEntries(['epub','mobi'].map(format=>[format,counts(r.rows.filter(x=>x.id.endsWith('-'+format)))])),accepted:r.rows.filter(x=>x.accepted).length,corrections:r.rows.filter(x=>!x.expected.includes(x.baseline)&&x.expected.includes(x.hybrid)).length,regressions:r.rows.filter(x=>x.expected.includes(x.baseline)&&!x.expected.includes(x.hybrid)).length,ruleCorrectOnTestedSubset:matchedRules.filter(x=>x.correct).length,ruleCorrectFullPlannedSet:rules.correct,jevVersusRules:{wins:r.rows.filter(x=>x.expected.includes(x.hybrid)&&!rules.rows.find(y=>y.id===x.id).correct).map(x=>x.id),losses:r.rows.filter(x=>!x.expected.includes(x.hybrid)&&rules.rows.find(y=>y.id===x.id).correct).map(x=>x.id)},candidateCoverage:18,successfulRequestMs:r.batches.filter(b=>b.status==='ok').map(b=>b.elapsedMs),failedAttempts:r.batches.filter(b=>b.status==='error'),successfulReportedCostUsd:r.batches.filter(b=>b.status==='ok').reduce((n,b)=>n+Number(b.gateway.cost),0),failedAttemptCostUsd:null,rows:r.rows};
 await fs.writeFile(path.join(root,'start-summary.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1});

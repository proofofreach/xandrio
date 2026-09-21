#!/usr/bin/env node
'use strict';
// Freeze actual production-shaped verifier inputs, including composed fields/questions.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {materialVerificationItems}=require('../lib/book-guide-service');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
(async()=>{
 const root=path.resolve('data/benchmarks/jev-expanded');const old=JSON.parse(await fs.readFile(path.join(root,'frozen-verification.json'),'utf8'));const rows=[];
 const defs={
 prince:[
 ['The author distinguishes principalities from republics and discusses how hereditary rule can be preserved.',true],
 ['The author seeks to prove that hereditary rulers can never lose power.',false],
 ['A new principality may be acquired through fortune or ability.',true],
 ['Every principality is hereditary and none is newly acquired.',false],
 ['Hereditary rule is comparatively easier to retain, but not invulnerable to extraordinary force.',true],
 ['Hereditary rule and its limits',true],
 ['A hereditary prince of average ability can retain power if he respects ancestral customs and acts prudently.',true],
 ['Subjects obey hereditary princes because every hereditary prince is morally perfect.',false],
 ['The Duke of Ferrara illustrates the advantage of being long established in a domain.',true],
 ['A hereditary prince faces no possible exception to the rule that his state is secure.',false],
 ['Therefore the text recommends that every new prince immediately invade Spain.',false],
 ['The chapter on hereditary principalities explains why they are relatively easier to maintain.',true],
 ['It argues that subjects must always hate hereditary princes.',false],
 ['Mandatory democratic elections for hereditary princes',false],
 ['Why does the author consider hereditary states easier to retain than new ones?',true],
 ['Because all hereditary rulers have unlimited armies and cannot be displaced.',false]
 ],
 liberty:[
 ['The essay examines the legitimate limits of social power over individual liberty.',true],
 ['The essay aims to resolve the metaphysical dispute about freedom of the will.',false],
 ['The author distinguishes liberty of opinion from unrestricted action.',true],
 ['Any harmful action must remain immune from all social interference.',false],
 ['Opinions can lose immunity when their expression becomes a positive instigation to harm.',true],
 ['The limits of social authority',true],
 ['Civil liberty concerns the power society may legitimately exercise over individuals.',true],
 ['Society must forbid all criticism of corn-dealers, regardless of context.',false],
 ['The same opinion may be treated differently in print and when delivered to an excited mob.',true],
 ['Freedom of action is unconditional, even when another person is harmed.',false],
 ['Therefore the author demands the permanent abolition of every newspaper.',false],
 ['The introductory chapter defines the essay’s subject as Civil or Social Liberty.',true],
 ['It identifies metaphysical free will as the essay’s central subject.',false],
 ['Liberty and Authority',true],
 ['Why does the author demand punishment whenever an opinion about corn-dealers appears in print?',false],
 ['Because merely printing any criticism is always a direct incitement to violence.',false]
 ]};
 for(const [work,pairs] of Object.entries(defs)){
  const originals=old.rows.filter(r=>r.work===work);rows.push(...originals.map(r=>({...r,itemClass:'extracted-claim-probe'})));
  const evidence=[...new Set(originals.map(r=>r.evidence))];const claims=evidence.map((e,i)=>({anchor:{id:'a'+i},evidence:e}));const anchors=claims.map(c=>c.anchor.id);
  const t=i=>({text:pairs[i][0],anchorIds:anchors});
  const guide={orientation:{thesis:t(0),problem:t(1),takeaways:[t(2),t(3)],bottomLine:t(4)},coreIdeas:[{anchorIds:anchors,...Object.fromEntries(['title','claim','howItWorks','support','qualifications','implications'].map((f,i)=>[f,pairs[i+5][0]]))}],chapterMap:[{status:'mapped',anchorIds:anchors,purpose:pairs[11][0],contributions:[pairs[12][0]],concepts:[pairs[13][0]]}],review:{questions:[{anchorIds:anchors,question:pairs[14][0],answer:pairs[15][0]}]}};
  const items=materialVerificationItems(guide,claims);if(items.length!==16)throw Error('Expected16materialfields');
  for(const [i,item] of items.entries())rows.push({...item,id:work+'-'+item.id,work,split:'production-shape-challenge',expected:pairs[i][1],itemClass:'composed-'+item.path,evidenceSha256:hash(item.evidence),origin:'Agent-authored compound-field/false-premise control, transformed by actual materialVerificationItems',sourceSpans:originals.filter((r,j)=>j===0||j===4).map(r=>({chapterIndex:r.chapterIndex,sourceSha256:r.sourceSha256,evidenceOffset:r.evidenceOffset,evidenceSha256:r.evidenceSha256}))});
 }
 await fs.writeFile(path.join(root,'frozen-guide-shape.json'),JSON.stringify({createdAt:new Date().toISOString(),thresholds:{acceptProbability:0.95,rejectProbability:0.05},scope:'Two24-item same-book batches: eight claim probes plus16 composed fields from actual production materialVerificationItems. Labels authored before inference; not natural guide error prevalence or certification.',rows},null,2),{flag:'wx',mode:0o600});console.log(rows.length);
})().catch(e=>{console.error(e.message);process.exitCode=1});

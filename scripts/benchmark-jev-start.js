#!/usr/bin/env node
'use strict';
// Existing preferred-start decision. Failure modes: title-only false chapter1,
// truncated candidate coverage, frontmatter selection, later poem selected, invalid index.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {findPreferredAudioStartChapterIndex}=require('../lib/chapters/classification');
const root=path.resolve('data/benchmarks/jev-expanded'),hash=x=>crypto.createHash('sha256').update(x).digest('hex');
(async()=>{
 const frozenPath=path.join(root,'frozen-start.json');
 if(process.argv.includes('--freeze')){
  const {findPreferredStartChapterIndex}=await import('../public/js/util/chapter-labels.mjs');
  const gold={huck:[[4],[5]],leaves:[[1],[4]],meditations:[[4,5],[4,5]],prince:[[9],[9]],souls:[[2],[4]],sherlock:[[1],[4]],moby:[[5],[5]],liberty:[[5],[5]],carol:[[8],[5]]};const rows=[];
  for(const [work,expected] of Object.entries(gold))for(const [fi,format] of ['epub','mobi'].entries()){
   const d=JSON.parse(await fs.readFile(path.join(root,`${work}.${format}.extraction.json`),'utf8')),cs=d.import.chapters;
   rows.push({id:work+'-'+format,work,format,expected:expected[fi],sourceSha256:d.sha256,baseline:findPreferredStartChapterIndex(cs),warmupBaseline:findPreferredAudioStartChapterIndex(cs),totalSections:cs.length,sections:cs.slice(0,24).map((c,i)=>({id:'s'+i,index:i,title:c.title.slice(0,180),opening:c.text.slice(0,450),characters:c.text.length}))});
  }
  await fs.writeFile(frozenPath,JSON.stringify({createdAt:new Date().toISOString(),policy:'Start first main authored chapter/story/poem, preferring chapter1 when present; skip title/legal/navigation/editorial introduction. Authored narrative prologues may count. Meditations accepts either its first-book prelude or first full book.',candidateRule:'First24sections in source order, or all if fewer; none if main start absent. All18gold starts present; no claim beyond this corpus.',threshold:0.9,rows},null,2),{flag:'wx'});console.log('Frozen18book-format start decisions');return;
 }
 if(!process.argv.includes('--live'))throw Error('--freeze or --live required');
 const output=path.join(root,'start-live.json');try{await fs.access(output);throw Error('Output exists')}catch(e){if(e.code!=='ENOENT')throw e;}
 const raw=await fs.readFile(frozenPath,'utf8'),f=JSON.parse(raw),{createGateway,experimental_evaluate}=await import('ai');
 const report={createdAt:new Date().toISOString(),sourceSha256:hash(raw),scriptSha256:hash(await fs.readFile(__filename)),complete:false,batches:[],rows:[]};
 const cache=process.argv.includes('--resume')?JSON.parse(await fs.readFile(path.join(root,'start-live-incomplete.json'),'utf8')):null;
 if(cache&&cache.sourceSha256!==hash(raw))throw Error('Resume input changed');
 for(let offset=0;offset<f.rows.length;offset+=3){
  if(cache&&offset<cache.rows.length){report.batches.push({...cache.batches[offset/3],replayed:true});report.rows.push(...cache.rows.slice(offset,offset+3));continue;}
  if(cache)await new Promise(r=>setTimeout(r,60000));
  const items=f.rows.slice(offset,offset+3),state={books:Object.fromEntries(items.map((r,i)=>['b'+i,{sections:r.sections}]))};
  const questions=Object.fromEntries(items.map((r,i)=>['q'+i,{type:'choice',instructions:`Choose where automatic reading should start in books.b${i}.sections: the first main authored chapter, story or poem, preferring genuine chapter1 when present. Skip publication/license notices, title pages, contents, dedication and editorial introductions. Preserve an authored narrative prologue when it begins the story. A generic Chapter1 label does not override legal text. A poem title beginning with the word I is not a numbered chapter. Use contents and opening text as evidence. Return none if no suitable start is in the candidates.`,criteria:{...Object.fromEntries(r.sections.map(s=>[s.id,`Start at section ${s.index}, whose source title and opening are given in books.b${i}.sections.`])),none:'The main authored reading start is absent or cannot be determined from these candidates.'}}]));
  const started=performance.now();
  try{
   const result=await experimental_evaluate({model:createGateway({apiKey:process.env.AI_GATEWAY_API_KEY}).evaluationModel('typesafe-ai/jev'),state,questions,maxRetries:0,abortSignal:AbortSignal.timeout(45000),providerOptions:{gateway:{only:['typesafe-ai']}}});
   const g=result.providerMetadata?.gateway;if(g?.routing?.canonicalSlug!=='typesafe-ai/jev'||g.routing.finalProvider!=='typesafe-ai')throw Error('Route mismatch');
   const batch={elapsedMs:performance.now()-started,state,questions,answers:result.answers,confidence:result.providerMetadata?.typesafe?.confidence,usage:result.usage,gateway:g,status:'ok'};report.batches.push(batch);
   for(const [i,r] of items.entries()){
    const a=result.answers['q'+i],c=batch.confidence?.['q'+i];if(a?.type!=='choice'||!Object.hasOwn(questions['q'+i].criteria,a.choice)||!Number.isFinite(c))throw Error('Invalid choice');
    const predicted=a.choice==='none'?null:Number(a.choice.slice(1)),accepted=predicted!==null&&c>=f.threshold;
    report.rows.push({id:r.id,expected:r.expected,baseline:r.baseline,warmupBaseline:r.warmupBaseline,predicted,confidence:c,accepted,hybrid:accepted?predicted:r.baseline,warmupHybrid:accepted?predicted:r.warmupBaseline});
   }
  }catch(e){report.batches.push({status:'error',code:e.name,elapsedMs:performance.now()-started});await fs.writeFile(output,JSON.stringify(report,null,2));throw Error('Incomplete start run saved');}
  await fs.writeFile(output,JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({offset,count:items.length,status:'ok'}));
  if(!cache&&offset+3<f.rows.length)await new Promise(r=>setTimeout(r,30000));
 }
 report.complete=true;await fs.writeFile(output,JSON.stringify(report,null,2),{mode:0o600});
})().catch(e=>{console.error(e.message);process.exitCode=1});

#!/usr/bin/env node
'use strict';
// Isolated benchmark only. Failure modes are frozen in docs/plans/jev-expanded-assessment.md.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve('data/benchmarks/jev-expanded');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const criteria={main:'Authored substantive reading: narrative, argument, poems including very short poems, epilogues that complete the story, or quotations forming part of the literary work.',rights:'Publisher/distributor legal, license or digital-edition production notices; not a discussion of law within the work.',toc:'A navigation list of contents or section titles; not substantive reading.',aux:'Title/author-only page, dedication, editorial/transcriber notes, footnotes/endnotes, glossary or bibliography. Preserve it separately; this label does not authorize deletion.',divider:'Only a part/book/volume heading with no substantive authored text. A heading followed by even a short poem is main, not divider.'};
async function run(){
 if(!process.argv.includes('--live'))throw Error('Explicit --live required');
 const operational=process.argv.includes('--operational');
 const output=path.join(root,operational?'operational-live.json':'structure-live.json');try{await fs.access(output);throw Error('Output exists')}catch(e){if(e.code!=='ENOENT')throw e;}
 const frozenText=await fs.readFile(path.join(root,operational?'frozen-operational.json':'frozen-structure.json'),'utf8'),frozen=JSON.parse(frozenText);
 const {createGateway,experimental_evaluate}=await import('ai');
 const apiKey=process.env.AI_GATEWAY_API_KEY;if(!apiKey)throw Error('Missing Gateway key');
 const cache=JSON.parse(await fs.readFile(path.join(root,operational?'operational-live-incomplete.json':'structure-live-incomplete.json'),'utf8').catch(()=>'{"batches":[],"rows":[]}'));
 const batches=[];
 for(const kind of ['roles','boundaries']){
  const groups=new Map();for(const item of frozen[kind]){const key=item.work+'-'+item.format;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
  for(const items of groups.values())for(let i=0;i<items.length;i+=6)batches.push({kind,items:items.slice(i,i+6)});
 }
 const report={createdAt:new Date().toISOString(),frozenSha256:hash(frozenText),scriptSha256:hash(await fs.readFile(__filename)),model:'typesafe-ai/jev',aliasPinned:false,complete:false,batches:[],rows:[]};
 for(const batch of batches){
  const state={sections:Object.fromEntries(batch.items.map((r,i)=>['s'+i,r.state]))};
  const questions=Object.fromEntries(batch.items.map((r,i)=>['q'+i,batch.kind==='roles'?{type:'choice',instructions:`Classify sections.s${i} by its actual contents and literary role. Title keywords alone are insufficient. Mixed title-plus-substantive authored text is main; notes mixed with navigation remain auxiliary.`,criteria}:{type:'boolean',instructions:`Should sections.s${i}.currentStart be joined to the preceding section as a continuation of the SAME authored chapter? Only merge an accidental extraction split, not distinct chapters, poems, footnotes or editorial sections. Topic similarity alone is insufficient. A generic generated Chapter N title is not proof of an authored boundary.`,criteria:{true:'Clear continuation of the same authored chapter; no new authored section begins.',false:'A new authored section, poem, notes section or chapter begins, or evidence is insufficient to merge.'}}]));
  const request={state,questions};const cached=cache.batches.find(b=>b.status==='ok'&&b.requestHash===hash(JSON.stringify(request)));
  if(cached){report.batches.push({...cached,replayed:true});report.rows.push(...cache.rows.filter(r=>batch.items.some(i=>i.id===r.id)));continue;}
  await new Promise(resolve=>setTimeout(resolve,30000));
  const started=performance.now();let row;
  try{
   const r=await experimental_evaluate({model:createGateway({apiKey}).evaluationModel('typesafe-ai/jev'),...request,maxRetries:0,abortSignal:AbortSignal.timeout(45000),providerOptions:{gateway:{only:['typesafe-ai']}}});
   const g=r.providerMetadata?.gateway,route=g?.routing,cost=Number(g?.cost);
   if(route?.canonicalSlug!=='typesafe-ai/jev'||route?.finalProvider!=='typesafe-ai'||route?.modelAttemptCount!==1||route?.totalProviderAttemptCount!==1||g?.cost===undefined||!Number.isFinite(cost)||!Number.isSafeInteger(r.usage?.inputTokens))throw Error('Invalid routing/accounting');
   row={kind:batch.kind,request,requestHash:hash(JSON.stringify(request)),elapsedMs:performance.now()-started,answers:r.answers,confidence:r.providerMetadata?.typesafe?.confidence,usage:r.usage,costUsd:cost,routing:route,status:'ok'};
   for(const [i,item] of batch.items.entries()){
    const a=r.answers['q'+i],confidence=row.confidence?.['q'+i];let predicted,accepted;
    if(batch.kind==='roles'){
     if(a?.type!=='choice'||!Object.hasOwn(criteria,a.choice)||!Number.isFinite(confidence))throw Error('Invalid choice');
     predicted=a.choice;accepted=confidence>=frozen.thresholds.choiceConfidence;
    }else{
     if(a?.type!=='boolean'||!Number.isFinite(a.probability)||a.probability<0||a.probability>1)throw Error('Invalid boolean');
     predicted=a.probability>=0.5;accepted=a.probability>=frozen.thresholds.mergeProbability||a.probability<=1-frozen.thresholds.mergeProbability;
    }
    report.rows.push({id:item.id,work:item.work,format:item.format,split:item.split,kind:batch.kind,expected:item.expected,baseline:item.baseline,predicted,accepted,hybrid:accepted?predicted:item.baseline,confidence,probability:a.probability});
   }
  }catch(e){row={kind:batch.kind,requestHash:hash(JSON.stringify(request)),elapsedMs:performance.now()-started,status:'error',code:e.name,statusCode:e.statusCode,detail:String(e.message||'').replaceAll(apiKey,'[redacted]').slice(0,600)};report.batches.push(row);await fs.writeFile(output,JSON.stringify(report,null,2));throw Error('Batch failed; incomplete report saved');}
  report.batches.push(row);await fs.writeFile(output,JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({kind:batch.kind,count:batch.items.length,ms:Math.round(row.elapsedMs),cost:row.costUsd}));
 }
 report.complete=true;await fs.writeFile(output,JSON.stringify(report,null,2),{mode:0o600});
}
run().catch(e=>{console.error(e.message);process.exitCode=1});

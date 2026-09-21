#!/usr/bin/env node
'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {createPpqBookGuideProvider}=require('../lib/book-guide-provider');
const root=path.resolve('data/benchmarks/jev-expanded'),hash=x=>crypto.createHash('sha256').update(x).digest('hex');
(async()=>{
 if(!process.argv.includes('--live'))throw Error('--live required');const mode=process.argv.includes('--baseline')?'baseline':'jev';const guideShape=process.argv.includes('--guide-shape');const generous=process.argv.includes('--generous-baseline');
 const output=path.join(root,`${guideShape?'guide-shape':'verification'}-${mode}${generous?'-6000-token-control':''}.json`);try{await fs.access(output);throw Error('Output exists')}catch(e){if(e.code!=='ENOENT')throw e;}
 const raw=await fs.readFile(path.join(root,guideShape?'frozen-guide-shape.json':'frozen-verification.json'),'utf8'),frozen=JSON.parse(raw);
 const report={createdAt:new Date().toISOString(),mode,sourceSha256:hash(raw),scriptSha256:hash(await fs.readFile(__filename)),complete:false,batches:[],rows:[]};
 const config=JSON.parse(await fs.readFile('data/book-guide-config.json','utf8'));let accounting,rawProviderResponse;
 const provider=mode==='baseline'?createPpqBookGuideProvider({apiKey:JSON.parse(await fs.readFile('data/book-guide-provider.json','utf8')).apiKey,timeoutMs:60000,fetchImpl:async(...args)=>{
  if(generous){const body=JSON.parse(args[1].body);body.max_tokens=6000;args[1]={...args[1],body:JSON.stringify(body)};}
  const response=await fetch(...args);if(response.ok){const d=await response.clone().json();rawProviderResponse=d;accounting={usage:d.usage,model:d.model,finishReason:d.choices?.[0]?.finish_reason,maxOutputTokens:generous?6000:1500,cost:d.cost??d.usage?.cost??null};}return response;
 }}):null;
 const {createGateway,experimental_evaluate}=await import('ai');
 const works=[...new Set(frozen.rows.map(r=>r.work))].filter(w=>!generous||w==='liberty');
 const cache=process.argv.includes('--resume')?JSON.parse(await fs.readFile(output.replace('.json','-incomplete.json'),'utf8')):null;
 if(cache&&cache.sourceSha256!==hash(raw))throw Error('Resume input changed');
 for(const work of works){
  const prior=cache?.batches.find(b=>b.work===work&&b.status==='ok');
  if(prior){report.batches.push({...prior,replayed:true});const ids=new Set(frozen.rows.filter(r=>r.work===work).map(r=>r.id));report.rows.push(...cache.rows.filter(r=>ids.has(r.id)));continue;}
  if(cache)await new Promise(r=>setTimeout(r,60000));
  const items=frozen.rows.filter(r=>r.work===work);const started=performance.now();let batch;
  try{
   if(mode==='baseline'){
    const claims=items.map(r=>({claimId:r.id,statement:r.statement,evidence:r.evidence}));
    const prompt=['Verify every claim strictly against its evidence. Return JSON only:','{"verdicts":[{"claimId":"...","supported":true|false}]}.','Mark false for dropped qualifiers, causal inversion, scope inflation, entity conflation, or any unsupported material detail.',JSON.stringify({claims})].join('\n');
    let result,productionAccepted=true;
    try{result=await provider.generate({baseUrl:config.baseUrl,modelSnapshot:config.verifier,prompt,purpose:'verification'});}
    catch(e){
      // Benchmark-only alias adjudication. Official PPQ model catalog archived alongside results.
      // Production remains unchanged and still rejects this response.
      if(e.code!=='BOOK_GUIDE_MODEL_SUBSTITUTED'||e.actualModel!=='z-ai/glm-5.2')throw e;
      const catalog=JSON.parse(await fs.readFile(path.join(root,'ppq-model-identity.json'),'utf8'));
      if(!catalog.some(m=>m.id===e.actualModel))throw e;
      result=JSON.parse(rawProviderResponse.choices[0].message.content);productionAccepted=false;
    }
    batch={work,model:config.verifier.name,productionAccepted,aliasAdjudication:'PPQ catalog z-ai/glm-5.2; benchmark only',elapsedMs:performance.now()-started,promptHash:hash(prompt),accounting,result,status:'ok'};
    for(const r of items){const v=result.verdicts?.find(v=>v.claimId===r.id);if(typeof v?.supported!=='boolean')throw Error('Invalid baseline verdict');report.rows.push({id:r.id,expected:r.expected,predicted:v.supported});}
   }else{
    const evidence=[...new Set(items.map(r=>r.evidence))];
    const state=guideShape?{evidence:Object.fromEntries(evidence.map((e,i)=>['e'+i,e])),claims:Object.fromEntries(items.map((r,i)=>['c'+i,{statement:r.statement,evidenceId:'e'+evidence.indexOf(r.evidence)}]))}:{claims:Object.fromEntries(items.map((r,i)=>['c'+i,{statement:r.statement,evidence:r.evidence}]))};
    const questions=Object.fromEntries(items.map((r,i)=>['q'+i,{type:'boolean',instructions:`Does ${guideShape?'evidence.'+state.claims['c'+i].evidenceId:'claims.c'+i+'.evidence'} support EVERY material detail of claims.c${i}.statement? Use only the provided evidence. Reject dropped qualifiers, causal inversion, scope inflation, entity conflation, and unsupported added details. A supported paraphrase need not repeat exact words.`,criteria:{true:'All material details are supported by the supplied evidence, preserving qualifiers and scope.',false:'Any material detail is contradicted or not established by the supplied evidence.'}}]));
    const result=await experimental_evaluate({model:createGateway({apiKey:process.env.AI_GATEWAY_API_KEY}).evaluationModel('typesafe-ai/jev'),state,questions,maxRetries:0,abortSignal:AbortSignal.timeout(45000),providerOptions:{gateway:{only:['typesafe-ai']}}});
    const g=result.providerMetadata?.gateway;if(g?.routing?.canonicalSlug!=='typesafe-ai/jev'||g.routing.finalProvider!=='typesafe-ai'||g.routing.totalProviderAttemptCount!==1)throw Error('Wrong inference route');
    batch={work,model:'typesafe-ai/jev',elapsedMs:performance.now()-started,state,questions,answers:result.answers,usage:result.usage,gateway:g,status:'ok'};
    for(const [i,r] of items.entries()){const a=result.answers['q'+i];if(a?.type!=='boolean'||!Number.isFinite(a.probability)||a.probability<0||a.probability>1)throw Error('Invalid Jev verdict');report.rows.push({id:r.id,expected:r.expected,probability:a.probability,predicted:a.probability>=0.5,cascade:a.probability>=0.95?'accept':a.probability<=0.05?'reject':'escalate'});}
   }
  }catch(e){batch={work,status:'error',code:e.code||e.name,actualModel:e.actualModel,accounting:mode==='baseline'?accounting:undefined,elapsedMs:performance.now()-started};report.batches.push(batch);await fs.writeFile(output,JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(batch));return;}
  report.batches.push(batch);await fs.writeFile(output,JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({mode,work,ms:batch.elapsedMs,status:batch.status}));
  if(mode==='jev')await new Promise(r=>setTimeout(r,30000));
 }
 report.complete=true;await fs.writeFile(output,JSON.stringify(report,null,2),{mode:0o600});
})().catch(e=>{console.error(e.message);process.exitCode=1});

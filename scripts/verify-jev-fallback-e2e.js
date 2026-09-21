#!/usr/bin/env node
'use strict';
// Real PDF through extraction: consent, partial failure, malformed response and
// whole-book deadline must preserve exact local text. No external API calls.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {extractPdfResult}=require('../lib/pdf-extraction');
const {createJevPdfRepair}=require('../lib/jev-pdf-repair');
const {exactNarrationIntegrity}=require('../lib/extraction-recovery');
(async()=>{
 const root=path.resolve('data/benchmarks/real-books');const source=path.join(root,'darwin.pdf');
 const baseline=await extractPdfResult(source,{warn:false});const integrity=exactNarrationIntegrity(baseline.chapters);const rows=[];
 for(const mode of ['unacknowledged','partial-error','invalid-routing','timeout']){
  let calls=0;
  const evaluate=async(request,signal)=>{
   const sequence=++calls;
   if(sequence===5){
    if(mode==='partial-error')throw Error('fixture provider failure');
    if(mode==='timeout')await new Promise((resolve,reject)=>{const keepAlive=setTimeout(()=>reject(Error('fixture deadline exceeded')),16000);const abort=()=>{clearTimeout(keepAlive);reject(Error('aborted'));};if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});
   }
   const m=/\b([A-Za-z]{2,})-\n([a-z]{2,})/.exec(request.state.text);
   const choice=Object.keys(request.state.choices).find(k=>request.state.choices[k].includes(m[1]+'-'+m[2]));
   return {model:'typesafe-ai/jev',answers:{decision:{type:'choice',choice,confidence:1,probabilities:Object.fromEntries(Object.keys(request.questions.decision.criteria).map(k=>[k,k===choice?1:0]))}},usage:{input_tokens:1},gateway:{costUsd:0,finalProvider:mode==='invalid-routing'&&sequence===5?'unexpected':'typesafe-ai',modelAttemptCount:1,totalProviderAttemptCount:1}};
  };
  const repair=createJevPdfRepair({enabled:true,acknowledged:mode!=='unacknowledged',apiKey:'fixture-only',evaluate});
  const result=await extractPdfResult(source,{warn:false,repairPages:repair});
  assert.deepEqual(exactNarrationIntegrity(result.chapters),integrity,`${mode} must preserve all baseline text`);
  if(mode==='unacknowledged')assert.equal(calls,0);
  else {assert.equal(result.sourceDocument.jevRepairs.applied,false);assert.equal(result.sourceDocument.jevRepairs.accepted.length,0);assert.ok(result.sourceDocument.jevRepairs.discardedAfterFailure>0,'must exercise rollback of tentative accepted edits');}
  rows.push({mode,calls,integrity,decisions:result.sourceDocument.jevRepairs,pass:true});
 }
 const output=path.join(root,'fallback-e2e.json');await fs.writeFile(output,JSON.stringify({createdAt:new Date().toISOString(),rows,pass:true},null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify({output,pass:true}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});

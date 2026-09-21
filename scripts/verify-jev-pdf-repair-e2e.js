#!/usr/bin/env node
'use strict';
// Written before the repair integration. Uses real selected PDF pages, frozen
// Gateway replies and actual PDF extraction/recovery, with no paid inference.
// Failures: disabled/low-confidence/invalid replies change text; unrelated edits;
// missing original retention; serialized rebuild differs or makes another call.
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createJevPdfRepair}=require('../lib/jev-pdf-repair');
const {extractPdfResult,reprocessPdfSourceDocument}=require('../lib/pdf-extraction');
const {proveArtifactRecovery,exactNarrationIntegrity}=require('../lib/extraction-recovery');
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
(async()=>{
 const root=path.resolve(process.argv[2]||'data/benchmarks/real-books');
 const output=path.resolve(process.argv[3]||path.join(root,'repair-e2e.json'));
 const frozen=JSON.parse(await fs.readFile(path.join(root,'frozen-cases.json'),'utf8'));
 const observations=JSON.parse(await fs.readFile(path.join(root,'gateway-results.json'),'utf8'));
 const records=new Map(observations.rows.map(r=>[r.id,r]));
 const rows=[];
 for(const book of ['darwin','walden']){
  const source=path.join(root,`${book}.pdf`);
  const baseline=await extractPdfResult(source,{warn:false});
  const known=frozen.cases.filter(c=>c.family===book&&c.category==='repair');
  const epub=JSON.parse(await fs.readFile(path.join(root,`${book}.epub.extraction.json`),'utf8'));
  const reference=epub.import.chapters.map(c=>c.text).join(' ').toLowerCase().replace(/[^a-z-]+/g,' ');
  let calls=0;
  const evaluate=async request=>{
   calls++;
   const item=known.find(c=>c.input.text===request.state.text);
   const observed=item&&records.get(item.id);
   let goldText=item&&item.input.choices[observed?.hybrid];
   let confidence=observed?.accepted?observed.jev.confidence:0;
   // For transformation coverage beyond the 24 sampled cases, use the same
   // explicit source alignment as a fixture oracle. This is not model accuracy.
   const raw=request.state.text;const m=/\b([A-Za-z]{2,})-\n([a-z]{2,})/.exec(raw);
   if(!item&&m){
    const before=(raw.slice(0,m.index).toLowerCase().match(/[a-z]+/g)||[]).slice(-3);
    const after=(raw.slice(m.index+m[0].length).toLowerCase().match(/[a-z]+/g)||[]).slice(0,3);
    const spelling=m[1]+'-'+m[2];
    if(before.length===3&&after.length===3&&reference.includes([...before,spelling.toLowerCase(),...after].join(' '))){
      goldText=Object.values(request.state.choices).find(text=>text.includes(spelling));confidence=1;
    }
   }
   const choice=Object.keys(request.state.choices).find(k=>request.state.choices[k]===goldText)||'none';
   const keys=Object.keys(request.questions.decision.criteria);
   return {model:'typesafe-ai/jev',answers:{decision:{type:'choice',choice,confidence,probabilities:Object.fromEntries(keys.map(k=>[k,k===choice?1:0]))}},usage:{input_tokens:1},gateway:{costUsd:0,finalProvider:'typesafe-ai',modelAttemptCount:1,totalProviderAttemptCount:1}};
  };
  const disabled=createJevPdfRepair({enabled:false,acknowledged:true,apiKey:'fixture-only',evaluate});
  const unchanged=await extractPdfResult(source,{warn:false,repairPages:disabled});
  assert.equal(calls,0,'disabled must not call provider');
  assert.deepEqual(exactNarrationIntegrity(unchanged.chapters),exactNarrationIntegrity(baseline.chapters));
  const repair=createJevPdfRepair({enabled:true,acknowledged:true,apiKey:'fixture-only',evaluate});
  const accepted=await extractPdfResult(source,{warn:false,repairPages:repair});
  const retained=JSON.parse(JSON.stringify(accepted.sourceDocument));
  assert.ok(retained.jevRepairs?.accepted?.length>0,'must exercise actual accepted repairs; a no-op is not a passing integration test');
  const beforeReplay=calls;
  const rebuilt=await reprocessPdfSourceDocument(retained,{warn:false});
  assert.equal(calls,beforeReplay,'rebuild must not call provider');
  assert.deepEqual(exactNarrationIntegrity(rebuilt),exactNarrationIntegrity(accepted.chapters),'serialized source must rebuild exact text');
  const proof=await proveArtifactRecovery({sourceFormat:'pdf',acceptedChapters:accepted.chapters,sourceDocument:retained});
  if(retained.jevRepairs?.accepted?.length)assert.equal(proof.proven,false,'model-affected source must be retained');
  rows.push({book,calls,baseline:exactNarrationIntegrity(baseline.chapters),accepted:exactNarrationIntegrity(accepted.chapters),decisions:retained.jevRepairs,retainedSourceDigest:digest(retained),recovery:proof,pass:true});
 }
 const report={createdAt:new Date().toISOString(),scope:'Actual PDF extraction and serialized recovery; frozen Gateway replies plus aligned-source fixture oracle for transformation coverage, no paid inference. Not importer persistence transaction.',rows,pass:true};
 await fs.writeFile(output,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify({output,pass:true,books:rows.length}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});

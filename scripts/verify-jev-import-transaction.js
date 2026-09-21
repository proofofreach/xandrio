#!/usr/bin/env node
'use strict';
// Actual importer, artifact store and source-retention transaction in scratch
// storage. Replay previously validated live decisions; never send new requests.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const pdf=require('../lib/pdf-extraction');
const {createJevPdfRepair}=require('../lib/jev-pdf-repair');
(async()=>{
 const root=path.resolve('data/benchmarks/real-books');
 const live=JSON.parse(await fs.readFile(path.join(root,'production-path-live.json'),'utf8'));
 const attempts=new Map(live.rows.flatMap(r=>r.decisions.attempts.map(a=>[a.requestHash,a])));
 let calls=0;
 const repair=createJevPdfRepair({enabled:true,acknowledged:true,apiKey:'fixture-only',evaluate:async request=>{
  calls++;const key=crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');const a=attempts.get(key);
  assert.ok(a&&a.status==='ok','every request must match a previously validated live attempt');
  return {model:'typesafe-ai/jev',answers:{decision:{type:'choice',choice:a.choice,confidence:a.confidence,probabilities:Object.fromEntries(Object.keys(request.questions.decision.criteria).map(k=>[k,k===a.choice?1:0]))}},usage:{input_tokens:a.inputTokens},gateway:a.gateway};
 }});
 const original=pdf.extractPdfChapters;
 pdf.extractPdfChapters=(source,options={})=>original(source,{...options,warn:false,repairPages:repair});
 const {evaluateBakeoffVersion}=require('./lib/import-bakeoff-evaluator');
 const scratch=await fs.mkdtemp(path.join(root,'import-transaction-'));
 const cases=['darwin','walden','frankenstein'].map(book=>({id:book,format:'pdf',path:path.join(root,`${book}.pdf`),minimumNormalizedChars:20000}));
 const result=await evaluateBakeoffVersion({versionRoot:path.resolve(__dirname,'..'),scratchRoot:scratch,cases,evaluateUx:async()=>({skipped:true,reason:'Focused importer/source-retention verification; no browser UX claim'})});
 const retention=[];
 for(const [index,book] of ['darwin','walden','frankenstein'].entries()){
  const prefix=path.join(scratch,'cache',`bakeoff-${index+1}`);
  const entries=await fs.readdir(path.join(scratch,'cache'));
  const artifactName=entries.find(x=>x.startsWith(`bakeoff-${index+1}.`)&&x.endsWith('.json')&&!x.includes('chapters'));
  assert.ok(artifactName,'persisted artifact must exist');
  const artifact=JSON.parse(await fs.readFile(path.join(scratch,'cache',artifactName),'utf8'));
  const count=artifact.sourceDocument?.jevRepairs?.accepted?.length||0;
  const retained=await fs.stat(prefix+'.pdf').then(()=>true,()=>false);
  if(count){assert.equal(retained,true);assert.equal(artifact.sourceDeleted,false);assert.equal(artifact.recoveryProof.proven,false);}
  retention.push({book,artifactPath:path.join(scratch,'cache',artifactName),accepted:count,retained,recovery:artifact.recoveryProof});
 }
 assert.ok(retention.some(r=>r.accepted>0),'must exercise accepted repair retention');
 assert.ok(result.cases.every(c=>c.importable&&c.narrationValid),'all books must remain importable and narratable');
 const output=path.join(root,'import-transaction-e2e.json');
 await fs.writeFile(output,JSON.stringify({createdAt:new Date().toISOString(),scratch,calls,pass:true,retention,...result},null,2),{flag:'wx',mode:0o600});
 console.log(JSON.stringify({output,pass:true,calls,retention},null,2));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});

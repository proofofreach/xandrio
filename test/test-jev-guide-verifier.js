'use strict';
// Failure cases frozen before implementation: malformed/missing/extra judgments,
// wrong route,429,timeout,cancellation,uncertainty,busy admission,disabled disclosure.
const assert=require('node:assert/strict');
const {createJevGuideVerifier}=require('../lib/jev-guide-verifier');
(async()=>{
 const items=[{id:'a',statement:'A',evidence:'Evidence A'},{id:'b',statement:'B',evidence:'Evidence B'},{id:'c',statement:'C',evidence:'Evidence C'}];
 const good=()=>({answers:{q0:{type:'boolean',probability:0.99},q1:{type:'boolean',probability:0.01},q2:{type:'boolean',probability:0.5}},providerMetadata:{gateway:{routing:{canonicalSlug:'typesafe-ai/jev',finalProvider:'typesafe-ai'}}}});
 const fallbacks=[];const fallback=async xs=>{fallbacks.push(xs.map(x=>x.id));return {verdicts:xs.map(x=>({claimId:x.id,supported:true}))};};
 let seen;const v=createJevGuideVerifier({enabled:true,acknowledged:true,apiKey:'test',evaluate:async request=>{seen=request;return good();}});
 assert.equal(v.active,true);const out=await v.verify(items,{fallback});assert.deepEqual(out.verdicts,[{claimId:'a',supported:true},{claimId:'b',supported:false},{claimId:'c',supported:true}]);assert.deepEqual(fallbacks.pop(),['c']);assert.equal(seen.maxRetries,0);
 for(const mutate of [r=>{delete r.answers.q1;},r=>{r.answers.extra={type:'boolean',probability:1};},r=>{r.answers.q0.probability=NaN;},r=>{r.providerMetadata.gateway.routing.finalProvider='other';}]){
  const bad=createJevGuideVerifier({enabled:true,acknowledged:true,apiKey:'test',evaluate:async()=>{const r=good();mutate(r);return r;}});await bad.verify(items,{fallback});assert.deepEqual(fallbacks.pop(),['a','b','c']);
 }
 let calls=0;const down=createJevGuideVerifier({enabled:true,acknowledged:true,apiKey:'test',evaluate:async()=>{calls++;throw Error('429');}});await down.verify(items,{fallback});await down.verify(items,{fallback});assert.equal(calls,1,'circuit prevents immediate provider retry');
 const disabled=createJevGuideVerifier({enabled:true,acknowledged:false,apiKey:'test',evaluate:()=>{throw Error('must not send');}});assert.equal(disabled.active,false);await disabled.verify(items,{fallback});
 const controller=new AbortController();controller.abort();const before=fallbacks.length;await assert.rejects(v.verify(items,{fallback,signal:controller.signal}));assert.equal(fallbacks.length,before);
 const timeout=createJevGuideVerifier({enabled:true,acknowledged:true,apiKey:'test',timeoutMs:10,evaluate:()=>new Promise(()=>{})});await timeout.verify(items,{fallback});assert.deepEqual(fallbacks.pop(),['a','b','c']);
 console.log('PASS Jev verifier cascade: typed decisions, subset fallback, failure atomicity, circuit, deadline, disclosure and cancellation');
})().catch(e=>{console.error(e);process.exitCode=1});

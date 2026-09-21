'use strict';
// Failure cases frozen before implementation: malformed/missing/extra judgments,
// wrong route,429,timeout,cancellation,uncertainty,busy admission,disabled disclosure.
const assert=require('node:assert/strict');
const {createJevGuideVerifier}=require('../lib/jev-guide-verifier');
(async()=>{
 const items=[{id:'a',statement:'A',evidence:'Evidence A'},{id:'b',statement:'B',evidence:'Evidence B'},{id:'c',statement:'C',evidence:'Evidence C'}];
 const good=()=>({answers:{q0:{type:'boolean',probability:0.99},q1:{type:'boolean',probability:0.01},q2:{type:'boolean',probability:0.5}},providerMetadata:{gateway:{routing:{canonicalSlug:'typesafe-ai/jev',finalProvider:'typesafe-ai',modelAttemptCount:1,totalProviderAttemptCount:1}}}});
 const fallbacks=[];const fallback=async xs=>{fallbacks.push(xs.map(x=>x.id));return {verdicts:xs.map(x=>({claimId:x.id,supported:true}))};};
 let seen;const v=createJevGuideVerifier({enabled:true,acknowledged:true,apiKey:'test',evaluate:async request=>{seen=request;return good();}});
 assert.equal(v.active,true);const out=await v.verify(items,{fallback});assert.deepEqual(out.verdicts,[{claimId:'a',supported:true},{claimId:'b',supported:false},{claimId:'c',supported:true}]);assert.deepEqual(fallbacks.pop(),['c']);assert.equal(seen.maxRetries,0);
 for(const mutate of [r=>{delete r.answers.q1;},r=>{r.answers.extra={type:'boolean',probability:1};},r=>{r.answers.q0.probability=NaN;},r=>{r.providerMetadata.gateway.routing.finalProvider='other';},r=>{r.providerMetadata.gateway.routing.totalProviderAttemptCount=2;}]){
  const bad=createJevGuideVerifier({enabled:true,acknowledged:true,apiKey:'test',evaluate:async()=>{const r=good();mutate(r);return r;}});await bad.verify(items,{fallback});assert.deepEqual(fallbacks.pop(),['a','b','c']);
 }
 let calls=0;const down=createJevGuideVerifier({enabled:true,acknowledged:true,apiKey:'test',evaluate:async()=>{calls++;throw Error('429');}});await down.verify(items,{fallback});await down.verify(items,{fallback});assert.equal(calls,1,'circuit prevents immediate provider retry');
 const disabled=createJevGuideVerifier({enabled:true,acknowledged:false,apiKey:'test',evaluate:()=>{throw Error('must not send');}});assert.equal(disabled.active,false);await disabled.verify(items,{fallback});
 const controller=new AbortController();controller.abort();const before=fallbacks.length;await assert.rejects(v.verify(items,{fallback,signal:controller.signal}));assert.equal(fallbacks.length,before);
 const timeout=createJevGuideVerifier({enabled:true,acknowledged:true,apiKey:'test',timeoutMs:10,evaluate:()=>new Promise(()=>{})});await timeout.verify(items,{fallback});assert.deepEqual(fallbacks.pop(),['a','b','c']);
 let inFlight=0,peak=0,evaluations=0;
 const serial=createJevGuideVerifier({enabled:true,acknowledged:true,apiKey:'test',evaluate:async()=>{evaluations++;peak=Math.max(peak,++inFlight);await new Promise(r=>setTimeout(r,5));inFlight--;return good();}});
 await Promise.all([serial.verify(items,{fallback}),serial.verify(items,{fallback})]);assert.equal(evaluations,2);assert.equal(peak,1);
 let releaseFirst,entered;const enteredPromise=new Promise(r=>entered=r);let queuedCalls=0;
 const queued=createJevGuideVerifier({enabled:true,acknowledged:true,apiKey:'test',evaluate:async()=>{if(++queuedCalls===1){entered();await new Promise(r=>releaseFirst=r);}return good();}});
 const first=queued.verify(items,{fallback});await enteredPromise;const queuedAbort=new AbortController();const second=queued.verify(items,{fallback,signal:queuedAbort.signal});const rejected=assert.rejects(second);const third=queued.verify(items,{fallback});queuedAbort.abort();await rejected;releaseFirst();await Promise.all([first,third]);assert.equal(queuedCalls,2);
 let fallbackActive=0,fallbackPeak=0;const unavailable=createJevGuideVerifier({enabled:true,acknowledged:true,apiKey:'test',evaluate:async()=>{throw Error('capacity');}});
 const parallelFallback=async xs=>{fallbackPeak=Math.max(fallbackPeak,++fallbackActive);await new Promise(r=>setTimeout(r,10));fallbackActive--;return {verdicts:xs.map(x=>({claimId:x.id,supported:true}))};};
 await Promise.all([unavailable.verify(items,{fallback:parallelFallback}),unavailable.verify(items,{fallback:parallelFallback})]);assert.equal(fallbackPeak,2);
 console.log('1 passed, 0 failed');
 console.log('PASS Jev verifier cascade: typed decisions, subset fallback, failure atomicity, circuit, deadline, disclosure and cancellation');
})().catch(e=>{console.error(e);process.exitCode=1});

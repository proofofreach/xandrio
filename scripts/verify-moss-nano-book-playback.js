// Real-app E2E for a captured complete Nano book. The directory must contain
// book.txt, chunks.json, result/report.json and numbered source WAVs with hashes.
// Replays those actual model outputs through mastering, noise rejection and
// complete 2x browser playback. This does not substitute for real-model capture.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const directory = path.resolve(process.argv[2] || 'output/nano-book-trial');
const { chromium } = require(path.join(root, 'node_modules/playwright'));
const { verifyAudioFile } = require(path.join(root, 'lib/audio-quality'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
 const texts = JSON.parse(await fs.readFile(path.join(directory, 'chunks.json')));
 const source = JSON.parse(await fs.readFile(path.join(directory, 'result/report.json')));
 const wavs = await Promise.all(texts.map((_, i) => fs.readFile(path.join(directory, 'result', `${String(i).padStart(3,'0')}.wav`))));
 source.records.forEach((c,i) => assert.equal(createHash('sha256').update(wavs[i]).digest('hex'), c.sha256));
 const data = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-real-book-'));
 await fs.mkdir(path.join(data, 'cache'),{recursive:true});
 const bookPath = path.join(data, 'cache/peter-rabbit.xbook.json');
 const text = await fs.readFile(path.join(directory, 'book.txt'), 'utf8');
 await fs.writeFile(bookPath, JSON.stringify({_xbookVersion:2,metadata:{title:'The Tale of Peter Rabbit',language:'en'},chapters:[{id:'complete',title:'The complete story',type:'chapter',text,estimatedDuration:398}]}));
 await fs.writeFile(path.join(data,'books.json'), JSON.stringify({'peter-rabbit':{id:'peter-rabbit',title:'The Tale of Peter Rabbit',author:'Beatrix Potter',path:bookPath,language:'en',chapterCount:1}}));
 await fs.writeFile(path.join(data,'settings.json'), JSON.stringify({voice:'kokoro:af_heart',premiumPrepEnabled:false,bookNarration:{'peter-rabbit':{voiceId:'moss-nano:Nathan',fallbackPolicy:'wait'}},operatorPolicy:{version:1,acknowledgedAt:new Date().toISOString(),unverifiedSourcesEnabled:false}}));
 const noisePath=path.join(directory,'loud-white-noise.wav');
 execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','anoisesrc=color=white:amplitude=0.4:duration=10:sample_rate=24000','-ac','1',noisePath]);
 const noise=await fs.readFile(noisePath);
 const books=JSON.parse(await fs.readFile(path.join(data,'books.json')));
 const noiseBook=path.join(data,'cache/noise-guard.xbook.json');
 await fs.writeFile(noiseBook,JSON.stringify({_xbookVersion:2,metadata:{title:'Noise guard',language:'en'},chapters:[{id:'noise',type:'chapter',title:'Noise guard',text:'This audible noise guard passage must be rejected because the engine returned white noise instead of spoken words.'}]}));
 books['noise-guard']={id:'noise-guard',title:'Noise guard',author:'Fixture',path:noiseBook,language:'en',chapterCount:1};
 await fs.writeFile(path.join(data,'books.json'),JSON.stringify(books));
 const used = [], unexpected = [];
 const service = http.createServer(async (req,res) => {
  if(req.url === '/health'){res.setHeader('Content-Type','application/json');return res.end('{"ok":true,"device":"cpu"}');}
  let body=''; for await(const b of req)body+=b;
  const input = JSON.parse(body); if(input.text.includes('audible noise guard')){res.setHeader('Content-Type','audio/wav');return res.end(noise);}
  const index=texts.findIndex(text => text === input.text);
  if(index<0){unexpected.push(input);res.statusCode=400;return res.end('Unexpected text');}
  used.push(index);res.setHeader('Content-Type','audio/wav');res.end(wavs[index]);
 });
 service.listen(0,'127.0.0.1');await once(service,'listening');
 const probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
 const origin=`http://127.0.0.1:${port}`, engine=`http://127.0.0.1:${service.address().port}`;
 let log='', browser;
 const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,CACHE_DIR:path.join(data,'cache'),XANDRIO_TOKEN:'real-book-token',XANDRIO_VOICE_PROVIDERS:'kokoro,moss-nano',MOSS_NANO_ENABLED:'true',MOSS_NANO_AUTO_START:'false',MOSS_NANO_TTS_URL:engine,KOKORO_AUTO_START:'false',KOKORO_TTS_URL:engine,CHATTERBOX_AUTO_START:'false',XANDRIO_RATE_LIMIT_DISABLED:'true'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
 const request=(route)=>fetch(origin+route,{headers:{Authorization:'Bearer real-book-token'},signal:AbortSignal.timeout(120000)});
 const evidence={generatedAt:new Date().toISOString(),sourceWaveHashesVerified:wavs.length,sourceSynthesis:'Actual VPS MOSS Nano output; WAV replay only avoids repeating inference',used,unexpected};
 try{
  for(let i=0;i<100;i++){try{if((await request('/api/voices')).ok)break;}catch{}await sleep(100);}
  const response=await request('/api/audio/peter-rabbit/0');assert.equal(response.status,200);assert.equal(response.headers.get('x-voice-id'),'moss-nano:Nathan');
  const mp3=path.join(directory,'peter-rabbit-nathan.mp3');await fs.writeFile(mp3,Buffer.from(await response.arrayBuffer()));
  assert.equal(new Set(used).size,texts.length);assert.equal(unexpected.length,0);
  evidence.acoustics=await verifyAudioFile(mp3,{minimumDurationSeconds:350});
  assert.equal(evidence.acoustics.pass,true,JSON.stringify(evidence.acoustics));
  const noiseResponse=await request('/api/audio/noise-guard/0?tier=premium&voiceId=moss-nano%3ANathan');
  evidence.audibleNoiseRejected=noiseResponse.status===500;assert(evidence.audibleNoiseRejected);await noiseResponse.text();
  browser=await chromium.launch();const context=await browser.newContext({serviceWorkers:'block',extraHTTPHeaders:{Authorization:'Bearer real-book-token'},viewport:{width:390,height:844}});
  await context.tracing.start({screenshots:true,snapshots:true});
  const page=await context.newPage();await page.goto(origin+'/#/player/peter-rabbit');
  await page.waitForFunction(()=>document.querySelector('#audio-player').readyState>=2);await page.locator('#speed-sheet-btn').click();await page.locator('.speed-preset[data-speed="2"]').click();await page.locator('#close-speed-sheet-btn').click();await sleep(600);
  if(await page.locator('#audio-player').evaluate(a=>a.paused)) await page.locator('#play-pause-btn').click();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('audio')).some(a=>!a.paused&&a.currentTime>0),{},{timeout:20000});
  await page.evaluate(()=>{window.bookPlayback={events:[],maxTime:0};for(const a of document.querySelectorAll('audio')){for(const e of ['ended','error','stalled','waiting','playing'])a.addEventListener(e,()=>window.bookPlayback.events.push({type:e,time:a.currentTime,rate:a.playbackRate}));a.addEventListener('timeupdate',()=>window.bookPlayback.maxTime=Math.max(window.bookPlayback.maxTime,a.currentTime));}});
  await page.screenshot({path:path.join(directory,'playing-2x.png')});
  const started=Date.now();
  for(let i=0;i<360;i++){const state=await page.evaluate(()=>window.bookPlayback);if(state.events.some(e=>e.type==='ended'))break;if(i%30===0)console.log(`Book playback: ${state.maxTime.toFixed(1)} audio seconds`);await sleep(1000);}
  evidence.playback=await page.evaluate(()=>window.bookPlayback);evidence.playback.elapsedSeconds=(Date.now()-started)/1000;
  assert(evidence.playback.events.some(e=>e.type==='ended'&&e.rate===2));assert(evidence.playback.maxTime>350);assert(!evidence.playback.events.some(e=>['error','stalled','waiting'].includes(e.type)&&e.time>2));
  await page.screenshot({path:path.join(directory,'completed-2x.png')});
  await context.tracing.stop({path:path.join(directory,'full-book.trace.zip')});
  evidence.passed=true;console.log('PASS full short book prepared, mastered, and played to completion at 2x');
 }catch(error){if(browser){const pages=browser.contexts()[0]?.pages()||[];if(pages[0]){evidence.browserState=await pages[0].evaluate(()=>Array.from(document.querySelectorAll('audio')).map(a=>({paused:a.paused,time:a.currentTime,rate:a.playbackRate,src:a.currentSrc,error:a.error?.message})));await pages[0].screenshot({path:path.join(directory,'failure.png')});}}evidence.passed=false;evidence.error=error.stack;console.error(error);process.exitCode=1;}
 finally{if(browser)await browser.close();child.kill('SIGTERM');await once(child,'exit');await new Promise(r=>service.close(r));await fs.writeFile(path.join(directory,'playback-report.json'),JSON.stringify(evidence,null,2));await fs.writeFile(path.join(directory,'app.log'),log);if(evidence.passed)await fs.rm(data,{recursive:true,force:true});else console.log('Fixture retained:',data);}
})().catch(e=>{console.error(e);process.exitCode=1;});

// Browser contract test with a mocked native transport. Real Rust media tests live in src-tauri/tests.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
(async () => {
  const server = spawn(process.execPath, [path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', '5184'], { stdio: 'pipe' });
  let serverOutput = '';
  for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { serverOutput = (serverOutput + data).slice(-4096); });
  let browser;
  try {
    const deadline = Date.now() + 15000;
    while (true) {
      if (server.exitCode !== null || Date.now() > deadline) throw Error(`Vite failed to start: ${serverOutput}`);
      try { if ((await fetch('http://127.0.0.1:5184')).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true });
  const page = await browser.newPage({viewport:{width:1440,height:1100}});
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(() => {
    let id = 0; const callbacks = new Map(); const listeners = new Map();
    const queue = JSON.parse(localStorage.getItem('queue') || '{"jobs":[],"running":false,"stopRequested":false,"revision":0}');
    let resolveRun;
    const calls = []; const selections = [];
    const emit = (event,payload) => { for (const [listener, value] of listeners) if(value.event === event) callbacks.get(value.handler)?.({event,id:listener,payload:structuredClone(payload)}); };
    const update = () => { queue.revision++; localStorage.setItem('queue',JSON.stringify(queue)); emit('native-queue-changed',queue); return structuredClone(queue); };
    window.test = {calls,selections,queue,emit,listeners,complete() {queue.running=false; queue.jobs[0].status='completed'; update(); resolveRun?.();}};
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener(_event,id){listeners.delete(id);}};
    window.__TAURI_INTERNALS__ = {
      transformCallback(fn) {const n=++id;callbacks.set(n,fn);return n;},
      async invoke(cmd,args={}) {
        calls.push({cmd,args:structuredClone(args)});
        if(cmd === 'plugin:event|listen') {const n=++id;listeners.set(n,args);return n;}
        if(cmd === 'plugin:event|unlisten') return;
        if(cmd === 'host_status') return {host:'tauri',platform:'linux',migrationStage:'native-processing-preview'};
        if(cmd === 'native_processing_status') return false;
        if(cmd === 'load_native_settings') return {lastInputDirectory:'',preferredVideoEncoder:'libx264'};
        if(cmd === 'list_native_profiles') return [];
        if(cmd === 'native_queue_snapshot') return structuredClone(queue);
        if(cmd === 'select_native_file' || cmd === 'select_native_output') return selections.shift() ?? null;
        if(cmd === 'inspect_media') return {path:args.path,durationSeconds:1,formatName:'matroska',streams:[{index:0,codecType:'video',codecName:'h264',width:160,height:120,language:null,title:null},{index:1,codecType:'audio',codecName:'aac',language:'eng',title:null,width:null,height:null}]};
        if(cmd === 'inspect_vapoursynth_script') return {valid:true,details:'Width: 128\nHeight: 96',script:args.script};
        if(cmd === 'check_native_encoder') return {encoder:args.encoder,available:true,detail:'Test frame encoded successfully'};
        if(cmd === 'edit_native_queue') {
          const edit=args.edit;
          if(edit.type==='add') queue.jobs.push({id:queue.jobs.length+1,...structuredClone(edit.request),status:'queued',error:null});
          if(edit.type==='applyOptions') for(const job of queue.jobs) if(job.status==='queued') job.options=structuredClone(edit.options);
          if(edit.type==='remove') queue.jobs=queue.jobs.filter(j=>j.id!==edit.id);
          if(edit.type==='retry') queue.jobs.find(j=>j.id===edit.id).status='queued';
          if(edit.type==='clearFinished') queue.jobs=queue.jobs.filter(j=>['queued','running'].includes(j.status));
          return update();
        }
        if(cmd === 'run_native_queue') {queue.running=true;queue.stopRequested=false;queue.jobs.find(j=>j.status==='queued').status='running';update();return new Promise(resolve=>{resolveRun=resolve;});}
        if(cmd === 'stop_native_queue') {queue.stopRequested=true;queue.running=false;for(const j of queue.jobs) if(j.status==='running') j.status='cancelled';const next=update();resolveRun?.();return next;}
        if(cmd === 'encode_sample') {emit('native-encode-progress',{status:'completed',detail:'Encoding completed',outTimeMs:1000,speed:'1x'});return 'completed';}
        if(cmd === 'save_native_profile' || cmd === 'save_native_settings' || cmd === 'delete_native_profile') return;
        if(cmd === 'read_native_frame') return new Uint8Array([255,216,255,217]).buffer;
        throw Error(`Unexpected command ${cmd}`);
      }
    };
  });
  await page.goto('http://127.0.0.1:5184');
  await page.getByRole('heading',{name:'Vapourkit native processing preview'}).waitFor();
  await page.waitForFunction(() => [...window.test.listeners.values()].filter(x=>x.event==='native-queue-changed').length===1);
  const input=page.getByPlaceholder('Absolute path to a source video');
  await input.fill('/test/source.mkv');
  await page.getByRole('button',{name:'Browse',exact:true}).nth(0).click();
  assert.equal(await input.inputValue(),'/test/source.mkv','Cancelling a file picker changed source');
  await page.getByPlaceholder('New .mkv, .mp4, or .mov file').fill('/test/output.mkv');
  await page.getByRole('button',{name:'Inspect tracks',exact:true}).click();
  await page.getByText('#1: audio / aac eng').waitFor();
  await page.getByRole('checkbox',{name:'Render a trusted VapourSynth script'}).check();
  await page.getByPlaceholder('Absolute path to a .vpy script').fill('/test/trusted.vpy');
  await page.getByRole('button',{name:'Validate script',exact:true}).click();
  await page.getByText('Valid: Width: 128').waitFor();
  await page.getByLabel('Batch input path').fill('/test/batch.mkv');
  await page.getByLabel('Batch output path').fill('/test/batch-output.mkv');
  await page.getByRole('button',{name:'Add job',exact:true}).click();
  await page.waitForFunction(()=>window.test.queue.jobs.length===1);
  assert.equal(await page.evaluate(()=>window.test.queue.jobs[0].script),'/test/trusted.vpy');
  assert.deepEqual(await page.evaluate(()=>window.test.queue.jobs[0].options.audioTracks),[1]);
  await page.getByRole('slider').fill('35');
  assert.equal(await page.evaluate(()=>window.test.queue.jobs[0].options.quality),20,'Queued options mutated with editor');
  await page.getByRole('button',{name:'Apply current options to pending jobs'}).click();
  await page.waitForFunction(()=>window.test.queue.jobs[0].options.quality===35);
  await page.evaluate(()=>window.test.emit('native-queue-changed',{jobs:[],running:false,stopRequested:false,revision:0}));
  assert.match(await page.locator('section').last().innerText(),/batch-output/,'Stale snapshot replaced current queue');
  await page.getByRole('button',{name:'Run queue',exact:true}).click();
  await page.getByRole('button',{name:'Stop queue',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Start encoding',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Stop queue',exact:true}).click();
  await page.getByText('cancelled',{exact:true}).waitFor();
  await page.reload();
  await page.getByText('cancelled',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Retry',exact:true}).click();
  await page.getByText('queued',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Run queue',exact:true}).click();
  await page.waitForFunction(()=>window.test.queue.running);
  await page.reload();
  await page.getByRole('button',{name:'Stop queue',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Start encoding',exact:true}).isDisabled(),true,'Reload lost backend running state');
  await page.getByRole('button',{name:'Stop queue',exact:true}).click();
  await page.getByText('cancelled',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  if (process.env.VAPOURKIT_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.VAPOURKIT_SMOKE_SCREENSHOT, fullPage: true });
  console.log('PASS: picker cancellation, script selection, track snapshots, batch apply, stale event handling, stop/retry, durable reload state, StrictMode listeners, no browser exceptions');
  } finally { await browser?.close(); server.kill(); }
})().catch(e=>{console.error(e);process.exit(1);});

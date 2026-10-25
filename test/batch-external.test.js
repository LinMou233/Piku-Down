const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {Readable}=require('node:stream');
const {createExternalRuntime}=require('../external-runtime');
const {createExternalMedia}=require('../external-media');
const {createDownloadTask,cleanupDownloadTask}=require('../download-task');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function root(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'piku-batch-external-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
test('cancelling one runtime-install waiter does not abort another waiter',async t=>{
 const folder=await root(t),started=deferred(),release=deferred();let sharedSignal;
 const runtime=createExternalRuntime({root:folder,fetch:async(_,opts)=>{sharedSignal=opts.signal;started.resolve();await release.promise;return {ok:true,headers:{get:()=> '4'},body:Readable.from([Buffer.from('bad!')])};}});
 const a=new AbortController(),b=new AbortController(),first=runtime.ensure(a.signal).catch(e=>e),second=runtime.ensure(b.signal).catch(e=>e);
 await started.promise;a.abort(Error('cancel A'));assert.match((await first).message,/cancel A/);assert.equal(sharedSignal.aborted,false);
 release.resolve();assert.match((await second).message,/校验失败/);assert.equal(b.signal.aborted,false);
 const files=await fs.readdir(path.join(folder,'download-tools','2026.10.21'));assert.deepEqual(files,[]);
});
test('last runtime-install waiter cancellation aborts the shared request and removes temporary data',async t=>{
 const folder=await root(t),started=deferred();let sharedSignal;
 const runtime=createExternalRuntime({root:folder,fetch:(_,opts)=>new Promise((_,reject)=>{sharedSignal=opts.signal;started.resolve();opts.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});})});
 const controller=new AbortController(),pending=runtime.ensure(controller.signal).catch(e=>e);await started.promise;controller.abort();await pending;
 assert.equal(sharedSignal.aborted,true);assert.deepEqual(await fs.readdir(path.join(folder,'download-tools','2026.10.21')),[]);
});
test('external concurrent downloads route independent callbacks and cancellation signals',async t=>{
 const folder=await root(t),ready=deferred(),release=deferred(),events=[[],[],[]];let calls=0;
 const info={title:'fixture',formats:[{format_id:'18',height:360,ext:'mp4',vcodec:'h264',acodec:'aac',url:'https://media.invalid/fixture'}]};
 const service=createExternalMedia({root:path.join(folder,'auth'),runtime:{ensure:async()=> 'fixture'},auth:{cookies:()=>assert.fail('public must not read cookies')},ffmpeg:()=> 'fixture',
  run:async(_,args,opts)=>{
   if(args.includes('--dump-single-json'))return JSON.stringify(info);
   const i=Number(new URL(args.at(-1)).searchParams.get('v').slice(-1));calls++;opts.onLine('PIKU_PROGRESS:'+JSON.stringify({status:'downloading',downloaded_bytes:(i+1)*10,total_bytes:100}));if(calls===3)ready.resolve();
   await Promise.race([release.promise,new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))]);
   opts.signal.throwIfAborted();const file=args[args.indexOf('-o')+1].replace('%(ext)s','mp4');await fs.writeFile(file,'complete');
  }});
 const parsed=await Promise.all([0,1,2].map(i=>service.parse('https://www.youtube.com/watch?v=aaaaaaaaaa'+i)));
 const tasks=parsed.map(()=>createDownloadTask(new AbortController(),folder));
 const pending=parsed.map((p,i)=>service.download({bvid:p.bvid,cid:p.pages[0].cid,qn:'18'},tasks[i],value=>events[i].push(value)).catch(e=>e));
 await ready.promise;tasks[0].controller.abort();release.resolve();const result=await Promise.all(pending);
 assert.ok(result[0] instanceof Error);assert.equal(result[1].platform,'youtube');assert.equal(result[2].platform,'youtube');
 assert.deepEqual(events.map(list=>list[0].received),[10,20,30]);assert.equal(new Set(tasks.map(task=>task.temp)).size,3);
 await Promise.all(tasks.map(cleanupDownloadTask));assert.deepEqual((await fs.readdir(folder)).filter(name=>name.startsWith('.bilidown-')),[]);
});

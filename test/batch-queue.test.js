const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createDownloadQueue,normalizeLink}=require('../download-queue');
const {cleanupDownloadTask}=require('../download-task');
const {moveOutputAtomically}=require('../output-file');
const {createBatchModel}=require('../ui/batch');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const turn=()=>new Promise(setImmediate);
const links=n=>Array.from({length:n},(_,i)=>'https://www.youtube.com/watch?v=aaaaaaaaaa'+i).join('\n');
function fixture(options={}){
 const gates=new Map(),reports=new Map(),events=[],started=[];
 const queue=createDownloadQueue({prepare:async job=>({title:job.input,canonical:job.input,folder:job.task.folder}),
  run:async(opts,task,report)=>{const gate=deferred();gates.set(task.id,gate);reports.set(task.id,report);started.push(task.id);
   const abort=()=>gate.reject(task.controller.signal.reason);task.controller.signal.addEventListener('abort',abort,{once:true});
   try{await gate.promise;return {file:opts.title};}finally{task.controller.signal.removeEventListener('abort',abort);}},
  cleanup:async()=>{},emit:value=>events.push(value),...options});
 const add=n=>queue.addBatch(links(n),{folder:path.resolve('batch-test')});
 const done=()=>Promise.allSettled([...queue.jobs.values()].map(job=>job.done));
 return {queue,gates,reports,events,started,add,done};
}
test('batch waits for start, defaults to one slot, and pause only stops dispatch',async()=>{
 const f=fixture();f.add(3);assert.equal(f.queue.state().concurrency,1);assert.equal(f.started.length,0);
 f.queue.start();await turn();assert.equal(f.started.length,1);f.queue.pause();
 f.gates.get(f.started[0]).resolve();await turn();assert.equal(f.started.length,1);assert.equal(f.queue.state().tasks[0].state,'completed');
 f.queue.start();await turn();f.gates.get(f.started[1]).resolve();await turn();f.gates.get(f.started[2]).resolve();await f.done();
 assert.equal(f.queue.state().tasks.filter(task=>task.state==='completed').length,3);
});
test('three slots isolate task progress, speeds, IDs and revision ordering',async()=>{
 let time=0;const f=fixture({now:()=>time});f.queue.setConcurrency(3);f.add(3);f.queue.start();await turn();assert.equal(f.started.length,3);
 time=1000;f.started.forEach((id,i)=>f.reports.get(id)({label:'正在下载',received:(i+1)*10,total:100}));
 assert.deepEqual(f.queue.state().tasks.map(task=>task.progress),[10,20,30]);assert.deepEqual(f.queue.state().tasks.map(task=>task.speed),[10,20,30]);
 assert.equal(new Set(f.started).size,3);const model=createBatchModel();for(const event of f.events)model.update(event);
 for(const id of f.started)f.gates.get(id).resolve();await f.done();for(const event of f.events)model.update(event);
 const completed=model.summary();assert.equal(completed.completed,3);const last=f.events.at(-1);assert.equal(model.update({...last,revision:last.revision-1,state:'downloading'}),false);
 assert.equal(model.tasks.get(last.taskId).state,'completed');assert.equal(model.update({...last,source:'single',revision:999}),false);
});
test('concurrency changes never abort existing tasks or start above the configured limit',async()=>{
 const f=fixture();f.queue.setConcurrency(3);f.add(5);f.queue.start();await turn();f.queue.setConcurrency(1);
 f.gates.get(f.started[0]).resolve();f.gates.get(f.started[1]).resolve();await turn();assert.equal(f.started.length,3);
 f.gates.get(f.started[2]).resolve();await turn();assert.equal(f.started.length,4);
 f.gates.get(f.started[3]).resolve();await turn();f.gates.get(f.started[4]).resolve();await f.done();
 for(const value of [0,4,1.5,'3',NaN])assert.throws(()=>f.queue.setConcurrency(value),/1～3/);
});
test('cancelling one active task does not cancel either sibling, and failure dispatches remaining work',async()=>{
 const f=fixture();f.queue.setConcurrency(3);f.add(5);f.queue.start();await turn();const [a,b,c]=f.started;
 assert.equal((await f.queue.cancel(a,true)).cancelled,true);await turn();assert.equal(f.started.length,4);
 assert.equal(f.queue.jobs.get(b).task.controller.signal.aborted,false);assert.equal(f.queue.jobs.get(c).task.controller.signal.aborted,false);
 f.gates.get(b).reject(Error('one source failed'));await turn();assert.equal(f.started.length,5);
 for(const id of f.started.slice(2))f.gates.get(id).resolve();await f.done();
 assert.deepEqual(f.queue.state().tasks.map(task=>task.state),['cancelled','failed','completed','completed','completed']);
 assert.equal(f.queue.state().tasks[0].error,'');
});
test('cancel-all includes waiting jobs, waits cleanup, and does not dispatch replacements',async()=>{
 const f=fixture();f.queue.setConcurrency(3);f.add(6);f.queue.start();await turn();await f.queue.cancelAll('batch');await f.done();
 assert.equal(f.started.length,3);assert.equal(f.queue.state().running,0);assert.equal(f.queue.state().paused,true);assert.ok(f.queue.state().tasks.every(task=>task.state==='cancelled'));
 f.queue.clear();assert.equal(f.queue.state().tasks.length,0);assert.equal(f.add(1).added.length,1);await f.queue.cancelAll();
});
test('cleanup occupies its slot and failure is reported without stopping other jobs',async()=>{
 const cleanup=deferred(),f=fixture({cleanup:async task=>{if(task.id===f.started[0]){await cleanup.promise;throw Error('cleanup failed');}}});f.add(2);f.queue.start();await turn();
 f.gates.get(f.started[0]).resolve();await turn();assert.equal(f.started.length,1);assert.equal(f.queue.state().running,1);
 cleanup.resolve();await turn();assert.equal(f.started.length,2);f.gates.get(f.started[1]).resolve();await f.done();
 assert.equal(f.queue.state().tasks[0].state,'failed');assert.match(f.queue.state().tasks[0].error,/cleanup/);assert.equal(f.queue.state().tasks[1].state,'completed');
});
test('canonical input duplicate detection covers tracking parameters and platform aliases',async()=>{
 const f=fixture();const result=f.queue.addBatch('https://youtu.be/jNQXAC9IVRw\nhttps://www.youtube.com/watch?v=jNQXAC9IVRw&t=5\nhttps://twitter.com/user/status/123\nhttps://x.com/i/web/status/123\nBV17x411w7KC\nhttps://www.bilibili.com/video/BV17x411w7KC/?x=1\nhttps://b23.tv/eOYc04u?a=1\nhttps://b23.tv/eOYc04u\nhttps://evil.invalid/video/BV17x411w7KC/',{folder:path.resolve('test')});
 assert.equal(result.added.length,4);assert.equal(result.duplicates.length,4);assert.equal(result.invalid.length,1);
 for(const input of ['https://bilibili.com.evil.invalid/video/BV17x411w7KC','https://user:pass@x.com/u/status/1','garbage','http://b23.tv/abc'])assert.throws(()=>normalizeLink(input));
 await f.queue.cancelAll();
});
test('resolved b23/BV aliases are skipped before duplicate output is downloaded',async()=>{
 let runs=0;const f=fixture({prepare:async()=>({title:'same',canonical:'bili:BV17x411w7KC'}),run:async()=>{runs++;return {file:'same.mp4'};}});
 f.queue.setConcurrency(3);f.queue.addBatch('https://b23.tv/eOYc04u\nBV17x411w7KC',{folder:path.resolve('test')});f.queue.start();await f.done();
 assert.equal(runs,1);assert.equal(f.queue.state().tasks.filter(task=>task.state==='skipped').length,1);
});
test('legacy single downloads share capacity, and ID-less cancel cannot touch a batch job',async()=>{
 const f=fixture();f.add(2);f.queue.start();await turn();const single=f.queue.addSingle({folder:path.resolve('test'),title:'single'});await turn();
 assert.equal((await f.queue.cancel()).cancelled,true);await assert.rejects(single,/取消/);assert.equal(f.queue.jobs.get(f.started[0]).task.controller.signal.aborted,false);
 f.gates.get(f.started[0]).resolve();await turn();f.gates.get(f.started[1]).resolve();await f.done();assert.equal(f.queue.state().tasks.filter(task=>task.state==='completed').length,2);
});
test('terminal tasks reject late progress and task IDs cannot be reused',async()=>{
 const f=fixture();const id=f.queue.newTaskId(),pending=f.queue.addSingle({folder:path.resolve('test'),title:'single',taskId:id});await turn();
 f.gates.get(id).resolve();assert.equal((await pending).taskId,id);const revision=f.queue.state().revision;
 f.reports.get(id)({label:'late',received:50,total:100});assert.equal(f.queue.state().revision,revision);
 assert.throws(()=>f.queue.addSingle({folder:path.resolve('test'),taskId:id}),/taskId/);assert.throws(()=>f.queue.addSingle({folder:path.resolve('test'),taskId:'bad'}),/taskId/);
});
test('close cancels active and waiting tasks, awaits cleanup and rejects further enqueue',async()=>{
 const f=fixture();f.add(3);f.queue.start();await turn();await f.queue.close();await f.done();assert.equal(f.queue.state().running,0);assert.equal(f.started.length,1);
 assert.throws(()=>f.queue.addSingle({folder:path.resolve('test')}),/关闭/);
});
test('cancel during parsing is scoped, and media progress starts at zero after component progress',async()=>{
 const ready=deferred();let blocked;
 const f=fixture({prepare:async(job,report)=>{
  if(!blocked){blocked=job;ready.resolve();await new Promise((_,reject)=>job.task.controller.signal.addEventListener('abort',()=>reject(Error('cancel parsing')),{once:true}));}
  report({label:'正在准备下载组件',received:80,total:100});return {title:job.input,canonical:job.input};
 }});
 f.queue.setConcurrency(3);f.add(3);f.queue.start();await ready.promise;await turn();
 assert.equal(blocked.state,'parsing');assert.ok(f.queue.state().tasks.filter(task=>task.state==='downloading').every(task=>task.progress===0&&task.received===0));
 await f.queue.cancel(blocked.task.id,true);for(const id of f.started)f.gates.get(id).resolve();await f.done();
 assert.equal(f.queue.state().tasks.filter(task=>task.state==='cancelled').length,1);assert.equal(f.queue.state().tasks.filter(task=>task.state==='completed').length,2);
});
test('input diagnostics retain original line numbers when blank lines are present',async()=>{
 const f=fixture();const result=f.queue.addBatch('\nBV17x411w7KC\n\nBV17x411w7KC\ninvalid',{folder:path.resolve('test')});
 assert.equal(result.duplicates[0].line,4);assert.equal(result.invalid[0].line,5);await f.queue.cancelAll();
});
test('unavailable renderer or invalid worker output cannot strand a task or its cleanup',async()=>{
 let cleanups=0;
 const f=fixture({emit(){throw Error('window destroyed');},run:async()=>undefined,cleanup:async()=>{cleanups++;}});
 f.add(2);f.queue.start();await f.done();assert.equal(cleanups,2);assert.equal(f.queue.state().running,0);
 assert.ok(f.queue.state().tasks.every(task=>task.state==='failed'&&/有效文件/.test(task.error)));
});
test('real filesystem publication racing three jobs keeps one owned output and cleans each private directory',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'piku-batch-race-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const ready=deferred(),release=deferred(),tasks=[];let count=0;
 const f=fixture({run:async(opts,task)=>{tasks.push(task);task.temp=await fs.mkdtemp(path.join(root,'.bilidown-'));const src=path.join(task.temp,'output.mp4');await fs.writeFile(src,task.id);if(++count===3)ready.resolve();await release.promise;task.target=path.join(root,'same.mp4');await moveOutputAtomically(src,task.target,()=>{task.ownedOutput=true;},fs,task.controller.signal);return {file:task.target};},cleanup:cleanupDownloadTask});
 f.queue.setConcurrency(3);f.queue.addBatch(links(3),{folder:root});f.queue.start();await ready.promise;release.resolve();await f.done();
 assert.equal(f.queue.state().tasks.filter(task=>task.state==='completed').length,1);assert.equal(f.queue.state().tasks.filter(task=>task.state==='failed').length,2);
 assert.equal(tasks.filter(task=>task.ownedOutput).length,1);assert.equal(await fs.readFile(path.join(root,'same.mp4'),'utf8'),tasks.find(task=>task.ownedOutput).id);assert.deepEqual(await fs.readdir(root),['same.mp4']);
});
test('cancelled filesystem task cannot delete sibling output or pre-existing user files',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'piku-batch-clean-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'keep.txt'),'keep');
 const ready=deferred(),hold=deferred();let blocked;
 const f=fixture({run:async(opts,task)=>{task.temp=await fs.mkdtemp(path.join(root,'.bilidown-'));const src=path.join(task.temp,'output');await fs.writeFile(src,'complete');task.target=path.join(root,task.id+'.mp4');
  if(!blocked){blocked=task;const abort=()=>hold.reject(task.controller.signal.reason);task.controller.signal.addEventListener('abort',abort,{once:true});ready.resolve();await hold.promise;}
  await moveOutputAtomically(src,task.target,()=>{task.ownedOutput=true;},fs,task.controller.signal);return {file:task.target};},cleanup:cleanupDownloadTask});
 f.queue.setConcurrency(3);f.queue.addBatch(links(3),{folder:root});f.queue.start();await ready.promise;await f.queue.cancel(blocked.id,true);await f.done();
 assert.equal(await fs.readFile(path.join(root,'keep.txt'),'utf8'),'keep');const files=await fs.readdir(root);assert.equal(files.length,3);assert.ok(files.every(name=>!name.startsWith('.bilidown-')));assert.equal(f.queue.state().tasks.filter(task=>task.state==='completed').length,2);
});

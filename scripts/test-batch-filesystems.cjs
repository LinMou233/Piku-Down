// 檔案系統整合驗證；網路與編碼使用fixture，不是GUI或真實平台下載。
// 明確執行：node scripts/test-batch-filesystems.cjs --run
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{randomUUID,createHash}=require('node:crypto');
const {publicationFixture}=require('../test/helpers/download-publication');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function main(){
 assert.equal(process.argv[2],'--run','必须明确指定--run');assert.equal(process.platform,'win32');
 const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
 const volumes=JSON.parse(execFileSync(ps,['-NoProfile','-NonInteractive','-Command','@(Get-Volume -DriveLetter C,D | Select-Object DriveLetter,FileSystem,Size,SizeRemaining) | ConvertTo-Json -Compress'],{encoding:'utf8',windowsHide:true}));
 assert.equal(volumes.find(v=>v.DriveLetter==='D').FileSystem,'FAT32');assert.equal(volumes.find(v=>v.DriveLetter==='C').FileSystem,'NTFS');
 assert.ok(volumes.find(v=>v.DriveLetter==='D').SizeRemaining>64*1024*1024);
 const fatBase=path.resolve('D:/PikuDown-FAT32-Test'),ntfsBase=path.resolve(__dirname,'../work');
 assert.equal((await fs.lstat(fatBase)).isSymbolicLink(),false);assert.equal((await fs.realpath(fatBase)).toLowerCase(),fatBase.toLowerCase());
 const before=(await fs.readdir(fatBase)).sort(),token=randomUUID(),checks=[],roots=[];
 const links='BV17x411w7KC\nhttps://x.com/user/status/123\nhttps://www.youtube.com/watch?v=jNQXAC9IVRw';
 function prepare(title){return async job=>({folder:job.task.folder,title:title?title(job):job.platform,bvid:job.platform==='bilibili'?'BVfixture':'external:'+job.platform,cid:1,qn:80,canonical:job.input});}
 const execute=async(f,root)=>{f.queue.setConcurrency(3);f.queue.addBatch(links,{folder:root});f.queue.start();return Promise.allSettled([...f.queue.jobs.values()].map(job=>job.done));};
 const ownRoot=async(parent,prefix)=>{const root=await fs.mkdtemp(path.join(parent,prefix));roots.push({root,parent,prefix});await fs.writeFile(path.join(root,'.piku-batch-owner'),token,{flag:'wx'});return root;};
 async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name);}
 try{
  for(const [label,base] of [['NTFS',ntfsBase],['FAT32',fatBase]]){
   const root=await ownRoot(base,'batch-files-');
   await check(label+'：三平台共用真实发布与独立任务历史',async()=>{
    const dir=path.join(root,'normal');await fs.mkdir(dir);const operations=[];
    const f=publicationFixture(dir,{prepareBatch:prepare(),io:{...fs,link:async(...args)=>{try{const result=await fs.link(...args);operations.push({method:'link',ok:true});return result;}catch(e){operations.push({method:'link',code:e.code});throw e;}},copyFile:async(...args)=>{operations.push({method:'copyFile'});return fs.copyFile(...args);}}});
    const results=await execute(f,dir);assert.ok(results.every(r=>r.status==='fulfilled'));assert.equal(f.history().length,4);
    assert.equal(new Set(f.publications.map(p=>p.taskId)).size,3);assert.equal(new Set(f.publications.map(p=>path.dirname(p.src))).size,3);
    assert.deepEqual((await fs.readdir(dir)).sort(),['bilibili.mp4','x.mp4','youtube.mp4']);
    for(const result of results)assert.equal(await fs.readFile(result.value.file,'utf8'),'complete fixture');
    if(label==='NTFS'){assert.equal(operations.filter(o=>o.method==='link'&&o.ok).length,3);assert.equal(operations.filter(o=>o.method==='copyFile').length,0);}
    else{assert.equal(operations.filter(o=>o.code==='EISDIR').length,6);assert.equal(operations.filter(o=>o.method==='copyFile').length,3);}
    checks.push({label,operations,files:await Promise.all(results.map(async r=>({name:path.basename(r.value.file),size:(await fs.stat(r.value.file)).size,sha256:createHash('sha256').update(await fs.readFile(r.value.file)).digest('hex')})))});
   });
   await check(label+'：三任务同名竞争只发布一个文件',async()=>{
    const dir=path.join(root,'race');await fs.mkdir(dir);const ready=deferred(),release=deferred();let count=0;
    const f=publicationFixture(dir,{prepareBatch:prepare(()=> 'same'),beforePublish:async()=>{if(++count===3)ready.resolve();await release.promise;}});
    const pending=execute(f,dir);await ready.promise;release.resolve();const result=await pending;
    assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(result.filter(r=>r.status==='rejected'&&r.reason.code==='EEXIST').length,2);
    assert.equal(f.history().length,2);assert.deepEqual(await fs.readdir(dir),['same.mp4']);assert.equal(await fs.readFile(path.join(dir,'same.mp4'),'utf8'),'complete fixture');
   });
   await check(label+'：取消已发布任务A不删除B／C或既有文件',async()=>{
    const dir=path.join(root,'cancel');await fs.mkdir(dir);await fs.writeFile(path.join(dir,'keep.txt'),'keep',{flag:'wx'});
    const f=publicationFixture(dir,{prepareBatch:prepare(),cancelAfterPublish:task=>path.basename(task.target)==='bilibili.mp4'});
    const result=await execute(f,dir);assert.equal(result.filter(r=>r.status==='fulfilled').length,2);assert.equal(f.history().length,3);
    assert.deepEqual((await fs.readdir(dir)).sort(),['keep.txt','x.mp4','youtube.mp4']);assert.equal(await fs.readFile(path.join(dir,'keep.txt'),'utf8'),'keep');
   });
   for(const code of ['EIO','ENOSPC'])await check(label+'：'+code+'部分复制不留下正式输出或任务暂存',async()=>{
    const dir=path.join(root,code);await fs.mkdir(dir);
    const f=publicationFixture(dir,{prepareBatch:prepare(),io:{...fs,link:async()=>{throw Object.assign(Error('cross-device'),{code:'EXDEV'});},copyFile:async(_,target)=>{await fs.writeFile(target,'partial',{flag:'wx'});throw Object.assign(Error(code),{code});}}});
    const results=await execute(f,dir);assert.ok(results.every(r=>r.status==='rejected'&&r.reason.code===code));assert.equal(f.history().length,1);assert.deepEqual(await fs.readdir(dir),[]);
   });
  }
 }finally{
  for(const {root,parent,prefix} of roots){assert.equal(path.dirname(path.resolve(root)),parent);assert.ok(path.basename(root).startsWith(prefix));assert.equal((await fs.lstat(root)).isSymbolicLink(),false);assert.equal((await fs.realpath(root)).toLowerCase(),root.toLowerCase());assert.equal(await fs.readFile(path.join(root,'.piku-batch-owner'),'utf8'),token);await fs.rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:150});}
 }
 assert.deepEqual((await fs.readdir(fatBase)).sort(),before);checks.push('本次目录已清理，D槽原有目录项目不变');
 const result={date:new Date().toISOString(),type:'real filesystem I/O with network/media fixtures; not GUI',volumes,checks};
 await fs.writeFile(path.join(ntfsBase,'batch-filesystem-results.json'),JSON.stringify(result,null,2));console.log('PASS '+checks.filter(c=>typeof c==='string').length+' checks');
}
main().catch(e=>{console.error(e);process.exitCode=1;});

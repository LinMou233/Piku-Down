const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(process.env.PIKU_UI_TEST_SOURCE||path.join(__dirname,'../ui/app.js'),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const sample=(title='sample')=>({title,bvid:title,pages:[{cid:1,page:1,part:title}]});
const available={video:[{id:80,label:'1080p',available:true}],audio:true};
function renderer(overrides={}){
 const nodes=new Map();
 const $=id=>{
  if(!nodes.has(id))nodes.set(id,{hidden:false,disabled:false,value:'',textContent:'',dataset:{},options:[],
   replaceChildren(...options){this.options=options;this.value=options[0]?.value??'';},
   add(option){this.options.push(option);},get selectedOptions(){return this.options.filter(o=>o.value===String(this.value));},
   querySelector(){return this.audioOption??={disabled:false};},removeAttribute(){},focus(){}});
  return nodes.get(id);
 };
 for(const id of ['view-history','view-settings','result','reveal','cancel','cancelDelete'])$(id).hidden=true;
 $('progress').value=0;$('downloadKind').value='video';$('audioOutput').value='m4a';$('accessMode').value='public';
 let progress;const revealed=[],calls=[];
 const bili={parse:async()=>sample(),formats:async()=>available,settings:async()=>({downloadDir:'C:/test'}),
  download:async opts=>{calls.push(opts);return {file:'C:/test/'+opts.title+'.mp4'};},
  reveal:file=>revealed.push(file),onProgress:fn=>{progress=fn;},cancel:async()=>{},cancelAndDelete:async()=>({cancelled:true}),...overrides};
 const context=vm.createContext({document:{getElementById:$},bili,createGuestNotice:()=>()=>{},isVideoCover:()=>false,currentView:'parse',
  switchView(){},settings:{},loadHistory:async()=>{},Option:function(label,value){this.text=label;this.value=String(value);}});
 const prefixEnd=source.indexOf('let settings=');assert.ok(prefixEnd>0);
 vm.runInContext(source.slice(0,prefixEnd),context);
 const kindStart=source.indexOf('function updateDownloadKind()'),kindEnd=source.indexOf("$('downloadKind').onchange",kindStart);
 vm.runInContext(source.slice(kindStart,kindEnd),context);
 const cancelStart=source.indexOf("$('cancelDelete').onclick="),cancelEnd=source.indexOf("$('performanceMode').onchange",cancelStart);
 vm.runInContext(source.slice(cancelStart,cancelEnd),context);
 const evaluate=code=>vm.runInContext(code,context);
 if(!overrides.settings)evaluate("folder='C:/test'");
 return {$,bili,context,progress:data=>progress(data),revealed,calls,evaluate,
  parse:()=>evaluate('run(parseVideo)'),download:()=>$('download').onclick(),
  seed:async()=>{await evaluate('parseVideo()');await $('download').onclick();assert.equal($('progress').value,100);}};
}
function cleared(r){assert.equal(r.$('progress').value,0);assert.equal(r.$('progressText').textContent,'');assert.equal(r.$('reveal').hidden,true);assert.equal(r.evaluate('lastFile'),undefined);}

test('reparse clears completed output immediately, including while parse is pending',async()=>{
 const r=renderer();await r.seed();const next=deferred();r.bili.parse=()=>next.promise;
 const pending=r.parse();cleared(r);assert.equal(r.$('download').disabled,true);assert.equal(r.$('cancel').hidden,true);
 r.$('reveal').onclick();assert.equal(r.revealed.length,0);next.resolve(sample('next'));await pending;cleared(r);
});
test('failed reparse leaves no previous completion or reveal action',async()=>{
 const r=renderer();await r.seed();r.bili.parse=async()=>{throw Error('parse failed');};await r.parse();cleared(r);assert.equal(r.$('status').textContent,'parse failed');
});
test('new download starts at zero and keeps the completed file reveal action',async()=>{
 const r=renderer();await r.seed();const next=deferred();r.bili.download=()=>next.promise;
 const pending=r.download();cleared(r);assert.equal(r.$('cancel').hidden,false);assert.equal(r.$('download').disabled,true);
 r.progress({label:'downloading',received:25,total:100});assert.equal(r.$('progress').value,25);
 next.resolve({file:'C:/test/new.mp4',video:{width:1920,height:1080,fps:30}});await pending;
 assert.equal(r.$('progress').value,100);assert.equal(r.$('progressText').textContent,'已保存：C:/test/new.mp4');assert.equal(r.$('reveal').hidden,false);
 r.$('reveal').onclick();assert.deepEqual(r.revealed,['C:/test/new.mp4']);
});
test('progress after completion or during a new parse cannot overwrite UI state',async()=>{
 const r=renderer();await r.seed();const saved=r.$('progressText').textContent;
 r.progress({label:'late',received:1,total:2});assert.equal(r.$('progressText').textContent,saved);assert.equal(r.$('progress').value,100);
 const next=deferred();r.bili.parse=()=>next.promise;const pending=r.parse();r.progress({label:'late',received:1,total:2});cleared(r);
 assert.equal(r.$('status').textContent,'正在解析视频…');next.resolve(sample());await pending;
});
test('old formats success cannot populate a new parse while its request is pending',async()=>{
 const old=deferred(),started=deferred(),r=renderer({formats:()=>{started.resolve();return old.promise;}});const first=r.parse();await started.promise;
 const next=deferred();r.bili.parse=()=>next.promise;r.bili.formats=async()=>available;
 const second=r.parse();old.resolve(available);await first;
 assert.equal(r.$('quality').options.length,0);assert.equal(r.$('download').disabled,true);assert.equal(r.$('parse').disabled,true);
 next.resolve(sample('new'));await second;assert.equal(r.$('title').textContent,'new');assert.equal(r.$('quality').options.length,1);
});
test('stale parse success and failure cannot replace the latest result or status',async()=>{
 for(const fail of [false,true]){
  const old=deferred(),r=renderer({parse:()=>old.promise});const first=r.parse();r.bili.parse=async()=>sample('new');await r.parse();
  const status=r.$('status').textContent;if(fail)old.reject(Error('old parse failed'));else old.resolve(sample('old'));await first;
  assert.equal(r.$('title').textContent,'new');assert.equal(r.$('status').textContent,status);assert.equal(r.$('parse').disabled,false);
 }
});
test('stale formats errors do not replace a newer parse status',async()=>{
 const old=deferred(),started=deferred(),r=renderer({formats:()=>{started.resolve();return old.promise;}});const first=r.parse();await started.promise;
 r.bili.formats=async()=>available;r.bili.parse=async()=>sample('new');await r.parse();const status=r.$('status').textContent;
 old.reject(Error('old formats failed'));await first;assert.equal(r.$('status').textContent,status);
});
test('returning home invalidates pending formats and clears completed state',async()=>{
 const r=renderer();await r.seed();const old=deferred(),started=deferred();r.bili.formats=()=>{started.resolve();return old.promise;};const pending=r.parse();await started.promise;
 r.evaluate('resetParseHome()');old.resolve(available);await pending;cleared(r);
 assert.equal(r.$('result').hidden,true);assert.equal(r.$('download').disabled,true);assert.equal(r.$('status').textContent,'准备就绪');
});
test('settings lookup is locked immediately and late progress is ignored until download starts',async()=>{
 const settings=deferred(),transfer=deferred(),r=renderer({settings:()=>settings.promise});await r.parse();let requests=0;r.bili.download=()=>{requests++;return transfer.promise;};
 const first=r.download(),second=r.download();cleared(r);assert.equal(r.$('parse').disabled,true);
 r.progress({label:'late',received:100,total:100});cleared(r);settings.resolve({downloadDir:'C:/test'});await Promise.resolve();
 transfer.resolve({file:'C:/test/new.mp4'});await Promise.all([first,second]);assert.equal(r.$('progress').value,100);assert.equal(requests,1);
});
test('failed download clears old completion and ignores late progress',async()=>{
 const r=renderer();await r.seed();r.bili.download=async()=>{throw Error('download failed');};await r.download();cleared(r);
 r.progress({label:'late',received:100,total:100});cleared(r);assert.equal(r.$('status').textContent,'download failed');assert.equal(r.$('parse').disabled,false);
});
test('late cancel response or error cannot change a new download or its buttons',async()=>{
 for(const fail of [false,true]){
  const old=deferred(),cancel=deferred(),next=deferred(),r=renderer({download:()=>old.promise,cancelAndDelete:()=>cancel.promise});await r.parse();
  const first=r.download(),cancelling=r.$('cancelDelete').onclick();old.reject(Error('cancelled'));await first;
  r.bili.download=()=>next.promise;const second=r.download();const status=r.$('status').textContent;
  if(fail)cancel.reject(Error('old cleanup failed'));else cancel.resolve({cancelled:true});await cancelling;
  assert.equal(r.$('status').textContent,status);assert.equal(r.$('progressText').textContent,'');assert.equal(r.$('parse').disabled,true);assert.equal(r.$('cancel').hidden,false);
  next.resolve({file:'C:/test/new.mp4'});await second;
 }
});
test('cancelled download keeps cleanup message and ignores subsequent progress',async()=>{
 const transfer=deferred(),cancel=deferred(),r=renderer({download:()=>transfer.promise,cancelAndDelete:()=>cancel.promise});await r.parse();
 const downloading=r.download(),cancelling=r.$('cancelDelete').onclick();transfer.reject(Error('下载已取消'));await downloading;
 cancel.resolve({cancelled:true});await cancelling;assert.equal(r.$('progress').value,0);assert.equal(r.$('reveal').hidden,true);
 const text=r.$('progressText').textContent;r.progress({label:'late',received:99,total:100});assert.equal(r.$('progressText').textContent,text);assert.match(text,/已清理/);
});
test('component installation progress still updates settings without changing download progress',()=>{
 const r=renderer();r.$('view-settings').hidden=false;r.progress({label:'installing',received:5,total:10});
 assert.equal(r.$('externalStatus').textContent,'installing');assert.equal(r.$('progress').value,0);assert.equal(r.$('progressText').textContent,'');
});
test('a no-task cancel reply cannot replace a successful completion',async()=>{
 const transfer=deferred(),cancel=deferred(),r=renderer({download:()=>transfer.promise,cancelAndDelete:()=>cancel.promise});await r.parse();
 const downloading=r.download(),cancelling=r.$('cancelDelete').onclick();transfer.resolve({file:'C:/test/done.mp4'});await downloading;
 cancel.resolve({cancelled:false});await cancelling;
 assert.equal(r.$('progressText').textContent,'已保存：C:/test/done.mp4');assert.equal(r.$('reveal').hidden,false);
});
test('batch task progress never changes the original single-download UI',async()=>{
 const transfer=deferred(),r=renderer({download:()=>transfer.promise});await r.parse();const pending=r.download();
 r.progress({taskId:'batch-id',source:'batch',label:'other task',received:90,total:100});assert.equal(r.$('progress').value,0);assert.equal(r.$('progressText').textContent,'');
 transfer.resolve({file:'single.mp4'});await pending;
});
test('single task IDs reject a previous task progress event and scope cancellation',async()=>{
 const started=deferred(),transfer=deferred();let cancelled;
 const r=renderer({newTaskId:async()=> 'current-id',download:()=>{started.resolve();return transfer.promise;},cancel:id=>{cancelled=id;}});await r.parse();const pending=r.download();await started.promise;
 r.progress({taskId:'previous-id',source:'single',label:'old',received:100,total:100});assert.equal(r.$('progress').value,0);
 r.progress({taskId:'current-id',source:'single',label:'current',received:25,total:100});assert.equal(r.$('progress').value,25);
 r.$('cancel').onclick();assert.equal(cancelled,'current-id');transfer.resolve({file:'single.mp4'});await pending;
});
test('component installation status remains visible after a tagged single download has completed',async()=>{
 const r=renderer({newTaskId:async()=> 'completed-id'});await r.seed();r.$('view-settings').hidden=false;
 r.progress({label:'installing',received:5,total:10});assert.equal(r.$('externalStatus').textContent,'installing');assert.equal(r.$('progress').value,100);assert.match(r.$('progressText').textContent,/已保存/);
});

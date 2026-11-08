const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function bridge({arch='x64',ready=Promise.resolve(),invoke=async()=>true,scoped=false}={}){
  const calls=[],listeners=new Map(),windowListeners=new Map(),documentListeners=new Map();
  const window={__PIKU_BOOT__:{arch,theme:'dark',performance:true},__TAURI__:{
    core:{invoke:async(name,args)=>{calls.push([name,args]);return invoke(name,args);}},
    event:{listen:(name,fn)=>{listeners.set(name,fn);return ready;}}
  }};
  if(scoped)window.__TAURI__.webviewWindow={getCurrentWebviewWindow:()=>({listen:(name,fn)=>{windowListeners.set(name,fn);return ready;}})};
  const document={addEventListener(name,fn){documentListeners.set(name,fn);}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../ui/tauri-bridge.js'),'utf8'),{window,document});
  return {window,calls,listeners,windowListeners,documentListeners};
}
const titlebarEvent=(detail,selector='.windowbar')=>({button:0,detail,target:{closest:query=>query.includes(selector)&&!/button/.test(query)?{}:null}});
test('窗口移动与最大化事件只监听当前窗口，下载事件仍为全局',()=>{
  const f=bridge({scoped:true});
  f.window.bili.onWindowMotion(()=>{});f.window.bili.onWindowState(()=>{});f.window.login.onWindowMotion(()=>{});f.window.downloadEvents.onState(()=>{});
  assert.ok(f.windowListeners.has('windowMotion'));assert.ok(f.windowListeners.has('windowStateChanged'));
  assert.ok(!f.listeners.has('windowMotion'));assert.ok(f.listeners.has('downloadState'));
});
test('标题栏单击拖动、双击最大化，登录窗口双击不最大化',async()=>{
  const f=bridge();const down=f.documentListeners.get('mousedown');
  down(titlebarEvent(1));down(titlebarEvent(2));down(titlebarEvent(2,'.login-titlebar'));
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(f.calls.map(c=>c[1].args[0]),['drag','maximize']);
});
test('Tauri桥接保留界面调用方法和taskId事件载荷',async()=>{
  const f=bridge();
  const names=['account','logout','folder','parse','formats','download','cancel','cancelAndDelete','reveal','settings','saveSettings','wallpaper','importWallpaper','history','clearHistory','library','windowAction','windowState','authState','openLogin','externalState','externalInstall','externalImport','externalRemember','externalClear','newTaskId','batchAdd','batchState','batchStart','batchPause','batchResume','batchConcurrency','batchCancelAll','batchClear'];
  for(const name of names)assert.equal(typeof f.window.bili[name],'function',name);
  await f.window.bili.cancelAndDelete('task-a');
  assert.equal(JSON.stringify(f.calls[0]),JSON.stringify(['dispatch',{command:'cancelAndDelete',args:['task-a']}]));
  let event;f.window.downloadEvents.onState(value=>{event=value;});
  f.listeners.get('downloadState')({payload:{taskId:'task-b',received:12}});
  assert.equal(event.taskId,'task-b');assert.equal(event.received,12);
});
test('监听器完成注册后才发送下载请求',async()=>{
  let ready;const f=bridge({ready:new Promise(resolve=>{ready=resolve;})});
  f.window.bili.onProgress(()=>{});
  const pending=f.window.bili.download({taskId:'task-a'});
  await Promise.resolve();assert.equal(f.calls.length,0);
  ready();await pending;assert.equal(f.calls[0][1].command,'download');
});
test('架构与首屏主题来自Rust初始化数据',()=>{
  for(const arch of ['ia32','arm64','x64']){const f=bridge({arch});assert.equal(f.window.externalEvents.arch,arch);assert.equal(f.window.bili.initialTheme,'dark');assert.equal(f.window.login.initialTheme,'dark');assert.equal(f.window.bili.initialPerformance,true);}
});
test('RPC错误保留界面可读的Error对象',async()=>{
  const f=bridge({invoke:async()=>{throw '同名文件已存在';}});
  await assert.rejects(f.window.bili.download({}),error=>error.message==='同名文件已存在');
});

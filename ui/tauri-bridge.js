/* 保留现有界面的调用约定，业务由Rust处理。 */
(() => {
  'use strict';
  const api = window.__TAURI__;
  if (!api) throw Error('请在Piku Down桌面程序中打开此界面');
  const pending = [];
  // 窗口移动与最大化状态只属于当前窗口；Tauri2的event.listen会收到所有窗口的事件。
  const current = api.webviewWindow?.getCurrentWebviewWindow?.();
  const subscribe = (name, fn, scoped = false) => { const source = scoped && current ? current : api.event; const promise = source.listen(name, e => fn(e.payload)); pending.push(promise); return promise; };
  const call = async (command, ...args) => {
    await Promise.all(pending);
    try { return await api.core.invoke('dispatch', {command, args}); }
    catch (message) { throw new Error(typeof message === 'string' ? message : '操作失败，请重试'); }
  };
  const names = ['account','logout','folder','parse','formats','download','cancel','cancelAndDelete','reveal','settings','saveSettings','wallpaper','importWallpaper','history','clearHistory','library','windowAction','windowState','authState','openLogin','externalState','externalInstall','externalImport','externalRemember','externalClear','newTaskId','batchAdd','batchState','batchStart','batchPause','batchResume','batchConcurrency','batchCancelAll','batchClear'];
  window.bili = Object.fromEntries(names.map(name => [name, (...args) => call(name,...args)]));
  Object.assign(window.bili, {
    legacy:false, initialTheme:window.__PIKU_BOOT__?.theme||'light', initialPerformance:!!window.__PIKU_BOOT__?.performance, initialDragEffects:true,
    onAuthState:fn=>subscribe('authStateChanged',fn), onWindowMotion:fn=>subscribe('windowMotion',fn,true),
    onWindowState:fn=>subscribe('windowStateChanged',fn,true), onProgress:fn=>subscribe('progress',fn)
  });
  window.externalEvents = {arch:window.__PIKU_BOOT__?.arch||'unknown'};
  window.downloadEvents = {onState:fn=>subscribe('downloadState',fn)};
  window.login = {qr:()=>call('qr'),poll:key=>call('poll',key),close:()=>call('loginClose')};
  Object.assign(window.login,{initialTheme:window.bili.initialTheme,initialPerformance:window.bili.initialPerformance,legacy:false,initialDragEffects:true,onWindowMotion:fn=>subscribe('windowMotion',fn,true)});
  // 标题栏：单击拖动，双击最大化／还原（登录窗口不可调整大小，只拖动）。
  document.addEventListener('mousedown', e => {
    if(e.button!==0 || !e.target.closest('.windowbar, .login-titlebar') || e.target.closest('button,input,select,a')) return;
    if(e.detail===2){ if(e.target.closest('.windowbar')) call('windowAction','maximize').catch(()=>{}); }
    else if(e.detail===1) call('windowAction','drag').catch(()=>{});
  });
})();

const { app, BrowserWindow, ipcMain, session, dialog, shell, nativeImage, nativeTheme, net, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { parseId, safeName } = require('./core');
const { createLibrary } = require('./library');
const { createAuthGate } = require('./auth');
const {frameRate,selectVideo,selectBestVideo,audioEncoding,playableStreams}=require('./media');
const {inspectMedia}=require('./probe');
const {createDownloadTask,cleanupDownloadTask}=require('./download-task');
const {sessionFetch,abortScope}=require('./network');
const {mediaBinary}=require('./media-binary');
const { createExternalRuntime } = require('./external-runtime');
const { createExternalAuth, checkPlatform } = require('./external-auth');
const { createExternalMedia, parseExternalUrl } = require('./external-media');
const { createPlayCache, createTransfer, downloadDashStreams } = require('./bili-download');
const { moveOutputAtomically } = require('./output-file');
const { createDownloadQueue, normalizeLink } = require('./download-queue');
const fetchSession=(url,options)=>sessionFetch(ses,url,options,net);
const legacyRuntime=Number(process.versions.electron.split('.')[0])<=22;let performanceMode=legacyRuntime,dragEffects=true;
let win, ses, loginWin, currentQrKey, quitting=false;
const protectedChannels=new Set(['parse','formats','download','folder','reveal','library','history','clearHistory','saveSettings','importWallpaper','externalState','externalInstall','externalImport','externalRemember','externalClear','cancel','cancelAndDelete','batchAdd','batchState','batchStart','batchPause','batchResume','batchConcurrency','batchCancelAll','batchClear','newTaskId']);
function handle(name,callback){ipcMain.handle(name,async(event,...args)=>{if(protectedChannels.has(name)){if(event.sender!==win?.webContents)throw Error('无效的窗口请求');if(name==='library')await auth.require();}return callback(event,...args);});}
app.setName('Piku Down');
// Keep the existing profile location across the product rename.
app.setPath('userData',path.join(app.getPath('appData'),'bili-desktop'));
app.setAppUserModelId('local.bili.desktop');

const externalRoot = app.getPath('userData');
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); } });
const externalLifetime = new AbortController();
const pendingExternal = new Set();
const externalRuntime = createExternalRuntime({ root: externalRoot, legacy: legacyRuntime, fetch: (url, options) => sessionFetch(session.defaultSession, url, options, net) });
const externalAuth = createExternalAuth({ root: externalRoot, safeStorage, clearLegacyX: () => session.fromPartition('persist:piku-x').clearStorageData() });
const externalProgress = value => { if (win && !win.isDestroyed()) win.webContents.send('progress', value); };
const externalMedia = createExternalMedia({ runtime: externalRuntime, auth: externalAuth, root: path.join(externalRoot, 'external-temp'), ffmpeg: mediaBinary, progress: externalProgress, win7Playback: legacyRuntime, ...(externalRuntime.jsRuntime && { jsRuntime: externalRuntime.jsRuntime }) });
const isExternal = value => typeof value === 'string' && value.startsWith('external:');
function idleAccounts() { if (downloads.hasWork()) throw Error('请在下载结束后更改登录状态'); }
handle('externalState', async () => ({ accounts: await externalAuth.status(), runtime: await externalRuntime.status() }));
handle('externalInstall', async () => { idleAccounts(); await externalRuntime.ensure(undefined, externalProgress); return externalRuntime.status(); });
handle('externalImport', async (_, platform, options = {}) => {
  idleAccounts(); checkPlatform(platform);
  const selected = await dialog.showOpenDialog(win, { title: '导入 ' + (platform === 'x' ? 'X' : 'YouTube') + ' Cookie', properties: ['openFile'], filters: [{ name: 'Netscape Cookie 文件', extensions: ['txt'] }] });
  if (selected.canceled) return null;
  if ((await fs.stat(selected.filePaths[0])).size > 2 * 1024 * 1024) throw Error('Cookie 文件过大');
  await externalAuth.importCookies(platform, await fs.readFile(selected.filePaths[0], 'utf8'), { remember: options.remember === true });
  return externalAuth.status();
});
handle('externalRemember', async (_, platform, remember) => { idleAccounts(); checkPlatform(platform); await externalAuth.setRemembered(platform, remember === true); return externalAuth.status(); });
handle('externalClear', async (_, platform) => { idleAccounts(); checkPlatform(platform); await externalAuth.clear(platform); return externalAuth.status(); });

const headers = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' };
async function api(url,{signal}={}) {
 signal?.throwIfAborted();
 const scope=abortScope(signal,15000);let r,j;try{r=await fetchSession(url,{headers,signal:scope.signal});if(!r.ok)throw Error(`网络请求失败：${r.status}`);j=await r.json();}finally{scope.dispose();}

 if(j.code===-101)auth.invalidate();
 if (j.code !== 0) throw Error(`B站返回 ${j.code}：${j.message || '请求失败'}`); return j.data;
}
const playCache = createPlayCache((bvid,cid,qn,signal) => api(`https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${Number(cid)}&qn=${Number(qn)}&fnval=4048&fourk=1`,{signal}));
function play(bvid,cid,qn=127,signal) { return playCache.get(bvid,cid,qn,signal); }
app.whenReady().then(async () => {
 if (!primaryInstance) return;
 // Remove plaintext cookies left by an interrupted run in this app-owned folder.
 await fs.rm(path.join(externalRoot,'external-temp'),{recursive:true,force:true});
 const saved=await readData('settings',defaultSettings);performanceMode=legacyRuntime||!!saved.performance;dragEffects=true;const initialTheme=saved.theme==='dark'?'dark':'light';nativeTheme.themeSource=initialTheme;
 ses = session.fromPartition('persist:bilibili');
 win = new BrowserWindow({ width:940,height:680,icon:path.join(__dirname,'resources','icon.ico'),minWidth:720,minHeight:520,frame:false,backgroundColor:initialTheme==='dark'?(saved.darkColor||'#171a24'):(saved.color||'#e7ebf2'),webPreferences:{additionalArguments:['--bili-theme='+initialTheme,...(performanceMode?['--bili-performance']:[]),...(dragEffects?['--bili-drag-effects']:[]),...(legacyRuntime?['--bili-legacy']:[])],preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,devTools:false} });
 win.setMenuBarVisibility(false); win.loadFile('ui/index.html');
 attachMotion(win);
 let closing=false;win.on('close',event=>{event.preventDefault();if(closing)return;closing=true;externalLifetime.abort();Promise.allSettled([downloads.close(),...pendingExternal]).then(()=>saveQueue).finally(()=>{if(!win.isDestroyed())win.destroy();});});
 const notifyWindowState=()=>win.webContents.send('windowStateChanged',{maximized:win.isMaximized()});win.on('maximize',notifyWindowState);win.on('unmaximize',notifyWindowState);
 const windowTitle='Piku Down · B站 / X / YouTube';
 win.setTitle(windowTitle); win.on('page-title-updated',e=>e.preventDefault());
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 win.webContents.on('will-navigate', e=>e.preventDefault());
});
app.on('before-quit',()=>{quitting=true;void downloads.close().catch(()=>{});externalLifetime.abort();});
app.on('will-quit', () => externalAuth.clearSession());
app.on('window-all-closed',()=>app.quit());
handle('account',()=>auth.check(true));
handle('authState',()=>auth.current);
handle('openLogin',async()=>{const profile=await auth.check(true);if(!profile.logged)await ensureLoginWindow();return profile;});
handle('qr',async(event)=>{if(event.sender!==loginWin?.webContents)throw Error('请在登录窗口扫码');const d=await api('https://passport.bilibili.com/x/passport-login/web/qrcode/generate');currentQrKey=d.qrcode_key;return {key:d.qrcode_key,image:await require('qrcode').toDataURL(d.url,{width:256,margin:2,errorCorrectionLevel:'M'})};});
handle('poll',async(event,key)=>{if(event.sender!==loginWin?.webContents)throw Error('无效的登录窗口');if(key!==currentQrKey)return {code:86038};const data=await api('https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key='+encodeURIComponent(key));if(data.code===0){const profile=await auth.check(true);if(!profile.logged)throw Error(profile.error||'登录尚未验证，请稍后重试');}return data;});
handle('loginClose',event=>{if(event.sender===loginWin?.webContents)loginWin.close();});
handle('logout',async()=>{downloads.pause();await downloads.cancelAll();playCache.clear();auth.invalidate();await ses.clearStorageData();if(loginWin&&!loginWin.isDestroyed())loginWin.close();return true;});
handle('folder',async()=>{const saved=await readData('settings',defaultSettings);const d=await dialog.showOpenDialog(win,{defaultPath:saved.downloadDir||app.getPath('videos'),properties:['openDirectory','createDirectory']});if(d.canceled)return null;const downloadDir=d.filePaths[0];await updateData('settings',current=>({...current,downloadDir}));return downloadDir;});
handle('parse',(_,input,options={})=>parseInput(input,options));
async function parseInput(input,options={},signal,progress=externalProgress){
 if (parseExternalUrl(input)) {
   const pending = externalMedia.parse(input, options.access || 'public', signal || externalLifetime.signal, progress);
   pendingExternal.add(pending);
   try { return await pending; } finally { pendingExternal.delete(pending); }
 }
 let value=input.trim();
 if (/^https:\/\/b23\.tv\//i.test(value)) {
  const scope=abortScope(signal,15000);
  try {const r=await fetchSession(value,{method:'HEAD',headers,signal:scope.signal,resolveRedirects:true});if(!r.ok)throw Error(`短链接展开失败：${r.status}`);value=r.url;}finally{scope.dispose();}
 }
 const id=parseId(value);const d=await api(`https://api.bilibili.com/x/web-interface/view?${id}`,{signal});
 return {bvid:d.bvid,title:d.title,owner:d.owner.name,cover:d.pic,duration:d.duration,pages:d.pages.map(p=>({cid:p.cid,page:p.page,part:p.part}))};
}
handle('formats',(_,bvid,cid)=>getFormats(bvid,cid));
async function getFormats(bvid,cid,signal){
 if (isExternal(bvid)) return externalMedia.formats(bvid,cid);
 // Win7 builds keep only streams its Media Player can play: H.264 up to 1080p (B站 qn 116 is 1080P60).
 const data=await play(bvid,cid,undefined,signal);const streams=[...playableStreams(data.dash?.video||[],legacyRuntime)];const accepted=data.accept_quality||[];
 if(!data.dash){
  const missing=[120,116,74].filter(id=>accepted.includes(id)&&!streams.some(stream=>stream.id===id));
  const results=await Promise.allSettled(missing.map(id=>play(bvid,cid,id,signal)));for(const result of results){if(result.status==='fulfilled')streams.push(...playableStreams(result.value.dash?.video||[],legacyRuntime));}
 }
 return {video:accepted.map((id,i)=>{const selected=selectVideo(streams,id);return {id,label:data.accept_description[i],available:!!selected||(!data.dash&&data.quality===id&&(!legacyRuntime||id<=116)),fps:selected?frameRate(selected):0};}),audio:!!data.dash?.audio?.length||!!data.durl?.length};
}
handle('cancel',(_,taskId)=>downloads.cancel(taskId));
handle('cancelAndDelete',async(event,taskId)=>{if(event.sender!==win?.webContents)throw Error('无效的窗口请求');return downloads.cancel(taskId,true);});
handle('download',async(_,opts)=>downloads.addSingle({...opts,folder:await downloadFolder(opts.folder)}));
async function downloadFolder(folder){
 if(!folder)folder=(await readData('settings',defaultSettings)).downloadDir||app.getPath('videos');
 if(typeof folder!=='string'||!path.isAbsolute(folder))throw Error('无效的下载目录');
 return folder;
}
async function runDownload(opts,task,progress){
 const controller=task.controller;
 controller.signal.throwIfAborted();await fs.mkdir(task.folder,{recursive:true});controller.signal.throwIfAborted();
 const transfer=createTransfer({fetch:fetchSession,headers,progress});
 let temp,result;
 if(isExternal(opts.bvid))return downloadExternal(opts,task,progress);
 const audioOnly=opts.kind==='audio';const extension=audioOnly?(opts.audioFormat==='mp3'?'mp3':'m4a'):'mp4';const d=await play(opts.bvid,opts.cid,audioOnly?80:opts.qn,controller.signal);const signal=controller.signal;
 const target=path.join(opts.folder,safeName(opts.title)+'.'+extension);task.target=target;
 try {await fs.access(target);throw Error('同名文件已存在，请更换目录或文件名');}catch(e){if(e.code!=='ENOENT')throw e;}
 temp=await fs.mkdtemp(path.join(opts.folder,'.bilidown-'));task.temp=temp;
 const ffmpeg=mediaBinary();
 let args;
 if(audioOnly){
 const audio=[...(d.dash?.audio||[])].sort((a,b)=>b.bandwidth-a.bandwidth)[0];
 if(audio){await transfer([audio.baseUrl||audio.base_url,...(audio.backupUrl||audio.backup_url||[])],path.join(temp,'audio'),signal,'下载音频');args=['-i',path.join(temp,'audio'),...audioEncoding(extension,true)];}
 else if(d.durl?.length){for(let i=0;i<d.durl.length;i++)await transfer([d.durl[i].url,...(d.durl[i].backup_url||[])],path.join(temp,'seg'+i),signal,'读取分段音轨 '+(i+1)+'/'+d.durl.length);await fs.writeFile(path.join(temp,'list.txt'),d.durl.map((_,i)=>"file 'seg"+i+"'").join('\n'));args=['-f','concat','-safe','0','-i',path.join(temp,'list.txt'),...audioEncoding(extension,false)];}
 else throw Error('这个视频暂时没有可下载的音轨');
 }else if(d.dash){
 progress({label:'正在检测原始视频帧率',received:0,total:0});const video=await selectBestVideo(playableStreams(d.dash.video,legacyRuntime),opts.qn,stream=>{const url=stream.baseUrl||stream.base_url;return inspectMedia(ffmpeg,url,{remote:true,signal});});
 const audio=[...(d.dash.audio||[])].sort((a,b)=>b.bandwidth-a.bandwidth)[0];
 if(!video)throw Error('当前账号无法下载所选清晰度，请重新解析或登录');
 await downloadDashStreams({video,audio,folder:temp,signal,transfer,progress});
 args=['-i',path.join(temp,'video'),...(audio?['-i',path.join(temp,'audio')]:[]),'-c','copy'];
 }else {
 if(d.quality!==Number(opts.qn)||!d.durl?.length)throw Error('所选清晰度不可用');
 for(let i=0;i<d.durl.length;i++)await transfer([d.durl[i].url,...(d.durl[i].backup_url||[])],path.join(temp,`seg${i}`),signal,`下载分段 ${i+1}/${d.durl.length}`);
 await fs.writeFile(path.join(temp,'list.txt'),d.durl.map((_,i)=>`file 'seg${i}'`).join('\n'));
 args=['-f','concat','-safe','0','-i',path.join(temp,'list.txt'),'-c','copy'];
 }
 signal.throwIfAborted();progress({label:audioOnly?'正在处理音频':'正在合并音视频',received:0,total:0});
 await new Promise((resolve,reject)=>{const p=spawn(ffmpeg,['-hide_banner','-loglevel','error',...args,'-n',path.join(temp,'output.'+extension)],{windowsHide:true});let err='';p.stderr.on('data',b=>err=(err+b).slice(-3000));const cancel=()=>p.kill();signal.addEventListener('abort',cancel,{once:true});p.on('error',reject);p.on('close',code=>{signal.removeEventListener('abort',cancel);code===0&&!signal.aborted?resolve():reject(Error(signal.aborted?'下载已取消':`合并失败：${err}`));});});
 const info=audioOnly?null:await inspectMedia(ffmpeg,path.join(temp,'output.'+extension),{signal}).catch(()=>null);signal.throwIfAborted();
 await publishOutput(path.join(temp,'output.'+extension),target,task,signal);signal.throwIfAborted();await updateData('history',items=>[{taskId:task.id,title:opts.title,bvid:opts.bvid,qn:opts.qn,kind:audioOnly?'audio':'video',format:extension,video:info,file:target,date:Date.now()},...(Array.isArray(items)?items:[])].slice(0,300)).catch(()=>{});result={file:target,kind:audioOnly?'audio':'video',video:info};
 return result;
}

// Once the final file exists and the task was not cancelled, a later staging cleanup failure is only a warning.
async function publishOutput(src, target, task, signal) {
  try { await moveOutputAtomically(src, target, () => { task.ownedOutput = true; }, fs, signal); }
  catch (error) { if (!task.ownedOutput || signal.aborted) throw error; task.cleanupWarning = '正式文件已保存，但暂存文件清理失败：' + error.message; }
}

async function downloadExternal(opts, task, progress) {
  const audioOnly = opts.kind === 'audio';
  const extension = audioOnly ? (opts.audioFormat === 'mp3' ? 'mp3' : 'm4a') : 'mp4';
  const target = path.join(task.folder, safeName(opts.title) + '.' + extension);
  task.target = target;
  try { await fs.access(target); throw Error('同名文件已存在，请更换目录或文件名'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = await externalMedia.download(opts, task, progress);
  const signal = task.controller.signal;
  const info = audioOnly ? null : await inspectMedia(mediaBinary(), result.file, { signal }).catch(() => null);
  signal.throwIfAborted();
  await publishOutput(result.file, target, task, signal);
  signal.throwIfAborted();
  await updateData('history', items => [{ taskId: task.id, title: opts.title, platform: result.platform, url: result.url, qn: opts.qn, kind: audioOnly ? 'audio' : 'video', format: extension, video: info, file: target, date: Date.now() }, ...(Array.isArray(items) ? items : [])].slice(0, 300)).catch(() => {});
  return { file: target, kind: audioOnly ? 'audio' : 'video', video: info };
}

async function prepareBatch(job,progress){
 const signal=job.task.controller.signal;
 signal.throwIfAborted();await fs.mkdir(job.task.folder,{recursive:true});signal.throwIfAborted();
 const parsed=await parseInput(job.input,{access:job.settings.access},signal,progress);
 signal.throwIfAborted();
 const page=parsed.pages[0];if(!page)throw Error('没有可下载的视频');
 const formats=await getFormats(parsed.bvid,page.cid,signal);signal.throwIfAborted();
 const available=formats.video.filter(format=>format.available);
 const height=format=>Number(/(\d{3,4})[pP]/.exec(format.label)?.[1])||0;
 const maximum=job.settings.maxHeight;
 const format=available.find(format=>!maximum||height(format)<=maximum)||available.at(-1);
 if(!format)throw Error('当前视频没有可用画质');
 return {folder:job.task.folder,bvid:parsed.bvid,cid:page.cid,qn:format.id,kind:'video',title:parsed.title,
  platform:parsed.platform,canonical:parsed.platform?normalizeLink(job.input).key:'bili:'+parsed.bvid};
}
const downloads=createDownloadQueue({
 prepare:prepareBatch,run:runDownload,
 async cleanup(task){await cleanupDownloadTask(task);if(task.controller.signal.aborted&&task.ownedOutput)await updateData('history',items=>(Array.isArray(items)?items:[]).filter(item=>item.taskId!==task.id));},
 emit(task){if(win&&!win.isDestroyed()){
  win.webContents.send('downloadState',task);
  if(!['completed','cancelled','failed','skipped'].includes(task.state))win.webContents.send('progress',{taskId:task.taskId,source:task.source,label:task.label,received:task.received,total:task.total});
 }}
});
handle('newTaskId',()=>downloads.newTaskId());
handle('batchAdd',async(_,text,options={})=>{
 if(!['public','session'].includes(options.access||'public'))throw Error('无效的访问方式');
 const maxHeight=Number(options.maxHeight)||0;if(![0,360,720,1080].includes(maxHeight))throw Error('无效的画质上限');
 return downloads.addBatch(text,{folder:await downloadFolder(options.folder),access:options.access||'public',maxHeight});
});
handle('batchState',()=>downloads.state());
handle('batchStart',()=>downloads.start());
handle('batchPause',()=>downloads.pause());
handle('batchResume',()=>downloads.start());
handle('batchConcurrency',(_,value)=>downloads.setConcurrency(value));
handle('batchCancelAll',async()=>{await downloads.cancelAll('batch');return downloads.state();});
handle('batchClear',()=>downloads.clear());
handle('reveal',(_,file)=>shell.showItemInFolder(file));

let saveQueue=Promise.resolve();
async function readData(name,fallback){try{return JSON.parse(await fs.readFile(path.join(app.getPath('userData'),name+'.json'),'utf8'));}catch{return fallback;}}
function updateData(name,transform){const op=saveQueue.then(async()=>{const value=transform(await readData(name,name==='history'?[]:{}));const file=path.join(app.getPath('userData'),name+'.json');await fs.writeFile(file+'.tmp',JSON.stringify(value));await fs.rename(file+'.tmp',file);return value;});saveQueue=op.catch(()=>{});return op;}
const defaultSettings={dragEffects:true,performance:legacyRuntime,mode:'color',color:'#e7ebf2',blur:12,collapsed:false,theme:'light',darkColor:'#171a24'};
handle('settings',async()=>{const saved=await readData('settings',defaultSettings);return {...defaultSettings,...saved,downloadDir:typeof saved.downloadDir==='string'&&path.isAbsolute(saved.downloadDir)?saved.downloadDir:app.getPath('videos')};});
handle('saveSettings',async(_,value)=>{const result=await updateData('settings',current=>({downloadDir:typeof value.downloadDir==='string'&&path.isAbsolute(value.downloadDir)?value.downloadDir:current.downloadDir||app.getPath('videos'),dragEffects:true,performance:legacyRuntime||!!value.performance,mode:value.mode==='wallpaper'?'wallpaper':'color',color:/^#[0-9a-f]{6}$/i.test(value.color)?value.color:'#e7ebf2',darkColor:/^#[0-9a-f]{6}$/i.test(value.darkColor)?value.darkColor:'#171a24',theme:value.theme==='dark'?'dark':'light',blur:Math.max(0,Math.min(40,Number(value.blur)||0)),collapsed:!!value.collapsed}));performanceMode=result.performance;dragEffects=result.dragEffects;nativeTheme.themeSource=result.theme;win.setBackgroundColor(result.theme==='dark'?result.darkColor:result.color);return result;});
handle('wallpaper',async()=>{try{return 'data:image/jpeg;base64,'+(await fs.readFile(path.join(app.getPath('userData'),'wallpaper.jpg'))).toString('base64');}catch{return null;}});
handle('importWallpaper',async()=>{const result=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'背景图片',extensions:['jpg','jpeg','png','webp']}]});if(result.canceled)return null;let image=nativeImage.createFromPath(result.filePaths[0]);if(image.isEmpty())throw Error('无法读取该图片');const size=image.getSize();if(size.width>2560||size.height>1600){const scale=Math.min(2560/size.width,1600/size.height);image=image.resize({width:Math.round(size.width*scale),height:Math.round(size.height*scale)});}const bytes=image.toJPEG(85);await fs.writeFile(path.join(app.getPath('userData'),'wallpaper.jpg'),bytes);return 'data:image/jpeg;base64,'+bytes.toString('base64');});
handle('history',()=>readData('history',[]));
handle('clearHistory',()=>updateData('history',()=>[]));

const library=createLibrary(api,async()=>{const cookies=await ses.cookies.get({url:'https://www.bilibili.com/'});const uid=cookies.find(c=>c.name==='DedeUserID')?.value;return cookies.some(c=>c.name==='SESSDATA')&&/^\d+$/.test(uid||'')?uid:null;});
handle('library',(_,request)=>library(request));

handle('windowState',()=>({maximized:win.isMaximized(),minimized:win.isMinimized(),title:win.getTitle()}));
handle('windowAction',(event,action)=>{if(BrowserWindow.fromWebContents(event.sender)!==win)return;if(action==='minimize')win.minimize();else if(action==='maximize'){if(win.isMaximized())win.unmaximize();else win.maximize();}else if(action==='restore')win.restore();else if(action==='close')win.close();return {maximized:win.isMaximized()};});

const auth=createAuthGate(async()=>{
 const cookies=await ses.cookies.get({url:'https://www.bilibili.com/'});if(!cookies.some(c=>c.name==='SESSDATA'))return {logged:false};
 const d=await api('https://api.bilibili.com/x/web-interface/nav');return {name:d.uname,logged:!!d.isLogin,face:d.face,mid:d.mid,level:d.level_info?.current_level,vip:d.vipStatus===1,vipLabel:d.vip_label?.text||'大会员',vipDue:d.vipDueDate};
},profile=>{
 playCache.clear();
 if(win&&!win.isDestroyed())win.webContents.send('authStateChanged',profile);
 if(profile.logged){if(loginWin&&!loginWin.isDestroyed())loginWin.close();}

});
async function ensureLoginWindow(){
 if(quitting||!win||win.isDestroyed()||auth.current.logged)return;
 if(loginWin&&!loginWin.isDestroyed()){loginWin.show();loginWin.focus();return;}
 const saved=await readData('settings',defaultSettings);if(loginWin&&!loginWin.isDestroyed()||quitting||auth.current.logged)return;
 const theme=saved.theme==='dark'?'dark':'light';
 loginWin=new BrowserWindow({parent:win,modal:true,width:400,height:520,frame:false,resizable:false,maximizable:false,minimizable:false,movable:true,show:false,icon:path.join(__dirname,'resources','icon.ico'),backgroundColor:theme==='dark'?'#202638':'#eef1f7',title:'登录 Piku Down',webPreferences:{preload:path.join(__dirname,'login-preload.js'),additionalArguments:['--bili-theme='+theme,...(performanceMode?['--bili-performance']:[]),...(dragEffects?['--bili-drag-effects']:[]),...(legacyRuntime?['--bili-legacy']:[])],contextIsolation:true,nodeIntegration:false,sandbox:true,devTools:false}});
 const child=loginWin;currentQrKey=null;child.setMenuBarVisibility(false);attachMotion(child);child.webContents.setWindowOpenHandler(()=>({action:'deny'}));child.webContents.on('will-navigate',event=>event.preventDefault());child.loadFile('ui/login.html');child.once('ready-to-show',()=>{if(!child.isDestroyed()){child.show();child.focus();}});child.on('closed',()=>{if(loginWin===child)loginWin=null;currentQrKey=null;});
}
function attachMotion(window){
 let previous=window.getPosition(),latest=previous,timer=null,lastNativeAt=0;
 const queue=position=>{
  latest=position;
  if(performanceMode||!dragEffects){previous=position;return;}
  if(timer!==null)return;
  timer=setTimeout(()=>{
   timer=null;
   if(window.isDestroyed())return;
   if(performanceMode||!dragEffects){previous=latest;return;}
   const dx=previous[0]-latest[0],dy=previous[1]-latest[1];
   previous=latest;
   if(dx||dy)window.webContents.send('windowMotion',{dx,dy});
  },16);
 };
 window.on('will-move',(_,bounds)=>{lastNativeAt=Date.now();queue([bounds.x,bounds.y]);});
 window.on('move',()=>{if(Date.now()-lastNativeAt>40)queue(window.getPosition());});
 window.on('closed',()=>{if(timer!==null)clearTimeout(timer);timer=null;});
}

const { app, BrowserWindow, ipcMain, session, dialog, shell, nativeImage, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { parseId, safeName } = require('./core');
const { createLibrary } = require('./library');
const { createAuthGate } = require('./auth');
const {frameRate,selectVideo,selectBestVideo,audioEncoding}=require('./media');
const {inspectMedia}=require('./probe');
const {createDownloadTask,cleanupDownloadTask}=require('./download-task');
let win, ses, active, activeTask, loginWin, currentQrKey, quitting=false;
const protectedChannels=new Set(['parse','formats','download','folder','reveal','library','history','clearHistory','saveSettings','importWallpaper']);
function handle(name,callback){ipcMain.handle(name,async(event,...args)=>{if(protectedChannels.has(name)){if(event.sender!==win?.webContents)throw Error('无效的窗口请求');await auth.require();}return callback(event,...args);});}
app.setName('Piku Down');
// Keep the existing profile location across the product rename.
app.setPath('userData',path.join(app.getPath('appData'),'bili-desktop'));
app.setAppUserModelId('local.bili.desktop');

const headers = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' };
async function api(url,{signal}={}) {
 signal?.throwIfAborted();
 const r = await ses.fetch(url, { headers, signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000) });
 if (!r.ok) throw Error(`网络请求失败：${r.status}`);
 let j; try { j = await r.json(); } catch { throw Error('B站返回了验证页面，请稍后重试或更换网络'); }
 if(j.code===-101)auth.invalidate();
 if (j.code !== 0) throw Error(`B站返回 ${j.code}：${j.message || '请求失败'}`); return j.data;
}
async function play(bvid,cid,qn=127,signal) { return api(`https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${Number(cid)}&qn=${Number(qn)}&fnval=4048&fourk=1`,{signal}); }
app.whenReady().then(async () => {
 const saved=await readData('settings',defaultSettings);const initialTheme=saved.theme==='dark'?'dark':'light';nativeTheme.themeSource=initialTheme;
 ses = session.fromPartition('persist:bilibili');
 win = new BrowserWindow({ width:940,height:680,icon:path.join(__dirname,'resources','icon.ico'),minWidth:720,minHeight:520,frame:false,backgroundColor:initialTheme==='dark'?(saved.darkColor||'#171a24'):(saved.color||'#e7ebf2'),webPreferences:{additionalArguments:['--bili-theme='+initialTheme],preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,devTools:false} });
 win.setMenuBarVisibility(false); win.loadFile('ui/index.html');
 attachMotion(win);
 let closing=false;win.on('close',event=>{if(closing)return;event.preventDefault();closing=true;saveQueue.finally(()=>{if(!win.isDestroyed())win.destroy();});});
 const notifyWindowState=()=>win.webContents.send('windowStateChanged',{maximized:win.isMaximized()});win.on('maximize',notifyWindowState);win.on('unmaximize',notifyWindowState);
 const sayings=['且将新火试新茶，诗酒趁年华。','行到水穷处，坐看云起时。','长风破浪会有时，直挂云帆济沧海。'];
 const windowTitle='Piku Down · '+sayings[Math.floor(Math.random()*sayings.length)];
 win.setTitle(windowTitle); win.on('page-title-updated',e=>e.preventDefault());
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 win.webContents.on('will-navigate', e=>e.preventDefault());
});
app.on('before-quit',()=>{quitting=true;active?.abort();});
app.on('window-all-closed',()=>app.quit());
handle('account',()=>auth.check(true));
handle('authState',()=>auth.current);
handle('openLogin',async()=>{const profile=await auth.check(true);if(!profile.logged)await ensureLoginWindow();return profile;});
handle('qr',async(event)=>{if(event.sender!==loginWin?.webContents)throw Error('请在登录窗口扫码');const d=await api('https://passport.bilibili.com/x/passport-login/web/qrcode/generate');currentQrKey=d.qrcode_key;return {key:d.qrcode_key,image:await require('qrcode').toDataURL(d.url,{width:256,margin:2,errorCorrectionLevel:'M'})};});
handle('poll',async(event,key)=>{if(event.sender!==loginWin?.webContents)throw Error('无效的登录窗口');if(key!==currentQrKey)return {code:86038};const data=await api('https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key='+encodeURIComponent(key));if(data.code===0){const profile=await auth.check(true);if(!profile.logged)throw Error(profile.error||'登录尚未验证，请稍后重试');}return data;});
handle('loginClose',event=>{if(event.sender===loginWin?.webContents)app.quit();});
handle('logout',async()=>{active?.abort();auth.invalidate();await ses.clearStorageData();await ensureLoginWindow();return true;});
handle('folder',async()=>{const d=await dialog.showOpenDialog(win,{properties:['openDirectory','createDirectory']});return d.canceled?null:d.filePaths[0];});
handle('parse',async(_,input)=>{
 let value=input.trim();
 if (/^https:\/\/b23\.tv\//i.test(value)) {const r=await ses.fetch(value,{method:'HEAD',headers});value=r.url;}
 const id=parseId(value);const d=await api(`https://api.bilibili.com/x/web-interface/view?${id}`);
 return {bvid:d.bvid,title:d.title,owner:d.owner.name,cover:d.pic,duration:d.duration,pages:d.pages.map(p=>({cid:p.cid,page:p.page,part:p.part}))};
});
handle('formats',async(_,bvid,cid)=>{
 const data=await play(bvid,cid);const streams=[...(data.dash?.video||[])];const accepted=data.accept_quality||[];const missing=[120,116,74].filter(id=>accepted.includes(id)&&!streams.some(stream=>stream.id===id));
 const results=await Promise.allSettled(missing.map(id=>play(bvid,cid,id)));for(const result of results){if(result.status==='fulfilled')streams.push(...(result.value.dash?.video||[]));}
 return {video:accepted.map((id,i)=>{const selected=selectVideo(streams,id);return {id,label:data.accept_description[i],available:!!selected||(!data.dash&&data.quality===id),fps:selected?frameRate(selected):0};}),audio:!!data.dash?.audio?.length||!!data.durl?.length};
});
async function transfer(urls,file,signal,label) {
 let last;
 for(const url of urls.filter(Boolean)) {
 try {const r=await ses.fetch(url,{headers,signal});if(!r.ok)throw Error(`下载失败 ${r.status}`);
 const h=await fs.open(file,'w');let received=0,lastUpdate=0;const total=Number(r.headers.get('content-length'));
 try {for await(const chunk of r.body){signal.throwIfAborted();await h.write(chunk);received+=chunk.length;if(Date.now()-lastUpdate>100){win?.webContents.send('progress',{label,received,total});lastUpdate=Date.now();}}} finally {await h.close();}return;
 }catch(e){last=e;if(signal.aborted)throw e;}
 } throw last||Error('没有可用下载地址');
}
handle('cancel',()=>{active?.abort(Error('下载已取消'));});
handle('cancelAndDelete',async event=>{if(event.sender!==win?.webContents)throw Error('无效的窗口请求');const task=activeTask;if(!task)return {cancelled:false,deleted:false};task.deleteRequested=true;task.controller.abort(Error('下载已取消'));const result=await task.done;if(result.error)throw Error(result.error);return result;});
handle('download',async(_,opts)=>{
 if(active)throw Error('已有下载任务正在运行');
 if(!opts.folder||!path.isAbsolute(opts.folder))throw Error('请先选择下载目录');
 const controller=new AbortController();active=controller;const task=createDownloadTask(controller,opts.folder);activeTask=task;let temp,result,failure,cleanupError;
 try {
 const audioOnly=opts.kind==='audio';const extension=audioOnly?(opts.audioFormat==='mp3'?'mp3':'m4a'):'mp4';const d=await play(opts.bvid,opts.cid,audioOnly?80:opts.qn,controller.signal);const signal=controller.signal;
 const target=path.join(opts.folder,safeName(opts.title)+'.'+extension);task.target=target;
 try {await fs.access(target);throw Error('同名文件已存在，请更换目录或文件名');}catch(e){if(e.code!=='ENOENT')throw e;}
 temp=await fs.mkdtemp(path.join(opts.folder,'.bilidown-'));task.temp=temp;
 const ffmpeg=require('ffmpeg-static').replace('app.asar','app.asar.unpacked');
 let args;
 if(audioOnly){
 const audio=[...(d.dash?.audio||[])].sort((a,b)=>b.bandwidth-a.bandwidth)[0];
 if(audio){await transfer([audio.baseUrl||audio.base_url,...(audio.backupUrl||audio.backup_url||[])],path.join(temp,'audio'),signal,'下载音频');args=['-i',path.join(temp,'audio'),...audioEncoding(extension,true)];}
 else if(d.durl?.length){for(let i=0;i<d.durl.length;i++)await transfer([d.durl[i].url,...(d.durl[i].backup_url||[])],path.join(temp,'seg'+i),signal,'读取分段音轨 '+(i+1)+'/'+d.durl.length);await fs.writeFile(path.join(temp,'list.txt'),d.durl.map((_,i)=>"file 'seg"+i+"'").join('\n'));args=['-f','concat','-safe','0','-i',path.join(temp,'list.txt'),...audioEncoding(extension,false)];}
 else throw Error('这个视频暂时没有可下载的音轨');
 }else if(d.dash){
 win.webContents.send('progress',{label:'正在检测原始视频帧率',received:0,total:0});const video=await selectBestVideo(d.dash.video,opts.qn,stream=>{const url=stream.baseUrl||stream.base_url;return inspectMedia(ffmpeg,url,{remote:true,signal});});
 const audio=[...(d.dash.audio||[])].sort((a,b)=>b.bandwidth-a.bandwidth)[0];
 if(!video)throw Error('当前账号无法下载所选清晰度，请重新解析或登录');
 await transfer([video.baseUrl||video.base_url,...(video.backupUrl||video.backup_url||[])],path.join(temp,'video'),signal,'下载视频');
 if(audio)await transfer([audio.baseUrl,...(audio.backupUrl||[])],path.join(temp,'audio'),signal,'下载音频');
 args=['-i',path.join(temp,'video'),...(audio?['-i',path.join(temp,'audio')]:[]),'-c','copy','-movflags','+faststart'];
 }else {
 if(d.quality!==Number(opts.qn)||!d.durl?.length)throw Error('所选清晰度不可用');
 for(let i=0;i<d.durl.length;i++)await transfer([d.durl[i].url,...(d.durl[i].backup_url||[])],path.join(temp,`seg${i}`),signal,`下载分段 ${i+1}/${d.durl.length}`);
 await fs.writeFile(path.join(temp,'list.txt'),d.durl.map((_,i)=>`file 'seg${i}'`).join('\n'));
 args=['-f','concat','-safe','0','-i',path.join(temp,'list.txt'),'-c','copy'];
 }
 signal.throwIfAborted();win.webContents.send('progress',{label:audioOnly?'正在处理音频':'正在合并音视频',received:0,total:0});
 await new Promise((resolve,reject)=>{const p=spawn(ffmpeg,['-hide_banner','-loglevel','error',...args,'-n',path.join(temp,'output.'+extension)],{windowsHide:true});let err='';p.stderr.on('data',b=>err=(err+b).slice(-3000));const cancel=()=>p.kill();signal.addEventListener('abort',cancel,{once:true});p.on('error',reject);p.on('close',code=>{signal.removeEventListener('abort',cancel);code===0&&!signal.aborted?resolve():reject(Error(signal.aborted?'下载已取消':`合并失败：${err}`));});});
 const info=audioOnly?null:await inspectMedia(ffmpeg,path.join(temp,'output.'+extension),{signal}).catch(()=>null);signal.throwIfAborted();
 await fs.copyFile(path.join(temp,'output.'+extension),target,require('node:fs').constants.COPYFILE_EXCL);task.ownedOutput=true;signal.throwIfAborted();await updateData('history',items=>[{taskId:task.id,title:opts.title,bvid:opts.bvid,qn:opts.qn,kind:audioOnly?'audio':'video',format:extension,video:info,file:target,date:Date.now()},...(Array.isArray(items)?items:[])].slice(0,300)).catch(()=>{});result={file:target,kind:audioOnly?'audio':'video',video:info};
 }catch(error){failure=error;}finally{
  try{await cleanupDownloadTask(task);if(controller.signal.aborted&&task.ownedOutput)await updateData('history',items=>(Array.isArray(items)?items:[]).filter(item=>item.taskId!==task.id));}catch(error){cleanupError=error;}finally{active=null;activeTask=null;task.resolve({cancelled:controller.signal.aborted,deleted:!cleanupError,error:cleanupError?.message});}
 }
 if(cleanupError)throw cleanupError;if(controller.signal.aborted)throw Error(task.deleteRequested?'下载已取消，当前任务源文件已删除':'下载已取消');if(failure)throw failure;return result;
});
handle('reveal',(_,file)=>shell.showItemInFolder(file));

let saveQueue=Promise.resolve();
async function readData(name,fallback){try{return JSON.parse(await fs.readFile(path.join(app.getPath('userData'),name+'.json'),'utf8'));}catch{return fallback;}}
function updateData(name,transform){const op=saveQueue.then(async()=>{const value=transform(await readData(name,name==='history'?[]:{}));const file=path.join(app.getPath('userData'),name+'.json');await fs.writeFile(file+'.tmp',JSON.stringify(value));await fs.rename(file+'.tmp',file);return value;});saveQueue=op.catch(()=>{});return op;}
const defaultSettings={mode:'color',color:'#e7ebf2',blur:12,collapsed:false,theme:'light',darkColor:'#171a24'};
handle('settings',()=>readData('settings',defaultSettings));
handle('saveSettings',async(_,value)=>{const result=await updateData('settings',()=>({mode:value.mode==='wallpaper'?'wallpaper':'color',color:/^#[0-9a-f]{6}$/i.test(value.color)?value.color:'#e7ebf2',darkColor:/^#[0-9a-f]{6}$/i.test(value.darkColor)?value.darkColor:'#171a24',theme:value.theme==='dark'?'dark':'light',blur:Math.max(0,Math.min(40,Number(value.blur)||0)),collapsed:!!value.collapsed}));nativeTheme.themeSource=result.theme;win.setBackgroundColor(result.theme==='dark'?result.darkColor:result.color);return result;});
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
 if(win&&!win.isDestroyed())win.webContents.send('authStateChanged',profile);
 if(profile.logged){if(loginWin&&!loginWin.isDestroyed())loginWin.close();}
 else{active?.abort();if(win&&!win.isDestroyed()&&!quitting)ensureLoginWindow().catch(console.error);}
});
async function ensureLoginWindow(){
 if(quitting||!win||win.isDestroyed()||auth.current.logged)return;
 if(loginWin&&!loginWin.isDestroyed()){loginWin.show();loginWin.focus();return;}
 const saved=await readData('settings',defaultSettings);if(loginWin&&!loginWin.isDestroyed()||quitting||auth.current.logged)return;
 const theme=saved.theme==='dark'?'dark':'light';
 loginWin=new BrowserWindow({parent:win,modal:true,width:400,height:520,frame:false,resizable:false,maximizable:false,minimizable:false,movable:true,show:false,icon:path.join(__dirname,'resources','icon.ico'),backgroundColor:theme==='dark'?'#202638':'#eef1f7',title:'登录 Piku Down',webPreferences:{preload:path.join(__dirname,'login-preload.js'),additionalArguments:['--bili-theme='+theme],contextIsolation:true,nodeIntegration:false,sandbox:true,devTools:false}});
 const child=loginWin;currentQrKey=null;child.setMenuBarVisibility(false);attachMotion(child);child.webContents.setWindowOpenHandler(()=>({action:'deny'}));child.webContents.on('will-navigate',event=>event.preventDefault());child.loadFile('ui/login.html');child.once('ready-to-show',()=>{if(!child.isDestroyed()){child.show();child.focus();}});child.on('closed',()=>{if(loginWin===child)loginWin=null;if(!auth.current.logged&&!quitting)app.quit();});
}
function attachMotion(window){let previous=window.getPosition(),lastSent=0;window.on('move',()=>{if(window.isDestroyed())return;const current=window.getPosition();const dx=previous[0]-current[0],dy=previous[1]-current[1];previous=current;if(Date.now()-lastSent<16)return;lastSent=Date.now();window.webContents.send('windowMotion',{dx:Math.max(-60,Math.min(60,dx)),dy:Math.max(-60,Math.min(60,dy))});});}


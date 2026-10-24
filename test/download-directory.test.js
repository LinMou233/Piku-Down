const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
test('Windows videos default and custom destination survive settings saves and restart',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');let stored={};const handlers=new Map();let selection={canceled:false,filePaths:['D:\\Media']};
 const context=vm.createContext({handle:(name,fn)=>handlers.set(name,fn),readData:async()=>stored,updateData:async(_,fn)=>(stored=fn(stored)),app:{getPath:name=>{assert.equal(name,'videos');return 'V:\\RedirectedVideos';}},path:path.win32,dialog:{showOpenDialog:async()=>selection},defaultSettings:{},legacyRuntime:false,nativeTheme:{},win:{setBackgroundColor(){}},performanceMode:false,dragEffects:true});
 for(const name of ['folder','settings','saveSettings']){const line=source.split('\n').find(line=>line.startsWith("handle('"+name+"'"));assert.ok(line);vm.runInContext(line,context);}
 assert.equal((await handlers.get('settings')()).downloadDir,'V:\\RedirectedVideos');
 assert.equal(await handlers.get('folder')(),'D:\\Media');assert.equal(stored.downloadDir,'D:\\Media');
 await handlers.get('saveSettings')(null,{theme:'light'});assert.equal(stored.downloadDir,'D:\\Media');
 assert.equal((await handlers.get('settings')()).downloadDir,'D:\\Media');selection={canceled:true};assert.equal(await handlers.get('folder')(),null);assert.equal(stored.downloadDir,'D:\\Media');
});

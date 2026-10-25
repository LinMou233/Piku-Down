const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const {parseId}=require('../core');const {abortScope}=require('../network');
const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
function fixture(fetchSession){
 const handlers=new Map(),calls=[];
 const context=vm.createContext({handle:(name,callback)=>handlers.set(name,callback),parseExternalUrl:()=>null,parseId,abortScope,fetchSession,headers:{Referer:'https://www.bilibili.com/'},api:async url=>{calls.push(url);return {bvid:'BV1B3YS69E51',title:'fixture',owner:{name:'fixture'},pages:[{cid:1,page:1,part:'fixture'}]};}});
 vm.runInContext(source.slice(source.indexOf("handle('parse',"),source.indexOf("handle('formats',")),context);
 return {parse:handlers.get('parse'),calls};
}
test('b23 parsing requests explicit redirect tracking and extracts a BV from locale URLs',async()=>{
 let received;const f=fixture(async(url,options)=>{received={url,options};return {ok:true,url:'https://www.bilibili.com/zh-Hant/video/BV1B3YS69E51/?tracking=discarded'};});
 const result=await f.parse(null,'https://b23.tv/eOYc04u');assert.equal(result.bvid,'BV1B3YS69E51');assert.equal(received.options.method,'HEAD');assert.equal(received.options.resolveRedirects,true);assert.equal(received.options.signal.aborted,false);assert.ok(f.calls[0].endsWith('?bvid=BV1B3YS69E51'));
});
test('short-link HTTP failures stop before the video API and direct BV parsing remains unchanged',async()=>{
 let requests=0;const f=fixture(async()=>{requests++;return {ok:false,status:412,url:'https://b23.tv/example'};});
 await assert.rejects(f.parse(null,'https://b23.tv/example'),/短链接展开失败：412/);assert.equal(f.calls.length,0);
 assert.equal((await f.parse(null,'BV1B3YS69E51')).bvid,'BV1B3YS69E51');assert.equal(requests,1);
});

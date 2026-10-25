const {test}=require('node:test'),assert=require('node:assert/strict');
const {createBatchView}=require('../ui/batch');
const tick=()=>new Promise(setImmediate);
function fixture(){
 const nodes=new Map(),calls=[];let observe;
 const node=()=>({children:[],value:'',hidden:false,disabled:false,textContent:'',setAttribute(name,value){this[name]=value;},append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;}});
 const document={getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},createElement:node};
 const api={settings:async()=>({downloadDir:'C:/test'}),batchState:async()=>({revision:0,concurrency:1,paused:true,tasks:[]}),cancelAndDelete:async id=>calls.push(['cancel',id]),reveal:async file=>calls.push(['reveal',file])};
 const view=createBatchView(document,api,{onState:fn=>{observe=fn;}},()=> 'C:/test',()=>{});
 return {nodes,calls,view,event:task=>observe({source:'batch',title:task.taskId,platform:'youtube',state:'downloading',label:'正在下载',progress:0,speed:0,revision:1,...task})};
}
test('three real batch row renderers maintain separate progress, errors and output actions',async()=>{
 const f=fixture();await tick();f.event({taskId:'a',progress:10});f.event({taskId:'b',progress:20});f.event({taskId:'c',progress:30});
 const rows=f.nodes.get('batchList').children;assert.deepEqual(rows.map(row=>row.children[2].value),[10,20,30]);
 await rows[0].children[5].children[0].onclick();assert.deepEqual(f.calls,[['cancel','a']]);assert.equal(rows[1].children[5].children[0].disabled,false);
 f.event({taskId:'b',state:'completed',file:'C:/test/b.mp4',progress:100,revision:2});await rows[1].children[5].children[1].onclick();assert.deepEqual(f.calls.at(-1),['reveal','C:/test/b.mp4']);
 f.event({taskId:'b',progress:55,revision:1});assert.equal(rows[1].children[2].value,100);assert.equal(rows[0].children[2].value,10);
 f.event({taskId:'c',state:'failed',error:'source failed',revision:3});assert.equal(rows[2].children[6].hidden,false);assert.equal(rows[2].children[6].children[1].textContent,'source failed');
 assert.match(f.nodes.get('batchSummary').textContent,/完成1 · 失败1/);
});
test('batch snapshot hydration ignores stale task revisions and paused scheduling is explicit',async()=>{
 const f=fixture();await tick();f.event({taskId:'a',progress:40,revision:5});
 f.view.apply({revision:2,concurrency:3,paused:true,tasks:[{source:'batch',taskId:'a',revision:2,state:'queued',progress:0}]});
 assert.equal(f.nodes.get('batchList').children[0].children[2].value,40);assert.match(f.nodes.get('batchScheduling').textContent,/正在处理的任务会继续/);
 assert.equal(f.nodes.get('batchConcurrency').value,'3');
});
test('clearing a finished queue prevents late events from resurrecting removed rows',async()=>{
 const f=fixture();await tick();f.event({taskId:'old',state:'completed',progress:100,revision:5});
 f.view.apply({revision:6,concurrency:1,paused:true,tasks:[]},true);assert.equal(f.nodes.get('batchList').children.length,0);
 f.event({taskId:'old',state:'completed',progress:100,revision:5});assert.equal(f.nodes.get('batchList').children.length,0);
 f.event({taskId:'new',revision:7});assert.equal(f.nodes.get('batchList').children.length,1);assert.equal(f.view.model.tasks.has('old'),false);
});

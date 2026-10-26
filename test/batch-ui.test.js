const {test}=require('node:test'),assert=require('node:assert/strict');
const {createBatchView}=require('../ui/batch');
const tick=()=>new Promise(setImmediate);
function fixture(){
 const nodes=new Map(),calls=[];let observe;
 const node=()=>({children:[],value:'',hidden:false,disabled:false,textContent:'',setAttribute(name,value){this[name]=value;},append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;}});
 const document={getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},createElement:node};
 const api={settings:async()=>({downloadDir:'C:/test'}),batchState:async()=>({revision:0,concurrency:1,paused:true,tasks:[]}),cancelAndDelete:async id=>calls.push(['cancel',id]),reveal:async file=>calls.push(['reveal',file])};
 const view=createBatchView(document,api,{onState:fn=>{observe=fn;}},()=> 'C:/test',()=>{});
 return {nodes,calls,view,api,event:task=>observe({source:'batch',title:task.taskId,platform:'youtube',state:'downloading',label:'正在下载',progress:0,speed:0,revision:1,...task})};
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
test('lowering concurrency mid-run explains that active tasks continue and cleanup warnings stay on completed rows',async()=>{
 const f=fixture();await tick();f.view.apply({revision:0,concurrency:3,paused:false,tasks:[]});
 for(const taskId of ['a','b','c'])f.event({taskId});assert.doesNotMatch(f.nodes.get('batchScheduling').textContent,/仍有/);
 f.view.apply({revision:2,concurrency:1,paused:false,tasks:[]});assert.match(f.nodes.get('batchScheduling').textContent,/最多处理1个任务。目前仍有3个任务处理中，不会中断/);
 f.event({taskId:'a',state:'completed',file:'C:/test/a.mp4',error:'当前任务文件清理失败：busy',progress:100,revision:3});
 const row=f.nodes.get('batchList').children[0];assert.equal(row.children[6].hidden,false);assert.equal(row.children[6].children[0].textContent,'清理警告');assert.match(f.nodes.get('batchSummary').textContent,/完成1 · 失败0/);
});
test('adding links reports resubmitted failed or cancelled links separately from duplicates',async()=>{
 const f=fixture();await tick();const api=f.api;api.batchAdd=async()=>({added:['n1','n2'],duplicates:[{line:3}],invalid:[],resubmitted:[{line:1},{line:2}]});
 await f.nodes.get('batchAdd').onclick();assert.equal(f.nodes.get('batchMessage').textContent,'已加入2项。其中2项为先前失败或取消的链接，已重新加入。重复链接1项，未加入。');
});
test('clearing a finished queue prevents late events from resurrecting removed rows',async()=>{
 const f=fixture();await tick();f.event({taskId:'old',state:'completed',progress:100,revision:5});
 f.view.apply({revision:6,concurrency:1,paused:true,tasks:[]},true);assert.equal(f.nodes.get('batchList').children.length,0);
 f.event({taskId:'old',state:'completed',progress:100,revision:5});assert.equal(f.nodes.get('batchList').children.length,0);
 f.event({taskId:'new',revision:7});assert.equal(f.nodes.get('batchList').children.length,1);assert.equal(f.view.model.tasks.has('old'),false);
});

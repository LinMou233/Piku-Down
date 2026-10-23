const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
test('return from parsing restores library contents and scroll without reloading',()=>{
 const source=fs.readFileSync(require('node:path').join(__dirname,'../ui/app.js'),'utf8');const start=source.indexOf("let currentView='parse'");const end=source.indexOf("for(const button of document.querySelectorAll('[data-view]'))",start);assert.ok(start>=0&&end>start);
 const views=['parse','library','history','settings'].map(name=>({id:'view-'+name,hidden:name!=='parse'}));const button={};const state={scrollY:0,scrollTo({top}){this.scrollY=top;}};let historyLoads=0;
 const context=vm.createContext({$:()=>button,document:{querySelectorAll:selector=>selector==='.view'?views:[]},window:state,setAccountOpen(){},loadHistory(){historyLoads++;return Promise.resolve();}});vm.runInContext(source.slice(start,end),context);
 vm.runInContext("switchView('library')",context);state.scrollY=630;vm.runInContext("switchView('parse')",context);assert.equal(state.scrollY,0);button.onclick();assert.equal(views[1].hidden,false);assert.equal(state.scrollY,630);assert.equal(historyLoads,0);
 button.onclick();assert.equal(views[0].hidden,false);assert.equal(button.disabled,true);
 vm.runInContext("switchView('history');switchView('parse')",context);button.onclick();assert.equal(historyLoads,1);assert.equal(views[2].hidden,false);
});

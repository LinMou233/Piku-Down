const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');const {EventEmitter}=require('node:events');
function fixture(){
 const messages=[],timers=new Map();let time=1000,id=0,position=[0,0],destroyed=false;
 const win=new EventEmitter();win.getPosition=()=>position;win.isDestroyed=()=>destroyed;win.webContents={send(channel,value){messages.push({channel,...value,at:time});}};
 const context=vm.createContext({performanceMode:false,dragEffects:true,Date:{now:()=>time},setTimeout(fn,delay){assert.equal(delay,16);const key=++id;timers.set(key,{fn,at:time+delay});return key;},clearTimeout:key=>timers.delete(key)});
 const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');vm.runInContext(source.slice(source.indexOf('function attachMotion(window)')),context);context.attachMotion(win);
 return {context,messages,timers,tick(ms){time+=ms;for(const [key,timer]of timers)if(timer.at<=time){timers.delete(key);timer.fn();}},move(x,y){position=[x,y];win.emit('will-move',{}, {x,y});win.emit('move');},fallback(x,y){position=[x,y];win.emit('move');},destroy(){destroyed=true;win.emit('closed');}};
}
test('1000Hz drag input is coalesced to 16ms IPC ticks without losing distance',()=>{
 const f=fixture();for(let i=1;i<=1000;i++){f.move(i,i*2);f.tick(1);}f.tick(16);assert.ok(f.messages.length<=63);
 for(let i=1;i<f.messages.length;i++)assert.ok(f.messages[i].at-f.messages[i-1].at>=16);
 assert.equal(f.messages.reduce((sum,value)=>sum+value.dx,0),-1000);assert.equal(f.messages.reduce((sum,value)=>sum+value.dy,0),-2000);assert.ok(f.messages.every(value=>value.channel==='windowMotion'));
});
test('performance changes, fallback moves and window close suppress or dispose queued motion',()=>{
 const f=fixture();f.move(10,3);f.context.performanceMode=true;f.tick(16);assert.equal(f.messages.length,0);
 f.context.performanceMode=false;f.move(15,4);f.tick(16);assert.equal(f.messages[0].dx,-5);
 f.context.dragEffects=false;f.move(30,10);f.tick(16);assert.equal(f.messages.length,1);
 f.context.dragEffects=true;f.tick(50);f.fallback(35,11);f.tick(16);assert.equal(f.messages.at(-1).dx,-5);
 f.move(40,12);f.destroy();f.tick(100);assert.equal(f.messages.length,2);assert.equal(f.timers.size,0);
});

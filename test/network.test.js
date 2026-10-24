const test=require('node:test');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');const {sessionFetch,abortScope}=require('../network');
test('legacy network preserves Chromium session cookies, redirects and streamed JSON',async()=>{
 const request=new EventEmitter();request.setHeader=()=>{};request.end=()=>{};request.abort=()=>{};let receivedOptions;
 const session={};const result=sessionFetch(session,'https://b23.tv/test',{}, {request(options){receivedOptions=options;return request;}});
 request.emit('redirect',302,'GET','https://www.bilibili.com/video/example');const response=new EventEmitter();response.statusCode=200;response.headers={'content-length':'11'};request.emit('response',response);const body=await result;response.emit('data',Buffer.from('{"ok":true}'));response.emit('end');assert.deepEqual(await body.json(),{ok:true});assert.equal(body.url,'https://www.bilibili.com/video/example');assert.equal(receivedOptions.session,session);assert.equal(receivedOptions.useSessionCookies,true);
});
test('legacy transfer abort rejects the streaming body',async()=>{
 const request=new EventEmitter();request.setHeader=()=>{};request.end=()=>{};let aborted=false;request.abort=()=>{aborted=true;};const controller=new AbortController();const result=sessionFetch({},'https://example.invalid',{signal:controller.signal},{request:()=>request});const response=new EventEmitter();response.statusCode=200;response.headers={};request.emit('response',response);const body=await result;const read=body.json();controller.abort(Error('cancelled'));await assert.rejects(read,/cancelled/);assert.ok(aborted);
});
test('network scope forwards cancellation and can be disposed',()=>{const parent=new AbortController();const scope=abortScope(parent.signal,1000);parent.abort(Error('stop'));assert.equal(scope.signal.reason.message,'stop');scope.dispose();});

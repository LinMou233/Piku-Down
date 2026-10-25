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

test('modern downloads keep using native session.fetch without redirect tracking',async()=>{
 const result={url:'',ok:true};const options={method:'GET',headers:{Referer:'https://www.bilibili.com/'}};let calls=0;
 const session={fetch:async(url,received)=>{calls++;assert.equal(url,'https://example.invalid/video');assert.equal(received,options);return result;}};
 assert.equal(await sessionFetch(session,'https://example.invalid/video',options,{request:()=>assert.fail('changed the normal transport')}),result);assert.equal(calls,1);
});
test('explicit short-link tracking follows redirect events even when modern fetch omits its URL',async()=>{
 const request=new EventEmitter();request.setHeader=()=>{};request.end=()=>{};request.abort=()=>{};let follows=0,receivedOptions;
 request.followRedirect=()=>{follows++;};const session={fetch:()=>assert.fail('native fetch has no final URL')};
 const operation=sessionFetch(session,'https://b23.tv/example',{method:'HEAD',resolveRedirects:true},{request(options){receivedOptions=options;return request;}});
 request.emit('redirect',302,'HEAD','https://www.bilibili.com/video/BV1B3YS69E51/');
 request.emit('redirect',302,'HEAD','https://www.bilibili.com/zh-Hant/video/BV1B3YS69E51/');
 const response=new EventEmitter();response.statusCode=200;response.headers={};request.emit('response',response);response.emit('end');const result=await operation;
 assert.equal(result.url,'https://www.bilibili.com/zh-Hant/video/BV1B3YS69E51/');assert.equal(follows,2);assert.equal(receivedOptions.redirect,'manual');assert.equal(receivedOptions.method,'HEAD');assert.equal(receivedOptions.session,session);assert.equal(receivedOptions.useSessionCookies,true);
});
test('cancelling modern short-link expansion aborts the native request',async()=>{
 const request=new EventEmitter();request.setHeader=()=>{};request.end=()=>{};let aborted=false;request.abort=()=>{aborted=true;};const controller=new AbortController();const reason=Error('stop short link');
 const result=sessionFetch({fetch:()=>assert.fail('wrong path')},'https://b23.tv/example',{resolveRedirects:true,signal:controller.signal},{request:()=>request});
 controller.abort(reason);await assert.rejects(result,error=>error===reason);assert.equal(aborted,true);
});

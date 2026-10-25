const {PassThrough}=require('node:stream');
function abortScope(parent,ms){
 const controller=new AbortController();const abort=()=>controller.abort(parent.reason||Error('请求已取消'));
 if(parent?.aborted)abort();else parent?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>controller.abort(Error('网络请求超时')),ms);timer.unref?.();
 return {signal:controller.signal,dispose(){clearTimeout(timer);parent?.removeEventListener('abort',abort);}};
}
// Electron 22 has Chromium-backed net.request, but no session.fetch.
function sessionFetch(ses,url,options={},net){
 // Electron's fetch Response may omit its final URL. Short-link expansion
 // explicitly uses redirect events; ordinary downloads keep their native path.
 if(typeof ses.fetch==='function'&&!options.resolveRedirects)return ses.fetch(url,options);
 return new Promise((resolve,reject)=>{
  const {signal}=options;if(signal?.aborted){reject(signal.reason||Error('请求已取消'));return;}
  const request=net.request({url,method:options.method||'GET',session:ses,useSessionCookies:true,redirect:options.resolveRedirects?'manual':'follow'});
  let body,settled=false,finalUrl=url;
  const clean=()=>signal?.removeEventListener('abort',abort);
  const abort=()=>{const error=signal.reason||Error('请求已取消');request.abort();if(body)body.destroy(error);if(!settled)reject(error);clean();};
  signal?.addEventListener('abort',abort,{once:true});
  for(const [name,value] of Object.entries(options.headers||{}))request.setHeader(name,value);
  request.on('redirect',(_,__,target)=>{finalUrl=target;if(options.resolveRedirects)request.followRedirect();});
  request.on('error',error=>{clean();if(body)body.destroy(error);if(!settled)reject(error);});
  request.on('response',response=>{
   body=new PassThrough();body.on('error',()=>{});
   response.on('data',chunk=>{if(!body.write(chunk))response.pause?.();});body.on('drain',()=>response.resume?.());
   response.on('end',()=>{body.end();clean();});response.on('error',error=>{body.destroy(error);clean();});
   response.on('aborted',()=>{body.destroy(Error('网络连接中断'));clean();});
   settled=true;resolve({ok:response.statusCode>=200&&response.statusCode<300,status:response.statusCode,url:finalUrl,headers:{get(name){const value=response.headers[name.toLowerCase()];return Array.isArray(value)?value.join(', '):value||null;}},body,async json(){const chunks=[];for await(const chunk of body)chunks.push(chunk);return JSON.parse(Buffer.concat(chunks).toString('utf8'));}});
  });
  request.end();
 });
}
module.exports={sessionFetch,abortScope};

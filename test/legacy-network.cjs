// Verifies the real Electron 22 Chromium session transport against a local server.
const {app,session,net}=require('electron');const http=require('node:http');const path=require('node:path');const {sessionFetch,abortScope}=require('../network');
app.setPath('userData',path.join(app.getPath('temp'),'piku-legacy-network-'+process.pid));
app.whenReady().then(async()=>{let server;try{
 server=http.createServer((request,response)=>{if(request.url==='/redirect'){response.writeHead(302,{Location:'/data'});response.end();}else if(request.url==='/slow'){response.writeHead(200);response.write('{');}else{response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({cookie:request.headers.cookie||''}));}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;const ses=session.fromPartition('fixture-'+process.pid);await ses.cookies.set({url:base,name:'fixture',value:'yes'});
 const response=await sessionFetch(ses,base+'/redirect',{},net);const data=await response.json();if(!data.cookie.includes('fixture=yes')||!response.url.endsWith('/data'))throw Error('Legacy cookies or redirect failed');
 const controller=new AbortController();const scope=abortScope(controller.signal,2000);const cancelled=await sessionFetch(ses,base+'/slow',{signal:scope.signal},net);const pending=cancelled.json();controller.abort(Error('cancelled'));let rejected=false;try{await pending;}catch{rejected=true;}if(!rejected)throw Error('Legacy cancellation failed');
 scope.dispose();await ses.clearStorageData();console.log('LEGACY_NETWORK PASS',process.versions.electron);app.exit(0);
 }catch(error){console.error(error);app.exit(1);}finally{server?.close();}});

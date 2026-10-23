const {spawn}=require('node:child_process');
function inspectMedia(binary,input,{signal,remote=false}={}){return new Promise((resolve,reject)=>{
 const args=['-hide_banner',...(remote?['-rw_timeout','6000000','-user_agent','Mozilla/5.0','-headers','Referer: https://www.bilibili.com/\r\n','-analyzeduration','3000000','-probesize','2097152']:[]),'-i',input,'-map','0:v:0','-an','-c:v','copy','-t','0','-f','null','-'];
 const child=spawn(binary,args,{windowsHide:true});let log='',settled=false,terminationError;
 const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
 const stop=error=>{terminationError=error;child.kill();};const abort=()=>stop(Error('帧率检测已取消'));const timer=setTimeout(()=>stop(Error('帧率检测超时')),remote?9000:15000);
 if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
 child.stderr.on('data',chunk=>log=(log+chunk).slice(-40000));child.on('error',()=>finish(Error('无法启动帧率检测')));child.on('close',()=>{if(terminationError){finish(terminationError);return;}const line=log.split('Output #')[0].split('\n').find(line=>line.includes('Video:'));const size=line?.match(/\b(\d{2,5})x(\d{2,5})\b/);const fps=line?.match(/([\d.]+)\s+fps\b/);if(!size){finish(Error('无法检测视频帧率'));return;}finish(null,{width:Number(size[1]),height:Number(size[2]),fps:fps?Number(fps[1]):null});});
 });}
module.exports={inspectMedia};

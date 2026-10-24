const fs=require('node:fs/promises');
const path=require('node:path');
const {gunzipSync}=require('node:zlib');
const {createHash}=require('node:crypto');
const {checkSize}=require('./check-size.cjs');
const machines={ia32:0x14c,x64:0x8664};
function machine(bytes){if(bytes.toString('ascii',0,2)!=='MZ')throw Error('媒体组件不是 Windows EXE');const pe=bytes.readUInt32LE(0x3c);if(bytes.toString('ascii',pe,pe+4)!=='PE\0\0')throw Error('无效的媒体组件');return bytes.readUInt16LE(pe+4);}
async function download(url){const response=await fetch(url,{signal:AbortSignal.timeout(180000)});if(!response.ok)throw Error(`下载媒体组件失败 ${response.status}: ${url}`);return Buffer.from(await response.arrayBuffer());}
module.exports=async context=>{
 const target=({0:'ia32',1:'x64',3:'arm64'})[context.arch];if(!target)throw Error('不支持的 Windows 架构');
 // ARM64 Windows supports x86 emulation; ffmpeg-static has no Windows ARM64 build.
 const legacy=Number(context.packager.config.electronVersion.split('.')[0])<=22;
 const mediaArch=target==='arm64'||legacy?'ia32':target;
 const dest=path.join(context.appOutDir,'resources/app.asar.unpacked/node_modules/ffmpeg-static');
 if(mediaArch==='x64'){const bytes=await fs.readFile(path.join(dest,'ffmpeg.exe'));if(machine(bytes)!==machines.x64)throw Error('x64 媒体组件架构不匹配');await checkSize(context.appOutDir);return;}
 const cache=path.join(context.packager.projectDir,'.build-cache','ffmpeg-b4.4.1-ia32');await fs.mkdir(cache,{recursive:true});
 let bytes;try{bytes=await fs.readFile(path.join(cache,'ffmpeg.exe'));}catch(error){if(error.code!=='ENOENT')throw error;
  const base='https://github.com/eugeneware/ffmpeg-static/releases/download/b4.4.1/win32-ia32';
  bytes=gunzipSync(await download(base+'.gz'));if(machine(bytes)!==machines.ia32)throw Error('下载的媒体组件架构不匹配');
  await fs.writeFile(path.join(cache,'ffmpeg.exe.LICENSE'),await download(base+'.LICENSE'));
  await fs.writeFile(path.join(cache,'ffmpeg.exe.README'),'Windows x86 media binary supplied by eugeneware/ffmpeg-static, release b4.4.1.\nSource and release: https://github.com/eugeneware/ffmpeg-static/releases/tag/b4.4.1\nARM64 uses Windows x86 emulation. Win7 builds use this older media tool.\n');
  await fs.writeFile(path.join(cache,'ffmpeg.exe'),bytes);
 }
 if(machine(bytes)!==machines.ia32)throw Error('缓存的媒体组件架构不匹配');
 await fs.copyFile(path.join(cache,'ffmpeg.exe'),path.join(dest,'ffmpeg.exe'));
 for(const ext of ['LICENSE','README'])await fs.copyFile(path.join(cache,'ffmpeg.exe.'+ext),path.join(dest,'ffmpeg.exe.'+ext));
 await fs.writeFile(path.join(context.appOutDir,'resources/media-build.json'),JSON.stringify({applicationArch:target,mediaArch,emulated:target==='arm64',source:'eugeneware/ffmpeg-static b4.4.1',sha256:createHash('sha256').update(bytes).digest('hex')},null,2));
 await checkSize(context.appOutDir);
};
module.exports.machine=machine;

const {spawnSync}=require('node:child_process');const path=require('node:path');const fs=require('node:fs');
const arch=process.argv[2]||'x64',legacy=process.argv.includes('--legacy');
const output=process.argv.find(value=>value.startsWith('--output='))?.slice(9);
if(!['x64','ia32','arm64'].includes(arch)||legacy&&arch==='arm64')throw Error('请选择 x64、ia32 或 arm64；Win7 仅支持 x64/ia32');
const args=[require.resolve('electron-builder/out/cli/cli.js'),'--win','--'+arch];
if(legacy)args.push('--config',path.resolve('build/electron-legacy.cjs'));
else if(arch==='arm64')args.push('--config',path.resolve('build/electron-arm64.cjs'));
else if(arch==='x64'&&fs.existsSync('node_modules/electron/dist/electron.exe'))args.push('--config.electronDist='+path.resolve('node_modules/electron/dist'));
if(output)args.push('--config.directories.output='+path.resolve(output));
if(arch==='ia32'){
 const suffix=legacy?'-Win7-x86':'-x86';
 args.push('--config.portable.artifactName=Piku-Down-${version}'+suffix+'.exe','--config.nsis.artifactName=Piku-Down-Setup-${version}'+suffix+'.exe');
}
const result=spawnSync(process.execPath,args,{stdio:'inherit',windowsHide:true});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);
if(arch==='arm64'){const portable=spawnSync(process.execPath,[path.join(__dirname,'build-arm64-portable.cjs'),...(output?[path.resolve(output)]:[])],{stdio:'inherit',windowsHide:true});if(portable.error)throw portable.error;process.exit(portable.status??1);}

const fs=require('node:fs/promises');const path=require('node:path');
async function directorySize(root){let bytes=0;for(const entry of await fs.readdir(root,{withFileTypes:true})){const file=path.join(root,entry.name);if(entry.isSymbolicLink())throw Error('应用目录中存在未预期的链接');bytes+=entry.isDirectory()?await directorySize(file):(await fs.stat(file)).size;}return bytes;}
async function checkSize(root){const bytes=await directorySize(root);if(bytes>499000000)throw Error(`应用体积超过 500 MB 安全上限：${bytes} bytes`);console.log(`  • app size verified: ${(bytes/1e6).toFixed(1)} MB / 500 MB`);return bytes;}
module.exports={directorySize,checkSize};

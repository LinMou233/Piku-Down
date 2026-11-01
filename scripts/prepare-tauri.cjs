const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.tauri-ui');
fs.mkdirSync(out,{recursive:true});
for(const name of fs.readdirSync(path.join(root,'ui'))){
  if(!/\.(?:html|js|css)$/.test(name))continue;
  let text=fs.readFileSync(path.join(root,'ui',name),'utf8');
  if(name.endsWith('.html')){
    text=text.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/,'');
    text=text.replace('<head>','<head><script src="tauri-bridge.js"></script>');
    text=text.replaceAll('../resources/','resources/');

  }
  fs.writeFileSync(path.join(out,name),text);
}
fs.mkdirSync(path.join(out,'resources/icons'),{recursive:true});
fs.copyFileSync(path.join(root,'resources/icons/icon-32.png'),path.join(out,'resources/icons/icon-32.png'));
fs.copyFileSync(path.join(root,'resources/icons/icon-64.png'),path.join(out,'resources/icons/icon-64.png'));
console.log('前端文件已更新');

const path=require('node:path');
function mediaBinary(){
 // Select the binary prepared for this build, rather than ffmpeg-static's host arch.
 const executable=path.join(path.dirname(require.resolve('ffmpeg-static/package.json')),'ffmpeg.exe');
 return executable.replace('app.asar','app.asar.unpacked');
}
module.exports={mediaBinary};

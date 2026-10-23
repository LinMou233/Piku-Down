function frameRate(stream){const raw=String(stream.frameRate??stream.frame_rate??'0');const parts=raw.split('/').map(Number);const value=parts.length===2?parts[0]/parts[1]:parts[0];return Number.isFinite(value)&&value>0?value:0;}
function selectVideo(streams,quality){return streams.filter(stream=>stream.id===Number(quality)).sort((a,b)=>frameRate(b)-frameRate(a)||(a.codecid===7?-1:0)-(b.codecid===7?-1:0)||(b.bandwidth||0)-(a.bandwidth||0))[0];}
function audioEncoding(format,copy=true){return format==='mp3'?['-vn','-c:a','libmp3lame','-b:a','320k']:['-vn','-c:a',copy?'copy':'aac',...(copy?[]:['-b:a','192k'])];}
module.exports={frameRate,selectVideo,audioEncoding};
async function selectBestVideo(streams,quality,probe){const candidates=streams.filter(stream=>stream.id===Number(quality));if(candidates.length<2)return selectVideo(candidates,quality);const results=await Promise.allSettled(candidates.map(probe));const measured=candidates.map((stream,i)=>({...stream,frameRate:results[i].status==='fulfilled'&&results[i].value?.fps>0?String(results[i].value.fps):stream.frameRate??stream.frame_rate}));return selectVideo(measured,quality);}
module.exports.selectBestVideo=selectBestVideo;

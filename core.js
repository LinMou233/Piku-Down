function parseId(input){const bv=input.match(/(?:^|\/)(BV[0-9A-Za-z]{10})(?=$|[/?#\s])/i);if(bv)return `bvid=${bv[1]}`;const av=input.match(/(?:^|\/)(av\d+)(?=$|[/?#\s])/i);if(av)return `aid=${av[1].slice(2)}`;throw Error('请输入 BV 号、av 号或哔哩哔哩视频链接');}
function safeName(name){let n=String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,140);if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(n))n='_'+n;return n||'video';}
module.exports={parseId,safeName};

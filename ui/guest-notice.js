(function(root){
 function createGuestNotice(element,schedule=setTimeout,cancel=clearTimeout){let checked=false,timer;
  return profile=>{if(profile.logged){if(timer!==undefined)cancel(timer);element.hidden=true;checked=true;return;}if(checked)return;checked=true;element.hidden=false;timer=schedule(()=>{element.hidden=true;},5000);};
 }
 if(typeof module==='object')module.exports={createGuestNotice};else root.createGuestNotice=createGuestNotice;
})(typeof window==='object'?window:globalThis);

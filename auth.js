function createAuthGate(loadAccount, onChange=()=>{}, {ttl=30000,now=Date.now}={}) {
 let profile={logged:false},checkedAt=0,pending=null,epoch=0;
 function publish(value){profile=value;checkedAt=now();onChange(value);return value;}
 return {
  get current(){return profile;},
  invalidate(){epoch++;pending=null;return publish({logged:false});},
  async check(force=false){
   if(!force&&profile.logged&&now()-checkedAt<ttl)return profile;
   if(pending)return pending;
   const generation=epoch;
   const operation=(async()=>{let value;try{value=await loadAccount();}catch(error){value={logged:false,error:error.message};}if(generation!==epoch)return profile;return publish(value?.logged?value:{logged:false,error:value?.error});})();
   pending=operation;
   try{return await operation;}finally{if(pending===operation)pending=null;}
  },
  async require(){const account=await this.check();if(!account.logged)throw Error('请先使用哔哩哔哩 App 扫码登录');return account;}
 };
}
module.exports={createAuthGate};

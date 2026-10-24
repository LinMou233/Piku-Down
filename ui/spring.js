// Exact damped spring integration: stable and consistent across refresh rates.
(function(root){
 function step(state,seconds){const dt=Math.min(.25,Math.max(0,seconds));const damping=11,stiffness=180,frequency=Math.sqrt(stiffness-damping*damping);const decay=Math.exp(-damping*dt),c=Math.cos(frequency*dt),s=Math.sin(frequency*dt);for(const axis of ['x','y']){const velocity=axis==='x'?'vx':'vy',x=state[axis],v=state[velocity];state[axis]=decay*(x*c+(v+damping*x)/frequency*s);state[velocity]=decay*(v*c-(damping*v+stiffness*x)/frequency*s);}return state;}
 function resting(state){return Math.abs(state.x)+Math.abs(state.y)<.05&&Math.abs(state.vx)+Math.abs(state.vy)<.2;}
 const api={step,resting};if(typeof module==='object')module.exports=api;else root.PikuSpring=api;
})(typeof window==='object'?window:globalThis);

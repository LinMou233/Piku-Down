(()=>{
 const api=window.bili||window.login;if(!api?.onWindowMotion)return;
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 const selector='.app-shell button:not(#collapse),.account-card button,.login-content button,.performance-setting input[role=switch]';
 const state={x:0,y:0,vx:0,vy:0};let frame=null,lastTime=0,pendingX=0,pendingY=0,controls=[],lastPaint='';
 const disabled=()=>reduced.matches||document.documentElement.dataset.performance==='true'||document.documentElement.dataset.dragEffects!=='true';
 function collect(){controls=[...document.querySelectorAll(selector)].filter(node=>node.getClientRects().length).map(node=>({node,weight:node.closest('.page-navigation') ? .45 : node.closest('#sidebar') ? .65 : node.closest('.account-card') ? .8 : 1}));for(const {node} of controls)node.classList.add('motion-control');}
 function paint(){const key=state.x.toFixed(2)+','+state.y.toFixed(2);if(key===lastPaint)return;lastPaint=key;for(const {node,weight} of controls)if(node.isConnected)node.style.translate=(state.x*weight).toFixed(2)+'px '+(state.y*weight).toFixed(2)+'px';}
 function reset(){if(frame!==null)cancelAnimationFrame(frame);frame=null;lastTime=0;pendingX=pendingY=0;state.x=state.y=state.vx=state.vy=0;for(const {node} of controls){node.style.removeProperty('translate');node.classList.remove('motion-control');}controls=[];lastPaint='';}
 function tick(time){if(disabled()){reset();return;}const dt=lastTime?(time-lastTime)/1000:1/60;lastTime=time;state.x=Math.max(-10,Math.min(10,state.x+pendingX*.38));state.y=Math.max(-10,Math.min(10,state.y+pendingY*.38));pendingX=pendingY=0;PikuSpring.step(state,dt);paint();if(PikuSpring.resting(state)){reset();return;}frame=requestAnimationFrame(tick);}
 api.onWindowMotion(delta=>{if(disabled())return;pendingX+=delta.dx;pendingY+=delta.dy;if(frame===null){collect();lastTime=performance.now();frame=requestAnimationFrame(tick);}});
 reduced.addEventListener('change',()=>{if(disabled())reset();});window.addEventListener('piku-effects-change',()=>{if(disabled())reset();});
})();

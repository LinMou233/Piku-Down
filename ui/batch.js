(function () {
  const ended = new Set(['completed','failed','cancelled','skipped']);
  const labels = {queued:'排队中',parsing:'解析中',downloading:'下载中',merging:'合并中',completed:'已完成',cancelled:'已取消',failed:'失败',skipped:'重复，已跳过'};
  function createBatchModel() {
    const tasks = new Map();
    return { tasks, update(task) {
      if(task.source!=='batch'||(tasks.get(task.taskId)?.revision??-1)>=task.revision)return false;
      tasks.set(task.taskId,task);return true;
    }, summary() {
      const all=[...tasks.values()],count=state=>all.filter(task=>task.state===state).length;
      return {total:all.length,completed:count('completed'),failed:count('failed'),cancelled:count('cancelled'),skipped:count('skipped'),
        pending:all.filter(task=>!ended.has(task.state)).length,
        progress:all.length?all.reduce((n,task)=>n+(ended.has(task.state)?100:task.progress||0),0)/all.length:0};
    }};
  }
  function createBatchView(document,api,events,getFolder,setFolder) {
    const $=id=>document.getElementById(id),model=createBatchModel(),rows=new Map();
    let paused=true,concurrency=1,controlRevision=-1;
    const message=text=>{$('batchMessage').textContent=text;};
    const error=e=>message(e.message.replace(/^Error invoking remote method '[^']+': Error: /,''));
    const element=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text)node.textContent=text;return node;};
    function row(task) {
      let nodes=rows.get(task.taskId);
      if(!nodes){
        const item=element('article','batch-task glass'),title=element('h3'),meta=element('p','hint'),progress=element('progress'),detail=element('p','hint');
        progress.max=100;progress.setAttribute('aria-label','任务进度');
        const output=element('p','batch-output'),buttons=element('div','batch-actions'),cancel=element('button','','取消此任务'),reveal=element('button','','打开文件位置');
        cancel.setAttribute('aria-label','取消任务：'+task.title);reveal.setAttribute('aria-label','打开位置：'+task.title);
        const errors=element('details'),summary=element('summary','','错误详情'),text=element('pre');errors.append(summary,text);
        cancel.onclick=async()=>{cancel.disabled=true;try{await api.cancelAndDelete(task.taskId);}catch(e){error(e);}finally{cancel.disabled=ended.has(model.tasks.get(task.taskId)?.state);}};
        reveal.onclick=()=>{const current=model.tasks.get(task.taskId);if(current?.state==='completed'&&current.file)api.reveal(current.file).catch(error);};
        buttons.append(cancel,reveal);item.append(title,meta,progress,detail,output,buttons,errors);$('batchList').append(item);
        nodes={item,title,meta,progress,detail,output,cancel,reveal,errors,summary,text};rows.set(task.taskId,nodes);
      }
      const speed=task.speed>0?(task.speed>=1048576?(task.speed/1048576).toFixed(1)+'MB/s':(task.speed/1024).toFixed(1)+'KB/s'):'—';
      nodes.title.textContent=task.title;nodes.meta.textContent=({bilibili:'B站',x:'X',youtube:'YouTube'}[task.platform]||'视频')+' · '+labels[task.state];
      nodes.cancel.setAttribute('aria-label','取消任务：'+task.title);nodes.reveal.setAttribute('aria-label','打开位置：'+task.title);
      nodes.progress.value=task.progress||0;
      nodes.detail.textContent=task.label+' · '+(task.progress||0).toFixed(1)+'% · '+speed;
      nodes.output.textContent=task.file?'已保存：'+task.file:'';
      nodes.reveal.hidden=task.state!=='completed';nodes.cancel.hidden=ended.has(task.state);
      nodes.cancel.disabled=ended.has(task.state)||task.label==='正在取消并清理';
      nodes.errors.hidden=!task.error;nodes.summary.textContent=task.state==='completed'?'清理警告':'错误详情';nodes.text.textContent=task.error||'';
    }
    function render() {
      const s=model.summary();$('batchProgress').value=s.progress;
      $('batchSummary').textContent=`共${s.total}项 · 完成${s.completed} · 失败${s.failed} · 取消${s.cancelled} · 跳过${s.skipped}`;
      const active=[...model.tasks.values()].filter(task=>['parsing','downloading','merging'].includes(task.state)).length;
      $('batchScheduling').textContent=paused?'排程已暂停，正在处理的任务会继续；不会派发新任务。':s.pending?'排程运行中，同时最多处理'+concurrency+'个任务。'+(active>concurrency?'目前仍有'+active+'个任务处理中，不会中断；完成后按新上限派发。':''):'本批次已结束。';
      $('batchStart').textContent=[...model.tasks.values()].some(task=>task.state!=='queued')?'继续排程':'开始队列';
      $('batchStart').disabled=!paused||!s.pending;$('batchPause').disabled=paused||!s.pending;
      $('batchCancelAll').disabled=!s.pending;$('batchClear').disabled=!!s.pending;
    }
    function apply(state,clear=false) {
      if(state.revision<controlRevision)return;
      controlRevision=state.revision;paused=state.paused;concurrency=state.concurrency;$('batchConcurrency').value=String(concurrency);
      if(clear){model.tasks.clear();rows.clear();$('batchList').replaceChildren();}
      for(const task of state.tasks)if(model.update(task))row(task);render();
    }
    async function action(button,fn){button.disabled=true;try{await fn();}catch(e){error(e);}finally{render();if(button===$('batchAdd')||button===$('batchFolder'))button.disabled=false;}}
    $('batchAdd').onclick=()=>action($('batchAdd'),async()=>{
      const result=await api.batchAdd($('batchInput').value,{folder:getFolder(),access:$('batchAccess').value,maxHeight:Number($('batchQuality').value)});
      message('已加入'+result.added.length+'项。'+(result.resubmitted?.length?'其中'+result.resubmitted.length+'项为先前失败或取消的链接，已重新加入。':'')+(result.duplicates.length?'重复链接'+result.duplicates.length+'项，未加入。':'')+result.invalid.map(item=>'第'+item.line+'行：'+item.error).join('；'));
      if(result.added.length)$('batchInput').value='';apply(await api.batchState());
    });
    $('batchStart').onclick=()=>action($('batchStart'),async()=>{message('');apply(await ([...model.tasks.values()].some(task=>task.state!=='queued')?api.batchResume():api.batchStart()));});
    $('batchPause').onclick=()=>action($('batchPause'),async()=>apply(await api.batchPause()));
    $('batchCancelAll').onclick=()=>action($('batchCancelAll'),async()=>apply(await api.batchCancelAll()));
    $('batchClear').onclick=()=>action($('batchClear'),async()=>{apply(await api.batchClear(),true);message('已清除队列，可建立下一批；不会删除下载文件。');});
    $('batchConcurrency').onchange=async()=>{try{apply(await api.batchConcurrency(Number($('batchConcurrency').value)));}catch(e){error(e);$('batchConcurrency').value=String(concurrency);}};
    $('batchFolder').onclick=()=>action($('batchFolder'),async()=>{const folder=await api.folder();if(folder){setFolder(folder);$('batchFolderName').textContent=folder;}});
    events.onState(task=>{
      if(task.revision<=controlRevision&&!model.tasks.has(task.taskId))return;
      if(model.update(task)){row(task);render();}
    });
    api.settings().then(settings=>{$('batchFolderName').textContent=getFolder()||settings.downloadDir;}).catch(error);
    api.batchState().then(state=>apply(state)).catch(error);render();
    return {model,apply};
  }
  if(typeof module!=='undefined')module.exports={createBatchModel,createBatchView};
  else createBatchView(document,bili,downloadEvents,()=>folder,f=>{folder=f;settings.downloadDir=f;$('folderName').textContent=f;});
})();

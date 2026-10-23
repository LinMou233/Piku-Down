const fs=require('node:fs/promises');const path=require('node:path');const {randomUUID}=require('node:crypto');
function createDownloadTask(controller,folder){let resolve;const done=new Promise(r=>resolve=r);return {id:randomUUID(),controller,folder:path.resolve(folder),temp:null,target:null,ownedOutput:false,deleteRequested:false,done,resolve};}
async function cleanupDownloadTask(task){const errors=[];
 if(task.temp){const target=path.resolve(task.temp);if(path.dirname(target)!==task.folder||!path.basename(target).startsWith('.bilidown-'))throw Error('拒绝清理当前任务范围之外的目录');try{await fs.rm(target,{recursive:true,force:true,maxRetries:3,retryDelay:150});}catch(error){errors.push(error);}}
 if(task.controller.signal.aborted&&task.ownedOutput&&task.target){const target=path.resolve(task.target);if(path.dirname(target)!==task.folder)throw Error('拒绝清理当前任务范围之外的文件');try{await fs.unlink(target);}catch(error){if(error.code!=='ENOENT')errors.push(error);}}
 if(errors.length)throw Error('当前任务文件清理失败：'+errors[0].message);
}
module.exports={createDownloadTask,cleanupDownloadTask};

const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { UserError } = require('./user-error');

// yt-dlp can start FFmpeg and a JS runtime. Wait for the whole tree on cancel.
function runProcess(command, args, { signal, timeout = 0, env, onLine, maxOutput = 24 * 1024 * 1024 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, env });
    const decoder = new StringDecoder('utf8');
    let output = '', stderr = '', pending = '', timer, failure, stopping;
    function stop(error) {
      if (failure) return;
      failure = error;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        stopping = new Promise(done => {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
          killer.once('error', () => { child.kill(); done(); });
          killer.once('close', done);
        });
      } else child.kill('SIGKILL');
    }
    const abort = () => stop(new UserError('下载已取消'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (timeout) timer = setTimeout(() => stop(new UserError('请求超时，请检查网络后重试')), timeout);
    child.stdout.on('data', chunk => {
      const value = decoder.write(chunk);
      if (!onLine) {
        output += value;
        if (output.length > maxOutput) stop(new UserError('返回的视频信息过大'));
      } else {
        pending += value;
        let index;
        while ((index = pending.indexOf('\n')) !== -1) {
          onLine(pending.slice(0, index).trim());
          pending = pending.slice(index + 1);
        }
        if (pending.length > maxOutput) stop(new UserError('下载进度信息过大'));
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-6000); });
    function dispose() { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    child.once('error', error => { dispose(); reject(failure || error); });
    child.once('close', async code => {
      dispose();
      await stopping;
      if (onLine && pending) onLine((pending + decoder.end()).trim());
      if (failure) return reject(failure);
      if (signal?.aborted) return reject(new UserError('下载已取消'));
      if (code !== 0) return reject(Error(stderr || `下载组件已退出（${code}）`));
      resolve(output + decoder.end());
    });
  });
}

module.exports = { runProcess };

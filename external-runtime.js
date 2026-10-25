const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { UserError } = require('./user-error');

const VERSION = '2026.10.21';
// SHA-256 values from the official release asset metadata.
const ASSETS = {
  x64: ['yt-dlp.exe', '33121d192d706e62f684a06f80918e3f3a8ba52ac3a65213b6951c39c7d9f555'],
  ia32: ['yt-dlp_x86.exe', '7ce38c77db13db50c64e656b1056a0448e6c38ec0f0ccf28e30dd5271c008850'],
  arm64: ['yt-dlp_arm64.exe', '1380a9f105302764e6a5d383c2f07238ae242f0f4fbf3414aea00e56619a79b3']
};

function createExternalRuntime({ root, fetch, arch = process.arch, supported = true }) {
  const asset = ASSETS[arch];
  const directory = path.join(root, 'download-tools', VERSION);
  const executable = path.join(directory, asset?.[0] || 'yt-dlp.exe');
  let installing;
  const reason = !supported || !asset ? 'X 与 YouTube 下载需要 Windows 10 或更新版本的现代版应用。' : '';
  async function valid() {
    if (reason) return false;
    try { return createHash('sha256').update(await fs.readFile(executable)).digest('hex') === asset[1]; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async function status() { return { supported: !reason, installed: await valid(), version: VERSION, reason }; }
  async function install(signal, progress = () => {}) {
    if (reason) throw new UserError(reason);
    signal?.throwIfAborted();
    if (await valid()) return executable;
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, randomUUID() + '.part');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, 180000);
    try {
      progress({ label: '正在准备下载组件（首次使用）', received: 0, total: 0 });
      const response = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}/${asset[0]}`, { signal: controller.signal });
      if (!response.ok) throw new UserError(`下载组件获取失败（${response.status}）`);
      const total = Number(response.headers.get('content-length')) || 0;
      const hash = createHash('sha256');
      const file = await fs.open(temporary, 'wx');
      let received = 0, lastUpdate = 0;
      try {
        for await (const chunk of response.body) {
          controller.signal.throwIfAborted();
          received += chunk.length;
          if (received > 80 * 1024 * 1024) throw new UserError('下载组件大小异常');
          hash.update(chunk);
          await file.write(chunk);
          if (Date.now() - lastUpdate > 150) {
            progress({ label: '正在准备下载组件', received, total });
            lastUpdate = Date.now();
          }
        }
      } finally { await file.close(); }
      if (hash.digest('hex') !== asset[1]) throw new UserError('下载组件校验失败，请重试');
      controller.signal.throwIfAborted();
      await fs.rename(temporary, executable);
      return executable;
    } catch (error) {
      if (controller.signal.aborted) throw new UserError(signal?.aborted ? '下载已取消' : '下载组件获取超时，请检查 GitHub 连接后重试');
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await fs.rm(temporary, { force: true });
    }
  }
  async function ensure(signal, progress) {
    signal?.throwIfAborted();
    if (installing?.controller.signal.aborted) { await installing.promise.catch(() => {}); return ensure(signal, progress); }
    if (!installing) {
      const flight = { controller: new AbortController(), listeners: new Set() };
      installing = flight;
      flight.promise = install(flight.controller.signal, value => {
        for (const listener of flight.listeners) listener.progress?.(value);
      }).finally(() => { if (installing === flight) installing = null; });
    }
    const flight = installing, listener = { progress };
    flight.listeners.add(listener);
    let abort;
    const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason || Error('下载已取消')); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try { return await Promise.race([flight.promise, cancelled]); }
    finally {
      signal?.removeEventListener('abort', abort); flight.listeners.delete(listener);
      if (installing === flight && !flight.listeners.size) {
        flight.controller.abort(); await flight.promise.catch(() => {});
      }
    }
  }
  return { status, ensure };
}

module.exports = { createExternalRuntime, VERSION, ASSETS };

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
// Official Windows releases need Windows 10+, and Electron 22's Node 16 is below yt-dlp's Node minimum.
// Win7 builds use a community Win7 build of yt-dlp and solve YouTube JS challenges with quickjs-ng.
const LEGACY_VERSION = '2026.10.24.042403';
const QUICKJS_VERSION = 'v0.17.0';
const LEGACY_ASSETS = {
  x64: [['yt-dlp_win7.exe', 'e86c466894dc48efc2a161a1486721a8a3e48049b30380c90ac10f65068f1afc'], ['qjs-windows-x86_64.exe', '2aeabf0092c3262d6b2609824418f7dd7ed1f1df939f73b2b15645230cac0d77']],
  ia32: [['yt-dlp_x86_win7.exe', 'fd930832124c625d20bcc744182ff8129d88768672a02088c8e661e3fc49b782'], ['qjs-windows-x86.exe', 'dedc4dd8da20234d206c433a706336fede47a14e75c690cb607f81aa9c9c71be']]
};

function createExternalRuntime({ root, fetch, arch = process.arch, supported = true, legacy = false }) {
  const version = legacy ? LEGACY_VERSION : VERSION;
  const pair = legacy ? LEGACY_ASSETS[arch] : ASSETS[arch] && [ASSETS[arch]];
  const directory = path.join(root, 'download-tools', legacy ? 'win7-' + LEGACY_VERSION : VERSION);
  const files = (pair || []).map(([name, sha256], index) => ({ name, sha256, path: path.join(directory, name),
    url: legacy ? (index ? `https://github.com/quickjs-ng/quickjs/releases/download/${QUICKJS_VERSION}/${name}` : `https://github.com/nicolaasjan/yt-dlp/releases/download/${LEGACY_VERSION}/${name}`)
      : `https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}/${name}` }));
  const executable = files[0]?.path || path.join(directory, 'yt-dlp.exe');
  const jsRuntime = legacy && files[1] ? 'quickjs:' + files[1].path : undefined;
  let installing;
  const reason = !supported || !pair ? 'X 与 YouTube 下载需要 Windows 10 或更新版本的现代版应用。' : '';
  async function matches(file) {
    try { return createHash('sha256').update(await fs.readFile(file.path)).digest('hex') === file.sha256; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async function valid() {
    if (reason) return false;
    for (const file of files) if (!await matches(file)) return false;
    return true;
  }
  async function status() { return { supported: !reason, installed: await valid(), version, reason }; }
  async function download(file, signal, progress) {
    const temporary = path.join(directory, randomUUID() + '.part');
    try {
      const response = await fetch(file.url, { signal });
      if (!response.ok) throw new UserError(`下载组件获取失败（${response.status}）`);
      const total = Number(response.headers.get('content-length')) || 0;
      const hash = createHash('sha256');
      const handle = await fs.open(temporary, 'wx');
      let received = 0, lastUpdate = 0;
      try {
        for await (const chunk of response.body) {
          signal.throwIfAborted();
          received += chunk.length;
          if (received > 80 * 1024 * 1024) throw new UserError('下载组件大小异常');
          hash.update(chunk);
          await handle.write(chunk);
          if (Date.now() - lastUpdate > 150) {
            progress({ label: '正在准备下载组件', received, total });
            lastUpdate = Date.now();
          }
        }
      } finally { await handle.close(); }
      if (hash.digest('hex') !== file.sha256) throw new UserError('下载组件校验失败，请重试');
      signal.throwIfAborted();
      await fs.rename(temporary, file.path);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async function install(signal, progress = () => {}) {
    if (reason) throw new UserError(reason);
    signal?.throwIfAborted();
    if (await valid()) return executable;
    await fs.mkdir(directory, { recursive: true });
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, 180000);
    try {
      progress({ label: '正在准备下载组件（首次使用）', received: 0, total: 0 });
      for (const file of files) if (!await matches(file)) await download(file, controller.signal, progress);
      return executable;
    } catch (error) {
      if (controller.signal.aborted) throw new UserError(signal?.aborted ? '下载已取消' : '下载组件获取超时，请检查 GitHub 连接后重试');
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
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
  return { status, ensure, jsRuntime };
}

module.exports = { createExternalRuntime, VERSION, ASSETS, LEGACY_VERSION, QUICKJS_VERSION, LEGACY_ASSETS };

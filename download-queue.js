const { randomUUID } = require('node:crypto');
const { createDownloadTask } = require('./download-task');
const { parseExternalUrl } = require('./external-media');
const { parseId } = require('./core');
const terminal = new Set(['completed', 'failed', 'cancelled', 'skipped']);

function normalizeLink(input) {
  const value = String(input).trim();
  const external = parseExternalUrl(value);
  if (external) return { key: external.url, platform: external.platform, input: external.url };
  if (/^https:\/\/b23\.tv\/[\w-]+\/?(?:[?#].*)?$/i.test(value)) {
    const url = new URL(value);
    return { key: 'b23:' + url.pathname.replace(/\/$/, ''), platform: 'bilibili', input: url.origin + url.pathname };
  }
  if (/^https?:/i.test(value)) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/^(?:www\.|m\.)?bilibili\.com$/i.test(url.hostname) || url.username || url.password || url.port) throw Error('不支持的视频链接');
  } else if (!/^(?:BV[\da-z]{10}|av\d+)$/i.test(value)) throw Error('不支持的视频链接');
  const id = parseId(value);
  return { key: 'bili:' + id, platform: 'bilibili', input: value };
}

function createDownloadQueue({ prepare, run, cleanup, emit = () => {}, now = Date.now }) {
  const jobs = new Map(), inputs = new Map(), resolved = new Map();
  let concurrency = 1, paused = true, running = 0, closing = false, revision = 0;
  const snapshot = job => ({ taskId: job.task.id, source: job.source, input: job.input,
    title: job.title, platform: job.platform, state: job.state, label: job.label,
    received: job.received, total: job.total, progress: job.progress, speed: job.speed,
    file: job.file || '', error: job.error || '', revision: job.revision });
  function changed(job) {
    job.revision = ++revision;
    // 視窗關閉或觀測器失敗不能阻止任務完成與檔案清理。
    try { emit(snapshot(job)); } catch {}
  }
  function progress(job, value) {
    if (!job.started || terminal.has(job.state) || job.finishing || job.task.controller.signal.aborted) return;
    const received = Math.max(0, Number(value.received) || 0), total = Math.max(0, Number(value.total) || 0), time = now();
    if (value.label !== job.label || received < job.received) { job.lastBytes = 0; job.lastTime = time; job.speed = 0; }
    const elapsed = time - job.lastTime;
    if (elapsed >= 100) { job.speed = Math.max(0, received - job.lastBytes) * 1000 / elapsed; job.lastTime = time; job.lastBytes = received; }
    job.label = String(value.label || '正在下载'); job.received = received; job.total = total;
    job.state = /合并|处理音|发布/.test(job.label) ? 'merging' : job.state === 'parsing' ? 'parsing' : 'downloading';
    job.progress = total ? Math.min(99.9, received / total * 100) : 0;
    changed(job);
  }
  async function finish(job, result, failure, skipped = false) {
    if (job.finishing) return;
    job.finishing = true;
    let cleanupError;
    try { await cleanup(job.task); } catch (error) { cleanupError = error; }
    const cancelled = job.task.controller.signal.aborted;
    job.task.resolve({ cancelled, deleted: !cleanupError, error: cleanupError?.message });
    job.speed = 0;
    job.state = cleanupError ? 'failed' : cancelled ? 'cancelled' : skipped ? 'skipped' : failure ? 'failed' : 'completed';
    job.error = cleanupError?.message || (!cancelled && failure?.message) || '';
    job.label = { completed: '下载完成', failed: '失败', cancelled: '已取消', skipped: '重复，已跳过' }[job.state];
    if (job.state === 'completed') { job.file = result.file; job.progress = 100; }
    else { job.file = ''; job.progress = 0; }
    changed(job);
    if (job.started) running--;
    if (job.state === 'completed') job.resolve({ ...result, taskId: job.task.id });
    else job.reject(cleanupError || (cancelled ? Error(job.task.deleteRequested ? '下载已取消，当前任务源文件已删除' : '下载已取消') : failure || Error(job.label)));
    pump();
  }
  async function execute(job) {
    try {
      job.state = job.source === 'batch' ? 'parsing' : 'downloading'; job.label = job.source === 'batch' ? '正在解析' : '正在下载'; changed(job);
      const prepared = job.source === 'batch' ? await prepare(job, value => progress(job, value)) : job.opts;
      job.task.controller.signal.throwIfAborted();
      if (job.source === 'batch') {
        job.title = prepared.title; job.platform = prepared.platform || 'bilibili'; changed(job);
        if (resolved.has(prepared.canonical)) return await finish(job, null, Error('与佇列内其他链接指向同一影片，已跳过'), true);
        resolved.set(prepared.canonical, job.task.id);
      }
      job.state = 'downloading'; job.label = '正在下载';
      job.received = 0; job.total = 0; job.progress = 0; job.speed = 0; job.lastBytes = 0; job.lastTime = now(); changed(job);
      const result = await run(prepared, job.task, value => progress(job, value));
      job.task.controller.signal.throwIfAborted();
      if (!result || typeof result.file !== 'string' || !result.file) throw Error('下载未返回有效文件');
      await finish(job, result);
    } catch (error) { await finish(job, null, error); }
  }
  function pump() {
    if (closing) return;
    for (const job of jobs.values()) {
      if (running >= concurrency) break;
      if (job.state !== 'queued' || job.finishing || (job.source === 'batch' && paused)) continue;
      job.started = true; job.lastTime = now(); running++;
      void execute(job);
    }
  }
  function enqueue({ source, input = '', platform, opts = {}, taskId, ...settings }) {
    if (closing) throw Error('程序正在关闭');
    if (source === 'batch' && [...jobs.values()].filter(job => job.source === 'batch').length >= 300) throw Error('队列最多保留300个批次任务，请先清除已结束任务');
    if (source === 'single' && [...jobs.values()].some(job => job.source === 'single' && !terminal.has(job.state))) throw Error('已有下载任务正在运行');
    if (taskId !== undefined && (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(taskId) || jobs.has(taskId))) throw Error('无效或重复的taskId');
    const task = createDownloadTask(new AbortController(), settings.folder || opts.folder);
    if (taskId) task.id = taskId;
    const job = { task, source, input, platform, opts, settings, title: opts.title || input,
      state: 'queued', label: '排队中', progress: 0, received: 0, total: 0, speed: 0, lastBytes: 0, lastTime: now() };
    job.done = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    job.done.catch(() => {});
    jobs.set(task.id, job); changed(job);
    return job;
  }
  function addBatch(text, settings) {
    const lines = String(text).split(/\r?\n/).map((input,index) => ({input:input.trim(),line:index+1})).filter(item => item.input);
    if (!lines.length || lines.length > 100) throw Error('每次请输入1～100行链接');
    const added = [], duplicates = [], invalid = [];
    for (const {input,line} of lines) {
      try {
        const source = normalizeLink(input);
        if (inputs.has(source.key)) { duplicates.push({ line, input }); continue; }
        const job = enqueue({ source: 'batch', input: source.input, platform: source.platform, ...settings });
        inputs.set(source.key, job.task.id); added.push(job.task.id);
      } catch (error) { invalid.push({ line, input, error: error.message }); }
    }
    pump(); return { added, duplicates, invalid };
  }
  function addSingle(opts) { const job = enqueue({ source: 'single', opts, taskId: opts.taskId }); pump(); return job.done; }
  async function cancel(taskId, deleteRequested = false) {
    const job = taskId ? jobs.get(taskId) : [...jobs.values()].find(job => job.source === 'single' && !terminal.has(job.state));
    if (!job || terminal.has(job.state)) return { cancelled: false, deleted: false };
    job.task.deleteRequested ||= deleteRequested;
    job.task.controller.abort(Error('下载已取消')); job.label = '正在取消并清理'; changed(job);
    if (!job.started) void finish(job, null, Error('下载已取消'));
    const result = await job.task.done;
    if (result.error) throw Error(result.error);
    return result;
  }
  async function cancelAll(source) {
    if (source === 'batch') paused = true;
    const results = await Promise.allSettled([...jobs.values()].filter(job => !terminal.has(job.state) && (!source || job.source === source)).map(job => cancel(job.task.id, true)));
    const error = results.find(result => result.status === 'rejected');
    if (error) throw error.reason;
  }
  function state() { return { revision, concurrency, paused, running, tasks: [...jobs.values()].map(snapshot) }; }
  function setConcurrency(value) {
    if (!Number.isInteger(value) || value < 1 || value > 3) throw Error('同时下载数量必须为1～3');
    concurrency = value; revision++; pump(); return state();
  }
  function clear() {
    if ([...jobs.values()].some(job => job.source === 'batch' && !terminal.has(job.state))) throw Error('请先等待或取消批次任务');
    for (const [id, job] of jobs) if (terminal.has(job.state)) jobs.delete(id);
    inputs.clear(); resolved.clear(); paused = true; revision++; return state();
  }
  return { jobs, addBatch, addSingle, cancel, cancelAll, state, setConcurrency, clear,
    start() { paused = false; revision++; pump(); return state(); }, pause() { paused = true; revision++; return state(); },
    hasWork: () => [...jobs.values()].some(job => !terminal.has(job.state)),
    async close() { closing = true; await cancelAll(); },
    newTaskId: randomUUID };
}
module.exports = { createDownloadQueue, normalizeLink };

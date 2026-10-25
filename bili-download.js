const { createWriteStream } = require('node:fs');
const { moveOutputAtomically } = require('./output-file');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function createPlayCache(load, { ttl = 60000, limit = 200, now = Date.now } = {}) {
  const entries = new Map();
  let generation = 0;
  const key = (bvid, cid, qn) => `${bvid}:${Number(cid)}:${Number(qn)}`;
  function clear() { generation++; entries.clear(); }
  async function get(bvid, cid, qn = 127, signal) {
    signal?.throwIfAborted();
    const id = key(bvid, cid, qn);
    const cached = entries.get(id);
    if (cached && cached.expires > now()) return cached.data;
    entries.delete(id);
    const epoch = generation;
    const data = await load(bvid, cid, qn, signal);
    signal?.throwIfAborted();
    if (epoch === generation) {
      const record = { data, expires: now() + ttl };
      // DASH already contains these qualities; selecting one need not refetch it.
      const qualities = new Set([Number(qn), ...(data.dash?.video || []).map(stream => Number(stream.id))]);
      for (const quality of qualities) {
        if (!Number.isFinite(quality)) continue;
        const cacheKey = key(bvid, cid, quality);
        entries.delete(cacheKey);
        while (entries.size >= limit) entries.delete(entries.keys().next().value);
        entries.set(cacheKey, record);
      }
    }
    return data;
  }
  return { get, clear };
}

function createProgressAggregator(keys, emit, label, {
  interval = 100, now = Date.now, schedule = setTimeout, cancel = clearTimeout
} = {}) {
  const states = new Map(keys.map(key => [key, { received: 0, total: 0, done: false }]));
  let timer = null, lastSent = -Infinity, dirty = false, disposed = false;
  function flush() {
    if (disposed || !dirty) return;
    dirty = false;
    lastSent = now();
    const values = [...states.values()];
    const received = values.reduce((sum, state) => sum + state.received, 0);
    // Do not briefly show 100% while another stream is still awaiting headers.
    const total = values.every(state => state.total > 0 || state.done)
      ? values.reduce((sum, state) => sum + state.total, 0) : 0;
    emit({ label, received, total });
  }
  function update(key, value) {
    if (disposed) return;
    const state = states.get(key);
    const received = Math.max(0, Number(value.received) || 0);
    state.done = !!value.done;
    // A retry holds the displayed byte count until the backup catches up.
    // On completion use the actual final size, including unknown-length bodies.
    state.received = state.done ? received : Math.max(state.received, received);
    state.total = state.done ? received : (state.total || value.total > 0)
      ? Math.max(state.total, Number(value.total) || 0, state.received) : 0;
    dirty = true;
    if (timer !== null) return;
    const delay = interval - (now() - lastSent);
    if (delay <= 0) flush();
    else timer = schedule(() => { timer = null; flush(); }, delay);
  }
  function dispose() { if (timer !== null) cancel(timer); timer = null; disposed = true; }
  function finish() { flush(); dispose(); }
  return { update, finish, dispose };
}

function createTransfer({ fetch, headers, progress = () => {}, stallTimeout = 15000 }) {
  return async function transfer(urls, file, signal, label, onProgress) {
    signal?.throwIfAborted();
    const reporter = onProgress ? null : createProgressAggregator(['stream'], progress, label);
    const report = onProgress || (value => reporter.update('stream', value));
    let last;
    try {
      for (const url of urls.filter(Boolean)) {
        signal?.throwIfAborted();
        const attempt = new AbortController();
        const abort = () => attempt.abort(signal.reason || Error('下载已取消'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        // Covers both a stalled response header and a stalled response body.
        const watchdog = setTimeout(() => attempt.abort(Error('下载源长时间无响应')), stallTimeout);
        watchdog.unref?.();
        const stopWatchdog = () => clearTimeout(watchdog);
        let response, source;
        try {
          response = await fetch(url, { headers, signal: attempt.signal });
          if (!response.ok) throw Error(`下载失败 ${response.status}`);
          if (!response.body) throw Error('下载源没有返回数据');
          // Modern Electron returns a Web stream; Electron 22's adapter returns
          // a Node stream and must not require Readable.fromWeb to exist.
          source = typeof response.body.getReader === 'function'
            ? Readable.fromWeb(response.body) : response.body;
          source.once('end', stopWatchdog);
          let received = 0;
          const length = Number(response.headers.get('content-length'));
          const total = Number.isFinite(length) && length > 0 ? length : 0;
          report({ received, total });
          const counter = new Transform({
            transform(chunk, encoding, callback) {
              watchdog.refresh();
              received += chunk.length;
              report({ received, total });
              callback(null, chunk);
            }
          });
          await pipeline(source, counter, createWriteStream(file, {
            flags: 'w', highWaterMark: 1024 * 1024
          }), { signal: attempt.signal });
          report({ received, total, done: true });
          reporter?.finish();
          return;
        } catch (error) {
          last = attempt.signal.aborted ? attempt.signal.reason : error;
          attempt.abort(last);
          if (signal?.aborted) throw signal.reason || last;
        } finally {
          stopWatchdog();
          signal?.removeEventListener('abort', abort);
          source?.removeListener('end', stopWatchdog);
          source?.destroy();
          if (!source && response?.body) {
            response.body.destroy?.();
            if (response.body.cancel) await response.body.cancel().catch(() => {});
          }
        }
      }
      throw last || Error('没有可用下载地址');
    } finally { reporter?.dispose(); }
  };
}

async function downloadDashStreams({ video, audio, folder, signal, transfer, progress }) {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason || Error('下载已取消'));
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const streams = [['video', video], ...(audio ? [['audio', audio]] : [])];
  const reporter = createProgressAggregator(streams.map(([kind]) => kind), progress, audio ? '下载音视频' : '下载视频');
  const jobs = streams.map(async ([kind, stream]) => transfer(
    [stream.baseUrl || stream.base_url, ...(stream.backupUrl || stream.backup_url || [])],
    path.join(folder, kind), controller.signal, kind === 'video' ? '下载视频' : '下载音频',
    value => reporter.update(kind, value)
  ));
  try {
    await Promise.all(jobs);
    reporter.finish();
  } catch (error) {
    // Do not mark the parent task as user-cancelled on a source failure.
    controller.abort(error);
    // Promise.all rejects early; both writers must close before task cleanup.
    await Promise.allSettled(jobs);
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    reporter.dispose();
  }
}

module.exports = { createPlayCache, createProgressAggregator, createTransfer, downloadDashStreams, moveOutputAtomically };

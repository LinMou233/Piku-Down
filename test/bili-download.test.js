const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { statSync, constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { Readable } = require('node:stream');
const { createPlayCache, createProgressAggregator, createTransfer, downloadDashStreams, moveOutputAtomically } = require('../bili-download');
const { createDownloadTask, cleanupDownloadTask } = require('../download-task');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function folder(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piku-bili-performance-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function server(t, handler) {
  const sockets = new Set(), instance = http.createServer(handler);
  instance.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => instance.close(resolve)); });
  return 'http://127.0.0.1:' + instance.address().port;
}
function clock() {
  let time = 0, id = 0;
  const timers = new Map();
  return { now: () => time,
    schedule(fn, delay) { const key = ++id; timers.set(key, { fn, at: time + delay }); return key; },
    cancel: key => timers.delete(key),
    tick(ms) { const end = time + ms; while (true) { const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]; if (!next || next[1].at > end) break; time = next[1].at; timers.delete(next[0]); next[1].fn(); } time = end; }
  };
}

test('PlayURL cache reuses DASH qualities for 60s and isolates video, page and quality', async () => {
  let time = 0, calls = 0;
  const cache = createPlayCache(async () => ({ call: ++calls, dash: { video: [{ id: 80 }, { id: 112 }] } }), { now: () => time });
  const first = await cache.get('BV1', 1);
  assert.equal(await cache.get('BV1', 1, 80), first);
  assert.equal(await cache.get('BV1', 1, 112), first);
  time = 59999; assert.equal(await cache.get('BV1', 1), first); assert.equal(calls, 1);
  time = 60000; assert.notEqual(await cache.get('BV1', 1, 80), first);
  await cache.get('BV1', 2, 80); await cache.get('BV2', 1, 80); await cache.get('BV2', 1, 120);
  assert.equal(calls, 5);
});
test('invalidating an account prevents old in-flight results from repopulating cache', async () => {
  const pending = deferred(); let calls = 0;
  const cache = createPlayCache(async () => ++calls === 1 ? pending.promise : { account: 'new' });
  const old = cache.get('BV1', 1); cache.clear(); pending.resolve({ account: 'old' }); await old;
  assert.equal((await cache.get('BV1', 1)).account, 'new'); assert.equal(calls, 2);
});
test('failed/cancelled requests are not cached and cache hits respect cancellation', async () => {
  let calls = 0; const controller = new AbortController();
  const cache = createPlayCache(async () => { calls++; if (calls === 1) throw Error('network'); if (calls === 2) controller.abort(Error('stop')); return {}; });
  await assert.rejects(cache.get('BV1', 1), /network/);
  await assert.rejects(cache.get('BV1', 1, 127, controller.signal), /stop/);
  await cache.get('BV1', 1);
  await assert.rejects(cache.get('BV1', 1, 127, controller.signal), /stop/); assert.equal(calls, 3);
});
test('PlayURL cache bounds retained entries', async () => {
  let calls = 0; const cache = createPlayCache(async () => ({ call: ++calls }), { limit: 2 });
  await cache.get('BV1', 1); await cache.get('BV2', 1); await cache.get('BV3', 1); await cache.get('BV1', 1);
  assert.equal(calls, 4);
});
test('one 100ms progress clock combines streams and holds progress during a retry', () => {
  const timer = clock(), events = [];
  const reporter = createProgressAggregator(['v', 'a'], value => events.push({ ...value, at: timer.now() }), 'combined', timer);
  reporter.update('v', { received: 20, total: 100 }); assert.equal(events[0].total, 0);
  reporter.update('a', { received: 10, total: 50 });
  for (let i = 21; i <= 30; i++) { timer.tick(5); reporter.update('v', { received: i, total: 100 }); }
  assert.equal(events.length, 1); timer.tick(50);
  assert.deepEqual(events.at(-1), { label: 'combined', received: 40, total: 150, at: 100 });
  reporter.update('v', { received: 0, total: 100 }); timer.tick(100); assert.equal(events.at(-1).received, 40);
  reporter.update('v', { received: 100, done: true }); reporter.update('a', { received: 50, done: true }); reporter.finish();
  assert.equal(events.at(-1).received, 150); assert.equal(events.at(-1).total, 150);
  const count = events.length; timer.tick(1000); reporter.update('v', { received: 500 }); assert.equal(events.length, count);
});
test('unknown lengths remain indeterminate and disposing cancels trailing progress', () => {
  const timer = clock(), events = [];
  const reporter = createProgressAggregator(['v', 'a'], value => events.push(value), 'combined', timer);
  reporter.update('v', { received: 10, total: 100 }); reporter.update('a', { received: 5, total: 0 }); timer.tick(100);
  assert.equal(events.at(-1).total, 0);
  reporter.update('a', { received: 5, done: true }); timer.tick(100); assert.equal(events.at(-1).total, 105);
  reporter.update('v', { received: 20, total: 100 }); const count = events.length;
  reporter.dispose(); timer.tick(1000); assert.equal(events.length, count);
});
test('pipeline preserves large Node streams and reports final unknown-length bytes', async t => {
  const root = await folder(t), expected = Buffer.alloc(3 * 1024 * 1024, 42), events = [];
  const transfer = createTransfer({ fetch: async () => ({ ok: true, headers: { get: () => null }, body: Readable.from((function* () { for (let i = 0; i < expected.length; i += 16384) yield expected.subarray(i, i + 16384); })()) }), progress: value => events.push(value) });
  await transfer(['node-stream'], path.join(root, 'out'), new AbortController().signal, 'download');
  assert.deepEqual(await fs.readFile(path.join(root, 'out')), expected);
  assert.equal(events.at(-1).received, expected.length); assert.equal(events.at(-1).total, expected.length);
});
test('body stalls abort the connection and backup output truncates partial data', async t => {
  const root = await folder(t), closed = deferred(), requests = [];
  const base = await server(t, (request, response) => { requests.push(request.url); if (request.url === '/stall') { response.on('close', closed.resolve); response.writeHead(200, { 'content-length': 100 }); response.write('old partial content'); } else response.end('OK'); });
  await createTransfer({ fetch, stallTimeout: 200 })([base + '/stall', base + '/backup'], path.join(root, 'out'), new AbortController().signal, 'download');
  await closed.promise; assert.deepEqual(requests, ['/stall', '/backup']); assert.equal(await fs.readFile(path.join(root, 'out'), 'utf8'), 'OK');
});
test('stall timeout includes waiting for response headers', async t => {
  const root = await folder(t), requests = [];
  const base = await server(t, (request, response) => { requests.push(request.url); if (request.url !== '/stall') response.end('backup'); });
  await createTransfer({ fetch, stallTimeout: 200 })([base + '/stall', base + '/backup'], path.join(root, 'out'), new AbortController().signal, 'download');
  assert.deepEqual(requests, ['/stall', '/backup']); assert.equal(await fs.readFile(path.join(root, 'out'), 'utf8'), 'backup');
});
test('steady chunks refresh the stall timer for transfers longer than the timeout', async t => {
  const root = await folder(t), requests = [];
  const base = await server(t, (request, response) => {
    requests.push(request.url); response.writeHead(200); let chunks = 0;
    const timer = setInterval(() => { response.write('x'); if (++chunks === 6) { clearInterval(timer); response.end(); } }, 40);
    response.on('close', () => clearInterval(timer));
  });
  await createTransfer({ fetch, stallTimeout: 150 })([base + '/steady', base + '/backup'], path.join(root, 'out'), new AbortController().signal, 'download');
  assert.deepEqual(requests, ['/steady']); assert.equal(await fs.readFile(path.join(root, 'out'), 'utf8'), 'xxxxxx');
});
test('HTTP errors release their response bodies and preserve the last source error', async t => {
  const root = await folder(t), bodies = [];
  const transfer = createTransfer({ fetch: async url => { const body = Readable.from([Buffer.from('error')]); bodies.push(body); return { ok: false, status: Number(url), body }; } });
  await assert.rejects(transfer(['503', '404'], path.join(root, 'out'), new AbortController().signal, 'download'), /下载失败 404/);
  assert.ok(bodies.every(body => body.destroyed)); await assert.rejects(fs.access(path.join(root, 'out')), { code: 'ENOENT' });
});
test('explicit cancellation skips backup and closes the writer before returning', async t => {
  const root = await folder(t), controller = new AbortController(), requests = [];
  const base = await server(t, (request, response) => { requests.push(request.url); response.writeHead(200); response.write('partial'); });
  const transfer = createTransfer({ fetch, progress: value => { if (value.received) controller.abort(Error('user stop')); } });
  await assert.rejects(transfer([base + '/first', base + '/backup'], path.join(root, 'out'), controller.signal, 'download'), /user stop/);
  assert.deepEqual(requests, ['/first']); await fs.unlink(path.join(root, 'out'));
});
test('DASH downloads start concurrently and expose only combined progress', async t => {
  const root = await folder(t), responses = [], starts = [], events = [];
  const base = await server(t, (request, response) => { starts.push(request.url); responses.push(response); if (responses.length === 2) { responses[0].writeHead(200, { 'content-length': 5 }); responses[0].end('video'); responses[1].writeHead(200, { 'content-length': 5 }); responses[1].end('audio'); } });
  await downloadDashStreams({ video: { baseUrl: base + '/v' }, audio: { base_url: base + '/a' }, folder: root, signal: new AbortController().signal, transfer: createTransfer({ fetch, stallTimeout: 1000, progress: () => assert.fail('individual progress leaked') }), progress: value => events.push(value) });
  assert.deepEqual(starts.sort(), ['/a', '/v']); assert.equal(await fs.readFile(path.join(root, 'video'), 'utf8'), 'video'); assert.equal(await fs.readFile(path.join(root, 'audio'), 'utf8'), 'audio');
  assert.deepEqual(events.at(-1), { label: '下载音视频', received: 10, total: 10 });
});
test('a failed stream aborts and joins its sibling before cleanup without cancelling the parent', async () => {
  const parent = new AbortController(), aborted = deferred(), release = deferred(), failure = Error('video failed');
  let finished = false, returned = false;
  const transfer = async (urls, file, signal) => { if (file.endsWith('video')) { await new Promise(resolve => setImmediate(resolve)); throw failure; } try { await new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted.resolve(); reject(signal.reason); }, { once: true })); } finally { await release.promise; finished = true; } };
  const operation = downloadDashStreams({ video: { baseUrl: 'v' }, audio: { baseUrl: 'a' }, folder: '/fixture', signal: parent.signal, transfer, progress: () => {} });
  const checked = assert.rejects(operation, error => { returned = true; return error === failure; });
  try { await aborted.promise; assert.equal(returned, false); assert.equal(parent.signal.aborted, false); } finally { release.resolve(); }
  await checked; assert.equal(finished, true);
});
test('cancelling parallel transfers releases files before cleanupDownloadTask', async t => {
  const root = await folder(t), parent = new AbortController(), task = createDownloadTask(parent, root);
  task.temp = await fs.mkdtemp(path.join(root, '.bilidown-')); let requests = 0;
  const base = await server(t, (request, response) => { response.writeHead(200); response.write('partial'); if (++requests === 2) parent.abort(Error('stop both')); });
  await assert.rejects(downloadDashStreams({ video: { baseUrl: base + '/v' }, audio: { baseUrl: base + '/a' }, folder: task.temp, signal: parent.signal, transfer: createTransfer({ fetch }), progress: () => {} }), /stop both/);
  await cleanupDownloadTask(task); await assert.rejects(fs.access(task.temp), { code: 'ENOENT' });
});
test('same-volume output uses a hard link, unlinks source and never replaces existing files', async t => {
  const root = await folder(t), source = path.join(root, 'source'), target = path.join(root, 'target');
  await fs.writeFile(source, 'complete'); let owned = false;
  await moveOutputAtomically(source, target, () => { owned = true; assert.equal(statSync(source).ino, statSync(target).ino); assert.equal(statSync(target).nlink, 2); });
  assert.equal(owned, true); await assert.rejects(fs.access(source), { code: 'ENOENT' }); assert.equal(await fs.readFile(target, 'utf8'), 'complete');
  await fs.writeFile(source, 'new'); await assert.rejects(moveOutputAtomically(source, target, () => assert.fail('claimed existing file')), { code: 'EEXIST' });
  assert.equal(await fs.readFile(target, 'utf8'), 'complete');
});
test('EXDEV stages a COPYFILE_EXCL copy while NTFS permission failures retain their error', async t => {
  const root = await folder(t), source = path.join(root, 'source'), target = path.join(root, 'target'); await fs.writeFile(source, 'copied'); let flags;
  const io = { ...fs, link: async (a, b) => { if (a === source) throw Object.assign(Error('cross-device'), { code: 'EXDEV' }); return fs.link(a, b); }, copyFile: async (a, b, mode) => { flags = mode; await fs.copyFile(a, b, mode); } };
  await moveOutputAtomically(source, target, () => {}, io); assert.equal(flags, constants.COPYFILE_EXCL); assert.equal(await fs.readFile(target, 'utf8'), 'copied');
  await fs.writeFile(source, 'new'); await assert.rejects(moveOutputAtomically(source, target, () => assert.fail('claimed existing file'), io), { code: 'EEXIST' });
  const denied = Object.assign(Error('denied'), { code: 'EPERM' });
  await assert.rejects(moveOutputAtomically(source, target, () => {}, { ...io, link: async () => { throw denied; }, copyFile: () => assert.fail('unexpected copy') }), error => error === denied);
  assert.equal(await fs.readFile(target, 'utf8'), 'copied');
});
test('ownership survives source unlink failure so cancellation can still remove the new output', async t => {
  const root = await folder(t), controller = new AbortController(), task = createDownloadTask(controller, root);
  task.temp = await fs.mkdtemp(path.join(root, '.bilidown-')); const source = path.join(task.temp, 'out'); task.target = path.join(root, 'final'); await fs.writeFile(source, 'complete');
  await assert.rejects(moveOutputAtomically(source, task.target, () => { task.ownedOutput = true; controller.abort(); }, { ...fs, unlink: async () => { throw Error('unlink failed'); } }), /unlink failed/);
  await cleanupDownloadTask(task); await assert.rejects(fs.access(task.target), { code: 'ENOENT' });
});

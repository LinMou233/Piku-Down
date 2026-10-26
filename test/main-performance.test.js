const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const source = require('node:fs').readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const helpers = require('../bili-download');
const media = require('../media');
const tasks = require('../download-task');
const { createAuthGate } = require('../auth');
const { safeName } = require('../core');

function formatsFixture(play, legacyRuntime = false) {
  const handlers = new Map();
  const context = vm.createContext({ handle: (name, callback) => handlers.set(name, callback), isExternal: key => key.startsWith('external:'), externalMedia: { formats: () => ({ external: true }) }, play, legacyRuntime, ...media });
  vm.runInContext(source.slice(source.indexOf("handle('formats',"), source.indexOf("handle('cancel',")), context);
  return handlers.get('formats');
}
test('formats issues one DASH request even if accepted qualities have no accessible stream', async () => {
  const calls = [];
  const formats = formatsFixture(async (...args) => { calls.push(args); return { dash: { video: [{ id: 80 }], audio: [{}] }, accept_quality: [80, 120, 116, 74], accept_description: ['1080p', '4K', '1080p60', '720p60'] }; });
  const result = await formats(null, 'BV1', 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(Array.from(result.video, item => item.available), [true, false, false, false]);
  assert.equal(result.audio, true);
});
test('Win7 formats offer only qualities with an H.264 stream up to 1080p, including non-DASH sources', async () => {
  const dash = { dash: { video: [{ id: 120, codecid: 12, width: 3840, height: 2160 }, { id: 116, codecid: 12, width: 1920, height: 1080 }, { id: 80, codecid: 13, width: 1920, height: 1080 }, { id: 80, codecid: 7, width: 1920, height: 1080 }, { id: 64, codecid: 7, width: 1280, height: 720 }], audio: [{}] },
    accept_quality: [120, 116, 80, 64], accept_description: ['4K', '1080P60', '1080P', '720P'] };
  assert.deepEqual(Array.from((await formatsFixture(async () => dash, true)(null, 'BV1', 1)).video, item => item.available), [false, false, true, true]);
  assert.deepEqual(Array.from((await formatsFixture(async () => dash)(null, 'BV1', 1)).video, item => item.available), [true, true, true, true]);
  for (const [quality, available] of [[116, true], [120, false]]) {
    const durl = async (bvid, cid, qn) => qn ? Promise.reject(Error('no dash')) : { durl: [{}], quality, accept_quality: [quality], accept_description: ['x'] };
    assert.equal((await formatsFixture(durl, true)(null, 'BV1', 1)).video[0].available, available);
  }
});
test('formats preserves non-DASH compensation, tolerates failures and delegates external formats', async () => {
  const calls = [];
  const formats = formatsFixture(async (bvid, cid, qn) => { calls.push(qn); if (qn === 116) throw Error('unavailable'); return qn ? { dash: { video: [{ id: qn }] } } : { durl: [{}], quality: 80, accept_quality: [80, 120, 116, 74], accept_description: ['a', 'b', 'c', 'd'] }; });
  const result = await formats(null, 'BV1', 1);
  assert.deepEqual(calls, [undefined, 120, 116, 74]);
  assert.deepEqual(Array.from(result.video, item => item.available), [true, true, false, true]);
  assert.equal((await formats(null, 'external:key', 'cid')).external, true);
  assert.equal(calls.length, 4);
});
test('main reuses the formats cache at download quality and clears it on account notifications/logout', async () => {
  const handlers = new Map(); let requests = 0, mid = 1, logged = true, cleared = false;
  const context = vm.createContext({ ...helpers, createAuthGate, handle: (name, callback) => handlers.set(name, callback), api: async url => url.includes('/nav') ? { isLogin: true, mid } : (requests++, { dash: { video: [{ id: 80 }] } }), headers: {}, fetchSession: () => assert.fail('unexpected transfer'), externalProgress: () => {}, active: new AbortController(), loginWin: undefined, win: { isDestroyed: () => false, webContents: { send() {} } }, ses: { cookies: { get: async () => logged ? [{ name: 'SESSDATA', value: 'fixture' }] : [] }, clearStorageData: async () => { cleared = true; logged = false; } } });
  context.downloads = { pause() {}, async cancelAll() { context.active.abort(); } };
  vm.runInContext(source.slice(source.indexOf('const playCache ='), source.indexOf('app.whenReady()')), context);
  vm.runInContext(source.slice(source.indexOf('const auth=createAuthGate'), source.indexOf('async function ensureLoginWindow')), context);
  vm.runInContext(source.split('\n').find(line => line.startsWith("handle('logout',")), context);
  await context.play('BV1', 1); await context.play('BV1', 1, 80); assert.equal(requests, 1);
  const auth = vm.runInContext('auth', context);
  await auth.check(true); await context.play('BV1', 1, 80); assert.equal(requests, 2);
  mid = 2; await auth.check(true); await context.play('BV1', 1, 80); assert.equal(requests, 3);
  assert.equal(await handlers.get('logout')(), true);
  await context.play('BV1', 1, 80); assert.equal(requests, 4);
  assert.equal(cleared, true); assert.equal(context.active.signal.aborted, true); assert.equal(auth.current.logged, false);
});

async function downloadFixture(t, cancelAtMove = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piku-main-performance-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const handlers = new Map(), commands = [], events = [];
  let history = [], context, apiCalls = 0, externalCalls = 0;
  const stream = key => ({ baseUrl: key, id: 80, bandwidth: 100 });
  const progress = value => events.push(value);
  context = vm.createContext({ ...helpers, ...media, ...tasks, fs, path, safeName, AbortController, legacyRuntime: false, active: null, activeTask: null, app: { getPath: () => root }, defaultSettings: {}, readData: async () => ({ downloadDir: root }), updateData: async (name, update) => { history = update(history); }, handle: (name, callback) => handlers.set(name, callback), isExternal: value => value.startsWith('external:'), play: async () => { apiCalls++; return { dash: { video: [stream('video')], audio: [stream('audio')] } }; }, mediaBinary: () => 'fixture-ffmpeg', inspectMedia: async () => ({ width: 1920, height: 1080, fps: 60 }), transfer: helpers.createTransfer({ fetch: async key => ({ ok: true, headers: { get: () => '5' }, body: Readable.from([Buffer.from(key)]) }) }), externalProgress: progress, win: { webContents: { send: (channel, value) => progress(value) } }, downloadExternal: async () => { externalCalls++; return { file: 'external-result' }; }, moveOutputAtomically: (src, target, onCreated, io, signal) => helpers.moveOutputAtomically(src, target, () => { onCreated(); if (cancelAtMove) context.active.abort(Error('stop at move')); }, io, signal), spawn(command, args) {
    commands.push({ command, args });
    const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => child.emit('close', 1);
    fs.writeFile(args.at(-1), 'merged-output').then(() => child.emit('close', 0), error => child.emit('error', error));
    return child;
  } });
  context.createTransfer = () => context.transfer; context.fetchSession = () => {}; context.headers = {};
  context.createDownloadQueue = require('../download-queue').createDownloadQueue;
  context.prepareBatch = () => assert.fail('unexpected batch preparation'); context.win.isDestroyed = () => false;
  vm.runInContext(source.slice(source.indexOf("handle('cancel',"), source.indexOf('async function downloadExternal')), context);
  vm.runInContext(source.slice(source.indexOf('const downloads=createDownloadQueue'), source.indexOf("handle('reveal',")), context);
  const queue = vm.runInContext('downloads', context);
  Object.defineProperty(context, 'activeTask', { get: () => [...queue.jobs.values()].find(job => !['completed','cancelled','failed','skipped'].includes(job.state))?.task || null });
  Object.defineProperty(context, 'active', { get: () => context.activeTask?.controller || null });
  return { root, context, commands, events, download: handlers.get('download'), cancelAndDelete: handlers.get('cancelAndDelete'), history: () => history, apiCalls: () => apiCalls, externalCalls: () => externalCalls };
}
test('the real download IPC preserves its result/history while using parallel streams and exclusive finalization', async t => {
  const f = await downloadFixture(t);
  const result = await f.download(null, { bvid: 'BV1', cid: 1, qn: 80, title: 'result' });
  assert.equal(result.file, path.join(f.root, 'result.mp4'));
  assert.equal(result.video.fps, 60); assert.equal(await fs.readFile(result.file, 'utf8'), 'merged-output');
  assert.ok(!f.commands[0].args.includes('-movflags')); assert.ok(!f.commands[0].args.includes('+faststart'));
  assert.equal(f.commands[0].args.filter(arg => arg === '-i').length, 2);
  assert.equal(f.history().length, 1); assert.equal(f.history()[0].qn, 80);
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['result.mp4']);
  assert.equal(f.context.active, null); assert.equal(f.context.activeTask, null);
  await assert.rejects(f.download(null, { folder: f.root, bvid: 'BV1', cid: 1, qn: 80, title: 'result' }), /同名文件/);
  assert.equal(await fs.readFile(result.file, 'utf8'), 'merged-output');
});
test('cancellation at finalization deletes only the owned result and resolves the task cleanup contract', async t => {
  const f = await downloadFixture(t, true); await fs.writeFile(path.join(f.root, 'existing.mp4'), 'keep');
  await assert.rejects(f.download(null, { folder: f.root, bvid: 'BV1', cid: 1, qn: 80, title: 'cancelled' }), /下载已取消/);
  assert.deepEqual(await fs.readdir(f.root), ['existing.mp4']); assert.equal(f.history().length, 0);
  assert.equal(f.context.active, null); assert.equal(f.context.activeTask, null);
});
test('external download IPC continues to delegate without entering the Bilibili path', async t => {
  const f = await downloadFixture(t);
  const result = await f.download(null, { folder: f.root, bvid: 'external:key' });
  assert.equal(result.file, 'external-result'); assert.equal(f.externalCalls(), 1); assert.equal(f.apiCalls(), 0); assert.equal(f.commands.length, 0);
});
test('cancelAndDelete preserves sender validation and waits for the shared task.done cleanup result', async t => {
  const f = await downloadFixture(t);
  let starts = 0, ready;
  const started = new Promise(resolve => { ready = resolve; });
  f.context.transfer = async (urls, file, signal) => {
    await fs.writeFile(file, 'partial');
    if (++starts === 2) ready();
    await new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const operation = f.download(null, { folder: f.root, bvid: 'BV1', cid: 1, qn: 80, title: 'cancel' }).catch(error => error);
  await started;
  const task = f.context.activeTask;
  await assert.rejects(f.cancelAndDelete({ sender: {} }), /无效的窗口/);
  assert.equal(task.controller.signal.aborted, false);
  const result = await f.cancelAndDelete({ sender: f.context.win.webContents });
  assert.equal(result, await task.done);
  assert.equal(result.cancelled, true); assert.equal(result.deleted, true); assert.equal(result.error, undefined);
  assert.match((await operation).message, /下载已取消，当前任务源文件已删除/);
  assert.deepEqual(await fs.readdir(f.root), []);
});

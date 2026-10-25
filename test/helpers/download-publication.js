const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { safeName } = require('../../core');
const tasks = require('../../download-task');
const { moveOutputAtomically } = require('../../output-file');
const { createDownloadQueue } = require('../../download-queue');
const source = require('node:fs').readFileSync(path.join(__dirname, '../../main.js'), 'utf8');

// Run the actual IPC handler and downloadExternal. Network, extractor and
// FFmpeg are fixtures; publication, filesystem I/O and task cleanup are real.
function publicationFixture(root, { io = fs, beforePublish, cancelAfterPublish = false, prepareBatch } = {}) {
  const handlers = new Map(), publications = [];
  let history = [{ file: 'previous', title: 'previous' }], lastTask;
  const context = vm.createContext({
    fs, path, safeName, ...tasks, AbortController,
    createDownloadQueue: options => createDownloadQueue({ ...options, ...(prepareBatch ? { prepare: prepareBatch } : {}) }),
    createTransfer: () => context.transfer, fetchSession() {}, headers: {},
    isExternal: key => key.startsWith('external:'),
    handle: (name, callback) => handlers.set(name, callback),
    app: { getPath: () => root }, defaultSettings: {},
    readData: async () => ({ downloadDir: root }),
    updateData: async (name, update) => { history = update(history); },
    win: { isDestroyed: () => false, webContents: { send() {} } },
    play: async () => ({ quality: 80, durl: [{ url: 'fixture' }] }),
    transfer: async (urls, file) => fs.writeFile(file, 'downloaded fixture'),
    mediaBinary: () => 'fixture-ffmpeg',
    inspectMedia: async () => ({ width: 640, height: 360, fps: 30 }),
    externalMedia: { download: async (opts, task) => {
      task.temp = await fs.mkdtemp(path.join(task.folder, '.bilidown-'));
      const file = path.join(task.temp, opts.kind === 'audio' ? 'media.m4a' : 'media.mp4');
      await fs.writeFile(file, 'complete fixture');
      const platform = opts.bvid.endsWith('x') ? 'x' : 'youtube';
      return { file, platform, url: `https://${platform}.invalid/fixture` };
    } },
    spawn(command, args) {
      const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => child.emit('close', 1);
      fs.writeFile(args.at(-1), 'complete fixture').then(() => child.emit('close', 0), error => child.emit('error', error));
      return child;
    },
    async moveOutputAtomically(src, target, onCreated, ignoredIo, signal) {
      lastTask = [...queue.jobs.values()].find(job => job.task.controller.signal === signal)?.task;
      const task = lastTask; publications.push({ src, target, signal, taskId: task.id });
      await beforePublish?.(src, target, lastTask);
      return moveOutputAtomically(src, target, () => {
        onCreated(); if (cancelAfterPublish === true || typeof cancelAfterPublish === 'function' && cancelAfterPublish(task)) task.controller.abort(Error('cancel after publication'));
      }, io, signal);
    }
  });
  vm.runInContext(source.slice(source.indexOf("handle('cancel',"), source.indexOf("handle('reveal',")), context);
  const queue = vm.runInContext('downloads', context);
  // Keep existing fixture observations, now derived from the real task Map.
  Object.defineProperty(context, 'activeTask', { get: () => [...queue.jobs.values()].find(job => !['completed','cancelled','failed','skipped'].includes(job.state))?.task || null });
  Object.defineProperty(context, 'active', { get: () => context.activeTask?.controller || null });
  return { context, queue, publications, history: () => history, task: () => lastTask, download: opts => handlers.get('download')(null, { folder: root, cid: 1, qn: 80, ...opts }) };
}

module.exports = { publicationFixture };

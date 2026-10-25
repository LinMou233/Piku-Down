// Isolated local-server check for modern and Electron 22 session transports.
const { app, session, net } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { sessionFetch } = require('../network');
const { createTransfer, downloadDashStreams, moveOutputAtomically } = require('../bili-download');
const { createDownloadTask, cleanupDownloadTask } = require('../download-task');
const root = path.resolve(__dirname, '../work/bili-transport-' + process.pid);
app.setPath('userData', path.join(root, 'profile'));
app.whenReady().then(async () => {
  const sockets = new Set(), responses = [];
  const server = http.createServer((request, response) => {
    if (['/video', '/audio'].includes(request.url)) {
      responses.push(response);
      if (responses.length === 2) { responses[0].end('video'); responses[1].end('audio'); }
    } else if (request.url === '/backup') response.end('backup');
    else { response.writeHead(200, { 'content-type': 'application/octet-stream', 'x-content-type-options': 'nosniff' }); response.write('partial'); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  let code = 0;
  try {
    await fs.mkdir(root, { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const ses = session.fromPartition('performance-fixture-' + process.pid);
    const fetch = (url, options) => sessionFetch(ses, url, options, net);
    const transfer = createTransfer({ fetch, stallTimeout: 1000 });
    await downloadDashStreams({ video: { baseUrl: base + '/video' }, audio: { baseUrl: base + '/audio' }, folder: root, signal: new AbortController().signal, transfer, progress() {} });
    assert.equal(await fs.readFile(path.join(root, 'video'), 'utf8'), 'video');
    assert.equal(await fs.readFile(path.join(root, 'audio'), 'utf8'), 'audio');
    await createTransfer({ fetch, stallTimeout: 200 })([base + '/stall', base + '/backup'], path.join(root, 'retry'), new AbortController().signal, 'retry');
    assert.equal(await fs.readFile(path.join(root, 'retry'), 'utf8'), 'backup');
    const controller = new AbortController();
    const task = createDownloadTask(controller, root);
    task.temp = await fs.mkdtemp(path.join(root, '.bilidown-'));
    const cancelled = createTransfer({ fetch, progress: value => { if (value.received) controller.abort(Error('fixture cancel')); } });
    await assert.rejects(cancelled([base + '/cancel'], path.join(task.temp, 'partial'), controller.signal, 'cancel'), /fixture cancel/);
    await cleanupDownloadTask(task);
    await assert.rejects(fs.access(task.temp), { code: 'ENOENT' });
    await moveOutputAtomically(path.join(root, 'video'), path.join(root, 'complete'));
    await assert.rejects(fs.access(path.join(root, 'video')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(root, 'complete'), 'utf8'), 'video');
    await ses.clearStorageData();
    console.log('BILI_TRANSPORT PASS', JSON.stringify({ electron: process.versions.electron, node: process.versions.node, transport: typeof ses.fetch === 'function' ? 'Web stream' : 'Node stream' }));
  } catch (error) { code = 1; console.error(error); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    app.exit(code);
  }
});

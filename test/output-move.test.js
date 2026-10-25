const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { moveOutputAtomically } = require('../bili-download');
const { createDownloadTask, cleanupDownloadTask } = require('../download-task');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const absent = file => assert.rejects(fs.access(file), { code: 'ENOENT' });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piku-output-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  await fs.writeFile(source, 'complete output');
  // Only the original source crosses volumes. The staging link is real NTFS I/O.
  const io = { ...fs, link: async (a, b) => {
    if (a === source) throw Object.assign(Error('cross-device'), { code: 'EXDEV' });
    return fs.link(a, b);
  } };
  return { root, source, target, io };
}

test('cross-volume publication hides partial data and removes only its private staging directory', async t => {
  const { root, source, target, io } = await fixture(t), copied = deferred(), finish = deferred();
  const foreign = path.join(root, '.bilidown-output-someone-else');
  await fs.mkdir(foreign); await fs.writeFile(path.join(foreign, 'keep'), 'other task');
  let staging, owned = 0;
  io.copyFile = async (a, b) => {
    staging = path.dirname(b);
    assert.equal(path.dirname(staging), root);
    await fs.writeFile(b, 'complete ', { flag: 'wx' }); copied.resolve();
    await finish.promise; await fs.appendFile(b, 'output');
  };
  const operation = moveOutputAtomically(source, target, () => {
    owned++; assert.equal(require('node:fs').readFileSync(target, 'utf8'), 'complete output');
  }, io);
  try {
    await copied.promise; await absent(target); assert.equal(owned, 0);
    assert.equal(await fs.readFile(path.join(staging, 'output'), 'utf8'), 'complete ');
  } finally { finish.resolve(); }
  await operation;
  assert.equal(owned, 1); await absent(source); await absent(staging);
  assert.equal(await fs.readFile(path.join(foreign, 'keep'), 'utf8'), 'other task');
  assert.deepEqual((await fs.readdir(root)).sort(), ['.bilidown-output-someone-else', 'target']);
});

for (const code of ['ENOSPC', 'EIO']) test(`mid-copy ${code} leaves no final file or owned staging remnants`, async t => {
  const { root, source, target, io } = await fixture(t), failure = Object.assign(Error(code), { code });
  await fs.writeFile(path.join(root, 'unrelated'), 'keep');
  io.copyFile = async (a, b) => { await fs.writeFile(b, 'partial', { flag: 'wx' }); throw failure; };
  await assert.rejects(moveOutputAtomically(source, target, () => assert.fail('claimed partial output'), io), error => error === failure);
  await absent(target); assert.equal(await fs.readFile(source, 'utf8'), 'complete output');
  assert.deepEqual((await fs.readdir(root)).sort(), ['source', 'unrelated']);
});

test('two cross-volume publishers race without overwriting or claiming the losing output', async t => {
  const { root, source, target } = await fixture(t), other = path.join(root, 'other');
  await fs.writeFile(other, 'other output');
  const sources = [source, other], copied = deferred(), publish = deferred(), owners = [];
  let copies = 0;
  const io = { ...fs, link: async (a, b) => {
    if (sources.includes(a)) throw Object.assign(Error('cross-device'), { code: 'EXDEV' });
    return fs.link(a, b);
  }, copyFile: async (...args) => {
    await fs.copyFile(...args); if (++copies === 2) copied.resolve(); await publish.promise;
  } };
  const operations = sources.map((file, index) => moveOutputAtomically(file, target, () => owners.push(index), io));
  const settled = Promise.allSettled(operations);
  try { await copied.promise; await absent(target); } finally { publish.resolve(); }
  const results = await settled;
  const winner = results.findIndex(result => result.status === 'fulfilled'), loser = 1 - winner;
  assert.ok(winner >= 0); assert.equal(results[loser].status, 'rejected');
  assert.equal(results[loser].reason.code, 'EEXIST'); assert.deepEqual(owners, [winner]);
  assert.equal(await fs.readFile(target, 'utf8'), winner === 0 ? 'complete output' : 'other output');
  await absent(sources[winner]); await fs.access(sources[loser]);
  assert.deepEqual((await fs.readdir(root)).sort(), [path.basename(sources[loser]), 'target'].sort());
});

test('a pre-existing final file is preserved after the cross-volume copy finishes', async t => {
  const { root, source, target, io } = await fixture(t); await fs.writeFile(target, 'original');
  await assert.rejects(moveOutputAtomically(source, target, () => assert.fail('claimed an existing file'), io), { code: 'EEXIST' });
  assert.equal(await fs.readFile(target, 'utf8'), 'original'); await fs.access(source);
  assert.deepEqual((await fs.readdir(root)).sort(), ['source', 'target']);
});

test('a pre-cancelled move makes no filesystem changes', async t => {
  const { root, source, target, io } = await fixture(t), controller = new AbortController(), reason = Error('cancel before move');
  controller.abort(reason); io.link = () => assert.fail('started a cancelled move');
  await assert.rejects(moveOutputAtomically(source, target, () => assert.fail('claimed output'), io, controller.signal), error => error === reason);
  assert.deepEqual(await fs.readdir(root), ['source']);
});

test('cancelling during copy waits for the writer and cleans partial staging without publishing', async t => {
  const { root, source, target, io } = await fixture(t), controller = new AbortController(), started = deferred(), finish = deferred();
  const reason = Error('cancel copying'); let returned = false, staging;
  io.copyFile = async (a, b) => {
    staging = path.dirname(b); await fs.writeFile(b, 'partial', { flag: 'wx' }); started.resolve();
    await finish.promise; await fs.appendFile(b, ' last write');
  };
  const checked = assert.rejects(moveOutputAtomically(source, target, () => assert.fail('published after cancellation'), io, controller.signal), error => error === reason).then(() => { returned = true; });
  try {
    await started.promise; controller.abort(reason); await new Promise(resolve => setImmediate(resolve));
    assert.equal(returned, false); await fs.access(staging); await absent(target);
  } finally { finish.resolve(); }
  await checked; await absent(staging); await absent(target);
  assert.equal(await fs.readFile(source, 'utf8'), 'complete output'); assert.deepEqual(await fs.readdir(root), ['source']);
});

test('cancellation while allocating staging removes it before starting the copy', async t => {
  const { root, source, target, io } = await fixture(t), controller = new AbortController(), reason = Error('cancel allocation');
  io.mkdtemp = async prefix => { const dir = await fs.mkdtemp(prefix); controller.abort(reason); return dir; };
  io.copyFile = () => assert.fail('copied after cancellation');
  await assert.rejects(moveOutputAtomically(source, target, () => assert.fail('claimed output'), io, controller.signal), error => error === reason);
  assert.deepEqual(await fs.readdir(root), ['source']);
});

test('cancellation as the final link completes registers ownership for cleanupDownloadTask', async t => {
  const { root, source, target, io } = await fixture(t), controller = new AbortController(), reason = Error('cancel publication');
  const task = createDownloadTask(controller, root); task.target = target;
  await fs.writeFile(path.join(root, 'unrelated'), 'keep');
  const link = io.link; io.link = async (a, b) => { await link(a, b); controller.abort(reason); };
  let claims = 0;
  await assert.rejects(moveOutputAtomically(source, target, () => { claims++; task.ownedOutput = true; }, io, controller.signal), error => error === reason);
  assert.equal(claims, 1); assert.equal(task.ownedOutput, true);
  assert.equal(await fs.readFile(target, 'utf8'), 'complete output');
  assert.deepEqual((await fs.readdir(root)).sort(), ['source', 'target', 'unrelated']);
  await cleanupDownloadTask(task); await absent(target);
  assert.deepEqual((await fs.readdir(root)).sort(), ['source', 'unrelated']);
});

test('a failed final link cleans staging and never claims or removes another output', async t => {
  const { root, source, target, io } = await fixture(t), failure = Object.assign(Error('denied link'), { code: 'EPERM' });
  const link = io.link; io.link = (a, b) => a === source ? link(a, b) : Promise.reject(failure);
  await assert.rejects(moveOutputAtomically(source, target, () => assert.fail('claimed unpublished output'), io), error => error === failure);
  assert.deepEqual(await fs.readdir(root), ['source']);
});

test('source unlink failure after cross-volume publication retains ownership and cleans staging', async t => {
  const { root, source, target, io } = await fixture(t), controller = new AbortController(), task = createDownloadTask(controller, root);
  task.target = target; io.unlink = async () => { throw Error('unlink source failed'); };
  await assert.rejects(moveOutputAtomically(source, target, () => { task.ownedOutput = true; }, io), /unlink source failed/);
  assert.equal(task.ownedOutput, true); assert.equal(await fs.readFile(target, 'utf8'), 'complete output');
  assert.deepEqual((await fs.readdir(root)).sort(), ['source', 'target']);
  controller.abort(); await cleanupDownloadTask(task); await absent(target); await fs.access(source);
});

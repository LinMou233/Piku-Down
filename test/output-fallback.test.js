const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { moveOutputAtomically } = require('../output-file');
const { createDownloadTask, cleanupDownloadTask } = require('../download-task');
const failure = code => Object.assign(Error(code), { code });
const absent = file => assert.rejects(fs.access(file), { code: 'ENOENT' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, code = 'EPERM') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piku-fallback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  await fs.writeFile(source, 'complete output');
  const calls = [];
  const io = { ...fs,
    link: async () => { throw failure(code); },
    supportsHardLinks: async () => { calls.push('capability'); return false; },
    // Simulate a native no-replace rename on the NTFS test volume. Actual
    // MoveFileExW is separately exercised by the opt-in Windows/FAT32 suite.
    moveNoReplace: async (a, b) => { calls.push('publish'); await fs.link(a, b); await fs.unlink(a); }
  };
  return { root, source, target, io, calls };
}

for (const code of ['EPERM', 'EISDIR', 'ENOTSUP', 'EOPNOTSUPP']) {
  test(`${code} on a non-hard-link volume stages complete bytes before exclusive publication`, async t => {
    const { root, source, target, io, calls } = await fixture(t, code);
    let claims = 0;
    io.copyFile = async (a, b, flags) => {
      assert.equal(flags, constants.COPYFILE_EXCL); await absent(target);
      assert.equal(path.dirname(path.dirname(b)), root); await fs.copyFile(a, b, flags);
    };
    await moveOutputAtomically(source, target, () => { claims++; }, io);
    assert.equal(claims, 1); assert.equal(await fs.readFile(target, 'utf8'), 'complete output');
    assert.equal(calls.filter(x => x === 'publish').length, 1);
    assert.equal(calls.filter(x => x === 'capability').length, ['EPERM', 'EISDIR'].includes(code) ? 1 : 0);
    await absent(source); assert.deepEqual(await fs.readdir(root), ['target']);
  });
}

for (const code of ['EPERM', 'EISDIR', 'EACCES']) test(`${code} permission/directory failures on NTFS do not trigger a copy or rename`, async t => {
  const { source, target, io } = await fixture(t, code);
  const denied = failure(code); io.link = async () => { throw denied; };
  io.supportsHardLinks = async () => true;
  io.copyFile = io.moveNoReplace = () => assert.fail('unsafe fallback');
  await assert.rejects(moveOutputAtomically(source, target, () => assert.fail('claimed'), io), e => e === denied);
  await fs.access(source); await absent(target);
});

test('an actual directory is never copied as the FAT32 EISDIR workaround', async t => {
  const { root, target, io } = await fixture(t, 'EISDIR'), directory = path.join(root, 'directory');
  await fs.mkdir(directory); io.copyFile = () => assert.fail('copied a directory');
  const original = failure('EISDIR'); io.link = async () => { throw original; };
  io.supportsHardLinks = () => assert.fail('probed a directory');
  await assert.rejects(moveOutputAtomically(directory, target, () => {}, io), e => e === original);
});

test('unknown capability fails closed and preserves the original files', async t => {
  const { root, source, target, io } = await fixture(t);
  const original = failure('EPERM'); io.link = async () => { throw original; };
  io.supportsHardLinks = async () => { throw failure('EACCES'); };
  io.copyFile = io.moveNoReplace = () => assert.fail('assumed unavailable hard links');
  await assert.rejects(moveOutputAtomically(source, target, () => {}, io), e => e === original);
  assert.deepEqual(await fs.readdir(root), ['source']);
});

test('cancellation during capability detection stops before creating staging', async t => {
  const { root, source, target, io } = await fixture(t), controller = new AbortController(), reason = Error('cancel capability query');
  io.supportsHardLinks = async () => { controller.abort(reason); return false; };
  io.copyFile = io.moveNoReplace = () => assert.fail('continued after cancellation');
  await assert.rejects(moveOutputAtomically(source, target, () => assert.fail('claimed'), io, controller.signal), e => e === reason);
  assert.deepEqual(await fs.readdir(root), ['source']);
});

for (const code of ['EIO', 'ENOSPC']) test(`non-hard-link mid-copy ${code} cleans private staging and protects other tasks`, async t => {
  const { root, source, target, io } = await fixture(t);
  const foreign = path.join(root, '.bilidown-output-foreign'); await fs.mkdir(foreign); await fs.writeFile(path.join(foreign, 'keep'), 'keep');
  io.copyFile = async (a, b) => { await fs.writeFile(b, 'partial', { flag: 'wx' }); await absent(target); throw failure(code); };
  io.moveNoReplace = () => assert.fail('published a partial file');
  await assert.rejects(moveOutputAtomically(source, target, () => assert.fail('claimed'), io), { code });
  assert.equal(await fs.readFile(source, 'utf8'), 'complete output'); await absent(target);
  assert.deepEqual((await fs.readdir(root)).sort(), ['.bilidown-output-foreign', 'source']);
  assert.equal(await fs.readFile(path.join(foreign, 'keep'), 'utf8'), 'keep');
});

test('fallback publication preserves pre-existing files and racing outputs', async t => {
  const { root, source, target, io } = await fixture(t);
  await fs.writeFile(target, 'keep');
  await assert.rejects(moveOutputAtomically(source, target, () => assert.fail('claimed existing output'), io), { code: 'EEXIST' });
  assert.equal(await fs.readFile(target, 'utf8'), 'keep'); await fs.unlink(target);
  const other = path.join(root, 'other'); await fs.writeFile(other, 'other output');
  let copies = 0; const ready = deferred(), publish = deferred();
  io.copyFile = async (...args) => { await fs.copyFile(...args); if (++copies === 2) ready.resolve(); await publish.promise; };
  const owners = [], sources = [source, other];
  const done = Promise.allSettled(sources.map((file, i) => moveOutputAtomically(file, target, () => owners.push(i), io)));
  try { await ready.promise; await absent(target); } finally { publish.resolve(); }
  const results = await done, winner = results.findIndex(x => x.status === 'fulfilled');
  assert.ok(winner >= 0); assert.equal(results[1 - winner].reason.code, 'EEXIST'); assert.deepEqual(owners, [winner]);
  assert.equal(await fs.readFile(target, 'utf8'), winner === 0 ? 'complete output' : 'other output');
  await absent(sources[winner]); await fs.access(sources[1 - winner]);
  assert.deepEqual((await fs.readdir(root)).sort(), [path.basename(sources[1 - winner]), 'target'].sort());
});

test('cancelling a fallback copy waits for its final write before removing private staging', async t => {
  const { root, source, target, io } = await fixture(t), started = deferred(), finish = deferred();
  const controller = new AbortController(), reason = Error('stop copy'); let returned = false;
  io.copyFile = async (a, b) => { await fs.writeFile(b, 'partial', { flag: 'wx' }); started.resolve(); await finish.promise; await fs.appendFile(b, ' last write'); };
  io.moveNoReplace = () => assert.fail('published cancelled bytes');
  const done = assert.rejects(moveOutputAtomically(source, target, () => assert.fail('claimed'), io, controller.signal), e => e === reason).then(() => { returned = true; });
  try { await started.promise; controller.abort(reason); await new Promise(r => setImmediate(r)); assert.equal(returned, false); await absent(target); }
  finally { finish.resolve(); }
  await done; assert.deepEqual(await fs.readdir(root), ['source']);
});

test('native publication settling after cancellation records ownership before shared task cleanup', async t => {
  const { root, source, target, io } = await fixture(t), controller = new AbortController();
  const task = createDownloadTask(controller, root); task.target = target;
  const publish = io.moveNoReplace;
  io.moveNoReplace = async (...args) => { await publish(...args); controller.abort(Error('stop publication')); };
  await assert.rejects(moveOutputAtomically(source, target, () => { task.ownedOutput = true; }, io, controller.signal), /stop publication/);
  assert.equal(task.ownedOutput, true); assert.equal(await fs.readFile(target, 'utf8'), 'complete output');
  await cleanupDownloadTask(task); await absent(target); await fs.access(source);
  assert.deepEqual(await fs.readdir(root), ['source']);
});

for (const code of ['EACCES', 'ENOTSUP', 'EIO']) test(`failed no-replace publication (${code}) never claims another output and cleans staging`, async t => {
  const { root, source, target, io } = await fixture(t);
  io.moveNoReplace = async () => { throw failure(code); };
  await assert.rejects(moveOutputAtomically(source, target, () => assert.fail('claimed'), io), { code });
  assert.deepEqual(await fs.readdir(root), ['source']); await absent(target);
});

test('ownership survives source unlink failure after fallback rename for later cancellation cleanup', async t => {
  const { root, source, target, io } = await fixture(t), controller = new AbortController(), task = createDownloadTask(controller, root);
  task.target = target; const error = failure('EACCES'); io.unlink = async () => { throw error; };
  await assert.rejects(moveOutputAtomically(source, target, () => { task.ownedOutput = true; }, io), e => e === error);
  assert.equal(task.ownedOutput, true); assert.equal(await fs.readFile(target, 'utf8'), 'complete output');
  assert.deepEqual((await fs.readdir(root)).sort(), ['source', 'target']);
  controller.abort(); await cleanupDownloadTask(task); await absent(target); await fs.access(source);
});

test('shared publisher is packaged and the previous bili-download export remains compatible', () => {
  assert.equal(require('../bili-download').moveOutputAtomically, moveOutputAtomically);
  assert.ok(require('../package.json').build.files.includes('output-file.js'));
});

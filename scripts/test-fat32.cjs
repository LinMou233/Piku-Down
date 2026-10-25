// Explicit opt-in only: node scripts/test-fat32.cjs --run
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { moveOutputAtomically } = require('../output-file');
const { createDownloadTask, cleanupDownloadTask } = require('../download-task');
const { publicationFixture } = require('../test/helpers/download-publication');
const absent = file => assert.rejects(fs.access(file), { code: 'ENOENT' });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const fail = code => Object.assign(Error(code), { code });

async function run() {
  assert.equal(process.platform, 'win32'); assert.equal(process.argv[2], '--run', 'Explicit --run is required');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Read-only volume checks precede every directory creation on D:.
  const volumes = JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; @(Get-Volume -DriveLetter C,D | Select-Object DriveLetter,FileSystem,Size,SizeRemaining) | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true }));
  assert.equal(volumes.find(v => v.DriveLetter === 'D').FileSystem, 'FAT32');
  assert.equal(volumes.find(v => v.DriveLetter === 'C').FileSystem, 'NTFS');
  assert.ok(volumes.find(v => v.DriveLetter === 'D').SizeRemaining > 64 * 1024 * 1024);
  const base = path.resolve('D:\\PikuDown-FAT32-Test');
  await fs.mkdir(base, { recursive: true });
  assert.equal((await fs.lstat(base)).isSymbolicLink(), false);
  assert.equal((await fs.realpath(base)).toLowerCase(), base.toLowerCase());
  const existingEntries = (await fs.readdir(base)).sort();
  const workspace = path.resolve(__dirname, '../work'); await fs.mkdir(workspace, { recursive: true });
  const sourceRoot = await fs.mkdtemp(path.join(workspace, 'fat32-source-'));
  const targetRoot = await fs.mkdtemp(path.join(base, 'run-'));
  const token = randomUUID(), checks = [], data = Buffer.alloc(1024 * 1024, 37);
  const marker = '.piku-test-owner';
  await fs.writeFile(path.join(sourceRoot, marker), token, { flag: 'wx' });
  await fs.writeFile(path.join(targetRoot, marker), token, { flag: 'wx' });
  async function check(name, callback) { await callback(); checks.push(name); console.log('PASS ' + name); }
  async function onlyOwnFiles(root, names) { assert.deepEqual((await fs.readdir(root)).filter(n => n !== marker).sort(), [...names].sort()); }
  async function cleanupOwned(root, parent, prefix) {
    assert.equal(path.dirname(path.resolve(root)), parent); assert.ok(path.basename(root).startsWith(prefix));
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
    assert.equal((await fs.realpath(root)).toLowerCase(), root.toLowerCase());
    assert.equal(await fs.readFile(path.join(root, marker), 'utf8'), token);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  }
  let failure;
  try {
    await check('native FAT32 regular-file link error and directory error preservation', async () => {
      const source = path.join(targetRoot, 'probe'); await fs.writeFile(source, data);
      await assert.rejects(fs.link(source, path.join(targetRoot, 'probe-link')), { code: 'EISDIR' });
      const directory = path.join(targetRoot, 'directory'); await fs.mkdir(directory);
      let original;
      await assert.rejects(moveOutputAtomically(directory, path.join(targetRoot, 'not-a-file'), () => assert.fail('claimed directory'), {
        ...fs, link: async (...args) => { try { return await fs.link(...args); } catch (error) { original = error; throw error; } }
      }), error => error === original && error.code === 'EISDIR');
      await fs.rmdir(directory); await fs.unlink(source);
    });
    await check('FAT32 to FAT32 complete publication, Unicode and literal shell characters', async () => {
      const source = path.join(targetRoot, 'source'), target = path.join(targetRoot, "影片 $(test) & 'literal'.mp4");
      await fs.writeFile(source, data); let claims = 0;
      await moveOutputAtomically(source, target, () => { claims++; });
      assert.equal(claims, 1); assert.equal(hash(await fs.readFile(target)), hash(data)); await absent(source);
      await onlyOwnFiles(targetRoot, [path.basename(target)]); await fs.unlink(target);
    });
    await check('existing FAT32 target is never replaced or claimed', async () => {
      const source = path.join(targetRoot, 'source'), target = path.join(targetRoot, 'existing');
      await fs.writeFile(source, data); await fs.writeFile(target, 'keep');
      await assert.rejects(moveOutputAtomically(source, target, () => assert.fail('claimed existing output')), { code: 'EEXIST' });
      assert.equal(await fs.readFile(target, 'utf8'), 'keep'); await fs.access(source);
      await onlyOwnFiles(targetRoot, ['source', 'existing']); await fs.unlink(source); await fs.unlink(target);
    });
    await check('two native FAT32 publishers compete with exactly one winner', async () => {
      const sources = [path.join(targetRoot, 'a'), path.join(targetRoot, 'b')], target = path.join(targetRoot, 'race');
      await fs.writeFile(sources[0], data); await fs.writeFile(sources[1], Buffer.alloc(data.length, 53));
      const ready = deferred(), finish = deferred(), owners = []; let copies = 0;
      const io = { ...fs, copyFile: async (...args) => { await fs.copyFile(...args); if (++copies === 2) ready.resolve(); await finish.promise; } };
      const done = Promise.allSettled(sources.map((source, i) => moveOutputAtomically(source, target, () => owners.push(i), io)));
      try { await ready.promise; await absent(target); } finally { finish.resolve(); }
      const results = await done, winner = results.findIndex(result => result.status === 'fulfilled');
      assert.ok(winner >= 0); assert.equal(results[1 - winner].reason.code, 'EEXIST'); assert.deepEqual(owners, [winner]);
      assert.equal(hash(await fs.readFile(target)), hash(Buffer.alloc(data.length, winner === 0 ? 37 : 53)));
      await absent(sources[winner]); await fs.access(sources[1 - winner]);
      await onlyOwnFiles(targetRoot, [path.basename(sources[1 - winner]), 'race']); await fs.unlink(sources[1 - winner]); await fs.unlink(target);
    });
    await check('cancel during controlled FAT32 partial write waits and removes only owned staging', async () => {
      const source = path.join(targetRoot, 'source'), target = path.join(targetRoot, 'cancelled'); await fs.writeFile(source, data);
      const foreign = path.join(targetRoot, '.bilidown-output-other-task'); await fs.mkdir(foreign); await fs.writeFile(path.join(foreign, 'keep'), 'keep');
      const started = deferred(), finish = deferred(), controller = new AbortController(), reason = Error('test cancellation'); let settled = false;
      const io = { ...fs, copyFile: async (a, b) => { const file = await fs.open(b, 'wx'); try { await file.write(data.subarray(0, 16)); started.resolve(); await finish.promise; await file.write(data.subarray(16)); } finally { await file.close(); } } };
      const done = assert.rejects(moveOutputAtomically(source, target, () => assert.fail('claimed cancelled output'), io, controller.signal), error => error === reason).then(() => { settled = true; });
      try { await started.promise; await absent(target); controller.abort(reason); await new Promise(r => setImmediate(r)); assert.equal(settled, false); }
      finally { finish.resolve(); }
      await done; await absent(target); await fs.access(source); assert.equal(await fs.readFile(path.join(foreign, 'keep'), 'utf8'), 'keep');
      await onlyOwnFiles(targetRoot, ['source', path.basename(foreign)]);
      await fs.unlink(source); await fs.unlink(path.join(foreign, 'keep')); await fs.rmdir(foreign);
    });
    for (const code of ['EIO', 'ENOSPC']) await check(`injected ${code} after partial FAT32 write leaves no formal output or staging`, async () => {
      const source = path.join(sourceRoot, 'source'), target = path.join(targetRoot, 'failed'); await fs.writeFile(source, data);
      await assert.rejects(moveOutputAtomically(source, target, () => assert.fail('claimed partial output'), { ...fs,
        copyFile: async (a, b) => { await fs.writeFile(b, 'partial', { flag: 'wx' }); await absent(target); throw fail(code); }
      }), { code });
      await fs.access(source); await absent(target); await onlyOwnFiles(targetRoot, []); await fs.unlink(source);
    });
    await check('NTFS to FAT32 and FAT32 to NTFS use real cross-volume EXDEV paths', async () => {
      for (const [from, to] of [[sourceRoot, targetRoot], [targetRoot, sourceRoot]]) {
        const source = path.join(from, 'source'), target = path.join(to, 'complete'); await fs.writeFile(source, data);
        await assert.rejects(fs.link(source, target), { code: 'EXDEV' });
        await moveOutputAtomically(source, target); await absent(source); assert.equal(hash(await fs.readFile(target)), hash(data));
        await fs.unlink(target); await onlyOwnFiles(sourceRoot, []); await onlyOwnFiles(targetRoot, []);
      }
    });
    await check('cancelling a pending native NTFS to FAT32 copy never publishes it', async () => {
      const source = path.join(sourceRoot, 'source'), target = path.join(targetRoot, 'cancelled'); await fs.writeFile(source, data);
      const controller = new AbortController(), reason = Error('cancel pending native copy');
      await assert.rejects(moveOutputAtomically(source, target, () => assert.fail('published cancelled copy'), { ...fs,
        copyFile: async (...args) => { const done = fs.copyFile(...args); controller.abort(reason); await done; }
      }, controller.signal), error => error === reason);
      await fs.access(source); await absent(target); await onlyOwnFiles(targetRoot, []); await fs.unlink(source);
    });
    await check('NTFS hard-link fast path performs no copy or Windows helper call', async () => {
      const source = path.join(sourceRoot, 'source'), target = path.join(sourceRoot, 'fast'); await fs.writeFile(source, data);
      await moveOutputAtomically(source, target, () => { const a = require('node:fs').statSync(source), b = require('node:fs').statSync(target); assert.equal(a.ino, b.ino); assert.equal(b.nlink, 2); }, {
        ...fs, copyFile: () => assert.fail('copied on NTFS'), supportsHardLinks: () => assert.fail('queried NTFS'), moveNoReplace: () => assert.fail('renamed on NTFS')
      });
      await absent(source); await fs.unlink(target); await onlyOwnFiles(sourceRoot, []);
    });
    await check('FAT32 publication settling after cancellation registers ownership for task cleanup', async () => {
      const source = path.join(targetRoot, 'source'), target = path.join(targetRoot, 'cancelled'); await fs.writeFile(source, data);
      const controller = new AbortController(), task = createDownloadTask(controller, targetRoot); task.target = target;
      await assert.rejects(moveOutputAtomically(source, target, () => { task.ownedOutput = true; controller.abort(Error('cancel publication')); }, fs, controller.signal), /cancel publication/);
      assert.equal(task.ownedOutput, true); await cleanupDownloadTask(task); await absent(target); await fs.access(source);
      await fs.unlink(source); await onlyOwnFiles(targetRoot, []);
    });
    for (const bvid of ['BVfixture', 'external:x', 'external:youtube']) {
      await check(`${bvid} actual IPC flow uses shared native FAT32 publication and preserves history`, async () => {
        const f = publicationFixture(targetRoot), result = await f.download({ bvid, title: 'integration' });
        assert.equal(f.publications.length, 1); assert.equal(f.task().ownedOutput, true); assert.equal(f.history().length, 2);
        assert.equal(await fs.readFile(result.file, 'utf8'), 'complete fixture'); assert.equal(f.history()[0].taskId, f.task().id);
        await onlyOwnFiles(targetRoot, ['integration.mp4']); await fs.unlink(result.file);
      });
      await check(`${bvid} cancelled FAT32 IPC flow cleans owned output without changing earlier history`, async () => {
        const f = publicationFixture(targetRoot, { cancelAfterPublish: true });
        await assert.rejects(f.download({ bvid, title: 'cancelled' }), /下载已取消/);
        assert.equal(f.task().ownedOutput, true); assert.equal(f.history().length, 1); assert.equal((await f.task().done).deleted, true);
        await onlyOwnFiles(targetRoot, []);
      });
      for (const code of ['EIO', 'ENOSPC']) await check(`${bvid} FAT32 IPC ${code} injection cleans partial staging and records no output`, async () => {
        const f = publicationFixture(targetRoot, { io: { ...fs, copyFile: async (a, b) => { await fs.writeFile(b, 'partial', { flag: 'wx' }); throw fail(code); } } });
        await assert.rejects(f.download({ bvid, title: 'failed' }), { code });
        assert.equal(f.task().ownedOutput, false); assert.equal(f.history().length, 1); await onlyOwnFiles(targetRoot, []);
      });
    }
  } catch (error) { failure = error; }
  finally {
    await cleanupOwned(sourceRoot, workspace, 'fat32-source-');
    await cleanupOwned(targetRoot, base, 'run-');
  }
  await absent(sourceRoot); await absent(targetRoot);
  assert.deepEqual((await fs.readdir(base)).sort(), existingEntries);
  if (failure) throw failure;
  return { passed: true, platform: process.platform, node: process.versions.node, electron: process.versions.electron || null, volumes, bytesPerSource: data.length, checks,
    privateTestDirectoriesRemoved: true, existingBaseEntriesUnchanged: true, exFATTested: false,
    scope: 'Actual Windows/FAT32 I/O and IPC handlers; network, extractor and FFmpeg are fixtures. EIO/ENOSPC are injected, never a full disk.' };
}
if (require.main === module) run().then(result => {
  console.log(JSON.stringify(result, null, 2));
  if (process.env.PIKU_FAT32_REPORT) return fs.writeFile(path.resolve(process.env.PIKU_FAT32_REPORT), JSON.stringify(result, null, 2) + '\n');
}).catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { run };

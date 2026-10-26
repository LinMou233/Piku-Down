const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { publicationFixture } = require('./helpers/download-publication');
async function folder(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piku-publication-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}

for (const bvid of ['BVfixture', 'external:x', 'external:youtube']) {
  test(`${bvid} uses shared publication and preserves history, IPC result and temporary cleanup`, async t => {
    const root = await folder(t), f = publicationFixture(root);
    const result = await f.download({ bvid, title: 'complete' });
    assert.equal(f.publications.length, 1); assert.equal(f.task().ownedOutput, true);
    assert.equal(result.file, path.join(root, 'complete.mp4')); assert.equal(result.kind, 'video'); assert.equal(result.video.fps, 30);
    assert.equal(await fs.readFile(result.file, 'utf8'), 'complete fixture');
    const record = f.history()[0]; assert.equal(record.file, result.file); assert.equal(record.taskId, f.task().id);
    assert.equal(record.title, 'complete'); assert.equal(record.kind, 'video'); assert.equal(record.format, 'mp4'); assert.equal(record.qn, 80);
    if (bvid.startsWith('external:')) { assert.equal(record.platform, bvid.slice(9)); assert.equal(record.url, `https://${record.platform}.invalid/fixture`); assert.equal(record.bvid, undefined); }
    else { assert.equal(record.bvid, bvid); assert.equal(record.platform, undefined); }
    assert.equal(f.history()[1].file, 'previous'); assert.equal(f.context.activeTask, null);
    assert.deepEqual(await fs.readdir(root), ['complete.mp4']);
    await assert.rejects(f.download({ bvid, title: 'complete' }), /同名文件/);
    assert.equal(f.publications.length, 1); assert.equal(await fs.readFile(result.file, 'utf8'), 'complete fixture');
  });

  test(`${bvid} protects an output created between the early name check and publication`, async t => {
    const root = await folder(t), f = publicationFixture(root, { beforePublish: (src, target) => fs.writeFile(target, 'competitor', { flag: 'wx' }) });
    await assert.rejects(f.download({ bvid, title: 'race' }), { code: 'EEXIST' });
    assert.equal(f.task().ownedOutput, false); assert.equal(await fs.readFile(path.join(root, 'race.mp4'), 'utf8'), 'competitor');
    assert.deepEqual(await fs.readdir(root), ['race.mp4']); assert.equal(f.history().length, 1);
  });

  test(`${bvid} cancellation after publication removes only owned output and adds no history`, async t => {
    const root = await folder(t); await fs.writeFile(path.join(root, 'keep'), 'keep');
    const f = publicationFixture(root, { cancelAfterPublish: true });
    await assert.rejects(f.download({ bvid, title: 'cancel' }), /下载已取消/);
    assert.equal(f.task().ownedOutput, true); assert.deepEqual(await fs.readdir(root), ['keep']); assert.equal(f.history().length, 1);
    assert.equal((await f.task().done).deleted, true); assert.equal(f.context.activeTask, null);
  });

  test(`${bvid} source cleanup failure after publication keeps the completed file, history and a warning`, async t => {
    const root = await folder(t), f = publicationFixture(root, { io: { ...fs, unlink: async () => { throw Object.assign(Error('locked source'), { code: 'EBUSY' }); } } });
    const result = await f.download({ bvid, title: 'warn' });
    assert.match(result.warning, /正式文件已保存.*locked source/); assert.equal(await fs.readFile(result.file, 'utf8'), 'complete fixture');
    assert.equal(f.history()[0].file, result.file); assert.equal(f.history()[0].taskId, f.task().id);
    const [task] = f.queue.state().tasks; assert.equal(task.state, 'completed'); assert.equal(task.file, result.file); assert.match(task.error, /locked source/);
    assert.deepEqual(await fs.readdir(root), ['warn.mp4']); assert.equal(f.context.activeTask, null);
  });

  for (const code of ['EIO', 'ENOSPC']) test(`${bvid} mid-copy ${code} leaves no output/history or temporary files`, async t => {
    const root = await folder(t), f = publicationFixture(root, { io: { ...fs,
      link: async () => { throw Object.assign(Error('cross-device'), { code: 'EXDEV' }); },
      copyFile: async (src, target) => { await fs.writeFile(target, 'partial', { flag: 'wx' }); throw Object.assign(Error(code), { code }); }
    } });
    await assert.rejects(f.download({ bvid, title: 'failed' }), { code });
    assert.equal(f.task().ownedOutput, false); assert.deepEqual(await fs.readdir(root), []); assert.equal(f.history().length, 1);
    assert.equal(f.context.activeTask, null);
  });
}

test('external audio keeps its existing result and history schema through shared publication', async t => {
  const root = await folder(t), f = publicationFixture(root);
  const result = await f.download({ bvid: 'external:youtube', kind: 'audio', title: 'audio', audioFormat: 'm4a' });
  assert.equal(result.kind, 'audio'); assert.equal(result.video, null); assert.equal(path.extname(result.file), '.m4a');
  assert.equal(f.history()[0].kind, 'audio'); assert.equal(f.history()[0].format, 'm4a'); assert.equal(f.history()[0].video, null);
});

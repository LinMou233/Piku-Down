const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { parseExternalUrl, entriesFromInfo, createExternalMedia, progressFromLine, readableError } = require('../external-media');
const { normalizeCookies, createExternalAuth } = require('../external-auth');
const { createExternalRuntime } = require('../external-runtime');
const { createDownloadTask, cleanupDownloadTask } = require('../download-task');
const { runProcess } = require('../process-runner');

const cookies = '# Netscape HTTP Cookie File\n.x.com\tTRUE\t/\tTRUE\t0\tauth_token\tprivate-value\n';
const metadata = {
  title: '测试视频', uploader: '作者', thumbnail: 'https://i.ytimg.com/vi/BaW_jenozKc/default.jpg',
  formats: [
    { format_id: '18', ext: 'mp4', vcodec: 'avc1', acodec: 'aac', height: 360, fps: 30, url: 'https://media.invalid/360' },
    { format_id: '137', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 1080, fps: 60, url: 'https://media.invalid/1080' },
    { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'aac', url: 'https://media.invalid/audio' },
    { format_id: 'drm', ext: 'mp4', vcodec: 'avc1', has_drm: true, height: 2160, url: 'https://media.invalid/drm' },
    { format_id: '773', ext: 'mp4', acodec: 'iamf.001.001.Opus', format_note: 'medium', url: 'https://media.invalid/iamf' }
  ]
};
async function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'piku-external-test-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), parent); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

test('accept X, Twitter, YouTube and Shorts links and discard tracking or playlist parameters', () => {
  for (const input of ['https://twitter.com/user/status/123?s=20', 'https://x.com/i/web/status/123/video/2']) assert.deepEqual(parseExternalUrl(input), { platform: 'x', url: 'https://x.com/i/web/status/123' });
  for (const input of ['https://youtu.be/BaW_jenozKc?t=2', 'https://www.youtube.com/shorts/BaW_jenozKc', 'https://music.youtube.com/watch?v=BaW_jenozKc&list=PLtest']) assert.deepEqual(parseExternalUrl(input), { platform: 'youtube', url: 'https://www.youtube.com/watch?v=BaW_jenozKc' });
  assert.equal(parseExternalUrl('BV17x411w7KC'), null);
  assert.equal(parseExternalUrl('https://x.com.attacker.invalid/user/status/123'), null);
  for (const input of ['http://x.com/user/status/123', 'https://user:pass@x.com/user/status/123', 'https://x.com/settings', 'https://youtube.com/playlist?list=123']) assert.throws(() => parseExternalUrl(input));
});

test('normalize multiple X videos, exclude DRM and audio-only streams from video choices', () => {
  const entries = entriesFromInfo({ title: '两个视频', entries: [metadata, metadata] });
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].cid, entries[1].cid);
  assert.equal(entries[1].index, 2);
  assert.deepEqual(entries[0].video.map(f => f.id), ['137', '18']);
  assert.equal(entries[0].audio, true);
  assert.throws(() => entriesFromInfo({ ...metadata, is_live: true }), /直播/);
});

test('Cookie import keeps only matching live cookies, including HttpOnly cookies', () => {
  const text = cookies + '#HttpOnly_.x.com\tTRUE\t/\tTRUE\t0\tct0\tcsrf\n.google.com\tTRUE\t/\tTRUE\t0\tSID\tunrelated\n.x.com\tTRUE\t/\tTRUE\t1\texpired\told\n.x.com.evil.invalid\tTRUE\t/\tTRUE\t0\twrong\tbad\n';
  const result = normalizeCookies(text, 'x');
  assert.match(result, /auth_token/);
  assert.match(result, /ct0/);
  assert.doesNotMatch(result, /SID|unrelated|expired|evil/);
  assert.throws(() => normalizeCookies(cookies.replace('auth_token', 'ct0'), 'x'), /登录状态/);
  assert.throws(() => normalizeCookies('not a cookie file', 'x'), /Netscape/);
  assert.throws(() => normalizeCookies(cookies, 'other'), /平台/);
});

test('X formats with unknown codecs allow audio extraction and keep original playlist indexes', () => {
  const entry = { title: 'X video', formats: [{ format_id: 'http-832', height: 360, ext: 'mp4', url: 'https://media.invalid/clip' }] };
  const entries = entriesFromInfo({ entries: [null, entry] });
  assert.equal(entries[0].index, 2);
  assert.equal(entries[0].audio, true);
  entry.formats[0].acodec = 'none';
  assert.equal(entriesFromInfo(entry)[0].audio, false);
});

test('saved cookies are encrypted, isolated by platform, and removable without touching source files', async t => {
  const root = await fixture(t);
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s).reverse(), decryptString: b => Buffer.from(b).reverse().toString() };
  let cleared = 0;
  const auth = createExternalAuth({ root, safeStorage, clearLegacyX: async () => { cleared++; } });
  assert.deepEqual(await auth.status(), { x: { saved: false, persistent: false }, youtube: { saved: false, persistent: false } });
  assert.equal(await auth.cookies('x'), null);
  await auth.importCookies('x', cookies, { remember: true });
  assert.equal((await auth.status()).x.saved, true);
  assert.equal((await auth.status()).youtube.saved, false);
  assert.equal((await fs.readFile(path.join(root, 'external-x.bin'))).includes(Buffer.from('private-value')), false);
  assert.match(await auth.cookies('x'), /private-value/);
  await auth.clear('x');
  assert.equal((await auth.status()).x.saved, false);
  assert.equal(cleared, 1);
  assert.equal(await auth.cookies('x'), null);
});

test('Cookie import defaults to memory and is discarded when the session ends', async t => {
  const root = await fixture(t);
  const safeStorage = { isEncryptionAvailable: () => false };
  const auth = createExternalAuth({ root, safeStorage });
  await auth.importCookies('x', cookies);
  assert.equal(await auth.cookies('x'), cookies);
  assert.deepEqual((await auth.status()).x, { saved: true, persistent: false });
  assert.deepEqual(await fs.readdir(root), []);
  auth.clearSession();
  assert.equal(await auth.cookies('x'), null);
  const restarted = createExternalAuth({ root, safeStorage });
  assert.equal(await restarted.cookies('x'), null);
  await auth.importCookies('x', cookies, { remember: 'true' });
  assert.deepEqual(await fs.readdir(root), []);
});

test('remembering is explicit and disabling it immediately removes the encrypted copy', async t => {
  const root = await fixture(t);
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s).reverse(), decryptString: b => Buffer.from(b).reverse().toString() };
  const auth = createExternalAuth({ root, safeStorage });
  await auth.importCookies('x', cookies);
  await auth.setRemembered('x', true);
  assert.equal((await auth.status()).x.persistent, true);
  const restarted = createExternalAuth({ root, safeStorage });
  assert.equal(await restarted.cookies('x'), cookies);
  await auth.setRemembered('x', false);
  await assert.rejects(fs.access(path.join(root, 'external-x.bin')));
  assert.equal(await auth.cookies('x'), cookies);
  assert.equal((await auth.status()).x.persistent, false);
  auth.clearSession();
  assert.equal(await auth.cookies('x'), null);
});

test('remembered files can be deleted even when decryption is unavailable', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'external-x.bin'), 'unreadable encrypted data');
  const auth = createExternalAuth({ root, safeStorage: { isEncryptionAvailable: () => false } });
  assert.equal((await auth.status()).x.persistent, true);
  await auth.setRemembered('x', false);
  assert.equal(await auth.cookies('x'), null);
  await assert.rejects(fs.access(path.join(root, 'external-x.bin')));
});

test('extractor errors never expose Cookie values, signed URLs or raw diagnostics', () => {
  for (const message of ['Cookie auth_token=fake-secret-value', '登录失败 Cookie=fake-secret-value', 'ERROR 403 https://media.invalid/?signature=fake-secret-value']) {
    const result = readableError(Error(message), 'x');
    assert.doesNotMatch(result.message, /fake-secret-value|signature=|auth_token=/);
    assert.doesNotMatch(result.stack, /fake-secret-value|signature=|auth_token=/);
  }
  assert.doesNotMatch(readableError(Error('NSFW post, extraction endpoint failed'), 'x').message, /要求登录|请导入/);
});

test('process arguments containing shell syntax are passed literally', async () => {
  const value = 'fake-cookie; $(echo must-not-run) & "quoted"';
  assert.equal(await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', value]), value);
});

test('public mode never reads or exports login cookies; selected formats stay bound to parsed media', async t => {
  const root = await fixture(t);
  const calls = [];
  let cookieReads = 0;
  const service = createExternalMedia({ root, runtime: { ensure: async () => 'yt-dlp.exe' }, auth: { cookies: async () => { cookieReads++; return cookies; } }, ffmpeg: () => 'ffmpeg.exe', run: async (file, args) => {
    calls.push(args);
    if (args.includes('--dump-single-json')) return JSON.stringify(metadata);
    await fs.writeFile(args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp4'), 'test-video');
  } });
  const result = await service.parse('https://youtu.be/BaW_jenozKc', 'public');
  const cid = result.pages[0].cid;
  assert.equal(service.formats(result.bvid, cid).video[0].id, '137');
  const task = createDownloadTask(new AbortController(), root);
  const download = await service.download({ bvid: result.bvid, cid, qn: '137', kind: 'video' }, task);
  assert.equal(download.extension, 'mp4');
  assert.equal(cookieReads, 0);
  assert.equal(calls.some(args => args.includes('--cookies')), false);
  assert.equal(calls[1].includes('137+bestaudio[ext=m4a][acodec!^=iamf]/137+bestaudio[acodec!^=iamf]/137'), true);
  await assert.rejects(service.download({ bvid: result.bvid, cid, qn: '137;evil', kind: 'video' }, task), /格式不可用/);
  assert.throws(() => service.formats(result.bvid, 'someone-elses-video'), /选择/);
  await cleanupDownloadTask(task);
});

test('session mode removes plaintext cookies after parse and after a failed download', async t => {
  const root = await fixture(t);
  const cookiePaths = [];
  const service = createExternalMedia({ root: path.join(root, 'private'), runtime: { ensure: async () => 'yt-dlp.exe' }, auth: { cookies: async () => cookies }, ffmpeg: () => 'ffmpeg.exe', run: async (file, args) => {
    const cookiePath = args[args.indexOf('--cookies') + 1];
    cookiePaths.push(cookiePath);
    assert.equal(args.some(arg => arg.includes('private-value')), false);
    assert.match(await fs.readFile(cookiePath, 'utf8'), /private-value/);
    if (args.includes('--dump-single-json')) return JSON.stringify(metadata);
    throw Error('HTTP Error 403 https://media.invalid/?secret=private');
  } });
  const result = await service.parse('https://x.com/user/status/123', 'session');
  await assert.rejects(fs.access(cookiePaths[0]));
  const task = createDownloadTask(new AbortController(), root);
  await assert.rejects(service.download({ bvid: result.bvid, cid: result.pages[0].cid, qn: '18', kind: 'video' }, task), error => !error.message.includes('secret=') && error.message.includes('无法访问'));
  await assert.rejects(fs.access(cookiePaths[1]));
  await cleanupDownloadTask(task);
});

test('missing login state fails before installing any component', async t => {
  const root = await fixture(t);
  const service = createExternalMedia({ root, auth: { cookies: async () => null }, runtime: { ensure: () => assert.fail('must not install') } });
  await assert.rejects(service.parse('https://x.com/user/status/123', 'session'), /尚未保存/);
});

test('corrupt runtime downloads are never executed or retained', async t => {
  const root = await fixture(t);
  const runtime = createExternalRuntime({ root, arch: 'x64', fetch: async () => new Response('corrupt executable') });
  await assert.rejects(runtime.ensure(), /校验失败/);
  assert.equal((await runtime.status()).installed, false);
  assert.deepEqual(await fs.readdir(path.join(root, 'download-tools', '2026.10.21')), []);
  const legacy = createExternalRuntime({ root, supported: false, fetch: () => assert.fail('legacy must not fetch') });
  await assert.rejects(legacy.ensure(), /Windows 10/);
});

test('structured progress tolerates unknown totals and ignores unrelated output', () => {
  assert.deepEqual(progressFromLine('PIKU_PROGRESS:{"status":"downloading","downloaded_bytes":42}'), { label: '正在下载', received: 42, total: 0 });
  assert.equal(progressFromLine('PIKU_PROGRESS:invalid'), null);
  assert.equal(progressFromLine('https://private.invalid/secret'), null);
});

test('cancel stops the downloader and its child before temporary files are cleaned', { timeout: 15000 }, async t => {
  const root = await fixture(t);
  const ready = path.join(root, 'ready');
  const marker = path.join(root, 'must-not-exist');
  const controller = new AbortController();
  const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'alive'),4000)`)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`;
  const running = runProcess(process.execPath, ['-e', script], { signal: controller.signal });
  const rejected = assert.rejects(running, /取消/);
  const started = Date.now();
  while (true) {
    try { await fs.access(ready); break; } catch { if (Date.now() - started > 5000) throw Error('child did not start'); await new Promise(resolve => setTimeout(resolve, 30)); }
  }
  controller.abort();
  await rejected;
  await new Promise(resolve => setTimeout(resolve, 4300));
  await assert.rejects(fs.access(marker));
});

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

test('Win7 runtime pins the community yt-dlp Win7 build and quickjs-ng, and hands QuickJS to yt-dlp', async t => {
  const root = await fixture(t);
  const { LEGACY_VERSION, QUICKJS_VERSION, LEGACY_ASSETS } = require('../external-runtime');
  const directory = path.join(root, 'download-tools', 'win7-' + LEGACY_VERSION);
  for (const [arch, tool, js] of [['x64', 'yt-dlp_win7.exe', 'qjs-windows-x86_64.exe'], ['ia32', 'yt-dlp_x86_win7.exe', 'qjs-windows-x86.exe']]) {
    assert.deepEqual(LEGACY_ASSETS[arch].map(([name]) => name), [tool, js]);
    const urls = [], runtime = createExternalRuntime({ root, arch, legacy: true, fetch: async url => { urls.push(url); return new Response('corrupt executable'); } });
    assert.equal(runtime.jsRuntime, 'quickjs:' + path.join(directory, js));
    assert.deepEqual(await runtime.status(), { supported: true, installed: false, version: LEGACY_VERSION, reason: '' });
    await assert.rejects(runtime.ensure(), /校验失败/);
    assert.deepEqual(urls, [`https://github.com/nicolaasjan/yt-dlp/releases/download/${LEGACY_VERSION}/${tool}`]);
    assert.deepEqual(await fs.readdir(directory), []);
  }
  assert.equal(QUICKJS_VERSION, 'v0.17.0');
  const arm = createExternalRuntime({ root, arch: 'arm64', legacy: true, fetch: () => assert.fail('unsupported Win7 arch must not fetch') });
  assert.equal(arm.jsRuntime, undefined); await assert.rejects(arm.ensure(), /Windows 10/);
  assert.equal(createExternalRuntime({ root, arch: 'x64', fetch: () => {} }).jsRuntime, undefined);
});

test('yt-dlp receives the configured JS runtime, defaulting to this Electron as Node', async t => {
  const root = await fixture(t);
  for (const [jsRuntime, expected] of [[undefined, 'node:' + process.execPath], ['quickjs:C:\\tools\\qjs-windows-x86.exe', 'quickjs:C:\\tools\\qjs-windows-x86.exe']]) {
    const calls = [];
    const service = createExternalMedia({ root, ...(jsRuntime && { jsRuntime }), runtime: { ensure: async () => 'yt-dlp.exe' }, auth: { cookies: async () => null }, ffmpeg: () => 'ffmpeg.exe',
      run: async (file, args) => { calls.push(args); return JSON.stringify(metadata); } });
    await service.parse('https://youtu.be/BaW_jenozKc', 'public');
    const args = calls[0];
    assert.equal(args[args.indexOf('--js-runtimes') + 1], expected); assert.ok(args.indexOf('--no-js-runtimes') < args.indexOf('--js-runtimes'));
  }
});

test('Win7 playback keeps only H.264 with AAC up to 1920x1088, while the modern build keeps its higher-bitrate choice', () => {
  const format = (format_id, vcodec, acodec, width, height, tbr, ext = 'mp4') => ({ format_id, ext, vcodec, acodec, width, height, tbr, url: 'https://media.invalid/' + format_id });
  const youtube = { title: 'Tears of Steel', formats: [
    format('616', 'vp09.00.40.08', 'none', 1920, 800, 4638), format('270', 'avc1.640028', 'none', 1920, 800, 3553), format('137', 'avc1.640028', 'none', 1920, 800, 1970),
    format('399', 'av01.0.08M.08', 'none', 1920, 800, 784), format('248', 'vp9', 'none', 1920, 800, 1018, 'webm'), format('401', 'av01.0.12M.08', 'none', 3840, 1600, 9000),
    format('18', 'avc1.42001E', 'mp4a.40.2', 640, 266, 374), format('opus-mux', 'avc1.4D401E', 'opus', 854, 356, 900), format('140', 'none', 'mp4a.40.2', null, null, 129, 'm4a')] };
  const modern = entriesFromInfo(youtube)[0].video, win7 = entriesFromInfo(youtube, { win7Playback: true })[0].video;
  assert.deepEqual(modern.map(item => item.id), ['401', '616', 'opus-mux', '18']);
  assert.deepEqual(win7.map(item => item.id), ['270', '18']); assert.equal(win7[1].hasAudio, true);
  const x = { title: 'X', formats: [format('http-2176', undefined, undefined, 1280, 720, 2176), format('http-10368', undefined, undefined, 2560, 1440, 10368), format('hls-1786', 'avc1.640020', 'none', 1280, 720, 1787)] };
  assert.deepEqual(entriesFromInfo(x, { win7Playback: true })[0].video.map(item => item.id), ['http-2176']);
  const portrait = { title: 'Shorts', formats: [format('137', 'avc1.640028', 'none', 1080, 1920, 3000), format('136', 'avc1.4d401f', 'none', 720, 1280, 1500), format('135', 'avc1.4d401f', 'none', 480, 854, 800), format('140', 'none', 'mp4a.40.2', null, null, 129, 'm4a')] };
  assert.deepEqual(entriesFromInfo(portrait, { win7Playback: true })[0].video.map(item => item.id), ['135']);
  assert.deepEqual(entriesFromInfo(portrait)[0].video.map(item => item.id), ['137', '136', '135']);
});

test('Win7 playback merges video only with AAC audio', async t => {
  const root = await fixture(t);
  const info = { title: 'Tears of Steel', formats: [{ format_id: '270', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', width: 1920, height: 800, tbr: 3553, url: 'https://media.invalid/270' }] };
  for (const [win7Playback, expected] of [[true, '270+bestaudio[acodec^=mp4a]/270'], [false, '270+bestaudio[ext=m4a][acodec!^=iamf]/270+bestaudio[acodec!^=iamf]/270']]) {
    const calls = [];
    const service = createExternalMedia({ root, win7Playback, runtime: { ensure: async () => 'yt-dlp.exe' }, auth: { cookies: async () => null }, ffmpeg: () => 'ffmpeg.exe', run: async (file, args) => {
      calls.push(args); if (args.includes('--dump-single-json')) return JSON.stringify(info);
      await fs.writeFile(args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp4'), 'video');
    } });
    const parsed = await service.parse('https://youtu.be/R6MlUcmOul8', 'public');
    const task = createDownloadTask(new AbortController(), root);
    await service.download({ bvid: parsed.bvid, cid: parsed.pages[0].cid, qn: '270', kind: 'video' }, task);
    assert.equal(calls[1][calls[1].indexOf('-f') + 1], expected); await cleanupDownloadTask(task);
  }
});

test('a Win7 machine missing loader or UCRT updates gets the required KB numbers instead of raw diagnostics', () => {
  for (const message of ['[PYI-2076:ERROR] Failed to load Python DLL C:\\Temp\\_MEI1\\python315.dll.\nLoadLibrary: The specified procedure could not be found.', 'spawn UNKNOWN']) {
    const error = readableError(Error(message), 'youtube');
    assert.match(error.message, /KB2533623.*KB2999226/); assert.doesNotMatch(error.message, /_MEI|python315/);
  }
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

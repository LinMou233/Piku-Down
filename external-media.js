const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { runProcess } = require('./process-runner');
const { UserError } = require('./user-error');

function parseExternalUrl(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { return null; }
  const host = url.hostname.toLowerCase();
  const x = ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(host);
  const youtube = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be'].includes(host);
  if (!x && !youtube) return null;
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new UserError('请使用完整的 HTTPS 视频链接');
  if (x) {
    const match = url.pathname.match(/^\/(?:[^/]+\/status|i\/web\/status)\/(\d+)(?:\/video\/\d+)?\/?$/);
    if (!match) throw new UserError('请粘贴 X 帖子的链接');
    return { platform: 'x', url: `https://x.com/i/web/status/${match[1]}` };
  }
  const id = host.endsWith('youtu.be') ? url.pathname.slice(1) : url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)\/?$/)?.[1];
  if (!/^[\w-]{11}$/.test(id || '')) throw new UserError('请粘贴单个 YouTube 视频或 Shorts 链接');
  return { platform: 'youtube', url: `https://www.youtube.com/watch?v=${id}` };
}

// Win7 Media Player only decodes H.264 up to 1920x1088 with AAC audio. X's direct MP4s omit
// codec fields but are always H.264/AAC, so a blank codec on an mp4 counts as playable.
function win7Playable(format) {
  const video = format.vcodec ? /^(avc1|h264)/i.test(format.vcodec) : format.ext === 'mp4';
  const audio = !format.acodec || format.acodec === 'none' || /^(mp4a|aac)/i.test(format.acodec);
  return video && audio && (Number(format.width) || 0) <= 1920 && (Number(format.height) || 0) <= 1088;
}

function videoFormats(info, { win7Playback = false } = {}) {
  const choices = new Map();
  for (const format of info.formats || []) {
    if (format.vcodec === 'none' || (!format.vcodec && !format.height && !format.width) || /^iamf/i.test(format.acodec || '') || format.has_drm || !format.url || !/^[\w.-]+$/.test(format.format_id || '') || format.ext === 'mhtml') continue;
    if (win7Playback && !win7Playable(format)) continue;
    const height = Number(format.height) || 0;
    const fps = Number(format.fps) || 0;
    const hdr = !!format.dynamic_range && !['SDR', 'unknown'].includes(format.dynamic_range);
    const group = `${height}:${Math.round(fps)}:${hdr}`;
    const score = (format.ext === 'mp4' ? 1e9 : 0) + (Number(format.tbr) || 0);
    if (choices.has(group) && choices.get(group).score >= score) continue;
    choices.set(group, {
      id: format.format_id, height, fps, hdr, score,
      label: (height ? `${height}p` : format.format_note || format.ext || '原画') + (fps >= 49 ? ` · ${Math.round(fps)}fps` : '') + (hdr ? ' · HDR' : ''),
      available: true, hasAudio: format.acodec && format.acodec !== 'none'
    });
  }
  return [...choices.values()].sort((a, b) => b.height - a.height || b.fps - a.fps || b.score - a.score);
}

function entriesFromInfo(info, options) {
  if (info.is_live || ['is_live', 'is_upcoming', 'post_live'].includes(info.live_status)) throw new UserError('请在直播结束并完成处理后再下载');
  const source = info.entries || [info];
  const entries = source.slice(0, 20).map((item, index) => item && ({
    cid: randomUUID(), index: Number(item.playlist_index) || index + 1,
    title: String(item.title || info.title || '未命名视频'),
    owner: String(item.uploader || item.channel || info.uploader || ''),
    cover: String(item.thumbnail || info.thumbnail || ''),
    duration: Number(item.duration) || 0,
    video: videoFormats(item, options),
    // Some X MP4 entries omit codec metadata; allow extraction and let FFmpeg
    // report a missing audio track rather than hiding audio for all such clips.
    audio: (item.formats || []).some(f => !f.has_drm && f.acodec !== 'none' && !/^iamf/i.test(f.acodec || '') && f.ext !== 'mhtml')
  })).filter(item => item && (item.video.length || item.audio));
  if (!entries.length) throw new UserError('没有找到可下载的视频，内容可能已删除或需要登录');
  return entries;
}

function readableError(error, platform) {
  if (error instanceof UserError) return error;
  const name = platform === 'x' ? 'X' : 'YouTube';
  // A Win7 machine without the loader and UCRT updates cannot start the bundled Python runtime.
  if (/Failed to load Python DLL|LoadLibrary|api-ms-win-crt|vcruntime|procedure could not be found|spawn UNKNOWN/i.test(error.message)) return Error('下载组件无法在此系统启动。Windows7 SP1请先安装KB2533623与KB2999226（通用C运行库），或安装最新的Windows7累积更新后重试。');
  if (/does not contain any audio|no audio|audio codec.*none/i.test(error.message)) return Error('这个视频没有可用音轨，请改为下载视频');
  if (/sign in|login|log in|confirm your age|authentication|cookies/i.test(error.message)) return Error(`${name} 访问失败。若网页要求登录，请导入有效 Cookie，并选择“使用登录状态”重新解析。`);
  if (/private|not available|unavailable|removed|deleted|restricted|403|404/i.test(error.message)) return Error(`${name} 视频无法访问，请确认链接、账号权限和地区限制。`);
  if (/timed out|network|connection|resolve|proxy|SSL|certificate/i.test(error.message)) return Error(`连接 ${name} 失败，请检查网络后重试。`);
  if (/ffmpeg|postprocess|conversion|codec|muxer/i.test(error.message)) return Error('音视频处理失败，可换一个画质或音频格式重试。');
  // Do not send signed media URLs or raw extractor diagnostics to the renderer.
  return Error(`${name} 解析或下载失败，请确认网页能访问该视频后重试。`);
}

function progressFromLine(line) {
  if (!line.startsWith('PIKU_PROGRESS:')) return null;
  try {
    const data = JSON.parse(line.slice(14));
    return { label: data.status === 'finished' ? '正在处理音视频' : '正在下载', received: Number(data.downloaded_bytes) || 0, total: Number(data.total_bytes || data.total_bytes_estimate) || 0 };
  } catch { return null; }
}

function createExternalMedia({ runtime, auth, root, ffmpeg, jsRuntime = 'node:' + process.execPath, win7Playback = false, run = runProcess, progress = () => {} }) {
  const cache = new Map();
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8' };
  const common = () => ['--ignore-config', '--no-plugin-dirs', '--no-playlist', '--no-warnings', '--no-cache-dir', '--encoding', 'utf-8', '--no-color', '--socket-timeout', '25', '--retries', '2', '--fragment-retries', '2', '--no-js-runtimes', '--js-runtimes', jsRuntime];
  async function withCookies(record, callback) {
    if (record.access === 'public') return callback([]);
    const cookies = await auth.cookies(record.platform);
    if (!cookies) throw new UserError('尚未保存该平台的登录状态，请先到设置中导入 Cookie');
    await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(path.join(root, 'auth-'));
    try {
      const file = path.join(directory, 'cookies.txt');
      await fs.writeFile(file, cookies, { flag: 'wx', mode: 0o600 });
      return await callback(['--cookies', file]);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
  function lookup(key, cid) {
    const record = cache.get(key);
    if (!record || Date.now() - record.created > 30 * 60 * 1000) throw new UserError('解析结果已过期，请重新解析');
    const entry = record.entries.find(item => item.cid === cid);
    if (!entry) throw new UserError('请选择要下载的视频');
    return { record, entry };
  }
  async function parse(input, access = 'public', signal, report = progress) {
    const source = parseExternalUrl(input);
    if (!source) throw new UserError('不支持的视频链接');
    if (!['public', 'session'].includes(access)) throw new UserError('无效的访问方式');
    const record = { ...source, access, created: Date.now() };
    let temporary;
    try {
      // Fail before installing tools if the requested login state is missing.
      if (access === 'session' && !await auth.cookies(source.platform)) throw new UserError('尚未保存该平台的登录状态，请先到设置中导入 Cookie');
      const executable = await runtime.ensure(signal, report);
      await fs.mkdir(root, { recursive: true });
      temporary = await fs.mkdtemp(path.join(root, 'parse-'));
      const json = await withCookies(record, cookies => run(executable, [...common(), ...cookies, '--dump-single-json', '--skip-download', '--playlist-items', '1:20', '--', source.url], { timeout: 120000, signal, env }));
      const info = JSON.parse(json);
      record.entries = entriesFromInfo(info, { win7Playback });
      const key = 'external:' + randomUUID();
      while (cache.size >= 20) cache.delete(cache.keys().next().value);
      cache.set(key, record);
      const first = record.entries[0];
      return { platform: source.platform, bvid: key, title: String(info.title || first.title), owner: first.owner, cover: first.cover, duration: first.duration, pages: record.entries.map((item, index) => ({ cid: item.cid, page: index + 1, part: item.title })) };
    } catch (error) { throw readableError(error, source.platform); }
    finally { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); }
  }
  function formats(key, cid) {
    const { entry } = lookup(key, cid);
    return { video: entry.video.map(({ id, label, fps, available }) => ({ id, label, fps, available })), audio: !!entry.audio };
  }
  async function download(opts, task, report = progress) {
    const { record, entry } = lookup(opts.bvid, opts.cid);
    const signal = task.controller.signal;
    const audioOnly = opts.kind === 'audio';
    const extension = audioOnly ? (opts.audioFormat === 'mp3' ? 'mp3' : 'm4a') : 'mp4';
    const format = entry.video.find(item => item.id === String(opts.qn));
    if (audioOnly ? !entry.audio : !format) throw new UserError('所选格式不可用，请重新解析');
    task.temp = await fs.mkdtemp(path.join(task.folder, '.bilidown-'));
    try {
      const executable = await runtime.ensure(signal, report);
      const audioSelector = record.platform === 'x' ? 'bestaudio/best' : 'bestaudio[acodec!^=iamf]/best[acodec!^=iamf]';
      const selection = audioOnly ? ['-f', audioSelector, '-x', '--audio-format', extension, '--audio-quality', extension === 'mp3' ? '320K' : '0'] : ['-f', format.hasAudio ? format.id : win7Playback ? `${format.id}+bestaudio[acodec^=mp4a]/${format.id}` : `${format.id}+bestaudio[ext=m4a][acodec!^=iamf]/${format.id}+bestaudio[acodec!^=iamf]/${format.id}`, '--merge-output-format', 'mp4', '--remux-video', 'mp4'];
      let lastProgress = 0;
      await withCookies(record, cookies => run(executable, [...common(), ...cookies, ...selection, '--ffmpeg-location', ffmpeg(), '--playlist-items', String(entry.index), '--no-simulate', '--no-overwrites', '--newline', '--progress', '--progress-template', 'download:PIKU_PROGRESS:%(progress)j', '-o', path.join(task.temp, 'media.%(ext)s'), '--', record.url], {
        signal, env,
        onLine(line) { const event = progressFromLine(line); if (event && (Date.now() - lastProgress > 100 || event.label === '正在处理音视频')) { report(event); lastProgress = Date.now(); } }
      }));
      signal.throwIfAborted();
      const file = path.join(task.temp, 'media.' + extension);
      const stat = await fs.stat(file);
      if (!stat.isFile() || !stat.size) throw new UserError('下载组件未生成有效文件');
      return { file, extension, platform: record.platform, url: record.url };
    } catch (error) { throw readableError(error, record.platform); }
  }
  return { parse, formats, download };
}

module.exports = { parseExternalUrl, videoFormats, entriesFromInfo, readableError, progressFromLine, createExternalMedia };

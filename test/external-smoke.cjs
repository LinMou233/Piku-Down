// Manual network check. Uses an isolated profile and no personal login state.
const { app, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createExternalRuntime } = require('../external-runtime');
const { createExternalMedia } = require('../external-media');
const { createDownloadTask, cleanupDownloadTask } = require('../download-task');
const { mediaBinary } = require('../media-binary');
const { runProcess } = require('../process-runner');
const root = path.resolve(__dirname, '../../work/external-smoke');
app.setPath('userData', path.join(root, 'profile'));
app.whenReady().then(async () => {
  try {
    await fs.mkdir(root, { recursive: true });
    const runtime = createExternalRuntime({ root, fetch: (url, opts) => session.defaultSession.fetch(url, opts) });
    const executable = await runtime.ensure(undefined, event => console.log(event.label, event.total ? Math.round(event.received / event.total * 100) : ''));
    console.log('YT_DLP', (await runProcess(executable, ['--version'])).trim());
    console.log('ELECTRON_NODE', (await runProcess(process.execPath, ['--version'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })).trim());
    let lastLabel;
    const service = createExternalMedia({ runtime, root: path.join(root, 'temp'), auth: { cookies: () => { throw Error('public smoke must not read cookies'); } }, ffmpeg: mediaBinary, progress: event => { if (event.label !== lastLabel) console.log(lastLabel = event.label); } });
    const urls = process.argv.slice(2).filter(value => value.startsWith('https://'));
    for (const url of urls) {
      try {
        const parsed = await service.parse(url);
        const cid = parsed.pages[0].cid;
        const formats = service.formats(parsed.bvid, cid);
        console.log('PARSED', JSON.stringify({ platform: parsed.platform, title: parsed.title, pages: parsed.pages.length, formats }));
        if (process.argv.includes('--download')) {
          const task = createDownloadTask(new AbortController(), root);
          try {
            const selected = formats.video.at(-1);
            const result = await service.download({ bvid: parsed.bvid, cid, qn: selected.id, kind: 'video' }, task);
            const info = await require('../probe').inspectMedia(mediaBinary(), result.file);
            if (!info?.width || !info?.fps) throw Error('downloaded file has no video stream');
            console.log('DOWNLOADED', (await fs.stat(result.file)).size, JSON.stringify(info));
            for (const audioFormat of formats.audio && !process.argv.includes('--video-only') ? ['m4a', 'mp3'] : []) {
              await cleanupDownloadTask(task);
              const audio = await service.download({ bvid: parsed.bvid, cid, kind: 'audio', audioFormat }, task);
              console.log('AUDIO', audioFormat, (await fs.stat(audio.file)).size);
            }
          } finally { await cleanupDownloadTask(task); }
        }
      } catch (error) { console.error('SMOKE_FAIL', url, error.message); process.exitCode = 1; }
    }
    console.log('RUNTIME_STATUS', JSON.stringify(await runtime.status()));
    app.exit(process.exitCode || 0);
  } catch (error) { console.error(error); app.exit(1); }
});

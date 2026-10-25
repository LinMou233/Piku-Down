module.exports = function makeFixture() {
  let installed = false, saved = false, persistent = false, last = {};
  return (name, value, options) => {
    if (name === 'externalState') return { accounts: { x: { saved, persistent }, youtube: { saved: false, persistent: false } }, runtime: { supported: true, installed, version: 'fixture' } };
    if (name === 'externalInstall') { installed = true; return {}; }
    if (name === 'externalImport') { saved = true; persistent = options?.remember === true; last.import = { platform: value, remember: persistent }; return {}; }
    if (name === 'externalRemember') { persistent = options === true; return {}; }
    if (name === 'externalClear') { saved = false; persistent = false; return {}; }
    if (name === 'lastRequest') return last;
    if (name === 'parse') {
      last.parse = { value, options };
      return { platform: value.includes('x.com') ? 'x' : 'youtube', bvid: 'external:fixture', title: '双视频下载测试', owner: '测试作者', pages: [{ cid: 'first', page: 1, part: '第一段' }, { cid: 'second', page: 2, part: '第二段' }] };
    }
    if (name === 'formats') return { video: [{ id: 'http-2176', label: '1080p · 60fps', fps: 60, available: true }], audio: true };
    if (name === 'download') {
      last.download = value;
      return new Promise(resolve => setTimeout(() => resolve({ file: 'V:/WindowsVideos/双视频下载测试.mp4', video: { width: 1920, height: 1080, fps: 60 } }), 150));
    }
    return undefined;
  };
};

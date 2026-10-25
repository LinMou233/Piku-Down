function isVideoCover(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname.endsWith('.hdslb.com') || url.hostname.endsWith('.ytimg.com') || ['pbs.twimg.com', 'video.twimg.com'].includes(url.hostname));
  } catch { return false; }
}

let externalAccounts = {};
function showExternalAccounts(accounts) {
  externalAccounts = accounts;
  for (const platform of ['x', 'youtube']) {
    const state = accounts[platform];
    $(platform + 'AccountState').textContent = state.error || (state.saved ? (state.persistent ? '已导入 Cookie · 已加密保存' : '已导入 Cookie · 仅本次使用') : '未导入 Cookie');
    $(platform + 'Clear').disabled = !state.saved && !state.error;
    $(platform + 'Remember').checked = !!state.persistent;
  }
}
async function refreshExternalState() {
  const state = await bili.externalState();
  showExternalAccounts(state.accounts);
  $('externalRuntimeState').textContent = state.runtime.reason || (state.runtime.installed ? '已就绪 · ' + state.runtime.version : '首次使用时准备 · ' + state.runtime.version);
  $('externalInstall').disabled = !state.runtime.supported || state.runtime.installed;
  $('externalInstall').textContent = state.runtime.installed ? '组件已就绪' : '准备下载组件';
}
async function externalAction(button, action) {
  if (busy) { $('externalStatus').textContent = '请在下载结束后更改登录状态'; return; }
  button.disabled = true;
  $('externalStatus').textContent = '';
  try {
    const message = await action();
    if (message) $('externalStatus').textContent = message;
  } catch (error) { $('externalStatus').textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  finally { button.disabled = false; await refreshExternalState().catch(() => {}); }
}
for (const platform of ['x', 'youtube']) {
  $(platform + 'Import').onclick = () => externalAction($(platform + 'Import'), async () => {
    const result = await bili.externalImport(platform, { remember: $(platform + 'Remember').checked });
    if (result) { resetParseHome(); switchView('settings'); return 'Cookie 已导入，回到解析页选择“使用登录状态”后重新解析。'; }
  });
  $(platform + 'Clear').onclick = () => externalAction($(platform + 'Clear'), async () => {
    await bili.externalClear(platform);
    resetParseHome(); switchView('settings');
    return '已清除该平台在软件中保存的 Cookie';
  });
  $(platform + 'Remember').onchange = () => {
    const remember = $(platform + 'Remember');
    if (busy) {
      remember.checked = !!externalAccounts[platform]?.persistent;
      $('externalStatus').textContent = '请在下载结束后更改 Cookie 保存方式';
      return;
    }
    if (!externalAccounts[platform]?.saved && !externalAccounts[platform]?.persistent) return;
    const value = remember.checked;
    externalAction(remember, async () => {
      await bili.externalRemember(platform, value);
      return value ? 'Cookie 已加密保存到本机，可随时清除' : '已删除本机保存的副本，Cookie 仅在本次使用';
    });
  };
}
$('biliSettingsLogin').onclick = () => externalAction($('biliSettingsLogin'), async () => {
  if ($('login').dataset.logged === 'true') {
    await bili.logout();
    await account();
    return 'B站已退出登录';
  }
  await bili.openLogin();
});
$('externalInstall').onclick = () => externalAction($('externalInstall'), async () => { await bili.externalInstall(); return '下载组件已就绪'; });
$('accessMode').onchange = () => {
  if (busy) return;
  const input = $('url').value;
  resetParseHome();
  $('url').value = input;
  $('accessHint').textContent = $('accessMode').value === 'session' ? 'X、YouTube 将使用设置中保存的登录状态；B站仍使用头像中的账号。' : 'X、YouTube 不会使用登录状态。B站仍使用头像中的账号。';
};
if (typeof bili.externalState === 'function') refreshExternalState().catch(error => { $('externalStatus').textContent = error.message; });
if (bili.legacy || (typeof externalEvents !== 'undefined' && externalEvents.arch !== 'x64')) {
  const label = bili.legacy ? 'Win7 兼容版' : externalEvents.arch === 'ia32' ? 'x86（ia32）版' : 'ARM64 版';
  $('buildNotice').hidden = false;
  $('buildNotice').textContent = label + '：未经对应系统或架构的实机测试。' + (bili.legacy ? '此版本不提供 X 与 YouTube 下载，请使用现代版。' : '如遇问题，请附上系统版本和视频链接。');
}

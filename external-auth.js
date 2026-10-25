const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { UserError } = require('./user-error');

function checkPlatform(platform) {
  if (!['x', 'youtube'].includes(platform)) throw new UserError('不支持的平台');
  return platform;
}
function matchesDomain(domain, platform) {
  const value = domain.replace(/^\./, '').toLowerCase();
  const hosts = platform === 'x' ? ['x.com', 'twitter.com'] : ['youtube.com', 'google.com'];
  return hosts.some(host => value === host || value.endsWith('.' + host));
}
function normalizeCookies(text, platform, now = Date.now() / 1000) {
  checkPlatform(platform);
  if (typeof text !== 'string' || Buffer.byteLength(text) > 2 * 1024 * 1024) throw new UserError('Cookie 文件过大');
  if (!/^# (?:Netscape HTTP Cookie File|HTTP Cookie File)/m.test(text.replace(/^\uFEFF/, ''))) throw new UserError('请选择 Netscape 格式的 cookies.txt');
  const rows = [];
  for (let line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (line.startsWith('#HttpOnly_')) line = line.slice(10);
    if (!line || line.startsWith('#')) continue;
    const fields = line.split('\t');
    if (fields.length !== 7) continue;
    const [domain, subdomains, cookiePath, secure, expiry, name, value] = fields;
    if (!matchesDomain(domain, platform) || !/^(TRUE|FALSE)$/.test(subdomains) || !/^(TRUE|FALSE)$/.test(secure) || !/^\d+$/.test(expiry) || !name || !cookiePath.startsWith('/') || /[\x00-\x1f\x7f]/.test(line.replace(/\t/g, ''))) continue;
    if (Number(expiry) && Number(expiry) <= now) continue;
    rows.push([domain, subdomains, cookiePath, secure, expiry, name, value]);
  }
  if (!rows.length) throw new UserError('文件中没有该平台可用的 Cookie，可能已过期');
  if (platform === 'x' && !rows.some(row => row[5] === 'auth_token')) throw new UserError('没有找到 X 登录状态，请登录后重新导出 Cookie');
  return '# Netscape HTTP Cookie File\n' + rows.map(row => row.join('\t')).join('\n') + '\n';
}

function createExternalAuth({ root, safeStorage, clearLegacyX = async () => {} }) {
  const file = platform => path.join(root, `external-${checkPlatform(platform)}.bin`);
  const sessions = new Map();
  async function record(platform) {
    checkPlatform(platform);
    if (sessions.has(platform)) {
      const cached = sessions.get(platform);
      return { ...cached, text: normalizeCookies(cached.text, platform) };
    }
    let bytes;
    try { bytes = await fs.readFile(file(platform)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!safeStorage.isEncryptionAvailable()) throw new UserError('系统加密服务不可用，暂时无法读取 Cookie');
    try {
      const saved = { text: normalizeCookies(safeStorage.decryptString(bytes), platform), persistent: true };
      sessions.set(platform, saved);
      return saved;
    } catch { throw new UserError('保存的 Cookie 已失效，请重新导入'); }
  }
  async function cookies(platform) { return (await record(platform))?.text || null; }
  async function status() {
    const state = {};
    for (const platform of ['x', 'youtube']) {
      try { const saved = await record(platform); state[platform] = { saved: !!saved, persistent: !!saved?.persistent }; }
      catch {
        let persistent = false;
        try { await fs.access(file(platform)); persistent = true; } catch {}
        state[platform] = { saved: false, persistent, error: 'Cookie 无法读取或已过期，请清除后重新导入' };
      }
    }
    return state;
  }
  async function importCookies(platform, text, { remember = false } = {}) {
    const normalized = normalizeCookies(text, platform);
    remember = remember === true;
    if (remember) {
      if (!safeStorage.isEncryptionAvailable()) throw new UserError('系统加密服务不可用，无法保存 Cookie；可取消记住后仅在本次使用');
      let encrypted;
      try { encrypted = safeStorage.encryptString(normalized); }
      catch { throw new UserError('Cookie 加密失败，未保存到本机'); }
      await fs.mkdir(root, { recursive: true });
      const temporary = file(platform) + '.' + randomUUID() + '.tmp';
      try {
        await fs.writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, file(platform));
      } finally { await fs.rm(temporary, { force: true }); }
    } else await fs.rm(file(platform), { force: true });
    sessions.set(platform, { text: normalized, persistent: !!remember });
  }
  async function setRemembered(platform, remember) {
    checkPlatform(platform);
    if (!remember) {
      let text;
      try { text = await cookies(platform); } catch {}
      await fs.rm(file(platform), { force: true });
      if (text) sessions.set(platform, { text, persistent: false });
      else sessions.delete(platform);
      return;
    }
    const text = await cookies(platform);
    if (!text) throw new UserError('请先导入 Cookie');
    await importCookies(platform, text, { remember: true });
  }
  async function clear(platform) {
    checkPlatform(platform);
    sessions.delete(platform);
    await fs.rm(file(platform), { force: true });
    // Clear credentials left by previews that used an embedded X window.
    if (platform === 'x') await clearLegacyX();
  }
  function clearSession() { sessions.clear(); }
  return { cookies, status, importCookies, setRemembered, clear, clearSession };
}

module.exports = { checkPlatform, matchesDomain, normalizeCookies, createExternalAuth };

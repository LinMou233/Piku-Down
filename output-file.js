const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Node's Windows rename replaces an existing destination. Use flags=0 instead:
// neither MOVEFILE_REPLACE_EXISTING nor MOVEFILE_COPY_ALLOWED is permitted.
// Paths travel as base64 stdin data, never as PowerShell source or shell args.
const windowsBridge = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PikuOutputFile {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool MoveFileExW(string source, string target, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool GetVolumePathNameW(string path, StringBuilder root, uint length);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool GetVolumeInformationW(string root, StringBuilder name, uint nameLength,
    out uint serial, out uint maxLength, out uint flags, StringBuilder format, uint formatLength);
}
'@
  $operation = [Console]::In.ReadLine()
  $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))
  $target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))
  if ($operation -eq 'links') {
    $root = New-Object Text.StringBuilder 32768
    if (-not [PikuOutputFile]::GetVolumePathNameW($source, $root, $root.Capacity)) {
      [Console]::WriteLine('ERR:' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 1
    }
    [uint32]$serial = 0; [uint32]$maxLength = 0; [uint32]$flags = 0
    if (-not [PikuOutputFile]::GetVolumeInformationW($root.ToString(), $null, 0, [ref]$serial, [ref]$maxLength, [ref]$flags, $null, 0)) {
      [Console]::WriteLine('ERR:' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 1
    }
    [Console]::WriteLine('OK:' + [int](($flags -band 0x00400000) -ne 0))
  } elseif ($operation -eq 'move') {
    if (-not [PikuOutputFile]::MoveFileExW($source, $target, 0)) {
      [Console]::WriteLine('ERR:' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 1
    }
    [Console]::WriteLine('OK')
  } else { exit 1 }
} catch { [Console]::WriteLine('BRIDGE_ERROR'); exit 1 }
`;

function windowsFileOperation(operation, source, target = '') {
  if (process.platform !== 'win32') return Promise.reject(Object.assign(
    Error('当前系统缺少安全的不覆盖文件发布方式'), { code: 'ENOTSUP' }));
  return new Promise((resolve, reject) => {
    const command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsBridge], { windowsHide: true, shell: false });
    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-1024); });
    child.stderr.resume();
    child.stdin.on('error', () => {}); // A blocked helper can exit before reading stdin.
    child.once('error', reject);
    // Do not kill this short operation on cancellation: first learn whether it
    // published the file, then register ownership and let task cleanup run.
    child.once('close', code => {
      const result = output.trim();
      if (code === 0 && (operation === 'links' ? /^OK:[01]$/.test(result) : result === 'OK')) {
        resolve(operation === 'links' ? result === 'OK:1' : undefined);
      } else {
        const win32Code = /^ERR:(\d+)$/.exec(result)?.[1];
        const codes = { 2: 'ENOENT', 3: 'ENOENT', 5: 'EACCES', 17: 'EXDEV', 32: 'EBUSY', 50: 'ENOTSUP', 80: 'EEXIST', 112: 'ENOSPC', 183: 'EEXIST' };
        reject(Object.assign(Error('安全文件发布失败' + (win32Code ? `（Windows错误${win32Code}）` : '，Windows辅助程序不可用')), { code: codes[win32Code] || 'EIO', win32Code: Number(win32Code) || undefined }));
      }
    });
    child.stdin.end([operation, Buffer.from(source).toString('base64'), Buffer.from(target).toString('base64'), ''].join('\n'));
  });
}

async function moveOutputAtomically(src, target, onCreated = () => {}, io = fs, signal) {
  signal?.throwIfAborted();
  let staging, support;
  const supportsLinks = () => support ||= (async () => {
    const directory = await io.realpath(path.dirname(target));
    return (io.supportsHardLinks || (dir => windowsFileOperation('links', dir)))(directory);
  })();
  async function canStage(error, source) {
    if (['EXDEV', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) return true;
    // Windows/libuv also reports EISDIR for a regular file on FAT32. Do not
    // disguise a real directory error or an NTFS permission failure as this case.
    if (!['EPERM', 'EISDIR'].includes(error.code)) return false;
    try { return (await io.lstat(source)).isFile() && (await supportsLinks()) === false; }
    catch { return false; } // Failed capability checks must preserve the link error.
  }
  try {
    try { await io.link(src, target); }
    catch (error) {
      if (!await canStage(error, src)) throw error;
      signal?.throwIfAborted();
      staging = await io.mkdtemp(path.join(path.dirname(target), '.bilidown-output-'));
      signal?.throwIfAborted();
      const file = path.join(staging, 'output');
      // Wait for copyFile to settle before cleanup; it cannot be aborted safely.
      await io.copyFile(src, file, constants.COPYFILE_EXCL);
      signal?.throwIfAborted();
      try { await io.link(file, target); }
      catch (error) {
        if (!await canStage(error, file)) throw error;
        signal?.throwIfAborted();
        // Same-volume rename without replacement; never fall back to copying
        // into the final name or to an access()+rename() race.
        await (io.moveNoReplace || ((a, b) => windowsFileOperation('move', path.toNamespacedPath(a), path.toNamespacedPath(b))))(file, target);
      }
    }
    onCreated();
    signal?.throwIfAborted();
    await io.unlink(src);
  } finally {
    if (staging) await io.rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  }
}

module.exports = { moveOutputAtomically };

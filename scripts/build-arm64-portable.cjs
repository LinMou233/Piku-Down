const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getMakeNsisPath } = require(require.resolve('app-builder-lib/out/toolsets/windows', { paths: [require.resolve('electron-builder')] }));

async function buildPortable() {
  const root = path.resolve(__dirname, '..');
  const version = require('../package.json').version;
  const versionParts = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-.*\.(\d+))?$/);
  if (!versionParts) throw Error('Unsupported application version');
  const numericVersion = versionParts.slice(1).map(value => Number(value) || 0).join('.');
  const outputRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'dist');
  const appDir = path.join(outputRoot, 'win-arm64-unpacked');
  const exe = fs.readFileSync(path.join(appDir, 'Piku Down.exe'));
  if (exe.readUInt16LE(exe.readUInt32LE(60) + 4) !== 0xaa64) throw Error('Expected ARM64 application');
  const { path: compiler } = await getMakeNsisPath();
  const output = path.join(outputRoot, `Piku-Down-${version}-arm64.exe`);
  const result = spawnSync(compiler, ['/V2', `/DAPP_VERSION=${version}`, `/DAPP_VERSION_NUM=${numericVersion}`, `/DAPP_DIR=${appDir}`, `/DOUTPUT_FILE=${output}`, `/DICON_FILE=${path.join(root, 'resources/icon.ico')}`, path.join(root, 'build/portable-arm64.nsi')], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`Portable compiler failed: ${result.status}`);
  console.log(`ARM64 portable created: ${output}`);
}
buildPortable().catch(error => { console.error(error); process.exitCode = 1; });

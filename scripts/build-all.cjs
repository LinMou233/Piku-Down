const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outputArg = process.argv.find(value => value.startsWith('--output='))?.slice(9);
const outputRoot = outputArg ? path.resolve(outputArg) : path.join(root, 'dist');
const jobs = [
  ['x64', false], ['ia32', false], ['arm64', false],
  ['ia32', true], ['x64', true]
];
const results = [];
for (const [arch, legacy] of jobs) {
  console.log(`Building ${legacy ? 'Win7 ' : ''}${arch}`);
  const started = new Date().toISOString();
  const child = spawnSync(process.execPath, [path.join(__dirname, 'build-release.cjs'), arch, ...(legacy ? ['--legacy'] : []), ...(outputArg ? ['--output=' + (legacy ? path.join(outputRoot, 'win7') : outputRoot)] : [])], { cwd: root, stdio: 'inherit', windowsHide: true });
  results.push({ arch, legacy, started, success: child.status === 0, error: child.error?.message });
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(path.join(outputRoot, 'build-results.json'), JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(results, null, 2));
if (results.some(result => !result.success)) process.exitCode = 1;

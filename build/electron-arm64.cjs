const base = require('../package.json').build;

module.exports = {
  ...base,
  win: { ...base.win, target: ['nsis', 'zip'], artifactName: 'Piku-Down-${version}-${arch}.zip' },
  nsis: { ...base.nsis, useZip: true, differentialPackage: false },
};

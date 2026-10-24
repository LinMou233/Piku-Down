const base=require('../package.json').build;
module.exports={...base,electronVersion:'22.3.27',directories:{output:'dist/win7'},portable:{...base.portable,artifactName:'Piku-Down-${version}-Win7-${arch}.exe'},nsis:{...base.nsis,artifactName:'Piku-Down-Setup-${version}-Win7-${arch}.exe'}};

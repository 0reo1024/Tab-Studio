const {execFileSync}=require('node:child_process');
const path=require('node:path');
exports.default=async context=>{
  if(context.electronPlatformName!=='darwin')return;
  if(process.platform!=='darwin')throw new Error('Local Mac signing requires macOS');
  const app=path.join(context.appOutDir,'Tab Studio.app');
  execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',app],{stdio:'inherit'});
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app],{stdio:'inherit'});
};

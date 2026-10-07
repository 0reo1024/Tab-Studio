import {packager} from '@electron/packager';
import fs from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),pkg=JSON.parse(await fs.readFile('package.json','utf8'));
if(!/^\d+\.\d+\.\d+$/.test(pkg.version))throw new Error('Invalid release directory');
const stage=path.join(root,'release',pkg.version,'mac-source');
await fs.mkdir(stage,{recursive:true});
for(const name of ['dist','electron','licenses'])await fs.cp(path.join(root,name),path.join(stage,name),{recursive:true});
await fs.writeFile(path.join(stage,'package.json'),JSON.stringify({name:pkg.name,productName:'Tab Studio',version:pkg.version,description:pkg.description,main:pkg.main,author:pkg.author,license:pkg.license},null,2));
for(const arch of ['arm64','x64']){
 const paths=await packager({dir:stage,name:'Tab Studio',platform:'darwin',arch,electronVersion:'41.10.7',appBundleId:pkg.build.appId,appVersion:pkg.version,appCategoryType:'public.app-category.music',extendInfo:{LSMinimumSystemVersion:'12.0'},asar:{unpack:'licenses/**'},prune:false,overwrite:true,out:path.join(root,'release',pkg.version,'mac-bundles')});
 await fs.cp(path.join(root,'licenses'),path.join(paths[0],'Tab Studio.app','Contents','Resources','licenses'),{recursive:true});
 console.log('MAC BUNDLE',arch,paths[0]);
}

from pathlib import Path
import hashlib, json, stat, zipfile

root=Path(__file__).resolve().parents[1]
version=json.loads((root/'package.json').read_text(encoding='utf-8'))['version']
release=root/'release'/version
prefix=f'Tab-Studio-{version}-source'
output=release/f'Tab-Studio-{version}-source.zip'
folders=['src','electron','scripts','tests','public','licenses','packaging','.github']
files=['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','vite.config.ts','index.html','print.html','README.md','LICENSE','.gitignore']
with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
    for file in [root/f for f in files]+[p for f in folders for p in (root/f).rglob('*') if p.is_file() and '__pycache__' not in p.parts]:
        name=file.relative_to(root).as_posix()
        info=zipfile.ZipInfo(prefix+'/'+name);info.create_system=3;info.compress_type=zipfile.ZIP_DEFLATED
        info.external_attr=(stat.S_IFREG|(0o755 if file.suffix in ['.command','.sh'] else 0o644))<<16
        archive.writestr(info,file.read_bytes())
with zipfile.ZipFile(output) as archive:assert archive.testzip() is None
manifest={}
for path in sorted(release.glob('*')):
    if path.is_file() and path.suffix in ['.exe','.zip']:
        digest=hashlib.sha256()
        with path.open('rb') as f:
            while data:=f.read(1024*1024):digest.update(data)
        manifest[path.name]=digest.hexdigest()
(release/'SHA256SUMS.txt').write_text(''.join(f'{digest}  {name}\n' for name,digest in manifest.items()),encoding='utf-8')
print('SOURCE ZIP AND SHA256 VERIFIED:',len(manifest),'release files')

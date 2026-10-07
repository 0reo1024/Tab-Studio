"""Create Mac ZIPs while preserving executable bits and framework symlinks."""
from pathlib import Path
import json, os, plistlib, posixpath, stat, struct, zipfile

root=Path(__file__).resolve().parents[1]
version=json.loads((root/'package.json').read_text(encoding='utf-8'))['version']
release=root/'release'/version

def add_tree(archive, directory, prefix):
    for item in sorted(directory.iterdir()):
        name=prefix+'/'+item.name
        info=zipfile.ZipInfo(name)
        info.create_system=3
        info.compress_type=zipfile.ZIP_DEFLATED
        if item.is_symlink():
            target=os.readlink(item).replace('\\','/')
            assert not target.startswith('/') and ':' not in target, (item,target)
            info.external_attr=(stat.S_IFLNK|0o777)<<16
            archive.writestr(info,target.encode('utf-8'))
        elif item.is_dir():
            info.filename+='/'
            info.external_attr=((stat.S_IFDIR|0o755)<<16)|0x10
            archive.writestr(info,b'')
            add_tree(archive,item,name)
        else:
            with item.open('rb') as f: head=f.read(4)
            executable='/Contents/MacOS/' in name or head in [b'\xcf\xfa\xed\xfe',b'\xfe\xed\xfa\xcf',b'\xca\xfe\xba\xbe'] or head.startswith(b'#!')
            info.external_attr=(stat.S_IFREG|(0o755 if executable else 0o644))<<16
            with item.open('rb') as src,archive.open(info,'w') as dest:
                while block:=src.read(1024*1024):dest.write(block)

for arch,cpu in [('arm64',0x0100000c),('x64',0x01000007)]:
    app=release/'mac-bundles'/f'Tab Studio-darwin-{arch}'/'Tab Studio.app'
    plist=plistlib.loads((app/'Contents/Info.plist').read_bytes())
    assert plist['CFBundleIdentifier']=='jp.tabstudio.desktop'
    assert plist['CFBundleShortVersionString']==version
    binary=app/'Contents/MacOS'/plist['CFBundleExecutable']
    with binary.open('rb') as f:header=f.read(8)
    assert header[:4]==b'\xcf\xfa\xed\xfe' and struct.unpack('<I',header[4:])[0]==cpu
    output=release/f'Tab-Studio-{version}-mac-{arch}-Install.zip'
    with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
        add_tree(archive,app,'Tab Studio.app')
        for filename in ['Install Tab Studio.command','README-ja.md']:
            info=zipfile.ZipInfo(filename);info.create_system=3;info.compress_type=zipfile.ZIP_DEFLATED
            info.external_attr=(stat.S_IFREG|(0o755 if filename.endswith('.command') else 0o644))<<16
            archive.writestr(info,(root/'packaging/mac'/filename).read_bytes().replace(b'\r\n',b'\n'))
    with zipfile.ZipFile(output) as archive:
        assert archive.testzip() is None
        assert stat.S_ISLNK(archive.getinfo('Tab Studio.app/Contents/Frameworks/Electron Framework.framework/Versions/Current').external_attr>>16)
        assert archive.getinfo('Install Tab Studio.command').external_attr>>16 & 0o111
        names={i.filename.rstrip('/') for i in archive.infolist()}
        links={i.filename:archive.read(i).decode('utf-8') for i in archive.infolist() if stat.S_ISLNK(i.external_attr>>16)}
        for link in links:
            resolved=link
            for _ in range(20):
                parts=resolved.split('/');changed=False
                for i in range(1,len(parts)+1):
                    prefix='/'.join(parts[:i])
                    if prefix in links:
                        resolved=posixpath.normpath(posixpath.join(posixpath.dirname(prefix),links[prefix],*parts[i:]))
                        changed=True;break
                if not changed:break
            assert resolved in names, ('broken archive symlink',link,resolved)
    print(f'MAC ZIP VERIFIED: {arch} / version {version} / Mach-O CPU / symlinks / executable bits / CRC: {output.name}',flush=True)

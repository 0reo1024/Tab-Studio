"""Prepare isolated Python + VST3/AU/SFZ runtime for the current OS/architecture."""
import hashlib, io, json, pathlib, platform, shutil, subprocess, sys, tarfile, urllib.request, zipfile
root=pathlib.Path(__file__).resolve().parent.parent
runtime=root/'native'/'runtime'
runtime.mkdir(parents=True,exist_ok=True)
if sys.platform=='win32':
    if not (runtime/'python.exe').exists():
        data=urllib.request.urlopen('https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip',timeout=60).read()
        with zipfile.ZipFile(io.BytesIO(data)) as archive: archive.extractall(runtime)
    (runtime/'python311._pth').write_text('python311.zip\n.\nsite-packages\nimport site\n',encoding='utf-8')
    python=runtime/'python.exe';libname='sfizz.dll'
elif sys.platform=='darwin':
    if not (runtime/'bin/python3').exists():
        arch='aarch64' if platform.machine()=='arm64' else 'x86_64'
        url=f'https://github.com/astral-sh/python-build-standalone/releases/download/20240415/cpython-3.11.9%2B20240415-{arch}-apple-darwin-install_only.tar.gz'
        data=urllib.request.urlopen(url,timeout=60).read()
        expected=urllib.request.urlopen(url+'.sha256',timeout=30).read().decode().split()[0]
        assert hashlib.sha256(data).hexdigest()==expected
        with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as archive:
            archive.extractall(runtime.parent/'python-stage',filter='data')
        shutil.copytree(runtime.parent/'python-stage/python',runtime,dirs_exist_ok=True)
    python=runtime/'bin/python3';libname='libsfizz.dylib'
else: raise RuntimeError('Windows/macOS runtime only')
if not (runtime/'site-packages'/'pedalboard').exists():
    subprocess.check_call([sys.executable,'-m','pip','install','--target',str(runtime/'site-packages'),'pedalboard==0.9.26','numpy==2.4.6'])
if not (runtime/libname).exists():
    kind='win64.zip' if sys.platform=='win32' else 'macos.tar.gz'
    url='https://github.com/sfztools/sfizz/releases/download/1.2.3/sfizz-1.2.3-'+kind
    data=urllib.request.urlopen(url,timeout=60).read()
    if sys.platform=='win32':
        with zipfile.ZipFile(io.BytesIO(data)) as archive: (runtime/libname).write_bytes(archive.read('bin/Release/sfizz.dll'))
    else:
        with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as archive:
            entry=next(m for m in archive.getmembers() if m.isfile() and 'libsfizz' in m.name and m.name.endswith('.dylib'))
            (runtime/libname).write_bytes(archive.extractfile(entry).read())
for package in ['pedalboard-0.9.26','numpy-2.4.6']:
    shutil.copytree(runtime/'site-packages'/(package+'.dist-info')/'licenses',root/'licenses'/package,dirs_exist_ok=True)
standard=root/'native/soundfonts/UI_Standard_Guitar/Programs/01-Standard Guitar KSOP.sfz'
if standard.exists(): (root/'native/soundfonts.json').write_text(json.dumps({'standardGuitar':str(standard.resolve())}),encoding='utf-8')
print('Isolated Python 3.11.9 + Pedalboard 0.9.26 + sfizz 1.2.3 runtime ready')

"""Deduplicate old release binaries into a verified, reversible local archive."""
from pathlib import Path
import hashlib, json, os, re, stat, zipfile

root = Path(__file__).resolve().parents[1]
release = root / 'release'
versions = sorted((p for p in release.iterdir() if re.fullmatch(r'0\.3\.\d+', p.name) and p.is_dir()), key=lambda p: int(p.name.split('.')[-1]))
if not versions:
    raise SystemExit('No 0.3.x releases to archive')
output = release / 'archive-0.3.x'
output.mkdir(exist_ok=True)
archive_path = output / 'Tab-Studio-0.3.x-history.zip'
if archive_path.exists():
    raise SystemExit('Archive already exists; refusing to overwrite it')
partial = archive_path.with_suffix('.zip.writing')
manifest = {'format': 'TabStudioReleaseArchive', 'version': 1, 'chunkSize': 1048576, 'versions': [p.name for p in versions], 'entries': [], 'originalBytes': 0}
chunks = set()

def walk_error(error):
    raise error

def record(p, archive):
    metadata = p.lstat()
    item = {'path': p.relative_to(release).as_posix(), 'mode': stat.S_IMODE(metadata.st_mode), 'mtimeNs': metadata.st_mtime_ns}
    if p.is_symlink():
        target = os.readlink(p).replace('\\', '/')
        if Path(target).is_absolute() or ':' in target:
            raise ValueError('Nonportable symlink: ' + str(p))
        resolved = (p.parent / target).resolve()
        if not resolved.is_relative_to(release.resolve()):
            raise ValueError('Symlink outside release: ' + str(p))
        item.update(type='link', target=target, directory=bool(metadata.st_file_attributes & stat.FILE_ATTRIBUTE_DIRECTORY))
    elif metadata.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        raise ValueError('Unsupported reparse point: ' + str(p))
    elif p.is_dir():
        item['type'] = 'directory'
    elif p.is_file():
        item.update(type='file', chunks=[], size=metadata.st_size)
        digest = hashlib.sha256()
        with p.open('rb') as source:
            while block := source.read(manifest['chunkSize']):
                digest.update(block)
                key = hashlib.sha256(block).hexdigest()
                item['chunks'].append(key)
                if key not in chunks:
                    archive.writestr('chunks/' + key, block)
                    chunks.add(key)
        item['sha256'] = digest.hexdigest()
        if p.stat().st_size != metadata.st_size or p.stat().st_mtime_ns != metadata.st_mtime_ns:
            raise ValueError('File changed while archiving: ' + str(p))
        manifest['originalBytes'] += metadata.st_size
    else:
        raise ValueError('Unsupported file: ' + str(p))
    manifest['entries'].append(item)

with zipfile.ZipFile(partial, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=3, allowZip64=True) as archive:
    for version in versions:
        if version.is_symlink() or not version.resolve().is_relative_to(release.resolve()):
            raise ValueError('Unsafe version directory')
        record(version, archive)
        for base, dirs, files in os.walk(version, followlinks=False, onerror=walk_error):
            for name in sorted(dirs[:]):
                p = Path(base) / name
                record(p, archive)
                if p.is_symlink():
                    dirs.remove(name)
            for name in sorted(files):
                record(Path(base) / name, archive)
        print(f'ARCHIVED {version.name}: {len(chunks)} unique chunks', flush=True)
    archive.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, separators=(',', ':')).encode())

with zipfile.ZipFile(partial) as archive:
    loaded = json.loads(archive.read('manifest.json'))
    assert loaded == manifest
    for i, key in enumerate(sorted(chunks)):
        block = archive.read('chunks/' + key)  # ZIP CRC is also checked here.
        assert hashlib.sha256(block).hexdigest() == key
        if i and i % 500 == 0:
            print(f'VERIFIED {i}/{len(chunks)} chunks', flush=True)
    entries = {e['path']: e for e in manifest['entries']}
    for e in manifest['entries']:
        if e['type'] == 'file':
            assert all(key in chunks for key in e['chunks'])
        assert e['path'].split('/')[0] in manifest['versions']
    for version in versions:
        for base, dirs, files in os.walk(version, followlinks=False, onerror=walk_error):
            for name in dirs[:]:
                p = Path(base) / name
                assert p.relative_to(release).as_posix() in entries
                if p.is_symlink():
                    dirs.remove(name)
            for name in files:
                p = Path(base) / name
                e = entries[p.relative_to(release).as_posix()]
                if not p.is_symlink():
                    assert p.stat().st_size == e['size'] and p.stat().st_mtime_ns == e['mtimeNs']
partial.rename(archive_path)
report = {'versions': manifest['versions'], 'files': sum(e['type'] == 'file' for e in manifest['entries']), 'uniqueChunks': len(chunks), 'originalBytes': manifest['originalBytes'], 'archiveBytes': archive_path.stat().st_size, 'archive': str(archive_path)}
(output / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print('ARCHIVE VERIFIED: ' + json.dumps(report), flush=True)

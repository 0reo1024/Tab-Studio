"""Restore one version from the local deduplicated release archive."""
from pathlib import Path
import argparse, hashlib, json, os, re, stat, uuid, zipfile

parser = argparse.ArgumentParser()
parser.add_argument('version', nargs='?')
parser.add_argument('--archive', type=Path)
parser.add_argument('--interactive', action='store_true')
args = parser.parse_args()
base = Path(__file__).resolve().parent
archive_path = args.archive or (base / 'Tab-Studio-0.3.x-history.zip' if (base / 'Tab-Studio-0.3.x-history.zip').exists() else base.parent / 'release/archive-0.3.x/Tab-Studio-0.3.x-history.zip')
release = archive_path.resolve().parent.parent
with zipfile.ZipFile(archive_path) as archive:
    manifest = json.loads(archive.read('manifest.json'))
    assert manifest['format'] == 'TabStudioReleaseArchive' and manifest['version'] == 1
    if not args.version:
        print('Available versions: ' + ', '.join(manifest['versions']))
        if args.interactive:
            args.version = input('Version to restore (example: 0.3.37): ').strip()
        else:
            raise SystemExit(0)
    if not re.fullmatch(r'0\.3\.\d+', args.version) or args.version not in manifest['versions']:
        raise SystemExit('Version is not in this archive')
    destination = release / 'restored' / args.version
    if destination.exists():
        raise SystemExit('Destination exists; refusing to overwrite it: ' + str(destination))
    stage = destination.with_name('.' + args.version + '-restoring-' + uuid.uuid4().hex)
    stage.mkdir(parents=True)
    records = [e for e in manifest['entries'] if e['path'].split('/')[0] == args.version]
    def target(e):
        relative = Path(*e['path'].split('/')[1:])
        p = stage / relative
        if not p.resolve().is_relative_to(stage.resolve()):
            raise ValueError('Unsafe archive path')
        return p
    for e in records:
        p = target(e)
        if e['type'] == 'directory':
            p.mkdir(parents=True, exist_ok=True)
        elif e['type'] == 'file':
            p.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            with p.open('xb') as dest:
                for key in e['chunks']:
                    block = archive.read('chunks/' + key)
                    assert hashlib.sha256(block).hexdigest() == key
                    digest.update(block)
                    dest.write(block)
            assert p.stat().st_size == e['size'] and digest.hexdigest() == e['sha256']
            os.chmod(p, e['mode'])
            os.utime(p, ns=(e['mtimeNs'], e['mtimeNs']))
    # Restore links only after all ordinary files have been validated.
    for e in records:
        if e['type'] == 'link':
            p = target(e)
            if Path(e['target']).is_absolute() or ':' in e['target'] or not (p.parent / e['target']).resolve().is_relative_to(stage.resolve()):
                raise ValueError('Unsafe archive symlink')
            os.symlink(e['target'], p, target_is_directory=e['directory'])
    for e in reversed(records):
        if e['type'] == 'directory':
            p = target(e)
            os.chmod(p, e['mode'])
            os.utime(p, ns=(e['mtimeNs'], e['mtimeNs']))
    stage.rename(destination)
print('RESTORED AND SHA256 VERIFIED: ' + str(destination))

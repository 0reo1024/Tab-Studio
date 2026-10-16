"""Register Karoryfer Fashionbass as the Bass DI.

Usage: python scripts/install-fashionbass.py [Karoryfer.Fashionbass.v1.001.zip]
Without an argument it downloads the CC0 release from GitHub (sfzinstruments). The library
is a direct-recorded Killer KB-Simmony (neck pickup, onboard EQ flat; five velocity layers,
three round robins) mapped at pitch, with string release samples and muted-string noises.
The Tab Studio program includes its regular mapping; the native engine adds the palm-mute,
slap, pop and dead-note voicings from the same samples. Everything stays in native/soundfonts.
"""
import io, json, pathlib, sys, urllib.request, zipfile

URL = 'https://github.com/sfzinstruments/karoryfer.fashionbass/releases/download/v1.001/Karoryfer.Fashionbass.v1.001.zip'
root = pathlib.Path(__file__).resolve().parent.parent
target = root / 'native/soundfonts'
folder = target / 'Fashionbass'
if not (folder / 'fashionbass.sfz').is_file():
    data = pathlib.Path(sys.argv[1]).read_bytes() if len(sys.argv) > 1 else urllib.request.urlopen(URL).read()
    archive = zipfile.ZipFile(io.BytesIO(data))
    # The release zips its files under one top folder ("Fashionbass"); keep them directly in
    # native/soundfonts/Fashionbass.
    files = [i for i in archive.infolist() if not i.is_dir()]
    tops = {pathlib.PurePosixPath(i.filename).parts[0] for i in files}
    strip = len(tops) == 1 and all(len(pathlib.PurePosixPath(i.filename).parts) > 1 for i in files)
    for info in files:
        parts = pathlib.PurePosixPath(info.filename).parts
        out = folder.joinpath(*(parts[1:] if strip else parts))
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(archive.read(info))
program = folder / 'Tab Studio Bass DI Fashion.sfz'
program.write_text('// Tab Studio: Bass DI (Fashion) = Karoryfer Fashionbass (CC0), regular mapping, at pitch.\n'
                   '#include "fashionbass.sfz"\n', encoding='utf-8')
manifest = root / 'native/soundfonts.json'
data = json.loads(manifest.read_text(encoding='utf-8')) if manifest.exists() else {}
data.update(fashionBass=str(program.resolve()))
manifest.write_text(json.dumps(data), encoding='utf-8')
print('Registered Bass DI (Fashion):', program)

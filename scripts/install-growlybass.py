"""Register Karoryfer Growlybass as a third bass DI: Bass DI (Growly).

Usage: python scripts/install-growlybass.py [Karoryfer.Growlybass.v1.002.zip]
Without an argument it downloads the CC0 release from GitHub (sfzinstruments). The
library is a direct-recorded Squier Jazz bass mapped an octave above the sounding pitch
(key 40 plays E1), so a Tab Studio program includes its "dirty" mapping (sustains with
release samples) shifted to sound as written. Everything stays in native/soundfonts.
"""
import io, json, pathlib, sys, urllib.request, zipfile

URL = 'https://github.com/sfzinstruments/karoryfer.growlybass/releases/download/v1.002/Karoryfer.Growlybass.v1.002.zip'
root = pathlib.Path(__file__).resolve().parent.parent
target = root / 'native/soundfonts'
folder = target / 'Growlybass'
if not (folder / 'growlybass_dirty.sfz').is_file():
    data = pathlib.Path(sys.argv[1]).read_bytes() if len(sys.argv) > 1 else urllib.request.urlopen(URL).read()
    zipfile.ZipFile(io.BytesIO(data)).extractall(target)
program = folder / 'Tab Studio Bass DI Growly.sfz'
# sfizz applies note_offset to the regions' keys: -12 makes key 28 play the library's "e2" (E1).
program.write_text('// Tab Studio: Bass DI (Growly) = Karoryfer Growlybass (CC0), dirty mapping, as written.\n'
                   '<control>\nnote_offset=-12\n#include "growlybass_dirty.sfz"\n', encoding='utf-8')
manifest = root / 'native/soundfonts.json'
data = json.loads(manifest.read_text(encoding='utf-8')) if manifest.exists() else {}
data.update(growlyBass=str(program.resolve()))
manifest.write_text(json.dumps(data), encoding='utf-8')
print('Registered Bass DI (Growly):', program)

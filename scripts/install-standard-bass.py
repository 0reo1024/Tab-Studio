"""Register local bass DI programs: Bass DI (pick), Bass DI (finger) and Slap.

Usage: python scripts/install-standard-bass.py [Ui_Standard_Bass_V2.rar | folder] [Fender Jazz Bass.zip]
Bass DI (pick) is Standard Bass V2's KSOP program. Bass DI (finger) plays the Fender JB
SoundFont (converted to SFZ by convert-sf2-to-sfz.py) from a Tab Studio program placed
beside KSOP, so finger and pick share the library's Slap program.
Neither library may be redistributed: everything stays in native/soundfonts (git-ignored).
"""
import importlib.util, json, pathlib, re, shutil, subprocess, sys

root = pathlib.Path(__file__).resolve().parent.parent
target = root / 'native/soundfonts'
seven = shutil.which('7z') or r'C:\Program Files\7-Zip\7z.exe'
source = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else target / 'Ui_Standard_Bass_V2'
if source.suffix.lower() == '.rar':
    subprocess.run([seven, 'x', '-y', f'-o{target}', str(source)], check=True, stdout=subprocess.DEVNULL)
    source = target / 'Ui_Standard_Bass_V2'
ksop = source / 'Standard_Bass_V2_KSOP' / '#Standard_Bass_V2_KSOP.sfz'
slap = source / 'Standard_Bass_V2_Slap' / '#Standard_Bass_V2_Slap.sfz'
for file in (ksop, slap):
    if not file.is_file(): raise SystemExit(f'Not found: {file}')

fender = target / 'Fender_Jazz_Bass'
if len(sys.argv) > 2:
    subprocess.run([seven, 'x', '-y', f'-o{fender / "sf2"}', sys.argv[2]], check=True, stdout=subprocess.DEVNULL)
font = fender / 'sf2' / 'Fender JB.sf2'
if not font.is_file(): raise SystemExit(f'Not found: {font} (pass Fender Jazz Bass.zip)')
spec = importlib.util.spec_from_file_location('sf2', root / 'scripts/convert-sf2-to-sfz.py')
sf2 = importlib.util.module_from_spec(spec); spec.loader.exec_module(sf2)
program, _, _ = sf2.convert(font, fender / 'FenderJB')
# The finger program sits beside KSOP (that is how the SFZ hosts find the Slap program)
# and reaches the Fender samples through a relative sample path.
samples = '../../Fender_Jazz_Bass/FenderJB/samples/'
regions = [line for line in program.read_text(encoding='utf-8').splitlines() if line.startswith('<region>')]
# The Fender JB samples stop at key 62; a 24-fret G string reaches 67. Stretch the top
# samples over those keys (at most 7 semitones of pitch shift) instead of leaving them silent.
top = max(int(re.search(r'hikey=(\d+)', line)[1]) for line in regions)
regions = [re.sub(r'hikey=\d+', 'hikey=67', line) if f'hikey={top} ' in line + ' ' else line for line in regions]
finger = ksop.with_name('Tab Studio Bass DI Finger.sfz')
finger.write_text('// Tab Studio: Bass DI (finger) = Fender JB (GoldMidiSF2.com), local use only.\n'
                  f'<control>\ndefault_path={samples}\n\n' + '\n'.join(regions) + '\n', encoding='utf-8')

manifest = root / 'native/soundfonts.json'
data = json.loads(manifest.read_text(encoding='utf-8')) if manifest.exists() else {}
data.update(standardBassPick=str(ksop.resolve()), standardBassFinger=str(finger.resolve()))
manifest.write_text(json.dumps(data), encoding='utf-8')
print('Registered Bass DI (pick): Standard Bass V2 KSOP, Bass DI (finger): Fender JB, slap from', slap.parent.name)

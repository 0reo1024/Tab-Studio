"""Register the FlameStudios Les Paul Direct In guitars as Guitar DI (LP Neck) / (LP Bridge).

Usage: python scripts/install-lespaul-di.py [neck.sf2|neck.7z bridge.sf2|bridge.7z]
Without arguments it downloads the GPL SoundFonts (Gary Campion, 2008) from the
gdm-2112/electric-guitar-soundfonts mirror and unpacks them with 7-Zip. Each SoundFont's
"Standard" instrument (one sample per key 40-84 in four velocity layers, the softest a palm
mute) becomes WAV files and a Tab Studio program: sustains in three layers over the full
velocity range (keyswitch 24) and the mutes (keyswitch 27; Tab Studio sends 23/27/28 there),
the end samples stretched to keys 28-100. Everything stays in native/soundfonts.
"""
import json, pathlib, struct, subprocess, sys, tempfile, urllib.request, wave

MIRROR = 'https://media.githubusercontent.com/media/gdm-2112/electric-guitar-soundfonts/main/SF2/FlameStudios/'
SOURCES = {
    'Neck': 'FS%20Gibson%20Les%20Paul%20Electric%20Guitar%20Neck%20Pickup%20Direct%20In/FS%20Gibson%20Les%20Paul%20Electric%20Guitar%20Neck%20Pickup%20Direct%20In',
    'Bridge': 'FS_Gibson_Les_Paul_Electric_Guitar_Bridge_Pickup_Direct_In/FS%20Gibson%20Les%20Paul%20Electric%20Guitar%20Bridge%20Pickup%20Direct%20In',
}
SEVEN_ZIP = pathlib.Path(r'C:\Program Files\7-Zip\7z.exe')
LOWEST, HIGHEST = 28, 100
root = pathlib.Path(__file__).resolve().parent.parent
target = root / 'native/soundfonts'


def chunks(data, start, end):
    while start < end:
        cid, size = data[start:start + 4].decode('latin1'), struct.unpack('<I', data[start + 4:start + 8])[0]
        yield cid, start + 8, size
        start += 8 + size + (size & 1)


def records(raw, size, fmt):
    return [struct.unpack(fmt, raw[i:i + size]) for i in range(0, len(raw), size)]


def name(raw):
    return raw.split(b'\0')[0].decode('latin1').strip()


def read_sf2(data):
    """The "Standard" instrument's zones as (key, lovel, hivel, sample name, PCM bytes, root, release s)."""
    pdta, smpl = {}, b''
    for cid, at, size in chunks(data, 12, len(data)):
        if cid != 'LIST':
            continue
        kind = data[at:at + 4]
        for sub, at2, size2 in chunks(data, at + 4, at + size):
            if kind == b'pdta':
                pdta[sub] = data[at2:at2 + size2]
            elif kind == b'sdta' and sub == 'smpl':
                smpl = data[at2:at2 + size2]
    inst = records(pdta['inst'], 22, '<20sH')
    ibag = records(pdta['ibag'], 4, '<HH')
    igen = records(pdta['igen'], 4, '<Hh')
    shdr = records(pdta['shdr'], 46, '<20sIIIIIBbHH')
    index = next(i for i, ins in enumerate(inst[:-1]) if name(ins[0]) == 'Standard')
    zones = []
    for bag in range(inst[index][1], inst[index + 1][1]):
        gens = dict(igen[ibag[bag][0]:ibag[bag + 1][0]])
        if 53 not in gens:
            continue
        sample = shdr[gens[53]]
        key, vel = gens[43] & 255, gens.get(44, 127 << 8)
        root_key = gens.get(58, sample[6])
        release = 2 ** (gens.get(38, -12000) / 1200)
        assert sample[7] == 0 and gens.get(51, 0) == 0 and gens.get(52, 0) == 0, 'tuned samples are not expected'
        zones.append((key, vel & 255, (vel >> 8) & 255, name(sample[0]), smpl[2 * sample[1]:2 * sample[2]], root_key, sample[5], release))
    return zones


def source(kind, given):
    if given is not None and given.suffix.lower() == '.sf2':
        return given.read_bytes()
    archive = given.read_bytes() if given is not None else urllib.request.urlopen(MIRROR + SOURCES[kind] + '.7z').read()
    if not SEVEN_ZIP.is_file():
        sys.exit(f'7-Zip is needed to unpack the SoundFont ({SEVEN_ZIP}); or pass the .sf2 files.')
    with tempfile.TemporaryDirectory() as tmp:
        packed = pathlib.Path(tmp) / 'source.7z'
        packed.write_bytes(archive)
        subprocess.run([str(SEVEN_ZIP), 'x', '-y', f'-o{tmp}', str(packed)], check=True, stdout=subprocess.DEVNULL)
        return next(pathlib.Path(tmp).glob('*.sf2')).read_bytes()


def install(kind, given):
    folder = target / f'FlameStudios_LesPaul_{kind}'
    program = folder / f'Tab Studio Guitar DI LP {kind}.sfz'
    zones = read_sf2(source(kind, given))
    (folder / 'Samples').mkdir(parents=True, exist_ok=True)
    keys = sorted({z[0] for z in zones})
    lines = [f'// Tab Studio: Guitar DI (LP {kind}) = FlameStudios Gibson Les Paul {kind} Pickup Direct In',
             '// (GPL, Gary Campion 2008), its Standard instrument; see scripts/install-lespaul-di.py.',
             '<global> bend_up=1600 bend_down=-1600 sw_lokey=20 sw_hikey=32 sw_default=24']
    for switch, layers in ((24, ('Low', 'Med', 'High')), (27, ('Muted',))):
        for key, lovel, hivel, sample, pcm, root_key, rate, release in sorted(zones):
            layer = next((l for l in layers if sample.lower().startswith(f'normg') and l.lower() in sample.lower()), None)
            if layer is None:
                continue
            file = sample.replace(' ', '_')
            wav = folder / 'Samples' / f'{file}.wav'
            if not wav.exists():
                with wave.open(str(wav), 'wb') as out:
                    out.setnchannels(1)
                    out.setsampwidth(2)
                    out.setframerate(rate)
                    out.writeframes(pcm)
            # The mute layer covers every velocity; the softest sustain layer reaches down to 1.
            lovel, hivel = (1, 127) if switch == 27 else ((1 if layer == 'Low' else lovel), hivel)
            lokey = LOWEST if key == keys[0] else key
            hikey = HIGHEST if key == keys[-1] else key
            # lokey/hikey start their own lines: Tab Studio keeps a string's regions by them (and
            # only those, so each region carries its keyswitch instead of a <group> header).
            lines.append(f'<region> sample=Samples\\{file}.wav pitch_keycenter={root_key} sw_last={switch}\nlokey={lokey}\nhikey={hikey}\n'
                         f'lovel={lovel} hivel={hivel} ampeg_release={release:.3f}')
    program.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    # The samples are GPL: their license travels with them.
    for notice in ('license.txt', 'copying'):
        if not (folder / notice).exists():
            url = 'https://raw.githubusercontent.com/gdm-2112/electric-guitar-soundfonts/main/SF2/FlameStudios/'
            (folder / notice).write_bytes(urllib.request.urlopen(url + SOURCES[kind].split('/')[0] + '/' + notice).read())
    return program


given = [pathlib.Path(a) for a in sys.argv[1:3]]
manifest = root / 'native/soundfonts.json'
data = json.loads(manifest.read_text(encoding='utf-8')) if manifest.exists() else {}
for i, kind in enumerate(('Neck', 'Bridge')):
    program = install(kind, given[i] if i < len(given) else None)
    data[f'lesPaul{kind}'] = str(program.resolve())
    print(f'Registered Guitar DI (LP {kind}):', program)
manifest.write_text(json.dumps(data), encoding='utf-8')

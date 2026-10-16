"""Register Bernhard Trummer's Gibson Les Paul as Guitar DI (Trummer LP Neck) / (Trummer LP Bridge).

Usage: python scripts/install-trummer-lp.py [Gibson Les Paul.sf2 | its .zip]
Without an argument it downloads the SoundFont (CC BY-SA 4.0, 2020; Les Paul Standard 2001,
D'Addario EXL115 tuned a half step down) from the author's Google Drive link on the Polyphone
forum. Every string was recorded at frets 0-13 in seven picking strengths, both pickups at once:
the left channel is the neck pickup, the right the bridge. Each pickup becomes WAV files and
Tab Studio programs, one per string preference: "... string<N>.sfz" plays each key on string N
(1 = low E) where frets 0-13 reach it, else on the nearest string that does, else stretched from
the end samples (keys 28-100). Tab Studio loads string N's program for notes on string N (lanes
above 6 use 6) and the main program, which prefers the low E, for notes without a string. The
seven strengths spread over velocities 1-127; palm, fret and up-stroke mutes (keyswitch 27) play
the same samples damped. Samples longer than 12 s are cut there with a fade. The converted
library stays CC BY-SA 4.0 (the author's readme travels with it). Everything stays in native/soundfonts.
"""
import json, math, pathlib, statistics, struct, sys, tempfile, urllib.request, wave, zipfile

URL = 'https://drive.usercontent.google.com/download?id=1T8PKbbf2EVlLefttJqUb3Y94sXUWrv43&export=download&confirm=t'
LOWEST, HIGHEST, FRETS, LONGEST, FADE = 28, 100, 13, 12.0, 1.5
root = pathlib.Path(__file__).resolve().parent.parent
folder = root / 'native/soundfonts/Trummer_LesPaul'


def chunks(handle, start, end):
    while start < end:
        handle.seek(start)
        head = handle.read(8)
        cid, size = head[:4].decode('latin1'), struct.unpack('<I', head[4:])[0]
        yield cid, start + 8, size
        start += 8 + size + (size & 1)


def records(raw, size, fmt):
    return [struct.unpack(fmt, raw[i:i + size]) for i in range(0, len(raw), size)]


def name(raw):
    return raw.split(b'\0')[0].decode('latin1').strip()


def read_sf2(path):
    """Per (string 1-6, fret): [(strength, left sample, right sample)] and the sample table."""
    handle = open(path, 'rb')
    handle.seek(4)
    total = struct.unpack('<I', handle.read(4))[0] + 8
    pdta, smpl = {}, None
    for cid, at, size in chunks(handle, 12, total):
        if cid != 'LIST':
            continue
        handle.seek(at)
        kind = handle.read(4)
        for sub, at2, size2 in chunks(handle, at + 4, at + size):
            if kind == b'pdta':
                handle.seek(at2)
                pdta[sub] = handle.read(size2)
            elif kind == b'sdta' and sub == 'smpl':
                smpl = at2
    inst = records(pdta['inst'], 22, '<20sH')
    ibag = records(pdta['ibag'], 4, '<HH')
    igen = records(pdta['igen'], 4, '<Hh')
    shdr = records(pdta['shdr'], 46, '<20sIIIIIBbHH')
    notes = {}
    for i, ins in enumerate(inst[:-1]):
        string, _, fret = name(ins[0]).split('_')
        layers = {}
        for bag in range(ins[1], inst[i + 1][1]):
            gens = dict(igen[ibag[bag][0]:ibag[bag + 1][0]])
            if 53 not in gens:
                continue
            sample = shdr[gens[53]]
            # Sample names end in the averaged peak level, then L (neck) or R (bridge).
            label = name(sample[0])
            layers.setdefault(int(label.split('_')[3][:-1]), {})[label[-1]] = sample
        notes[(int(string), int(fret))] = [(peak, side['L'], side['R']) for peak, side in sorted(layers.items())]
    return handle, smpl, notes


def write_wav(handle, smpl, sample, target):
    if target.exists():
        return
    start, end, rate = sample[1], sample[2], sample[5]
    end = min(end, start + int(LONGEST * rate))
    handle.seek(smpl + 2 * start)
    pcm = handle.read(2 * (end - start))
    if end - start == int(LONGEST * rate):
        values = list(struct.unpack(f'<{end - start}h', pcm))
        fade = int(FADE * rate)
        for i in range(fade):
            values[-fade + i] = int(values[-fade + i] * (1 - i / fade))
        pcm = struct.pack(f'<{len(values)}h', *values)
    with wave.open(str(target), 'wb') as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(pcm)


def string_levels(notes, pickup):
    """Per string, the dB that brings it to the pickup's median: the RMS over 0.34 s of each
    fret's fifth strength (what velocity 79 plays), median per string. The bridge pickup fell
    11 dB from the low E to the high e; the neck pickup's D string stood 3 dB out."""
    levels = {}
    for (string, fret), layers in notes.items():
        sample = layers[min(4, len(layers) - 1)][1 if pickup == 'Neck' else 2]
        with wave.open(str(folder / 'Samples' / pickup / f'{name(sample[0])}.wav'), 'rb') as w:
            frames = w.readframes(int(0.34 * w.getframerate()))
        values = struct.unpack(f'<{len(frames) // 2}h', frames)
        levels.setdefault(string, []).append(10 * math.log10(sum(v * v for v in values) / len(values) / 32768 ** 2))
    medians = {string: statistics.median(v) for string, v in levels.items()}
    overall = statistics.median([x for v in levels.values() for x in v])
    return {string: round(overall - m, 1) for string, m in medians.items()}


def program(notes, opens, prefer, pickup, volumes):
    """The SFZ text for one pickup preferring string `prefer` (1 = low E)."""
    lines = [f'// Tab Studio: Guitar DI (Trummer LP {pickup}) = Bernhard Trummer, Gibson Les Paul (CC BY-SA 4.0),',
             f'// the {pickup.lower()} pickup; keys prefer string {prefer}. See scripts/install-trummer-lp.py.',
             '<global> bend_up=1600 bend_down=-1600 sw_lokey=20 sw_hikey=32 sw_default=24 ampeg_release=0.3']
    for key in range(LOWEST, HIGHEST + 1):
        covering = [s for s in opens if opens[s] <= key <= opens[s] + FRETS]
        if covering:
            string = min(covering, key=lambda s: (abs(s - prefer), s))
            fret = key - opens[string]
        elif key < opens[1]:
            string, fret = 1, 0
        else:
            string, fret = 6, FRETS
        layers = notes[(string, fret)]
        for i, (peak, left, right) in enumerate(layers):
            sample = left if pickup == 'Neck' else right
            lovel, hivel = 1 + 127 * i // len(layers), 127 * (i + 1) // len(layers)
            file = f'Samples\\{pickup}\\{name(sample[0])}.wav'
            center = opens[string] + fret
            for switch, damp in ((24, ''), (27, ' ampeg_decay=0.25 ampeg_sustain=4 ampeg_release=0.08 fil_type=lpf_2p cutoff=1400')):
                # lokey/hikey start their own lines: Tab Studio keeps a string's regions by them.
                lines.append(f'<region> sample={file} pitch_keycenter={center} sw_last={switch} lovel={lovel} hivel={hivel} volume={volumes[string]}{damp}\n'
                             f'lokey={key}\nhikey={key}')
    return '\n'.join(lines) + '\n'


def source():
    given = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if given is not None and given.suffix.lower() == '.sf2':
        return given, None
    tmp = tempfile.TemporaryDirectory()
    archive = given or pathlib.Path(tmp.name) / 'lp.zip'
    if given is None:
        print('Downloading the SoundFont (about 920 MB)...')
        urllib.request.urlretrieve(URL, archive)
    with zipfile.ZipFile(archive) as z:
        z.extractall(tmp.name)
    return next(pathlib.Path(tmp.name).rglob('*.sf2')), tmp


sf2, tmp = source()
handle, smpl, notes = read_sf2(sf2)
# The open strings sound a half step low (E is D#): their pitch is the open sample's.
opens = {string: notes[(string, 0)][0][1][6] for string in range(1, 7)}
assert opens == {1: 39, 2: 44, 3: 49, 4: 54, 5: 58, 6: 63}, opens
manifest = root / 'native/soundfonts.json'
data = json.loads(manifest.read_text(encoding='utf-8')) if manifest.exists() else {}
for pickup, side in (('Neck', 1), ('Bridge', 2)):
    (folder / 'Samples' / pickup).mkdir(parents=True, exist_ok=True)
    for layers in notes.values():
        for layer in layers:
            write_wav(handle, smpl, layer[side], folder / 'Samples' / pickup / f'{name(layer[side][0])}.wav')
    volumes = string_levels(notes, pickup)
    print(pickup, 'string levels (dB):', volumes)
    main = folder / f'Tab Studio Guitar DI Trummer LP {pickup}.sfz'
    main.write_text(program(notes, opens, 1, pickup, volumes), encoding='utf-8')
    for prefer in range(1, 7):
        (folder / f'Tab Studio Guitar DI Trummer LP {pickup} string{prefer}.sfz').write_text(program(notes, opens, prefer, pickup, volumes), encoding='utf-8')
    data[f'trummerLp{pickup}'] = str(main.resolve())
    print(f'Registered Guitar DI (Trummer LP {pickup}):', main)
readme = sf2.parent / 'readme.txt'
if readme.exists():
    (folder / 'readme.txt').write_bytes(readme.read_bytes())
(folder / 'LICENSE.txt').write_text('Gibson Les Paul SoundFont by Bernhard Trummer, licensed CC BY-SA 4.0\n'
                                    '(https://creativecommons.org/licenses/by-sa/4.0/). Converted to WAV/SFZ for Tab Studio\n'
                                    '(split by pickup, long samples shortened); the conversion is shared under the same license.\n', encoding='utf-8')
manifest.write_text(json.dumps(data), encoding='utf-8')

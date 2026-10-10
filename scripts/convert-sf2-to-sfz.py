"""Convert a SoundFont 2 (.sf2) file into an SFZ program with WAV samples, so the SFZ
hosts (sfizz) can play it. Covers what single-instrument fonts use: key/velocity
ranges, root key and tuning, loops, attenuation, pan, volume envelope and filter.

Usage: python scripts/convert-sf2-to-sfz.py <font.sf2> <output folder>
Writes <output folder>/<preset name>.sfz and <output folder>/samples/*.wav.
The converted files stay on this computer (the fonts' licences forbid redistribution).
"""
import math, pathlib, re, struct, sys, wave

def chunks(data, offset, end):
    while offset + 8 <= end:
        cid, size = data[offset:offset + 4], struct.unpack('<I', data[offset + 4:offset + 8])[0]
        yield cid, offset + 8, size
        offset += 8 + size + (size & 1)

def read(path):
    data = pathlib.Path(path).read_bytes()
    if data[:4] != b'RIFF' or data[8:12] != b'sfbk': raise SystemExit('Not a SoundFont 2 file: ' + str(path))
    parts = {}
    for cid, offset, size in chunks(data, 12, len(data)):
        for sub, o, s in chunks(data, offset + 4, offset + size): parts[sub] = data[o:o + s]
    return parts

def records(blob, size, fmt):
    return [struct.unpack(fmt, blob[i:i + size]) for i in range(0, len(blob) - size + 1, size)]

def name(raw): return raw.split(b'\0')[0].decode('latin1').strip()

RANGES = (43, 44)  # keyRange, velRange: (lo, hi) bytes

def zones(bags, gens, first, last):
    """Generator dicts for bags first..last-1 (ranges as (lo, hi), others signed)."""
    result = []
    for b in range(first, last):
        zone = {}
        for oper, amount in gens[bags[b][0]:bags[b + 1][0]]:
            zone[oper] = (amount & 0xFF, amount >> 8) if oper in RANGES else struct.unpack('<h', struct.pack('<H', amount))[0]
        result.append(zone)
    return result

def split_global(zone_list, terminal):
    """SF2: a first zone without the terminal generator holds defaults for the others."""
    if zone_list and terminal not in zone_list[0]: return zone_list[0], zone_list[1:]
    return {}, zone_list

def intersect(a, b): return (max(a[0], b[0]), min(a[1], b[1]))
def seconds(timecents): return 0.0 if timecents <= -12000 else round(2 ** (timecents / 1200), 4)

def convert(source, target):
    parts = read(source)
    target = pathlib.Path(target); (target / 'samples').mkdir(parents=True, exist_ok=True)
    pcm = parts[b'smpl']
    phdr = [(name(r[0]), r[1], r[2], r[3]) for r in records(parts[b'phdr'], 38, '<20sHHHIII')]
    pbag = records(parts[b'pbag'], 4, '<HH'); pgen = records(parts[b'pgen'], 4, '<HH')
    inst = [(name(r[0]), r[1]) for r in records(parts[b'inst'], 22, '<20sH')]
    ibag = records(parts[b'ibag'], 4, '<HH'); igen = records(parts[b'igen'], 4, '<HH')
    shdr = [(name(r[0]),) + r[1:] for r in records(parts[b'shdr'], 46, '<20sIIIIIBbHH')]
    preset_name, program = phdr[0][0], phdr[0][1]
    written, lines = {}, [f'// {preset_name} (program {program}) converted from {pathlib.Path(source).name} by Tab Studio.', '<control>', 'default_path=samples/', '']
    pzones = zones(pbag, pgen, phdr[0][3], phdr[1][3])
    pglobal, pzones = split_global(pzones, 41)
    for pz in pzones:
        p = {**pglobal, **pz}
        index = p[41]
        izones = zones(ibag, igen, inst[index][1], inst[index + 1][1])
        iglobal, izones = split_global(izones, 53)
        for iz in izones:
            z = {**iglobal, **iz}
            sample_name, start, end, loop_start, loop_end, rate, root, correction, _link, kind = shdr[z[53]]
            if kind & 0x8000: continue  # ROM samples are not in the file
            start += z.get(0, 0) + 32768 * z.get(4, 0); end += z.get(1, 0) + 32768 * z.get(12, 0)
            loop_start += z.get(2, 0) + 32768 * z.get(45, 0); loop_end += z.get(3, 0) + 32768 * z.get(50, 0)
            key = (start, end, rate)
            if key not in written:
                file = re.sub(r'[^A-Za-z0-9_-]+', '_', sample_name) or 'sample'
                file = f'{len(written):03d}_{file}.wav'
                with wave.open(str(target / 'samples' / file), 'wb') as w:
                    w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(pcm[start * 2:end * 2])
                written[key] = file
            keys = intersect(z.get(43, (0, 127)), p.get(43, (0, 127)))
            vels = intersect(z.get(44, (0, 127)), p.get(44, (0, 127)))
            if keys[0] > keys[1] or vels[0] > vels[1]: continue
            # Instrument values plus the preset's offsets (SF2 adds preset-level generators).
            add = lambda g, d=0: z.get(g, d) + p.get(g, 0)
            root_key = z.get(58, -1)
            if root_key < 0: root_key = root
            region = [f'<region> sample={written[key]}', f'lokey={keys[0]} hikey={keys[1]} lovel={vels[0]} hivel={vels[1]}', f'pitch_keycenter={root_key}']
            tune = correction + add(52) + 100 * add(51)
            if tune: region.append(f'tune={tune}')
            if z.get(56, 100) != 100: region.append(f'pitch_keytrack={z[56]}')
            attenuation = add(48)
            if attenuation: region.append(f'volume={-attenuation * 0.04:.2f}')  # E-mu convention: 0.4 x centibels
            if add(17): region.append(f'pan={max(-100, min(100, add(17) / 5)):.1f}')
            mode = z.get(54, 0) & 3
            if mode in (1, 3):
                region.append(f'loop_mode={"loop_continuous" if mode == 1 else "loop_sustain"} loop_start={loop_start - start} loop_end={loop_end - start - 1}')
            env = [(34, 'ampeg_attack'), (35, 'ampeg_hold'), (36, 'ampeg_decay'), (38, 'ampeg_release'), (33, 'ampeg_delay')]
            for gen, opcode in env:
                if gen in z or gen in p: region.append(f'{opcode}={seconds(add(gen, -12000))}')
            if 37 in z or 37 in p: region.append(f'ampeg_sustain={round(100 * 10 ** (-max(0, add(37)) / 200), 2)}')
            cutoff = add(8, 13500)
            if cutoff < 13500:
                region.append(f'fil_type=lpf_2p cutoff={round(8.176 * 2 ** (cutoff / 1200), 1)} resonance={add(9) / 10:.1f}')
            if z.get(57): region.append(f'group={z[57]} off_by={z[57]}')
            lines.append(' '.join(region))
    out = target / (re.sub(r'[^A-Za-z0-9 _-]+', '_', preset_name) + '.sfz')
    out.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return out, len(lines) - 4, len(written)

if __name__ == '__main__':
    if len(sys.argv) != 3: raise SystemExit(__doc__)
    file, regions, samples = convert(sys.argv[1], sys.argv[2])
    print(f'{file}: {regions} regions, {samples} samples')

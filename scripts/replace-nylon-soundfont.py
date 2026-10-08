"""Build the bundled GM bank with the user-supplied classical guitar at program 24.

Keep the original sample encodings: compressed sample positions are byte offsets,
whereas PCM positions are measured in 16-bit samples. alphaTab resolves the last
preset for a bank/program, so the appended classical preset replaces Nylon only.
"""
import pathlib
import struct

ROOT = pathlib.Path(__file__).resolve().parents[1] / 'public/alphatab/soundfont'


def chunks(data, start=0):
    result = {}
    while start + 8 <= len(data):
        tag, length = struct.unpack_from('<4sI', data, start)
        result[tag] = data[start + 8:start + 8 + length]
        start += 8 + length
        # The supplied SF3 omits RIFF padding. Accept both encodings.
        if length % 2 and data[start:start + 1] == b'\0':
            start += 1
    return result


def read(file):
    data = file.read_bytes()
    assert data[:4] == b'RIFF' and data[8:12] == b'sfbk'
    lists = {}
    start = 12
    while start + 8 <= len(data):
        tag, length = struct.unpack_from('<4sI', data, start)
        assert tag == b'LIST'
        payload = data[start + 8:start + 8 + length]
        lists[payload[:4]] = chunks(payload, 4)
        start += 8 + length
        if length % 2 and data[start:start + 1] == b'\0':
            start += 1
    return lists


def chunk(tag, data):
    # Include padding in the size for alphaTab's RIFF reader and PCM alignment.
    data += b'\0' * (len(data) % 2)
    return tag + struct.pack('<I', len(data)) + data


def build():
    base = read(ROOT / 'GeneralUser-GS.sf2')
    guitar = read(ROOT / 'classical_guitar_1a.sf3')
    a, b = base[b'pdta'], guitar[b'pdta']
    sizes = {b'phdr':38, b'pbag':4, b'pmod':10, b'pgen':4,
             b'inst':22, b'ibag':4, b'imod':10, b'igen':4, b'shdr':46}
    offsets = {tag:len(a[tag]) // size - 1 for tag, size in sizes.items()}
    smpl = base[b'sdta'][b'smpl']
    assert len(smpl) % 2 == 0
    result = {}
    for tag, size in sizes.items():
        tail = bytearray(b[tag])
        for i in range(0, len(tail), size):
            def shift(at, amount):
                struct.pack_into('<H', tail, i + at, struct.unpack_from('<H', tail, i + at)[0] + amount)
            if tag == b'phdr':
                struct.pack_into('<HH', tail, i + 20, 24, 0)
                shift(24, offsets[b'pbag'])
            elif tag in (b'pbag', b'ibag'):
                shift(0, offsets[b'pgen' if tag == b'pbag' else b'igen'])
                shift(2, offsets[b'pmod' if tag == b'pbag' else b'imod'])
            elif tag == b'inst':
                shift(20, offsets[b'ibag'])
            elif tag in (b'pgen', b'igen'):
                operator = struct.unpack_from('<H', tail, i)[0]
                if tag == b'pgen' and operator == 41:
                    shift(2, offsets[b'inst'])
                elif tag == b'igen' and operator == 53:
                    shift(2, offsets[b'shdr'])
            elif tag == b'shdr':
                sample_type = struct.unpack_from('<H', tail, i + 44)[0]
                for field in (20, 24):
                    value = struct.unpack_from('<I', tail, i + field)[0]
                    struct.pack_into('<I', tail, i + field, value + (len(smpl) if sample_type & 16 else len(smpl) // 2))
                if sample_type & 6:
                    shift(42, offsets[b'shdr'])
        result[tag] = a[tag][:-size] + tail
    info = dict(base[b'INFO'])
    info[b'ifil'] = struct.pack('<HH', 3, 0)
    info[b'INAM'] = b'Tab Studio GM + CG_Kazuma\0'
    payload = b'sfbk' + chunk(b'LIST', b'INFO' + b''.join(chunk(k, v) for k, v in info.items()))
    payload += chunk(b'LIST', b'sdta' + chunk(b'smpl', smpl + guitar[b'sdta'][b'smpl']))
    payload += chunk(b'LIST', b'pdta' + b''.join(chunk(k, result[k]) for k in sizes))
    destination = ROOT / 'GeneralUser-Classical.sf3'
    destination.write_bytes(b'RIFF' + struct.pack('<I', len(payload)) + payload)
    print(f'Created {destination.name}: {destination.stat().st_size} bytes')


if __name__ == '__main__':
    build()

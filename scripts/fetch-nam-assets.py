"""Pinned upstream NAM assets. Run explicitly; never downloads at app startup."""
import base64, hashlib, io, json, pathlib, tarfile, urllib.request

root = pathlib.Path(__file__).resolve().parent.parent
dest = root / 'public' / 'nam'
dest.mkdir(parents=True, exist_ok=True)
url = 'https://registry.npmjs.org/neural-amp-modeler-wasm/-/neural-amp-modeler-wasm-2.0.1.tgz'
payload = urllib.request.urlopen(url, timeout=60).read()
expected = '3Pki618H0qQrERQR5KclUO5QWSJLgETi5be8uLjCNQeVHTsKS0lfR4hFHrPqSIghRI0nIiqWhGClvM9yYz5mtw=='
assert base64.b64encode(hashlib.sha512(payload).digest()).decode() == expected
with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
    for name in ['nam-worklet.js', 'nam-engine.wasm']:
        (dest / name).write_bytes(archive.extractfile('package/dist/engine/' + name).read())
base = 'https://raw.githubusercontent.com/tone-3000/neural-amp-modeler-wasm/main/'
# Pin the repository revision as well as the package version for reproducible models.
revision = 'a6c895049771bacc40c74dfa19369c2ebf75cdb1'
base = f'https://raw.githubusercontent.com/tone-3000/neural-amp-modeler-wasm/{revision}/'
for remote, local in [('ui/public/models/deluxe-a2.nam', dest / 'deluxe-a2.nam'),
                      ('LICENSE', root / 'licenses' / 'NAM-wasm-MIT.txt'),
                      ('ui/public/models/README.md', dest / 'MODELS.md')]:
    local.parent.mkdir(parents=True, exist_ok=True)
    local.write_bytes(urllib.request.urlopen(base + remote, timeout=60).read())
(dest / 'SOURCE.json').write_text(json.dumps({'package': url, 'integrity': 'sha512-' + expected, 'modelRevision': revision, 'repository': 'https://github.com/tone-3000/neural-amp-modeler-wasm'}, indent=2), encoding='utf-8')
print('NAM 2.0.1 engine and A2 model prepared')

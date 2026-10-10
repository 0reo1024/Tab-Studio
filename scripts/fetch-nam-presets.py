"""Install user-selected TONE3000 A2 models locally; do not redistribute these files."""
import hashlib, json, pathlib, urllib.request

root=pathlib.Path(__file__).resolve().parent.parent
sources=json.loads((root/'public/nam/TONE3000-SOURCES.json').read_text(encoding='utf-8'))
folder=root/'native/nam-models';folder.mkdir(parents=True,exist_ok=True)
manifest={}
for key,source in sources.items():
    file=folder/source['modelUrl'].rsplit('/',1)[1]
    data=file.read_bytes() if file.exists() else urllib.request.urlopen(source['modelUrl'],timeout=60).read()
    if hashlib.sha256(data).hexdigest()!=source['sha256']:raise ValueError('Unexpected model checksum: '+key)
    model=json.loads(data)
    if model.get('architecture')!='SlimmableContainer':raise ValueError('Not an A2 model: '+key)
    file.write_bytes(data);manifest[key]=str(file.resolve());print('Installed',key)
(root/'native/nam-models.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')

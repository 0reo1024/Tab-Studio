"""Bundle pinned corresponding source and third-party notices for audio libraries."""
import hashlib, io, json, pathlib, re, tarfile, urllib.request
root=pathlib.Path(__file__).resolve().parent.parent
dest=root/'licenses'/'audio-source';dest.mkdir(parents=True,exist_ok=True)
records=[];seen=set()
def fetch(repo,ref):
    if (repo,ref) in seen: return
    seen.add((repo,ref))
    url=f'https://codeload.github.com/{repo}/tar.gz/{ref}'
    file=dest/(repo.replace('/','-')+'-'+ref+'.tar.gz')
    if not file.exists(): file.write_bytes(urllib.request.urlopen(url,timeout=60).read())
    payload=file.read_bytes();records.append({'repository':repo,'revision':ref,'source':url,'file':file.name,'sha256':hashlib.sha256(payload).hexdigest()})
    with tarfile.open(fileobj=io.BytesIO(payload),mode='r:gz') as archive:
        modules=next((m for m in archive.getmembers() if m.name.count('/')==1 and m.name.endswith('/.gitmodules')),None)
        if not modules: return
        text=archive.extractfile(modules).read().decode()
        links=re.findall(r'path\s*=\s*([^\n]+)\s+url\s*=\s*([^\n]+)',text)
        tree=json.load(urllib.request.urlopen(f'https://api.github.com/repos/{repo}/git/trees/{ref}?recursive=1',timeout=60))['tree']
        for path,url in links:
            item=next((t for t in tree if t['path']==path.strip() and t['type']=='commit'),None)
            match=re.search(r'github.com[:/]([^\s]+?)(?:\.git)?$',url.strip())
            if item and match: fetch(match.group(1),item['sha'])
            elif item and 'gitlab.com/libeigen/eigen' in url:
                revision=item['sha'];source=f'https://gitlab.com/libeigen/eigen/-/archive/{revision}/eigen-{revision}.tar.gz';target=dest/f'eigen-{revision}.tar.gz'
                if not target.exists(): target.write_bytes(urllib.request.urlopen(source,timeout=60).read())
                records.append({'repository':'libeigen/eigen','revision':revision,'source':source,'file':target.name,'sha256':hashlib.sha256(target.read_bytes()).hexdigest()})
for repo,ref in [('spotify/pedalboard','v0.9.26'),('tone-3000/neural-amp-modeler-wasm','a6c895049771bacc40c74dfa19369c2ebf75cdb1')]: fetch(repo,ref)
(dest/'SOURCES.json').write_text(json.dumps(records,indent=2),encoding='utf-8')
print('Pinned audio source archives prepared:',len(records))

"""Restore the pinned bundled GM SoundFont and its license."""
import hashlib, json, pathlib, urllib.request
root=pathlib.Path(__file__).resolve().parent.parent
folder=root/'public/alphatab/soundfont'
source=json.loads((folder/'GeneralUser-GS-SOURCE.json').read_text(encoding='utf-8'))
base=f"https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/{source['revision']}/"
data=urllib.request.urlopen(base+source['path'],timeout=60).read()
assert hashlib.sha256(data).hexdigest()==source['sha256']
(folder/'GeneralUser-GS.sf2').write_bytes(data)
(root/'licenses/GeneralUser-GS-LICENSE.txt').write_bytes(urllib.request.urlopen(base+'documentation/LICENSE.txt',timeout=30).read())
print('GeneralUser GS 2.0.3 restored')

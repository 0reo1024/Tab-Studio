from pathlib import Path
from urllib.request import urlretrieve
from concurrent.futures import ThreadPoolExecutor
root=Path('tests/fixtures');root.mkdir(parents=True,exist_ok=True)
files=['guitarpro3/notes.gp3','guitarpro4/notes.gp4','guitarpro5/notes.gp5','guitarpro6/notes.gpx','guitarpro7/notes.gp']
def fetch(name):
 p=root/name.split('/')[-1];urlretrieve('https://raw.githubusercontent.com/CoderLine/alphaTab/develop/packages/alphatab/test-data/'+name,p);return (p.name,p.stat().st_size)
with ThreadPoolExecutor(max_workers=5) as pool:print(list(pool.map(fetch,files)))
urlretrieve('https://codeload.github.com/helge17/tuxguitar/zip/refs/heads/master','licenses/tuxguitar-corresponding-source.zip')

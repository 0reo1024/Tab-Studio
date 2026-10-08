import json,pathlib,subprocess,base64,sys
sys.path.insert(0,str(pathlib.Path('native/runtime/site-packages').resolve()))
import numpy as np
file=next(pathlib.Path('native/soundfonts').glob('*/Programs/01-Standard Guitar KSOP.sfz'))
p=subprocess.Popen(['native/runtime/python.exe','native/sfz-host.py',str(file)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
def ask(d):
 p.stdin.write(json.dumps(d)+'\n');p.stdin.flush()
 while True:
  line=p.stdout.readline()
  if line.startswith('TABSTUDIO:'):
   r=json.loads(line[10:]);assert not r.get('error'),r;return r
while True:
 line=p.stdout.readline()
 if line.startswith('TABSTUDIO:'):print(line.strip());break
cases=json.loads(pathlib.Path('test-results/sfz-events.json').read_text())
def freq(pcm,t):
 x=pcm[int(t*44100):int((t+.13)*44100),0];n=65536;a=np.abs(np.fft.rfft(x*np.hanning(len(x)),n));bins=np.fft.rfftfreq(n,1/44100);ix=np.argmax(a[(bins>100)&(bins<1200)])+np.where(bins>100)[0][0];return round(bins[ix],2)
for name,events in cases.items():
 ask({'id':1,'cmd':'reset'});chunks=[]
 for start in range(0,88200,2048):
  frames=min(2048,88200-start);ev=[]
  for e in events:
   sample=max(0,round(e['tick']/960*.5*44100))
   if start<=sample<start+frames:ev.append(dict(e,delay=sample-start))
  r=ask({'id':2,'cmd':'render','frames':frames,'rate':44100,'events':ev});chunks.append(np.frombuffer(base64.b64decode(r['pcm']),dtype='<f4').reshape(-1,2))
 pcm=np.concatenate(chunks);observed=freq(pcm,.18);print(name,'freq',observed,freq(pcm,.6),freq(pcm,1.1),'peak',np.max(np.abs(pcm)),flush=True)
 if name in ['grace','slide-in']:target=554.365
 elif name=='slide':target=554.365;observed=freq(pcm,.6)
 elif name=='harmonic':target=659.255
 elif name=='pinch':target=987.767
 else:target=554.365;observed=freq(pcm,.6)
 assert min(abs(observed/target/harmonic-1) for harmonic in [1,2,3,4])<.025,(name,observed,target)
 if name=='bend':assert min(abs(freq(pcm,.18)/146.832/h-1) for h in [1,2,3,4])<.025,'unbent string changed pitch'
 assert min(abs(freq(pcm,1.1)/440/h-1) for h in [1,2,3,4])<.025,'bend leaked into the following note'
 assert np.max(np.abs(pcm))>.001,name
p.stdin.close()
try:p.wait(timeout=15)
except subprocess.TimeoutExpired:p.terminate();p.wait()
print('SFZ ARTICULATIONS PASSED')

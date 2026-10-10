"""SFZ host: separate Standard Guitar strings preserve independent note bends."""
import base64, ctypes as c, json, pathlib, sys, re
sys.path.insert(0,str(pathlib.Path(__file__).parent/'runtime'/'site-packages'))
import numpy as np
root=pathlib.Path(__file__).parent/'runtime'
lib=c.CDLL(str(root/('sfizz.dll' if sys.platform=='win32' else 'libsfizz.dylib')))
ptr=c.c_void_p;fp=c.POINTER(c.c_float)
def bind(name,args,result=None):
    fn=getattr(lib,name);fn.argtypes=args;fn.restype=result;return fn
create=bind('sfizz_create_synth',[],ptr);free=bind('sfizz_free',[ptr])
load=bind('sfizz_load_file',[ptr,c.c_char_p],c.c_bool)
load_text=bind('sfizz_load_string',[ptr,c.c_char_p,c.c_char_p],c.c_bool)
rate=bind('sfizz_set_sample_rate',[ptr,c.c_float]);block=bind('sfizz_set_samples_per_block',[ptr,c.c_int])
preload=bind('sfizz_set_preload_size',[ptr,c.c_uint])
on=bind('sfizz_send_note_on',[ptr,c.c_int,c.c_int,c.c_int]);off=bind('sfizz_send_note_off',[ptr,c.c_int,c.c_int,c.c_int])
cc=bind('sfizz_send_cc',[ptr,c.c_int,c.c_int,c.c_int]);bend=bind('sfizz_send_hd_pitch_wheel',[ptr,c.c_int,c.c_float])
render=bind('sfizz_render_block',[ptr,c.POINTER(fp),c.c_int,c.c_int]);reset=bind('sfizz_all_sound_off',[ptr])
regions=bind('sfizz_get_num_regions',[ptr],c.c_int)
file=pathlib.Path(sys.argv[1]).resolve();standard='standard guitar' in file.name.lower();samplers={};current_rate=44100;controls={};text=None
# Standard Bass V2 (pick or Tab Studio's finger voicing): one lane plus the library's Slap
# program on lane SLAP; keyswitch 100+n picks slap articulation n (24 thump, 26 pop, ...).
SLAP=100;slap_file=file.parent.parent/'Standard_Bass_V2_Slap'/'#Standard_Bass_V2_Slap.sfz'
bass=file.parent.name.lower()=='standard_bass_v2_ksop' and slap_file.is_file();slap_keys=set()
# Only the library's own KSOP program has keyswitches; Tab Studio's finger program (Fender JB) does not.
bass_switches=bass and file.name.lower().startswith('#standard_bass')
# Bass sits lower than guitar at the same level: pick +6 dB, finger (Fender JB) and slap +3 dB.
BASS_GAIN={'pick':2.0,'finger':1.41,'slap':1.41}
# Standard Bass V2's own programs (pick KSOP and Slap) are mapped an octave above the
# sounding pitch: key 40 plays E1 and nothing exists below key 35. The finger program
# (Fender JB) is mapped at pitch. Notes are sent an octave up to sound as written.
def sounding(lane,key):return min(127,key+12) if bass and (lane==SLAP or bass_switches) else key
requested_lanes=json.loads(sys.argv[2]) if len(sys.argv)>2 else list(range(1,7))
if not isinstance(requested_lanes,list) or len(requested_lanes)>12 or any(type(lane) is not int or lane<1 or lane>12 for lane in requested_lanes):
    raise ValueError('Invalid sampler lanes')
requested_pitches=json.loads(sys.argv[3]) if len(sys.argv)>3 else {}
def check_pitches(value):
    if not isinstance(value,dict) or len(value)>12:raise ValueError('Invalid sampler pitches')
    for keys in value.values():
        if not isinstance(keys,list) or len(keys)>128 or any(type(key) is not int or key<0 or key>127 for key in keys):raise ValueError('Invalid sampler pitches')
    return {int(lane):set(keys) for lane,keys in value.items() if str(lane).isdigit() and 1<=int(lane)<=12}
requested_pitches=check_pitches(requested_pitches)
def midi_key(value):
    if value.lstrip('-').isdigit():return int(value)
    match=re.fullmatch(r'([a-g])([b#]?)(-?\d+)',value.lower())
    if not match:return None
    return 12*(int(match[3])+1)+{'c':0,'d':2,'e':4,'f':5,'g':7,'a':9,'b':11}[match[1]]+({'#':1,'b':-1}.get(match[2],0))
def restrict_patch(patch,keys):
    if not keys:return patch
    parts=patch.split('<region>');kept=[]
    for region in parts[1:]:
        low=re.search(r'(?m)^\s*lokey\s*=\s*(\S+)',region);high=re.search(r'(?m)^\s*hikey\s*=\s*(\S+)',region)
        lo=midi_key(low[1]) if low else None;hi=midi_key(high[1]) if high else None
        if lo is None or hi is None or any(lo<=key<=hi for key in keys):kept.append('<region>'+region)
    return parts[0]+''.join(kept) if kept else ''
patch_texts=[]
if standard:
    directory=file.parent/'Individual Patchs'/'Standard_Guitar_KSOP'
    patches=['Sus_Down','Sus_Up','Mute_Down','Mute_Up','Mute_Fret','Natural_Harmonics','Picking_Harmonics','Legato','Release1_Sus_Down','Release1_Sus_Up','Release1_Mute_Down','Release1_Mute_Up','Release1_Legato']
    text='<control> set_cc20=0 set_cc21=95 set_cc22=127 set_cc23=0 set_cc24=13 set_cc25=108 set_cc48=0\n'
    for name in patches:
        p=directory/(name+'.sfz')
        if not p.exists():continue
        patch=p.read_text(encoding='utf-8-sig').replace('sw_hikey=g#7','sw_hikey=32')
        if name=='Natural_Harmonics':
            # Original keys select physical harmonic positions, not their sounding MIDI pitch.
            # Map the supplied samples to measured fundamentals; extend nearest regions.
            keys=[52,57,59,62,64,67,69,71,74,76,78,79,83,88]
            patch=patch.split('<region>')[0]
            for i,key in enumerate(keys):
                low=35 if i==0 else (keys[i-1]+key)//2+1
                high=108 if i==len(keys)-1 else (key+keys[i+1])//2
                patch+=f'<region> sample=..\\Samples\\Natural Harmonics\\{i+1}.flac lokey={low} hikey={high} pitch_keycenter={key}\n'
        elif name=='Picking_Harmonics':
            def transpose(match):
                token=match[2].lower();m=re.fullmatch(r'([a-g])([b#]?)(-?\d+)',token)
                key=12*(int(m[3])+1)+{'c':0,'d':2,'e':4,'f':5,'g':7,'a':9,'b':11}[m[1]]+({'#':1,'b':-1}.get(m[2],0))
                return match[1]+str(min(127,key+24))
            patch=re.sub(r'(pitch_keycenter=|lokey=|hikey=)([a-g][b#]?-?\d+)',transpose,patch)
            patch=patch.replace('lokey=59','lokey=35')
        patch_texts.append(patch.replace('<global>','<global> bend_up=1600 bend_down=-1600')+'\n')
def lane_text(lane,keys):
    if not standard:return None
    body=''.join(restrict_patch(patch,keys) for patch in patch_texts)
    if '<region>' not in body:body=''.join(patch_texts)
    return (text+body).encode('utf-8')
def make(lane):
    # Six independent strings must not each preload the full multi-gigabyte library.
    # Keep the attacks resident and let sfizz stream the remaining sample data.
    synth=create();block(synth,4096);rate(synth,current_rate);preload(synth,8192)
    keys=requested_pitches.get(lane)
    source=lane_text(lane,keys)
    ok=load(synth,str(slap_file).encode()) if lane==SLAP else load_text(synth,str(file).encode(),source) if source else load(synth,str(file).encode())
    if not ok or regions(synth)<1:free(synth);raise ValueError('SFZに再生できる音色がありません。')
    # Full channel volume until the song says otherwise, as the GM synth (playback sends CC7 127).
    cc(synth,0,7,127)
    for key,value in controls.items():cc(synth,0,key,value)
    gain=(BASS_GAIN['slap'] if lane==SLAP else BASS_GAIN['pick'] if bass_switches else BASS_GAIN['finger']) if bass else 1.
    state={'synth':synth,'key':None,'midiKey':None,'pitch':0.,'wheel':0.,'pending':{},'gain':gain};old=samplers.get(lane);samplers[lane]=state
    if old:free(old['synth'])
    return state
def pitch(state,delay):
    bend(state['synth'],delay,max(-1.,min(1.,state['pitch']+state['wheel'])))
def reply(request,**value):print('TABSTUDIO:'+json.dumps({'id':request,**value}),flush=True)
try:
    for lane in (requested_lanes or [1]) if standard else [0,SLAP] if bass else [0]:make(lane)
    reply(0,ready=True,name=file.stem)
    for line in sys.stdin:
        request=None
        try:
            d=json.loads(line);request=d['id']
            if d['cmd']=='reset':
                for state in samplers.values():reset(state['synth']);state.update(key=None,midiKey=None,pitch=0.,wheel=0.,pending={})
                reply(request,reset=True);continue
            if d['cmd']=='prepare':
                if not standard:
                    reply(request,lanes=[0]);continue
                lanes=d['lanes']
                if not isinstance(lanes,list) or len(lanes)>12 or any(type(lane) is not int or lane<1 or lane>12 for lane in lanes):raise ValueError('Invalid sampler lanes')
                pitches=check_pitches(d.get('pitches',{}))
                for lane in lanes:
                    if lane not in pitches and lane in requested_pitches:
                        requested_pitches.pop(lane);make(lane)
                    elif lane in pitches and requested_pitches.get(lane)!=pitches[lane]:
                        requested_pitches[lane]=pitches[lane];make(lane)
                    elif lane not in samplers:make(lane)
                reply(request,lanes=sorted(samplers));continue
            if d['cmd']!='render':raise ValueError('Unknown sampler command')
            frames=int(d['frames']);sample_rate=float(d['rate'])
            if not 0<frames<=4096 or not 22050<=sample_rate<=192000:raise ValueError('Invalid render block')
            if current_rate!=sample_rate:
                current_rate=sample_rate
                for state in samplers.values():rate(state['synth'],sample_rate)
            for e in d.get('events',[]):
                delay=max(0,min(frames-1,int(e.get('delay',0))));kind=e['type']
                if kind in [128,144,96]:
                    lane=max(1,min(12,int(e.get('lane',1)))) if standard else 0
                    key=int(e['noteKey']);switch=int(e.get('keyswitch',24))
                    if bass:
                        if kind==128:
                            if switch>=SLAP:slap_keys.add(key)
                            else:slap_keys.discard(key)
                        if key in slap_keys:lane=SLAP
                    state=samplers.get(lane) or make(lane);synth=state['synth']
                    if kind==128:
                        if standard and lane in requested_pitches and key not in requested_pitches[lane]:
                            requested_pitches[lane].add(key);state=make(lane);synth=state['synth']
                        if bass:
                            # Bass KSOP keys 20/21 are FX, not harmonics: those play sustained.
                            switch=switch-SLAP if lane==SLAP else 24 if switch in (20,21) or switch>=SLAP else switch
                        elif switch>=SLAP:switch=24
                        if standard or lane==SLAP or bass_switches:on(synth,delay,switch,1);off(synth,delay,switch,0)
                        state['key']=key;state['midiKey']=key
                        state['pitch']=state['pending'].pop(key,0.)
                        pitch(state,delay);on(synth,delay,sounding(lane,key),int(e['noteVelocity']))
                    elif kind==144:off(synth,delay,sounding(lane,key),int(e.get('noteVelocity',0)))
                    else:
                        reference=int(e.get('reference',key));root_key=state['key']
                        delta=(reference-root_key)/16 if e.get('continued') and root_key is not None and state['midiKey']!=key else 0.
                        value=(int(e['value'])-2147483648)/2147483648+delta
                        state['pending'][key]=value
                        state['pitch']=value;pitch(state,delay)
                elif kind==176:
                    controller=int(e['controller']);value=int(e['value']);controls[controller]=value
                    for state in samplers.values():cc(state['synth'],delay,controller,value)
                elif kind==224:
                    for state in samplers.values():state['wheel']=(int(e['value'])-8192)/8192;pitch(state,delay)
            pcm=np.zeros((frames,2),dtype=np.float32)
            for state in samplers.values():
                left=np.zeros(frames,dtype=np.float32);right=np.zeros(frames,dtype=np.float32)
                channels=(fp*2)(left.ctypes.data_as(fp),right.ctypes.data_as(fp));render(state['synth'],channels,2,frames)
                pcm[:,0]+=left*state['gain'];pcm[:,1]+=right*state['gain']
            reply(request,pcm=base64.b64encode(pcm.astype('<f4').tobytes()).decode())
        except Exception as error:reply(request,error=str(error))
except Exception as error:reply(0,error=str(error));sys.exit(1)
finally:
    for state in samplers.values():free(state['synth'])

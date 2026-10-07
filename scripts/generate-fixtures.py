import struct,pathlib,zipfile,math
root=pathlib.Path('tests/fixtures')
b=bytearray()
def byte(n):b.extend(struct.pack('B',n))
def short(n):b.extend(struct.pack('>h',n))
def text(s,long=False):
 enc=s.encode('utf-16-be');n=len(enc)//2
 b.extend(struct.pack('>i',n)if long else struct.pack('B',n));b.extend(enc)
def dur(d,dot=0,tuplet=None):
 byte(dot|(4 if tuplet else 0));byte(d)
 if tuplet:byte(tuplet[0]);byte(tuplet[1])
text('TuxGuitar File Format - 1.5');text('TG Reader Test');text('Tab Studio')
for _ in range(6):text('')
text('',True);byte(1);short(1)
for n in [0,27,100,64,0,0,0,0]:byte(n)
text('Guitar');short(0);short(2)
byte(3);byte(4);dur(4);short(120)
byte(3);byte(6);dur(8);short(90)
byte(1);byte(0);text('Guitar');short(1)
for mi,frets in enumerate([[3,5,7,8],[0,2,3,5,7,8]]):
 byte(0)
 for i,fret in enumerate(frets):
  byte((1 if i<len(frets)-1 else 0)|16|32);byte(3);dur(4 if mi==0 else 8)
  byte(8|(4 if i==0 else 0));byte(fret);byte(1);byte(95)
  if i==0:b.extend(bytes([0,32,0]))
byte(6)
for n in [64,59,55,50,45,40]:byte(n)
byte(24);b.extend(bytes([0,128,128]))
(root/'tg-v15.tg').write_bytes(b)
unit=math.lcm(64,3,5,6,7,9,10,11,12,13)
measures=[]
start=1
for mi,frets in enumerate([[3,5,7,8],[0,2,3,5,7,8]]):
 beats=[]
 for i,fret in enumerate(frets):
  qq=start+i*(1 if mi==0 else .5)
  beats.append(f'<TGBeat><preciseStart>{int(qq*unit)}</preciseStart><voice><duration value="{4 if mi==0 else 8}"/><note string="1" value="{fret}" velocity="95">'+('<palmMute/>'if i==0 else '')+'</note></voice></TGBeat>')
 measures.append('<TGMeasure><clef>treble</clef><keySignature>0</keySignature>'+''.join(beats)+'</TGMeasure>');start+=4 if mi==0 else 3
xml='<TuxGuitarFile><TGSong><name>TG Reader Test</name><artist>Tab Studio</artist><TGChannel><id>1</id><bank>0</bank><program>27</program><volume>100</volume><balance>64</balance></TGChannel><TGMeasureHeader><timeSignature numerator="4" denominator="4"/><tempo base="4">120</tempo></TGMeasureHeader><TGMeasureHeader><timeSignature numerator="6" denominator="8"/><tempo base="8" dotted="true">60</tempo></TGMeasureHeader><TGTrack><name>Guitar</name><channelId>1</channelId><offset>0</offset><color R="0" G="128" B="128"/>'+''.join(f'<TGString>{n}</TGString>'for n in [64,59,55,50,45,40])+''.join(measures)+'</TGTrack></TGSong></TuxGuitarFile>'
# dotted eighth=0.75 quarter; 60 bpm -> quarter bpm45. Tests catch BPM unit conversion.
with zipfile.ZipFile(root/'tg-v2.tg','w',zipfile.ZIP_DEFLATED)as z:
 z.writestr('version.txt','TuxGuitar_file_format 2.0');z.writestr('content.xml',xml)
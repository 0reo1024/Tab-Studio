from pathlib import Path
from pypdf import PdfReader
import json,sys,subprocess,logging
import pdfplumber
from PIL import Image,ImageDraw
logging.getLogger('pdfminer').setLevel(logging.ERROR)
folder=Path(sys.argv[1]).resolve()
report=[]
for name in json.loads((folder/'pdf-files.json').read_text()):
    file=folder/name
    text='\n'.join(page.extract_text() or '' for page in PdfReader(file).pages)
    assert 'BAR-2' in text and 'BAR-3' in text,(name,'Missing selected measures')
    assert 'BAR-1' not in text and 'BAR-4' not in text,(name,'Unselected measures printed')
    with pdfplumber.open(file) as pdf:
        for page in pdf.pages:
            width,height=(842,595) if name=='landscape.pdf' else (595,842)
            assert abs(page.width-width)<2 and abs(page.height-height)<2,(name,'Orientation')
            for c in page.chars:
                assert -1<=c['x0'] and c['x1']<=page.width+1 and -1<=c['top'] and c['bottom']<=page.height+1,(name,'Clipped text',c['text'])
        report.append({'file':name,'pages':len(pdf.pages)})
    prefix=folder/file.stem
    subprocess.run(['pdftoppm','-scale-to','1400','-png',str(file),str(prefix)],check=True,capture_output=True)
    pages=sorted(folder.glob(file.stem+'-*.png'))
    sheet=Image.new('RGB',(1080,800*((len(pages)+1)//2)),(224,227,230));draw=ImageDraw.Draw(sheet)
    for i,p in enumerate(pages):
        im=Image.open(p);im.thumbnail((510,750));x=15+(i%2)*540;y=28+(i//2)*800;sheet.paste(im,(x,y));draw.text((x,y-18),p.name,fill='black')
    sheet.save(folder/(file.stem+'-contact.png'))
(folder/'pdf-qa.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report))

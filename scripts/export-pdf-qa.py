from pathlib import Path
import json, subprocess, sys, logging
import pdfplumber
from pypdf import PdfReader
from PIL import Image, ImageDraw

folder=Path(sys.argv[1]).resolve()
report=[]
logging.getLogger('pdfminer').setLevel(logging.ERROR)
for name in ['demo','multi-page','one-track','standard-and-tab','tall-system']:
    file=folder/(name+'.pdf')
    with pdfplumber.open(file) as pdf:
        texts=[page.extract_text() or '' for page in PdfReader(file).pages]
        assert all(abs(page.width-595)<2 and abs(page.height-842)<2 for page in pdf.pages)
        assert all(text.strip() for text in texts), ('Blank PDF page',name)
        assert 'HiddenIgnored' not in '\n'.join(texts)
        if name in ['multi-page','one-track','standard-and-tab']:
            assert len(pdf.pages)>1
            assert 'END-24' in texts[-1], ('Missing final measure',name)
        if name=='tall-system':
            assert 'Tall system' in texts[0]
            assert 'Track 12' in '\n'.join(texts)
        for page in pdf.pages:
            for char in page.chars:
                assert -1<=char['x0']<=page.width+1 and char['x1']<=page.width+1, ('Horizontal clipping',name,char['text'])
                assert -1<=char['top']<=page.height+1 and char['bottom']<=page.height+1, ('Vertical clipping',name,char['text'])
        report.append({'name':name,'pages':len(pdf.pages),'lastPageText':texts[-1][-250:]})
    subprocess.run(['pdftoppm','-scale-to','1200','-png',str(file),str(folder/name)],check=True,capture_output=True)
    images=sorted(folder.glob(name+'-*.png'))
    sheet=Image.new('RGB',(830,610*((len(images)+1)//2)),(224,227,230));draw=ImageDraw.Draw(sheet)
    for i,path in enumerate(images):
        page=Image.open(path);page.thumbnail((395,565));x=20+(i%2)*410;y=28+(i//2)*610;sheet.paste(page,(x,y));draw.text((x,y-18),path.name,fill='black')
    sheet.save(folder/(name+'-contact.png'))
(folder/'pdf-qa.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps([{'name':item['name'],'pages':item['pages']} for item in report]))

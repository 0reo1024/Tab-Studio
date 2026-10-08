"""Check initial native captions before any move or resize, using real VST3 editors."""
import ctypes as c
from ctypes import wintypes as w
from pathlib import Path
import sys, threading, time, struct, zlib
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'native'))
from editor_window import show_editor
from pedalboard import load_plugin
user=c.WinDLL('user32');kernel=c.WinDLL('kernel32')
user.GetClassNameW.argtypes=[w.HWND,w.LPWSTR,c.c_int]
user.GetWindowRect.argtypes=[w.HWND,c.POINTER(w.RECT)]
user.GetClientRect.argtypes=[w.HWND,c.POINTER(w.RECT)]
user.ClientToScreen.argtypes=[w.HWND,c.POINTER(w.POINT)]
user.GetWindowLongPtrW.argtypes=[w.HWND,c.c_int];user.GetWindowLongPtrW.restype=c.c_ssize_t
user.GetWindowThreadProcessId.argtypes=[w.HWND,c.POINTER(w.DWORD)]
enum=c.WINFUNCTYPE(w.BOOL,w.HWND,w.LPARAM)
gdi=c.WinDLL('gdi32')
user.GetDC.argtypes=[w.HWND];user.GetDC.restype=w.HDC
user.ReleaseDC.argtypes=[w.HWND,w.HDC]
user.PrintWindow.argtypes=[w.HWND,w.HDC,w.UINT]
gdi.CreateCompatibleDC.argtypes=[w.HDC];gdi.CreateCompatibleDC.restype=w.HDC
gdi.CreateCompatibleBitmap.argtypes=[w.HDC,c.c_int,c.c_int];gdi.CreateCompatibleBitmap.restype=w.HBITMAP
gdi.SelectObject.argtypes=[w.HDC,w.HANDLE];gdi.SelectObject.restype=w.HANDLE
gdi.BitBlt.argtypes=[w.HDC,c.c_int,c.c_int,c.c_int,c.c_int,w.HDC,c.c_int,c.c_int,w.DWORD]
gdi.GetDIBits.argtypes=[w.HDC,w.HBITMAP,w.UINT,w.UINT,c.c_void_p,c.c_void_p,w.UINT]
gdi.DeleteObject.argtypes=[w.HANDLE];gdi.DeleteDC.argtypes=[w.HDC]
def capture(hwnd,filename):
    rect=w.RECT();user.GetClientRect(hwnd,c.byref(rect));width,height=rect.right,rect.bottom
    dc=user.GetDC(hwnd);mem=gdi.CreateCompatibleDC(dc);bitmap=gdi.CreateCompatibleBitmap(dc,width,height);previous=gdi.SelectObject(mem,bitmap)
    try:
        user.PrintWindow(hwnd,mem,3)
        info=c.create_string_buffer(struct.pack('<IiiHHIIiiII',40,width,-height,1,32,0,width*height*4,0,0,0,0))
        bits=c.create_string_buffer(width*height*4);gdi.GetDIBits(mem,bitmap,0,height,bits,info,0)
        rgb=np.frombuffer(bits.raw,dtype=np.uint8).reshape(height,width,4)[:,:, [2,1,0]]
        colors=len(np.unique(rgb.reshape(-1,3),axis=0));print('EDITOR DRAW COLORS',filename,colors,flush=True)
        def chunk(tag,data):return struct.pack('>I',len(data))+tag+data+struct.pack('>I',zlib.crc32(tag+data)&0xffffffff)
        png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(b'\0'+row.tobytes() for row in rgb)))+chunk(b'IEND',b'')
        Path('test-results').mkdir(exist_ok=True);Path('test-results/'+filename+'.png').write_bytes(png)
        return colors
    finally:
        gdi.SelectObject(mem,previous);gdi.DeleteObject(bitmap);gdi.DeleteDC(mem);user.ReleaseDC(hwnd,dc)
plugins={}
for filename in ['BIAS FX 2_x64.vst3','BIAS FX 2_x64.vst3','BIAS FX 2_x64.vst3','bx_megasingle.vst3']:
    if filename not in plugins:plugins[filename]=load_plugin(str(Path('C:/Program Files/Common Files/VST3')/filename))
    plugin=plugins[filename]
    plugin.process(np.zeros((2,512),dtype=np.float32),44100,buffer_size=512,reset=False)
    closed=threading.Event();failures=[];seen=[]
    def verify():
        try:
            @enum
            def find(hwnd,_):
                name=c.create_unicode_buffer(256);pid=w.DWORD()
                user.GetClassNameW(hwnd,name,256);user.GetWindowThreadProcessId(hwnd,c.byref(pid))
                if pid.value==kernel.GetCurrentProcessId() and user.IsWindowVisible(hwnd) and user.GetWindowLongPtrW(hwnd,-16)&0xc00000==0xc00000:seen.append(hwnd)
                return True
            end=time.monotonic()+15
            while not seen and time.monotonic()<end:user.EnumWindows(find,0);time.sleep(.05)
            assert seen,'Native frame was not created'
            time.sleep(1.5)
            frame=w.RECT();client=w.RECT();origin=w.POINT()
            user.GetWindowRect(seen[0],c.byref(frame));user.GetClientRect(seen[0],c.byref(client));user.ClientToScreen(seen[0],c.byref(origin))
            assert origin.y-frame.top>=20,(frame.top,origin.y)
            assert frame.top>=0,'Caption is offscreen'
            assert user.GetWindowLongPtrW(seen[0],-16)&0xc00000==0xc00000
            assert client.right>100 and client.bottom>100
            deadline=time.monotonic()+30
            while capture(seen[0],filename)<2000 and time.monotonic()<deadline:time.sleep(.5)
            assert capture(seen[0],filename)>=2000,'Editor did not finish drawing'
            print('INITIAL FX WINDOW PASSED',filename,'caption height',origin.y-frame.top,flush=True)
        except BaseException as e:failures.append(e)
        finally:closed.set()
    check=threading.Thread(target=verify);check.start();show_editor(plugin,closed);check.join()
    if failures:raise failures[0]

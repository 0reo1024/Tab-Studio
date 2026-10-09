# Spike S10: the Electron build's editor (pedalboard + native/editor_window.py), captured
# after a delay with PrintWindow (this window's own content only), for comparison.
# Usage: python editor-reference.py <plugin> <out.bmp> <seconds>
import sys, pathlib, threading, time, ctypes as c
from ctypes import wintypes as w
root = pathlib.Path(sys.argv[0]).resolve().parents[2] / 'native'
sys.path.insert(0, str(root)); sys.path.insert(0, str(root / 'runtime' / 'site-packages'))
import numpy as np
from pedalboard import load_plugin
from editor_window import show_editor
plugin = load_plugin(sys.argv[1])
plugin.process(np.zeros((2, 512), dtype=np.float32), 44100, buffer_size=512, reset=False)
closing = threading.Event(); found = {}
def capture():
    time.sleep(float(sys.argv[3]))
    hwnd = found.get('hwnd')
    if hwnd:
        user, gdi = c.WinDLL('user32'), c.WinDLL('gdi32')
        user.GetDC.restype = w.HDC; gdi.CreateCompatibleDC.restype = w.HDC; gdi.CreateCompatibleDC.argtypes = [w.HDC]; gdi.CreateCompatibleBitmap.restype = w.HBITMAP; gdi.CreateCompatibleBitmap.argtypes = [w.HDC, c.c_int, c.c_int]; gdi.SelectObject.argtypes = [w.HDC, w.HGDIOBJ]; user.PrintWindow.argtypes = [w.HWND, w.HDC, w.UINT]; gdi.GetDIBits.argtypes = [w.HDC, w.HBITMAP, w.UINT, w.UINT, c.c_void_p, c.c_void_p, w.UINT]; user.GetDC.argtypes = [w.HWND]
        r = w.RECT(); user.GetWindowRect(w.HWND(hwnd), c.byref(r)); W, H = r.right - r.left, r.bottom - r.top
        sdc = user.GetDC(w.HWND(hwnd)); dc = gdi.CreateCompatibleDC(sdc); bmp = gdi.CreateCompatibleBitmap(sdc, W, H); gdi.SelectObject(dc, bmp)
        user.PrintWindow(w.HWND(hwnd), dc, 2)
        class BIH(c.Structure): _fields_ = [('biSize', w.DWORD), ('biWidth', w.LONG), ('biHeight', w.LONG), ('biPlanes', w.WORD), ('biBitCount', w.WORD), ('biCompression', w.DWORD), ('biSizeImage', w.DWORD), ('a', w.LONG), ('b', w.LONG), ('cu', w.DWORD), ('ci', w.DWORD)]
        h = BIH(); h.biSize = c.sizeof(BIH); h.biWidth = W; h.biHeight = H; h.biPlanes = 1; h.biBitCount = 32
        buf = c.create_string_buffer(W * H * 4); gdi.GetDIBits(dc, bmp, 0, H, buf, c.byref(h), 0)
        head = b'BM' + (54 + len(buf.raw)).to_bytes(4, 'little') + b'\0' * 4 + (54).to_bytes(4, 'little') + bytes(h)
        open(sys.argv[2], 'wb').write(head + buf.raw); print('captured', W, H, flush=True)
    else:
        print('no editor window', flush=True)
    closing.set()
threading.Thread(target=capture, daemon=True).start()
show_editor(plugin, closing, on_window=lambda hwnd: found.update(hwnd=hwnd))

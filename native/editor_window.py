"""Add a Windows caption to the plugin's own window without reparenting its GPU view."""
import ctypes as c
from ctypes import wintypes as w
import os, sys, threading, time


def show_editor(plugin, close_event):
    if sys.platform != 'win32':
        plugin.show_editor(close_event)
        return
    user=c.WinDLL('user32',use_last_error=True)
    user.GetWindowLongPtrW.argtypes=[w.HWND,c.c_int];user.GetWindowLongPtrW.restype=c.c_ssize_t
    user.SetWindowLongPtrW.argtypes=[w.HWND,c.c_int,c.c_ssize_t];user.SetWindowLongPtrW.restype=c.c_ssize_t
    user.GetWindowThreadProcessId.argtypes=[w.HWND,c.POINTER(w.DWORD)]
    user.GetWindowRect.argtypes=[w.HWND,c.POINTER(w.RECT)]
    user.GetClientRect.argtypes=[w.HWND,c.POINTER(w.RECT)]
    user.SetWindowPos.argtypes=[w.HWND,w.HWND,c.c_int,c.c_int,c.c_int,c.c_int,w.UINT]
    user.SetWindowTextW.argtypes=[w.HWND,w.LPCWSTR]
    user.IsWindowVisible.argtypes=[w.HWND]
    user.GetWindow.argtypes=[w.HWND,w.UINT];user.GetWindow.restype=w.HWND
    enum=c.WINFUNCTYPE(w.BOOL,w.HWND,w.LPARAM)
    finished=threading.Event()
    def windows():
        found=[]
        @enum
        def find(hwnd,_):
            pid=w.DWORD();user.GetWindowThreadProcessId(hwnd,c.byref(pid))
            if pid.value==os.getpid() and user.IsWindowVisible(hwnd) and not user.GetWindow(hwnd,4):
                rect=w.RECT();user.GetClientRect(hwnd,c.byref(rect))
                if rect.right>100 and rect.bottom>100:found.append(hwnd)
            return True
        user.EnumWindows(find,0)
        return found
    previous=set(windows())
    def decorate():
        while not finished.is_set() and not close_event.is_set():
            candidates=[hwnd for hwnd in windows() if hwnd not in previous]
            if not candidates:
                finished.wait(.02)
                continue
            hwnd=candidates[0]
            if finished.wait(.2):return
            rect=w.RECT();client=w.RECT();user.GetWindowRect(hwnd,c.byref(rect));user.GetClientRect(hwnd,c.byref(client))
            style=(user.GetWindowLongPtrW(hwnd,-16)&~0x80000000)|0x00cf0000
            bounds=w.RECT(0,0,client.right,client.bottom);user.AdjustWindowRectEx(c.byref(bounds),style,False,0)
            user.SetWindowLongPtrW(hwnd,-16,style);user.SetWindowTextW(hwnd,plugin.name)
            # Async positioning preserves JUCE's message thread and OpenGL context.
            # A foreign parent/thread can leave BIAS's GPU editor permanently black.
            user.SetWindowPos(hwnd,None,max(0,rect.left+bounds.left),max(0,rect.top+bounds.top),bounds.right-bounds.left,bounds.bottom-bounds.top,0x20|0x4|0x4000)
            return
    thread=threading.Thread(target=decorate,daemon=True);thread.start()
    try:
        plugin.show_editor(close_event)
    finally:
        finished.set();thread.join(1)

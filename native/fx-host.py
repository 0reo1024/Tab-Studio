# SPDX-License-Identifier: GPL-3.0-or-later
"""Isolated VST3/AU host; UI runs on the process main thread.

Pedalboard is GPL-3.0. It is used by this separate helper process.
Upstream source: https://github.com/spotify/pedalboard/tree/v0.9.26
"""
import base64, json, pathlib, queue, sys, threading, time
sys.path.insert(0, str(pathlib.Path(__file__).parent))
sys.path.insert(0, str(pathlib.Path(__file__).parent / 'runtime' / 'site-packages'))
import numpy as np
from pedalboard import load_plugin
from editor_window import show_editor

output_lock = threading.Lock()
def reply(request, **value):
    with output_lock:
        print('TABSTUDIO:' + json.dumps({'id': request, **value}), flush=True)

try:
    plugin = load_plugin(sys.argv[1])
    if not plugin.is_effect:
        raise ValueError('Audio FXにはエフェクトプラグインを選んでください。')
    # Initialize DSP before the first editor open (BIAS builds its engine lazily).
    plugin.process(np.zeros((2,512),dtype=np.float32),44100,buffer_size=512,reset=False)
    reply(0, name=plugin.name, ready=True)
except Exception as error:
    reply(0, error=str(error))
    sys.exit(1)

editors = queue.Queue()
closing = threading.Event()
editor_closing = threading.Event()
def commands():
    for line in sys.stdin:
        request = None
        try:
            data = json.loads(line); request = data['id']; command = data['cmd']
            if command == 'process':
                raw = base64.b64decode(data['pcm'], validate=True)
                if len(raw) > 1024 * 1024 or len(raw) % 8:
                    raise ValueError('Invalid stereo PCM block')
                audio = np.frombuffer(raw, dtype='<f4').reshape(-1, 2).T.copy()
                result = plugin.process(audio, float(data['rate']), buffer_size=512, reset=False)
                # Some plugins return fewer frames while filling their internal latency buffer.
                pcm = np.zeros_like(audio)
                frames = min(result.shape[-1], audio.shape[-1])
                if frames:
                    if result.ndim == 1: pcm[:, -frames:] = result[-frames:]
                    else: pcm[:, -frames:] = result[:2, -frames:]
                reply(request, pcm=base64.b64encode(pcm.T.astype('<f4').tobytes()).decode())
            elif command == 'state':
                reply(request, state=base64.b64encode(plugin.preset_data).decode())
            elif command == 'restore':
                plugin.preset_data = base64.b64decode(data['state'], validate=True)
                reply(request, restored=True)
            elif command == 'reset':
                plugin.reset(); reply(request, reset=True)
            elif command == 'editor':
                editors.put(request)
            elif command == 'editor-close':
                editor_closing.set(); reply(request, closed=True)
            elif command == 'close':
                closing.set(); editor_closing.set(); reply(request, closed=True); break
            else:
                raise ValueError('Unknown FX command')
        except Exception as error:
            reply(request, error=str(error))
    closing.set(); editor_closing.set()

threading.Thread(target=commands, daemon=True).start()
while not closing.is_set():
    try: request = editors.get(timeout=.1)
    except queue.Empty: continue
    try:
        editor_closing.clear()
        show_editor(plugin, editor_closing)
        reply(request, state=base64.b64encode(plugin.preset_data).decode())
    except Exception as error:
        reply(request, error=str(error))

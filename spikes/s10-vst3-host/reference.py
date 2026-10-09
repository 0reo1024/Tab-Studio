# Spike S10 reference: the Electron build's host (pedalboard, as native/fx-host.py uses it).
# Usage: python reference.py <plugin> <rate> <in.f32 stereo> <out.f32> <state-out> [state-in]
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(sys.argv[0]).resolve().parents[2] / 'native' / 'runtime' / 'site-packages'))
import numpy as np
from pedalboard import load_plugin
plugin = load_plugin(sys.argv[1])
if len(sys.argv) > 6:
    plugin.preset_data = open(sys.argv[6], 'rb').read()
rate = float(sys.argv[2])
audio = np.fromfile(sys.argv[3], dtype='<f4').reshape(-1, 2).T.copy()
out = plugin.process(audio, rate, buffer_size=512, reset=False)
np.ascontiguousarray(out[:2].T.astype('<f4')).tofile(sys.argv[4])
open(sys.argv[5], 'wb').write(plugin.preset_data)
print(plugin.name, out.shape)

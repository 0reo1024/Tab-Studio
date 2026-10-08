# Audio components

- GeneralUser GS 2.0.3 by S. Christian Collins: `GeneralUser-GS-LICENSE.txt`.
- NAM WASM 2.0.1 and the Deluxe A2 model: `NAM-wasm-MIT.txt`, `public/nam/SOURCE.json`. Upstream NAM Core/Eigen notices are retained in the corresponding source archives.
- Pedalboard 0.9.26 / JUCE: GPL-3.0. The isolated FX helper is GPL-3.0-or-later; license and NOTICE are in `pedalboard-0.9.26`. Fixed upstream sources and submodules are bundled in `audio-source`, with exact URLs and checksums in `SOURCES.json`. Regenerate with `python scripts/prepare-audio-notices.py`.
- Python 3.11.9: `Python-3.11.9-LICENSE.txt`; NumPy 2.4.6 notices are in `numpy-2.4.6`.
- sfizz 1.2.3: `sfizz-BSD-2-Clause.txt`, `sfizz-third-party`, `sfizz-1.2.3-source.tar.gz` (https://github.com/sfztools/sfizz/tree/1.2.3).
- alphaTab 1.8.4: MPL-2.0. Modified worker source is shipped in `dist/alphatab/alphaTab.core.mjs`; the reproducible patch is `alphaTab-channel-audio-patch.mjs`.

Standard Guitar is a user-installed library from Unreal Instruments, referenced through a local SFZ path. Its original documentation remains beside the samples. Commercial effect plugins are supplied by the user and retain their own licenses.

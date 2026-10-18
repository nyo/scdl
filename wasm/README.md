# libs/lame-wasm.js

The mp3 encoder of the add-on: [LAME](https://lame.sourceforge.io) 3.100 compiled to WebAssembly, with a small C file (`lame-bridge.c`) to call it.

LAME is not modified.

## Sources and tools

| What | Version | Where | Digest |
| ---- | ------- | ----- | ------ |
| LAME | 3.100 | https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz | `sha256:ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e` |
| Emscripten | 6.0.12 | Docker image `emscripten/emsdk:6.0.12` | `sha256:77638e6c215a65f25a704c0c831d5c2463a8c0468a58c6cb82489dbe621dfa05` |
| Bridge | | `wasm/lame-bridge.c` | |

## Rebuilding

Start Docker, then run from the root of the repository:

```bash
bash wasm/build.sh
```

It downloads LAME, checks it, builds it and writes `libs/lame-wasm.js`. The SHA-256 it prints at the end must be:

```
6bbf47e39ce134a8c697f8321cb42c131627894565c1fa044d4d35ab09548646
```

### Cleaning up

```bash
rm -rf wasm/build # the source archive and the compiled LAME (10 MB)
docker rmi emscripten/emsdk@sha256:77638e6c215a65f25a704c0c831d5c2463a8c0468a58c6cb82489dbe621dfa05 # the Emscripten image (3.39 GB)
```

## Credits

- [LAME](https://lame.sourceforge.io) (LGPL). Its [license page](https://lame.sourceforge.io/license.txt) asks to acknowledge LAME with a link to its site. LAME's decoder is under the GPL and is not part of this build.
- [Mediabunny](https://github.com/Vanilagy/mediabunny/tree/8dee3638fb1755e58b88d4432e344c5916027e76/packages/mp3-encoder) 1.61.6 (MPL-2.0): the build instructions, and the settings and their order in the C file.
- [wasm-media-encoders](https://github.com/arseneyr/wasm-media-encoders/tree/4a45333baadbab312d1cc0911151dfad23157c51) 0.7.0 (MIT): feeding LAME floats through `lame_encode_buffer_ieee_float` rather than 16-bit samples.

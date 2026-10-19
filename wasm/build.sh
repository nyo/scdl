#!/usr/bin/env bash
#
# Builds libs/lame-wasm.js: LAME 3.100, from its official source archive,
# compiled to WebAssembly with Emscripten, plus lame-bridge.c.
#
# Needs a running Docker. Emscripten itself runs in the pinned image, so
# nothing else gets installed on the machine.
#
#   bash wasm/build.sh
#
# To clean up afterwards, see wasm/README.md.
#
# The configure options and the compiler flags follow the build instructions
# in the README of Mediabunny's mp3-encoder package (MPL-2.0), version 1.61.6:
# https://github.com/Vanilagy/mediabunny/blob/8dee3638fb1755e58b88d4432e344c5916027e76/packages/mp3-encoder/README.md
# Four differences:
# - the module is not an ES module and is named createLame, so it loads as a
#   classic content script
# - HEAPF32 is exported, for the float samples
# - cwrap is not, since index.js calls the _scdl_ functions directly
# - configure gets --build, see below

set -euo pipefail

cd "$(dirname "$0")/.."

# https://lame.sourceforge.io/download.php says LAME is only distributed as
# source. The archive's SHA-256 is the one measured on 2026-10-18; the
# archive is checked against it before anything is built
LAME_VERSION="3.100"
LAME_URL="https://downloads.sourceforge.net/project/lame/lame/${LAME_VERSION}/lame-${LAME_VERSION}.tar.gz"
LAME_SHA256="ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e"

# Emscripten 6.0.12, the multi-architecture image (amd64 and arm64), by
# digest so a moved tag can't change the build
EMSDK_IMAGE="emscripten/emsdk:6.0.12@sha256:77638e6c215a65f25a704c0c831d5c2463a8c0468a58c6cb82489dbe621dfa05"

OUTPUT="libs/lame-wasm.js"
WORK="wasm/build"
SOURCE="${WORK}/lame-${LAME_VERSION}"

mkdir -p "$WORK"

if [ ! -f "${WORK}/lame-${LAME_VERSION}.tar.gz" ]; then
  echo "Downloading LAME ${LAME_VERSION}…"
  curl -fL -o "${WORK}/lame-${LAME_VERSION}.tar.gz" "$LAME_URL"
fi

echo "${LAME_SHA256}  ${WORK}/lame-${LAME_VERSION}.tar.gz" | shasum -a 256 -c -

rm -rf "$SOURCE"
tar -xzf "${WORK}/lame-${LAME_VERSION}.tar.gz" -C "$WORK"

# the container runs as the current user, so the files it writes are ours
emsdk() {
  docker run --rm -u "$(id -u):$(id -g)" -v "$PWD":/repo -w /repo "$EMSDK_IMAGE" "$@"
}

# 1. LAME as a static library. No decoder, no command-line program.
#    -DNO_STDIO is in Mediabunny's instructions; LAME 3.100 does not read it.
#    configure turns on code for x86_64 hosts (TAKEHIRO_IEEE754_HACK and
#    USE_FAST_LOG), so the host it detects changes the output. --build fixes
#    it, and every machine builds the same file
echo "Compiling LAME…"
emsdk sh -c "cd ${SOURCE} \
  && emconfigure ./configure \
    --build=x86_64-unknown-linux-gnu \
    CFLAGS='-DNDEBUG -DNO_STDIO -O3 -msimd128' \
    --disable-dependency-tracking \
    --disable-shared \
    --disable-gtktest \
    --disable-analyzer-hooks \
    --disable-decoder \
    --disable-frontend \
  && emmake make"

# 2. the bridge and the library, linked into one JavaScript file that holds
#    the wasm inline. It defines the global createLame
echo "Linking ${OUTPUT}…"
emsdk emcc wasm/lame-bridge.c "${SOURCE}/libmp3lame/.libs/libmp3lame.a" \
  -I"${SOURCE}/include" \
  -O3 -msimd128 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME=createLame \
  -s SINGLE_FILE=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s ENVIRONMENT=web,worker \
  -s EXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32 \
  -s EXPORTED_FUNCTIONS=_malloc,_free,_lame_encode_buffer_ieee_float,_lame_encode_flush,_lame_close \
  -o "$OUTPUT"

echo
ls -l "$OUTPUT"
shasum -a 256 "$OUTPUT"

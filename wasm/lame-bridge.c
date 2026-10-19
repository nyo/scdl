// Sets up a LAME 3.100 encoder for the add-on. Compiled into
// libs/lame-wasm.js by build.sh, with LAME itself.
//
// The settings and their order follow the lame-bridge.c of Mediabunny's
// mp3-encoder package (MPL-2.0), version 1.61.6:
// https://github.com/Vanilagy/mediabunny/blob/8dee3638fb1755e58b88d4432e344c5916027e76/packages/mp3-encoder/src/lame-bridge.c
//
// The encoder is LAME: https://lame.sourceforge.io

#include <emscripten.h>
#include <lame.h>

// Creates an encoder for constant-bitrate mp3 at the input's sample rate.
// Returns NULL when LAME refuses the settings.
EMSCRIPTEN_KEEPALIVE
lame_global_flags *scdl_lame_init(int channels, int sample_rate,
                                  int bitrate_kbps) {
  lame_global_flags *gfp = lame_init();

  if (gfp == NULL) return NULL;

  lame_set_num_channels(gfp, channels);
  lame_set_in_samplerate(gfp, sample_rate);
  lame_set_out_samplerate(gfp, sample_rate);
  lame_set_brate(gfp, bitrate_kbps);
  // no Xing/LAME header frame: the file holds only audio frames
  lame_set_bWriteVbrTag(gfp, 0);

  if (lame_init_params(gfp) < 0) {
    lame_close(gfp);
    return NULL;
  }

  return gfp;
}

#include "wasapi_capture.h"
#include <ks.h>
#include <ksmedia.h>

namespace screen_audio {

Format ParseWasapiFormat(const WAVEFORMATEX* wave, size_t bytes) {
  if (!wave || bytes < sizeof(WAVEFORMATEX) ||
      size_t(wave->cbSize) > bytes - sizeof(WAVEFORMATEX))
    throw Failure("ERR_AUDIO_FORMAT", "Truncated WAVEFORMATEX");
  Format f;
  f.sampleRate = wave->nSamplesPerSec;
  f.channels = wave->nChannels;
  f.bits = f.validBits = wave->wBitsPerSample;
  f.blockAlign = wave->nBlockAlign;
  f.averageBytesPerSecond = wave->nAvgBytesPerSec;
  WORD tag = wave->wFormatTag;
  if (tag == WAVE_FORMAT_EXTENSIBLE) {
    if (wave->cbSize < sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX) ||
        bytes < sizeof(WAVEFORMATEXTENSIBLE))
      throw Failure("ERR_AUDIO_FORMAT", "Truncated WAVEFORMATEXTENSIBLE");
    const auto* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(wave);
    f.validBits = ext->Samples.wValidBitsPerSample;
    f.channelMask = ext->dwChannelMask;
    if (ext->SubFormat == KSDATAFORMAT_SUBTYPE_PCM) tag = WAVE_FORMAT_PCM;
    else if (ext->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) tag = WAVE_FORMAT_IEEE_FLOAT;
    else throw Failure("ERR_AUDIO_FORMAT", "Unsupported WASAPI subformat");
  } else if (wave->cbSize != 0) {
    throw Failure("ERR_AUDIO_FORMAT", "Unexpected extension on non-extensible PCM");
  }
  if (tag != WAVE_FORMAT_PCM && tag != WAVE_FORMAT_IEEE_FLOAT)
    throw Failure("ERR_AUDIO_FORMAT", "Unsupported WASAPI encoding");
  f.floatingPoint = tag == WAVE_FORMAT_IEEE_FLOAT;
  ValidateFormat(f);
  return f;
}

}  // namespace screen_audio

#include "dsp_native/wav_file.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <stdexcept>

namespace dsp_native {

namespace {

uint32_t ReadU32LE(const unsigned char* p) {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

uint16_t ReadU16LE(const unsigned char* p) {
  return static_cast<uint16_t>(static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8));
}

void WriteU32LE(std::ofstream& out, uint32_t value) {
  unsigned char bytes[4] = {static_cast<unsigned char>(value & 0xFF),
                            static_cast<unsigned char>((value >> 8) & 0xFF),
                            static_cast<unsigned char>((value >> 16) & 0xFF),
                            static_cast<unsigned char>((value >> 24) & 0xFF)};
  out.write(reinterpret_cast<const char*>(bytes), 4);
}

void WriteU16LE(std::ofstream& out, uint16_t value) {
  unsigned char bytes[2] = {static_cast<unsigned char>(value & 0xFF),
                            static_cast<unsigned char>((value >> 8) & 0xFF)};
  out.write(reinterpret_cast<const char*>(bytes), 2);
}

constexpr uint16_t kWaveFormatPcm = 1;
constexpr uint16_t kWaveFormatIeeeFloat = 3;
constexpr uint16_t kWaveFormatExtensible = 0xFFFE;

}  // namespace

WavAudio ReadWavFile(const std::string& path) {
  std::ifstream file(path, std::ios::binary);
  if (!file) {
    throw std::runtime_error("dsp_native::ReadWavFile: could not open '" + path + "'");
  }

  std::vector<unsigned char> bytes((std::istreambuf_iterator<char>(file)),
                                    std::istreambuf_iterator<char>());
  if (bytes.size() < 44) {
    throw std::runtime_error("dsp_native::ReadWavFile: '" + path + "' too small to be a WAV file");
  }
  if (std::memcmp(bytes.data(), "RIFF", 4) != 0 || std::memcmp(bytes.data() + 8, "WAVE", 4) != 0) {
    throw std::runtime_error("dsp_native::ReadWavFile: '" + path + "' is not a RIFF/WAVE file");
  }

  uint16_t formatTag = 0;
  uint16_t numChannels = 0;
  uint32_t sampleRate = 0;
  uint16_t bitsPerSample = 0;
  const unsigned char* dataPtr = nullptr;
  uint32_t dataSize = 0;

  std::size_t pos = 12;
  bool haveFmt = false;
  bool haveData = false;
  while (pos + 8 <= bytes.size()) {
    char chunkId[5] = {0};
    std::memcpy(chunkId, bytes.data() + pos, 4);
    const uint32_t chunkSize = ReadU32LE(bytes.data() + pos + 4);
    const std::size_t chunkDataStart = pos + 8;
    if (chunkDataStart + chunkSize > bytes.size()) {
      break;  // truncated/garbled chunk; stop walking rather than read OOB.
    }

    if (std::memcmp(chunkId, "fmt ", 4) == 0 && chunkSize >= 16) {
      const unsigned char* fmt = bytes.data() + chunkDataStart;
      formatTag = ReadU16LE(fmt + 0);
      numChannels = ReadU16LE(fmt + 2);
      sampleRate = ReadU32LE(fmt + 4);
      bitsPerSample = ReadU16LE(fmt + 14);
      if (formatTag == kWaveFormatExtensible && chunkSize >= 40) {
        // The real format is in the first two bytes of the SubFormat GUID.
        formatTag = ReadU16LE(fmt + 24);
      }
      haveFmt = true;
    } else if (std::memcmp(chunkId, "data", 4) == 0) {
      dataPtr = bytes.data() + chunkDataStart;
      dataSize = chunkSize;
      haveData = true;
    }

    pos = chunkDataStart + chunkSize + (chunkSize % 2);  // chunks are word-aligned
  }

  if (!haveFmt || !haveData) {
    throw std::runtime_error("dsp_native::ReadWavFile: '" + path + "' missing fmt/data chunk");
  }
  if (numChannels == 0 || sampleRate == 0 || bitsPerSample == 0) {
    throw std::runtime_error("dsp_native::ReadWavFile: '" + path + "' has an invalid fmt chunk");
  }

  const std::size_t bytesPerSample = bitsPerSample / 8;
  const std::size_t frameStride = bytesPerSample * numChannels;
  if (frameStride == 0) {
    throw std::runtime_error("dsp_native::ReadWavFile: '" + path + "' has zero frame stride");
  }
  const std::size_t numFrames = dataSize / frameStride;

  std::vector<float> mono(numFrames, 0.0f);

  auto decodeChannelSample = [&](const unsigned char* p) -> float {
    if (formatTag == kWaveFormatPcm) {
      switch (bitsPerSample) {
        case 8: {
          // 8-bit PCM WAV is conventionally unsigned, centered at 128.
          const int v = static_cast<int>(p[0]) - 128;
          return static_cast<float>(v) / 128.0f;
        }
        case 16: {
          const int16_t v = static_cast<int16_t>(ReadU16LE(p));
          return static_cast<float>(v) / 32768.0f;
        }
        case 24: {
          int32_t v = (static_cast<int32_t>(p[0])) | (static_cast<int32_t>(p[1]) << 8) |
                      (static_cast<int32_t>(p[2]) << 16);
          if (v & 0x00800000) {
            v |= static_cast<int32_t>(0xFF000000);  // sign-extend
          }
          return static_cast<float>(v) / 8388608.0f;
        }
        case 32: {
          const int32_t v = static_cast<int32_t>(ReadU32LE(p));
          return static_cast<float>(v) / 2147483648.0f;
        }
        default:
          throw std::runtime_error("dsp_native::ReadWavFile: unsupported PCM bit depth " +
                                    std::to_string(bitsPerSample));
      }
    } else if (formatTag == kWaveFormatIeeeFloat) {
      if (bitsPerSample == 32) {
        float v;
        std::memcpy(&v, p, sizeof(float));
        return v;
      } else if (bitsPerSample == 64) {
        double v;
        std::memcpy(&v, p, sizeof(double));
        return static_cast<float>(v);
      }
      throw std::runtime_error("dsp_native::ReadWavFile: unsupported float bit depth " +
                                std::to_string(bitsPerSample));
    }
    throw std::runtime_error("dsp_native::ReadWavFile: unsupported format tag " +
                              std::to_string(formatTag));
  };

  for (std::size_t frame = 0; frame < numFrames; ++frame) {
    float sum = 0.0f;
    const unsigned char* framePtr = dataPtr + frame * frameStride;
    for (std::size_t ch = 0; ch < numChannels; ++ch) {
      sum += decodeChannelSample(framePtr + ch * bytesPerSample);
    }
    mono[frame] = sum / static_cast<float>(numChannels);
  }

  WavAudio result;
  result.samples = std::move(mono);
  result.sampleRateHz = static_cast<double>(sampleRate);
  return result;
}

void WriteMonoWavFile(const std::string& path, const std::vector<float>& samples,
                       double sampleRateHz) {
  std::ofstream out(path, std::ios::binary);
  if (!out) {
    throw std::runtime_error("dsp_native::WriteMonoWavFile: could not open '" + path + "' for writing");
  }

  const uint32_t sampleRate = static_cast<uint32_t>(sampleRateHz);
  const uint16_t numChannels = 1;
  const uint16_t bitsPerSample = 16;
  const uint32_t byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const uint16_t blockAlign = static_cast<uint16_t>(numChannels * (bitsPerSample / 8));
  const uint32_t dataSize = static_cast<uint32_t>(samples.size() * sizeof(int16_t));

  out.write("RIFF", 4);
  WriteU32LE(out, 36 + dataSize);
  out.write("WAVE", 4);

  out.write("fmt ", 4);
  WriteU32LE(out, 16);
  WriteU16LE(out, kWaveFormatPcm);
  WriteU16LE(out, numChannels);
  WriteU32LE(out, sampleRate);
  WriteU32LE(out, byteRate);
  WriteU16LE(out, blockAlign);
  WriteU16LE(out, bitsPerSample);

  out.write("data", 4);
  WriteU32LE(out, dataSize);
  for (float s : samples) {
    const float clamped = std::clamp(s, -1.0f, 1.0f);
    const int16_t sample16 = static_cast<int16_t>(std::lround(clamped * 32767.0f));
    WriteU16LE(out, static_cast<uint16_t>(sample16));
  }
}

}  // namespace dsp_native

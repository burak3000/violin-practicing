import { readFileSync } from 'node:fs';

/**
 * Test-only RIFF/WAVE reader for the shared Phase 8 conformance suite.
 * Reads the exact fixture assets under packages/dsp-native/test/fixtures/
 * into normalized mono float samples, mirroring dsp-native's own
 * ReadWavFile() contract closely enough for fixture-driven parity tests
 * without adding a runtime dependency to this package's shipped source.
 */

export interface WavFixture {
  readonly sampleRateHz: number;
  readonly samples: Float32Array;
}

interface WaveFormat {
  readonly audioFormat: number;
  readonly numChannels: number;
  readonly sampleRateHz: number;
  readonly blockAlign: number;
  readonly bitsPerSample: number;
}

function readInt24LE(view: DataView, offset: number): number {
  const b0 = view.getUint8(offset);
  const b1 = view.getUint8(offset + 1);
  const b2 = view.getUint8(offset + 2);
  const value = b0 | (b1 << 8) | (b2 << 16);
  return value & 0x800000 ? value - 0x1000000 : value;
}

function pcmSampleToFloat(view: DataView, offset: number, bitsPerSample: number): number {
  switch (bitsPerSample) {
    case 8:
      return (view.getUint8(offset) - 128) / 128;
    case 16:
      return view.getInt16(offset, true) / 32768;
    case 24:
      return readInt24LE(view, offset) / 8388608;
    case 32:
      return view.getInt32(offset, true) / 2147483648;
    default:
      throw new Error(`Unsupported PCM bitsPerSample=${bitsPerSample}`);
  }
}

function floatSampleToFloat(view: DataView, offset: number, bitsPerSample: number): number {
  switch (bitsPerSample) {
    case 32:
      return view.getFloat32(offset, true);
    case 64:
      return view.getFloat64(offset, true);
    default:
      throw new Error(`Unsupported IEEE-float bitsPerSample=${bitsPerSample}`);
  }
}

export function readWavFixture(path: string): WavFixture {
  const buffer = readFileSync(path);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  if (buffer.byteLength < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error(`Invalid WAV fixture (missing RIFF header): ${path}`);
  }
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`Invalid WAV fixture (missing WAVE signature): ${path}`);
  }

  let format: WaveFormat | undefined;
  let dataOffset = -1;
  let dataSize = -1;

  for (let offset = 12; offset + 8 <= buffer.byteLength;) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;
    if (chunkDataOffset + chunkSize > buffer.byteLength) {
      throw new Error(`Invalid WAV fixture (chunk overruns file): ${path}`);
    }

    if (chunkId === 'fmt ') {
      if (chunkSize < 16) {
        throw new Error(`Invalid WAV fixture (short fmt chunk): ${path}`);
      }
      format = {
        audioFormat: view.getUint16(chunkDataOffset, true),
        numChannels: view.getUint16(chunkDataOffset + 2, true),
        sampleRateHz: view.getUint32(chunkDataOffset + 4, true),
        blockAlign: view.getUint16(chunkDataOffset + 12, true),
        bitsPerSample: view.getUint16(chunkDataOffset + 14, true),
      };
    } else if (chunkId === 'data') {
      dataOffset = chunkDataOffset;
      dataSize = chunkSize;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (format === undefined) {
    throw new Error(`Invalid WAV fixture (missing fmt chunk): ${path}`);
  }
  if (dataOffset < 0 || dataSize < 0) {
    throw new Error(`Invalid WAV fixture (missing data chunk): ${path}`);
  }
  if (format.numChannels <= 0 || format.blockAlign <= 0 || format.sampleRateHz <= 0) {
    throw new Error(`Invalid WAV fixture (bad format fields): ${path}`);
  }
  if (dataSize % format.blockAlign !== 0) {
    throw new Error(`Invalid WAV fixture (data size misaligned to blockAlign): ${path}`);
  }
  if (format.audioFormat !== 1 && format.audioFormat !== 3) {
    throw new Error(
      `Unsupported WAV fixture audioFormat=${format.audioFormat}; expected PCM (1) or IEEE float (3): ${path}`,
    );
  }

  const frameCount = dataSize / format.blockAlign;
  const bytesPerSample = format.bitsPerSample / 8;
  const out = new Float32Array(frameCount);

  for (let frame = 0; frame < frameCount; frame++) {
    const frameOffset = dataOffset + frame * format.blockAlign;
    let mixed = 0;
    for (let channel = 0; channel < format.numChannels; channel++) {
      const sampleOffset = frameOffset + channel * bytesPerSample;
      mixed +=
        format.audioFormat === 1
          ? pcmSampleToFloat(view, sampleOffset, format.bitsPerSample)
          : floatSampleToFloat(view, sampleOffset, format.bitsPerSample);
    }
    out[frame] = mixed / format.numChannels;
  }

  return { sampleRateHz: format.sampleRateHz, samples: out };
}

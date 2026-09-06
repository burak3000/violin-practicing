import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeFrequency, frequencyToCents, noteNameToFrequencyHz } from '@violin/core';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import {
  ANALYSIS_FRAME_SIZE,
  ANALYSIS_HOP_SIZE,
  PitchAnalysisPipeline,
  type AnalysisFrameResult,
} from './pitch-pipeline.js';
import { forViolin } from './pitch-types.js';
import { readWavFixture } from './test-support/wav-fixture.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DSP_NATIVE_TEST_DIR = resolve(HERE, '../../dsp-native/test');
const FIXTURES_DIR = resolve(DSP_NATIVE_TEST_DIR, 'fixtures');
const REFERENCE_DIR = resolve(DSP_NATIVE_TEST_DIR, 'reference');

const OCTAVE_ERROR_CENTS_THRESHOLD = 600;
// Phase 1's published synthetic YIN means/top-end maxes are all ~0-2c, and
// the plan repeatedly treats ~5c as the perceptual relevance threshold.
// Conformance between two implementations of the *same* validated algorithm
// should be much tighter than perceptual tolerance, while still allowing for
// tiny C++ vs JS floating-point/interpolation drift.
const SYNTHETIC_MEAN_CENTS_TOLERANCE = 0.1;
const SYNTHETIC_MAX_CENTS_TOLERANCE = 0.25;
const IOWA_STDDEV_CENTS_TOLERANCE = 1.0;
const SEGMENT_DURATION_TOLERANCE_S = ANALYSIS_HOP_SIZE / 44100;

interface SyntheticManifestEntry {
  readonly relativePath: string;
  readonly category: string;
  readonly waveform: string;
  readonly noteName: string;
  readonly frequencyHz: number;
  readonly sampleRateHz: number;
  readonly toneStartS: number;
  readonly toneEndS: number;
}

interface SyntheticReferenceRow {
  readonly category: string;
  readonly waveform: string;
  readonly noteName: string;
  readonly frequencyHz: number;
  readonly algorithm: string;
  readonly totalFrames: number;
  readonly voicedFrames: number;
  readonly meanAbsCentsError: number;
  readonly medianAbsCentsError: number;
  readonly maxAbsCentsError: number;
  readonly octaveErrorFrames: number;
  readonly onsetCount: number;
  readonly meanOnsetDurationS: number;
}

interface IowaReferenceRow {
  readonly filename: string;
  readonly algorithm: string;
  readonly hasGroundTruthRange: boolean;
  readonly totalFrames: number;
  readonly rawVoicedFrames: number;
  readonly rawInRangeVoiced: number;
  readonly rawOctaveErrorVoiced: number;
  readonly gatedVoicedFrames: number;
  readonly gatedInRangeVoiced: number;
  readonly gatedOctaveErrorVoiced: number;
  readonly onsetSegments: number;
  readonly meanSegmentDurationS: number;
  readonly meanSegmentStddevCents: number;
}

interface AnalyzedFrame {
  readonly startSample: number;
  readonly centerSample: number;
  readonly timeS: number;
  readonly result: AnalysisFrameResult;
}

interface SyntheticMeasurement {
  readonly totalFrames: number;
  readonly voicedFrames: number;
  readonly meanAbsCentsError: number;
  readonly medianAbsCentsError: number;
  readonly maxAbsCentsError: number;
  readonly octaveErrorFrames: number;
  readonly onsetCount: number;
  readonly meanOnsetDurationS: number;
  readonly detectedNoteLabels: readonly string[];
  readonly wrongNoteLabels: readonly string[];
}

interface IowaMeasurement {
  readonly totalFrames: number;
  readonly gatedVoicedFrames: number;
  readonly gatedInRangeVoiced: number;
  readonly gatedOctaveErrorVoiced: number;
  readonly onsetSegments: number;
  readonly meanSegmentDurationS: number;
  readonly meanSegmentStddevCents: number;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle]!;
  }
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function sampleStdDev(values: readonly number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const avg = mean(values);
  const sumSq = values.reduce((sum, value) => sum + (value - avg) ** 2, 0);
  return Math.sqrt(sumSq / (values.length - 1));
}

function parseCsv(path: string): Array<Record<string, string>> {
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  const header = lines.shift();
  if (header === undefined) {
    return [];
  }
  const columns = header.split(',');
  return lines.map((line) => {
    const fields = line.split(',');
    const row: Record<string, string> = {};
    for (let i = 0; i < columns.length; i++) {
      row[columns[i]!] = fields[i] ?? '';
    }
    return row;
  });
}

function readSyntheticManifest(): SyntheticManifestEntry[] {
  return parseCsv(resolve(FIXTURES_DIR, 'synthetic/manifest.csv')).map((row) => ({
    relativePath: row.relative_path,
    category: row.category,
    waveform: row.waveform,
    noteName: row.note_name,
    frequencyHz: Number(row.frequency_hz),
    sampleRateHz: Number(row.sample_rate_hz),
    toneStartS: Number(row.tone_start_s),
    toneEndS: Number(row.tone_end_s),
  }));
}

function readSyntheticReference(): Map<string, SyntheticReferenceRow> {
  const rows = parseCsv(resolve(REFERENCE_DIR, 'synthetic_results.csv'))
    .map((row) => ({
      category: row.category,
      waveform: row.waveform,
      noteName: row.note_name,
      frequencyHz: Number(row.frequency_hz),
      algorithm: row.algorithm,
      totalFrames: Number(row.total_frames),
      voicedFrames: Number(row.voiced_frames),
      meanAbsCentsError: Number(row.mean_abs_cents_error),
      medianAbsCentsError: Number(row.median_abs_cents_error),
      maxAbsCentsError: Number(row.max_abs_cents_error),
      octaveErrorFrames: Number(row.octave_error_frames),
      onsetCount: Number(row.onset_count),
      meanOnsetDurationS: Number(row.mean_onset_duration_s),
    }))
    .filter((row) => row.algorithm === 'YIN');

  return new Map(rows.map((row) => [syntheticKey(row.category, row.waveform, row.noteName), row]));
}

function readIowaReference(): Map<string, IowaReferenceRow> {
  const rows = parseCsv(resolve(REFERENCE_DIR, 'iowa_results.csv'))
    .map((row) => ({
      filename: row.filename,
      algorithm: row.algorithm,
      hasGroundTruthRange: row.has_ground_truth_range === '1',
      totalFrames: Number(row.total_frames),
      rawVoicedFrames: Number(row.raw_voiced_frames),
      rawInRangeVoiced: Number(row.raw_in_range_voiced),
      rawOctaveErrorVoiced: Number(row.raw_octave_error_voiced),
      gatedVoicedFrames: Number(row.gated_voiced_frames),
      gatedInRangeVoiced: Number(row.gated_in_range_voiced),
      gatedOctaveErrorVoiced: Number(row.gated_octave_error_voiced),
      onsetSegments: Number(row.onset_segments),
      meanSegmentDurationS: Number(row.mean_segment_duration_s),
      meanSegmentStddevCents: Number(row.mean_segment_stddev_cents),
    }))
    .filter((row) => row.algorithm === 'YIN');

  return new Map(rows.map((row) => [row.filename, row]));
}

function syntheticKey(category: string, waveform: string, noteName: string): string {
  return `${category}|${waveform}|${noteName}`;
}

function listIowaFixtureFilenames(): string[] {
  return readdirSync(resolve(FIXTURES_DIR, 'iowa'))
    .filter((name) => name.endsWith('.wav'))
    .sort();
}

function analyzeAudioFixture(samples: Float32Array, sampleRateHz: number): AnalyzedFrame[] {
  const pipeline = new PitchAnalysisPipeline(forViolin(sampleRateHz));
  const frames: AnalyzedFrame[] = [];
  for (
    let startSample = 0;
    startSample + ANALYSIS_FRAME_SIZE <= samples.length;
    startSample += ANALYSIS_HOP_SIZE
  ) {
    const frame = samples.subarray(startSample, startSample + ANALYSIS_FRAME_SIZE);
    frames.push({
      startSample,
      centerSample: startSample + ANALYSIS_FRAME_SIZE / 2,
      timeS: startSample / sampleRateHz,
      result: pipeline.analyzeFrame(frame),
    });
  }
  return frames;
}

function extractNoteRangeFromFilename(filename: string): readonly [number, number] | undefined {
  const tokens = filename.split(/[._\- ]+/).filter(Boolean);
  const rangePattern = /^([A-Ga-g][#b]?\d{1,2})([A-Ga-g][#b]?\d{1,2})$/;
  const singlePattern = /^([A-Ga-g][#b]?\d{1,2})$/;

  for (const token of tokens) {
    const match = rangePattern.exec(token);
    if (match !== null) {
      const lo = noteNameToFrequencyHz(match[1]!);
      const hi = noteNameToFrequencyHz(match[2]!);
      if (lo !== undefined && hi !== undefined) {
        return [Math.min(lo, hi), Math.max(lo, hi)] as const;
      }
    }
  }

  for (const token of tokens) {
    if (!singlePattern.test(token)) {
      continue;
    }
    const frequencyHz = noteNameToFrequencyHz(token);
    if (frequencyHz !== undefined) {
      return [frequencyHz, frequencyHz] as const;
    }
  }

  return undefined;
}

function measureSyntheticFixture(entry: SyntheticManifestEntry): SyntheticMeasurement {
  const fixture = readWavFixture(resolve(FIXTURES_DIR, 'synthetic', entry.relativePath));
  const frames = analyzeAudioFixture(fixture.samples, fixture.sampleRateHz);
  const toneStartSample = Math.trunc(entry.toneStartS * fixture.sampleRateHz);
  const toneEndSample = Math.trunc(entry.toneEndS * fixture.sampleRateHz);

  const absCentsErrors: number[] = [];
  const detectedNoteLabels: string[] = [];
  const wrongNoteLabels: string[] = [];
  const onsetDurations: number[] = [];
  let onsetCount = 0;
  let onsetStartTime = -1;
  let totalFrames = 0;
  let voicedFrames = 0;
  let octaveErrorFrames = 0;

  for (const frame of frames) {
    if (frame.result.noteOnset) {
      onsetCount += 1;
      onsetStartTime = frame.timeS;
    }
    if (frame.result.noteOffset && onsetStartTime >= 0) {
      onsetDurations.push(frame.timeS - onsetStartTime);
      onsetStartTime = -1;
    }

    if (frame.centerSample < toneStartSample || frame.centerSample >= toneEndSample) {
      continue;
    }

    totalFrames += 1;
    if (!frame.result.confirmedVoiced) {
      continue;
    }

    voicedFrames += 1;
    const cents = Math.abs(frequencyToCents(frame.result.frequencyHz, entry.frequencyHz));
    absCentsErrors.push(cents);
    if (cents > OCTAVE_ERROR_CENTS_THRESHOLD) {
      octaveErrorFrames += 1;
    }
    const noteLabel = analyzeFrequency(frame.result.frequencyHz).note.label;
    detectedNoteLabels.push(noteLabel);
    if (noteLabel !== entry.noteName) {
      wrongNoteLabels.push(noteLabel);
    }
  }

  return {
    totalFrames,
    voicedFrames,
    meanAbsCentsError: mean(absCentsErrors),
    medianAbsCentsError: median(absCentsErrors),
    maxAbsCentsError: absCentsErrors.length === 0 ? 0 : Math.max(...absCentsErrors),
    octaveErrorFrames,
    onsetCount,
    meanOnsetDurationS: mean(onsetDurations),
    detectedNoteLabels,
    wrongNoteLabels,
  };
}

function measureIowaFixture(filename: string): IowaMeasurement {
  const fixture = readWavFixture(resolve(FIXTURES_DIR, 'iowa', filename));
  const frames = analyzeAudioFixture(fixture.samples, fixture.sampleRateHz);
  const range = extractNoteRangeFromFilename(filename);
  const bandLow = range === undefined ? 0 : range[0] * 0.85;
  const bandHigh = range === undefined ? 0 : range[1] * 1.15;

  const segmentDurations: number[] = [];
  const segmentStdDevs: number[] = [];
  let onsetSegments = 0;
  let inSegment = false;
  let segmentStartTime = 0;
  let currentSegmentHz: number[] = [];
  let gatedVoicedFrames = 0;
  let gatedInRangeVoiced = 0;
  let gatedOctaveErrorVoiced = 0;

  for (const frame of frames) {
    if (frame.result.noteOnset) {
      inSegment = true;
      currentSegmentHz = [];
      segmentStartTime = frame.timeS;
    }

    if (inSegment && frame.result.confirmedVoiced) {
      currentSegmentHz.push(frame.result.frequencyHz);
    }

    if (frame.result.noteOffset && inSegment) {
      onsetSegments += 1;
      segmentDurations.push(frame.timeS - segmentStartTime);
      if (currentSegmentHz.length >= 2) {
        const meanHz = mean(currentSegmentHz);
        const centsDeviations = currentSegmentHz.map(
          (frequencyHz) => 1200 * Math.log2(frequencyHz / meanHz),
        );
        segmentStdDevs.push(sampleStdDev(centsDeviations));
      }
      inSegment = false;
    }

    if (!frame.result.confirmedVoiced) {
      continue;
    }

    gatedVoicedFrames += 1;
    if (range !== undefined) {
      const frequencyHz = frame.result.frequencyHz;
      if (frequencyHz >= bandLow && frequencyHz <= bandHigh) {
        gatedInRangeVoiced += 1;
      }
      if (frequencyHz < range[0] * 0.6 || frequencyHz > range[1] * 1.8) {
        gatedOctaveErrorVoiced += 1;
      }
    }
  }

  return {
    totalFrames: frames.length,
    gatedVoicedFrames,
    gatedInRangeVoiced,
    gatedOctaveErrorVoiced,
    onsetSegments,
    meanSegmentDurationS: mean(segmentDurations),
    meanSegmentStddevCents: mean(segmentStdDevs),
  };
}

const syntheticManifest = readSyntheticManifest();
const syntheticReference = readSyntheticReference();
const iowaReference = readIowaReference();
const iowaFilenames = listIowaFixtureFilenames();
let syntheticMeasurements = new Map<string, SyntheticMeasurement>();
let iowaMeasurements = new Map<string, IowaMeasurement>();

beforeAll(() => {
  syntheticMeasurements = new Map(
    syntheticManifest.map((entry) => [
      syntheticKey(entry.category, entry.waveform, entry.noteName),
      measureSyntheticFixture(entry),
    ]),
  );
  iowaMeasurements = new Map(
    iowaFilenames.map((filename) => [filename, measureIowaFixture(filename)]),
  );
}, 120_000);

describe('Phase 8 conformance vs dsp-native synthetic fixtures', () => {
  it('has a YIN reference row for every synthetic WAV fixture', () => {
    expect(syntheticReference.size).toBe(syntheticManifest.length);
    for (const entry of syntheticManifest) {
      expect(
        syntheticReference.has(syntheticKey(entry.category, entry.waveform, entry.noteName)),
      ).toBe(true);
    }
  });

  it.each(syntheticManifest)(
    '$relativePath matches dsp-native YIN note/cents/onset results',
    (entry) => {
      const key = syntheticKey(entry.category, entry.waveform, entry.noteName);
      const expected = syntheticReference.get(key);
      const actual = syntheticMeasurements.get(key);

      expect(expected).toBeDefined();
      expect(actual).toBeDefined();

      expect(actual!.totalFrames).toBe(expected!.totalFrames);
      expect(actual!.voicedFrames).toBe(expected!.voicedFrames);
      expect(actual!.octaveErrorFrames).toBe(expected!.octaveErrorFrames);
      expect(actual!.onsetCount).toBe(expected!.onsetCount);
      expect(actual!.wrongNoteLabels).toEqual([]);
      expect(actual!.detectedNoteLabels.length).toBeGreaterThan(0);

      expect(Math.abs(actual!.meanAbsCentsError - expected!.meanAbsCentsError)).toBeLessThanOrEqual(
        SYNTHETIC_MEAN_CENTS_TOLERANCE,
      );
      expect(
        Math.abs(actual!.medianAbsCentsError - expected!.medianAbsCentsError),
      ).toBeLessThanOrEqual(SYNTHETIC_MEAN_CENTS_TOLERANCE);
      expect(Math.abs(actual!.maxAbsCentsError - expected!.maxAbsCentsError)).toBeLessThanOrEqual(
        SYNTHETIC_MAX_CENTS_TOLERANCE,
      );
      expect(
        Math.abs(actual!.meanOnsetDurationS - expected!.meanOnsetDurationS),
      ).toBeLessThanOrEqual(SEGMENT_DURATION_TOLERANCE_S);
    },
  );
});

describe('Phase 8 conformance vs dsp-native Iowa violin fixtures', () => {
  it('has a YIN reference row for every Iowa WAV fixture', () => {
    expect(iowaReference.size).toBe(iowaFilenames.length);
    for (const filename of iowaFilenames) {
      expect(iowaReference.has(filename)).toBe(true);
    }
  });

  it.each(iowaFilenames)(
    '%s matches dsp-native YIN gated-voicing and onset/stability metrics',
    (filename) => {
      const expected = iowaReference.get(filename);
      const actual = iowaMeasurements.get(filename);

      expect(expected).toBeDefined();
      expect(actual).toBeDefined();

      expect(actual!.totalFrames).toBe(expected!.totalFrames);
      expect(actual!.gatedVoicedFrames).toBe(expected!.gatedVoicedFrames);
      expect(actual!.gatedInRangeVoiced).toBe(expected!.gatedInRangeVoiced);
      expect(actual!.gatedOctaveErrorVoiced).toBe(expected!.gatedOctaveErrorVoiced);
      expect(actual!.onsetSegments).toBe(expected!.onsetSegments);
      expect(
        Math.abs(actual!.meanSegmentDurationS - expected!.meanSegmentDurationS),
      ).toBeLessThanOrEqual(SEGMENT_DURATION_TOLERANCE_S);
      expect(
        Math.abs(actual!.meanSegmentStddevCents - expected!.meanSegmentStddevCents),
      ).toBeLessThanOrEqual(IOWA_STDDEV_CENTS_TOLERANCE);
    },
  );
});

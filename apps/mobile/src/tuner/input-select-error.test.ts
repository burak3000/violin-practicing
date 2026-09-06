import { describe, expect, it } from 'vitest';
import { describeInputSelectError } from './input-select-error';

describe('describeInputSelectError', () => {
  it('returns the fixed iOS-only explanation on Android regardless of the underlying error', () => {
    expect(describeInputSelectError(new Error('native boom'), true)).toBe(
      'Input selection is iOS-only in this version of react-native-audio-api; Android routes automatically.',
    );
    expect(describeInputSelectError('some string', true)).toBe(
      'Input selection is iOS-only in this version of react-native-audio-api; Android routes automatically.',
    );
    expect(describeInputSelectError(undefined, true)).toBe(
      'Input selection is iOS-only in this version of react-native-audio-api; Android routes automatically.',
    );
  });

  it('surfaces a real Error message verbatim on iOS', () => {
    expect(describeInputSelectError(new Error('device busy'), false)).toBe('device busy');
  });

  it('stringifies a non-Error thrown value on iOS', () => {
    expect(describeInputSelectError('a plain string rejection', false)).toBe(
      'a plain string rejection',
    );
    expect(describeInputSelectError(42, false)).toBe('42');
    expect(describeInputSelectError(undefined, false)).toBe('undefined');
  });
});

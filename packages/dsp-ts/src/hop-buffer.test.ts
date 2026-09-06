import { describe, expect, it } from 'vitest';
import { HopBuffer } from './hop-buffer.js';

describe('HopBuffer', () => {
  it('rejects an invalid hopSize', () => {
    expect(() => new HopBuffer(2048, 0)).toThrow(RangeError);
    expect(() => new HopBuffer(2048, 4096)).toThrow(RangeError);
  });

  it('emits nothing until frameSize samples have accumulated', () => {
    const buf = new HopBuffer(2048, 512);
    // 3 pushes of 512 = 1536 < 2048: no window yet.
    expect(buf.push(new Float32Array(512).fill(1))).toHaveLength(0);
    expect(buf.push(new Float32Array(512).fill(2))).toHaveLength(0);
    expect(buf.push(new Float32Array(512).fill(3))).toHaveLength(0);
    // 4th push reaches exactly 2048 filled AND a hop boundary.
    const windows = buf.push(new Float32Array(512).fill(4));
    expect(windows).toHaveLength(1);
    expect(windows[0]).toHaveLength(2048);
  });

  it('emits one window exactly every hopSize samples after the buffer first fills, mirroring 128-sample worklet render quanta', () => {
    const buf = new HopBuffer(2048, 512);
    let totalWindows = 0;
    // 128-sample chunks, matching AudioWorkletProcessor's fixed render
    // quantum -- 512 / 128 = 4 chunks per hop.
    for (let i = 0; i < 64; i++) {
      totalWindows += buf.push(new Float32Array(128).fill(i)).length;
    }
    // First window appears once 2048 samples (16 chunks) have accumulated;
    // thereafter one window every 4 chunks. 64 chunks = 8192 samples =
    // 4 full frames worth beyond the initial fill point:
    // floor((8192 - 2048) / 512) + 1 = 13.
    expect(totalWindows).toBe(13);
  });

  it('the returned window is the trailing frameSize samples in arrival order, most recent last', () => {
    const buf = new HopBuffer(8, 4);
    buf.push(Float32Array.from([1, 2, 3, 4]));
    const [window] = buf.push(Float32Array.from([5, 6, 7, 8]));
    expect(Array.from(window)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const [window2] = buf.push(Float32Array.from([9, 10, 11, 12]));
    expect(Array.from(window2)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('returned windows are independent copies, not views into internal state', () => {
    const buf = new HopBuffer(8, 4);
    buf.push(Float32Array.from([1, 2, 3, 4]));
    const [window] = buf.push(Float32Array.from([5, 6, 7, 8]));
    buf.push(Float32Array.from([100, 100, 100, 100]));
    expect(Array.from(window)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // unchanged by later pushes
  });

  it('handles a single push larger than hopSize by emitting multiple windows', () => {
    const buf = new HopBuffer(8, 4);
    // One big push of 12 samples: fills the 8-sample frame after the first
    // 8, then crosses one more 4-sample hop boundary.
    const windows = buf.push(Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    expect(windows).toHaveLength(2);
    expect(Array.from(windows[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Array.from(windows[1])).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('reset() clears fill state so a full frameSize must accumulate again', () => {
    const buf = new HopBuffer(8, 4);
    buf.push(Float32Array.from([1, 2, 3, 4]));
    buf.push(Float32Array.from([5, 6, 7, 8]));
    buf.reset();
    expect(buf.push(Float32Array.from([9, 10, 11, 12]))).toHaveLength(0);
  });
});

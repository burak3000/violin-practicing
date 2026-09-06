/**
 * Accumulates fixed-size input blocks into overlapping analysis windows,
 * advancing by `hopSize` each time.
 *
 * Exists because a real-time audio callback delivers input in whatever
 * block size the platform/library imposes -- Web Audio's
 * `AudioWorkletProcessor.process()` delivers exactly 128 samples per call
 * (a fixed browser/OS render-quantum size, not configurable; apps/desktop's
 * consumer), while React Native audio libraries typically deliver
 * larger, configurable chunks via an event callback (apps/mobile's
 * consumer) -- but packages/dsp-native's validated pipeline analyzes
 * 2048-sample windows every 512 samples (75% overlap) regardless -- see
 * packages/dsp-native/CLAUDE.md's "Numbers" section and
 * pitch-pipeline.ts's ANALYSIS_FRAME_SIZE/ANALYSIS_HOP_SIZE constants,
 * which this class is parameterized by, not hardcoded against. Writing the
 * push loop below to accept *any* input block length (not just 128) is
 * exactly what makes this same class reusable across both platforms'
 * different native delivery granularities with zero changes.
 */
export class HopBuffer {
  private readonly buffer: Float32Array;
  private filled = 0; // total samples seen so far, saturating at frameSize once full
  private sinceLastHop = 0;

  constructor(
    private readonly frameSize: number,
    private readonly hopSize: number,
  ) {
    if (!(hopSize > 0) || hopSize > frameSize) {
      throw new RangeError(
        `HopBuffer: hopSize (${hopSize}) must be in (0, frameSize=${frameSize}]`,
      );
    }
    this.buffer = new Float32Array(frameSize);
  }

  /**
   * Push one input block (any length -- on desktop this is always exactly
   * 128 samples inside a real AudioWorkletProcessor, but the loop below is
   * correct for arbitrary sizes, which is what makes it straightforward to
   * unit-test without a real AudioWorkletProcessor, and what lets
   * apps/mobile feed it its own, differently-sized native delivery chunks
   * unchanged). Returns zero or more trailing `frameSize`-sample windows
   * (fresh copies, safe to hold onto) -- one per hop boundary crossed by
   * this push. Returns an empty array before the buffer has accumulated a
   * full `frameSize` samples yet.
   */
  push(block: Float32Array): Float32Array[] {
    const results: Float32Array[] = [];
    let offset = 0;
    while (offset < block.length) {
      // Step by at most hopSize so we never skip over a hop boundary
      // within one call, however large `block` is.
      const take = Math.min(block.length - offset, this.hopSize);

      // Slide the window left by `take`, then fill the newly-opened tail
      // with the incoming chunk -- a linear (not circular) sliding buffer,
      // simplest to reason about; at these sizes (2048 samples, 512-sample
      // hop, 44.1kHz) the O(frameSize) copy per hop is microseconds, not a
      // real cost against the ~11.6ms hop budget (see
      // apps/desktop/CLAUDE.md's latency numbers).
      this.buffer.copyWithin(0, take);
      this.buffer.set(block.subarray(offset, offset + take), this.frameSize - take);
      offset += take;

      // Samples that arrive *before* the buffer has ever filled don't
      // count as hop-boundary backlog -- only start the hop clock once a
      // full window first exists. Without this guard, `sinceLastHop` would
      // silently accumulate the entire fill-up period (frameSize/hopSize
      // hops' worth), and the very first `filled >= frameSize` call would
      // then drain that backlog as a burst of closely-spaced,
      // near-duplicate windows instead of the single correct one -- caught
      // by hop-buffer.test.ts's cadence test during implementation.
      const wasFull = this.filled >= this.frameSize;
      this.filled = Math.min(this.frameSize, this.filled + take);
      const justBecameFull = !wasFull && this.filled >= this.frameSize;

      if (justBecameFull) {
        this.sinceLastHop = 0;
        results.push(this.buffer.slice());
      } else if (wasFull) {
        this.sinceLastHop += take;
        if (this.sinceLastHop >= this.hopSize) {
          this.sinceLastHop -= this.hopSize;
          results.push(this.buffer.slice());
        }
      }
    }
    return results;
  }

  reset(): void {
    this.buffer.fill(0);
    this.filled = 0;
    this.sinceLastHop = 0;
  }
}

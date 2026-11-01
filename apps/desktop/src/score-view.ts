/**
 * Draws a window of a piece's sheet music (key signature, accidentals, note
 * values, bar lines ...) into a container, and lets the owner recolour
 * individual notes and move a playhead across it *without redrawing it*.
 *
 * All geometry is `packages/core`'s (`sizeScore` picks the size of a staff
 * space and which bars fit; `scoreLayoutToSvg` writes the markup); this file
 * only owns the DOM side: the full-bleed sizing, remembering which SVG
 * elements belong to which practice note (`data-note`), and the cheap
 * per-frame updates. Shared by the timed play-along (`play-along-view.ts`) and
 * the Wait-for-me session when an ABC piece is being practiced
 * (`practice-session-view.ts`).
 *
 * ## Redraw policy
 *
 * Building the SVG is the expensive part, so `show(firstBar)` rebuilds it only
 * when the first bar, the window size or the height cap changed; a note
 * changing colour or the playhead moving is a couple of attribute writes on
 * elements already in the DOM.
 *
 * ## Colours
 *
 * Note colour is a `data-state` attribute on every element of that note (head,
 * stem, accidental, dots, ledger lines, tie), styled in `index.css`
 * (`.score [data-state='hit']` ...). Beams, rests and bar lines belong to no
 * single note and keep the default ink.
 */

import {
  barIndexAtWhole,
  scoreLayoutToSvg,
  sizeScore,
  type AbcPiece,
  type FingerMark,
  type PlayAlongNoteDisplayState,
  type ScoreLayout,
  type ScoreSize,
} from '@violin/core';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Upper bound on the score's height, so on a very tall window it doesn't grow without limit. */
const SCORE_MAX_HEIGHT_PX = 380;
/** Fraction of the window height the score may use. */
const SCORE_MAX_HEIGHT_FRACTION = 0.4;
/** Width of the playhead line in staff spaces (about 3px at a typical size). */
const PLAYHEAD_WIDTH_SPACES = 0.16;
/** When more bars are wanted on screen than fit, the staff space shrinks by this factor per attempt ... */
const SHRINK_FACTOR = 0.82;
/** ... but never below this many px (a staff 4 spaces tall is then ~48px: small, still legible on a desktop monitor). */
const SHRINK_FLOOR_UNIT_PX = 12;
/** Core's own upper bound on the preferred staff-space size (`sizeScore`'s `maxUnitPx` default). */
const DEFAULT_MAX_UNIT_PX = 34;

export type ScoreNoteState = PlayAlongNoteDisplayState;

export class ScoreView {
  private layout: ScoreLayout | undefined;
  private svg: SVGSVGElement | undefined;
  private playhead: SVGLineElement | undefined;
  /** The SVG elements of each practice note shown in the current window. */
  private readonly partsByNote = new Map<number, Element[]>();
  /** The state last written to a note's elements, so only changes touch the DOM. */
  private readonly applied = new Map<number, ScoreNoteState>();
  /** Finger numbers to draw over the notes (`fingerMarksOf` for the piece's notes); none by default. */
  private fingers: readonly (FingerMark | undefined)[] | undefined;
  /** What the current drawing was built for: `firstBar|width|maxHeight|minBars`. */
  private drawnKey: string | undefined;

  constructor(
    private readonly container: HTMLElement,
    private readonly piece: AbcPiece,
  ) {}

  /** The bar a position in the piece (whole notes) is in. */
  barAt(whole: number): number {
    return barIndexAtWhole(this.piece, whole);
  }

  /** Shows (or, with `undefined`, hides) finger numbers; takes effect at the next `show`. */
  setFingers(marks: readonly (FingerMark | undefined)[] | undefined): void {
    this.fingers = marks;
    this.drawnKey = undefined;
  }

  /** Empties the container. */
  clear(): void {
    this.container.replaceChildren();
    this.layout = undefined;
    this.svg = undefined;
    this.playhead = undefined;
    this.partsByNote.clear();
    this.applied.clear();
    this.drawnKey = undefined;
  }

  /**
   * Makes the window start at `firstBar`, redrawing only if that (or the
   * window's size) changed. Returns true if it redrew; the caller then needs to
   * re-apply any note states it cares about -- they are kept in `applied` only
   * as a cache, and a fresh drawing starts with none applied.
   *
   * The score is full-bleed, like the single-note staff: as wide as the visible
   * window, centered on the narrow column the rest of the page lives in.
   *
   * `minBars`: the play-along wants to see the *next* bar too, to read ahead.
   * `sizeScore` makes the notation as large as the width allows, which for a
   * busy bar leaves room for just one; when fewer than `minBars` bars fit (and
   * the piece has that many left), the staff space is shrunk step by step --
   * through `sizeScore`'s own `maxUnitPx`, so the layout stays core's -- until
   * they do or the notation would become too small to read.
   */
  show(firstBar: number, minBars = 1): boolean {
    const viewportWidth = document.documentElement.clientWidth;
    const maxHeight = Math.min(window.innerHeight * SCORE_MAX_HEIGHT_FRACTION, SCORE_MAX_HEIGHT_PX);
    const key = `${firstBar}|${viewportWidth}|${Math.round(maxHeight)}|${minBars}`;
    if (key === this.drawnKey && this.svg !== undefined) return false;

    this.container.style.width = `${viewportWidth}px`;
    this.container.style.marginInline = `calc(50% - ${viewportWidth / 2}px)`;

    const sizeAt = (maxUnitPx: number): ScoreSize =>
      sizeScore(this.piece, {
        firstBar,
        availableWidthPx: viewportWidth,
        maxHeightPx: maxHeight,
        maxUnitPx,
        fingers: this.fingers,
      });
    let maxUnit = DEFAULT_MAX_UNIT_PX;
    let size = sizeAt(maxUnit);
    const wantedLastBar = Math.min(firstBar + minBars - 1, this.piece.barCount - 1);
    while (size.layout.lastBar < wantedLastBar && size.unitPx > SHRINK_FLOOR_UNIT_PX) {
      maxUnit = Math.max(SHRINK_FLOOR_UNIT_PX, Math.min(maxUnit, size.unitPx) * SHRINK_FACTOR);
      size = sizeAt(maxUnit);
    }
    this.layout = size.layout;
    // Safe to inject: scoreLayoutToSvg writes only numbers and a fixed set of tag/attribute names (see its doc comment).
    this.container.innerHTML = scoreLayoutToSvg(size.layout, { unitPx: size.unitPx });
    const svg = this.container.firstElementChild;
    if (!(svg instanceof SVGSVGElement)) {
      this.clear();
      return true;
    }
    this.svg = svg;
    svg.classList.add('score');
    svg.setAttribute('role', 'img');
    svg.setAttribute('focusable', 'false');
    const { firstBar: first, lastBar } = size.layout;
    svg.setAttribute(
      'aria-label',
      first === lastBar ? `Sheet music, bar ${first}` : `Sheet music, bars ${first} to ${lastBar}`,
    );

    // Index the elements of each note once per drawing.
    this.partsByNote.clear();
    this.applied.clear();
    for (const element of svg.querySelectorAll('[data-note]')) {
      const index = Number(element.getAttribute('data-note'));
      const list = this.partsByNote.get(index);
      if (list) list.push(element);
      else this.partsByNote.set(index, [element]);
    }

    // The playhead goes last so it draws on top. A transform, so moving it is one attribute write.
    const [, minY, , height] = size.layout.viewBox;
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('class', 'score-playhead');
    line.setAttribute('x1', '0');
    line.setAttribute('x2', '0');
    line.setAttribute('y1', String(minY));
    line.setAttribute('y2', String(minY + height));
    line.setAttribute('stroke-width', String(PLAYHEAD_WIDTH_SPACES));
    line.setAttribute('visibility', 'hidden');
    svg.append(line);
    this.playhead = line;

    this.drawnKey = key;
    return true;
  }

  /** Colours one note (all of its parts). A note that is not in the window is ignored. */
  setNoteState(noteIndex: number, state: ScoreNoteState): void {
    if (this.applied.get(noteIndex) === state) return;
    const parts = this.partsByNote.get(noteIndex);
    if (parts === undefined) return;
    this.applied.set(noteIndex, state);
    for (const part of parts) {
      if (state === 'pending') part.removeAttribute('data-state');
      else part.setAttribute('data-state', state);
    }
  }

  /** Applies `stateOf(noteIndex)` to every note in the window. */
  applyStates(stateOf: (noteIndex: number) => ScoreNoteState): void {
    for (const noteIndex of this.partsByNote.keys())
      this.setNoteState(noteIndex, stateOf(noteIndex));
  }

  /**
   * Puts the playhead at a position in the piece (whole notes; negative =
   * before the music), or hides it with `undefined`. `dimmed` draws it faintly:
   * parked at the first note during the count-in.
   */
  setPlayhead(whole: number | undefined, dimmed = false): void {
    const line = this.playhead;
    if (!line) return;
    if (whole === undefined || this.layout === undefined) {
      if (line.getAttribute('visibility') !== 'hidden') line.setAttribute('visibility', 'hidden');
      return;
    }
    const x = this.layout.xForWhole(whole);
    line.setAttribute('transform', `translate(${x.toFixed(3)} 0)`);
    line.setAttribute('visibility', 'visible');
    line.setAttribute('opacity', dimmed ? '0.35' : '1');
  }
}

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, G, Line, Path, Polygon } from 'react-native-svg';
import {
  STAFF_GLYPHS,
  sizeScore,
  type AbcPiece,
  type FingerMark,
  type PlayAlongNoteDisplayState,
  type PlayAlongRunView,
  type ScoreLayout,
  type ScorePrimitive,
} from '@violin/core';
import { SCREEN_PADDING_PX } from './StaffView';

/**
 * The notated score of an ABC piece (note values, rests, bar lines, key and
 * time signatures, beams, ties, accidentals only where a printed sheet carries
 * them), drawn with react-native-svg from `packages/core`'s pure `sizeScore` /
 * `layoutScore` geometry. Core hands over a flat list of drawing primitives
 * (lines, Bravura glyph outlines, polygons, paths, circles) in staff-space
 * units; this file's only job is to map each onto the matching `react-native-svg`
 * element -- `score-svg.ts` in core does the same for desktop, so the two apps
 * cannot disagree about what a primitive means. No notation geometry lives
 * here.
 *
 * Used two ways:
 *  - **Wait for me** (Staff display of an ABC session): the window starting at
 *    the target note's bar with the target (`targetIndex`) highlighted.
 *  - **Play along**: the window starting at the current bar, every note
 *    coloured by its state (`noteStates`: due / hit / missed / pending) and a
 *    moving playhead.
 *
 * ## Rendering cost
 *
 * A window holds a few hundred primitives and the play-along redraws it as notes
 * resolve (a few times a second at most), so each primitive is its own memoized
 * element keyed on (primitive, colour): when one note turns green only that
 * note's heads/stems/etc. are re-rendered. The playhead is a separate tiny
 * component fed by `playhead.subscribe`, so moving it ~30 times a second never
 * re-renders the score. Full-bleed like `StaffView` (cancels the screen's own
 * horizontal padding).
 */

const INK = '#1a1a1a';
/** The note the player should be on / the target. */
const COLOR_DUE = '#2563eb';
const COLOR_HIT = '#1a7f37';
const COLOR_MISSED = '#b91c1c';

/** Never taller than this (px), whatever the width. */
const MAX_SCORE_HEIGHT_PX = 260;

/** Something that can tell the playhead where the run is, ~30 times a second. `subscribe` returns an unsubscribe function and should call the listener at once with the latest view if it has one. */
export interface PlayheadSource {
  subscribe(listener: (view: PlayAlongRunView) => void): () => void;
}

/** The colour of a primitive: notes by state / target, everything else ink. */
function colorOf(
  noteIndex: number | undefined,
  noteStates: readonly PlayAlongNoteDisplayState[] | undefined,
  targetIndex: number | undefined,
): string {
  if (noteIndex === undefined) return INK;
  if (noteIndex === targetIndex) return COLOR_DUE;
  switch (noteStates?.[noteIndex]) {
    case 'due':
      return COLOR_DUE;
    case 'hit':
      return COLOR_HIT;
    case 'missed':
      return COLOR_MISSED;
    default:
      return INK;
  }
}

const PrimitiveElement = memo(function PrimitiveElement({
  primitive: p,
  color,
}: {
  primitive: ScorePrimitive;
  color: string;
}) {
  switch (p.kind) {
    case 'line':
      return <Line x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} stroke={color} strokeWidth={p.width} />;
    case 'glyph':
      return (
        <G transform={`translate(${p.x} ${p.y})`}>
          <Path d={STAFF_GLYPHS[p.glyph].path} fill={color} />
        </G>
      );
    case 'polygon':
      return <Polygon points={p.points.map((pt) => `${pt[0]},${pt[1]}`).join(' ')} fill={color} />;
    case 'path':
      return p.filled ? (
        <Path d={p.d} fill={color} />
      ) : (
        <Path
          d={p.d}
          fill="none"
          stroke={color}
          strokeWidth={p.width}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    case 'circle':
      return <Circle cx={p.cx} cy={p.cy} r={p.r} fill={color} />;
  }
});

/** The drawing itself. `noteStates` keeps its identity until a state changes, so React skips this entirely between changes. */
const ScoreDrawing = memo(function ScoreDrawing({
  layout,
  unitPx,
  noteStates,
  targetIndex,
}: {
  layout: ScoreLayout;
  unitPx: number;
  noteStates: readonly PlayAlongNoteDisplayState[] | undefined;
  targetIndex: number | undefined;
}) {
  const [minX, minY, width, height] = layout.viewBox;
  return (
    <Svg
      width={width * unitPx}
      height={height * unitPx}
      viewBox={`${minX} ${minY} ${width} ${height}`}
    >
      {layout.primitives.map((primitive, i) => (
        <PrimitiveElement
          key={i}
          primitive={primitive}
          color={colorOf(primitive.noteIndex, noteStates, targetIndex)}
        />
      ))}
    </Svg>
  );
});

/** The play-along cursor: a thin vertical line that follows the run's position along the window. */
function Playhead({
  layout,
  unitPx,
  source,
}: {
  layout: ScoreLayout;
  unitPx: number;
  source: PlayheadSource;
}) {
  const [x, setX] = useState<number | undefined>(undefined);
  useEffect(() => {
    return source.subscribe((view) => {
      if (view.phase !== 'playing') {
        setX(undefined);
        return;
      }
      // Half-pixel steps: finer movement is invisible and each distinct value is a render.
      const next =
        Math.round((layout.xForWhole(view.positionWhole) - layout.viewBox[0]) * unitPx * 2) / 2;
      setX((previous) => (previous === next ? previous : next));
    });
  }, [layout, unitPx, source]);
  if (x === undefined) return null;
  return <View pointerEvents="none" style={[styles.playhead, { left: x - 1 }]} />;
}

export function ScoreView({
  piece,
  firstBar,
  noteStates,
  targetIndex,
  playhead,
  fingers,
}: {
  piece: AbcPiece;
  /** Finger numbers to draw over the notes (`fingerMarksOf`); keep the array's identity stable between renders. */
  fingers?: readonly (FingerMark | undefined)[];
  /** The bar the window starts at (0-based). */
  firstBar: number;
  /** Play-along: one state per note, coloured accordingly. */
  noteStates?: readonly PlayAlongNoteDisplayState[];
  /** Wait for me: the note to highlight. */
  targetIndex?: number;
  /** Play-along: draws a moving playhead. */
  playhead?: PlayheadSource;
}) {
  const [availableWidth, setAvailableWidth] = useState<number | undefined>(undefined);
  const size = useMemo(
    () =>
      availableWidth === undefined || availableWidth <= 0
        ? undefined
        : sizeScore(piece, {
            firstBar,
            availableWidthPx: availableWidth,
            maxHeightPx: MAX_SCORE_HEIGHT_PX,
            fingers,
          }),
    [piece, firstBar, availableWidth, fingers],
  );

  // Windows differ slightly in height (ledger lines, high notes); never shrink
  // below the tallest seen so the content under the score does not jump.
  const tallest = useRef(0);
  if (size && size.heightPx > tallest.current) tallest.current = size.heightPx;

  const onLayout = (event: LayoutChangeEvent): void => {
    setAvailableWidth(event.nativeEvent.layout.width);
  };

  return (
    <View
      style={[styles.container, { minHeight: Math.max(120, tallest.current) }]}
      onLayout={onLayout}
      accessible
      accessibilityRole="image"
      accessibilityLabel={
        size
          ? `Sheet music, bars ${size.layout.firstBar + 1} to ${size.layout.lastBar + 1} of ${piece.barCount}`
          : 'Sheet music'
      }
    >
      {size && (
        <View style={{ width: size.widthPx, height: size.heightPx }}>
          <ScoreDrawing
            layout={size.layout}
            unitPx={size.unitPx}
            noteStates={noteStates}
            targetIndex={targetIndex}
          />
          {playhead && <Playhead layout={size.layout} unitPx={size.unitPx} source={playhead} />}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // `alignSelf: 'stretch'` so onLayout measures the *available* width even
  // inside a centered column (see StaffView for the same reasoning). The
  // drawing is left-aligned: the last window of a piece is not stretched to
  // the full width, and the playhead's x is measured from the drawing's left.
  container: {
    alignSelf: 'stretch',
    alignItems: 'flex-start',
    marginHorizontal: -SCREEN_PADDING_PX,
  },
  playhead: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: 'rgba(37, 99, 235, 0.55)',
  },
});

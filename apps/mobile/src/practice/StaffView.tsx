import { useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { G, Line, Path } from 'react-native-svg';
import {
  STAFF_GLYPHS,
  formatSpelling,
  sizeStaff,
  type StaffGlyphName,
  type StaffNote,
} from '@violin/core';

/**
 * A treble-clef staff with notes, drawn with react-native-svg from
 * `packages/core`'s pure `layoutStaff` geometry and embedded Bravura glyph
 * outlines -- the same positions and shapes apps/desktop's `staff-svg.ts`
 * draws, so the two apps show identical staves with no music font involved
 * (React Native can't rely on one). The target note is near-black, upcoming
 * notes lighter, matching desktop's colors.
 *
 * Full-bleed: the staff fills the whole screen width, edge to edge (its
 * container cancels the screen's own horizontal padding), with the staff lines
 * running across and the notes spread along them. `sizeStaff` (packages/core,
 * shared with desktop) picks the size of a staff space from the width, and
 * shrinks the whole staff if five notes with accidentals wouldn't otherwise
 * fit a narrow phone.
 */

/**
 * The horizontal padding of the screen's scroll content in App.tsx (`styles.
 * scroll.padding`); the staff pulls out by this much on each side to reach
 * the screen edges. Keep in sync with that style.
 */
export const SCREEN_PADDING_PX = 16;

/** Never taller than this (px), whatever the width -- e.g. on a tablet. */
const MAX_STAFF_HEIGHT_PX = 240;

const INK = '#1a1a1a';
const INK_UPCOMING = '#a3a3a3';

/** Accessible description: the target, then what follows it. */
function describe(notes: ReadonlyArray<Pick<StaffNote, 'spelling' | 'role'>>): string {
  const target = notes.find((n) => n.role === 'target');
  const upcoming = notes.filter((n) => n.role === 'upcoming');
  const parts = [target ? `Target note ${formatSpelling(target.spelling)}` : 'No target note'];
  if (upcoming.length > 0) {
    parts.push(`then ${upcoming.map((n) => formatSpelling(n.spelling)).join(' ')}`);
  }
  return parts.join(', ');
}

function Glyph({
  glyph,
  x,
  y,
  color,
}: {
  glyph: StaffGlyphName;
  x: number;
  y: number;
  color: string;
}) {
  return (
    <G transform={`translate(${x} ${y})`}>
      <Path d={STAFF_GLYPHS[glyph].path} fill={color} />
    </G>
  );
}

/**
 * `lookahead`: the notes after the first are a preview of what's coming --
 * draw as many as fit across the width (see `sizeStaff`), left-aligned so the
 * target stays put, instead of all of them.
 */
export function StaffView({
  notes,
  lookahead,
}: {
  notes: readonly StaffNote[];
  lookahead: boolean;
}) {
  const [availableWidth, setAvailableWidth] = useState<number | undefined>(undefined);
  const size = useMemo(
    () =>
      availableWidth === undefined || availableWidth <= 0
        ? undefined
        : sizeStaff(notes, availableWidth, { maxHeightPx: MAX_STAFF_HEIGHT_PX, lookahead }),
    [notes, availableWidth, lookahead],
  );

  const onLayout = (event: LayoutChangeEvent): void => {
    setAvailableWidth(event.nativeEvent.layout.width);
  };

  return (
    <View
      style={styles.container}
      onLayout={onLayout}
      accessible
      accessibilityRole="image"
      accessibilityLabel={describe(size ? size.layout.notes : notes)}
    >
      {size && (
        <Svg width={size.widthPx} height={size.heightPx} viewBox={size.layout.viewBox.join(' ')}>
          {size.layout.lineYs.map((y) => (
            <Line
              key={y}
              x1={size.layout.lineX1}
              x2={size.layout.lineX2}
              y1={y}
              y2={y}
              stroke={INK}
              strokeWidth={size.layout.lineWidth}
            />
          ))}
          <Glyph
            glyph={size.layout.clef.glyph}
            x={size.layout.clef.x}
            y={size.layout.clef.y}
            color={INK}
          />
          {size.layout.notes.map((note, i) => {
            const color = note.role === 'target' ? INK : INK_UPCOMING;
            return (
              <G key={i}>
                {note.ledgerLines.map((ledger, j) => (
                  <Line
                    key={j}
                    x1={ledger.x1}
                    x2={ledger.x2}
                    y1={ledger.y}
                    y2={ledger.y}
                    stroke={color}
                    strokeWidth={size.layout.lineWidth}
                  />
                ))}
                {note.accidental && (
                  <Glyph
                    glyph={note.accidental.glyph}
                    x={note.accidental.x}
                    y={note.y}
                    color={color}
                  />
                )}
                <Glyph glyph="noteheadBlack" x={note.x} y={note.y} color={color} />
                <Line
                  x1={note.stem.x}
                  x2={note.stem.x}
                  y1={note.stem.y1}
                  y2={note.stem.y2}
                  stroke={color}
                  strokeWidth={size.layout.stemWidth}
                />
              </G>
            );
          })}
        </Svg>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // `alignSelf: 'stretch'` so onLayout measures the *available* width even
  // inside the session panel's `alignItems: 'center'` column (a centered
  // child with nothing in it yet would measure 0 and never draw).
  container: {
    alignSelf: 'stretch',
    alignItems: 'center',
    marginHorizontal: -SCREEN_PADDING_PX,
    minHeight: 120,
  },
});

import React from 'react';
import { View, Platform, StyleSheet } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import { BarColors } from '../constants/theme';

interface Segment {
  /** Fraction of total width (0-1) */
  fraction: number;
  /** Custom gradient colors [start, mid, end] or use defaults */
  colors?: [string, string, string];
  shadowColor?: string;
}

interface Props {
  width: number;
  height: number;
  segments: Segment[];
  /** Border radius for pill shape */
  radius?: number;
}

export function GlossyHorizontalBar({ width, height, segments, radius = 4 }: Props) {
  if (width <= 0 || height <= 0) return null;

  // Calculate x positions for each segment
  let runningX = 0;
  const rects = segments.map((seg, i) => {
    const segW = Math.max(seg.fraction * width, 0);
    const x = runningX;
    runningX += segW;
    return { ...seg, x, segW, index: i };
  });

  return (
    <View style={[shadowStyles.container, { width, height }]}>
      <Svg width={width} height={height}>
        <Defs>
          {rects.map((r) => {
            const colors = r.colors || [BarColors.greenStart, BarColors.greenMid, BarColors.greenEnd];
            return (
              <React.Fragment key={`defs-${r.index}`}>
                <LinearGradient id={`hGrad${r.index}`} x1="0" y1="1" x2="0" y2="0">
                  <Stop offset="0" stopColor={colors[0]} />
                  <Stop offset="0.5" stopColor={colors[1]} />
                  <Stop offset="1" stopColor={colors[2]} />
                </LinearGradient>
                <LinearGradient id={`hHighlight${r.index}`} x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor="white" stopOpacity="0.5" />
                  <Stop offset="0.4" stopColor="white" stopOpacity="0.1" />
                  <Stop offset="1" stopColor="white" stopOpacity="0" />
                </LinearGradient>
              </React.Fragment>
            );
          })}
        </Defs>
        {rects.map((r) => {
          if (r.segW < 1) return null;
          // Only apply border radius at the edges
          const isFirst = r.index === 0;
          const isLast = r.index === rects.length - 1;
          const rx = (isFirst || isLast) ? radius : 0;

          return (
            <React.Fragment key={r.index}>
              <Rect
                x={r.x}
                y={0}
                width={r.segW}
                height={height}
                rx={rx}
                ry={rx}
                fill={`url(#hGrad${r.index})`}
              />
              <Rect
                x={r.x}
                y={0}
                width={r.segW}
                height={height * 0.5}
                rx={rx}
                ry={rx}
                fill={`url(#hHighlight${r.index})`}
              />
            </React.Fragment>
          );
        })}
      </Svg>
    </View>
  );
}

const shadowStyles = StyleSheet.create({
  container: {
    ...Platform.select({
      ios: {
        shadowColor: BarColors.barShadow,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.3,
        shadowRadius: 4,
      },
      android: { elevation: 3 },
    }),
  },
});

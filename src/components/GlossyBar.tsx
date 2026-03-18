import React from 'react';
import { View, Platform, StyleSheet } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import { BarColors } from '../constants/theme';

interface GlossyBarProps {
  width: number;
  height: number;
  bars: {
    x: number;
    y: number;
    width: number;
    height: number;
    isActual: boolean;
    isNegative?: boolean;
  }[];
}

const PILL_RADIUS = 6;

export function GlossyBarSvg({ width, height, bars }: GlossyBarProps) {
  if (width <= 0 || height <= 0) return null;

  return (
    <View style={[shadowStyles.container, { width, height }]}>
      <Svg width={width} height={height}>
        <Defs>
          {/* Actual positive (green) — bottom to top */}
          <LinearGradient id="gradGreen" x1="0" y1="1" x2="0" y2="0">
            <Stop offset="0" stopColor={BarColors.greenStart} />
            <Stop offset="0.5" stopColor={BarColors.greenMid} />
            <Stop offset="1" stopColor={BarColors.greenEnd} />
          </LinearGradient>
          {/* Actual negative (red) — top to bottom for downward bars */}
          <LinearGradient id="gradRed" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={BarColors.redStart} />
            <Stop offset="0.5" stopColor={BarColors.redMid} />
            <Stop offset="1" stopColor={BarColors.redEnd} />
          </LinearGradient>
          {/* Projected — pastel pink, bottom to top */}
          <LinearGradient id="gradProjected" x1="0" y1="1" x2="0" y2="0">
            <Stop offset="0" stopColor={BarColors.projectedStart} />
            <Stop offset="0.5" stopColor={BarColors.projectedMid} />
            <Stop offset="1" stopColor={BarColors.projectedEnd} />
          </LinearGradient>
          {/* Projected flipped for negative */}
          <LinearGradient id="gradProjectedNeg" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={BarColors.projectedStart} />
            <Stop offset="0.5" stopColor={BarColors.projectedMid} />
            <Stop offset="1" stopColor={BarColors.projectedEnd} />
          </LinearGradient>
          {/* White highlight */}
          <LinearGradient id="highlight" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="white" stopOpacity="0.5" />
            <Stop offset="0.35" stopColor="white" stopOpacity="0.12" />
            <Stop offset="1" stopColor="white" stopOpacity="0" />
          </LinearGradient>
        </Defs>
        {bars.map((bar, i) => {
          if (bar.height < 1) return null;

          let gradId: string;
          if (!bar.isActual) {
            gradId = bar.isNegative ? 'gradProjectedNeg' : 'gradProjected';
          } else {
            gradId = bar.isNegative ? 'gradRed' : 'gradGreen';
          }

          return (
            <React.Fragment key={i}>
              <Rect
                x={bar.x}
                y={bar.y}
                width={bar.width}
                height={bar.height}
                rx={PILL_RADIUS}
                ry={PILL_RADIUS}
                fill={`url(#${gradId})`}
              />
              <Rect
                x={bar.x}
                y={bar.y}
                width={bar.width}
                height={Math.min(bar.height, bar.height * 0.5)}
                rx={PILL_RADIUS}
                ry={PILL_RADIUS}
                fill="url(#highlight)"
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
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.4,
        shadowRadius: 6,
      },
      android: { elevation: 4 },
    }),
  },
});

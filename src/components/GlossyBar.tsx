import React from 'react';
import { View, Platform, StyleSheet } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Stop, Rect, Polyline, Circle, Ellipse, Path } from 'react-native-svg';
import { BarColors } from '../constants/theme';

interface OverlayLinePoint {
  x: number;
  y: number;
}

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
    colorType?: 'green' | 'red';
  }[];
  projectionBars?: ({ x: number; y: number; width: number; height: number } | null)[];
  overlayLine?: {
    points: OverlayLinePoint[];
    color: string;
  };
}

const R = 6;

export function GlossyBarSvg({ width, height, bars, projectionBars, overlayLine }: GlossyBarProps) {
  if (width <= 0 || height <= 0) return null;

  return (
    <View style={[shadowStyles.container, { width, height }]}>
      <Svg width={width} height={height}>
        <Defs>
          {/* ══════════════════════════════════════════════
              BAR GRADIENTS — vibrant fills for light backgrounds
              ══════════════════════════════════════════════ */}

          {/* Green — solid emerald with subtle gradient */}
          <LinearGradient id="gG" x1="0" y1="1" x2="0" y2="0">
            <Stop offset="0"    stopColor="#059669" stopOpacity="1" />
            <Stop offset="0.4"  stopColor="#10B981" stopOpacity="1" />
            <Stop offset="0.7"  stopColor="#1ECE6E" stopOpacity="0.95" />
            <Stop offset="1"    stopColor="#34D399" stopOpacity="0.85" />
          </LinearGradient>

          {/* Red — solid ruby with subtle gradient */}
          <LinearGradient id="gR" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0"    stopColor="#DC2626" stopOpacity="1" />
            <Stop offset="0.4"  stopColor="#EF4444" stopOpacity="1" />
            <Stop offset="0.7"  stopColor="#F87171" stopOpacity="0.95" />
            <Stop offset="1"    stopColor="#FCA5A5" stopOpacity="0.85" />
          </LinearGradient>

          {/* Projected — solid grey */}
          <LinearGradient id="gP" x1="0" y1="1" x2="0" y2="0">
            <Stop offset="0"   stopColor="#9CA3AF" stopOpacity="0.7" />
            <Stop offset="0.5" stopColor="#D1D5DB" stopOpacity="0.6" />
            <Stop offset="1"   stopColor="#E5E7EB" stopOpacity="0.5" />
          </LinearGradient>
          <LinearGradient id="gPN" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0"   stopColor="#9CA3AF" stopOpacity="0.7" />
            <Stop offset="0.5" stopColor="#D1D5DB" stopOpacity="0.6" />
            <Stop offset="1"   stopColor="#E5E7EB" stopOpacity="0.5" />
          </LinearGradient>

          {/* ══════════════════════════════════════════════
              GLASS EFFECT LAYERS — iOS 26 liquid glass
              ══════════════════════════════════════════════ */}

          {/* Top refraction — very subtle */}
          <LinearGradient id="hl" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0"    stopColor="white" stopOpacity="0.15" />
            <Stop offset="0.1"  stopColor="white" stopOpacity="0.05" />
            <Stop offset="0.25" stopColor="white" stopOpacity="0" />
          </LinearGradient>

          {/* Bottom inner glow — minimal */}
          <LinearGradient id="ig" x1="0" y1="1" x2="0" y2="0">
            <Stop offset="0"    stopColor="white" stopOpacity="0.1" />
            <Stop offset="0.15" stopColor="white" stopOpacity="0" />
          </LinearGradient>

          {/* Center bloom — barely visible */}
          <RadialGradient id="cb" cx="50%" cy="38%" rx="55%" ry="45%">
            <Stop offset="0"   stopColor="white" stopOpacity="0.08" />
            <Stop offset="0.3" stopColor="white" stopOpacity="0" />
            <Stop offset="1"   stopColor="white" stopOpacity="0" />
          </RadialGradient>

          {/* Frosted edges — minimal */}
          <LinearGradient id="fe" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0"    stopColor="white" stopOpacity="0.12" />
            <Stop offset="0.06" stopColor="white" stopOpacity="0" />
            <Stop offset="0.5"  stopColor="white" stopOpacity="0" />
            <Stop offset="0.92" stopColor="white" stopOpacity="0.1" />
            <Stop offset="1"    stopColor="white" stopOpacity="0.3" />
          </LinearGradient>

          {/* Glass border */}
          <LinearGradient id="gb" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0"    stopColor="white" stopOpacity="0.7" />
            <Stop offset="0.2"  stopColor="white" stopOpacity="0.25" />
            <Stop offset="0.5"  stopColor="white" stopOpacity="0.08" />
            <Stop offset="0.8"  stopColor="white" stopOpacity="0.12" />
            <Stop offset="1"    stopColor="white" stopOpacity="0.3" />
          </LinearGradient>

          {/* Side borders */}
          <LinearGradient id="sb" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0"    stopColor="white" stopOpacity="0.35" />
            <Stop offset="0.1"  stopColor="white" stopOpacity="0" />
            <Stop offset="0.9"  stopColor="white" stopOpacity="0" />
            <Stop offset="1"    stopColor="white" stopOpacity="0.25" />
          </LinearGradient>

          {/* Caustic */}
          <RadialGradient id="cs" cx="50%" cy="18%" rx="40%" ry="20%">
            <Stop offset="0"   stopColor="white" stopOpacity="0.15" />
            <Stop offset="0.6" stopColor="white" stopOpacity="0.03" />
            <Stop offset="1"   stopColor="white" stopOpacity="0" />
          </RadialGradient>

          {/* Dot inner glass */}
          <RadialGradient id="dg" cx="38%" cy="35%" r="60%">
            <Stop offset="0"   stopColor="white" stopOpacity="0.5" />
            <Stop offset="0.3" stopColor="white" stopOpacity="0.15" />
            <Stop offset="1"   stopColor="white" stopOpacity="0" />
          </RadialGradient>
        </Defs>

        {/* ══════════════════════════════════════════════
            PROJECTION BACKGROUND BARS — grey ghost behind actual
            ══════════════════════════════════════════════ */}
        {projectionBars && projectionBars.map((pb, i) => {
          if (!pb || pb.height < 1) return null;
          return (
            <Rect key={`proj-${i}`}
              x={pb.x} y={pb.y} width={pb.width} height={pb.height}
              rx={R} ry={R} fill="url(#gP)" />
          );
        })}

        {/* ══════════════════════════════════════════════
            BARS — liquid glass layers
            ══════════════════════════════════════════════ */}
        {bars.map((bar, i) => {
          if (bar.height < 1) return null;
          const bk = `b-${i}-${bar.height.toFixed(0)}`;

          let g: string;
          if (bar.colorType === 'red') g = bar.isActual ? 'gR' : 'gPN';
          else if (bar.colorType === 'green') g = bar.isActual ? 'gG' : 'gP';
          else if (!bar.isActual) g = bar.isNegative ? 'gPN' : 'gP';
          else g = bar.isNegative ? 'gR' : 'gG';

          const { x, y, width: w, height: h } = bar;

          return (
            <React.Fragment key={bk}>
              {/* 1 — Main glass body */}
              <Rect x={x} y={y} width={w} height={h} rx={R} ry={R}
                fill={`url(#${g})`} />
              {/* 2 — Center volumetric bloom */}
              <Rect x={x} y={y} width={w} height={h} rx={R} ry={R}
                fill="url(#cb)" />
              {/* 3 — Bottom inner glow */}
              <Rect x={x} y={y} width={w} height={h} rx={R} ry={R}
                fill="url(#ig)" />
              {/* 4 — Frosted edge refraction */}
              <Rect x={x} y={y} width={w} height={h} rx={R} ry={R}
                fill="url(#fe)" />
              {/* 5 — Top caustic */}
              <Rect x={x} y={y} width={w} height={Math.min(h, h * 0.5)} rx={R} ry={R}
                fill="url(#cs)" />
              {/* 6 — Top highlight */}
              <Rect x={x} y={y} width={w} height={Math.min(h, h * 0.35)} rx={R} ry={R}
                fill="url(#hl)" />
              {/* 7 — Glass border */}
              <Rect x={x + 0.25} y={y + 0.25} width={w - 0.5} height={h - 0.5}
                rx={R} ry={R} fill="none" stroke="url(#gb)" strokeWidth={1.5} />
              {/* 8 — Side shimmer */}
              <Rect x={x + 0.25} y={y + 0.25} width={w - 0.5} height={h - 0.5}
                rx={R} ry={R} fill="none" stroke="url(#sb)" strokeWidth={0.5} />
              {/* 9 — Top specular catch-light */}
              {h > 10 && (
                <Rect
                  x={x + w * 0.15} y={y + 2}
                  width={w * 0.7} height={1.5}
                  rx={0.75} ry={0.75}
                  fill="white" opacity={0.25}
                />
              )}
            </React.Fragment>
          );
        })}

        {/* ══════════════════════════════════════════════
            OVERLAY LINE — liquid glass with depth
            ══════════════════════════════════════════════ */}
        {overlayLine && overlayLine.points.length > 1 && (() => {
          const pts = overlayLine.points;
          const c = overlayLine.color;

          // Build smooth cubic bezier path through points
          let path = `M ${pts[0].x},${pts[0].y}`;
          for (let i = 1; i < pts.length; i++) {
            const prev = pts[i - 1];
            const curr = pts[i];
            const tension = 0.35;
            const dx = (curr.x - prev.x) * tension;
            path += ` C ${prev.x + dx},${prev.y} ${curr.x - dx},${curr.y} ${curr.x},${curr.y}`;
          }

          // Build offset path for highlight
          let hlPath = `M ${pts[0].x},${pts[0].y - 1.2}`;
          for (let i = 1; i < pts.length; i++) {
            const prev = pts[i - 1];
            const curr = pts[i];
            const tension = 0.35;
            const dx = (curr.x - prev.x) * tension;
            hlPath += ` C ${prev.x + dx},${prev.y - 1.2} ${curr.x - dx},${curr.y - 1.2} ${curr.x},${curr.y - 1.2}`;
          }

          return (
            <>
              {/* Soft ambient glow */}
              <Path d={path} fill="none" stroke={c} strokeWidth={10} strokeLinecap="round" opacity={0.06} />
              {/* Mid glow */}
              <Path d={path} fill="none" stroke={c} strokeWidth={5} strokeLinecap="round" opacity={0.12} />
              {/* Core stroke — glass */}
              <Path d={path} fill="none" stroke={c} strokeWidth={2.5} strokeLinecap="round" opacity={0.8} />
              {/* Top highlight — light refraction */}
              <Path d={hlPath} fill="none" stroke="white" strokeWidth={0.8} strokeLinecap="round" opacity={0.35} />

              {/* Glass dots — minimal, modern */}
              {pts.map((p, i) => (
                <React.Fragment key={i}>
                  {/* Outer glow */}
                  <Circle cx={p.x} cy={p.y} r={6} fill={c} opacity={0.08} />
                  {/* Glass body */}
                  <Circle cx={p.x} cy={p.y} r={3} fill="white" opacity={0.95} />
                  <Circle cx={p.x} cy={p.y} r={3}
                    fill="none" stroke={c} strokeWidth={1.5} opacity={0.7} />
                  {/* Inner specular */}
                  <Circle cx={p.x - 0.4} cy={p.y - 0.6} r={0.8}
                    fill="white" opacity={0.6} />
                </React.Fragment>
              ))}
            </>
          );
        })()}
      </Svg>
    </View>
  );
}

const shadowStyles = StyleSheet.create({
  container: {
    ...Platform.select({
      ios: {
        shadowColor: 'rgba(0,0,0,0.12)',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 1,
        shadowRadius: 10,
      },
      android: { elevation: 6 },
    }),
  },
});

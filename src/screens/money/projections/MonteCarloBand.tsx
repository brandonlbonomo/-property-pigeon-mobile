import React, { useRef, useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Dimensions, PanResponder, Animated, Platform } from 'react-native';
import Svg, { Path, Line, Text as SvgText, Defs, LinearGradient, Stop, Circle } from 'react-native-svg';
import { Colors, FontSize, Spacing, Radius } from '../../../constants/theme';
import { YearRow } from '../../../utils/projections';
import { fmtCompact } from '../../../utils/format';
import { ExpandableSection } from './ExpandableSection';
import { lockParentScroll, unlockParentScroll } from '../../../navigation/LTRNavigator';

interface Props {
  projection: YearRow[];
}

const SCREEN_W = Dimensions.get('window').width;
const CHART_W = SCREEN_W - Spacing.md * 4;
const CHART_H = 160;
const PAD = { top: 16, right: 16, bottom: 28, left: 54 };
const PLOT_W = CHART_W - PAD.left - PAD.right;
const PLOT_H = CHART_H - PAD.top - PAD.bottom;
const TOOLTIP_W = 172;

function variancePct(yearOffset: number): number {
  return 0.08 + (yearOffset / 30) * 0.12;
}

function toX(i: number, total: number): number {
  return PAD.left + (i / (total - 1)) * PLOT_W;
}

function toY(value: number, min: number, max: number): number {
  if (max === min) return PAD.top + PLOT_H / 2;
  return PAD.top + PLOT_H - ((value - min) / (max - min)) * PLOT_H;
}

function linePath(points: { x: number; y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
}

export function MonteCarloBand({ projection }: Props) {
  const [flat15, setFlat15] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.92)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasActiveRef = useRef(false);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (activeIndex !== null && !wasActiveRef.current) {
      wasActiveRef.current = true;
      fadeAnim.setValue(0);
      scaleAnim.setValue(0.92);
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 120, useNativeDriver: true }),
        Animated.spring(scaleAnim, { toValue: 1, tension: 130, friction: 10, useNativeDriver: true }),
      ]).start();
    }
    if (activeIndex === null) wasActiveRef.current = false;
  }, [activeIndex]);

  // Reset active on variance toggle
  useEffect(() => { setActiveIndex(null); }, [flat15]);

  function xToIndex(touchX: number): number {
    const clamped = Math.max(PAD.left, Math.min(touchX, PAD.left + PLOT_W));
    const fraction = (clamped - PAD.left) / PLOT_W;
    return Math.round(fraction * (projection.length - 1));
  }

  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponderCapture: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (evt) => {
      if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
      setActiveIndex(xToIndex(evt.nativeEvent.locationX));
    },
    onPanResponderMove: (evt) => {
      setActiveIndex(xToIndex(evt.nativeEvent.locationX));
    },
    onPanResponderRelease: () => {
      hideTimer.current = setTimeout(() => {
        Animated.timing(fadeAnim, { toValue: 0, duration: 200, useNativeDriver: true })
          .start(() => { setActiveIndex(null); });
      }, 2200);
    },
  })).current;

  if (!projection || projection.length < 2) return null;

  const bandData = projection.map((r, i) => {
    const v = flat15 ? 0.15 : variancePct(r.yearOffset);
    return {
      base: r.netCF,
      high: r.netCF * (1 + v),
      low: r.netCF * (1 - v),
      variance: v,
      x: toX(i, projection.length),
      yearOffset: r.yearOffset,
    };
  });

  const allVals = bandData.flatMap(d => [d.high, d.low, d.base]);
  const minVal = Math.min(...allVals, 0);
  const maxVal = Math.max(...allVals) * 1.05;

  const basePoints = bandData.map(d => ({ x: d.x, y: toY(d.base, minVal, maxVal) }));
  const highPoints = bandData.map(d => ({ x: d.x, y: toY(d.high, minVal, maxVal) }));
  const lowPoints  = bandData.map(d => ({ x: d.x, y: toY(d.low,  minVal, maxVal) }));

  const bandPath = (() => {
    const fwd = highPoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    const bwd = [...lowPoints].reverse().map(p => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    return `${fwd} ${bwd} Z`;
  })();

  const zeroY = toY(0, minVal, maxVal);
  const showZeroLine = minVal < 0;

  const yTicks = [0, 0.25, 0.5, 0.75, 1.0].map(pct => ({
    val: minVal + (maxVal - minVal) * pct,
    y: PAD.top + PLOT_H - pct * PLOT_H,
  }));

  // Active point data
  const activeData = activeIndex !== null ? bandData[activeIndex] : null;
  const crosshairX = activeData ? activeData.x : 0;
  const activeBaseY = activeData ? toY(activeData.base, minVal, maxVal) : 0;
  const activeHighY = activeData ? toY(activeData.high, minVal, maxVal) : 0;
  const activeLowY  = activeData ? toY(activeData.low,  minVal, maxVal) : 0;

  const tooltipLeft = Math.max(0, Math.min(crosshairX - TOOLTIP_W / 2, CHART_W - TOOLTIP_W));

  const lastBase = bandData[bandData.length - 1];

  return (
    <ExpandableSection
      title="Sensitivity Band"
      subtitle="Drag to explore · confidence range across occupancy scenarios"
      iconName="analytics-outline"
    >
      {/* Variance toggle */}
      <View style={styles.toggleRow}>
        <TouchableOpacity activeOpacity={0.7}
          style={[styles.toggleBtn, !flat15 && styles.toggleBtnActive]}
          onPress={() => setFlat15(false)}>
          <Text style={[styles.toggleText, !flat15 && styles.toggleTextActive]}>Tapered</Text>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.7}
          style={[styles.toggleBtn, flat15 && styles.toggleBtnActive]}
          onPress={() => setFlat15(true)}>
          <Text style={[styles.toggleText, flat15 && styles.toggleTextActive]}>Flat ±15%</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.chartContainer}>
        <Svg width={CHART_W} height={CHART_H}>
          <Defs>
            <LinearGradient id="mcBandFill" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={Colors.green} stopOpacity="0.14" />
              <Stop offset="1" stopColor={Colors.green} stopOpacity="0.04" />
            </LinearGradient>
          </Defs>

          {/* Gridlines */}
          {yTicks.map((tick, i) => (
            <Line key={i} x1={PAD.left} y1={tick.y.toFixed(1)}
              x2={(PAD.left + PLOT_W).toFixed(1)} y2={tick.y.toFixed(1)}
              stroke={Colors.border} strokeWidth="0.5" />
          ))}

          {/* Zero line */}
          {showZeroLine && (
            <Line x1={PAD.left} y1={zeroY.toFixed(1)}
              x2={(PAD.left + PLOT_W).toFixed(1)} y2={zeroY.toFixed(1)}
              stroke={Colors.textDim} strokeWidth="1" strokeDasharray="3 3" />
          )}

          {/* Y-axis labels */}
          {yTicks.map((tick, i) => (
            <SvgText key={i} x={(PAD.left - 4).toFixed(1)} y={(tick.y + 4).toFixed(1)}
              fontSize="9" fill={Colors.textDim} textAnchor="end">
              {fmtCompact(tick.val)}
            </SvgText>
          ))}

          {/* X-axis labels */}
          {projection.map((r, i) =>
            i % 2 === 0 ? (
              <SvgText key={i} x={toX(i, projection.length).toFixed(1)} y={(CHART_H - 4).toFixed(1)}
                fontSize="9" fill={activeIndex === i ? Colors.text : Colors.textDim} textAnchor="middle"
                fontWeight={activeIndex === i ? '700' : '400'}>
                {r.yearOffset}
              </SvgText>
            ) : null
          )}

          {/* Band + edges */}
          <Path d={bandPath} fill="url(#mcBandFill)" />
          <Path d={linePath(highPoints)} stroke={Colors.green} strokeWidth="0.8" fill="none"
            strokeDasharray="3 2" strokeOpacity="0.5" />
          <Path d={linePath(lowPoints)} stroke={Colors.green} strokeWidth="0.8" fill="none"
            strokeDasharray="3 2" strokeOpacity="0.5" />

          {/* Base line */}
          <Path d={linePath(basePoints)} stroke={Colors.green} strokeWidth="2.5" fill="none"
            strokeLinecap="round" strokeLinejoin="round" />

          {/* Crosshair */}
          {activeIndex !== null && activeData && (
            <>
              <Line
                x1={crosshairX.toFixed(1)} y1={PAD.top.toFixed(1)}
                x2={crosshairX.toFixed(1)} y2={(PAD.top + PLOT_H).toFixed(1)}
                stroke={Colors.textSecondary} strokeWidth="1" strokeDasharray="3 2" />
              {/* High dot */}
              <Circle cx={crosshairX.toFixed(1)} cy={activeHighY.toFixed(1)} r="4"
                fill="#6366F1" stroke={Colors.glassHeavy} strokeWidth="1.5" />
              {/* Base dot */}
              <Circle cx={crosshairX.toFixed(1)} cy={activeBaseY.toFixed(1)} r="5"
                fill={Colors.green} stroke={Colors.glassHeavy} strokeWidth="1.5" />
              {/* Low dot */}
              <Circle cx={crosshairX.toFixed(1)} cy={activeLowY.toFixed(1)} r="4"
                fill={Colors.red} stroke={Colors.glassHeavy} strokeWidth="1.5" />
            </>
          )}
        </Svg>

        {/* Touch capture — lock all scroll on touch, unlock on release */}
        <View
          style={styles.touchOverlay}
          onTouchStart={(evt) => {
            lockParentScroll();
            if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
            setActiveIndex(xToIndex(evt.nativeEvent.locationX));
          }}
          onTouchMove={(evt) => {
            setActiveIndex(xToIndex(evt.nativeEvent.locationX));
          }}
          onTouchEnd={() => {
            unlockParentScroll();
            hideTimer.current = setTimeout(() => {
              Animated.timing(fadeAnim, { toValue: 0, duration: 200, useNativeDriver: true })
                .start(() => { setActiveIndex(null); });
            }, 2200);
          }}
          onTouchCancel={() => {
            unlockParentScroll();
          }}
        />

        {/* Tooltip */}
        {activeIndex !== null && activeData && (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.tooltip,
              {
                left: tooltipLeft,
                opacity: fadeAnim,
                transform: [{ scale: scaleAnim }],
              },
            ]}
          >
            <Text style={styles.tooltipYear}>YEAR {activeData.yearOffset}</Text>
            <Text style={styles.tooltipVariance}>
              ±{(activeData.variance * 100).toFixed(0)}% occupancy variance
            </Text>
            <View style={styles.tooltipDivider} />
            <View style={styles.tooltipRow}>
              <View style={[styles.tooltipDot, { backgroundColor: '#6366F1' }]} />
              <Text style={styles.tooltipLabel}>Bull case</Text>
              <Text style={[styles.tooltipVal, { color: '#6366F1' }]}>{fmtCompact(activeData.high)}</Text>
            </View>
            <View style={styles.tooltipRow}>
              <View style={[styles.tooltipDot, { backgroundColor: Colors.green }]} />
              <Text style={styles.tooltipLabel}>Base</Text>
              <Text style={[styles.tooltipVal, { color: Colors.green }]}>{fmtCompact(activeData.base)}</Text>
            </View>
            <View style={styles.tooltipRow}>
              <View style={[styles.tooltipDot, { backgroundColor: Colors.red }]} />
              <Text style={styles.tooltipLabel}>Bear case</Text>
              <Text style={[styles.tooltipVal, { color: Colors.red }]}>{fmtCompact(activeData.low)}</Text>
            </View>
            <View style={[styles.tooltipArrow, { left: Math.max(8, Math.min(crosshairX - tooltipLeft - 4, TOOLTIP_W - 16)) }]} />
          </Animated.View>
        )}
      </View>

      {/* Yr 30 range callout */}
      <View style={styles.rangeBox}>
        <View style={styles.rangeItem}>
          <Text style={[styles.rangeVal, { color: Colors.red }]}>{fmtCompact(lastBase.low)}</Text>
          <Text style={styles.rangeLabel}>Bear case (Yr 30)</Text>
        </View>
        <View style={styles.rangeDivider} />
        <View style={styles.rangeItem}>
          <Text style={[styles.rangeVal, { color: Colors.green }]}>{fmtCompact(lastBase.base)}</Text>
          <Text style={styles.rangeLabel}>Base case</Text>
        </View>
        <View style={styles.rangeDivider} />
        <View style={styles.rangeItem}>
          <Text style={[styles.rangeVal, { color: '#6366F1' }]}>{fmtCompact(lastBase.high)}</Text>
          <Text style={styles.rangeLabel}>Bull case</Text>
        </View>
      </View>

      <Text style={styles.disclaimer}>
        {flat15
          ? 'Flat ±15% occupancy variance applied across all years'
          : 'Variance tapers from ±8% (yr 0) to ±20% (yr 30) — uncertainty grows with time'}
      </Text>
    </ExpandableSection>
  );
}

const styles = StyleSheet.create({
  toggleRow: {
    flexDirection: 'row', backgroundColor: Colors.glassDark,
    borderRadius: Radius.lg, padding: 3, marginBottom: Spacing.md,
  },
  toggleBtn: { flex: 1, paddingVertical: 6, alignItems: 'center', borderRadius: Radius.md },
  toggleBtnActive: { backgroundColor: Colors.glassHeavy },
  toggleText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary },
  toggleTextActive: { color: Colors.text },

  chartContainer: { position: 'relative', marginBottom: Spacing.xs },

  touchOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
  },

  tooltip: {
    position: 'absolute',
    top: 2,
    width: TOOLTIP_W,
    backgroundColor: Colors.glassOverlay,
    borderRadius: Radius.md,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 6,
    zIndex: 10,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.22, shadowRadius: 8 },
      android: { elevation: 4 },
    }),
  },
  tooltipYear: { fontSize: 10, fontWeight: '800', color: Colors.text, textAlign: 'center', letterSpacing: 0.4 },
  tooltipVariance: { fontSize: 9, color: Colors.textDim, textAlign: 'center', marginTop: 1 },
  tooltipDivider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border, marginVertical: 4 },
  tooltipRow: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 2 },
  tooltipDot: { width: 7, height: 7, borderRadius: 3.5 },
  tooltipLabel: { fontSize: 11, color: Colors.textSecondary, flex: 1 },
  tooltipVal: { fontSize: 12, fontWeight: '800' },
  tooltipArrow: {
    position: 'absolute',
    bottom: -4,
    width: 8, height: 8,
    backgroundColor: Colors.glassOverlay,
    borderRightWidth: 0.5, borderBottomWidth: 0.5,
    borderColor: Colors.glassBorder,
    transform: [{ rotate: '45deg' }],
  },

  rangeBox: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.glassDark, borderRadius: Radius.lg,
    padding: Spacing.sm, marginTop: Spacing.sm,
  },
  rangeItem: { flex: 1, alignItems: 'center' },
  rangeVal: { fontSize: FontSize.md, fontWeight: '800' },
  rangeLabel: { fontSize: 10, color: Colors.textDim, marginTop: 2 },
  rangeDivider: { width: StyleSheet.hairlineWidth, height: 32, backgroundColor: Colors.border },

  disclaimer: {
    fontSize: 10, color: Colors.textDim, fontStyle: 'italic',
    marginTop: Spacing.sm, textAlign: 'center', lineHeight: 14,
  },
});

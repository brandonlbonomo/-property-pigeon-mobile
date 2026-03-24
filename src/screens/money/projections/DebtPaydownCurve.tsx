import React, { useRef, useState, useEffect } from 'react';
import { View, Text, StyleSheet, Dimensions, PanResponder, Animated, Platform } from 'react-native';
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
const CHART_H = 180;
const PAD = { top: 16, right: 16, bottom: 28, left: 54 };
const PLOT_W = CHART_W - PAD.left - PAD.right;
const PLOT_H = CHART_H - PAD.top - PAD.bottom;
const TOOLTIP_W = 168;

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

export function DebtPaydownCurve({ projection }: Props) {
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

  if (!projection || projection.length < 2) {
    return (
      <ExpandableSection title="Debt Paydown Curve" subtitle="Mortgage balance vs equity over 30 years" iconName="trending-up-outline">
        <Text style={styles.empty}>No projection data available.</Text>
      </ExpandableSection>
    );
  }

  const allValues = projection.flatMap(r => [r.portfolioValue, r.mortgageBalance, r.equity]);
  const minVal = 0;
  const maxVal = Math.max(...allValues) * 1.05;

  const valuePoints  = projection.map((r, i) => ({ x: toX(i, projection.length), y: toY(r.portfolioValue, minVal, maxVal) }));
  const mortgagePoints = projection.map((r, i) => ({ x: toX(i, projection.length), y: toY(r.mortgageBalance, minVal, maxVal) }));
  const equityPoints = projection.map((r, i) => ({ x: toX(i, projection.length), y: toY(r.equity, minVal, maxVal) }));

  const equityAreaPath = (() => {
    const fwd = valuePoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    const bwd = [...mortgagePoints].reverse().map(p => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    return `${fwd} ${bwd} Z`;
  })();

  const mortgageAreaPath = [
    ...mortgagePoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`),
    `L ${mortgagePoints[mortgagePoints.length - 1].x.toFixed(1)} ${(PAD.top + PLOT_H).toFixed(1)}`,
    `L ${mortgagePoints[0].x.toFixed(1)} ${(PAD.top + PLOT_H).toFixed(1)}`,
    'Z',
  ].join(' ');

  const yTicks = [0, 0.25, 0.5, 0.75, 1.0].map(pct => ({
    val: minVal + (maxVal - minVal) * pct,
    y: PAD.top + PLOT_H - pct * PLOT_H,
  }));

  // Active point coords
  const activeRow = activeIndex !== null ? projection[activeIndex] : null;
  const crosshairX = activeIndex !== null ? toX(activeIndex, projection.length) : 0;
  const activeValueY = activeRow ? toY(activeRow.portfolioValue, minVal, maxVal) : 0;
  const activeMortgageY = activeRow ? toY(activeRow.mortgageBalance, minVal, maxVal) : 0;
  const activeEquityY = activeRow ? toY(activeRow.equity, minVal, maxVal) : 0;

  const tooltipLeft = Math.max(0, Math.min(crosshairX - TOOLTIP_W / 2, CHART_W - TOOLTIP_W));

  const lastRow = projection[projection.length - 1];

  return (
    <ExpandableSection
      title="Debt Paydown Curve"
      subtitle="Drag to explore · portfolio value vs mortgage balance"
      iconName="trending-up-outline"
    >
      <View style={styles.chartContainer}>
        <Svg width={CHART_W} height={CHART_H}>
          <Defs>
            <LinearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={Colors.green} stopOpacity="0.18" />
              <Stop offset="1" stopColor={Colors.green} stopOpacity="0.04" />
            </LinearGradient>
            <LinearGradient id="debtFill" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={Colors.red} stopOpacity="0.10" />
              <Stop offset="1" stopColor={Colors.red} stopOpacity="0.02" />
            </LinearGradient>
          </Defs>

          {/* Gridlines */}
          {yTicks.map((tick, i) => (
            <Line key={i} x1={PAD.left} y1={tick.y.toFixed(1)}
              x2={(PAD.left + PLOT_W).toFixed(1)} y2={tick.y.toFixed(1)}
              stroke={Colors.border} strokeWidth="0.5" />
          ))}

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

          {/* Fill areas */}
          <Path d={equityAreaPath} fill="url(#equityFill)" />
          <Path d={mortgageAreaPath} fill="url(#debtFill)" />

          {/* Lines */}
          <Path d={linePath(valuePoints)} stroke={Colors.green} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <Path d={linePath(mortgagePoints)} stroke={Colors.red} strokeWidth="1.5" fill="none" strokeDasharray="4 3" strokeLinecap="round" />
          <Path d={linePath(equityPoints)} stroke={Colors.green} strokeWidth="1" fill="none" strokeOpacity="0.5" strokeLinecap="round" />

          {/* Crosshair */}
          {activeIndex !== null && (
            <>
              <Line
                x1={crosshairX.toFixed(1)} y1={PAD.top.toFixed(1)}
                x2={crosshairX.toFixed(1)} y2={(PAD.top + PLOT_H).toFixed(1)}
                stroke={Colors.textSecondary} strokeWidth="1" strokeDasharray="3 2" />
              {/* Portfolio value dot */}
              <Circle cx={crosshairX.toFixed(1)} cy={activeValueY.toFixed(1)} r="5"
                fill={Colors.green} stroke={Colors.glassHeavy} strokeWidth="1.5" />
              {/* Mortgage dot */}
              {activeRow && activeRow.mortgageBalance > 0 && (
                <Circle cx={crosshairX.toFixed(1)} cy={activeMortgageY.toFixed(1)} r="4"
                  fill={Colors.red} stroke={Colors.glassHeavy} strokeWidth="1.5" />
              )}
              {/* Equity dot */}
              <Circle cx={crosshairX.toFixed(1)} cy={activeEquityY.toFixed(1)} r="4"
                fill={Colors.green} stroke={Colors.glassHeavy} strokeWidth="1.5" fillOpacity="0.6" />
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
        {activeIndex !== null && activeRow && (
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
            <Text style={styles.tooltipYear}>YEAR {activeRow.yearOffset}</Text>
            <View style={styles.tooltipDivider} />
            <View style={styles.tooltipRow}>
              <View style={[styles.tooltipDot, { backgroundColor: Colors.green }]} />
              <Text style={styles.tooltipLabel}>Portfolio</Text>
              <Text style={[styles.tooltipVal, { color: Colors.green }]}>{fmtCompact(activeRow.portfolioValue)}</Text>
            </View>
            <View style={styles.tooltipRow}>
              <View style={[styles.tooltipDot, { backgroundColor: Colors.red }]} />
              <Text style={styles.tooltipLabel}>Mortgage</Text>
              <Text style={[styles.tooltipVal, { color: Colors.red }]}>{fmtCompact(activeRow.mortgageBalance)}</Text>
            </View>
            <View style={styles.tooltipRow}>
              <View style={[styles.tooltipDot, { backgroundColor: Colors.green, opacity: 0.5 }]} />
              <Text style={styles.tooltipLabel}>Equity</Text>
              <Text style={[styles.tooltipVal, { color: Colors.green }]}>{fmtCompact(activeRow.equity)}</Text>
            </View>
            {/* Arrow */}
            <View style={[styles.tooltipArrow, { left: Math.max(8, Math.min(crosshairX - tooltipLeft - 4, TOOLTIP_W - 16)) }]} />
          </Animated.View>
        )}
      </View>

      {/* Legend */}
      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={[styles.legendLine, { backgroundColor: Colors.green }]} />
          <Text style={styles.legendText}>Portfolio Value</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendLine, { backgroundColor: Colors.red, opacity: 0.7 }]} />
          <Text style={styles.legendText}>Mortgage Balance</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: Colors.green, opacity: 0.4 }]} />
          <Text style={styles.legendText}>Equity</Text>
        </View>
      </View>

      {/* Callouts */}
      <View style={styles.callouts}>
        <View style={styles.calloutItem}>
          <Text style={styles.calloutVal}>{fmtCompact(lastRow.portfolioValue)}</Text>
          <Text style={styles.calloutLabel}>Yr 30 Value</Text>
        </View>
        <View style={styles.calloutItem}>
          <Text style={[styles.calloutVal, { color: Colors.red }]}>{fmtCompact(lastRow.mortgageBalance)}</Text>
          <Text style={styles.calloutLabel}>Remaining Debt</Text>
        </View>
        <View style={styles.calloutItem}>
          <Text style={[styles.calloutVal, { color: Colors.green }]}>{fmtCompact(lastRow.equity)}</Text>
          <Text style={styles.calloutLabel}>Yr 30 Equity</Text>
        </View>
      </View>
    </ExpandableSection>
  );
}

const styles = StyleSheet.create({
  empty: { fontSize: FontSize.xs, color: Colors.textDim, fontStyle: 'italic' },

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

  legend: { flexDirection: 'row', gap: Spacing.md, marginTop: Spacing.xs, flexWrap: 'wrap' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendLine: { width: 16, height: 2, borderRadius: 1 },
  legendDot: { width: 12, height: 12, borderRadius: 3 },
  legendText: { fontSize: 11, color: Colors.textSecondary },

  callouts: {
    flexDirection: 'row', justifyContent: 'space-around',
    backgroundColor: Colors.glassDark, borderRadius: Radius.lg,
    padding: Spacing.sm, marginTop: Spacing.sm,
  },
  calloutItem: { alignItems: 'center' },
  calloutVal: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text },
  calloutLabel: { fontSize: 10, color: Colors.textDim, marginTop: 2 },
});

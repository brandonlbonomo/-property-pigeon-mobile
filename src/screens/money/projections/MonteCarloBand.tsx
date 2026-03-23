import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Dimensions } from 'react-native';
import Svg, { Path, Line, Text as SvgText, Defs, LinearGradient, Stop } from 'react-native-svg';
import { Colors, FontSize, Spacing, Radius } from '../../../constants/theme';
import { YearRow } from '../../../utils/projections';
import { fmtCompact } from '../../../utils/format';
import { ExpandableSection } from './ExpandableSection';

interface Props {
  projection: YearRow[];
}

const SCREEN_W = Dimensions.get('window').width;
const CHART_W = SCREEN_W - Spacing.md * 4;
const CHART_H = 160;
const PAD = { top: 16, right: 16, bottom: 28, left: 54 };
const PLOT_W = CHART_W - PAD.left - PAD.right;
const PLOT_H = CHART_H - PAD.top - PAD.bottom;

// Variance widens over time (more uncertainty further out)
function variance(yearOffset: number): number {
  return 0.08 + (yearOffset / 30) * 0.12; // 8% at yr0 → 20% at yr30
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
  const [variance15, setVariance15] = useState(false); // false = tapered, true = flat ±15%

  if (!projection || projection.length < 2) return null;

  const bandData = projection.map((r, i) => {
    const v = variance15 ? 0.15 : variance(r.yearOffset);
    return {
      base: r.netCF,
      high: r.netCF * (1 + v),
      low: r.netCF * (1 - v),
      x: toX(i, projection.length),
      yearOffset: r.yearOffset,
    };
  });

  const allVals = bandData.flatMap(d => [d.high, d.low, d.base]);
  const minVal = Math.min(...allVals, 0);
  const maxVal = Math.max(...allVals) * 1.05;

  const basePoints = bandData.map(d => ({ x: d.x, y: toY(d.base, minVal, maxVal) }));
  const highPoints = bandData.map(d => ({ x: d.x, y: toY(d.high, minVal, maxVal) }));
  const lowPoints = bandData.map(d => ({ x: d.x, y: toY(d.low, minVal, maxVal) }));

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

  const lastBase = bandData[bandData.length - 1];
  const lastHigh = lastBase.high;
  const lastLow = lastBase.low;

  return (
    <ExpandableSection
      title="Sensitivity Band"
      subtitle="Confidence range across occupancy scenarios"
      iconName="analytics-outline"
    >
      {/* Variance toggle */}
      <View style={styles.toggleRow}>
        <TouchableOpacity
          activeOpacity={0.7}
          style={[styles.toggleBtn, !variance15 && styles.toggleBtnActive]}
          onPress={() => setVariance15(false)}
        >
          <Text style={[styles.toggleText, !variance15 && styles.toggleTextActive]}>Tapered</Text>
        </TouchableOpacity>
        <TouchableOpacity
          activeOpacity={0.7}
          style={[styles.toggleBtn, variance15 && styles.toggleBtnActive]}
          onPress={() => setVariance15(true)}
        >
          <Text style={[styles.toggleText, variance15 && styles.toggleTextActive]}>Flat ±15%</Text>
        </TouchableOpacity>
      </View>

      <Svg width={CHART_W} height={CHART_H}>
        <Defs>
          <LinearGradient id="bandFill" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={Colors.green} stopOpacity="0.14" />
            <Stop offset="1" stopColor={Colors.green} stopOpacity="0.04" />
          </LinearGradient>
        </Defs>

        {/* Gridlines */}
        {yTicks.map((tick, i) => (
          <Line key={i} x1={PAD.left} y1={tick.y.toFixed(1)}
            x2={(PAD.left + PLOT_W).toFixed(1)} y2={tick.y.toFixed(1)}
            stroke={Colors.border} strokeWidth="0.5"
          />
        ))}

        {/* Zero line */}
        {showZeroLine && (
          <Line x1={PAD.left} y1={zeroY.toFixed(1)}
            x2={(PAD.left + PLOT_W).toFixed(1)} y2={zeroY.toFixed(1)}
            stroke={Colors.textDim} strokeWidth="1" strokeDasharray="3 3"
          />
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
              fontSize="9" fill={Colors.textDim} textAnchor="middle">
              {r.yearOffset}
            </SvgText>
          ) : null
        )}

        {/* Confidence band */}
        <Path d={bandPath} fill="url(#bandFill)" />

        {/* High edge */}
        <Path d={linePath(highPoints)} stroke={Colors.green} strokeWidth="0.8" fill="none"
          strokeDasharray="3 2" strokeOpacity="0.5" />

        {/* Low edge */}
        <Path d={linePath(lowPoints)} stroke={Colors.green} strokeWidth="0.8" fill="none"
          strokeDasharray="3 2" strokeOpacity="0.5" />

        {/* Base (median) line */}
        <Path d={linePath(basePoints)} stroke={Colors.green} strokeWidth="2.5" fill="none"
          strokeLinecap="round" strokeLinejoin="round" />
      </Svg>

      {/* Yr 30 range callout */}
      <View style={styles.rangeBox}>
        <View style={styles.rangeItem}>
          <Text style={[styles.rangeVal, { color: Colors.red }]}>{fmtCompact(lastLow)}</Text>
          <Text style={styles.rangeLabel}>Bear case (Yr 30)</Text>
        </View>
        <View style={styles.rangeDivider} />
        <View style={styles.rangeItem}>
          <Text style={[styles.rangeVal, { color: Colors.green }]}>{fmtCompact(lastBase.base)}</Text>
          <Text style={styles.rangeLabel}>Base case</Text>
        </View>
        <View style={styles.rangeDivider} />
        <View style={styles.rangeItem}>
          <Text style={[styles.rangeVal, { color: '#6366F1' }]}>{fmtCompact(lastHigh)}</Text>
          <Text style={styles.rangeLabel}>Bull case</Text>
        </View>
      </View>

      <Text style={styles.disclaimer}>
        {variance15
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

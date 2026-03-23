import React from 'react';
import { View, Text, StyleSheet, Dimensions } from 'react-native';
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
const CHART_H = 180;
const PAD = { top: 16, right: 16, bottom: 28, left: 54 };
const PLOT_W = CHART_W - PAD.left - PAD.right;
const PLOT_H = CHART_H - PAD.top - PAD.bottom;

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

function areaPath(top: { x: number; y: number }[], bottom: { x: number; y: number }[], baseY: number): string {
  const forward = top.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const backward = [...bottom].reverse().map(p => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  return `${forward} ${backward} Z`;
}

export function DebtPaydownCurve({ projection }: Props) {
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

  const valuePoints = projection.map((r, i) => ({ x: toX(i, projection.length), y: toY(r.portfolioValue, minVal, maxVal) }));
  const mortgagePoints = projection.map((r, i) => ({ x: toX(i, projection.length), y: toY(r.mortgageBalance, minVal, maxVal) }));
  const equityPoints = projection.map((r, i) => ({ x: toX(i, projection.length), y: toY(r.equity, minVal, maxVal) }));

  // Equity fill area: between portfolioValue line and mortgageBalance line
  const equityAreaPath = (() => {
    const fwd = valuePoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    const bwd = [...mortgagePoints].reverse().map(p => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    return `${fwd} ${bwd} Z`;
  })();

  // Y-axis labels
  const yTicks = [0, 0.25, 0.5, 0.75, 1.0].map(pct => ({
    val: minVal + (maxVal - minVal) * pct,
    y: PAD.top + PLOT_H - pct * PLOT_H,
  }));

  // X-axis labels (year offsets)
  const xLabels = projection.map((r, i) => ({ label: `${r.yearOffset}`, x: toX(i, projection.length) }));

  const lastRow = projection[projection.length - 1];

  return (
    <ExpandableSection
      title="Debt Paydown Curve"
      subtitle="Portfolio value vs mortgage balance over 30 years"
      iconName="trending-up-outline"
    >
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
          <Line
            key={i}
            x1={PAD.left} y1={tick.y.toFixed(1)}
            x2={(PAD.left + PLOT_W).toFixed(1)} y2={tick.y.toFixed(1)}
            stroke={Colors.border} strokeWidth="0.5"
          />
        ))}

        {/* Y-axis labels */}
        {yTicks.map((tick, i) => (
          <SvgText
            key={i}
            x={(PAD.left - 4).toFixed(1)} y={(tick.y + 4).toFixed(1)}
            fontSize="9" fill={Colors.textDim} textAnchor="end"
          >
            {fmtCompact(tick.val)}
          </SvgText>
        ))}

        {/* X-axis labels */}
        {xLabels.map((l, i) => (
          i % 2 === 0 ? (
            <SvgText key={i} x={l.x.toFixed(1)} y={(CHART_H - 4).toFixed(1)}
              fontSize="9" fill={Colors.textDim} textAnchor="middle">
              {l.label}
            </SvgText>
          ) : null
        ))}

        {/* Equity fill area */}
        <Path d={equityAreaPath} fill="url(#equityFill)" />

        {/* Mortgage balance fill to bottom */}
        <Path
          d={[
            ...mortgagePoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`),
            `L ${mortgagePoints[mortgagePoints.length - 1].x.toFixed(1)} ${(PAD.top + PLOT_H).toFixed(1)}`,
            `L ${mortgagePoints[0].x.toFixed(1)} ${(PAD.top + PLOT_H).toFixed(1)}`,
            'Z',
          ].join(' ')}
          fill="url(#debtFill)"
        />

        {/* Portfolio value line */}
        <Path d={linePath(valuePoints)} stroke={Colors.green} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />

        {/* Mortgage balance line */}
        <Path d={linePath(mortgagePoints)} stroke={Colors.red} strokeWidth="1.5" fill="none" strokeDasharray="4 3" strokeLinecap="round" />

        {/* Equity line */}
        <Path d={linePath(equityPoints)} stroke={Colors.green} strokeWidth="1" fill="none" strokeOpacity="0.5" strokeLinecap="round" />
      </Svg>

      {/* Legend */}
      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={[styles.legendLine, { backgroundColor: Colors.green }]} />
          <Text style={styles.legendText}>Portfolio Value</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendLine, { backgroundColor: Colors.red, opacity: 0.6 }]} />
          <Text style={styles.legendText}>Mortgage Balance</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: Colors.green, opacity: 0.4 }]} />
          <Text style={styles.legendText}>Equity (shaded)</Text>
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
  legend: { flexDirection: 'row', gap: Spacing.md, marginTop: Spacing.sm, flexWrap: 'wrap' },
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

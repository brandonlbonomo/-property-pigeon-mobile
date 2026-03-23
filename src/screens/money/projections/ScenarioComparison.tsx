import React, { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { Colors, FontSize, Spacing, Radius } from '../../../constants/theme';
import { generate30YearProjection, YearRow } from '../../../utils/projections';
import { fmtCompact } from '../../../utils/format';
import { ExpandableSection } from './ExpandableSection';

interface Props {
  startingUnits: number;
  currentUnitsPerYear: number;
  revenue: number;
  expenses: number;
  projStyle: string;
}

type ViewMode = 'netCF' | 'portfolioValue' | 'equity';

const CHECKPOINTS = [10, 20, 30] as const;

interface Scenario {
  key: string;
  label: string;
  sublabel: string;
  style: string;
  unitsPerYear: number;
  color: string;
}

export function ScenarioComparison({ startingUnits, currentUnitsPerYear, revenue, expenses, projStyle }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('netCF');

  const scenarios: Scenario[] = useMemo(() => [
    {
      key: 'conservative',
      label: 'Conservative',
      sublabel: '0 units/yr · slow growth',
      style: 'conservative',
      unitsPerYear: 0,
      color: Colors.textSecondary,
    },
    {
      key: 'current',
      label: 'Current Plan',
      sublabel: `${currentUnitsPerYear} units/yr · ${projStyle}`,
      style: projStyle,
      unitsPerYear: currentUnitsPerYear,
      color: Colors.green,
    },
    {
      key: 'aggressive',
      label: 'Aggressive',
      sublabel: `${currentUnitsPerYear + 2} units/yr · bullish`,
      style: 'bullish',
      unitsPerYear: currentUnitsPerYear + 2,
      color: '#6366F1',
    },
  ], [currentUnitsPerYear, projStyle]);

  const projections = useMemo(() =>
    scenarios.map(s => generate30YearProjection(startingUnits, s.unitsPerYear, revenue, expenses, s.style)),
    [scenarios, startingUnits, revenue, expenses],
  );

  function getValue(row: YearRow, mode: ViewMode): number {
    if (mode === 'netCF') return row.netCF;
    if (mode === 'portfolioValue') return row.portfolioValue;
    return row.equity;
  }

  const checkpointRows = CHECKPOINTS.map(yr =>
    projections.map(proj => proj.find(r => r.yearOffset === yr)),
  );

  // Delta between aggressive and conservative at yr 30
  const conservativeVal30 = getValue(projections[0].find(r => r.yearOffset === 30)!, viewMode);
  const aggressiveVal30 = getValue(projections[2].find(r => r.yearOffset === 30)!, viewMode);
  const deltaLabel = viewMode === 'netCF' ? 'net CF/yr' : viewMode === 'portfolioValue' ? 'portfolio value' : 'equity';

  const modeLabels: { key: ViewMode; label: string }[] = [
    { key: 'netCF', label: 'Net CF' },
    { key: 'portfolioValue', label: 'Value' },
    { key: 'equity', label: 'Equity' },
  ];

  return (
    <ExpandableSection
      title="Scenario Comparison"
      subtitle="What-if modeling across growth strategies"
      iconName="git-branch-outline"
      badge="INVESTOR"
    >
      {/* Toggle */}
      <View style={styles.toggleRow}>
        {modeLabels.map(m => (
          <TouchableOpacity
            key={m.key}
            activeOpacity={0.7}
            style={[styles.toggleBtn, viewMode === m.key && styles.toggleBtnActive]}
            onPress={() => setViewMode(m.key)}
          >
            <Text style={[styles.toggleText, viewMode === m.key && styles.toggleTextActive]}>{m.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Scenario labels */}
      <View style={styles.scenarioLabelRow}>
        <View style={styles.yearLabelCol} />
        {scenarios.map((s, si) => (
          <View key={s.key} style={styles.scenarioLabelCol}>
            <View style={[styles.scenarioDot, { backgroundColor: s.color }]} />
            <Text style={[styles.scenarioName, { color: s.color }]}>{s.label}</Text>
            <Text style={styles.scenarioSub}>{s.sublabel}</Text>
          </View>
        ))}
      </View>

      {/* Checkpoint rows */}
      {CHECKPOINTS.map((yr, ci) => (
        <View key={yr} style={[styles.checkpointRow, ci > 0 && styles.checkpointBorder]}>
          <View style={styles.yearLabelCol}>
            <Text style={styles.yrLabel}>YR {yr}</Text>
          </View>
          {checkpointRows[ci].map((row, si) => {
            if (!row) return <View key={si} style={styles.scenarioValCol} />;
            const val = getValue(row, viewMode);
            return (
              <View key={si} style={styles.scenarioValCol}>
                <Text style={[styles.valText, { color: scenarios[si].color }]}>{fmtCompact(val)}</Text>
                {viewMode === 'netCF' && <Text style={styles.valSub}>/yr</Text>}
              </View>
            );
          })}
        </View>
      ))}

      {/* Delta callout */}
      <View style={styles.deltaBox}>
        <Text style={styles.deltaLabel}>Aggressive vs Conservative at Yr 30</Text>
        <Text style={styles.deltaValue}>
          {fmtCompact(Math.abs(aggressiveVal30 - conservativeVal30))} more {deltaLabel}
        </Text>
      </View>
    </ExpandableSection>
  );
}

const styles = StyleSheet.create({
  toggleRow: {
    flexDirection: 'row', backgroundColor: Colors.glassDark,
    borderRadius: Radius.lg, padding: 3, marginBottom: Spacing.md,
  },
  toggleBtn: {
    flex: 1, paddingVertical: 6, alignItems: 'center', borderRadius: Radius.md,
  },
  toggleBtnActive: { backgroundColor: Colors.glassHeavy },
  toggleText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary },
  toggleTextActive: { color: Colors.text },

  scenarioLabelRow: { flexDirection: 'row', marginBottom: Spacing.sm },
  yearLabelCol: { width: 48 },
  scenarioLabelCol: { flex: 1, alignItems: 'center', paddingHorizontal: 2 },
  scenarioDot: { width: 8, height: 8, borderRadius: 4, marginBottom: 4 },
  scenarioName: { fontSize: 10, fontWeight: '700', textAlign: 'center' },
  scenarioSub: { fontSize: 9, color: Colors.textDim, textAlign: 'center', marginTop: 1 },

  checkpointRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.sm },
  checkpointBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border },
  yrLabel: { fontSize: 10, fontWeight: '700', color: Colors.textDim, letterSpacing: 0.3 },
  scenarioValCol: { flex: 1, alignItems: 'center' },
  valText: { fontSize: FontSize.sm, fontWeight: '800' },
  valSub: { fontSize: 9, color: Colors.textDim },

  deltaBox: {
    marginTop: Spacing.md,
    backgroundColor: Colors.greenDim,
    borderRadius: Radius.lg,
    padding: Spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  deltaLabel: { fontSize: FontSize.xs, color: Colors.textSecondary },
  deltaValue: { fontSize: FontSize.sm, fontWeight: '800', color: Colors.green },
});

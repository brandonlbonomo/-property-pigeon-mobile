import React, { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, Pressable, StyleSheet, ScrollView } from 'react-native';
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
type ActiveCheckpoint = 10 | 20 | 30 | null;

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
  const [activeCheckpoint, setActiveCheckpoint] = useState<ActiveCheckpoint>(null);

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

      {/* Checkpoint rows — tap to expand detail */}
      {CHECKPOINTS.map((yr, ci) => {
        const isActive = activeCheckpoint === yr;
        return (
          <React.Fragment key={yr}>
            <Pressable
              onPress={() => setActiveCheckpoint(isActive ? null : yr as ActiveCheckpoint)}
              style={({ pressed }) => [
                styles.checkpointRow,
                ci > 0 && styles.checkpointBorder,
                isActive && styles.checkpointRowActive,
                pressed && styles.checkpointRowPressed,
              ]}
            >
              <View style={styles.yearLabelCol}>
                <Text style={[styles.yrLabel, isActive && { color: Colors.green }]}>YR {yr}</Text>
                <Text style={styles.tapHint}>{isActive ? '▲' : '▼'}</Text>
              </View>
              {checkpointRows[ci].map((row, si) => {
                if (!row) return <View key={si} style={styles.scenarioValCol} />;
                const val = getValue(row, viewMode);
                return (
                  <View key={si} style={styles.scenarioValCol}>
                    <Text style={[styles.valText, { color: scenarios[si].color }]}>
                      {fmtCompact(val)}{viewMode === 'netCF' && <Text style={styles.valSub}>/yr</Text>}
                    </Text>
                  </View>
                );
              })}
            </Pressable>

            {/* Expanded detail panel */}
            {isActive && (
              <View style={styles.detailPanel}>
                {(['netCF', 'portfolioValue', 'equity'] as ViewMode[]).filter(m => m !== viewMode).map(m => {
                  const mLabel = m === 'netCF' ? 'Net CF/yr' : m === 'portfolioValue' ? 'Portfolio Value' : 'Equity';
                  return (
                    <View key={m} style={styles.detailRow}>
                      <Text style={styles.detailMetric}>{mLabel}</Text>
                      {checkpointRows[ci].map((row, si) => {
                        if (!row) return <View key={si} style={styles.detailValCol} />;
                        const v = getValue(row, m);
                        return (
                          <Text key={si} style={[styles.detailVal, { color: scenarios[si].color }]}>
                            {fmtCompact(v)}
                          </Text>
                        );
                      })}
                    </View>
                  );
                })}
                {/* Units row */}
                <View style={styles.detailRow}>
                  <Text style={styles.detailMetric}>Units</Text>
                  {checkpointRows[ci].map((row, si) => (
                    <Text key={si} style={[styles.detailVal, { color: scenarios[si].color }]}>
                      {row?.units ?? '—'}
                    </Text>
                  ))}
                </View>
              </View>
            )}
          </React.Fragment>
        );
      })}

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

  checkpointRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.sm, borderRadius: Radius.md },
  checkpointBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border },
  checkpointRowActive: { backgroundColor: Colors.greenDim },
  checkpointRowPressed: { backgroundColor: Colors.glassDark },
  yrLabel: { fontSize: 10, fontWeight: '700', color: Colors.textDim, letterSpacing: 0.3 },
  tapHint: { fontSize: 8, color: Colors.textDim, marginTop: 2 },
  detailPanel: {
    backgroundColor: Colors.glassDark, borderRadius: Radius.md,
    padding: Spacing.sm, marginBottom: Spacing.xs,
    borderWidth: 0.5, borderColor: Colors.border,
  },
  detailRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  detailMetric: { width: 100, fontSize: 11, color: Colors.textSecondary, fontWeight: '600' },
  detailValCol: { flex: 1 },
  detailVal: { flex: 1, fontSize: 12, fontWeight: '700', textAlign: 'center' },
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

import React, { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../../constants/theme';
import { generate30YearProjection, YearRow, PROJECTION_VALUE_PER_UNIT } from '../../../utils/projections';
import { fmt$, fmtCompact } from '../../../utils/format';
import { ExpandableSection } from './ExpandableSection';

interface Props {
  projection: YearRow[];
  startingUnits: number;
  unitsPerYear: number;
  revenue: number;
  expenses: number;
  projStyle: string;
}

const CHECKPOINTS = [10, 20, 30] as const;

export function RefiModeler({ projection, startingUnits, unitsPerYear, revenue, expenses, projStyle }: Props) {
  const currentEquity = projection[0]?.equity ?? 0;

  const [refiLTV, setRefiLTV] = useState(70);
  const [unitCost, setUnitCost] = useState(PROJECTION_VALUE_PER_UNIT);
  const DOWN_PCT = 0.20;

  const cashPulled = currentEquity * (refiLTV / 100);
  const newUnits = Math.floor(cashPulled / (unitCost * DOWN_PCT));
  const leftoverCash = cashPulled - newUnits * unitCost * DOWN_PCT;
  const newMonthlyCost = (cashPulled - leftoverCash) * 0.065 / 12; // rough interest on pulled cash

  const refiProjection = useMemo(() =>
    generate30YearProjection(
      startingUnits + newUnits,
      unitsPerYear,
      revenue,
      expenses,
      projStyle,
    ),
    [startingUnits, newUnits, unitsPerYear, revenue, expenses, projStyle],
  );

  function delta(refi: YearRow, base: YearRow) {
    return {
      netCF: refi.netCF - base.netCF,
      portfolioValue: refi.portfolioValue - base.portfolioValue,
      equity: refi.equity - base.equity,
    };
  }

  const ltvOptions = [60, 65, 70, 75, 80];

  return (
    <ExpandableSection
      title="Cash-Out Refi / BRRRR"
      subtitle="Model equity extraction and redeployment"
      iconName="refresh-circle-outline"
      badge="BRRRR"
    >
      {/* Current equity summary */}
      <View style={styles.equitySummary}>
        <View style={styles.equityItem}>
          <Text style={styles.equityVal}>{fmtCompact(currentEquity)}</Text>
          <Text style={styles.equityLabel}>Current Equity</Text>
        </View>
        <Ionicons name="arrow-forward" size={16} color={Colors.textDim} />
        <View style={styles.equityItem}>
          <Text style={[styles.equityVal, { color: Colors.green }]}>{fmtCompact(cashPulled)}</Text>
          <Text style={styles.equityLabel}>Cash Pulled</Text>
        </View>
        <Ionicons name="arrow-forward" size={16} color={Colors.textDim} />
        <View style={styles.equityItem}>
          <Text style={[styles.equityVal, { color: '#6366F1' }]}>{newUnits}</Text>
          <Text style={styles.equityLabel}>New Units</Text>
        </View>
      </View>

      {/* LTV selector */}
      <Text style={styles.sectionLabel}>REFI LTV</Text>
      <View style={styles.ltvRow}>
        {ltvOptions.map(v => (
          <TouchableOpacity
            key={v}
            activeOpacity={0.7}
            style={[styles.ltvBtn, refiLTV === v && styles.ltvBtnActive]}
            onPress={() => setRefiLTV(v)}
          >
            <Text style={[styles.ltvText, refiLTV === v && styles.ltvTextActive]}>{v}%</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Unit cost selector */}
      <View style={styles.unitCostRow}>
        <Text style={styles.sectionLabel}>AVG UNIT COST</Text>
        <View style={styles.unitCostControls}>
          <TouchableOpacity activeOpacity={0.7} style={styles.stepBtn} onPress={() => setUnitCost(v => Math.max(50000, v - 25000))}>
            <Ionicons name="remove" size={14} color={Colors.textSecondary} />
          </TouchableOpacity>
          <Text style={styles.unitCostVal}>{fmtCompact(unitCost)}</Text>
          <TouchableOpacity activeOpacity={0.7} style={styles.stepBtn} onPress={() => setUnitCost(v => v + 25000)}>
            <Ionicons name="add" size={14} color={Colors.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>

      {newUnits === 0 && (
        <View style={styles.noUnitsHint}>
          <Ionicons name="information-circle-outline" size={14} color={Colors.textDim} />
          <Text style={styles.noUnitsText}>
            Not enough equity to buy a unit at {fmtCompact(unitCost)} with {DOWN_PCT * 100}% down.
            Need {fmt$(unitCost * DOWN_PCT)} — you have {fmt$(cashPulled)}.
          </Text>
        </View>
      )}

      {/* Comparison table */}
      {newUnits > 0 && (
        <>
          <View style={styles.tableHeader}>
            <Text style={[styles.thCell, { flex: 0.8 }]}>YEAR</Text>
            <Text style={styles.thCell}>BASELINE</Text>
            <Text style={styles.thCell}>AFTER REFI</Text>
            <Text style={[styles.thCell, { color: Colors.green }]}>DELTA</Text>
          </View>
          {CHECKPOINTS.map(yr => {
            const base = projection.find(r => r.yearOffset === yr);
            const refi = refiProjection.find(r => r.yearOffset === yr);
            if (!base || !refi) return null;
            const d = delta(refi, base);
            return (
              <View key={yr} style={styles.tableRow}>
                <Text style={[styles.tdCell, styles.tdBold, { flex: 0.8 }]}>Yr {yr}</Text>
                <View style={styles.tdMulti}>
                  <Text style={styles.tdCell}>{fmtCompact(base.netCF)}/yr</Text>
                  <Text style={styles.tdSub}>{fmtCompact(base.portfolioValue)} val</Text>
                </View>
                <View style={styles.tdMulti}>
                  <Text style={[styles.tdCell, { color: Colors.green }]}>{fmtCompact(refi.netCF)}/yr</Text>
                  <Text style={styles.tdSub}>{fmtCompact(refi.portfolioValue)} val</Text>
                </View>
                <View style={styles.tdMulti}>
                  <Text style={[styles.tdCell, { color: d.netCF >= 0 ? Colors.green : Colors.red }]}>
                    {d.netCF >= 0 ? '+' : ''}{fmtCompact(d.netCF)}
                  </Text>
                  <Text style={[styles.tdSub, { color: d.portfolioValue >= 0 ? Colors.green : Colors.red }]}>
                    {d.portfolioValue >= 0 ? '+' : ''}{fmtCompact(d.portfolioValue)}
                  </Text>
                </View>
              </View>
            );
          })}
        </>
      )}

      <Text style={styles.disclaimer}>
        Assumes {DOWN_PCT * 100}% down on new units · 6.5% refi rate · {unitsPerYear} units/yr acquisition unchanged
      </Text>
    </ExpandableSection>
  );
}

const styles = StyleSheet.create({
  equitySummary: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around',
    backgroundColor: Colors.glassDark, borderRadius: Radius.lg,
    padding: Spacing.sm, marginBottom: Spacing.md,
  },
  equityItem: { alignItems: 'center' },
  equityVal: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  equityLabel: { fontSize: 10, color: Colors.textDim, marginTop: 2 },

  sectionLabel: { fontSize: 10, fontWeight: '700', color: Colors.textDim, letterSpacing: 0.5, marginBottom: Spacing.xs },
  ltvRow: { flexDirection: 'row', gap: Spacing.xs, marginBottom: Spacing.md },
  ltvBtn: {
    flex: 1, paddingVertical: 6, alignItems: 'center',
    backgroundColor: Colors.glassDark, borderRadius: Radius.md,
    borderWidth: 0.5, borderColor: Colors.border,
  },
  ltvBtnActive: { backgroundColor: Colors.greenDim, borderColor: Colors.green },
  ltvText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary },
  ltvTextActive: { color: Colors.green },

  unitCostRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.md },
  unitCostControls: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  stepBtn: {
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: Colors.glassDark, borderWidth: 0.5, borderColor: Colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  unitCostVal: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text, minWidth: 60, textAlign: 'center' },

  noUnitsHint: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.xs,
    backgroundColor: Colors.yellowDim, borderRadius: Radius.md,
    padding: Spacing.sm, marginBottom: Spacing.md,
  },
  noUnitsText: { fontSize: FontSize.xs, color: Colors.textSecondary, flex: 1, lineHeight: 16 },

  tableHeader: { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: Colors.border },
  thCell: { flex: 1, fontSize: 9, fontWeight: '700', color: Colors.textDim, letterSpacing: 0.5, textAlign: 'center' },
  tableRow: {
    flexDirection: 'row', paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
    alignItems: 'center',
  },
  tdCell: { fontSize: FontSize.xs, fontWeight: '700', color: Colors.text, textAlign: 'center' },
  tdBold: { fontWeight: '800' },
  tdSub: { fontSize: 10, color: Colors.textDim, textAlign: 'center' },
  tdMulti: { flex: 1, alignItems: 'center' },

  disclaimer: {
    fontSize: 10, color: Colors.textDim, fontStyle: 'italic',
    marginTop: Spacing.sm, textAlign: 'center',
  },
});

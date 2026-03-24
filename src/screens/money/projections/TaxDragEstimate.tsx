import React, { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Colors, FontSize, Spacing, Radius } from '../../../constants/theme';
import { YearRow } from '../../../utils/projections';
import { fmtCompact, fmt$ } from '../../../utils/format';
import { ExpandableSection } from './ExpandableSection';

interface Props {
  projection: YearRow[];
  startingUnits: number;
}

// Simple IRR via Newton-Raphson on annual cash flows
function calculateIRR(cashFlows: number[]): number | null {
  if (cashFlows.length < 2) return null;
  let rate = 0.08;
  for (let iter = 0; iter < 200; iter++) {
    let npv = 0;
    let dnpv = 0;
    for (let t = 0; t < cashFlows.length; t++) {
      const disc = Math.pow(1 + rate, t);
      npv += cashFlows[t] / disc;
      dnpv -= (t * cashFlows[t]) / (disc * (1 + rate));
    }
    if (Math.abs(dnpv) < 1e-12) break;
    const next = rate - npv / dnpv;
    if (Math.abs(next - rate) < 1e-7) { rate = next; break; }
    rate = Math.max(-0.99, Math.min(5, next));
  }
  return isFinite(rate) ? rate : null;
}

const TAX_RATE_INCOME = 0.22;  // effective federal rate on rental income
const TAX_RATE_DEPR = 0.25;   // depreciation shield rate
const DEPR_YEARS = 27.5;
const STRUCT_PCT = 0.80;       // 80% of property value is depreciable structure

export function TaxDragEstimate({ projection, startingUnits }: Props) {
  const [taxRate, setTaxRate] = useState(TAX_RATE_INCOME);
  const TAX_RATES = [0.12, 0.22, 0.32, 0.37];

  // Guard: if key inputs are missing, show placeholder instead of bogus -99% IRR
  const hasData = useMemo(() => {
    if (!projection || projection.length < 2) return false;
    const first = projection[0];
    if (!first.portfolioValue || first.portfolioValue <= 0) return false;
    if (!first.equity || first.equity <= 0) return false;
    // Need meaningful revenue somewhere in the projection
    return projection.some(r => r.revenue > 0);
  }, [projection]);

  const rows = useMemo(() => projection.map(r => {
    const depreciableBase = r.portfolioValue * STRUCT_PCT;
    const annualDepr = depreciableBase / DEPR_YEARS;
    const deprBenefit = annualDepr * TAX_RATE_DEPR;
    const taxOnIncome = Math.max(0, r.netCF) * taxRate;
    const afterTaxNetCF = r.netCF + deprBenefit - taxOnIncome;
    const netTaxEffect = deprBenefit - taxOnIncome;
    return { ...r, annualDepr, deprBenefit, taxOnIncome, afterTaxNetCF, netTaxEffect };
  }), [projection, taxRate]);

  // IRR calc: year 0 = -initial equity invested, subsequent = 5-yr annual net CF
  // Expand 5-year steps to annual for better IRR accuracy
  const annualCFs = useMemo(() => {
    const cfs: number[] = [];
    const initialInvestment = -(projection[0]?.equity || 0);
    if (Math.abs(initialInvestment) < 1) return null;
    cfs.push(initialInvestment);
    for (let i = 1; i < rows.length; i++) {
      const annualCF = rows[i].afterTaxNetCF / 5; // divide 5-year chunk into annual
      for (let y = 0; y < 5; y++) cfs.push(annualCF);
    }
    // Add terminal value in year 30
    const lastRow = rows[rows.length - 1];
    cfs[cfs.length - 1] += lastRow.portfolioValue;
    return cfs;
  }, [rows, projection]);

  const nominalIRR = useMemo(() => {
    if (!annualCFs) return null;
    return calculateIRR(annualCFs);
  }, [annualCFs]);

  const irrValid = (v: number | null): boolean => v !== null && v > -0.95 && v < 5;
  const nominalIRRStr = irrValid(nominalIRR) ? `${(nominalIRR! * 100).toFixed(1)}%` : 'N/A';

  // After-tax IRR (same structure but using afterTaxNetCF)
  const afterTaxIRR = useMemo(() => {
    if (!annualCFs || !projection[0]?.equity) return null;
    const cfs: number[] = [-(projection[0].equity)];
    for (let i = 1; i < rows.length; i++) {
      const annualCF = rows[i].afterTaxNetCF / 5;
      for (let y = 0; y < 5; y++) cfs.push(annualCF);
    }
    cfs[cfs.length - 1] += rows[rows.length - 1].portfolioValue;
    return calculateIRR(cfs);
  }, [rows, projection]);

  const afterTaxIRRStr = irrValid(afterTaxIRR) ? `${(afterTaxIRR! * 100).toFixed(1)}%` : 'N/A';

  // Summary for Yr 10 and Yr 30
  const yr10 = rows.find(r => r.yearOffset === 10);
  const yr30 = rows[rows.length - 1];

  if (!hasData) {
    return (
      <ExpandableSection
        title="Tax Drag Estimate"
        subtitle="After-tax net CF, depreciation shield, and IRR"
        iconName="receipt-outline"
        badge="BALLPARK"
      >
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>Add property details to see your IRR</Text>
        </View>
      </ExpandableSection>
    );
  }

  return (
    <ExpandableSection
      title="Tax Drag Estimate"
      subtitle="After-tax net CF, depreciation shield, and IRR"
      iconName="receipt-outline"
      badge="BALLPARK"
    >
      {/* Tax rate selector */}
      <Text style={styles.sectionLabel}>YOUR MARGINAL TAX RATE</Text>
      <View style={styles.taxRateRow}>
        {TAX_RATES.map(r => (
          <TouchableOpacity
            key={r}
            activeOpacity={0.7}
            style={[styles.taxBtn, taxRate === r && styles.taxBtnActive]}
            onPress={() => setTaxRate(r)}
          >
            <Text style={[styles.taxText, taxRate === r && styles.taxTextActive]}>{(r * 100).toFixed(0)}%</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* IRR Summary */}
      <View style={styles.irrRow}>
        <View style={styles.irrItem}>
          <Text style={styles.irrLabel}>NOMINAL IRR</Text>
          <Text style={styles.irrLabelPlain}>your return before taxes</Text>
          <Text style={styles.irrVal}>{nominalIRRStr}</Text>
          <Text style={styles.irrSub}>pre-tax, 30-yr</Text>
        </View>
        <View style={styles.irrDivider} />
        <View style={styles.irrItem}>
          <Text style={styles.irrLabel}>AFTER-TAX IRR</Text>
          <Text style={styles.irrLabelPlain}>what you actually keep</Text>
          <Text style={[styles.irrVal, { color: Colors.green }]}>{afterTaxIRRStr}</Text>
          <Text style={styles.irrSub}>with depr. shield</Text>
        </View>
        <View style={styles.irrDivider} />
        <View style={styles.irrItem}>
          <Text style={styles.irrLabel}>TAX DRAG</Text>
          <Text style={styles.irrLabelPlain}>what taxes cost you</Text>
          <Text style={[styles.irrVal, { color: Colors.red }]}>
            {irrValid(nominalIRR) && irrValid(afterTaxIRR)
              ? `${((nominalIRR! - afterTaxIRR!) * 100).toFixed(1)}%`
              : 'N/A'}
          </Text>
          <Text style={styles.irrSub}>IRR haircut</Text>
        </View>
      </View>

      {/* Year-by-year table */}
      <View style={styles.tableHeader}>
        <Text style={[styles.tdCell, styles.thCellText, { flex: 0.7 }]}>YR</Text>
        <Text style={[styles.tdCell, styles.thCellText]}>GROSS{'\n'}CF</Text>
        <Text style={[styles.tdCell, styles.thCellText]}>DEPR +{'\n'}
          <Text style={styles.thCellSub}>write-off</Text>
        </Text>
        <Text style={[styles.tdCell, styles.thCellText]}>TAX −{'\n'}
          <Text style={styles.thCellSub}>owed</Text>
        </Text>
        <Text style={[styles.tdCell, styles.thCellText, { color: Colors.green }]}>AFTER-{'\n'}TAX</Text>
      </View>
      {rows.filter(r => r.yearOffset % 3 === 0).map((r, i) => (
        <View key={r.yearOffset} style={[styles.tableRow, i % 2 === 0 && styles.tableRowAlt]}>
          <Text style={[styles.tdCell, styles.tdBold, { flex: 0.7 }]}>{r.yearOffset}</Text>
          <Text style={styles.tdCell}>{fmtCompact(r.netCF)}</Text>
          <Text style={[styles.tdCell, { color: Colors.green }]}>+{fmtCompact(r.deprBenefit)}</Text>
          <Text style={[styles.tdCell, { color: Colors.red }]}>-{fmtCompact(r.taxOnIncome)}</Text>
          <Text style={[styles.tdCell, { color: r.afterTaxNetCF >= 0 ? Colors.green : Colors.red, fontWeight: '800' }]}>
            {fmtCompact(r.afterTaxNetCF)}
          </Text>
        </View>
      ))}

      {/* Depreciation note */}
      <View style={styles.deprNote}>
        <Text style={styles.deprNoteTitle}>How Depreciation Works Here</Text>
        <Text style={styles.deprNoteText}>
          {(STRUCT_PCT * 100).toFixed(0)}% of portfolio value depreciates over {DEPR_YEARS} years.
          At a {(TAX_RATE_DEPR * 100).toFixed(0)}% shield rate, this offsets taxable income annually.
          Actual results depend on cost segregation, 1031 exchanges, and your full tax picture —
          consult a CPA for exact figures.
        </Text>
      </View>
    </ExpandableSection>
  );
}

const styles = StyleSheet.create({
  sectionLabel: { fontSize: 10, fontWeight: '700', color: Colors.textDim, letterSpacing: 0.5, marginBottom: Spacing.xs },

  taxRateRow: { flexDirection: 'row', gap: Spacing.xs, marginBottom: Spacing.md },
  taxBtn: {
    flex: 1, paddingVertical: 6, alignItems: 'center',
    backgroundColor: Colors.glassDark, borderRadius: Radius.md,
    borderWidth: 0.5, borderColor: Colors.border,
  },
  taxBtnActive: { backgroundColor: Colors.greenDim, borderColor: Colors.green },
  taxText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary },
  taxTextActive: { color: Colors.green },

  irrRow: {
    flexDirection: 'row', alignItems: 'stretch',
    backgroundColor: Colors.glassDark, borderRadius: Radius.lg,
    padding: Spacing.sm, marginBottom: Spacing.md,
  },
  irrItem: { flex: 1, alignItems: 'center', justifyContent: 'flex-start', paddingHorizontal: 4 },
  irrLabel: { fontSize: 9, fontWeight: '700', color: Colors.textDim, letterSpacing: 0.4, marginBottom: 1, textAlign: 'center' },
  irrLabelPlain: { fontSize: 9, color: '#999', marginBottom: 3, textAlign: 'center', minHeight: 22 },
  irrVal: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, textAlign: 'center' },
  irrSub: { fontSize: 10, color: Colors.textDim, marginTop: 2 },
  irrDivider: { width: StyleSheet.hairlineWidth, height: 40, backgroundColor: Colors.border },

  tableHeader: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: Colors.border },
  thCellWrap: { flex: 1, alignItems: 'center' },
  thCell: { flex: 1, fontSize: 9, fontWeight: '700', color: Colors.textDim, letterSpacing: 0.5, textAlign: 'center' },
  thCellText: { fontSize: 9, fontWeight: '700', color: Colors.textDim, letterSpacing: 0.5, textAlign: 'center' },
  thCellSub: { fontSize: 8, color: '#999', textAlign: 'center' },
  tableRow: { flexDirection: 'row', paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border },
  tableRowAlt: { backgroundColor: 'rgba(0,0,0,0.015)' },
  tdCell: { flex: 1, fontSize: 11, fontWeight: '600', color: Colors.text, textAlign: 'center' },
  tdBold: { fontWeight: '800' },

  deprNote: {
    marginTop: Spacing.md, backgroundColor: Colors.glassDark,
    borderRadius: Radius.lg, padding: Spacing.sm,
  },
  deprNoteTitle: { fontSize: FontSize.xs, fontWeight: '700', color: Colors.textSecondary, marginBottom: 4 },
  deprNoteText: { fontSize: 11, color: Colors.textDim, lineHeight: 16 },

  placeholder: { paddingVertical: Spacing.xl, alignItems: 'center' },
  placeholderText: { fontSize: FontSize.sm, color: Colors.textDim, fontWeight: '500', textAlign: 'center' },
});

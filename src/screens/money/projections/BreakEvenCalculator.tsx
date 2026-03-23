import React, { useState } from 'react';
import { View, Text, TouchableOpacity, TextInput, ScrollView, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../../constants/theme';
import { fmt$, fmtCompact } from '../../../utils/format';
import { ExpandableSection } from './ExpandableSection';

interface UserProperty {
  id?: string;
  name: string;
  address: string;
  units: number;
  purchasePrice?: number;
  downPaymentPct?: number;
}

interface Props {
  properties: UserProperty[];
  monthlyRevenue: number;
  monthlyExpenses: number;
  startingUnits: number;
}

interface ManualEntry {
  purchasePrice: string;
  downPaymentPct: string;
  monthlyNet: string;
}

function breakEvenMonths(invested: number, monthlyNet: number): number | null {
  if (monthlyNet <= 0) return null;
  return invested / monthlyNet;
}

function formatBreakEven(months: number | null): string {
  if (months === null) return 'N/A';
  if (months > 600) return '>50 yrs';
  const yrs = Math.floor(months / 12);
  const mo = Math.round(months % 12);
  if (yrs === 0) return `${mo}mo`;
  if (mo === 0) return `${yrs}yr`;
  return `${yrs}yr ${mo}mo`;
}

export function BreakEvenCalculator({ properties, monthlyRevenue, monthlyExpenses, startingUnits }: Props) {
  const [showManual, setShowManual] = useState(false);
  const [manual, setManual] = useState<ManualEntry>({
    purchasePrice: '300000',
    downPaymentPct: '20',
    monthlyNet: '',
  });

  const monthlyNet = startingUnits > 0 ? monthlyRevenue - monthlyExpenses : 0;
  const netPerUnit = startingUnits > 0 ? monthlyNet / startingUnits : 0;

  const propCards = properties.map(p => {
    const price = p.purchasePrice || 150000;
    const downPct = (p.downPaymentPct ?? 20) / 100;
    const down = price * downPct;
    const unitNetCF = netPerUnit * (p.units || 1);
    const months = breakEvenMonths(down, unitNetCF);
    const cocReturn = unitNetCF > 0 ? (unitNetCF * 12) / down * 100 : 0;
    return { p, price, down, unitNetCF, months, cocReturn };
  });

  // Manual calculation
  const manualPrice = parseFloat(manual.purchasePrice) || 0;
  const manualDown = manualPrice * ((parseFloat(manual.downPaymentPct) || 20) / 100);
  const manualNetCF = parseFloat(manual.monthlyNet) || netPerUnit;
  const manualMonths = breakEvenMonths(manualDown, manualNetCF);
  const manualCoC = manualNetCF > 0 && manualDown > 0 ? (manualNetCF * 12) / manualDown * 100 : 0;

  return (
    <ExpandableSection
      title="Break-Even & Payback"
      subtitle="Time to recoup your down payment per deal"
      iconName="timer-outline"
    >
      {/* Portfolio-level summary */}
      {startingUnits > 0 && (
        <View style={styles.summaryRow}>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryVal}>{fmt$(monthlyNet)}</Text>
            <Text style={styles.summaryLabel}>net CF/mo</Text>
          </View>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryVal}>{fmt$(netPerUnit)}</Text>
            <Text style={styles.summaryLabel}>per unit/mo</Text>
          </View>
          <View style={styles.summaryItem}>
            <Text style={[styles.summaryVal, { color: Colors.green }]}>
              {netPerUnit > 0 ? `${((netPerUnit * 12) / (150000 * 0.2) * 100).toFixed(1)}%` : '—'}
            </Text>
            <Text style={styles.summaryLabel}>est. CoC return</Text>
          </View>
        </View>
      )}

      {/* Per-property cards */}
      {propCards.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.propScroll}>
          {propCards.map(({ p, price, down, unitNetCF, months, cocReturn }) => (
            <View key={p.id || p.name} style={styles.propCard}>
              <Text style={styles.propName} numberOfLines={1}>{p.name}</Text>
              <Text style={styles.propUnits}>{p.units} unit{p.units !== 1 ? 's' : ''}</Text>
              <View style={styles.propDivider} />
              <Text style={styles.breakEvenVal}>{formatBreakEven(months)}</Text>
              <Text style={styles.breakEvenLabel}>payback</Text>
              <View style={styles.propRow}>
                <Text style={styles.propMeta}>Down: {fmtCompact(down)}</Text>
              </View>
              <View style={styles.propRow}>
                <Text style={[styles.cocVal, { color: cocReturn > 8 ? Colors.green : cocReturn > 4 ? Colors.yellow : Colors.red }]}>
                  {cocReturn.toFixed(1)}% CoC
                </Text>
              </View>
            </View>
          ))}
        </ScrollView>
      )}

      {propCards.length === 0 && (
        <Text style={styles.noPropsHint}>Add properties in Settings to see per-deal breakdowns.</Text>
      )}

      {/* Manual Deal Calculator */}
      <TouchableOpacity activeOpacity={0.7} style={styles.manualToggle} onPress={() => setShowManual(s => !s)}>
        <Ionicons name="calculator-outline" size={14} color={Colors.textSecondary} />
        <Text style={styles.manualToggleText}>Model a New Deal</Text>
        <Ionicons name={showManual ? 'chevron-up' : 'chevron-down'} size={14} color={Colors.textDim} />
      </TouchableOpacity>

      {showManual && (
        <View style={styles.manualBox}>
          <View style={styles.inputRow}>
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Purchase Price</Text>
              <TextInput
                style={styles.input}
                value={manual.purchasePrice}
                onChangeText={v => setManual(m => ({ ...m, purchasePrice: v }))}
                keyboardType="numeric"
                placeholder="300000"
                placeholderTextColor={Colors.textDim}
              />
            </View>
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Down % </Text>
              <TextInput
                style={styles.input}
                value={manual.downPaymentPct}
                onChangeText={v => setManual(m => ({ ...m, downPaymentPct: v }))}
                keyboardType="numeric"
                placeholder="20"
                placeholderTextColor={Colors.textDim}
              />
            </View>
          </View>
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Monthly Net CF (leave blank to use portfolio avg)</Text>
            <TextInput
              style={styles.input}
              value={manual.monthlyNet}
              onChangeText={v => setManual(m => ({ ...m, monthlyNet: v }))}
              keyboardType="numeric"
              placeholder={netPerUnit > 0 ? `${netPerUnit.toFixed(0)} (portfolio avg)` : '0'}
              placeholderTextColor={Colors.textDim}
            />
          </View>

          <View style={styles.manualResults}>
            <View style={styles.manualResultItem}>
              <Text style={styles.manualResultVal}>{fmtCompact(manualDown)}</Text>
              <Text style={styles.manualResultLabel}>Down Payment</Text>
            </View>
            <View style={styles.manualResultItem}>
              <Text style={[styles.manualResultVal, { color: Colors.green }]}>{formatBreakEven(manualMonths)}</Text>
              <Text style={styles.manualResultLabel}>Payback Period</Text>
            </View>
            <View style={styles.manualResultItem}>
              <Text style={[styles.manualResultVal, {
                color: manualCoC > 8 ? Colors.green : manualCoC > 4 ? Colors.yellow : Colors.red,
              }]}>
                {manualCoC.toFixed(1)}%
              </Text>
              <Text style={styles.manualResultLabel}>Cash-on-Cash</Text>
            </View>
          </View>
        </View>
      )}
    </ExpandableSection>
  );
}

const styles = StyleSheet.create({
  summaryRow: {
    flexDirection: 'row', justifyContent: 'space-around',
    backgroundColor: Colors.glassDark, borderRadius: Radius.lg,
    padding: Spacing.sm, marginBottom: Spacing.md,
  },
  summaryItem: { alignItems: 'center' },
  summaryVal: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text },
  summaryLabel: { fontSize: 10, color: Colors.textDim, marginTop: 2 },

  propScroll: { marginBottom: Spacing.md },
  propCard: {
    width: 130, backgroundColor: Colors.glassDark,
    borderRadius: Radius.lg, padding: Spacing.sm,
    marginRight: Spacing.sm, borderWidth: 0.5, borderColor: Colors.border,
  },
  propName: { fontSize: 12, fontWeight: '700', color: Colors.text },
  propUnits: { fontSize: 10, color: Colors.textDim, marginBottom: Spacing.xs },
  propDivider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border, marginVertical: Spacing.xs },
  breakEvenVal: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  breakEvenLabel: { fontSize: 9, color: Colors.textDim, marginBottom: Spacing.xs },
  propRow: { flexDirection: 'row', marginTop: 2 },
  propMeta: { fontSize: 11, color: Colors.textSecondary },
  cocVal: { fontSize: 11, fontWeight: '700' },

  noPropsHint: { fontSize: FontSize.xs, color: Colors.textDim, fontStyle: 'italic', marginBottom: Spacing.sm },

  manualToggle: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs,
    paddingVertical: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border,
  },
  manualToggleText: { fontSize: FontSize.sm, color: Colors.textSecondary, flex: 1, fontWeight: '600' },

  manualBox: { marginTop: Spacing.sm },
  inputRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.sm },
  inputGroup: { flex: 1, marginBottom: Spacing.sm },
  inputLabel: { fontSize: 11, color: Colors.textDim, marginBottom: 4, fontWeight: '600' },
  input: {
    backgroundColor: Colors.glassDark,
    borderRadius: Radius.md, borderWidth: 0.5, borderColor: Colors.glassBorder,
    paddingHorizontal: Spacing.sm, paddingVertical: 8,
    fontSize: FontSize.sm, color: Colors.text,
  },
  manualResults: {
    flexDirection: 'row', justifyContent: 'space-around',
    backgroundColor: Colors.glassDark, borderRadius: Radius.lg,
    padding: Spacing.sm, marginTop: Spacing.xs,
  },
  manualResultItem: { alignItems: 'center' },
  manualResultVal: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  manualResultLabel: { fontSize: 10, color: Colors.textDim, marginTop: 2 },
});

import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
  TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useDataStore } from '../../store/dataStore';
import { Card } from '../../components/Card';
import { SectionHeader } from '../../components/SectionHeader';
import { EmptyState } from '../../components/EmptyState';
import { fmt$, fmtMonthYear, currentYear } from '../../utils/format';

interface MonthSummary {
  month: string;
  revenue: number;
  expenses: number;
  net: number;
  txCount: number;
}

export function MoneyScreen() {
  const navigation = useNavigation<any>();
  const { fetchTransactions, fetchTags, fetchProps } = useDataStore();
  const [months, setMonths] = useState<MonthSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [year, setYear] = useState(currentYear());
  const [error, setError] = useState('');

  const load = useCallback(async (force = false) => {
    try {
      setError('');
      const [txs, tags, props] = await Promise.all([
        fetchTransactions(force),
        fetchTags(force),
        fetchProps(force),
      ]);

      // Aggregate by month for selected year
      const byMonth: Record<string, MonthSummary> = {};
      for (let m = 1; m <= 12; m++) {
        const key = `${year}-${String(m).padStart(2, '0')}`;
        byMonth[key] = { month: key, revenue: 0, expenses: 0, net: 0, txCount: 0 };
      }

      (txs || []).forEach((tx: any) => {
        const d = (tx.user_date || tx.date || '').slice(0, 7);
        if (!byMonth[d]) return;
        byMonth[d].txCount++;
        if (tx.type === 'in' || tx.tx_type === 'in') {
          byMonth[d].revenue += Math.abs(tx.amount);
        } else {
          byMonth[d].expenses += Math.abs(tx.amount);
        }
      });

      Object.values(byMonth).forEach(m => {
        m.net = m.revenue - m.expenses;
      });

      const sorted = Object.values(byMonth).sort((a, b) => b.month.localeCompare(a.month));
      setMonths(sorted);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [fetchTransactions, fetchTags, fetchProps, year]);

  useEffect(() => { load(); }, [year]);
  const onRefresh = () => { setRefreshing(true); load(true); };

  const totalRev = months.reduce((s, m) => s + m.revenue, 0);
  const totalExp = months.reduce((s, m) => s + m.expenses, 0);
  const totalNet = totalRev - totalExp;

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
    >
      {error ? <Card><Text style={styles.error}>{error}</Text></Card> : null}

      {/* Year selector */}
      <View style={styles.yearRow}>
        <TouchableOpacity onPress={() => setYear(y => y - 1)} style={styles.yearBtn}>
          <Text style={styles.yearBtnText}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.yearLabel}>{year}</Text>
        <TouchableOpacity onPress={() => setYear(y => y + 1)} style={styles.yearBtn}>
          <Text style={styles.yearBtnText}>›</Text>
        </TouchableOpacity>
      </View>

      {/* Annual summary */}
      <Card>
        <View style={styles.summaryRow}>
          <SummaryCol label="Revenue" value={fmt$(totalRev)} color={Colors.green} />
          <SummaryCol label="Expenses" value={fmt$(totalExp)} color={Colors.red} />
          <SummaryCol label="Net" value={fmt$(totalNet)} color={totalNet >= 0 ? Colors.green : Colors.red} />
        </View>
      </Card>

      <SectionHeader title="By Month" />

      {months.filter(m => m.txCount > 0 || true).map(m => (
        <TouchableOpacity
          key={m.month}
          onPress={() => navigation.navigate('MonthDetail', { month: m.month, year })}
          activeOpacity={0.7}
        >
          <Card padding={Spacing.sm}>
            <View style={styles.monthRow}>
              <Text style={styles.monthName}>{fmtMonthYear(m.month + '-01')}</Text>
              <View style={styles.monthAmounts}>
                {m.revenue > 0 && (
                  <Text style={[styles.amt, { color: Colors.green }]}>+{fmt$(m.revenue, true)}</Text>
                )}
                {m.expenses > 0 && (
                  <Text style={[styles.amt, { color: Colors.red }]}>-{fmt$(m.expenses, true)}</Text>
                )}
              </View>
              <Text style={[styles.net, { color: m.net >= 0 ? Colors.green : Colors.red }]}>
                {m.net >= 0 ? '+' : ''}{fmt$(m.net, true)}
              </Text>
              <Text style={styles.chevron}>›</Text>
            </View>
          </Card>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

function SummaryCol({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={{ alignItems: 'center', flex: 1 }}>
      <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary }}>{label}</Text>
      <Text style={{ fontSize: FontSize.lg, fontWeight: '700', color }}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Spacing.md, paddingBottom: Spacing.xl },
  center: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },
  error: { color: Colors.red, fontSize: FontSize.sm },
  yearRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.md },
  yearBtn: { padding: Spacing.md },
  yearBtnText: { color: Colors.primary, fontSize: FontSize.xl },
  yearLabel: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, minWidth: 60, textAlign: 'center' },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-around' },
  monthRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  monthName: { flex: 1, color: Colors.text, fontSize: FontSize.sm, fontWeight: '500' },
  monthAmounts: { flexDirection: 'row', gap: 4 },
  amt: { fontSize: FontSize.xs },
  net: { fontSize: FontSize.sm, fontWeight: '600', minWidth: 58, textAlign: 'right' },
  chevron: { color: Colors.textDim, fontSize: FontSize.md, marginLeft: 4 },
});

import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { useRoute } from '@react-navigation/native';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useDataStore } from '../../store/dataStore';
import { Card } from '../../components/Card';
import { SectionHeader } from '../../components/SectionHeader';
import { EmptyState } from '../../components/EmptyState';
import { fmt$, fmtDate, fmtMonthYear } from '../../utils/format';

export function MonthDetailScreen() {
  const route = useRoute<any>();
  const { month } = route.params;
  const { fetchTransactions, fetchTags, fetchProps } = useDataStore();
  const [txs, setTxs] = useState<any[]>([]);
  const [tags, setTags] = useState<Record<string, string>>({});
  const [props, setProps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'in' | 'out'>('all');
  const [propFilter, setPropFilter] = useState<string>('all');

  useEffect(() => {
    (async () => {
      try {
        const [allTxs, allTags, allProps] = await Promise.all([
          fetchTransactions(),
          fetchTags(),
          fetchProps(),
        ]);
        const monthTxs = (allTxs || []).filter((tx: any) =>
          (tx.user_date || tx.date || '').slice(0, 7) === month
        );
        setTxs(monthTxs);
        setTags(allTags || {});
        setProps(allProps || []);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    })();
  }, [month]);

  const filtered = txs.filter(tx => {
    const t = tx.type || tx.tx_type;
    if (filter !== 'all' && t !== filter) return false;
    if (propFilter !== 'all' && tags[tx.id] !== propFilter) return false;
    return true;
  });

  const revenue = filtered.filter(t => (t.type || t.tx_type) === 'in').reduce((s, t) => s + Math.abs(t.amount), 0);
  const expenses = filtered.filter(t => (t.type || t.tx_type) === 'out').reduce((s, t) => s + Math.abs(t.amount), 0);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Summary */}
      <Card>
        <View style={styles.summaryRow}>
          <View style={styles.summaryCol}>
            <Text style={styles.summaryLabel}>Revenue</Text>
            <Text style={[styles.summaryVal, { color: Colors.green }]}>{fmt$(revenue)}</Text>
          </View>
          <View style={styles.summaryCol}>
            <Text style={styles.summaryLabel}>Expenses</Text>
            <Text style={[styles.summaryVal, { color: Colors.red }]}>{fmt$(expenses)}</Text>
          </View>
          <View style={styles.summaryCol}>
            <Text style={styles.summaryLabel}>Net</Text>
            <Text style={[styles.summaryVal, { color: (revenue - expenses) >= 0 ? Colors.green : Colors.red }]}>
              {fmt$(revenue - expenses)}
            </Text>
          </View>
        </View>
      </Card>

      {/* Type filter pills */}
      <View style={styles.pills}>
        {(['all', 'in', 'out'] as const).map(f => (
          <TouchableOpacity
            key={f}
            style={[styles.pill, filter === f && styles.pillActive]}
            onPress={() => setFilter(f)}
          >
            <Text style={[styles.pillText, filter === f && styles.pillTextActive]}>
              {f === 'all' ? 'All' : f === 'in' ? 'Income' : 'Expenses'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Property filter */}
      {props.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.propScroll}>
          <TouchableOpacity
            style={[styles.pill, propFilter === 'all' && styles.pillActive]}
            onPress={() => setPropFilter('all')}
          >
            <Text style={[styles.pillText, propFilter === 'all' && styles.pillTextActive]}>All Props</Text>
          </TouchableOpacity>
          {props.map((p: any) => (
            <TouchableOpacity
              key={p.id || p.prop_id}
              style={[styles.pill, propFilter === (p.id || p.prop_id) && styles.pillActive]}
              onPress={() => setPropFilter(p.id || p.prop_id)}
            >
              <Text style={[styles.pillText, propFilter === (p.id || p.prop_id) && styles.pillTextActive]}>
                {p.label || p.id}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      <SectionHeader title={`Transactions (${filtered.length})`} />

      {filtered.length === 0 ? (
        <EmptyState icon="💸" message="No transactions" />
      ) : (
        filtered.map((tx: any, i: number) => {
          const isIn = (tx.type || tx.tx_type) === 'in';
          const propId = tags[tx.id];
          const prop = props.find((p: any) => (p.id || p.prop_id) === propId);
          return (
            <Card key={tx.id || i} padding={Spacing.sm}>
              <View style={styles.txRow}>
                <View style={styles.txInfo}>
                  <Text style={styles.txPayee} numberOfLines={1}>{tx.payee || 'Unknown'}</Text>
                  <Text style={styles.txMeta}>
                    {fmtDate(tx.user_date || tx.date)}
                    {prop ? ` · ${prop.label || prop.id}` : ''}
                    {tx.account_name ? ` · ${tx.account_name}` : ''}
                  </Text>
                </View>
                <Text style={[styles.txAmt, { color: isIn ? Colors.green : Colors.red }]}>
                  {isIn ? '+' : '-'}{fmt$(Math.abs(tx.amount))}
                </Text>
              </View>
            </Card>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Spacing.md, paddingBottom: Spacing.xl },
  center: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },
  summaryRow: { flexDirection: 'row' },
  summaryCol: { flex: 1, alignItems: 'center' },
  summaryLabel: { fontSize: FontSize.xs, color: Colors.textSecondary },
  summaryVal: { fontSize: FontSize.lg, fontWeight: '700' },
  pills: { flexDirection: 'row', gap: Spacing.xs, marginBottom: Spacing.sm, flexWrap: 'wrap' },
  propScroll: { marginBottom: Spacing.sm },
  pill: {
    paddingHorizontal: Spacing.sm, paddingVertical: 6,
    borderRadius: Radius.xl, borderWidth: 1, borderColor: Colors.border,
    marginRight: Spacing.xs,
  },
  pillActive: { backgroundColor: Colors.primaryDim, borderColor: Colors.primary },
  pillText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  pillTextActive: { color: Colors.primary },
  txRow: { flexDirection: 'row', alignItems: 'center' },
  txInfo: { flex: 1, marginRight: Spacing.xs },
  txPayee: { color: Colors.text, fontSize: FontSize.sm, fontWeight: '500' },
  txMeta: { color: Colors.textDim, fontSize: FontSize.xs, marginTop: 2 },
  txAmt: { fontSize: FontSize.sm, fontWeight: '600' },
});

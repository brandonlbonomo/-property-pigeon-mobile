import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator, RefreshControl,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRoute } from '@react-navigation/native';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useDataStore } from '../../store/dataStore';
import { Card } from '../../components/Card';
import { SectionHeader } from '../../components/SectionHeader';
import { EmptyState } from '../../components/EmptyState';
import { fmt$ } from '../../utils/format';

export function MonthDetailScreen() {
  const route = useRoute<any>();
  const { month } = route.params;
  const { fetchCockpit, fetchProps } = useDataStore();
  const [cockpit, setCockpit] = useState<any>(null);
  const [props, setProps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    try {
      setError(null);
      const [c, pr] = await Promise.all([
        fetchCockpit(force),
        fetchProps(force),
      ]);
      setCockpit(c);
      setProps(pr || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [fetchCockpit, fetchProps]);

  useEffect(() => { load(); }, [month]);

  const onRefresh = () => { setRefreshing(true); load(true); };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.green} />
      </View>
    );
  }

  const isCurrentMonth = cockpit?.month === month;
  if (!isCurrentMonth) {
    return (
      <View style={styles.container}>
        <EmptyState message="No transaction details for this month" sub="Only current month summary is available" />
      </View>
    );
  }

  const kpis = cockpit?.kpis || {};
  const byProp = cockpit?.expenses_by_property || {};

  const propLabel = (pid: string) => {
    const p = (props || []).find((p: any) => (p.id || p.prop_id) === pid);
    return p?.label || pid.split('-')[0]?.toUpperCase() || pid;
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.green} />}
    >
      {error && (
        <View style={styles.errorBanner}>
          <Ionicons name="cloud-offline-outline" size={16} color={Colors.red} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
      <Card>
        <View style={styles.summaryRow}>
          <View style={styles.summaryCol}>
            <Text style={styles.summaryLabel}>Revenue</Text>
            <Text style={[styles.summaryVal, { color: Colors.green }]}>{fmt$(kpis.revenue_mtd ?? 0)}</Text>
          </View>
          <View style={styles.summaryCol}>
            <Text style={styles.summaryLabel}>Expenses</Text>
            <Text style={[styles.summaryVal, { color: Colors.red }]}>{fmt$(kpis.expenses_mtd ?? 0)}</Text>
          </View>
          <View style={styles.summaryCol}>
            <Text style={styles.summaryLabel}>Net</Text>
            <Text style={[styles.summaryVal, { color: (kpis.net_mtd ?? 0) >= 0 ? Colors.green : Colors.red }]}>
              {fmt$(kpis.net_mtd ?? 0)}
            </Text>
          </View>
        </View>
      </Card>

      {Object.keys(byProp).length > 0 && (
        <>
          <SectionHeader title="Expenses by Property" />
          {Object.entries(byProp)
            .sort(([, a]: any, [, b]: any) => b - a)
            .map(([pid, amount]: any) => (
              <Card key={pid} padding={Spacing.sm}>
                <View style={styles.propRow}>
                  <Text style={styles.propName}>{propLabel(pid)}</Text>
                  <Text style={[styles.propAmt, { color: Colors.red }]}>-{fmt$(amount)}</Text>
                </View>
              </Card>
            ))
          }
        </>
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
  propRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  propName: { color: Colors.text, fontSize: FontSize.sm, fontWeight: '500', flex: 1 },
  propAmt: { fontSize: FontSize.sm, fontWeight: '600' },
  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: 'rgba(239,68,68,0.08)', borderRadius: Radius.md,
    padding: Spacing.sm, marginBottom: Spacing.md, borderWidth: 0.5, borderColor: 'rgba(239,68,68,0.20)',
  },
  errorText: { fontSize: FontSize.xs, color: Colors.red, flex: 1, lineHeight: 16 },
});

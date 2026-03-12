import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
  TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useDataStore } from '../../store/dataStore';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { SectionHeader } from '../../components/SectionHeader';
import { fmt$, fmtPct, fmtDate } from '../../utils/format';

export function HomeScreen() {
  const { fetchCockpit, fetchIcalEvents } = useDataStore();
  const [cockpit, setCockpit] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (force = false) => {
    try {
      setError('');
      const [c, ev] = await Promise.all([
        fetchCockpit(force),
        fetchIcalEvents(force),
      ]);
      setCockpit(c);
      // Next 7 days check-ins
      const today = new Date();
      const next7 = new Date(today); next7.setDate(today.getDate() + 7);
      const checkins = (ev || []).filter((e: any) => {
        const ci = new Date(e.check_in + 'T00:00:00');
        return ci >= today && ci <= next7;
      }).sort((a: any, b: any) => a.check_in.localeCompare(b.check_in));
      setEvents(checkins);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [fetchCockpit, fetchIcalEvents]);

  useEffect(() => { load(); }, []);

  const onRefresh = () => { setRefreshing(true); load(true); };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  const kpis = cockpit?.kpis || {};
  const alerts = cockpit?.alerts || [];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
    >
      {error ? (
        <Card><Text style={styles.error}>{error}</Text></Card>
      ) : null}

      {/* Alert banner */}
      {alerts.length > 0 && (
        <Card style={styles.alertCard}>
          {alerts.map((a: any, i: number) => (
            <Text key={i} style={styles.alertText}>⚠ {a.message || a}</Text>
          ))}
        </Card>
      )}

      {/* KPI Grid */}
      <SectionHeader title="This Month" />
      <View style={styles.kpiGrid}>
        <KpiTile label="Revenue" value={fmt$(kpis.revenue_mtd ?? 0)} color={Colors.green} />
        <KpiTile label="Expenses" value={fmt$(kpis.expenses_mtd ?? 0)} color={Colors.red} />
        <KpiTile label="Net" value={fmt$(kpis.net_mtd ?? 0)} color={(kpis.net_mtd ?? 0) >= 0 ? Colors.green : Colors.red} />
        <KpiTile label="Occupancy" value={fmtPct((kpis.occupancy_mtd ?? 0) / 100)} color={Colors.primary} />
      </View>

      {/* YTD */}
      <SectionHeader title="Year to Date" />
      <View style={styles.kpiGrid}>
        <KpiTile label="Revenue" value={fmt$(kpis.revenue_ytd ?? 0)} color={Colors.green} />
        <KpiTile label="Expenses" value={fmt$(kpis.expenses_ytd ?? 0)} color={Colors.red} />
        <KpiTile label="Net" value={fmt$(kpis.net_ytd ?? 0)} color={(kpis.net_ytd ?? 0) >= 0 ? Colors.green : Colors.red} />
        <KpiTile label="ADR" value={fmt$(kpis.adr ?? 0)} color={Colors.yellow} />
      </View>

      {/* Upcoming check-ins */}
      <SectionHeader title="Next 7 Days" />
      {events.length === 0 ? (
        <EmptyState icon="📅" message="No check-ins in the next 7 days" />
      ) : (
        events.map((ev: any, i: number) => (
          <Card key={i} padding={Spacing.sm}>
            <View style={styles.eventRow}>
              <View style={styles.eventDate}>
                <Text style={styles.eventDateText}>{fmtDate(ev.check_in)}</Text>
              </View>
              <View style={styles.eventInfo}>
                <Text style={styles.eventProp}>{ev.summary || ev.prop_id || 'Property'}</Text>
                <Text style={styles.eventSub}>
                  {ev.nights} night{ev.nights !== 1 ? 's' : ''} · out {fmtDate(ev.check_out)}
                </Text>
              </View>
              <View style={[styles.statusDot, { backgroundColor: Colors.green }]} />
            </View>
          </Card>
        ))
      )}
    </ScrollView>
  );
}

function KpiTile({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={[styles.kpiTile, { borderColor: color + '40' }]}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={[styles.kpiValue, { color }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Spacing.md, paddingBottom: Spacing.xl },
  center: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },
  error: { color: Colors.red, fontSize: FontSize.sm },
  alertCard: { backgroundColor: Colors.yellowDim, borderColor: Colors.yellow + '40' },
  alertText: { color: Colors.yellow, fontSize: FontSize.sm },
  kpiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  kpiTile: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: Spacing.md,
  },
  kpiLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, marginBottom: 4 },
  kpiValue: { fontSize: FontSize.xl, fontWeight: '700' },
  eventRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  eventDate: {
    backgroundColor: Colors.primaryDim,
    borderRadius: Radius.sm,
    padding: Spacing.xs,
    minWidth: 52,
    alignItems: 'center',
  },
  eventDateText: { color: Colors.primary, fontSize: FontSize.xs, fontWeight: '600' },
  eventInfo: { flex: 1 },
  eventProp: { color: Colors.text, fontSize: FontSize.sm, fontWeight: '600' },
  eventSub: { color: Colors.textSecondary, fontSize: FontSize.xs },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
});

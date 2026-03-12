import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
  ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useDataStore } from '../../store/dataStore';
import { Card } from '../../components/Card';
import { SectionHeader } from '../../components/SectionHeader';
import { EmptyState } from '../../components/EmptyState';
import { fmtDate } from '../../utils/format';

export function CleaningsScreen() {
  const { fetchIcalEvents, fetchProps } = useDataStore();
  const [cleanings, setCleanings] = useState<any[]>([]);
  const [props, setProps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [propFilter, setPropFilter] = useState<string>('all');

  const load = useCallback(async (force = false) => {
    try {
      const [ev, pr] = await Promise.all([
        fetchIcalEvents(force),
        fetchProps(force),
      ]);
      setProps(pr || []);

      // Build cleaning events from consecutive bookings (check-out = next check-in = same day)
      const sorted = [...(ev || [])].sort((a: any, b: any) =>
        (a.check_out || '').localeCompare(b.check_out || '')
      );

      const cleaningDays: any[] = [];
      const seen = new Set<string>();

      sorted.forEach((e: any) => {
        const key = `${e.prop_id}-${e.check_out}`;
        if (!seen.has(key)) {
          seen.add(key);
          // Find if there's a check-in on same day (same-day turnover)
          const sameDayNext = sorted.find(
            (n: any) => n.prop_id === e.prop_id && n.check_in === e.check_out && n !== e
          );
          cleaningDays.push({
            date: e.check_out,
            prop_id: e.prop_id,
            outGuest: e.summary,
            inGuest: sameDayNext?.summary || null,
            sameDayTurnover: !!sameDayNext,
          });
        }
      });

      // Also include check-outs from today forward
      const today = new Date().toISOString().slice(0, 10);
      const upcoming = cleaningDays
        .filter(c => c.date >= today)
        .sort((a, b) => a.date.localeCompare(b.date));

      setCleanings(upcoming);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [fetchIcalEvents, fetchProps]);

  useEffect(() => { load(); }, []);
  const onRefresh = () => { setRefreshing(true); load(true); };

  const filtered = cleanings.filter(c =>
    propFilter === 'all' || c.prop_id === propFilter
  );

  const propLabel = (pid: string) => {
    const p = props.find((p: any) => (p.id || p.prop_id) === pid);
    return p?.label || pid || 'Property';
  };

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
      {/* Property filter */}
      {props.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.propScroll}>
          <TouchableOpacity
            style={[styles.pill, propFilter === 'all' && styles.pillActive]}
            onPress={() => setPropFilter('all')}
          >
            <Text style={[styles.pillText, propFilter === 'all' && styles.pillTextActive]}>All</Text>
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

      <SectionHeader title={`Upcoming Cleanings (${filtered.length})`} />

      {filtered.length === 0 ? (
        <EmptyState icon="🧹" message="No upcoming cleanings" sub="Connect iCal feeds on the web app to see cleaning schedule" />
      ) : (
        filtered.map((c, i) => (
          <Card key={i} padding={Spacing.sm}>
            <View style={styles.cleaningRow}>
              <View style={styles.dateBox}>
                <Text style={styles.dateMonth}>
                  {new Date(c.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short' })}
                </Text>
                <Text style={styles.dateDay}>
                  {new Date(c.date + 'T00:00:00').getDate()}
                </Text>
              </View>
              <View style={styles.cleaningInfo}>
                <View style={styles.cleaningNameRow}>
                  <Text style={styles.propName}>{propLabel(c.prop_id)}</Text>
                  {c.sameDayTurnover && (
                    <View style={styles.turnoverBadge}>
                      <Text style={styles.turnoverText}>⚡ Same-Day</Text>
                    </View>
                  )}
                </View>
                {c.outGuest && (
                  <Text style={styles.guestLine}>
                    <Text style={styles.guestLabel}>Out: </Text>
                    {c.outGuest}
                  </Text>
                )}
                {c.inGuest && (
                  <Text style={styles.guestLine}>
                    <Text style={styles.guestLabel}>In: </Text>
                    {c.inGuest}
                  </Text>
                )}
              </View>
            </View>
          </Card>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Spacing.md, paddingBottom: Spacing.xl },
  center: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },
  propScroll: { marginBottom: Spacing.md },
  pill: {
    paddingHorizontal: Spacing.sm, paddingVertical: 6,
    borderRadius: Radius.xl, borderWidth: 1, borderColor: Colors.border,
    marginRight: Spacing.xs,
  },
  pillActive: { backgroundColor: Colors.primaryDim, borderColor: Colors.primary },
  pillText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  pillTextActive: { color: Colors.primary },
  cleaningRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
  dateBox: {
    width: 44, backgroundColor: Colors.primaryDim, borderRadius: Radius.sm,
    alignItems: 'center', paddingVertical: Spacing.xs,
  },
  dateMonth: { fontSize: 10, color: Colors.primary, textTransform: 'uppercase' },
  dateDay: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.primary },
  cleaningInfo: { flex: 1 },
  cleaningNameRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, flexWrap: 'wrap' },
  propName: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  turnoverBadge: { backgroundColor: Colors.yellowDim, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  turnoverText: { fontSize: 10, color: Colors.yellow, fontWeight: '600' },
  guestLine: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  guestLabel: { color: Colors.textDim },
});

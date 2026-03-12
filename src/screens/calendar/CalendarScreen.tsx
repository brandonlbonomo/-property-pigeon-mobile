import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
  TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useDataStore } from '../../store/dataStore';
import { Card } from '../../components/Card';
import { SectionHeader } from '../../components/SectionHeader';
import { EmptyState } from '../../components/EmptyState';
import { fmtDate, fmtMonthYear } from '../../utils/format';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Su','Mo','Tu','We','Th','Fr','Sa'];

export function CalendarScreen() {
  const { fetchIcalEvents, fetchPlBookings, fetchProps } = useDataStore();
  const [events, setEvents] = useState<any[]>([]);
  const [props, setProps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [propFilter, setPropFilter] = useState<string>('all');

  const load = useCallback(async (force = false) => {
    try {
      const [ev, bk, pr] = await Promise.all([
        fetchIcalEvents(force),
        fetchPlBookings(force),
        fetchProps(force),
      ]);
      // Merge ical events + pl_bookings
      const merged = [
        ...(ev || []).map((e: any) => ({ ...e, _src: 'ical' })),
        ...(bk || []).map((b: any) => ({
          check_in: b.check_in,
          check_out: b.check_out,
          summary: b.listing_name,
          prop_id: b.prop_id,
          nights: b.nights,
          _src: 'pl',
          status: b.status,
        })),
      ];
      setEvents(merged);
      setProps(pr || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [fetchIcalEvents, fetchPlBookings, fetchProps]);

  useEffect(() => { load(); }, []);
  const onRefresh = () => { setRefreshing(true); load(true); };

  // Build calendar days for current view month
  const { year, month } = viewMonth;
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Which days have check-ins?
  const checkinDays = new Set<number>();
  const checkoutDays = new Set<number>();
  const filteredEvents = events.filter(e =>
    propFilter === 'all' || e.prop_id === propFilter
  );

  filteredEvents.forEach((e: any) => {
    const ci = new Date(e.check_in + 'T00:00:00');
    const co = new Date(e.check_out + 'T00:00:00');
    if (ci.getFullYear() === year && ci.getMonth() === month) {
      checkinDays.add(ci.getDate());
    }
    if (co.getFullYear() === year && co.getMonth() === month) {
      checkoutDays.add(co.getDate());
    }
  });

  // Upcoming events in this month
  const monthStr = `${year}-${String(month + 1).padStart(2, '0')}`;
  const monthEvents = filteredEvents
    .filter((e: any) => (e.check_in || '').startsWith(monthStr))
    .sort((a: any, b: any) => (a.check_in || '').localeCompare(b.check_in || ''));

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  const calendarDays: (number | null)[] = Array(firstDay).fill(null);
  for (let d = 1; d <= daysInMonth; d++) calendarDays.push(d);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
    >
      {/* Month nav */}
      <View style={styles.monthNav}>
        <TouchableOpacity
          onPress={() => setViewMonth(v => {
            const d = new Date(v.year, v.month - 1, 1);
            return { year: d.getFullYear(), month: d.getMonth() };
          })}
          style={styles.navBtn}
        >
          <Text style={styles.navBtnText}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.monthTitle}>{MONTHS[month]} {year}</Text>
        <TouchableOpacity
          onPress={() => setViewMonth(v => {
            const d = new Date(v.year, v.month + 1, 1);
            return { year: d.getFullYear(), month: d.getMonth() };
          })}
          style={styles.navBtn}
        >
          <Text style={styles.navBtnText}>›</Text>
        </TouchableOpacity>
      </View>

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

      {/* Calendar grid */}
      <Card>
        {/* Day headers */}
        <View style={styles.dayHeaders}>
          {DAYS.map(d => (
            <Text key={d} style={styles.dayHeader}>{d}</Text>
          ))}
        </View>
        {/* Day cells */}
        <View style={styles.calGrid}>
          {calendarDays.map((day, i) => {
            if (!day) return <View key={i} style={styles.dayCell} />;
            const isCheckin = checkinDays.has(day);
            const isCheckout = checkoutDays.has(day);
            const today = new Date();
            const isToday = today.getDate() === day && today.getMonth() === month && today.getFullYear() === year;
            return (
              <View
                key={i}
                style={[
                  styles.dayCell,
                  isToday && styles.dayCellToday,
                  isCheckin && styles.dayCellCheckin,
                  isCheckout && !isCheckin && styles.dayCellCheckout,
                ]}
              >
                <Text style={[
                  styles.dayText,
                  isToday && styles.dayTextToday,
                  (isCheckin || isCheckout) && styles.dayTextHighlight,
                ]}>
                  {day}
                </Text>
                {isCheckin && <View style={styles.dot} />}
              </View>
            );
          })}
        </View>

        {/* Legend */}
        <View style={styles.legend}>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: Colors.green }]} />
            <Text style={styles.legendText}>Check-in</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: Colors.primary + '80' }]} />
            <Text style={styles.legendText}>Check-out</Text>
          </View>
        </View>
      </Card>

      {/* Events list */}
      <SectionHeader title={`${MONTHS[month]} Events (${monthEvents.length})`} />
      {monthEvents.length === 0 ? (
        <EmptyState icon="📅" message="No bookings this month" />
      ) : (
        monthEvents.map((e: any, i: number) => (
          <Card key={i} padding={Spacing.sm}>
            <View style={styles.eventRow}>
              <View style={[styles.srcBadge, e._src === 'pl' ? styles.srcPl : styles.srcIcal]}>
                <Text style={styles.srcText}>{e._src === 'pl' ? 'PL' : 'iCal'}</Text>
              </View>
              <View style={styles.eventInfo}>
                <Text style={styles.eventName}>{e.summary || e.listing_name || 'Booking'}</Text>
                <Text style={styles.eventDates}>
                  {fmtDate(e.check_in)} → {fmtDate(e.check_out)}
                  {e.nights ? ` · ${e.nights}n` : ''}
                </Text>
              </View>
              {e.status && (
                <View style={[styles.statusPill, e.status === 'cancelled' && styles.statusCancelled]}>
                  <Text style={styles.statusText}>{e.status}</Text>
                </View>
              )}
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
  monthNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.md },
  navBtn: { padding: Spacing.md },
  navBtnText: { color: Colors.primary, fontSize: 24 },
  monthTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, minWidth: 120, textAlign: 'center' },
  propScroll: { marginBottom: Spacing.md },
  pill: {
    paddingHorizontal: Spacing.sm, paddingVertical: 6,
    borderRadius: Radius.xl, borderWidth: 1, borderColor: Colors.border,
    marginRight: Spacing.xs,
  },
  pillActive: { backgroundColor: Colors.primaryDim, borderColor: Colors.primary },
  pillText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  pillTextActive: { color: Colors.primary },
  dayHeaders: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: Spacing.xs },
  dayHeader: { fontSize: FontSize.xs, color: Colors.textDim, width: 32, textAlign: 'center' },
  calGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  dayCell: { width: `${100 / 7}%`, aspectRatio: 1, alignItems: 'center', justifyContent: 'center' },
  dayCellToday: { backgroundColor: Colors.primaryDim, borderRadius: Radius.sm },
  dayCellCheckin: { backgroundColor: Colors.greenDim, borderRadius: Radius.sm },
  dayCellCheckout: { backgroundColor: Colors.primaryDim + '60', borderRadius: Radius.sm },
  dayText: { fontSize: FontSize.sm, color: Colors.text },
  dayTextToday: { color: Colors.primary, fontWeight: '700' },
  dayTextHighlight: { color: Colors.green, fontWeight: '600' },
  dot: { width: 4, height: 4, borderRadius: 2, backgroundColor: Colors.green, marginTop: 1 },
  legend: { flexDirection: 'row', gap: Spacing.md, marginTop: Spacing.sm, justifyContent: 'center' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  eventRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  srcBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  srcPl: { backgroundColor: Colors.yellowDim },
  srcIcal: { backgroundColor: Colors.primaryDim },
  srcText: { fontSize: 10, fontWeight: '700', color: Colors.textSecondary },
  eventInfo: { flex: 1 },
  eventName: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '500' },
  eventDates: { fontSize: FontSize.xs, color: Colors.textSecondary },
  statusPill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: Colors.greenDim },
  statusCancelled: { backgroundColor: Colors.redDim },
  statusText: { fontSize: 10, color: Colors.textSecondary },
});

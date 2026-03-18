import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
  TouchableOpacity, ActivityIndicator, Platform, Animated,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { GradientHeader } from '../../components/GradientHeader';
import { useDataStore } from '../../store/dataStore';
import { useUserStore } from '../../store/userStore';
import { apiFetch } from '../../services/api';
import { Card } from '../../components/Card';
import { SectionHeader } from '../../components/SectionHeader';
import { EmptyState } from '../../components/EmptyState';
import { GlossyHorizontalBar } from '../../components/GlossyHorizontalBar';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function getMonthGrid(year: number, month: number) {
  const firstDay = new Date(year, month, 1);
  const startDow = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const weeks: (number | null)[][] = [];
  let week: (number | null)[] = [];
  for (let i = 0; i < startDow; i++) week.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    week.push(d);
    if (week.length === 7) { weeks.push(week); week = []; }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }
  return weeks;
}

export function CalendarScreen() {
  const { fetchIcalEvents, fetchIcalFeeds, fetchProps, fetchAnalytics } = useDataStore();
  const lastError = useDataStore(s => s.lastError);
  const hasPriceLabs = !!useUserStore(s => s.profile?.priceLabsApiKey);
  const [events, setEvents] = useState<any[]>([]);
  const [props, setProps] = useState<any[]>([]);
  const [analytics, setAnalytics] = useState<any>(null);
  const [plStats, setPlStats] = useState<any>(null);
  const [feedMap, setFeedMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [propFilter, setPropFilter] = useState<string>('all');
  const [calSelectedDay, setCalSelectedDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [calGridLayout, setCalGridLayout] = useState({ width: 0, height: 0 });
  const calGlassX = useRef(new Animated.Value(0)).current;
  const calGlassY = useRef(new Animated.Value(0)).current;
  const calSelectedRef = useRef(new Date().toISOString().slice(0, 10));

  const load = useCallback(async (force = false) => {
    try {
      const [ev, pr, an, feeds] = await Promise.all([
        fetchIcalEvents(force),
        fetchProps(force),
        fetchAnalytics(force),
        fetchIcalFeeds(force),
      ]);
      setEvents(ev || []);
      setProps(pr || []);
      setAnalytics(an);
      // Build feed_key → listingName map for unit-level labels
      const map: Record<string, string> = {};
      (feeds || []).forEach((f: any) => {
        if (f.feed_key && f.listingName) map[f.feed_key] = f.listingName;
      });
      setFeedMap(map);
      // Fetch PriceLabs stats for market occupancy comparison
      if (hasPriceLabs) {
        try {
          const stats = await apiFetch('/api/pricelabs/stats');
          setPlStats(stats);
        } catch {}
      }
    } catch (e) {
      // fetch failed
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [fetchIcalEvents, fetchIcalFeeds, fetchProps, fetchAnalytics, hasPriceLabs]);

  useEffect(() => { load(); }, []);
  const onRefresh = () => { setRefreshing(true); load(true); };

  const today = new Date();
  const todayDateStr = today.toISOString().slice(0, 10);

  // PriceLabs-only occupancy (STR/both users with a PriceLabs API key)
  const plOccupancy = useMemo(() => {
    if (!hasPriceLabs || !plStats?.by_prop) return [];
    const byProp = plStats.by_prop;
    return props
      .filter(p => byProp[p.id || p.prop_id]?.avg_occ_past_30 != null)
      .map(p => {
        const pid = p.id || p.prop_id;
        return { id: pid, label: p.label || pid, occupancy: byProp[pid].avg_occ_past_30 as number };
      });
  }, [props, hasPriceLabs, plStats]);

  // Derive upcoming cleanings from check-out events (per-unit via feed_key)
  const cleanings = useMemo(() => {
    const sorted = [...events].sort((a: any, b: any) =>
      (a.check_out || '').localeCompare(b.check_out || '')
    );
    const cleaningDays: any[] = [];
    const seen = new Set<string>();
    sorted.forEach((e: any) => {
      if (!e.check_out || !e.prop_id) return;
      const unitKey = e.feed_key || '';
      const key = `${e.prop_id}-${unitKey}-${e.check_out}`;
      if (!seen.has(key)) {
        seen.add(key);
        const sameDayNext = sorted.find(
          (n: any) => n.prop_id === e.prop_id && (n.feed_key || '') === unitKey && n.check_in === e.check_out && n !== e
        );
        cleaningDays.push({
          date: e.check_out,
          prop_id: e.prop_id,
          feed_key: unitKey,
          outGuest: e.summary,
          inGuest: sameDayNext?.summary || null,
          sameDayTurnover: !!sameDayNext,
        });
      }
    });
    const todayStr = new Date().toISOString().slice(0, 10);
    return cleaningDays.filter(c => c.date >= todayStr).sort((a, b) => a.date.localeCompare(b.date));
  }, [events]);

  const filteredCleanings = cleanings.filter(c => propFilter === 'all' || c.prop_id === propFilter);
  const todayStr = today.toISOString().slice(0, 10);

  const { year, month } = viewMonth;

  const filteredEvents = events.filter(e =>
    propFilter === 'all' || e.prop_id === propFilter
  );

  const calGrid = useMemo(() => getMonthGrid(year, month), [year, month]);

  const checkinDays = useMemo(() => {
    const days = new Set<string>();
    filteredEvents.forEach((e: any) => {
      const d = (e.check_in || '').slice(0, 10);
      if (d) days.add(d);
    });
    return days;
  }, [filteredEvents]);

  const checkoutDays = useMemo(() => {
    const days = new Set<string>();
    filteredEvents.forEach((e: any) => {
      const d = (e.check_out || '').slice(0, 10);
      if (d) days.add(d);
    });
    return days;
  }, [filteredEvents]);

  const monthStr = `${year}-${String(month + 1).padStart(2, '0')}`;
  const monthEvents = filteredEvents
    .filter((e: any) => (e.check_in || '').startsWith(monthStr))
    .sort((a: any, b: any) => (a.check_in || '').localeCompare(b.check_in || ''));

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.green} />
      </View>
    );
  }

  const numWeeks = calGrid.length;
  const calCellW = calGridLayout.width > 0 ? (calGridLayout.width - 2 * Spacing.sm) / 7 : 0;
  const calCellH = calGridLayout.height > 0 ? calGridLayout.height / numWeeks : 0;

  // Position glass on month change or initial layout
  useEffect(() => {
    const now = new Date();
    const isCurrentMonth = now.getMonth() === month && now.getFullYear() === year;
    const day = isCurrentMonth ? now.getDate() : 1;
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    setCalSelectedDay(dateStr);
    calSelectedRef.current = dateStr;
    if (calCellW <= 0 || calCellH <= 0) return;
    const firstDow = new Date(year, month, 1).getDay();
    const col = (firstDow + day - 1) % 7;
    const row = Math.floor((firstDow + day - 1) / 7);
    calGlassX.setValue(Spacing.sm + col * calCellW + (calCellW - 40) / 2);
    calGlassY.setValue(row * calCellH + (calCellH - 40) / 2);
  }, [year, month, calCellW, calCellH]);

  const handleCalDayPress = useCallback((dateStr: string, row: number, col: number) => {
    if (calCellW <= 0 || calCellH <= 0 || calSelectedRef.current === dateStr) return;
    calSelectedRef.current = dateStr;
    setCalSelectedDay(dateStr);
    Animated.parallel([
      Animated.spring(calGlassX, { toValue: Spacing.sm + col * calCellW + (calCellW - 40) / 2, useNativeDriver: true, tension: 60, friction: 9 }),
      Animated.spring(calGlassY, { toValue: row * calCellH + (calCellH - 40) / 2, useNativeDriver: true, tension: 60, friction: 9 }),
    ]).start();
  }, [calCellW, calCellH]);

  const selectedDayEvents = useMemo(() => {
    return filteredEvents.filter((e: any) =>
      (e.check_in || '').slice(0, 10) === calSelectedDay ||
      (e.check_out || '').slice(0, 10) === calSelectedDay
    );
  }, [calSelectedDay, filteredEvents]);

  // Deduplicated activities for selected day: property + unit + type
  const selectedDayActivities = useMemo(() => {
    const unitGroups = new Map<string, { hasCheckin: boolean; hasCheckout: boolean; unitLabel: string }>();
    selectedDayEvents.forEach((e: any) => {
      const unitKey = `${e.prop_id}-${e.feed_key || ''}`;
      const unitLabel = (e.feed_key && feedMap[e.feed_key]) || props.find((p: any) => (p.id || p.prop_id) === e.prop_id)?.label || '';
      if (!unitGroups.has(unitKey)) {
        unitGroups.set(unitKey, { hasCheckin: false, hasCheckout: false, unitLabel });
      }
      const g = unitGroups.get(unitKey)!;
      if ((e.check_in || '').slice(0, 10) === calSelectedDay) g.hasCheckin = true;
      if ((e.check_out || '').slice(0, 10) === calSelectedDay) g.hasCheckout = true;
    });
    const activities: { unitLabel: string; type: string; color: string }[] = [];
    unitGroups.forEach((g) => {
      if (g.hasCheckout && g.hasCheckin) {
        activities.push({ unitLabel: g.unitLabel, type: 'Turnover', color: Colors.yellow });
      } else {
        if (g.hasCheckout) activities.push({ unitLabel: g.unitLabel, type: 'Cleaning', color: Colors.yellow });
        if (g.hasCheckin) activities.push({ unitLabel: g.unitLabel, type: 'Check-in', color: Colors.green });
      }
    });
    return activities;
  }, [calSelectedDay, selectedDayEvents, feedMap, props]);


  return (
    <View style={{ flex: 1 }}>
    <GradientHeader />
    <ScrollView
      style={[styles.container, { backgroundColor: 'transparent' }]}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={"#FFFFFF"} colors={["#FFFFFF"]} />}
    >
      {/* Error banner */}
      {lastError && (
        <View style={styles.errorBanner}>
          <Ionicons name="cloud-offline-outline" size={16} color={Colors.red} />
          <Text style={styles.errorText}>{lastError}</Text>
        </View>
      )}

      {/* PriceLabs Occupancy — only shown when PriceLabs API key is connected */}
      {plOccupancy.length > 0 && (
        <View style={styles.occCompactRow}>
          {plOccupancy.map(p => (
            <View key={p.id} style={styles.occCompactItem}>
              <Text style={styles.occCompactLabel} numberOfLines={1}>{p.label}</Text>
              <Text style={styles.occCompactPct}>{p.occupancy.toFixed(0)}%</Text>
              <Text style={styles.occP30Label}>P30 · PriceLabs</Text>
            </View>
          ))}
        </View>
      )}

      {/* Month Nav */}
      <View style={styles.calHeader}>
        <TouchableOpacity activeOpacity={0.7}
          onPress={() => setViewMonth(v => {
            const d = new Date(v.year, v.month - 1, 1);
            return { year: d.getFullYear(), month: d.getMonth() };
          })}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
        <Text style={styles.calTitle}>{MONTHS[month]} {year}</Text>
        <TouchableOpacity activeOpacity={0.7}
          onPress={() => setViewMonth(v => {
            const d = new Date(v.year, v.month + 1, 1);
            return { year: d.getFullYear(), month: d.getMonth() };
          })}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="chevron-forward" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* Weekday headers */}
      <View style={styles.calWeekRow}>
        {WEEKDAYS.map(d => (
          <Text key={d} style={styles.calWeekDay}>{d}</Text>
        ))}
      </View>

      {/* Property filter */}
      {props.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.propScroll}>
          <TouchableOpacity activeOpacity={0.7}
          style={[styles.pill, propFilter === 'all' && styles.pillActive]}
            onPress={() => setPropFilter('all')}
          >
            <Text style={[styles.pillText, propFilter === 'all' && styles.pillTextActive]}>All</Text>
          </TouchableOpacity>
          {props.map((p: any) => (
            <TouchableOpacity activeOpacity={0.7}
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

      {/* Calendar grid — week-row layout with liquid glass */}
      <View
        style={styles.calGridWrap}
        onLayout={e => setCalGridLayout({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
      >
        {/* Sliding glass indicator */}
        {calCellW > 0 && (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.calSlidingGlass,
              { transform: [{ translateX: calGlassX }, { translateY: calGlassY }] },
            ]}
          />
        )}
        {calGrid.map((week, wi) => (
          <View key={wi} style={styles.calWeekRow}>
            {week.map((day, di) => {
              if (day === null) return <View key={di} style={styles.calDayCell} />;
              const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
              const isCheckin = checkinDays.has(dateStr);
              const isCheckout = checkoutDays.has(dateStr);
              const isToday = dateStr === todayStr;
              const isSelected = dateStr === calSelectedDay;
              return (
                <TouchableOpacity
                  activeOpacity={0.7}
                  key={di}
                  style={styles.calDayCell}
                  onPress={() => handleCalDayPress(dateStr, wi, di)}
                >
                  <View style={[
                    styles.calDayBubble,
                    !isSelected && isToday && styles.calDayBubbleToday,
                    !isSelected && isCheckout && styles.calDayBubbleCleaning,
                    !isSelected && isCheckin && !isCheckout && styles.calDayBubbleCheckin,
                  ]}>
                    <Text style={[
                      styles.calDayText,
                      isToday && styles.calDayTextToday,
                      isCheckout && styles.calDayTextCleaning,
                      isCheckin && !isCheckout && styles.calDayTextCheckin,
                      isSelected && styles.calDayTextSelected,
                    ]}>
                      {day}
                    </Text>
                    {isToday && !isCheckin && !isCheckout && <View style={styles.calDotToday} />}
                    {isCheckout && <View style={styles.calDotCleaning} />}
                    {isCheckin && !isCheckout && <View style={styles.calDotCheckin} />}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </View>

      {/* Legend */}
      <View style={styles.calLegend}>
        <View style={styles.calLegendItem}>
          <View style={[styles.calLegendSwatch, { backgroundColor: 'rgba(245,158,11,0.15)', borderColor: 'rgba(245,158,11,0.30)' }]} />
          <Text style={styles.calLegendText}>Cleaning</Text>
        </View>
        <View style={styles.calLegendItem}>
          <View style={[styles.calLegendSwatch, { backgroundColor: 'rgba(16,185,129,0.15)', borderColor: 'rgba(16,185,129,0.30)' }]} />
          <Text style={styles.calLegendText}>Check-in</Text>
        </View>
        <View style={styles.calLegendItem}>
          <View style={[styles.calLegendSwatch, { backgroundColor: 'rgba(59,130,246,0.15)', borderColor: 'rgba(59,130,246,0.30)' }]} />
          <Text style={styles.calLegendText}>Today</Text>
        </View>
      </View>

      {/* Selected day detail */}
      <View style={styles.calDetail}>
        <Text style={styles.calDetailTitle}>
          {new Date(calSelectedDay + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
        </Text>
        {selectedDayActivities.length === 0 ? (
          <Text style={styles.calDetailEmpty}>No events on this day</Text>
        ) : (
          selectedDayActivities.map((a, idx) => (
            <View key={idx} style={styles.selectedDayEvent}>
              <View style={[styles.selectedDayDot, { backgroundColor: a.color }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.selectedDayName}>{a.unitLabel}</Text>
                <Text style={styles.selectedDaySub}>{a.type}</Text>
              </View>
            </View>
          ))
        )}
      </View>

      {/* Month Events */}
      <SectionHeader title={`Check-ins (${monthEvents.length})`} />
      {monthEvents.length === 0 ? (
        <EmptyState message="No check-ins this month" />
      ) : (
        monthEvents.map((e: any, i: number) => {
          const unitName = (e.feed_key && feedMap[e.feed_key]) || props.find((p: any) => (p.id || p.prop_id) === e.prop_id)?.label || '';
          return (
            <Card key={i} padding={Spacing.sm}>
              <View style={styles.eventRow}>
                <View style={styles.eventDateBox}>
                  <Text style={styles.eventDateMonth}>
                    {new Date(e.check_in + 'T00:00:00').toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}
                  </Text>
                  <Text style={styles.eventDateDay}>
                    {new Date(e.check_in + 'T00:00:00').getDate()}
                  </Text>
                </View>
                <View style={styles.eventInfo}>
                  <Text style={styles.eventName}>{unitName}</Text>
                  <Text style={styles.eventDates}>Check-in</Text>
                </View>
              </View>
            </Card>
          );
        })
      )}

      {/* Cleanings & Turnovers */}
      <SectionHeader title={`Cleanings (${filteredCleanings.length})`} />
      {filteredCleanings.length === 0 ? (
        <EmptyState message="No upcoming cleanings" />
      ) : (
        filteredCleanings.slice(0, 10).map((c: any, i: number) => {
          const dateObj = new Date(c.date + 'T00:00:00');
          const isCleanToday = c.date === todayStr;
          const unitName = (c.feed_key && feedMap[c.feed_key]) || props.find((p: any) => (p.id || p.prop_id) === c.prop_id)?.label || '';
          const eventType = c.sameDayTurnover ? 'Turnover' : 'Cleaning';
          return (
            <Card key={`cl-${i}`} padding={Spacing.sm}>
              <View style={styles.cleaningCard}>
                <View style={styles.cleaningDateCol}>
                  <Text style={styles.cleaningMonth}>
                    {dateObj.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}
                  </Text>
                  <Text style={styles.cleaningDay}>{dateObj.getDate()}</Text>
                </View>
                <View style={styles.cleaningInfo}>
                  <Text style={styles.cleaningProp}>{unitName}</Text>
                  <View style={[styles.statusBadge, c.sameDayTurnover ? styles.statusUrgent : (isCleanToday ? styles.statusUrgent : styles.statusNeeded)]}>
                    <Ionicons
                      name={c.sameDayTurnover ? 'swap-horizontal' : (isCleanToday ? 'alert-circle' : 'time')}
                      size={12}
                      color={c.sameDayTurnover ? Colors.yellow : (isCleanToday ? Colors.red : Colors.yellow)}
                    />
                    <Text style={[styles.statusText, { color: c.sameDayTurnover ? Colors.yellow : (isCleanToday ? Colors.red : Colors.yellow) }]}>
                      {eventType}{isCleanToday && !c.sameDayTurnover ? ' · TODAY' : ''}
                    </Text>
                  </View>
                </View>
              </View>
            </Card>
          );
        })
      )}

      <View style={{ height: 40 }} />
    </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Spacing.md, paddingBottom: Spacing.xl },
  center: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },

  pageTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginBottom: Spacing.md },
  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: 'rgba(239,68,68,0.08)', borderRadius: Radius.md,
    padding: Spacing.sm, marginBottom: Spacing.md, borderWidth: 0.5, borderColor: 'rgba(239,68,68,0.20)',
  },
  errorText: { fontSize: FontSize.xs, color: Colors.red, flex: 1, lineHeight: 16 },

  // Occupancy cards
  occCompactRow: {
    flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.sm,
  },
  occCompactItem: {
    flex: 1, backgroundColor: Colors.glassHeavy, borderRadius: Radius.md, padding: Spacing.sm,
    alignItems: 'center', borderWidth: 0.5, borderColor: Colors.glassBorder,
  },
  occCompactLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '500', marginBottom: 2 },
  occCompactPct: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  occP30Label: { fontSize: 9, fontWeight: '600', color: Colors.textDim, marginTop: 2, letterSpacing: 0.3 },
  occCompactDelta: { fontSize: FontSize.xs, fontWeight: '600', marginTop: 1 },
  occRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.sm },
  occCard: { flex: 1 },
  occLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '500' },
  occPct: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, marginVertical: 4 },
  occBarTrack: { height: 6, backgroundColor: Colors.border, borderRadius: 3, overflow: 'hidden', marginBottom: 6 },
  occBarFill: { height: '100%', borderRadius: 3 },
  occCompare: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  occMarketLabel: { fontSize: FontSize.xs, color: Colors.textDim },
  occDelta: { fontSize: FontSize.xs, fontWeight: '600' },

  // Per-property occupancy
  propOccRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  propOccInfo: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  propOccName: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  propOccPct: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text },
  airbnbBadge: { backgroundColor: Colors.greenDim, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  airbnbText: { fontSize: 9, fontWeight: '600', color: Colors.primary },
  propOccBarTrack: { height: 8, backgroundColor: Colors.border, borderRadius: 4, overflow: 'hidden', position: 'relative', marginBottom: 4 },
  propOccBarFill: { height: '100%', backgroundColor: Colors.green, borderRadius: 4 },
  propOccMarker: { position: 'absolute', top: -2, width: 2, height: 12, backgroundColor: Colors.textDim },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border, marginVertical: Spacing.sm },
  occLegend: { flexDirection: 'row', gap: Spacing.lg, marginTop: Spacing.md, paddingTop: Spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderColor: Colors.border },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendLine: { width: 12, height: 2, backgroundColor: Colors.textDim },
  legendText: { fontSize: FontSize.xs, color: Colors.textSecondary },

  // Property pills
  propScroll: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },
  pill: {
    paddingHorizontal: Spacing.sm, paddingVertical: 4,
    borderRadius: Radius.pill, borderWidth: 0.5, borderColor: Colors.glassBorder,
    backgroundColor: Colors.glassDark, marginRight: Spacing.xs, overflow: 'hidden',
  },
  pillActive: {
    backgroundColor: Colors.glass,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.45, shadowRadius: 8 },
    }),
  },
  pillText: { fontSize: FontSize.xs, color: Colors.textDim, fontWeight: '500' },
  pillTextActive: { color: Colors.text, fontWeight: '600' },

  // Calendar — matching cleaner liquid glass style
  calHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingTop: Spacing.md, paddingBottom: Spacing.sm,
  },
  calTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  calWeekRow: { flexDirection: 'row', paddingHorizontal: Spacing.sm },
  calWeekDay: {
    flex: 1, textAlign: 'center', fontSize: FontSize.xs,
    color: Colors.textDim, fontWeight: '600', paddingVertical: 4,
  },
  calGridWrap: { position: 'relative' as const },
  calDayCell: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 3, minHeight: 44,
  },
  calDayBubble: {
    width: 38, height: 38, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  calDayBubbleToday: {
    borderWidth: 2.5, borderColor: Colors.primary,
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.4, shadowRadius: 6 },
    }),
  },
  calDayBubbleCheckin: {
    backgroundColor: 'rgba(16,185,129,0.15)',
    borderWidth: 1.5, borderColor: 'rgba(16,185,129,0.25)',
    ...Platform.select({
      ios: { shadowColor: 'rgba(16,185,129,0.35)', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 1, shadowRadius: 8 },
    }),
  },
  calDayBubbleCleaning: {
    backgroundColor: 'rgba(245,158,11,0.15)',
    borderWidth: 1.5, borderColor: 'rgba(245,158,11,0.25)',
    ...Platform.select({
      ios: { shadowColor: 'rgba(245,158,11,0.35)', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 1, shadowRadius: 8 },
    }),
  },
  calSlidingGlass: {
    position: 'absolute' as const,
    width: 40, height: 40, borderRadius: 16,
    backgroundColor: Colors.glass,
    borderWidth: 2.5, borderColor: Colors.glassBorder,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.8, shadowRadius: 16 },
    }),
  },
  calDayText: { fontSize: FontSize.md, fontWeight: '500', color: Colors.text },
  calDayTextToday: { color: Colors.primary, fontWeight: '800' },
  calDayTextCheckin: { color: Colors.green, fontWeight: '600' },
  calDayTextCleaning: { color: Colors.yellow, fontWeight: '600' },
  calDayTextSelected: { fontWeight: '800' as const },
  calDotToday: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: Colors.green, marginTop: 2 },
  calDotCheckin: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: Colors.green, marginTop: 2 },
  calDotCleaning: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: Colors.yellow, marginTop: 2 },
  calLegend: {
    flexDirection: 'row', justifyContent: 'center', gap: Spacing.lg,
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md,
  },
  calLegendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  calLegendSwatch: {
    width: 14, height: 14, borderRadius: 6, borderWidth: 1.5,
  },
  calLegendText: { fontSize: FontSize.xs, color: Colors.textDim },
  calDetail: { padding: Spacing.md },
  calDetailTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginBottom: Spacing.sm },
  calDetailEmpty: { fontSize: FontSize.sm, color: Colors.textDim, textAlign: 'center', paddingVertical: Spacing.lg },
  selectedDayEvent: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingVertical: 6 },
  selectedDayDot: { width: 6, height: 6, borderRadius: 3 },
  selectedDayName: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  selectedDaySub: { fontSize: FontSize.xs, color: Colors.textSecondary },

  // Events
  eventRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  eventDateBox: {
    width: 44, backgroundColor: Colors.greenDim, borderRadius: Radius.sm,
    alignItems: 'center', paddingVertical: Spacing.xs,
  },
  eventDateMonth: { fontSize: 9, color: Colors.green, fontWeight: '600' },
  eventDateDay: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.green },
  eventInfo: { flex: 1 },
  eventName: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '500' },
  eventDates: { fontSize: FontSize.xs, color: Colors.textSecondary },

  // Cleaning cards
  cleaningCard: { flexDirection: 'row', gap: Spacing.sm },
  cleaningDateCol: {
    width: 48, backgroundColor: Colors.greenDim, borderRadius: Radius.sm,
    alignItems: 'center', paddingVertical: Spacing.xs,
  },
  cleaningMonth: { fontSize: 9, color: Colors.primary, fontWeight: '600' },
  cleaningDay: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.primary },
  cleaningInfo: { flex: 1 },
  cleaningProp: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text, marginBottom: 4 },
  statusBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4,
    alignSelf: 'flex-start', marginBottom: 4,
  },
  statusUrgent: { backgroundColor: Colors.redDim },
  statusNeeded: { backgroundColor: Colors.yellowDim },
  statusText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.3 },
});

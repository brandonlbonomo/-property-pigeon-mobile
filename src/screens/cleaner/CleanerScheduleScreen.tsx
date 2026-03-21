import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
  TouchableOpacity, Platform, Animated, Dimensions,
  PanResponder, PanResponderGestureState, ActivityIndicator,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useCleanerStore, CleanerEvent } from '../../store/cleanerStore';
import { localDateStr } from '../../utils/format';

type SubTab = 'Cleanings' | 'Check-ins' | 'Calendar';
const SUB_TABS: SubTab[] = ['Calendar', 'Cleanings', 'Check-ins'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const DAY_CELL_WIDTH = 52;
const DAYS_BEFORE = 30;
const DAYS_AFTER = 30;
const SCREEN_WIDTH = Dimensions.get('window').width;
const SUB_PAD = 3;

function buildDayList() {
  const today = new Date();
  const todayStr = localDateStr(today);
  const days: { date: string; label: string; dayNum: number; isToday: boolean }[] = [];
  for (let i = -DAYS_BEFORE; i <= DAYS_AFTER; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const dateStr = localDateStr(d);
    days.push({
      date: dateStr,
      label: WEEKDAYS[d.getDay()],
      dayNum: d.getDate(),
      isToday: dateStr === todayStr,
    });
  }
  return days;
}

const ALL_DAYS = buildDayList();

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

function EventCard({ event, type, isNew }: { event: CleanerEvent; type: 'cleaning' | 'checkin'; isNew?: boolean }) {
  const isCleaning = type === 'cleaning';
  const color = isCleaning ? Colors.yellow : Colors.green;
  const dateStr = isCleaning ? event.check_out : event.check_in;
  const time = dateStr ? new Date(dateStr).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';

  return (
    <View style={styles.eventCard}>
      <View style={[styles.eventBar, { backgroundColor: color }]} />
      <View style={styles.eventContent}>
        <View style={styles.eventTypeRow}>
          <Text style={[styles.eventType, { color }]}>
            {isCleaning ? 'CLEANING NEEDED' : 'CHECK-IN'}
          </Text>
          {isNew && (
            <View style={styles.newBadge}>
              <Text style={styles.newBadgeText}>NEW</Text>
            </View>
          )}
        </View>
        <Text style={styles.eventProp}>{event.prop_name}</Text>
        <Text style={styles.eventSub}>
          {event.owner} {time ? `· ${time}` : ''}
        </Text>
      </View>
    </View>
  );
}

export function CleanerScheduleScreen() {
  const { schedule, loading, fetchSchedule, newBookingUids, dismissNewBookings } = useCleanerStore();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<SubTab>('Calendar');
  const [selectedDate, setSelectedDate] = useState(() => localDateStr());
  const [propFilter, setPropFilter] = useState('all');

  // Calendar state
  const today = new Date();
  const [calMonth, setCalMonth] = useState(today.getMonth());
  const [calYear, setCalYear] = useState(today.getFullYear());
  const [calSelectedDay, setCalSelectedDay] = useState(localDateStr());
  const [calGridLayout, setCalGridLayout] = useState({ width: 0, height: 0 });
  const calGlassX = useRef(new Animated.Value(0)).current;
  const calGlassY = useRef(new Animated.Value(0)).current;
  const calSelectedRef = useRef(localDateStr());

  useEffect(() => {
    fetchSchedule().catch(() => setError('Could not load schedule.'));
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try { await fetchSchedule(true); }
    catch { setError('Could not load schedule.'); }
    finally { setRefreshing(false); }
  }, [fetchSchedule]);

  // ── Sub-tab liquid glass animation ──
  const subGlideX = useRef(new Animated.Value(0)).current;
  const [subContainerWidth, setSubContainerWidth] = useState(0);
  const didSetSubInit = useRef(false);
  const subTabRef = useRef<SubTab>(subTab);
  subTabRef.current = subTab;

  const subTabWidth = subContainerWidth > 0
    ? (subContainerWidth - SUB_PAD * 2) / SUB_TABS.length
    : 0;
  const subTabWidthRef = useRef(0);
  subTabWidthRef.current = subTabWidth;

  useEffect(() => {
    if (subTabWidth <= 0) return;
    const idx = SUB_TABS.indexOf(subTab);
    const target = SUB_PAD + idx * subTabWidth;
    if (!didSetSubInit.current) {
      didSetSubInit.current = true;
      subGlideX.setValue(target);
    } else {
      Animated.spring(subGlideX, {
        toValue: target,
        useNativeDriver: true,
        tension: 14,
        friction: 5,
      }).start();
    }
  }, [subTab, subTabWidth]);

  // Drag-tracking PanResponder: glass follows finger, snaps on release
  const subPan = useMemo(() => {
    let startX = 0;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      // Capture phase — steal gesture from TouchableOpacity on horizontal drag
      onMoveShouldSetPanResponderCapture: (_, gs) =>
        Math.abs(gs.dx) > 8 && Math.abs(gs.dx) > Math.abs(gs.dy) * 1.5,
      onPanResponderGrant: () => {
        const tw = subTabWidthRef.current;
        const curIdx = SUB_TABS.indexOf(subTabRef.current);
        startX = SUB_PAD + curIdx * tw;
      },
      onPanResponderMove: (_, gs) => {
        const tw = subTabWidthRef.current;
        if (tw <= 0) return;
        const maxX = SUB_PAD + (SUB_TABS.length - 1) * tw;
        const newX = Math.max(SUB_PAD, Math.min(maxX, startX + gs.dx));
        subGlideX.setValue(newX);
      },
      onPanResponderRelease: (_, gs) => {
        const tw = subTabWidthRef.current;
        if (tw <= 0) return;
        const finalX = startX + gs.dx;
        const idx = Math.round((finalX - SUB_PAD) / tw);
        const clampedIdx = Math.max(0, Math.min(SUB_TABS.length - 1, idx));
        setSubTab(SUB_TABS[clampedIdx]);
      },
    });
  }, []);

  // ── Day strip glass animation ──
  const todayIdx = ALL_DAYS.findIndex(d => d.isToday);
  const initIdx = todayIdx >= 0 ? todayIdx : DAYS_BEFORE;
  const slideX = useRef(new Animated.Value(initIdx * DAY_CELL_WIDTH)).current;
  const dayScrollRef = useRef<ScrollView>(null);
  const didInitScroll = useRef(false);

  const selectDate = useCallback((date: string) => {
    const idx = ALL_DAYS.findIndex(d => d.date === date);
    if (idx < 0) return;
    setSelectedDate(date);
    Animated.spring(slideX, {
      toValue: idx * DAY_CELL_WIDTH,
      useNativeDriver: true,
      tension: 14,
      friction: 5,
    }).start();
  }, []);

  // Scroll to today on mount
  useEffect(() => {
    if (!didInitScroll.current) {
      didInitScroll.current = true;
      const offset = Spacing.sm + initIdx * DAY_CELL_WIDTH - (SCREEN_WIDTH - DAY_CELL_WIDTH) / 2;
      setTimeout(() => {
        dayScrollRef.current?.scrollTo({ x: Math.max(0, offset), animated: false });
      }, 50);
    }
  }, []);

  // ── Data memos ──
  const uniqueProps = useMemo(() => {
    const set = new Map<string, string>();
    schedule.forEach(e => {
      if (e.prop_id && !set.has(e.prop_id)) set.set(e.prop_id, e.prop_name);
    });
    return Array.from(set.entries());
  }, [schedule]);

  const filteredEvents = useMemo(() => {
    return schedule.filter(e => {
      if (propFilter !== 'all' && e.prop_id !== propFilter) return false;
      const eventDate = subTab === 'Cleanings'
        ? (e.check_out || '').slice(0, 10)
        : (e.check_in || '').slice(0, 10);
      return eventDate === selectedDate;
    });
  }, [schedule, propFilter, selectedDate, subTab]);

  const calGrid = useMemo(() => getMonthGrid(calYear, calMonth), [calYear, calMonth]);

  const calCleaningDays = useMemo(() => {
    const days = new Set<string>();
    schedule.forEach(e => {
      if (propFilter !== 'all' && e.prop_id !== propFilter) return;
      const d = (e.check_out || '').slice(0, 10);
      if (d) days.add(d);
    });
    return days;
  }, [schedule, propFilter]);

  const calCheckinDays = useMemo(() => {
    const days = new Set<string>();
    schedule.forEach(e => {
      if (propFilter !== 'all' && e.prop_id !== propFilter) return;
      const d = (e.check_in || '').slice(0, 10);
      if (d) days.add(d);
    });
    return days;
  }, [schedule, propFilter]);

  const calDayEvents = useMemo(() => {
    return schedule.filter(e => {
      if (propFilter !== 'all' && e.prop_id !== propFilter) return false;
      const co = (e.check_out || '').slice(0, 10);
      const ci = (e.check_in || '').slice(0, 10);
      return co === calSelectedDay || ci === calSelectedDay;
    });
  }, [schedule, calSelectedDay, propFilter]);

  // New booking events (from iCal syncs)
  const newBookingEvents = useMemo(() => {
    if (newBookingUids.size === 0) return [];
    return schedule.filter(e => newBookingUids.has(e.uid));
  }, [schedule, newBookingUids]);

  const prevMonth = () => {
    if (calMonth === 0) { setCalMonth(11); setCalYear(y => y - 1); }
    else setCalMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (calMonth === 11) { setCalMonth(0); setCalYear(y => y + 1); }
    else setCalMonth(m => m + 1);
  };

  const todayStr = localDateStr();

  const numWeeks = calGrid.length;
  const calCellW = calGridLayout.width > 0 ? (calGridLayout.width - 2 * Spacing.sm) / 7 : 0;
  const calCellH = calGridLayout.height > 0 ? calGridLayout.height / numWeeks : 0;

  // Position glass on month change or initial layout
  useEffect(() => {
    const now = new Date();
    const isCurrentMonth = now.getMonth() === calMonth && now.getFullYear() === calYear;
    const day = isCurrentMonth ? now.getDate() : 1;
    const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    setCalSelectedDay(dateStr);
    calSelectedRef.current = dateStr;
    if (calCellW <= 0 || calCellH <= 0) return;
    const firstDow = new Date(calYear, calMonth, 1).getDay();
    const col = (firstDow + day - 1) % 7;
    const row = Math.floor((firstDow + day - 1) / 7);
    calGlassX.setValue(Spacing.sm + col * calCellW + (calCellW - 40) / 2);
    calGlassY.setValue(row * calCellH + (calCellH - 40) / 2);
  }, [calYear, calMonth, calCellW, calCellH]);

  const handleCalDayPress = useCallback((dateStr: string, row: number, col: number) => {
    if (calCellW <= 0 || calCellH <= 0 || calSelectedRef.current === dateStr) return;
    calSelectedRef.current = dateStr;
    setCalSelectedDay(dateStr);
    Animated.parallel([
      Animated.spring(calGlassX, { toValue: Spacing.sm + col * calCellW + (calCellW - 40) / 2, useNativeDriver: true, tension: 60, friction: 9 }),
      Animated.spring(calGlassY, { toValue: row * calCellH + (calCellH - 40) / 2, useNativeDriver: true, tension: 60, friction: 9 }),
    ]).start();
  }, [calCellW, calCellH]);

  if (loading && schedule.length === 0 && !refreshing) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={Colors.green} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={"#1A1A1A"} colors={["#1A1A1A"]} />}
    >
      {error && (
        <View style={styles.errorBanner}>
          <Ionicons name="cloud-offline-outline" size={16} color={Colors.red} />
          <Text style={styles.errorBannerText}>{error}</Text>
        </View>
      )}

      {/* New Booking Banner */}
      {newBookingEvents.length > 0 && (
        <View style={styles.newBookingBanner}>
          <View style={styles.newBookingLeft}>
            <View style={styles.newBookingIconWrap}>
              <Ionicons name="calendar" size={16} color={Colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.newBookingTitle}>
                {newBookingEvents.length} new cleaning{newBookingEvents.length !== 1 ? 's' : ''} booked
              </Text>
              <Text style={styles.newBookingSub}>
                {[...new Set(newBookingEvents.map(e => e.prop_name))].join(', ')}
              </Text>
            </View>
          </View>
          <TouchableOpacity activeOpacity={0.7} style={styles.newBookingDismiss} onPress={dismissNewBookings}>
            <Ionicons name="close" size={14} color={Colors.textDim} />
          </TouchableOpacity>
        </View>
      )}

      {/* Sub-tabs with liquid glass sliding indicator */}
      <View style={styles.subTabOuter} {...subPan.panHandlers}>
        <View
          style={styles.subTabContainer}
          onLayout={e => setSubContainerWidth(e.nativeEvent.layout.width)}
        >
          {subTabWidth > 0 && (
            <Animated.View style={[
              styles.subGlass,
              { width: subTabWidth, transform: [{ translateX: subGlideX }] },
            ]} />
          )}
          {SUB_TABS.map(tab => (
            <TouchableOpacity
              activeOpacity={0.7}
              key={tab}
              style={styles.subTab}
              onPress={() => setSubTab(tab)}
            >
              <Text style={[styles.subTabText, subTab === tab && styles.subTabTextActive]}>
                {tab}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Property filter chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
        <TouchableOpacity activeOpacity={0.7}
          style={[styles.chip, propFilter === 'all' && styles.chipActive]}
          onPress={() => setPropFilter('all')}
        >
          <Text style={[styles.chipText, propFilter === 'all' && styles.chipTextActive]}>All</Text>
        </TouchableOpacity>
        {uniqueProps.map(([id, name]) => (
          <TouchableOpacity activeOpacity={0.7}
          key={id}
            style={[styles.chip, propFilter === id && styles.chipActive]}
            onPress={() => setPropFilter(id)}
          >
            <Text style={[styles.chipText, propFilter === id && styles.chipTextActive]}>{name}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {subTab === 'Calendar' ? (
        <>
          {/* Month navigation */}
          <View style={styles.calHeader}>
            <TouchableOpacity activeOpacity={0.7} onPress={prevMonth} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
            </TouchableOpacity>
            <Text style={styles.calTitle}>{MONTH_NAMES[calMonth]} {calYear}</Text>
            <TouchableOpacity activeOpacity={0.7} onPress={nextMonth} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="chevron-forward" size={22} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Weekday headers */}
          <View style={styles.calWeekRow}>
            {WEEKDAYS.map(d => (
              <Text key={d} style={styles.calWeekDay}>{d}</Text>
            ))}
          </View>

          {/* Month grid */}
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
                  const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                  const isCleaning = calCleaningDays.has(dateStr);
                  const isCheckin = calCheckinDays.has(dateStr);
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
                        !isSelected && isCheckin && styles.calDayBubbleCheckin,
                        !isSelected && isCleaning && !isCheckin && styles.calDayBubbleCleaning,
                        isToday && styles.calDayBubbleToday,
                      ]}>
                        <Text style={[
                          styles.calDayText,
                          isCheckin && styles.calDayTextCheckin,
                          isCleaning && !isCheckin && styles.calDayTextCleaning,
                          isToday && styles.calDayTextToday,
                          isSelected && styles.calDayTextSelected,
                        ]}>
                          {day}
                        </Text>
                        {isCheckin && <View style={styles.calDotCheckin} />}
                        {isCleaning && !isCheckin && <View style={styles.calDotCleaning} />}
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
            {calDayEvents.length === 0 ? (
              <Text style={styles.calDetailEmpty}>No events on this day</Text>
            ) : (
              calDayEvents.map((ev, i) => {
                const isCleaning = (ev.check_out || '').slice(0, 10) === calSelectedDay;
                return (
                  <EventCard key={ev.uid + i} event={ev} type={isCleaning ? 'cleaning' : 'checkin'} isNew={newBookingUids.has(ev.uid)} />
                );
              })
            )}
          </View>
        </>
      ) : (
        <>
          {/* Scrollable day strip with sliding glass indicator */}
          <ScrollView
            ref={dayScrollRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.dayStripScroll}
            contentContainerStyle={styles.dayStripContent}
            decelerationRate="fast"
          >
            <View style={styles.dayStripInner}>
              <Animated.View
                style={[styles.daySlider, { transform: [{ translateX: slideX }] }]}
              />
              {ALL_DAYS.map(d => (
                <TouchableOpacity activeOpacity={0.7}
                  key={d.date}
                  style={styles.dayCell}
                  onPress={() => selectDate(d.date)}
                >
                  <Text style={[styles.dayLabel, selectedDate === d.date && styles.dayLabelActive]}>{d.label}</Text>
                  <Text style={[styles.dayNum, selectedDate === d.date && styles.dayNumActive, d.isToday && styles.dayToday]}>
                    {d.dayNum}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>

          {/* Events */}
          <View style={styles.events}>
            {filteredEvents.length === 0 ? (
              <View style={styles.empty}>
                <Ionicons name="sparkles-outline" size={36} color={Colors.textDim} />
                <Text style={styles.emptyText}>
                  No {subTab.toLowerCase()} for this date
                </Text>
              </View>
            ) : (
              filteredEvents.map((ev, i) => (
                <EventCard
                  key={ev.uid + i}
                  event={ev}
                  type={subTab === 'Cleanings' ? 'cleaning' : 'checkin'}
                  isNew={newBookingUids.has(ev.uid)}
                />
              ))
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent', paddingTop: 140 },
  loadingContainer: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },
  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: 'rgba(239,68,68,0.08)', borderRadius: Radius.md,
    padding: Spacing.sm, marginHorizontal: Spacing.md, marginTop: Spacing.sm, borderWidth: 0.5, borderColor: 'rgba(239,68,68,0.20)',
  },
  errorBannerText: { fontSize: FontSize.xs, color: Colors.red, flex: 1, lineHeight: 16 },

  // New Booking Banner
  newBookingBanner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.greenDim, borderRadius: Radius.xl,
    padding: Spacing.md, marginHorizontal: Spacing.md, marginTop: Spacing.sm,
    borderWidth: 0.5, borderColor: 'rgba(59,130,246,0.20)',
    ...Platform.select({
      ios: { shadowColor: 'rgba(59,130,246,0.25)', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 1, shadowRadius: 10 },
      android: { elevation: 2 },
    }),
  },
  newBookingLeft: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, flex: 1 },
  newBookingIconWrap: {
    width: 32, height: 32, borderRadius: 10,
    backgroundColor: 'rgba(59,130,246,0.15)', alignItems: 'center', justifyContent: 'center',
  },
  newBookingTitle: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text },
  newBookingSub: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 1 },
  newBookingDismiss: {
    padding: 6, borderRadius: Radius.pill,
    backgroundColor: Colors.glass, borderWidth: 0.5, borderColor: Colors.glassBorder,
  },

  // Sub-tabs — liquid glass container
  subTabOuter: {
    paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm,
  },
  subTabContainer: {
    flexDirection: 'row',
    backgroundColor: Colors.glassDark,
    borderRadius: Radius.pill,
    padding: SUB_PAD,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    height: 32,
  },
  subGlass: {
    position: 'absolute',
    top: SUB_PAD,
    bottom: SUB_PAD,
    borderRadius: Radius.pill,
    backgroundColor: Colors.glass,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight,
    borderTopWidth: 1,
    ...Platform.select({
      ios: {
        shadowColor: Colors.glassShadow,
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.45,
        shadowRadius: 8,
      },
    }),
  },
  subTab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.pill,
  },
  subTabText: { fontSize: FontSize.xs, color: Colors.textDim, fontWeight: '500' },
  subTabTextActive: { color: Colors.text, fontWeight: '600' },

  chipRow: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },
  chip: {
    paddingHorizontal: Spacing.sm, paddingVertical: 4,
    borderRadius: Radius.pill, borderWidth: 0.5, borderColor: Colors.glassBorder,
    backgroundColor: Colors.glassDark, marginRight: Spacing.xs, overflow: 'hidden',
  },
  chipActive: {
    backgroundColor: Colors.glass,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.45, shadowRadius: 8 },
    }),
  },
  chipText: { fontSize: FontSize.xs, color: Colors.textDim, fontWeight: '500' },
  chipTextActive: { color: Colors.text, fontWeight: '600' },

  // Day strip
  dayStripScroll: {
    paddingTop: Spacing.md, paddingBottom: Spacing.sm,
  },
  dayStripContent: {
    paddingHorizontal: Spacing.sm,
  },
  dayStripInner: {
    flexDirection: 'row',
  },
  daySlider: {
    position: 'absolute', top: 0, bottom: 0,
    width: DAY_CELL_WIDTH,
    backgroundColor: Colors.glass, borderRadius: Radius.lg,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.45, shadowRadius: 8 },
    }),
  },
  dayCell: { alignItems: 'center', paddingVertical: Spacing.xs, width: DAY_CELL_WIDTH },
  dayLabel: { fontSize: FontSize.xs, color: Colors.textDim },
  dayLabelActive: { color: Colors.text, fontWeight: '600' },
  dayNum: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.text, marginTop: 2 },
  dayNumActive: { color: Colors.text, fontWeight: '800' },
  dayToday: { color: Colors.green, fontWeight: '900' },

  events: { padding: Spacing.md },
  eventCard: {
    flexDirection: 'row', gap: Spacing.sm,
    padding: Spacing.md,
    backgroundColor: Colors.glassHeavy, borderRadius: Radius.lg,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    marginBottom: Spacing.sm,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 20 },
      android: { elevation: 2 },
    }),
  },
  eventBar: { width: 3, borderRadius: 2, alignSelf: 'stretch' },
  eventContent: { flex: 1 },
  eventTypeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  eventType: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  newBadge: {
    backgroundColor: Colors.green, borderRadius: Radius.pill,
    paddingHorizontal: 5, paddingVertical: 1,
  },
  newBadgeText: { fontSize: 8, fontWeight: '800', color: '#fff', letterSpacing: 0.5 },
  eventProp: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginTop: 2 },
  eventSub: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 1 },
  empty: {
    alignItems: 'center', justifyContent: 'center', paddingVertical: Spacing.xl * 2,
  },
  emptyText: { fontSize: FontSize.sm, color: Colors.textDim, marginTop: Spacing.sm },

  // Calendar styles
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
    borderWidth: 3, borderColor: Colors.green,
    backgroundColor: 'rgba(30,206,110,0.08)',
    ...Platform.select({
      ios: { shadowColor: Colors.green, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.5, shadowRadius: 8 },
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
  calDayTextToday: { color: Colors.green, fontWeight: '900' },
  calDayTextCheckin: { color: Colors.green, fontWeight: '600' },
  calDayTextCleaning: { color: Colors.yellow, fontWeight: '600' },
  calDayTextSelected: { fontWeight: '800' as const },
  calDotCheckin: {
    width: 5, height: 5, borderRadius: 2.5, backgroundColor: Colors.green, marginTop: 2,
  },
  calDotCleaning: {
    width: 5, height: 5, borderRadius: 2.5, backgroundColor: Colors.yellow, marginTop: 2,
  },
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
});

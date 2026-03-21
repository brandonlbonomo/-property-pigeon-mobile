import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Platform,
  Animated, Modal, ScrollView, Alert,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../../constants/theme';
import { CleanerEvent } from '../../../store/cleanerStore';
import { localDateStr } from '../../../utils/format';
import { glassAlert } from '../../../components/GlassAlert';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

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

function pad(n: number) { return n < 10 ? `0${n}` : `${n}`; }
function dateStr(y: number, m: number, d: number) { return `${y}-${pad(m + 1)}-${pad(d)}`; }

interface Props {
  events: CleanerEvent[];
  invoicedUids: Set<string>;
  selectedUnits: Map<string, Set<string>>;
  selectedCleanings: Map<string, CleanerEvent>;
  onToggleCleaning: (uid: string, event: CleanerEvent) => void;
  onNext?: () => void;
}

export function CalendarStep({
  events, invoicedUids, selectedUnits, selectedCleanings, onToggleCleaning, onNext,
}: Props) {
  const todayStr = localDateStr();
  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [sheetDate, setSheetDate] = useState<string | null>(null);
  const [activeQuick, setActiveQuick] = useState<'today' | 'week' | 'month' | null>(null);
  const [calGridLayout, setCalGridLayout] = useState({ width: 0, height: 0 });
  const calGlassX = useRef(new Animated.Value(0)).current;
  const calGlassY = useRef(new Animated.Value(0)).current;
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const { year: vYear, month: vMonth } = viewMonth;
  const weeks = useMemo(() => getMonthGrid(vYear, vMonth), [vYear, vMonth]);

  // Filter events to only selected units
  const filteredEvents = useMemo(() => {
    return events.filter(e => {
      const unitSet = selectedUnits.get(e.prop_id);
      if (!unitSet) return false;
      // Match by feed_key if available, otherwise include if prop_id matched
      if (e.feed_key) return unitSet.has(e.feed_key);
      return unitSet.size > 0;
    });
  }, [events, selectedUnits]);

  // Build day → events map (keyed by check_out date = cleaning day)
  const dayEventsMap = useMemo(() => {
    const map = new Map<string, CleanerEvent[]>();
    filteredEvents.forEach(e => {
      const d = (e.check_out || '').slice(0, 10);
      if (!d) return;
      if (!map.has(d)) map.set(d, []);
      map.get(d)!.push(e);
    });
    return map;
  }, [filteredEvents]);

  const numWeeks = weeks.length;
  const calCellW = calGridLayout.width > 0 ? (calGridLayout.width - 2 * Spacing.sm) / 7 : 0;
  const calCellH = calGridLayout.height > 0 ? calGridLayout.height / numWeeks : 0;

  // Position glass
  useEffect(() => {
    if (calCellW <= 0 || calCellH <= 0) return;
    const now = new Date();
    const isCurrentMonth = now.getMonth() === vMonth && now.getFullYear() === vYear;
    const day = isCurrentMonth ? now.getDate() : 1;
    const firstDow = new Date(vYear, vMonth, 1).getDay();
    const col = (firstDow + day - 1) % 7;
    const row = Math.floor((firstDow + day - 1) / 7);
    calGlassX.setValue(Spacing.sm + col * calCellW + (calCellW - 40) / 2);
    calGlassY.setValue(row * calCellH + (calCellH - 40) / 2);
  }, [vYear, vMonth, calCellW, calCellH]);

  const handleDayPress = useCallback((ds: string, row: number, col: number) => {
    if (calCellW <= 0 || calCellH <= 0) return;
    setSelectedDay(ds);
    Animated.parallel([
      Animated.spring(calGlassX, { toValue: Spacing.sm + col * calCellW + (calCellW - 40) / 2, useNativeDriver: true, tension: 60, friction: 9 }),
      Animated.spring(calGlassY, { toValue: row * calCellH + (calCellH - 40) / 2, useNativeDriver: true, tension: 60, friction: 9 }),
    ]).start();

    const isFuture = ds > todayStr;
    if (isFuture) return;

    const dayEvents = dayEventsMap.get(ds) || [];
    if (dayEvents.length === 0) return;

    // Check if all are invoiced
    const allInvoiced = dayEvents.every(e => invoicedUids.has(e.uid));
    if (allInvoiced) {
      glassAlert('Already Invoiced', 'All cleanings on this date have been invoiced.');
      return;
    }

    setSheetDate(ds);
  }, [calCellW, calCellH, dayEventsMap, invoicedUids, todayStr]);

  // Quick select helpers
  const getQuickRange = useCallback((range: 'today' | 'week' | 'month') => {
    const now = new Date();
    let start: string, end: string;
    if (range === 'today') {
      start = end = todayStr;
    } else if (range === 'week') {
      const day = now.getDay();
      const diffToMonday = day === 0 ? 6 : day - 1;
      const monday = new Date(now);
      monday.setDate(now.getDate() - diffToMonday);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      start = localDateStr(monday);
      end = localDateStr(sunday);
    } else {
      start = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
      end = todayStr;
    }
    return { start, end };
  }, [todayStr]);

  const quickSelect = useCallback((range: 'today' | 'week' | 'month') => {
    setActiveQuick(prev => prev === range ? null : range);
    const { start, end } = getQuickRange(range);
    filteredEvents.forEach(e => {
      const d = (e.check_out || '').slice(0, 10);
      if (d >= start && d <= end && d <= todayStr && !invoicedUids.has(e.uid) && !selectedCleanings.has(e.uid)) {
        onToggleCleaning(e.uid, e);
      }
    });
  }, [filteredEvents, invoicedUids, selectedCleanings, onToggleCleaning, todayStr, getQuickRange]);

  // Events in the active quick-select range (for the list below calendar)
  const quickRangeEvents = useMemo(() => {
    if (!activeQuick) return [];
    const { start, end } = getQuickRange(activeQuick);
    return filteredEvents.filter(e => {
      const d = (e.check_out || '').slice(0, 10);
      return d >= start && d <= end && d <= todayStr;
    });
  }, [activeQuick, filteredEvents, getQuickRange, todayStr]);

  const sheetEvents = sheetDate ? (dayEventsMap.get(sheetDate) || []) : [];
  const sheetDateObj = sheetDate ? new Date(sheetDate + 'T12:00:00') : null;

  return (
    <View style={styles.container}>
      {/* Quick-select pills */}
      <View style={styles.quickRow}>
        {(['today', 'week', 'month'] as const).map(r => (
          <TouchableOpacity
            key={r}
            activeOpacity={0.7}
            style={[styles.quickPill, activeQuick === r && styles.quickPillActive]}
            onPress={() => quickSelect(r)}
          >
            <Text style={[styles.quickText, activeQuick === r && styles.quickTextActive]}>
              {r === 'today' ? 'Today' : r === 'week' ? 'This Week' : 'This Month'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Month navigation */}
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
        <Text style={styles.calHeaderTitle}>{MONTH_NAMES[vMonth]} {vYear}</Text>
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
      <View style={styles.weekRow}>
        {WEEKDAYS.map((d, i) => (
          <Text key={i} style={styles.weekDay}>{d}</Text>
        ))}
      </View>

      {/* Calendar grid */}
      <View
        style={styles.gridWrap}
        onLayout={e => setCalGridLayout({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
      >
        {calCellW > 0 && (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.slidingGlass,
              { transform: [{ translateX: calGlassX }, { translateY: calGlassY }] },
            ]}
          />
        )}
        {weeks.map((week, wi) => (
          <View key={wi} style={styles.weekRow}>
            {week.map((day, di) => {
              if (day === null) return <View key={di} style={styles.dayCell} />;
              const ds = dateStr(vYear, vMonth, day);
              const isFuture = ds > todayStr;
              const dayEvents = dayEventsMap.get(ds) || [];
              const hasEvents = dayEvents.length > 0;
              const allInvoiced = hasEvents && dayEvents.every(e => invoicedUids.has(e.uid));
              const allSelected = hasEvents && !allInvoiced && dayEvents.every(e => selectedCleanings.has(e.uid) || invoicedUids.has(e.uid));
              const someSelected = hasEvents && !allSelected && dayEvents.some(e => selectedCleanings.has(e.uid));

              let bubbleStyle: any = {};
              if (isFuture) bubbleStyle = styles.dayFuture;
              else if (allInvoiced) bubbleStyle = styles.dayInvoiced;
              else if (allSelected) bubbleStyle = styles.daySelected;
              else if (someSelected) bubbleStyle = styles.dayPartial;
              else if (hasEvents) bubbleStyle = styles.daySelectable;

              return (
                <TouchableOpacity
                  activeOpacity={0.7}
                  key={di}
                  style={styles.dayCell}
                  onPress={() => handleDayPress(ds, wi, di)}
                  disabled={isFuture}
                >
                  <View style={[styles.dayBubble, bubbleStyle]}>
                    <Text style={[
                      styles.dayText,
                      isFuture && { opacity: 0.35 },
                      allInvoiced && { color: Colors.textDim },
                      allSelected && { color: '#fff', fontWeight: '700' },
                      ds === todayStr && { color: Colors.primary, fontWeight: '800' },
                    ]}>
                      {day}
                    </Text>
                    {allInvoiced && (
                      <Ionicons name="lock-closed" size={8} color={Colors.textDim} style={{ marginTop: 1 }} />
                    )}
                    {allSelected && (
                      <Ionicons name="checkmark" size={9} color="#fff" style={{ marginTop: 1 }} />
                    )}
                    {someSelected && <View style={styles.halfDot} />}
                    {hasEvents && !allInvoiced && !allSelected && !someSelected && (
                      <View style={styles.eventDot} />
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </View>

      {/* Legend */}
      <View style={styles.legendRow}>
        <View style={styles.legendItem}>
          <View style={[styles.legendSwatch, { backgroundColor: 'rgba(245,158,11,0.15)', borderColor: 'rgba(245,158,11,0.30)' }]} />
          <Text style={styles.legendText}>Available</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendSwatch, { backgroundColor: Colors.green, borderColor: Colors.primary }]} />
          <Text style={styles.legendText}>Selected</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendSwatch, { backgroundColor: 'rgba(156,163,175,0.15)', borderColor: 'rgba(156,163,175,0.30)' }]} />
          <Text style={styles.legendText}>Invoiced</Text>
        </View>
      </View>

      {/* Cleaning list for active quick-select range */}
      {activeQuick && quickRangeEvents.length > 0 && (
        <View style={styles.rangeList}>
          <Text style={styles.rangeListTitle}>
            {activeQuick === 'today' ? "Today's Cleanings" : activeQuick === 'week' ? 'This Week' : 'This Month'}
          </Text>
          {quickRangeEvents.map(ev => {
            const isInvoiced = invoicedUids.has(ev.uid);
            const isChecked = selectedCleanings.has(ev.uid);
            return (
              <TouchableOpacity
                key={ev.uid}
                activeOpacity={isInvoiced ? 1 : 0.7}
                style={styles.rangeListRow}
                onPress={() => !isInvoiced && onToggleCleaning(ev.uid, ev)}
                disabled={isInvoiced}
              >
                <Ionicons
                  name={isInvoiced ? 'lock-closed' : isChecked ? 'checkbox' : 'square-outline'}
                  size={20}
                  color={isInvoiced ? Colors.textDim : isChecked ? Colors.green : Colors.textDim}
                />
                <View style={{ flex: 1, marginLeft: Spacing.sm }}>
                  <Text style={[styles.rangeListName, isInvoiced && { color: Colors.textDim }]}>
                    {ev.unit_name || ev.prop_name}
                  </Text>
                  <Text style={styles.rangeListSub}>
                    {new Date((ev.check_out || '') + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                    {ev.guest_name ? ` · ${ev.guest_name}` : ''}
                  </Text>
                </View>
                {isInvoiced && (
                  <View style={styles.invoicedBadge}>
                    <Text style={styles.invoicedText}>Invoiced</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      )}
      {activeQuick && quickRangeEvents.length === 0 && (
        <Text style={{ textAlign: 'center', color: Colors.textDim, fontSize: FontSize.sm, paddingVertical: Spacing.md }}>
          No cleanings in this range
        </Text>
      )}

      {/* Shopping cart badge — tappable to advance to next step */}
      {selectedCleanings.size > 0 && (
        <TouchableOpacity activeOpacity={0.7} style={styles.cartBadge} onPress={onNext}>
          <Ionicons name="cart" size={16} color="#fff" />
          <Text style={styles.cartText}>
            {selectedCleanings.size} cleaning{selectedCleanings.size !== 1 ? 's' : ''} selected
          </Text>
          <Ionicons name="arrow-forward" size={14} color="#fff" style={{ marginLeft: 4 }} />
        </TouchableOpacity>
      )}

      {/* Bottom Sheet Modal */}
      <Modal visible={!!sheetDate} transparent animationType="slide" onRequestClose={() => setSheetDate(null)}>
        <TouchableOpacity style={styles.sheetOverlay} activeOpacity={1} onPress={() => setSheetDate(null)}>
          <View style={styles.sheetCard} onStartShouldSetResponder={() => true}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>
              {sheetDateObj?.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            </Text>
            <ScrollView style={styles.sheetScroll}>
              {sheetEvents.map((ev) => {
                const isInvoiced = invoicedUids.has(ev.uid);
                const isChecked = selectedCleanings.has(ev.uid);
                return (
                  <TouchableOpacity
                    key={ev.uid}
                    activeOpacity={isInvoiced ? 1 : 0.7}
                    style={styles.sheetRow}
                    onPress={() => !isInvoiced && onToggleCleaning(ev.uid, ev)}
                    disabled={isInvoiced}
                  >
                    <Ionicons
                      name={isInvoiced ? 'lock-closed' : isChecked ? 'checkbox' : 'square-outline'}
                      size={22}
                      color={isInvoiced ? Colors.textDim : isChecked ? Colors.primary : Colors.textDim}
                    />
                    <View style={styles.sheetRowInfo}>
                      <Text style={[styles.sheetRowName, isInvoiced && { color: Colors.textDim }]}>
                        {ev.unit_name || ev.prop_name}
                      </Text>
                      {ev.guest_name ? (
                        <Text style={styles.sheetRowSub}>Guest: {ev.guest_name}</Text>
                      ) : null}
                    </View>
                    {isInvoiced && (
                      <View style={styles.invoicedBadge}>
                        <Text style={styles.invoicedText}>Invoiced</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity
              activeOpacity={0.7}
              style={styles.sheetDoneBtn}
              onPress={() => setSheetDate(null)}
            >
              <Text style={styles.sheetDoneText}>Done</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  quickRow: {
    flexDirection: 'row', gap: Spacing.sm,
    paddingHorizontal: Spacing.md, paddingTop: Spacing.sm, paddingBottom: Spacing.xs,
  },
  quickPill: {
    paddingHorizontal: 14, paddingVertical: 7,
    borderRadius: Radius.pill, backgroundColor: Colors.glassDark,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
  },
  quickText: { fontSize: FontSize.xs, color: Colors.text, fontWeight: '600' },
  quickPillActive: {
    backgroundColor: Colors.green,
    borderColor: Colors.green,
  },
  quickTextActive: { color: '#fff' },
  calHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingTop: Spacing.sm, paddingBottom: Spacing.xs,
  },
  calHeaderTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  weekRow: { flexDirection: 'row', paddingHorizontal: Spacing.sm },
  weekDay: {
    flex: 1, textAlign: 'center', fontSize: FontSize.xs,
    color: Colors.textDim, fontWeight: '600', paddingVertical: 4,
  },
  gridWrap: { position: 'relative' as const },
  slidingGlass: {
    position: 'absolute' as const,
    width: 40, height: 40, borderRadius: 16,
    backgroundColor: Colors.glass,
    borderWidth: 2.5, borderColor: Colors.glassBorder,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.8, shadowRadius: 16 },
    }),
  },
  dayCell: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 3, minHeight: 44,
  },
  dayBubble: {
    width: 38, height: 38, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  dayText: { fontSize: FontSize.md, fontWeight: '500', color: Colors.text },
  dayFuture: { opacity: 0.35 },
  dayInvoiced: {
    backgroundColor: 'rgba(156,163,175,0.15)',
    borderWidth: 1, borderColor: 'rgba(156,163,175,0.25)',
  },
  daySelectable: {
    backgroundColor: 'rgba(245,158,11,0.15)',
    borderWidth: 1.5, borderColor: 'rgba(245,158,11,0.25)',
  },
  daySelected: {
    backgroundColor: Colors.green,
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 8 },
    }),
  },
  dayPartial: {
    backgroundColor: 'rgba(245,158,11,0.15)',
    borderWidth: 1.5, borderColor: 'rgba(245,158,11,0.25)',
  },
  halfDot: {
    width: 5, height: 5, borderRadius: 2.5,
    backgroundColor: Colors.green, marginTop: 1,
  },
  eventDot: {
    width: 5, height: 5, borderRadius: 2.5,
    backgroundColor: Colors.yellow, marginTop: 1,
  },

  // Legend
  legendRow: {
    flexDirection: 'row', justifyContent: 'center', gap: Spacing.lg,
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendSwatch: { width: 14, height: 14, borderRadius: 6, borderWidth: 1.5 },
  legendText: { fontSize: FontSize.xs, color: Colors.textDim },

  // Cart badge
  cartBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    alignSelf: 'center',
    backgroundColor: Colors.green, borderRadius: Radius.pill,
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm + 2,
    marginTop: Spacing.sm,
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 16 },
    }),
  },
  cartText: { color: '#fff', fontSize: FontSize.sm, fontWeight: '600' },

  // Bottom sheet
  sheetOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  sheetCard: {
    backgroundColor: Colors.glassOverlay, borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl, padding: Spacing.lg,
    maxHeight: '60%',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: -8 }, shadowOpacity: 0.1, shadowRadius: 20 },
    }),
  },
  sheetHandle: {
    width: 36, height: 5, borderRadius: 2.5,
    backgroundColor: Colors.glassBorder, alignSelf: 'center',
    marginBottom: Spacing.md,
  },
  sheetTitle: {
    fontSize: FontSize.lg, fontWeight: '700', color: Colors.text,
    marginBottom: Spacing.md,
  },
  sheetScroll: { maxHeight: 300 },
  sheetRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: Colors.border,
  },
  sheetRowInfo: { flex: 1 },
  sheetRowName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  sheetRowSub: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  invoicedBadge: {
    backgroundColor: Colors.glassDark, borderRadius: Radius.pill,
    paddingHorizontal: 8, paddingVertical: 2,
  },
  invoicedText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textDim },
  sheetDoneBtn: {
    backgroundColor: Colors.green, borderRadius: Radius.lg,
    paddingVertical: Spacing.sm + 2, alignItems: 'center',
    marginTop: Spacing.md,
  },
  sheetDoneText: { color: '#fff', fontSize: FontSize.md, fontWeight: '600' },

  // Range cleaning list
  rangeList: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },
  rangeListTitle: {
    fontSize: FontSize.xs, fontWeight: '700', color: Colors.textDim,
    letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: Spacing.sm,
  },
  rangeListRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
  },
  rangeListName: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  rangeListSub: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 1 },
});

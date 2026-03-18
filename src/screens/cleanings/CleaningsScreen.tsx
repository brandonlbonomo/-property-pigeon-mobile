import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl, Platform,
  ActivityIndicator, TouchableOpacity, TextInput, Keyboard, Modal,
  Animated, Dimensions, NativeSyntheticEvent, NativeScrollEvent,
  KeyboardAvoidingView,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
// Lazy-load expo-clipboard to avoid crash if native module missing
const Clipboard = { setStringAsync: async (s: string) => { try { const C = require('expo-clipboard'); await C.setStringAsync(s); } catch { /* fallback */ } } };
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';

import { useDataStore } from '../../store/dataStore';
import { useUserStore } from '../../store/userStore';
import { apiFetch } from '../../services/api';
import { useSubscriptionGate } from '../../hooks/useSubscriptionGate';
import { useProCheckout } from '../../hooks/useProCheckout';
import { EmptyState } from '../../components/EmptyState';
import { SwipePills } from '../../components/SwipePills';
import { Card } from '../../components/Card';
import { BarChart, BarData, dismissAllChartTooltips } from '../../components/BarChart';
import { SectionHeader } from '../../components/SectionHeader';
import { GlossyHorizontalBar } from '../../components/GlossyHorizontalBar';
import { fmt$ } from '../../utils/format';


type SubTab = 'Calendar' | 'Cleanings' | 'Cost' | 'Rates';
const SCREEN_W = Dimensions.get('window').width;
const SUB_TABS: SubTab[] = ['Calendar', 'Cleanings', 'Cost', 'Rates'];
const RATES_KEY = 'pp_cleaning_rates';
const MONTH_NAMES_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const WEEKDAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ── Calendar helpers ──

function getMonthGrid(year: number, month: number) {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const startDay = first.getDay();
  const daysInMonth = last.getDate();
  const weeks: (number | null)[][] = [];
  let week: (number | null)[] = new Array(startDay).fill(null);
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

// ══════════════════════════════════════
// ── Main Screen ──
// ══════════════════════════════════════

function LockedSubTab() {
  const checkout = useProCheckout();
  return (
    <View style={styles.lockedPanel}>
      <View style={styles.lockedCircle}>
        <Ionicons name="lock-closed" size={28} color={Colors.textDim} />
      </View>
      <Text style={styles.lockedTitle}>Pro Feature</Text>
      <Text style={styles.lockedDesc}>
        Subscribe to Pro to access cleaning schedules, cost tracking, rate management, and occupancy tracking.
      </Text>
      <TouchableOpacity
        activeOpacity={0.7}
        style={[styles.lockedBtn, checkout.loading && { opacity: 0.6 }]}
        onPress={checkout.startCheckout}
        disabled={checkout.loading}
      >
        {checkout.loading ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <>
            <Ionicons name="diamond-outline" size={14} color="#fff" />
            <Text style={styles.lockedBtnText}>Subscribe to Pro</Text>
          </>
        )}
      </TouchableOpacity>
      {Platform.OS === 'ios' && (
        <TouchableOpacity activeOpacity={0.7} style={styles.restoreLink} onPress={async () => {
          const { restorePurchases } = require('../../services/revenueCat');
          const info = await restorePurchases();
          if (info) { await require('../../store/userStore').useUserStore.getState().fetchBillingStatus(); }
        }}>
          <Text style={styles.restoreLinkText}>Restore Purchases</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

export function CleaningsScreen() {
  const { isReadOnly } = useSubscriptionGate();
  const { fetchIcalEvents, fetchIcalFeeds, fetchProps, fetchAnalytics } = useDataStore();
  const lastError = useDataStore(s => s.lastError);
  const [events, setEvents] = useState<any[]>([]);
  const [props, setProps] = useState<any[]>([]);
  const [analytics, setAnalytics] = useState<any>(null);
  const [plStats, setPlStats] = useState<any>(null);
  const [feedMap, setFeedMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [propFilter, setPropFilter] = useState<string>('all');
  const [subTab, setSubTab] = useState<SubTab>('Calendar');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [tappedCard, setTappedCard] = useState<'cleanings' | 'cost' | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(() => new Date().toISOString().slice(0, 10));
  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  // ── Horizontal paging state ──
  const scrollX = useRef(new Animated.Value(0)).current;
  const horizontalRef = useRef<ScrollView>(null);

  const handlePillSelect = useCallback((key: SubTab) => {
    const idx = SUB_TABS.indexOf(key);
    horizontalRef.current?.scrollTo({ x: idx * SCREEN_W, animated: true });
    setSubTab(key);
  }, []);

  const onMomentumEnd = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const idx = Math.round(e.nativeEvent.contentOffset.x / SCREEN_W);
    if (idx >= 0 && idx < SUB_TABS.length) setSubTab(SUB_TABS[idx]);
  }, []);

  // Calendar sliding glass state
  const [calGridLayout, setCalGridLayout] = useState({ width: 0, height: 0 });
  const calGlassX = useRef(new Animated.Value(0)).current;
  const calGlassY = useRef(new Animated.Value(0)).current;
  const calSelectedRef = useRef<string>(new Date().toISOString().slice(0, 10));

  // ── Cost / Rates state ──
  const [rates, setRates] = useState<Record<string, number>>({});
  const [costYear, setCostYear] = useState(new Date().getFullYear());
  const [showYearPicker, setShowYearPicker] = useState(false);
  const [receivedInvoices, setReceivedInvoices] = useState<any[]>([]);
  const fetchReceivedInvoices = useDataStore(s => s.fetchReceivedInvoices);

  // ── Follow code popup (STR/both owners, first visit) ──
  const userProfile = useUserStore(s => s.profile);
  const fetchFollowCode = useUserStore(s => s.fetchFollowCode);
  const [showFollowCodeModal, setShowFollowCodeModal] = useState(false);
  const [followCode, setFollowCode] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);

  useEffect(() => {
    const pt = userProfile?.portfolioType;
    if (pt !== 'str' && pt !== 'both') return;
    if (userProfile?.accountType === 'cleaner') return;
    (async () => {
      const shown = await SecureStore.getItemAsync('pp_follow_code_shown');
      if (shown) return;
      const code = await fetchFollowCode();
      if (code) {
        setFollowCode(code);
        setShowFollowCodeModal(true);
      }
    })();
  }, []);

  const dismissFollowCode = async () => {
    setShowFollowCodeModal(false);
    await SecureStore.setItemAsync('pp_follow_code_shown', 'true');
  };

  const copyCode = async () => {
    if (followCode) {
      await Clipboard.setStringAsync(followCode);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    }
  };

  // Load rates from SecureStore on mount
  useEffect(() => {
    (async () => {
      try {
        const stored = await SecureStore.getItemAsync(RATES_KEY);
        if (stored) setRates(JSON.parse(stored));
      } catch {}
    })();
  }, []);

  const saveRate = useCallback(async (propId: string, amount: number) => {
    const next = { ...rates, [propId]: amount };
    setRates(next);
    try {
      await SecureStore.setItemAsync(RATES_KEY, JSON.stringify(next));
    } catch {}
  }, [rates]);

  const hasPriceLabs = !!userProfile?.priceLabsApiKey;

  const load = useCallback(async (force = false) => {
    try {
      const [ev, pr, an, rawFeeds] = await Promise.all([
        fetchIcalEvents(force),
        fetchProps(force),
        fetchAnalytics(force),
        fetchIcalFeeds(force),
      ]);
      setProps(pr || []);
      setEvents(ev || []);
      setAnalytics(an);
      // Build feed_key → listingName map for unit-level labels
      const map: Record<string, string> = {};
      (rawFeeds || []).forEach((f: any) => {
        if (f.feed_key && f.listingName) map[f.feed_key] = f.listingName;
      });
      setFeedMap(map);
      setLastUpdated(new Date());
      // Load received invoices for cost tab
      try {
        const invs = await fetchReceivedInvoices(force);
        setReceivedInvoices(invs);
      } catch {}
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
  }, [fetchIcalEvents, fetchIcalFeeds, fetchProps, fetchAnalytics, fetchReceivedInvoices, hasPriceLabs]);

  useEffect(() => { load(); }, []);
  const onRefresh = () => { setRefreshing(true); load(true); };

  const propLabel = (pid: string, feedKey?: string) => {
    // Use feed listingName for unit-level label (e.g. "LOCKWOOD - Unit 1")
    if (feedKey && feedMap[feedKey]) return feedMap[feedKey];
    const p = (props || []).find((p: any) => (p.id || p.prop_id) === pid);
    return p?.label || pid || 'Property';
  };

  // ── Derive data ──

  const { cleanings, allCleanings, checkins, calendarData } = useMemo(() => {
    const sorted = [...events].sort((a: any, b: any) =>
      (a.check_out || '').localeCompare(b.check_out || '')
    );

    const cleaningDays: any[] = [];
    const checkinDays: any[] = [];
    const seen = new Set<string>();
    const seenCI = new Set<string>();

    sorted.forEach((e: any) => {
      if (!e.check_out || !e.prop_id) return;
      // Use feed_key in dedup key so different units get separate entries
      const unitKey = e.feed_key || '';
      const key = `${e.prop_id}-${unitKey}-${e.check_out}`;
      if (!seen.has(key)) {
        seen.add(key);
        const sameDayNext = sorted.find(
          (n: any) => n.prop_id === e.prop_id && (n.feed_key || '') === unitKey && n.check_in === e.check_out && n !== e
        );
        let prevNights = 0;
        if (e.check_in && e.check_out) {
          const ci = new Date(e.check_in);
          const co = new Date(e.check_out);
          prevNights = Math.round((co.getTime() - ci.getTime()) / 86400000);
        }
        cleaningDays.push({
          date: e.check_out,
          prop_id: e.prop_id,
          feed_key: e.feed_key || '',
          outGuest: e.summary || e.guest_name,
          inGuest: sameDayNext?.summary || sameDayNext?.guest_name || null,
          sameDayTurnover: !!sameDayNext,
          prevNights,
        });
      }
      if (e.check_in) {
        const ciKey = `${e.prop_id}-${unitKey}-${e.check_in}`;
        if (!seenCI.has(ciKey)) {
          seenCI.add(ciKey);
          checkinDays.push({
            date: e.check_in,
            prop_id: e.prop_id,
            feed_key: e.feed_key || '',
            guest: e.summary || e.guest_name,
            nights: e.nights,
          });
        }
      }
    });

    // Calendar lookup: date → counts (per-property aware)
    const calendar: Record<string, {
      cleaningCount: number; checkinCount: number; turnoverCount: number;
      cleaningProps: string[]; checkinProps: string[]; turnoverProps: string[];
    }> = {};
    cleaningDays.forEach(c => {
      if (!calendar[c.date]) calendar[c.date] = { cleaningCount: 0, checkinCount: 0, turnoverCount: 0, cleaningProps: [], checkinProps: [], turnoverProps: [] };
      calendar[c.date].cleaningCount++;
      calendar[c.date].cleaningProps.push(c.prop_id);
      if (c.sameDayTurnover) {
        calendar[c.date].turnoverCount++;
        calendar[c.date].turnoverProps.push(c.prop_id);
      }
    });
    checkinDays.forEach(c => {
      if (!calendar[c.date]) calendar[c.date] = { cleaningCount: 0, checkinCount: 0, turnoverCount: 0, cleaningProps: [], checkinProps: [], turnoverProps: [] };
      calendar[c.date].checkinCount++;
      calendar[c.date].checkinProps.push(c.prop_id);
    });

    const today = new Date().toISOString().slice(0, 10);
    return {
      cleanings: cleaningDays.filter(c => c.date >= today).sort((a, b) => a.date.localeCompare(b.date)),
      allCleanings: cleaningDays.sort((a, b) => a.date.localeCompare(b.date)),
      checkins: checkinDays.filter(c => c.date >= today).sort((a, b) => a.date.localeCompare(b.date)),
      calendarData: calendar,
    };
  }, [events]);

  // ── Filtering ──
  const filteredCleanings = cleanings.filter(c => propFilter === 'all' || c.prop_id === propFilter);

  // ── Week stats ──
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const endOfWeek = new Date(today);
  endOfWeek.setDate(today.getDate() + (7 - today.getDay()));
  const weekEnd = endOfWeek.toISOString().slice(0, 10);
  const cleaningsThisWeek = cleanings.filter(c => c.date >= todayStr && c.date <= weekEnd).length;

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

  // ── Cost computations ──
  const currentMonth = `${today.getFullYear()}-${pad(today.getMonth() + 1)}`;
  const hasAnyRates = Object.values(rates).some(v => v > 0);

  // Invoice totals by month
  const invoiceTotalsByMonth = useMemo(() => {
    const totals: Record<string, number> = {};
    receivedInvoices.forEach((inv: any) => {
      (inv.lineItems || []).forEach((li: any) => {
        const ym = (li.date || '').slice(0, 7);
        if (ym) totals[ym] = (totals[ym] || 0) + (li.amount || 0);
      });
    });
    return totals;
  }, [receivedInvoices]);

  const invoiceCostThisMonth = invoiceTotalsByMonth[currentMonth] || 0;
  const hasInvoicesThisMonth = invoiceCostThisMonth > 0;

  const expectedCostThisMonth = useMemo(() => {
    const remaining = cleanings.filter(c => c.date.startsWith(currentMonth));
    const breakdown: { propId: string; count: number; rate: number; cost: number }[] = [];
    const byProp: Record<string, number> = {};
    remaining.forEach(c => { byProp[c.prop_id] = (byProp[c.prop_id] || 0) + 1; });
    let total = 0;
    Object.entries(byProp).forEach(([propId, count]) => {
      const rate = rates[propId] || 0;
      const cost = count * rate;
      total += cost;
      breakdown.push({ propId, count, rate, cost });
    });
    // Use actual invoice total if available
    const displayTotal = hasInvoicesThisMonth ? invoiceCostThisMonth : total;
    return { total: displayTotal, estimatedTotal: total, invoiceTotal: invoiceCostThisMonth, breakdown, count: remaining.length, hasInvoices: hasInvoicesThisMonth };
  }, [cleanings, currentMonth, rates, hasInvoicesThisMonth, invoiceCostThisMonth]);

  const costYears = useMemo(() => {
    const years = new Set<number>();
    const thisYear = today.getFullYear();
    for (let y = thisYear - 3; y <= thisYear + 1; y++) years.add(y);
    allCleanings.forEach(c => { if (c.date) years.add(parseInt(c.date.slice(0, 4))); });
    return Array.from(years).sort((a, b) => b - a); // descending
  }, [allCleanings]);

  const costBars = useMemo((): BarData[] => {
    const currentMonthIdx = today.getMonth();
    const currentYr = today.getFullYear();
    return Array.from({ length: 12 }, (_, m) => {
      const monthKey = `${costYear}-${pad(m + 1)}`;
      // Use invoice total if available, otherwise estimate from rates
      const invoiceTotal = invoiceTotalsByMonth[monthKey] || 0;
      let cost: number;
      if (invoiceTotal > 0) {
        cost = invoiceTotal;
      } else {
        const monthCleanings = allCleanings.filter(c => c.date.startsWith(monthKey));
        cost = 0;
        monthCleanings.forEach(c => { cost += rates[c.prop_id] || 0; });
      }
      return {
        label: MONTH_NAMES_SHORT[m],
        value: cost,
        isActual: costYear < currentYr || (costYear === currentYr && m <= currentMonthIdx),
        isCurrent: costYear === currentYr && m === currentMonthIdx,
      };
    });
  }, [allCleanings, rates, costYear, invoiceTotalsByMonth]);

  const costYearTotal = useMemo(() => costBars.reduce((s, b) => s + b.value, 0), [costBars]);



  // ── Calendar grid data ──
  const { year: vYear, month: vMonth } = viewMonth;
  const weeks = useMemo(() => getMonthGrid(vYear, vMonth), [vYear, vMonth]);

  const numWeeks = weeks.length;
  const calCellW = calGridLayout.width > 0 ? (calGridLayout.width - 2 * Spacing.sm) / 7 : 0;
  const calCellH = calGridLayout.height > 0 ? calGridLayout.height / numWeeks : 0;

  // Position glass on month change or initial layout
  useEffect(() => {
    const now = new Date();
    const isCurrentMonth = now.getMonth() === vMonth && now.getFullYear() === vYear;
    const day = isCurrentMonth ? now.getDate() : 1;
    const ds = `${vYear}-${String(vMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    setSelectedDay(ds);
    calSelectedRef.current = ds;
    if (calCellW <= 0 || calCellH <= 0) return;
    const firstDow = new Date(vYear, vMonth, 1).getDay();
    const col = (firstDow + day - 1) % 7;
    const row = Math.floor((firstDow + day - 1) / 7);
    calGlassX.setValue(Spacing.sm + col * calCellW + (calCellW - 40) / 2);
    calGlassY.setValue(row * calCellH + (calCellH - 40) / 2);
  }, [vYear, vMonth, calCellW, calCellH]);

  const handleCalDayPress = useCallback((ds: string, row: number, col: number) => {
    if (calCellW <= 0 || calCellH <= 0 || calSelectedRef.current === ds) return;
    calSelectedRef.current = ds;
    setSelectedDay(ds);
    Animated.parallel([
      Animated.spring(calGlassX, { toValue: Spacing.sm + col * calCellW + (calCellW - 40) / 2, useNativeDriver: true, tension: 60, friction: 9 }),
      Animated.spring(calGlassY, { toValue: row * calCellH + (calCellH - 40) / 2, useNativeDriver: true, tension: 60, friction: 9 }),
    ]).start();
  }, [calCellW, calCellH]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.green} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View style={{ flex: 1, backgroundColor: 'transparent' }}>
      {/* ── Fixed header: Error banner + Summary Cards + SwipePills ── */}
      <View style={{ paddingHorizontal: Spacing.md, paddingTop: Spacing.md }}>
        {/* Error banner */}
        {lastError && (
          <View style={styles.errorBanner}>
            <Ionicons name="cloud-offline-outline" size={16} color={Colors.red} />
            <Text style={styles.errorText}>{lastError}</Text>
          </View>
        )}

        {/* Summary Cards */}
        <View style={styles.summaryRow}>
          <TouchableOpacity
            activeOpacity={0.7}
            style={styles.summaryCard}
            onPress={() => {
              if (tappedCard === 'cleanings') {
                setTappedCard(null);
              } else {
                setTappedCard('cleanings');
                handlePillSelect('Cleanings');
              }
            }}
          >
            <Text style={styles.summaryLabel}>CLEANINGS THIS WEEK</Text>
            <Text style={[styles.summaryNumber, { color: Colors.green }]}>{cleaningsThisWeek}</Text>
            {tappedCard === 'cleanings' && (
              <View style={styles.cardDetail}>
                {cleaningsThisWeek === 0 ? (
                  <Text style={styles.cardDetailText}>No cleanings scheduled this week</Text>
                ) : (
                  <>
                    {cleanings
                      .filter(c => c.date >= todayStr && c.date <= weekEnd)
                      .slice(0, 3)
                      .map((c, i) => {
                        const d = new Date(c.date + 'T00:00:00');
                        const dayName = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                        return (
                          <View key={i} style={styles.cardDetailRow}>
                            <Ionicons name="sparkles" size={10} color={Colors.green} />
                            <Text style={styles.cardDetailText} numberOfLines={1}>
                              {dayName} · {propLabel(c.prop_id, c.feed_key)}
                            </Text>
                          </View>
                        );
                      })}
                    {cleaningsThisWeek > 3 && (
                      <Text style={styles.cardDetailMore}>+{cleaningsThisWeek - 3} more</Text>
                    )}
                  </>
                )}
              </View>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            activeOpacity={0.7}
            style={styles.summaryCard}
            onPress={() => {
              if (tappedCard === 'cost') {
                setTappedCard(null);
              } else {
                setTappedCard('cost');
                handlePillSelect('Cost');
              }
            }}
          >
            <Text style={styles.summaryLabel}>EST. COST THIS MONTH</Text>
            <Text style={[styles.summaryNumber, { color: Colors.red }]}>
              {hasAnyRates ? fmt$(expectedCostThisMonth.total) : '--'}
            </Text>
            {tappedCard === 'cost' && (
              <View style={styles.cardDetail}>
                {!hasAnyRates ? (
                  <Text style={styles.cardDetailText}>Set rates in the Rates tab</Text>
                ) : expectedCostThisMonth.breakdown.length === 0 ? (
                  <Text style={styles.cardDetailText}>No cleanings remaining this month</Text>
                ) : (
                  <>
                    {expectedCostThisMonth.breakdown.slice(0, 3).map((b, i) => (
                      <View key={i} style={styles.cardDetailRow}>
                        <Ionicons name="cash-outline" size={10} color={Colors.red} />
                        <Text style={styles.cardDetailText} numberOfLines={1}>
                          {propLabel(b.propId)} · {b.count}x · {fmt$(b.cost)}
                        </Text>
                      </View>
                    ))}
                    {expectedCostThisMonth.breakdown.length > 3 && (
                      <Text style={styles.cardDetailMore}>
                        +{expectedCostThisMonth.breakdown.length - 3} more
                      </Text>
                    )}
                  </>
                )}
              </View>
            )}
          </TouchableOpacity>
        </View>

        {/* Sub-tab Toggle (scroll-driven) */}
        <SwipePills
          compact
          items={[
            { key: 'Calendar' as SubTab, label: 'Calendar' },
            { key: 'Cleanings' as SubTab, label: 'Cleanings' },
            { key: 'Cost' as SubTab, label: 'Cost' },
            { key: 'Rates' as SubTab, label: 'Rates' },
          ]}
          selected={subTab}
          onSelect={handlePillSelect}
          scrollOffset={scrollX}
          pageWidth={SCREEN_W}
        />
      </View>

      {/* ── Horizontal paginated scroll ── */}
      <Animated.ScrollView
        ref={horizontalRef as any}
        horizontal
        pagingEnabled
        scrollEnabled={false}
        showsHorizontalScrollIndicator={false}
        bounces={false}
        scrollEventThrottle={16}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { x: scrollX } } }],
          { useNativeDriver: false }
        )}
        onMomentumScrollEnd={onMomentumEnd}
        decelerationRate="fast"
        style={{ flex: 1 }}
      >
        {/* ═══ CALENDAR PAGE ═══ */}
        <ScrollView
          style={{ width: SCREEN_W }}
          contentContainerStyle={{ padding: Spacing.md, paddingBottom: Spacing.xl * 2 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={"#FFFFFF"} colors={["#FFFFFF"]} />}
          keyboardShouldPersistTaps="handled"
          onTouchStart={dismissAllChartTooltips}
        >
          {isReadOnly ? <LockedSubTab /> : (
            <>
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

              {/* Month Navigation */}
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
              <View style={styles.calWeekRow}>
                {WEEKDAY_HEADERS.map((d, i) => (
                  <Text key={i} style={styles.calWeekDay}>{d}</Text>
                ))}
              </View>

              {/* Property filter */}
              {props.length > 0 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterScroll}
                  contentContainerStyle={styles.filterContent}>
                  <TouchableOpacity activeOpacity={0.7}
                    style={[styles.filterChip, propFilter === 'all' && styles.filterChipActive]}
                    onPress={() => setPropFilter('all')}
                  >
                    <Text style={[styles.filterChipText, propFilter === 'all' && styles.filterChipTextActive]}>All</Text>
                  </TouchableOpacity>
                  {props.map((p: any) => {
                    const id = p.id || p.prop_id;
                    return (
                      <TouchableOpacity activeOpacity={0.7}
                        key={id}
                        style={[styles.filterChip, propFilter === id && styles.filterChipActive]}
                        onPress={() => setPropFilter(id)}
                      >
                        <Text style={[styles.filterChipText, propFilter === id && styles.filterChipTextActive]}>
                          {p.label || p.id}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              )}

              {/* Calendar Grid — liquid glass */}
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
                {weeks.map((week, wi) => (
                  <View key={wi} style={styles.calWeekRow}>
                    {week.map((day, di) => {
                      if (day === null) return <View key={di} style={styles.calDayCell} />;

                      const ds = dateStr(vYear, vMonth, day);
                      const isToday = ds === todayStr;
                      const isSelected = selectedDay === ds;
                      const data = calendarData[ds];

                      // Apply property filter
                      let cleaningCount = 0;
                      let turnoverCount = 0;
                      let checkinCount = 0;
                      if (data) {
                        if (propFilter === 'all') {
                          cleaningCount = data.cleaningCount;
                          turnoverCount = data.turnoverCount;
                          checkinCount = data.checkinCount;
                        } else {
                          cleaningCount = data.cleaningProps.filter(p => p === propFilter).length;
                          turnoverCount = data.turnoverProps.filter(p => p === propFilter).length;
                          checkinCount = data.checkinProps.filter(p => p === propFilter).length;
                        }
                      }
                      const hasCleaning = cleaningCount > 0;
                      const hasTurnover = turnoverCount > 0;
                      const hasCheckin = checkinCount > 0;

                      return (
                        <TouchableOpacity
                          activeOpacity={0.7}
                          key={di}
                          style={styles.calDayCell}
                          onPress={() => handleCalDayPress(ds, wi, di)}
                        >
                          <View style={[
                            styles.calDayBubble,
                            !isSelected && isToday && styles.calDayBubbleToday,
                            !isSelected && hasTurnover && styles.calDayBubbleTurnover,
                            !isSelected && hasCleaning && !hasTurnover && styles.calDayBubbleCleaning,
                            !isSelected && hasCheckin && !hasCleaning && !hasTurnover && styles.calDayBubbleCheckin,
                          ]}>
                            <Text style={[
                              styles.calDayText,
                              isToday && styles.calDayTextToday,
                              hasTurnover && styles.calDayTextTurnover,
                              hasCleaning && !hasTurnover && styles.calDayTextCleaning,
                              hasCheckin && !hasCleaning && !hasTurnover && styles.calDayTextCheckin,
                              isSelected && styles.calDayTextSelected,
                            ]}>{day}</Text>
                            {(hasCleaning || hasTurnover) && <View style={styles.calDotCleaning} />}
                            {hasCheckin && !hasCleaning && !hasTurnover && <View style={styles.calDotCheckin} />}
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                ))}
              </View>

              {/* Legend */}
              <View style={styles.calLegendRow}>
                <View style={styles.calLegendItem}>
                  <View style={[styles.calLegendSwatch, { backgroundColor: 'rgba(245,158,11,0.15)', borderColor: 'rgba(245,158,11,0.30)' }]} />
                  <Text style={styles.calLegendText}>Cleaning</Text>
                </View>
                <View style={styles.calLegendItem}>
                  <View style={[styles.calLegendSwatch, { backgroundColor: 'rgba(239,68,68,0.15)', borderColor: 'rgba(239,68,68,0.30)' }]} />
                  <Text style={styles.calLegendText}>Turnover</Text>
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

              {/* Selected Day Detail */}
              {selectedDay && (() => {
                const dayDate = new Date(selectedDay + 'T12:00:00');
                const dayLbl = dayDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
                const dayCleanings = allCleanings.filter(c => c.date === selectedDay && (propFilter === 'all' || c.prop_id === propFilter));
                const dayCheckins = checkins.filter(c => c.date === selectedDay && (propFilter === 'all' || c.prop_id === propFilter));
                // Also include historical checkins
                const allCheckinDays = events
                  .filter((e: any) => e.check_in === selectedDay && e.prop_id && (propFilter === 'all' || e.prop_id === propFilter))
                  .map((e: any) => ({ prop_id: e.prop_id, guest: e.summary || e.guest_name, nights: e.nights }));
                const uniqueCheckins = allCheckinDays.filter((c, i, arr) =>
                  arr.findIndex(x => x.prop_id === c.prop_id && x.guest === c.guest) === i
                );
                const hasNothing = dayCleanings.length === 0 && uniqueCheckins.length === 0;

                return (
                  <View style={styles.calDetail}>
                    <Text style={styles.calDetailTitle}>{dayLbl}</Text>
                    {hasNothing ? (
                      <Text style={styles.calDetailEmpty}>No cleanings or check-ins scheduled</Text>
                    ) : (
                      <>
                        {dayCleanings.map((c, i) => (
                          <View key={`c-${i}`} style={styles.dayDetailRow}>
                            <View style={[styles.dayDetailDot, { backgroundColor: c.sameDayTurnover ? Colors.red : Colors.yellow }]} />
                            <View style={{ flex: 1 }}>
                              <Text style={styles.dayDetailRowTitle}>
                                {c.sameDayTurnover ? 'Turnover' : 'Cleaning'} · {propLabel(c.prop_id, c.feed_key)}
                              </Text>
                              {c.outGuest && c.outGuest !== 'Reserved' && <Text style={styles.dayDetailRowSub}>Checkout: {c.outGuest}</Text>}
                              {c.inGuest && c.inGuest !== 'Reserved' && <Text style={styles.dayDetailRowSub}>Next guest: {c.inGuest}</Text>}
                              {c.sameDayTurnover && <Text style={[styles.dayDetailRowSub, { color: Colors.red }]}>Same-day turnover</Text>}
                            </View>
                          </View>
                        ))}
                        {uniqueCheckins
                          .filter(c => !dayCleanings.some(cl => cl.prop_id === c.prop_id && cl.sameDayTurnover))
                          .map((c, i) => (
                            <View key={`ci-${i}`} style={styles.dayDetailRow}>
                              <View style={[styles.dayDetailDot, { backgroundColor: Colors.green }]} />
                              <View style={{ flex: 1 }}>
                                <Text style={styles.dayDetailRowTitle}>Check-in · {propLabel(c.prop_id, c.feed_key)}</Text>
                                {c.guest && c.guest !== 'Reserved' && <Text style={styles.dayDetailRowSub}>{c.guest}</Text>}
                                {c.nights > 0 && <Text style={styles.dayDetailRowSub}>{c.nights} night{c.nights !== 1 ? 's' : ''}</Text>}
                              </View>
                            </View>
                          ))}
                      </>
                    )}
                  </View>
                );
              })()}



            </>
          )}
        </ScrollView>

        {/* ═══ CLEANINGS PAGE ═══ */}
        <ScrollView
          style={{ width: SCREEN_W }}
          contentContainerStyle={{ padding: Spacing.md, paddingBottom: Spacing.xl * 2 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={"#FFFFFF"} colors={["#FFFFFF"]} />}
        >
          {isReadOnly ? <LockedSubTab /> : (
            <>
              {/* Property filter */}
              {props.length > 0 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterScroll}
                  contentContainerStyle={styles.filterContent}>
                  <TouchableOpacity activeOpacity={0.7}
                    style={[styles.filterChip, propFilter === 'all' && styles.filterChipActive]}
                    onPress={() => setPropFilter('all')}
                  >
                    <Text style={[styles.filterChipText, propFilter === 'all' && styles.filterChipTextActive]}>All</Text>
                  </TouchableOpacity>
                  {props.map((p: any) => {
                    const id = p.id || p.prop_id;
                    return (
                      <TouchableOpacity activeOpacity={0.7}
                        key={id}
                        style={[styles.filterChip, propFilter === id && styles.filterChipActive]}
                        onPress={() => setPropFilter(id)}
                      >
                        <Text style={[styles.filterChipText, propFilter === id && styles.filterChipTextActive]}>
                          {p.label || p.id}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              )}

              {/* Last Updated + Refresh */}
              <View style={styles.metaRow}>
                <Text style={styles.metaText}>
                  {lastUpdated
                    ? `Updated ${lastUpdated.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
                    : ''}
                </Text>
                <TouchableOpacity activeOpacity={0.7}
                  style={styles.refreshBtn} onPress={onRefresh} disabled={refreshing}>
                  <Ionicons name="refresh" size={14} color={Colors.primary} />
                  <Text style={styles.refreshBtnText}>{refreshing ? 'Refreshing...' : 'Refresh'}</Text>
                </TouchableOpacity>
              </View>

              {filteredCleanings.length === 0 ? (
                <EmptyState message="No upcoming cleanings" sub="Cleanings appear based on check-out dates from your bookings" />
              ) : (
                filteredCleanings.map((c, i) => {
                  const dateObj = new Date(c.date + 'T00:00:00');
                  const isToday = c.date === todayStr;
                  const dayLabel = dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
                  return (
                    <View key={i} style={styles.cleaningCard}>
                      <View style={styles.cleaningDateBar}>
                        <Text style={styles.cleaningDateText}>{dayLabel}</Text>
                        {isToday && <View style={styles.todayDot} />}
                      </View>
                      <View style={styles.cleaningBody}>
                        <View style={styles.cleaningBadgeRow}>
                          <View style={[styles.cleaningBadge, isToday ? styles.cleaningBadgeUrgent : styles.cleaningBadgeNeeded]}>
                            <Ionicons name={isToday ? 'alert-circle' : 'sparkles'} size={12}
                              color={isToday ? Colors.red : Colors.yellow} />
                            <Text style={[styles.cleaningBadgeText, { color: isToday ? Colors.red : Colors.yellow }]}>
                              {isToday ? 'CLEANING TODAY' : 'CLEANING NEEDED'}
                            </Text>
                          </View>
                          {c.sameDayTurnover && (
                            <View style={styles.turnoverBadge}>
                              <Ionicons name="warning" size={11} color={Colors.yellow} />
                              <Text style={styles.turnoverText}>Same-Day Turnover</Text>
                            </View>
                          )}
                        </View>
                        <Text style={styles.cleaningProp}>{propLabel(c.prop_id, c.feed_key)}</Text>
                        {c.prevNights > 0 && (
                          <Text style={styles.cleaningMeta}>Previous stay: {c.prevNights} night{c.prevNights !== 1 ? 's' : ''}</Text>
                        )}
                        {c.outGuest && (
                          <View style={styles.guestRow}>
                            <Ionicons name="log-out-outline" size={14} color={Colors.textDim} />
                            <Text style={styles.guestText}>Checkout: {c.outGuest}</Text>
                          </View>
                        )}
                        {c.inGuest && (
                          <View style={styles.guestRow}>
                            <Ionicons name="log-in-outline" size={14} color={Colors.green} />
                            <Text style={styles.guestText}>Next guest: {c.inGuest}</Text>
                          </View>
                        )}
                      </View>
                    </View>
                  );
                })
              )}
            </>
          )}
        </ScrollView>

        {/* ═══ COST PAGE ═══ */}
        <ScrollView
          style={{ width: SCREEN_W }}
          contentContainerStyle={{ padding: Spacing.md, paddingBottom: Spacing.xl * 2 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={"#FFFFFF"} colors={["#FFFFFF"]} />}
          onTouchStart={dismissAllChartTooltips}
        >
          {isReadOnly ? <LockedSubTab /> : (
            <>
              <Card>
                <Text style={styles.costSectionLabel}>
                  {expectedCostThisMonth.hasInvoices ? 'ACTUAL COST THIS MONTH' : 'EXPECTED COST THIS MONTH'}
                </Text>
                {!hasAnyRates && !expectedCostThisMonth.hasInvoices ? (
                  <View>
                    <Text style={styles.costTotal}>{fmt$(0)}</Text>
                    <TouchableOpacity activeOpacity={0.7} onPress={() => handlePillSelect('Rates')}>
                      <Text style={styles.costHint}>Set per-property rates in the Rates tab</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <View>
                    <Text style={styles.costTotal}>{fmt$(expectedCostThisMonth.total)}</Text>
                    {expectedCostThisMonth.hasInvoices && (
                      <Text style={{ fontSize: FontSize.xs, color: Colors.green, fontWeight: '600', marginBottom: 2 }}>
                        From cleaner invoices
                      </Text>
                    )}
                    {!expectedCostThisMonth.hasInvoices && (
                      <Text style={styles.costCount}>
                        {expectedCostThisMonth.count} cleaning{expectedCostThisMonth.count !== 1 ? 's' : ''} remaining
                      </Text>
                    )}
                    {!expectedCostThisMonth.hasInvoices && expectedCostThisMonth.breakdown.map((b, i) => (
                      <View key={i} style={styles.costBreakdownRow}>
                        <Text style={styles.costBreakdownLabel} numberOfLines={1}>{propLabel(b.propId)}</Text>
                        <Text style={styles.costBreakdownValue}>{b.count} × {fmt$(b.rate)} = {fmt$(b.cost)}</Text>
                      </View>
                    ))}
                    {expectedCostThisMonth.hasInvoices && hasAnyRates && expectedCostThisMonth.estimatedTotal > 0 && (
                      <Text style={{ fontSize: FontSize.xs, color: Colors.textDim, marginTop: Spacing.xs }}>
                        Rate-based estimate: {fmt$(expectedCostThisMonth.estimatedTotal)}
                      </Text>
                    )}
                  </View>
                )}
              </Card>

              <Card style={{ overflow: 'visible' }}>
                <View style={styles.costChartHeader}>
                  <Text style={styles.costSectionLabel}>MONTHLY CLEANING COST</Text>
                  <View style={{ position: 'relative' }}>
                    <TouchableOpacity
                      activeOpacity={0.7}
                      style={styles.yearPill}
                      onPress={() => setShowYearPicker(!showYearPicker)}
                    >
                      <Text style={styles.yearPillTextActive}>{costYear}</Text>
                      <Ionicons name="chevron-down" size={12} color={Colors.text} style={{ marginLeft: 3 }} />
                    </TouchableOpacity>
                    {showYearPicker && (
                      <View style={styles.yearDropdown}>
                        {costYears.map(yr => (
                          <TouchableOpacity
                            activeOpacity={0.7}
                            key={yr}
                            style={[styles.yearDropdownItem, costYear === yr && styles.yearDropdownItemActive]}
                            onPress={() => { setCostYear(yr); setShowYearPicker(false); }}
                          >
                            <Text style={[styles.yearDropdownText, costYear === yr && styles.yearDropdownTextActive]}>
                              {yr}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    )}
                  </View>
                </View>
                <BarChart bars={costBars} color={Colors.red} height={120} invertDelta />
                <Text style={styles.costYearTotal}>{costYear} Total: {fmt$(costYearTotal)}</Text>
              </Card>
            </>
          )}
        </ScrollView>

        {/* ═══ RATES PAGE ═══ */}
        <ScrollView
          style={{ width: SCREEN_W }}
          contentContainerStyle={{ padding: Spacing.md, paddingBottom: Spacing.xl * 2 }}
          keyboardShouldPersistTaps="handled"
        >
          {isReadOnly ? <LockedSubTab /> : (
            <>
              <Card>
                <View style={styles.ratesHeaderRow}>
                  <Ionicons name="pricetag-outline" size={18} color={Colors.primary} />
                  <View style={{ flex: 1, marginLeft: Spacing.sm }}>
                    <Text style={styles.ratesHeaderTitle}>Cleaning Rates</Text>
                    <Text style={styles.ratesHeaderSub}>
                      Set a per-cleaning cost for each property. Used to estimate monthly costs.
                    </Text>
                  </View>
                </View>
              </Card>

              {props.length === 0 ? (
                <EmptyState message="No properties" sub="Add properties in Settings to set cleaning rates" />
              ) : (
                props.map((p: any) => {
                  const id = p.id || p.prop_id;
                  return (
                    <View key={id} style={styles.rateRow}>
                      <Text style={styles.rateLabel} numberOfLines={1}>{p.label || p.id}</Text>
                      <View style={styles.rateInputWrap}>
                        <Text style={styles.rateDollar}>$</Text>
                        <TextInput
                          style={styles.rateInput}
                          keyboardType="numeric"
                          placeholder="0"
                          placeholderTextColor={Colors.textDim}
                          defaultValue={rates[id] ? String(rates[id]) : ''}
                          onEndEditing={(e) => {
                            const val = parseFloat(e.nativeEvent.text) || 0;
                            saveRate(id, val);
                          }}
                          onSubmitEditing={() => Keyboard.dismiss()}
                          returnKeyType="done"
                        />
                      </View>
                    </View>
                  );
                })
              )}
            </>
          )}
        </ScrollView>
      </Animated.ScrollView>

      {/* ═══ FOLLOW CODE MODAL (outside horizontal scroll) ═══ */}
      <Modal visible={showFollowCodeModal} transparent animationType="fade">
        <View style={styles.followOverlay}>
          <View style={styles.followCard}>
            <View style={styles.followIconCircle}>
              <Ionicons name="people-outline" size={28} color={Colors.primary} />
            </View>
            <Text style={styles.followTitle}>Your Cleaner Code</Text>
            <TouchableOpacity activeOpacity={0.7} style={styles.followCodePill} onPress={copyCode}>
              <Text style={styles.followCodeText}>{followCode}</Text>
              <Ionicons name={codeCopied ? 'checkmark' : 'copy-outline'} size={16} color={Colors.primary} />
            </TouchableOpacity>
            <Text style={styles.followDesc}>
              Share this code with your cleaners so they can follow your properties and see the cleaning schedule.
            </Text>
            <Text style={styles.followFooter}>You can always find this in Settings.</Text>
            <TouchableOpacity activeOpacity={0.7} style={styles.followDismissBtn} onPress={dismissFollowCode}>
              <Text style={styles.followDismissBtnText}>Got it</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
    </KeyboardAvoidingView>
  );
}

const EMPTY_EVENTS: any[] = [];

/** Returns the count of cleanings today/upcoming for badge display */
export function useCleaningsBadgeCount(): number {
  const events = useDataStore(s => s.icalEvents?.data || EMPTY_EVENTS);
  return useMemo(() => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const seen = new Set<string>();
    let count = 0;
    events.forEach((e: any) => {
      if (!e.check_out || !e.prop_id) return;
      const key = `${e.prop_id}-${e.check_out}`;
      if (!seen.has(key) && e.check_out === todayStr) {
        seen.add(key);
        count++;
      }
    });
    return count;
  }, [events]);
}

// ══════════════════════════════════════
// ── Styles ──
// ══════════════════════════════════════

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  content: { padding: Spacing.md, paddingBottom: Spacing.xl * 2 },
  center: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },
  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: 'rgba(239,68,68,0.08)', borderRadius: Radius.md,
    padding: Spacing.sm, marginBottom: Spacing.md, borderWidth: 0.5, borderColor: 'rgba(239,68,68,0.20)',
  },
  errorText: { fontSize: FontSize.xs, color: Colors.red, flex: 1, lineHeight: 16 },

  // Summary Cards
  summaryRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.md },
  summaryCard: {
    flex: 1, backgroundColor: Colors.glassHeavy, borderRadius: Radius.xl,
    padding: Spacing.md, borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 20 },
      android: { elevation: 2 },
    }),
  },
  summaryLabel: {
    fontSize: FontSize.xs - 1, fontWeight: '700', color: Colors.textDim,
    letterSpacing: 0.5, marginBottom: 4,
  },
  summaryNumber: { fontSize: 28, fontWeight: '800' },

  // Filter chips
  filterScroll: { marginBottom: Spacing.sm },
  filterContent: { gap: 6 },
  filterChip: {
    paddingHorizontal: 14, paddingVertical: 7,
    borderRadius: Radius.pill, backgroundColor: Colors.glassDark,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    overflow: 'hidden',
  },
  filterChipActive: {
    backgroundColor: Colors.glass,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.45, shadowRadius: 8 },
    }),
  },
  filterChipText: { fontSize: FontSize.xs, color: Colors.textDim, fontWeight: '500' },
  filterChipTextActive: { color: Colors.text, fontWeight: '600' },

  // Meta row
  metaRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: Spacing.md,
  },
  metaText: { fontSize: FontSize.xs, color: Colors.textDim },
  refreshBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: Radius.pill, backgroundColor: Colors.primaryDim,
  },
  refreshBtnText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.primary },

  // ── Occupancy ──
  occCompactRow: {
    flexDirection: 'row', gap: Spacing.sm, paddingHorizontal: Spacing.md, paddingTop: Spacing.sm, paddingBottom: Spacing.xs,
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
  occCompare: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  occMarketLabel: { fontSize: FontSize.xs, color: Colors.textDim },
  occDelta: { fontSize: FontSize.xs, fontWeight: '600' },

  // Per-property occupancy
  propOccRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  propOccInfo: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  propOccName: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  propOccPct: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text },
  airbnbBadge: { backgroundColor: Colors.primaryDim, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  airbnbText: { fontSize: 9, fontWeight: '600', color: Colors.primary },
  propOccBarTrack: { height: 8, backgroundColor: Colors.border, borderRadius: 4, overflow: 'hidden', position: 'relative', marginBottom: 4 },
  propOccMarker: { position: 'absolute', top: -2, width: 2, height: 12, backgroundColor: Colors.textDim },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border, marginVertical: Spacing.sm },
  occLegend: { flexDirection: 'row', gap: Spacing.lg, marginTop: Spacing.md, paddingTop: Spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderColor: Colors.border },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendLine: { width: 12, height: 2, backgroundColor: Colors.textDim },
  legendText: { fontSize: FontSize.xs, color: Colors.textSecondary },

  // ── Calendar — liquid glass ──
  calHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingTop: Spacing.md, paddingBottom: Spacing.sm,
  },
  calHeaderTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
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
  calDayBubbleTurnover: {
    backgroundColor: 'rgba(239,68,68,0.15)',
    borderWidth: 1.5, borderColor: 'rgba(239,68,68,0.25)',
    ...Platform.select({
      ios: { shadowColor: 'rgba(239,68,68,0.35)', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 1, shadowRadius: 8 },
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
  calDayTextTurnover: { color: Colors.red, fontWeight: '600' },
  calDayTextCleaning: { color: Colors.yellow, fontWeight: '600' },
  calDayTextSelected: { fontWeight: '800' as const },
  calDotCheckin: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: Colors.green, marginTop: 2 },
  calDotCleaning: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: Colors.yellow, marginTop: 2 },
  calLegendRow: {
    flexDirection: 'row', justifyContent: 'center', gap: Spacing.lg,
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md,
  },
  calLegendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  calLegendSwatch: { width: 14, height: 14, borderRadius: 6, borderWidth: 1.5 },
  calLegendText: { fontSize: FontSize.xs, color: Colors.textDim },
  calDetail: { padding: Spacing.md },
  calDetailTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginBottom: Spacing.sm },
  calDetailEmpty: { fontSize: FontSize.sm, color: Colors.textDim, textAlign: 'center', paddingVertical: Spacing.lg },

  // ── Cleaning Cards ──
  cleaningCard: {
    backgroundColor: Colors.glassHeavy, borderRadius: Radius.xl,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    marginBottom: Spacing.sm, overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 20 },
      android: { elevation: 2 },
    }),
  },
  cleaningDateBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    backgroundColor: Colors.glassDark,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: Colors.glassBorder,
  },
  cleaningDateText: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text },
  todayDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: Colors.primary },
  cleaningBody: { padding: Spacing.md },
  cleaningBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 },
  cleaningBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.sm,
    alignSelf: 'flex-start',
  },
  cleaningBadgeUrgent: { backgroundColor: Colors.redDim },
  cleaningBadgeNeeded: { backgroundColor: Colors.yellowDim },
  cleaningBadgeText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.3 },
  cleaningProp: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginBottom: 2 },
  cleaningMeta: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 1 },
  turnoverBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: Colors.yellowDim, borderRadius: Radius.sm,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  turnoverText: { fontSize: 9, fontWeight: '600', color: Colors.yellow },
  guestRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  guestText: { fontSize: FontSize.xs, color: Colors.textSecondary },

  // ── Card detail (tap-to-expand on summary cards) ──
  cardDetail: { marginTop: Spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderColor: Colors.glassBorder, paddingTop: Spacing.sm },
  cardDetailRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 4 },
  cardDetailText: { fontSize: FontSize.xs, color: Colors.textSecondary, flex: 1 },
  cardDetailMore: { fontSize: FontSize.xs, color: Colors.textDim, fontStyle: 'italic', marginTop: 2 },

  // ── Day detail rows ──
  dayDetailRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: Spacing.sm },
  dayDetailDot: { width: 8, height: 8, borderRadius: 4, marginTop: 3 },
  dayDetailRowTitle: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  dayDetailRowSub: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 1 },

  // ── Cost Tab ──
  costSectionLabel: {
    fontSize: FontSize.xs - 1, fontWeight: '700', color: Colors.textDim,
    letterSpacing: 0.5, marginBottom: Spacing.xs,
  },
  costTotal: { fontSize: FontSize.xxl, fontWeight: '800', color: Colors.red, marginBottom: 2 },
  costCount: { fontSize: FontSize.xs, color: Colors.textSecondary, marginBottom: Spacing.sm },
  costHint: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '600', marginTop: Spacing.xs },
  costBreakdownRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 5, borderTopWidth: StyleSheet.hairlineWidth, borderColor: Colors.glassBorder,
  },
  costBreakdownLabel: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '500', flex: 1, marginRight: Spacing.sm },
  costBreakdownValue: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  costChartHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: Spacing.xs,
  },
  yearPill: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 5, borderRadius: Radius.pill,
    backgroundColor: Colors.glass, borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 6 },
    }),
  },
  yearPillTextActive: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '600' },
  yearDropdown: {
    position: 'absolute', top: '100%', right: 0, marginTop: 4,
    minWidth: 80,
    backgroundColor: Colors.glassOverlay, borderRadius: Radius.md,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    overflow: 'hidden', zIndex: 100,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.4, shadowRadius: 16 },
      android: { elevation: 8 },
    }),
  },
  yearDropdownItem: {
    paddingHorizontal: 14, paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: Colors.glassBorder,
  },
  yearDropdownItemActive: { backgroundColor: Colors.primaryDim },
  yearDropdownText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '500', textAlign: 'center' },
  yearDropdownTextActive: { color: Colors.primary, fontWeight: '700' },
  costYearTotal: {
    fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600',
    textAlign: 'center', marginTop: Spacing.sm,
  },

  // ── Rates Tab ──
  ratesHeaderRow: { flexDirection: 'row', alignItems: 'flex-start' },
  ratesHeaderTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginBottom: 2 },
  ratesHeaderSub: { fontSize: FontSize.xs, color: Colors.textSecondary, lineHeight: 16 },
  rateRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.glassHeavy, borderRadius: Radius.xl,
    padding: Spacing.md, marginBottom: Spacing.sm,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 12 },
      android: { elevation: 2 },
    }),
  },
  rateLabel: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, flex: 1, marginRight: Spacing.sm },
  rateInputWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.glassDark, borderRadius: Radius.sm,
    paddingHorizontal: Spacing.sm, paddingVertical: 6,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    minWidth: 80,
  },
  rateDollar: { fontSize: FontSize.md, fontWeight: '600', color: Colors.textDim, marginRight: 2 },
  rateInput: {
    fontSize: FontSize.md, fontWeight: '600', color: Colors.text,
    flex: 1, padding: 0, minWidth: 50,
  },

  // Follow Code Modal
  followOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center', justifyContent: 'center', padding: Spacing.lg,
  },
  followCard: {
    backgroundColor: Colors.glassOverlay, borderRadius: Radius.xl,
    padding: Spacing.xl, alignItems: 'center', width: '100%', maxWidth: 340,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.5, shadowRadius: 30 },
      android: { elevation: 10 },
    }),
  },
  followIconCircle: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: Colors.primaryDim, alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  followTitle: {
    fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginBottom: Spacing.md,
  },
  followCodePill: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.primaryDim, borderRadius: Radius.pill,
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm + 2,
    marginBottom: Spacing.md,
  },
  followCodeText: {
    fontSize: FontSize.xl, fontWeight: '800', color: Colors.primary, letterSpacing: 1,
  },
  followDesc: {
    fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center',
    lineHeight: 20, marginBottom: Spacing.sm,
  },
  followFooter: {
    fontSize: FontSize.xs, color: Colors.textDim, textAlign: 'center',
    marginBottom: Spacing.lg,
  },
  followDismissBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.lg,
    paddingHorizontal: Spacing.xl * 2, paddingVertical: Spacing.sm + 2,
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 12 },
    }),
  },
  followDismissBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: '600' },

  // Locked panel
  lockedPanel: {
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: Spacing.xl * 2, paddingHorizontal: Spacing.lg,
  },
  lockedCircle: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: Colors.glassDark, borderWidth: 0.5, borderColor: Colors.glassBorder,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  lockedTitle: {
    fontSize: FontSize.lg, fontWeight: '700', color: Colors.text,
    marginBottom: Spacing.xs,
  },
  lockedDesc: {
    fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center',
    lineHeight: 20, marginBottom: Spacing.lg,
  },
  lockedBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: Colors.primary, borderRadius: Radius.lg,
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm + 2,
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 12 },
    }),
  },
  lockedBtnText: { color: '#fff', fontSize: FontSize.sm, fontWeight: '600' },
  restoreLink: { marginTop: 8, padding: 8 },
  restoreLinkText: { fontSize: 12, color: Colors.primary, fontWeight: '500' },
});

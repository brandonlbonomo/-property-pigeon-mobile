import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
  TouchableOpacity, ActivityIndicator, Platform, Dimensions,
  Animated, PanResponder, PanResponderGestureState,
  NativeSyntheticEvent, NativeScrollEvent,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as SecureStore from 'expo-secure-store';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useUserStore } from '../../store/userStore';
import { useCleanerStore, CleanerEvent } from '../../store/cleanerStore';
import { useDataStore } from '../../store/dataStore';
import { useSubscriptionGate } from '../../hooks/useSubscriptionGate';
import { useProCheckout } from '../../hooks/useProCheckout';
import type { PaywallResult } from '../../hooks/useProCheckout';
import { Card } from '../../components/Card';
import { SwipePills } from '../../components/SwipePills';
import { BarChart, BarData, dismissAllChartTooltips } from '../../components/BarChart';
import { MonthDetailModal } from '../../components/MonthDetailModal';
import { PlaidLinkModal } from '../../components/PlaidLink';
import { apiFetch } from '../../services/api';
import { fmt$, fmtCompact } from '../../utils/format';


const RATES_KEY = 'pp_cleaning_rates';
const { width: SCREEN_W } = Dimensions.get('window');
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── YearTabs (swipeable year selector inside cards) ──

const YEAR_PILL_W = 42;
const YEAR_PILL_GAP = 2;
const YEAR_PILL_STEP = YEAR_PILL_W + YEAR_PILL_GAP;
const YEAR_CONTAINER_W = SCREEN_W - Spacing.md * 4 - 1 + 8;
const YEAR_SIDE_PAD = (YEAR_CONTAINER_W - YEAR_PILL_W) / 2;

function YearTabs({ years, selected, onSelect }: { years: number[]; selected: number; onSelect: (y: number) => void }) {
  const selectedIdx = years.indexOf(selected);
  const animIdx = useRef(new Animated.Value(selectedIdx >= 0 ? selectedIdx : 0)).current;

  const yearsRef = useRef(years);
  yearsRef.current = years;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const idx = years.indexOf(selected);
    if (idx >= 0) {
      Animated.spring(animIdx, {
        toValue: idx,
        useNativeDriver: true,
        tension: 14,
        friction: 5,
      }).start();
    }
  }, [selected, years]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dx) > 10 && Math.abs(gs.dx) > Math.abs(gs.dy),
        onPanResponderRelease: (_, gs: PanResponderGestureState) => {
          if (Math.abs(gs.dx) < 25) return;
          const yrs = yearsRef.current;
          const sel = selectedRef.current;
          const idx = yrs.indexOf(sel);
          if (idx < 0) return;
          if (gs.dx < -25 && idx < yrs.length - 1) {
            onSelectRef.current(yrs[idx + 1]);
          } else if (gs.dx > 25 && idx > 0) {
            onSelectRef.current(yrs[idx - 1]);
          }
        },
      }),
    []
  );

  const translateX = animIdx.interpolate({
    inputRange: years.map((_, i) => i),
    outputRange: years.map((_, i) => -i * YEAR_PILL_STEP),
    extrapolate: 'clamp',
  });

  return (
    <View style={yearStyles.container} {...panResponder.panHandlers}>
      <Animated.View
        style={[
          yearStyles.row,
          { paddingLeft: YEAR_SIDE_PAD, paddingRight: YEAR_SIDE_PAD, transform: [{ translateX }] },
        ]}
      >
        {years.map((y, i) => {
          const scale = animIdx.interpolate({
            inputRange: [i - 1, i, i + 1],
            outputRange: [0.8, 1.15, 0.8],
            extrapolate: 'clamp',
          });
          const opacity = animIdx.interpolate({
            inputRange: [i - 1, i, i + 1],
            outputRange: [0.35, 1, 0.35],
            extrapolate: 'clamp',
          });
          const glassOpacity = animIdx.interpolate({
            inputRange: [i - 0.5, i, i + 0.5],
            outputRange: [0, 1, 0],
            extrapolate: 'clamp',
          });

          return (
            <TouchableOpacity activeOpacity={0.7}
              key={y}
              onPress={() => onSelect(y)}
              style={yearStyles.pillTouch}
            >
              <Animated.View style={[yearStyles.pill, { transform: [{ scale }], opacity }]}>
                <Animated.View style={[yearStyles.glass, { opacity: glassOpacity }]} />
                <Text style={yearStyles.label}>{y}</Text>
              </Animated.View>
            </TouchableOpacity>
          );
        })}
      </Animated.View>
    </View>
  );
}

const yearStyles = StyleSheet.create({
  container: {
    height: 28,
    overflow: 'hidden',
    marginBottom: Spacing.xs,
    marginHorizontal: -4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 28,
    gap: YEAR_PILL_GAP,
  },
  pillTouch: {
    width: YEAR_PILL_W,
  },
  pill: {
    width: YEAR_PILL_W,
    height: 22,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 1,
    overflow: 'hidden',
  },
  glass: {
    ...StyleSheet.absoluteFillObject,
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
        shadowRadius: 10,
      },
      android: { elevation: 4 },
    }),
  },
  label: {
    fontSize: 10,
    fontWeight: '600',
    color: Colors.text,
    zIndex: 1,
  },
});

type Tab = 'Revenue' | 'Projections';
const TABS: Tab[] = ['Revenue', 'Projections'];

// ── Revenue Sub-tab ──

function RevenueTab({
  allEvents, rates, refreshing, onRefresh, plaidTransactions, isPlaidConnected,
  onPlaidConnected,
}: {
  allEvents: CleanerEvent[];
  rates: Record<string, number>;
  refreshing: boolean;
  onRefresh: () => void;
  plaidTransactions: any[];
  isPlaidConnected: boolean;
  onPlaidConnected: () => void;
}) {
  const currentYear = new Date().getFullYear();
  const now = new Date();
  const years = useMemo(() => {
    const yrs: number[] = [];
    for (let y = currentYear - 3; y <= currentYear; y++) yrs.push(y);
    return yrs;
  }, [currentYear]);

  // Per-card year selection
  const [revYear, setRevYear] = useState(currentYear);
  const [qtrYear, setQtrYear] = useState(currentYear);
  const [avgRateYear, setAvgRateYear] = useState(currentYear);
  const [cleaningsYear, setCleaningsYear] = useState(currentYear);
  const [drillDownMonth, setDrillDownMonth] = useState<string | null>(null);

  // Plaid Link state
  const [plaidLinkVisible, setPlaidLinkVisible] = useState(false);
  const [plaidLinkToken, setPlaidLinkToken] = useState('');

  // This month revenue
  const thisMonth = now.toISOString().slice(0, 7);
  const monthRevenue = useMemo(() => {
    return allEvents
      .filter(e => (e.check_out || '').slice(0, 7) === thisMonth)
      .reduce((sum, e) => sum + (rates[e.prop_id] || 0), 0);
  }, [allEvents, thisMonth, rates]);

  // Plaid expenses this month
  const monthExpenses = useMemo(() => {
    return plaidTransactions
      .filter(t => (t.date || '').slice(0, 7) === thisMonth && (t.amount ?? 0) < 0)
      .reduce((sum, t) => sum + Math.abs(t.amount ?? 0), 0);
  }, [plaidTransactions, thisMonth]);

  // Net margin
  const netMargin = monthRevenue - monthExpenses;
  const marginPct = monthRevenue > 0 ? (netMargin / monthRevenue) * 100 : 0;

  // Monthly revenue bars for selected year
  const monthlyBars: BarData[] = useMemo(() => {
    return MONTH_LABELS.map((label, i) => {
      const ym = `${revYear}-${String(i + 1).padStart(2, '0')}`;
      const rev = allEvents
        .filter(e => (e.check_out || '').slice(0, 7) === ym)
        .reduce((sum, e) => sum + (rates[e.prop_id] || 0), 0);
      const isCurrentMonth = ym === thisMonth;
      const monthDate = new Date(revYear, i + 1, 0);
      const isFuture = monthDate > now && !isCurrentMonth;
      const priorIdx = i - 1;
      let priorValue: number | undefined;
      let priorLabel: string | undefined;
      if (priorIdx >= 0) {
        const priorYm = `${revYear}-${String(priorIdx + 1).padStart(2, '0')}`;
        priorValue = allEvents
          .filter(e => (e.check_out || '').slice(0, 7) === priorYm)
          .reduce((sum, e) => sum + (rates[e.prop_id] || 0), 0);
        priorLabel = MONTH_LABELS[priorIdx];
      }
      return { label, value: rev, isActual: !isFuture, isCurrent: isCurrentMonth, month: ym, priorValue, priorLabel };
    });
  }, [allEvents, rates, revYear, thisMonth, now]);

  // Quarterly revenue bars
  const quarterlyBars: BarData[] = useMemo(() => {
    const quarters = ['Q1', 'Q2', 'Q3', 'Q4'];
    return quarters.map((label, qi) => {
      let total = 0;
      let hasCurrent = false;
      let allFuture = true;
      for (let m = qi * 3; m < qi * 3 + 3; m++) {
        const ym = `${qtrYear}-${String(m + 1).padStart(2, '0')}`;
        total += allEvents
          .filter(e => (e.check_out || '').slice(0, 7) === ym)
          .reduce((sum, e) => sum + (rates[e.prop_id] || 0), 0);
        if (ym === thisMonth) hasCurrent = true;
        const monthDate = new Date(qtrYear, m + 1, 0);
        if (monthDate <= now || ym === thisMonth) allFuture = false;
      }
      const priorQi = qi - 1;
      let priorValue: number | undefined;
      let priorLabel: string | undefined;
      if (priorQi >= 0) {
        let priorTotal = 0;
        for (let m = priorQi * 3; m < priorQi * 3 + 3; m++) {
          const ym = `${qtrYear}-${String(m + 1).padStart(2, '0')}`;
          priorTotal += allEvents
            .filter(e => (e.check_out || '').slice(0, 7) === ym)
            .reduce((sum, e) => sum + (rates[e.prop_id] || 0), 0);
        }
        priorValue = priorTotal;
        priorLabel = quarters[priorQi];
      }
      return { label, value: total, isActual: !allFuture, isCurrent: hasCurrent, priorValue, priorLabel };
    });
  }, [allEvents, rates, qtrYear, thisMonth, now]);

  // Avg rate per cleaning bars
  const avgRateBars: BarData[] = useMemo(() => {
    return MONTH_LABELS.map((label, i) => {
      const ym = `${avgRateYear}-${String(i + 1).padStart(2, '0')}`;
      const events = allEvents.filter(e => (e.check_out || '').slice(0, 7) === ym);
      const rev = events.reduce((sum, e) => sum + (rates[e.prop_id] || 0), 0);
      const avg = events.length > 0 ? rev / events.length : 0;
      const isCurrentMonth = ym === thisMonth;
      const monthDate = new Date(avgRateYear, i + 1, 0);
      const isFuture = monthDate > now && !isCurrentMonth;
      return { label, value: avg, isActual: !isFuture, isCurrent: isCurrentMonth };
    });
  }, [allEvents, rates, avgRateYear, thisMonth, now]);

  const yearAvgRate = useMemo(() => {
    const actual = avgRateBars.filter(b => b.isActual && b.value > 0);
    return actual.length > 0 ? actual.reduce((s, b) => s + b.value, 0) / actual.length : 0;
  }, [avgRateBars]);

  // Cleanings per month bars
  const cleaningsPerMonthBars: BarData[] = useMemo(() => {
    return MONTH_LABELS.map((label, i) => {
      const ym = `${cleaningsYear}-${String(i + 1).padStart(2, '0')}`;
      const count = allEvents.filter(e => (e.check_out || '').slice(0, 7) === ym).length;
      const isCurrentMonth = ym === thisMonth;
      const monthDate = new Date(cleaningsYear, i + 1, 0);
      const isFuture = monthDate > now && !isCurrentMonth;
      return { label, value: count, isActual: !isFuture, isCurrent: isCurrentMonth };
    });
  }, [allEvents, cleaningsYear, thisMonth, now]);

  const yearCleaningsTotal = cleaningsPerMonthBars.reduce((s, b) => s + b.value, 0);
  const yearTotal = monthlyBars.reduce((s, b) => s + b.value, 0);
  const qtrTotal = quarterlyBars.reduce((s, b) => s + b.value, 0);

  const handleDoubleTap = useCallback((bar: BarData) => {
    if (!bar.month) return;
    setDrillDownMonth(bar.month);
  }, []);

  // Plaid handlers
  const { isReadOnly } = useSubscriptionGate();
  const checkout = useProCheckout();
  const openPlaidLink = async () => {
    if (isReadOnly) {
      const result = await checkout.startCheckout();
      if (result !== 'purchased' && result !== 'restored') return;
    }
    try {
      const res = await apiFetch('/api/create-link-token', { method: 'POST' });
      if (res.link_token) {
        setPlaidLinkToken(res.link_token);
        setPlaidLinkVisible(true);
      }
    } catch {}
  };

  const handlePlaidSuccess = async (publicToken: string, accountName: string) => {
    setPlaidLinkVisible(false);
    try {
      const res = await apiFetch('/api/exchange-token', {
        method: 'POST',
        body: JSON.stringify({ public_token: publicToken, account_name: accountName }),
      });
      await apiFetch('/api/transactions/sync', { method: 'POST' });
      if (res.item_id) {
        await apiFetch('/api/transactions/historical', {
          method: 'POST',
          body: JSON.stringify({ item_id: res.item_id }),
        });
      }
      onPlaidConnected();
    } catch {}
  };

  // Revenue by host/property
  const revenueByHost = useMemo(() => {
    const map = new Map<string, { name: string; revenue: number; props: Map<string, { name: string; revenue: number }> }>();
    allEvents
      .filter(e => (e.check_out || '').slice(0, 4) === String(revYear))
      .forEach(e => {
        const rate = rates[e.prop_id] || 0;
        if (!map.has(e.owner_id)) map.set(e.owner_id, { name: e.owner, revenue: 0, props: new Map() });
        const host = map.get(e.owner_id)!;
        host.revenue += rate;
        if (!host.props.has(e.prop_id)) host.props.set(e.prop_id, { name: e.prop_name, revenue: 0 });
        host.props.get(e.prop_id)!.revenue += rate;
      });
    return Array.from(map.entries())
      .map(([id, data]) => ({
        id, name: data.name, revenue: data.revenue,
        props: Array.from(data.props.entries()).map(([pid, pd]) => ({ id: pid, name: pd.name, revenue: pd.revenue })),
      }))
      .sort((a, b) => b.revenue - a.revenue);
  }, [allEvents, rates, revYear]);

  return (
    <>
      {/* Summary cards */}
      <View style={styles.cardRow}>
        <Card style={styles.halfCard}>
          <Text style={styles.miniLabel}>Revenue This Month</Text>
          <Text style={[styles.cardValue, { color: Colors.green }]}>{fmt$(monthRevenue)}</Text>
        </Card>
        <Card style={styles.halfCard}>
          <Text style={styles.miniLabel}>Expenses This Month</Text>
          <Text style={[styles.cardValue, { color: Colors.red }]}>{fmt$(monthExpenses)}</Text>
        </Card>
      </View>

      {/* Net Margin */}
      <Card>
        <Text style={styles.sectionLabel}>
          NET MARGIN — {now.toLocaleDateString('en-US', { month: 'long' }).toUpperCase()}
        </Text>
        <View style={styles.marginRow}>
          <Text style={[styles.bigValue, { color: netMargin >= 0 ? Colors.green : Colors.red, marginBottom: 0 }]}>
            {fmt$(netMargin)}
          </Text>
          <View style={[styles.marginBadge, { backgroundColor: (netMargin >= 0 ? Colors.green : Colors.red) + '15' }]}>
            <Text style={[styles.marginBadgeText, { color: netMargin >= 0 ? Colors.green : Colors.red }]}>
              {marginPct.toFixed(1)}%
            </Text>
          </View>
        </View>
      </Card>

      {/* Revenue chart */}
      <Card>
        <Text style={styles.sectionLabel}>REVENUE — {revYear}</Text>
        <Text style={styles.bigValue}>{fmt$(yearTotal)}</Text>
        <YearTabs years={years} selected={revYear} onSelect={setRevYear} />
        <BarChart bars={monthlyBars} color={Colors.green} height={120} onDoubleTap={handleDoubleTap} />
      </Card>

      {/* Quarterly Revenue */}
      <Card>
        <Text style={styles.sectionLabel}>QUARTERLY REVENUE — {qtrYear}</Text>
        <Text style={styles.bigValue}>{fmt$(qtrTotal)}</Text>
        <YearTabs years={years} selected={qtrYear} onSelect={setQtrYear} />
        <BarChart bars={quarterlyBars} color={Colors.primary} height={120} />
      </Card>

      {/* Avg Rate Per Cleaning */}
      <Card>
        <Text style={styles.sectionLabel}>AVG RATE PER CLEANING — {avgRateYear}</Text>
        <Text style={styles.bigValue}>{fmt$(yearAvgRate)}</Text>
        <YearTabs years={years} selected={avgRateYear} onSelect={setAvgRateYear} />
        <BarChart bars={avgRateBars} color={Colors.green} height={120} />
      </Card>

      {/* Cleanings Per Month */}
      <Card>
        <Text style={styles.sectionLabel}>CLEANINGS PER MONTH — {cleaningsYear}</Text>
        <Text style={styles.bigValue}>{yearCleaningsTotal}</Text>
        <YearTabs years={years} selected={cleaningsYear} onSelect={setCleaningsYear} />
        <BarChart bars={cleaningsPerMonthBars} color={Colors.primary} height={120} />
      </Card>

      {/* Revenue breakdown */}
      {revenueByHost.length > 0 && (
        <Card>
          <Text style={styles.sectionLabel}>REVENUE BY HOST</Text>
          {revenueByHost.map((host, i) => (
            <View key={host.id} style={[styles.breakdownRow, i > 0 && styles.breakdownBorder]}>
              <View style={{ flex: 1 }}>
                <View style={styles.breakdownHeader}>
                  <Text style={styles.breakdownName}>{host.name}</Text>
                  <Text style={[styles.breakdownAmt, { color: Colors.green }]}>{fmt$(host.revenue)}</Text>
                </View>
                {host.props.map(p => (
                  <View key={p.id} style={styles.breakdownProp}>
                    <Text style={styles.breakdownPropName}>{p.name}</Text>
                    <Text style={styles.breakdownPropAmt}>{fmt$(p.revenue)}</Text>
                  </View>
                ))}
              </View>
            </View>
          ))}
        </Card>
      )}

      {/* Connect Plaid banner */}
      {!isPlaidConnected && (
        <TouchableOpacity
          activeOpacity={0.7}
          style={styles.plaidBanner}
          onPress={openPlaidLink}
        >
          <Ionicons name="card-outline" size={18} color={Colors.primary} />
          <Text style={styles.plaidBannerText}>Connect Plaid to track revenue & expenses</Text>
          <Ionicons name="chevron-forward" size={16} color={Colors.primary} />
        </TouchableOpacity>
      )}

      {/* Plaid Link */}
      <PlaidLinkModal
        visible={plaidLinkVisible}
        linkToken={plaidLinkToken}
        onSuccess={handlePlaidSuccess}
        onExit={() => setPlaidLinkVisible(false)}
      />

      {/* Drill-down modal */}
      <MonthDetailModal
        visible={!!drillDownMonth}
        yearMonth={drillDownMonth || ''}
        onClose={() => setDrillDownMonth(null)}
      />
    </>
  );
}

// ── 10-Year Projection Engine ──

interface CleanerYearRow {
  year: number;
  yearOffset: number;
  hosts: number;
  revenue: number;
  expenses: number;
  netIncome: number;
  businessValue: number;
}

function generate10YearProjection(
  currentHosts: number,
  hostsPerYear: number,
  monthlyRevenuePerHost: number,
  expenseRatio: number,
  projectionStyle: string,
): CleanerYearRow[] {
  const curYear = new Date().getFullYear();

  // Growth assumptions by style
  const styleFactors: Record<string, { rateGrowth: number; valMultiplier: number }> = {
    conservative: { rateGrowth: 0.02, valMultiplier: 1.0 },
    normal:       { rateGrowth: 0.04, valMultiplier: 1.5 },
    bullish:      { rateGrowth: 0.06, valMultiplier: 2.0 },
  };
  const factors = styleFactors[projectionStyle] || styleFactors.normal;

  const rows: CleanerYearRow[] = [];
  for (let i = 0; i <= 10; i++) {
    const hosts = currentHosts + hostsPerYear * i;
    // Revenue per host grows with rate increases over time
    const adjustedMonthlyRev = monthlyRevenuePerHost * Math.pow(1 + factors.rateGrowth, i);
    const annualRev = hosts * adjustedMonthlyRev * 12;
    const expenses = annualRev * expenseRatio;
    const netIncome = annualRev - expenses;
    // Cleaning business valuation: multiplier × annual revenue
    const businessValue = annualRev * factors.valMultiplier;

    rows.push({
      year: curYear + i,
      yearOffset: i,
      hosts,
      revenue: annualRev,
      expenses,
      netIncome,
      businessValue,
    });
  }
  return rows;
}

// ── Milestone Card ──

function CleanerMilestoneCard({ row }: { row: CleanerYearRow }) {
  return (
    <View style={milestoneStyles.card}>
      <Text style={milestoneStyles.yearLabel}>YEAR {row.yearOffset}</Text>
      <Text style={milestoneStyles.hosts}>{row.hosts} hosts</Text>
      <Text style={milestoneStyles.netIncome}>{fmtCompact(row.netIncome)}</Text>
      <Text style={milestoneStyles.netLabel}>net income/yr</Text>
      <Text style={milestoneStyles.value}>{fmtCompact(row.businessValue)}</Text>
      <Text style={milestoneStyles.valueLabel}>business value</Text>
    </View>
  );
}

const milestoneStyles = StyleSheet.create({
  card: {
    width: (SCREEN_W - Spacing.md * 2 - Spacing.sm * 3) / 3.5,
    backgroundColor: Colors.glassHeavy,
    borderRadius: Radius.xl,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight,
    borderTopWidth: 1,
    padding: Spacing.sm,
    alignItems: 'center',
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 20 },
      android: { elevation: 2 },
    }),
  },
  yearLabel: { fontSize: 9, fontWeight: '700', color: Colors.textDim, letterSpacing: 0.5, marginBottom: 2 },
  hosts: { fontSize: 11, color: Colors.textSecondary, marginBottom: 4 },
  netIncome: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.green },
  netLabel: { fontSize: 9, color: Colors.textDim, marginBottom: 6 },
  value: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },
  valueLabel: { fontSize: 9, color: Colors.textDim },
});

// ── Projections Sub-tab (Pro-gated) ──

function ProjectionsTab({ allEvents, rates }: { allEvents: CleanerEvent[]; rates: Record<string, number> }) {
  const { isReadOnly } = useSubscriptionGate();
  const checkout = useProCheckout();
  const profile = useUserStore(s => s.profile);
  const setProfile = useUserStore(s => s.setProfile);
  const hostsPerYear = profile?.hostsPerYear ?? 3;
  const projStyle = profile?.projectionStyle || 'normal';
  const { owners } = useCleanerStore();

  if (isReadOnly) {
    return (
      <View style={styles.lockedContainer}>
        <View style={styles.lockedCircle}>
          <Ionicons name="lock-closed" size={36} color={Colors.textDim} />
        </View>
        <Text style={styles.lockedTitle}>Unlock Projections</Text>
        <Text style={styles.lockedDesc}>
          Subscribe to Cleaner Pro to access revenue projections, business valuation, and 10-year growth modeling.
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
              <Ionicons name="diamond-outline" size={16} color="#fff" />
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

  // Current stats
  const currentHosts = owners.length || 1;
  const thisMonth = new Date().toISOString().slice(0, 7);
  const monthCleanings = allEvents.filter(e => (e.check_out || '').slice(0, 7) === thisMonth).length;
  const cleaningsPerHostPerMonth = currentHosts > 0 ? monthCleanings / currentHosts : 4;
  const rateVals = Object.values(rates);
  const avgRate = rateVals.length > 0 ? rateVals.reduce((s, r) => s + r, 0) / rateVals.length : 100;
  const monthlyRevenuePerHost = cleaningsPerHostPerMonth * avgRate;
  const expenseRatio = 0.15;

  // 10-year projection
  const projection = useMemo(
    () => generate10YearProjection(currentHosts, hostsPerYear, monthlyRevenuePerHost, expenseRatio, projStyle),
    [currentHosts, hostsPerYear, monthlyRevenuePerHost, projStyle],
  );

  // Current annual income
  const currentAnnualIncome = projection[0]?.netIncome ?? 0;
  const year10Income = projection[projection.length - 1]?.netIncome ?? 0;
  const year10Value = projection[projection.length - 1]?.businessValue ?? 0;

  // Net income bar chart
  const projBars: BarData[] = projection.map((row, i) => ({
    label: i === 0 ? 'Now' : `Yr${row.yearOffset}`,
    value: row.netIncome,
    isActual: i === 0,
    isCurrent: i === 0,
  }));

  const handleHostsChange = (delta: number) => {
    const next = Math.max(0, hostsPerYear + delta);
    setProfile({ hostsPerYear: next });
  };

  return (
    <>
      {/* ── Summary Cards ── */}
      <View style={styles.cardRow}>
        <Card style={styles.halfCard}>
          <Text style={styles.miniLabel}>Annual Income Today</Text>
          <Text style={[styles.cardValue, { color: Colors.green }]}>{fmtCompact(currentAnnualIncome)}</Text>
        </Card>
        <Card style={styles.halfCard}>
          <Text style={styles.miniLabel}>Year 10 Income</Text>
          <Text style={[styles.cardValue, { color: Colors.green }]}>{fmtCompact(year10Income)}</Text>
        </Card>
      </View>
      <View style={styles.cardRow}>
        <Card style={styles.halfCard}>
          <Text style={styles.miniLabel}>Business Value Today</Text>
          <Text style={[styles.cardValue, { color: Colors.primary }]}>{fmtCompact(projection[0]?.businessValue ?? 0)}</Text>
        </Card>
        <Card style={styles.halfCard}>
          <Text style={styles.miniLabel}>Year 10 Value</Text>
          <Text style={[styles.cardValue, { color: Colors.primary }]}>{fmtCompact(year10Value)}</Text>
        </Card>
      </View>

      {/* ── 10-Year Projection Table ── */}
      <Card>
        <View style={styles.projHeader}>
          <Text style={styles.projTitle}>10-Year Projection</Text>
          <View style={styles.unitsControl}>
            <TouchableOpacity activeOpacity={0.7} style={styles.unitBtn} onPress={() => handleHostsChange(-1)}>
              <Ionicons name="remove" size={16} color={Colors.textSecondary} />
            </TouchableOpacity>
            <Text style={styles.unitsText}>{hostsPerYear} hosts/yr</Text>
            <TouchableOpacity activeOpacity={0.7} style={styles.unitBtn} onPress={() => handleHostsChange(1)}>
              <Ionicons name="add" size={16} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.projSummary}>
          <Text style={styles.projSummaryText}>
            Current hosts: <Text style={{ fontWeight: '700' }}>{currentHosts}</Text>
          </Text>
          <Text style={styles.projSummaryText}>
            Avg rate: <Text style={{ fontWeight: '700' }}>{fmt$(avgRate)}</Text>
          </Text>
          <Text style={styles.projSummaryText}>
            Avg cleanings/host: <Text style={{ fontWeight: '700' }}>{cleaningsPerHostPerMonth.toFixed(1)}/mo</Text>
          </Text>
        </View>

        {/* Table */}
        <View style={styles.tableHeader}>
          <Text style={[styles.tableHeaderCell, { flex: 0.7 }]}>YEAR</Text>
          <Text style={[styles.tableHeaderCell, { flex: 0.6 }]}>HOSTS</Text>
          <Text style={styles.tableHeaderCell}>REVENUE</Text>
          <Text style={styles.tableHeaderCell}>NET</Text>
          <Text style={styles.tableHeaderCell}>VALUE</Text>
        </View>
        {projection.map((row, i) => (
          <View key={row.year} style={[styles.tableRow, i % 2 === 0 && styles.tableRowAlt]}>
            <Text style={[styles.tableCell, styles.tableCellBold, { flex: 0.7 }]}>{row.year}</Text>
            <Text style={[styles.tableCell, { flex: 0.6 }]}>{row.hosts}</Text>
            <Text style={[styles.tableCell, { color: Colors.green }]}>{fmtCompact(row.revenue)}</Text>
            <Text style={[styles.tableCell, { color: Colors.green }]}>{fmtCompact(row.netIncome)}</Text>
            <Text style={[styles.tableCell, { color: Colors.primary }]}>{fmtCompact(row.businessValue)}</Text>
          </View>
        ))}
      </Card>

      {/* ── Milestone Cards ── */}
      <Text style={styles.milestoneTitle}>Growth Milestones</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.milestoneScroll}>
        {projection.filter(r => r.yearOffset > 0 && r.yearOffset % 2 === 0).map(row => (
          <View key={row.yearOffset} style={{ marginRight: Spacing.sm }}>
            <CleanerMilestoneCard row={row} />
          </View>
        ))}
      </ScrollView>

      {/* ── Annual Net Income Chart ── */}
      <Card>
        <Text style={styles.projTitle}>Annual Net Income</Text>
        <BarChart bars={projBars} color={Colors.green} height={140} showNegative />
        <View style={styles.chartFooter}>
          <Text style={styles.chartFooterText}>
            Yr 10 value <Text style={{ color: Colors.primary, fontWeight: '700' }}>{fmtCompact(year10Value)}</Text>
          </Text>
          <Text style={styles.chartFooterText}>
            Net income <Text style={{ color: Colors.green, fontWeight: '700' }}>{fmtCompact(year10Income)}</Text>/yr
          </Text>
        </View>
      </Card>

      <View style={styles.noteRow}>
        <Ionicons name="analytics-outline" size={14} color={Colors.textDim} />
        <Text style={styles.noteText}>
          Based on {projStyle} projections · {hostsPerYear} new hosts per year · {(expenseRatio * 100).toFixed(0)}% expense ratio
        </Text>
      </View>
    </>
  );
}

// ── Main Screen ──

export function CleanerMoneyScreen() {
  const { isReadOnly } = useSubscriptionGate();
  const checkout = useProCheckout();
  const { schedule, fetchSchedule, fetchHistory, history } = useCleanerStore();
  const { fetchTransactions } = useDataStore();
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('Revenue');
  const [rates, setRates] = useState<Record<string, number>>({});
  const [plaidTransactions, setPlaidTransactions] = useState<any[]>([]);
  const [isPlaidConnected, setIsPlaidConnected] = useState(false);

  // Horizontal scroll for tab pages
  const scrollX = useRef(new Animated.Value(0)).current;
  const horizontalRef = useRef<ScrollView>(null);

  const handlePillSelect = useCallback((key: Tab) => {
    const idx = TABS.indexOf(key);
    horizontalRef.current?.scrollTo({ x: idx * SCREEN_W, animated: true });
    setTab(key);
  }, []);

  const onMomentumEnd = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const idx = Math.round(e.nativeEvent.contentOffset.x / SCREEN_W);
    if (idx >= 0 && idx < TABS.length) setTab(TABS[idx]);
  }, []);

  const loadPlaidData = useCallback(async (force = false) => {
    try {
      const txs = await fetchTransactions(force);
      setPlaidTransactions(txs);
      setIsPlaidConnected(txs.length > 0);
    } catch {
      setPlaidTransactions([]);
    }
  }, [fetchTransactions]);

  useEffect(() => {
    Promise.all([loadRates(), fetchSchedule(), fetchHistory(), loadPlaidData()])
      .catch(() => setError('Could not load financial data.'))
      .finally(() => setLoading(false));
  }, []);

  const loadRates = async () => {
    try {
      const raw = await SecureStore.getItemAsync(RATES_KEY);
      if (raw) setRates(JSON.parse(raw));
    } catch {}
  };

  const allEvents = useMemo(() => {
    const combined = [...history, ...schedule];
    const seen = new Set<string>();
    return combined.filter(e => {
      if (seen.has(e.uid)) return false;
      seen.add(e.uid);
      return true;
    });
  }, [history, schedule]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      await Promise.all([fetchSchedule(true), fetchHistory(true), loadPlaidData(true)]);
      await loadRates();
    } catch { setError('Could not load financial data.'); }
    finally { setRefreshing(false); }
  }, [fetchSchedule, fetchHistory, loadPlaidData]);

  // ── Paywall for free users ──
  if (isReadOnly) {
    return (
      <View style={styles.lockedContainer}>
        <View style={styles.lockedCircle}>
          <Ionicons name="cash-outline" size={36} color={Colors.textDim} />
        </View>
        <Text style={styles.lockedTitle}>Money</Text>
        <Text style={styles.lockedDesc}>
          Subscribe to Cleaner Pro to unlock revenue tracking, earnings breakdowns, and 10-year business projections.
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
              <Ionicons name="diamond-outline" size={16} color="#fff" />
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

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={Colors.green} />
      </View>
    );
  }

  return (
    <View style={styles.outerContainer}>
      {error && (
        <View style={[styles.errorBanner, { marginHorizontal: Spacing.md, marginTop: Spacing.md }]}>
          <Ionicons name="cloud-offline-outline" size={16} color={Colors.red} />
          <Text style={styles.errorBannerText}>{error}</Text>
        </View>
      )}

      {/* Period Toggle — scroll-driven */}
      <View style={{ paddingHorizontal: Spacing.md }}>
        <SwipePills
          compact
          items={[
            { key: 'Revenue' as Tab, label: 'Revenue' },
            { key: 'Projections' as Tab, label: 'Projections' },
          ]}
          selected={tab}
          onSelect={handlePillSelect}
          scrollOffset={scrollX}
          pageWidth={SCREEN_W}
        />
      </View>

      {/* Horizontal paginated content */}
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
        {/* Revenue Page */}
        <ScrollView
          style={{ width: SCREEN_W }}
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={"#FFFFFF"} colors={["#FFFFFF"]} />}
          onTouchStart={dismissAllChartTooltips}
        >
          <RevenueTab
            allEvents={allEvents}
            rates={rates}
            refreshing={refreshing}
            onRefresh={onRefresh}
            plaidTransactions={plaidTransactions}
            isPlaidConnected={isPlaidConnected}
            onPlaidConnected={() => loadPlaidData(true)}
          />
        </ScrollView>

        {/* Projections Page */}
        <ScrollView
          style={{ width: SCREEN_W }}
          contentContainerStyle={styles.content}
        >
          <ProjectionsTab allEvents={allEvents} rates={rates} />
        </ScrollView>
      </Animated.ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  outerContainer: { flex: 1, backgroundColor: 'transparent' },
  content: { padding: Spacing.md, paddingBottom: Spacing.xl },
  loadingContainer: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },
  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: 'rgba(239,68,68,0.08)', borderRadius: Radius.md,
    padding: Spacing.sm, marginBottom: Spacing.md, borderWidth: 0.5, borderColor: 'rgba(239,68,68,0.20)',
  },
  errorBannerText: { fontSize: FontSize.xs, color: Colors.red, flex: 1, lineHeight: 16 },

  // Summary cards
  cardRow: { flexDirection: 'row', gap: Spacing.sm },
  halfCard: { flex: 1 },
  miniLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '500', marginBottom: 4 },
  cardValue: { fontSize: FontSize.lg, fontWeight: '700' },
  miniSub: { fontSize: FontSize.xs, color: Colors.textDim, marginTop: 2 },

  // Net Margin
  marginRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  marginBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.pill },
  marginBadgeText: { fontSize: FontSize.sm, fontWeight: '600' },

  // Year selector
  yearRow: {
    flexDirection: 'row', justifyContent: 'center', gap: Spacing.xs,
    marginBottom: Spacing.md,
  },
  yearPill: {
    paddingHorizontal: Spacing.md, paddingVertical: 4,
    borderRadius: Radius.pill, borderWidth: 0.5, borderColor: Colors.glassBorder,
    backgroundColor: Colors.glassDark, overflow: 'hidden',
  },
  yearPillActive: {
    backgroundColor: Colors.glass,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.45, shadowRadius: 8 },
    }),
  },
  yearText: { fontSize: FontSize.sm, color: Colors.textDim, fontWeight: '500' },
  yearTextActive: { color: Colors.text, fontWeight: '600' },

  // Section
  sectionLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, letterSpacing: 0.8, fontWeight: '600', marginBottom: 4 },
  bigValue: { fontSize: FontSize.xxl, fontWeight: '700', color: Colors.text, marginBottom: Spacing.xs },

  // Legend
  legendRow: {
    flexDirection: 'row', justifyContent: 'center', gap: Spacing.md,
    marginTop: Spacing.sm, paddingTop: Spacing.xs,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: FontSize.xs, color: Colors.textDim },

  // Plaid banner
  plaidBanner: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.greenDim, borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  plaidBannerText: {
    flex: 1, fontSize: FontSize.sm, color: Colors.primary, fontWeight: '500',
  },

  // Breakdown
  breakdownRow: { paddingVertical: Spacing.sm },
  breakdownBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border },
  breakdownHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  breakdownName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  breakdownAmt: { fontSize: FontSize.md, fontWeight: '700' },
  breakdownProp: {
    flexDirection: 'row', justifyContent: 'space-between', paddingLeft: Spacing.md, paddingVertical: 2,
  },
  breakdownPropName: { fontSize: FontSize.sm, color: Colors.textSecondary },
  breakdownPropAmt: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },

  // Projections
  projHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.sm },
  projTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginBottom: Spacing.md },
  unitsControl: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  unitBtn: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: Colors.glassDark, borderWidth: 0.5, borderColor: Colors.glassBorder,
    alignItems: 'center', justifyContent: 'center',
  },
  unitsText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  projSummary: {
    flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md,
    paddingBottom: Spacing.sm, marginBottom: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
  },
  projSummaryText: { fontSize: FontSize.xs, color: Colors.textSecondary },

  // Table
  tableHeader: {
    flexDirection: 'row', paddingVertical: 6,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  tableHeaderCell: {
    flex: 1, fontSize: 9, fontWeight: '700', color: Colors.textDim,
    letterSpacing: 0.5, textAlign: 'center',
  },
  tableRow: {
    flexDirection: 'row', paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
  },
  tableRowAlt: { backgroundColor: 'rgba(0,0,0,0.015)' },
  tableCell: {
    flex: 1, fontSize: FontSize.sm, fontWeight: '600', color: Colors.text,
    textAlign: 'center',
  },
  tableCellBold: { fontWeight: '800' },

  // Milestones
  milestoneTitle: {
    fontSize: FontSize.md, fontWeight: '700', color: Colors.text,
    marginTop: Spacing.md, marginBottom: Spacing.sm,
  },
  milestoneScroll: { marginBottom: Spacing.md },

  // Chart footer
  chartFooter: {
    flexDirection: 'row', justifyContent: 'space-between',
    marginTop: Spacing.md, paddingTop: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border,
  },
  chartFooterText: { fontSize: FontSize.sm, color: Colors.textSecondary },

  noteRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: Spacing.sm,
  },
  noteText: { fontSize: 11, color: Colors.textDim, fontStyle: 'italic' },

  // Locked
  lockedContainer: {
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: Spacing.xl * 2, paddingHorizontal: Spacing.xl,
  },
  lockedCircle: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: Colors.glassDark, borderWidth: 0.5, borderColor: Colors.glassBorder,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  lockedTitle: {
    fontSize: FontSize.xl, fontWeight: '700', color: Colors.text,
    marginBottom: Spacing.sm,
  },
  lockedDesc: {
    fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center',
    lineHeight: 22, marginBottom: Spacing.xl,
  },
  lockedBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.green, borderRadius: Radius.lg,
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md,
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 20 },
    }),
  },
  lockedBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: '600' },
  restoreLink: { marginTop: 8, padding: 8 },
  restoreLinkText: { fontSize: 12, color: Colors.primary, fontWeight: '500' },
});

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
  ActivityIndicator, TouchableOpacity, Dimensions,
  Animated, Platform, PanResponder, PanResponderGestureState,
  NativeSyntheticEvent, NativeScrollEvent,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';

import { useDataStore } from '../../store/dataStore';
import { useUserStore } from '../../store/userStore';
import { Card } from '../../components/Card';
import { SectionHeader } from '../../components/SectionHeader';
import { BarChart, BarData, dismissAllChartTooltips } from '../../components/BarChart';
import { fmt$ } from '../../utils/format';
import { MonthDetailModal } from '../../components/MonthDetailModal';
import { SwipePills } from '../../components/SwipePills';
import {
  generateYearTimeline,
  aggregateToQuarters,
  getAvailableYears,
} from '../../utils/projections';
type Period = 'Monthly' | 'Quarterly' | 'Annual' | 'ByProperty';

const SCREEN_W = Dimensions.get('window').width;
const PERIODS: Period[] = ['Monthly', 'Quarterly', 'Annual', 'ByProperty'];
const PILL_ITEMS = [
  { key: 'Monthly' as Period, label: 'Monthly' },
  { key: 'Quarterly' as Period, label: 'Quarterly' },
  { key: 'Annual' as Period, label: 'Annual' },
  { key: 'ByProperty' as Period, label: 'P/L' },
];

// ── Helpers ──

function DeltaBadge({ value, invert = false }: { value: number | null | undefined; invert?: boolean }) {
  if (value == null) return null;
  const positive = invert ? value <= 0 : value >= 0;
  const color = positive ? Colors.green : Colors.red;
  return (
    <View style={[badgeStyles.badge, { backgroundColor: color + '15' }]}>
      <Ionicons name={value >= 0 ? 'arrow-up' : 'arrow-down'} size={11} color={color} />
      <Text style={[badgeStyles.text, { color }]}>{Math.abs(value).toFixed(1)}%</Text>
    </View>
  );
}

const badgeStyles = StyleSheet.create({
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: 2,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.pill,
  },
  text: { fontSize: 10, fontWeight: '600' },
});

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

// ── Main Screen ──

interface MoneyScreenProps {
  period?: Period;
}

export function MoneyScreen({ period: fixedPeriod }: MoneyScreenProps = {}) {
  const profile = useUserStore(s => s.profile);
  const portfolioType = profile?.portfolioType;
  const projectionStyle = profile?.projectionStyle || 'normal';
  const totalInvestment = profile?.totalInvestment;

  const { fetchCockpit, fetchProps } = useDataStore();
  const [cockpit, setCockpit] = useState<any>(null);
  const [props, setProps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [periodState, setPeriod] = useState<Period>(fixedPeriod || 'Monthly');
  const period = fixedPeriod || periodState;

  // Per-card year selection (Monthly/Quarterly only)
  const currentYear = new Date().getFullYear();
  const years = useMemo(() => getAvailableYears(), []);
  const [revYear, setRevYear] = useState(currentYear);
  const [expYear, setExpYear] = useState(currentYear);
  const [netYear, setNetYear] = useState(currentYear);
  const [marginYear, setMarginYear] = useState(currentYear);

  // Horizontal scroll for period pages
  const scrollX = useRef(new Animated.Value(0)).current;
  const horizontalRef = useRef<ScrollView>(null);

  const load = useCallback(async (force = false) => {
    try {
      setError('');
      const [c, pr] = await Promise.all([
        fetchCockpit(force),
        fetchProps(force),
      ]);
      setCockpit(c);
      setProps(pr || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [fetchCockpit, fetchProps]);

  useEffect(() => { load(); }, []);
  const onRefresh = () => { setRefreshing(true); load(true); };

  // Extract values
  const kpis = cockpit?.kpis || {};
  const pct = cockpit?.pct_changes || {};
  const prior = cockpit?.prior || {};
  const byProp = cockpit?.expenses_by_property || {};
  const revByProp = cockpit?.revenue_by_property || {};
  const raw = cockpit?.raw?.current || {};

  const revenue = kpis.revenue_mtd ?? 0;
  const expenses = kpis.expenses_mtd ?? 0;
  const net = kpis.net_mtd ?? 0;
  const priorRev = prior.revenue ?? 0;
  const priorExp = prior.expenses ?? 0;
  const priorNet = prior.net ?? 0;

  const airbnbRev = raw?.airbnb?.revenue ?? revenue;
  const nonAirbnbRev = raw?.pierce?.revenue ?? 0;

  const margin = revenue > 0 ? (net / revenue) * 100 : 0;
  const priorMargin = priorRev > 0 ? (priorNet / priorRev) * 100 : 0;

  // Per-property P/L data
  const propertyPL = useMemo(() => {
    const allPids = new Set([...Object.keys(revByProp), ...Object.keys(byProp)]);
    const entries = Array.from(allPids).map(pid => {
      const rev = revByProp[pid] ?? 0;
      const exp = byProp[pid] ?? 0;
      const netVal = rev - exp;
      const marginPct = rev > 0 ? (netVal / rev) * 100 : (exp > 0 ? -100 : 0);
      return { pid, revenue: rev, expenses: exp, net: netVal, margin: marginPct };
    });
    entries.sort((a, b) => b.net - a.net);
    const totRev = entries.reduce((s, e) => s + e.revenue, 0);
    const totExp = entries.reduce((s, e) => s + e.expenses, 0);
    const totNet = totRev - totExp;
    const totMargin = totRev > 0 ? (totNet / totRev) * 100 : 0;
    return { entries, totRev, totExp, totNet, totMargin };
  }, [revByProp, byProp]);

  const [drillDownMonth, setDrillDownMonth] = useState<string | null>(null);

  function yearBars(current: number, priorVal: number, targetYear: number, p: Period): BarData[] {
    const timeline = generateYearTimeline(current, priorVal, projectionStyle, targetYear);
    const priorYearTimeline = generateYearTimeline(current, priorVal, projectionStyle, targetYear - 1);

    if (p === 'Quarterly') {
      const quarters = aggregateToQuarters(timeline);
      return quarters.map((q, i) => ({
        label: q.label, value: q.value, isActual: q.isActual, isCurrent: q.isCurrent,
        priorValue: i > 0 ? quarters[i - 1].value : undefined,
        priorLabel: i > 0 ? quarters[i - 1].label : undefined,
        month: `${targetYear}-Q${i + 1}`,
        year: targetYear,
      }));
    }
    return timeline.map((m, i) => {
      const yoyMonth = priorYearTimeline[i];
      const yoyPct = yoyMonth && yoyMonth.value !== 0
        ? ((m.value - yoyMonth.value) / Math.abs(yoyMonth.value)) * 100
        : undefined;
      return {
        label: m.label, value: m.value, isActual: m.isActual, isCurrent: m.isCurrent,
        priorValue: i > 0 ? timeline[i - 1].value : undefined,
        priorLabel: i > 0 ? timeline[i - 1].label : undefined,
        yoyValue: yoyPct,
        month: `${targetYear}-${String(i + 1).padStart(2, '0')}`,
        year: targetYear,
      };
    });
  }

  function annualBars(current: number, priorVal: number): BarData[] {
    return years.map(y => {
      const timeline = generateYearTimeline(current, priorVal, projectionStyle, y);
      const total = timeline.reduce((sum, m) => sum + m.value, 0);
      const hasActual = timeline.some(m => m.isActual);
      const isCurrent = y === currentYear;
      return { label: String(y), value: total, isActual: hasActual, isCurrent, year: y, month: String(y) };
    });
  }

  function displayValue(current: number, priorVal: number, selectedYear: number, p: Period): number {
    const timeline = generateYearTimeline(current, priorVal, projectionStyle, selectedYear);
    if (p === 'Annual') {
      return timeline.reduce((sum, m) => sum + m.value, 0);
    }
    if (p === 'Quarterly') {
      const quarters = aggregateToQuarters(timeline);
      if (selectedYear === currentYear) {
        const match = quarters.find(q => q.isCurrent);
        return match?.value ?? quarters[quarters.length - 1]?.value ?? 0;
      }
      return quarters.reduce((sum, q) => sum + q.value, 0);
    }
    if (selectedYear === currentYear) {
      const cur = timeline.find(m => m.isCurrent);
      return cur?.value ?? 0;
    }
    const curMonth = new Date().getMonth();
    return timeline[curMonth]?.value ?? 0;
  }

  const revenueLabel = portfolioType === 'str' ? 'STR Revenue' : 'Revenue';
  const showBreakdown = portfolioType === 'both';
  const totalMonthlyRev = airbnbRev + nonAirbnbRev;
  const airbnbRatio = totalMonthlyRev > 0 ? airbnbRev / totalMonthlyRev : 0;

  const handleDoubleTap = useCallback((bar: BarData) => {
    if (!bar.month) return;
    if (bar.month.includes('-Q')) {
      const [yr, q] = bar.month.split('-Q');
      setDrillDownMonth(`${yr}-Q${q}`);
    } else {
      setDrillDownMonth(bar.month);
    }
  }, []);

  const propLabel = (pid: string) => {
    const p = (props || []).find((p: any) => (p.id || p.prop_id) === pid);
    return p?.label || pid.split('-')[0]?.toUpperCase() || pid;
  };


  // Pill tap → scroll to page
  const handlePillSelect = useCallback((key: Period) => {
    const idx = PERIODS.indexOf(key);
    horizontalRef.current?.scrollTo({ x: idx * SCREEN_W, animated: true });
    setPeriod(key);
  }, []);

  // Horizontal scroll end → update period state
  const onMomentumEnd = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const idx = Math.round(e.nativeEvent.contentOffset.x / SCREEN_W);
    if (idx >= 0 && idx < PERIODS.length) {
      setPeriod(PERIODS[idx]);
    }
  }, []);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.green} />
      </View>
    );
  }

  // ── Render content for a period ──
  const renderPeriodContent = (p: Period) => {
    const isAnnual = p === 'Annual';
    const breakdownTotal = displayValue(revenue, priorRev, currentYear, p);
    const airbnbDisplayVal = breakdownTotal * airbnbRatio;
    const nonAirbnbDisplayVal = breakdownTotal * (1 - airbnbRatio);
    const annualNetValue = displayValue(net, priorNet, currentYear, p);
    const cocReturn = totalInvestment && totalInvestment > 0 ? (annualNetValue / totalInvestment) * 100 : null;
    const nextYearNet = displayValue(net, priorNet, currentYear + 1, p);
    const projectedCoC = totalInvestment && totalInvestment > 0 ? (nextYearNet / totalInvestment) * 100 : null;

    if (p === 'ByProperty') {
      return (
        <>
          <Card>
            <Text style={styles.sectionLabel}>
              PORTFOLIO P/L — {cockpit?.month ? new Date(cockpit.month + '-01').toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : 'This Month'}
            </Text>
            <View style={styles.plRow}>
              <View style={styles.plCol}>
                <Text style={styles.plLabel}>Revenue</Text>
                <Text style={[styles.plValue, { color: Colors.green }]}>{fmt$(propertyPL.totRev)}</Text>
              </View>
              <View style={styles.plCol}>
                <Text style={styles.plLabel}>Expenses</Text>
                <Text style={[styles.plValue, { color: Colors.red }]}>{fmt$(propertyPL.totExp)}</Text>
              </View>
              <View style={styles.plCol}>
                <Text style={styles.plLabel}>Net</Text>
                <Text style={[styles.plValue, { color: propertyPL.totNet >= 0 ? Colors.green : Colors.red }]}>
                  {fmt$(propertyPL.totNet)}
                </Text>
              </View>
            </View>
            <Text style={styles.plSummary}>
              {propertyPL.entries.length} {propertyPL.entries.length === 1 ? 'property' : 'properties'} · {propertyPL.totMargin.toFixed(1)}% margin
            </Text>
          </Card>

          {propertyPL.entries.map(entry => {
            const maxBar = Math.max(entry.revenue, entry.expenses, 1);
            const revPct = (entry.revenue / maxBar) * 100;
            const expPct = (entry.expenses / maxBar) * 100;
            return (
              <Card key={entry.pid}>
                <Text style={styles.plPropName}>{propLabel(entry.pid)}</Text>
                <View style={styles.plRow}>
                  <View style={styles.plCol}>
                    <Text style={styles.plLabel}>Revenue</Text>
                    <Text style={[styles.plValue, { color: Colors.green }]}>{fmt$(entry.revenue)}</Text>
                  </View>
                  <View style={styles.plCol}>
                    <Text style={styles.plLabel}>Expenses</Text>
                    <Text style={[styles.plValue, { color: Colors.red }]}>{fmt$(entry.expenses)}</Text>
                  </View>
                  <View style={styles.plCol}>
                    <Text style={styles.plLabel}>Net</Text>
                    <Text style={[styles.plValue, { color: entry.net >= 0 ? Colors.green : Colors.red }]}>
                      {fmt$(entry.net)}
                    </Text>
                  </View>
                </View>
                <View style={styles.plBarRow}>
                  <View style={styles.plBarTrack}>
                    <View style={[styles.plBarGreen, { width: `${revPct}%` }]} />
                    <View style={[styles.plBarRed, { width: `${expPct}%` }]} />
                  </View>
                  <Text style={styles.plMarginText}>
                    {entry.margin > -999 ? `${entry.margin.toFixed(1)}%` : '--'}
                  </Text>
                </View>
              </Card>
            );
          })}

          {propertyPL.entries.length === 0 && (
            <Card>
              <Text style={styles.plEmptyText}>No per-property data available yet. Tag transactions or add property income in Settings.</Text>
            </Card>
          )}
        </>
      );
    }

    // Monthly / Quarterly / Annual shared layout
    return (
      <>
        {showBreakdown && (
          <>
            <SectionHeader title="Revenue Breakdown" />
            <View style={styles.cardRow}>
              <Card style={styles.halfCard}>
                <Text style={styles.miniLabel}>STR Revenue</Text>
                <Text style={[styles.cardValue, { color: Colors.green }]}>{fmt$(airbnbDisplayVal)}</Text>
                <Text style={styles.miniSub}>Airbnb income</Text>
              </Card>
              <Card style={styles.halfCard}>
                <Text style={styles.miniLabel}>Non-Airbnb Revenue</Text>
                <Text style={[styles.cardValue, { color: Colors.primary }]}>{fmt$(nonAirbnbDisplayVal)}</Text>
                <Text style={styles.miniSub}>Other income</Text>
              </Card>
            </View>
          </>
        )}

        <Card>
          <View style={styles.cardHeader}>
            <Text style={styles.sectionLabel}>{revenueLabel.toUpperCase()}</Text>
            <DeltaBadge value={pct.revenue} />
          </View>
          <Text style={styles.bigValue}>
            {fmt$(isAnnual
              ? displayValue(revenue, priorRev, currentYear, p)
              : displayValue(revenue, priorRev, revYear, p)
            )}
          </Text>
          {!isAnnual && <YearTabs years={years} selected={revYear} onSelect={setRevYear} />}
          <BarChart
            bars={isAnnual ? annualBars(revenue, priorRev) : yearBars(revenue, priorRev, revYear, p)}
            color={Colors.green}
            onDoubleTap={handleDoubleTap}

          />
        </Card>

        <Card>
          <View style={styles.cardHeader}>
            <Text style={styles.sectionLabel}>EXPENSES</Text>
            <DeltaBadge value={pct.expenses} invert />
          </View>
          <Text style={[styles.bigValue, { color: Colors.red }]}>
            {fmt$(isAnnual
              ? displayValue(expenses, priorExp, currentYear, p)
              : displayValue(expenses, priorExp, expYear, p)
            )}
          </Text>
          {!isAnnual && <YearTabs years={years} selected={expYear} onSelect={setExpYear} />}
          <BarChart
            bars={isAnnual ? annualBars(expenses, priorExp) : yearBars(expenses, priorExp, expYear, p)}
            color={Colors.red}
            onDoubleTap={handleDoubleTap}
            invertDelta

          />
        </Card>

        <Card>
          <View style={styles.cardHeader}>
            <Text style={styles.sectionLabel}>NET INCOME</Text>
            <DeltaBadge value={pct.net} />
          </View>
          <Text style={[styles.bigValue, {
            color: (isAnnual ? annualNetValue : displayValue(net, priorNet, netYear, p)) >= 0 ? Colors.green : Colors.red
          }]}>
            {fmt$(isAnnual
              ? annualNetValue
              : displayValue(net, priorNet, netYear, p)
            )}
          </Text>
          {!isAnnual && <YearTabs years={years} selected={netYear} onSelect={setNetYear} />}
          <BarChart
            bars={isAnnual ? annualBars(net, priorNet) : yearBars(net, priorNet, netYear, p)}
            color={Colors.green}
            showNegative
            onDoubleTap={handleDoubleTap}

          />
        </Card>

        <Card>
          <View style={styles.cardHeader}>
            <Text style={styles.sectionLabel}>NET MARGIN</Text>
            <DeltaBadge value={margin - priorMargin} />
          </View>
          <Text style={[styles.bigValue, {
            color: (isAnnual ? margin : displayValue(margin, priorMargin, marginYear, p)) >= 0 ? Colors.green : Colors.red
          }]}>
            {(isAnnual ? margin : displayValue(margin, priorMargin, marginYear, p)).toFixed(1)}%
          </Text>
          {!isAnnual && <YearTabs years={years} selected={marginYear} onSelect={setMarginYear} />}
          <BarChart
            bars={isAnnual ? annualBars(margin, priorMargin) : yearBars(margin, priorMargin, marginYear, p)}
            color={Colors.primary}
            isPercent
            onDoubleTap={handleDoubleTap}
          />
        </Card>

        {isAnnual && (
          <>
            <SectionHeader title="Cash on Cash Return" />
            <Card>
              {totalInvestment && totalInvestment > 0 ? (
                <View style={styles.cocRow}>
                  <View style={styles.cocHalf}>
                    <Text style={styles.cocLabel}>Current</Text>
                    <Text style={[styles.cocValue, { color: (cocReturn ?? 0) >= 0 ? Colors.green : Colors.red }]}>
                      {cocReturn != null ? `${cocReturn.toFixed(1)}%` : '--'}
                    </Text>
                  </View>
                  <View style={styles.cocDivider} />
                  <View style={styles.cocHalf}>
                    <Text style={styles.cocLabel}>Projected</Text>
                    <Text style={[styles.cocValue, { color: (projectedCoC ?? 0) >= 0 ? Colors.green : Colors.red }]}>
                      {projectedCoC != null ? `${projectedCoC.toFixed(1)}%` : '--'}
                    </Text>
                  </View>
                </View>
              ) : (
                <View style={styles.cocPlaceholder}>
                  <Ionicons name="calculator-outline" size={20} color={Colors.textDim} />
                  <Text style={styles.cocPlaceholderText}>
                    Set your total investment in Settings to see Cash on Cash Return
                  </Text>
                </View>
              )}
            </Card>
          </>
        )}

        {Object.keys(byProp).length > 0 && (
          <>
            <SectionHeader title="Expenses by Property" />
            <Card>
              {Object.entries(byProp)
                .sort(([, a]: any, [, b]: any) => b - a)
                .map(([pid, amount]: any, i: number, arr: any[]) => {
                  const pctVal = expenses > 0 ? (amount / expenses) * 100 : 0;
                  return (
                    <View key={pid}>
                      <View style={styles.propExpRow}>
                        <View style={styles.propExpInfo}>
                          <Text style={styles.propExpName}>{propLabel(pid)}</Text>
                          <Text style={styles.propExpPct}>{pctVal.toFixed(0)}%</Text>
                        </View>
                        <Text style={styles.propExpAmt}>{fmt$(amount)}</Text>
                      </View>
                      <View style={styles.propExpBarTrack}>
                        <View style={[styles.propExpBarFill, { width: `${pctVal}%` }]} />
                      </View>
                      {i < arr.length - 1 && <View style={styles.propExpDivider} />}
                    </View>
                  );
                })}
            </Card>
          </>
        )}
      </>
    );
  };

  return (
    <View style={styles.outerContainer}>
      {error ? <Card style={[styles.errorCard, { margin: Spacing.md }]}><Text style={styles.error}>{error}</Text></Card> : null}

      {/* Period Toggle — scroll-driven */}
      {!fixedPeriod && (
        <View style={{ paddingHorizontal: Spacing.md }}>
          <SwipePills
            compact
            items={PILL_ITEMS}
            selected={period}
            onSelect={handlePillSelect}
            scrollOffset={scrollX}
            pageWidth={SCREEN_W}
          />
        </View>
      )}

      {/* Horizontal paginated content — tap-only, no user swipe */}
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
      >
        {PERIODS.map(p => (
          <View key={p} style={{ width: SCREEN_W, flex: 1 }}>
            <ScrollView
              contentContainerStyle={styles.content}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.green} />}
              onTouchStart={dismissAllChartTooltips}
            >
              {renderPeriodContent(p)}
            </ScrollView>
          </View>
        ))}
      </Animated.ScrollView>

      <MonthDetailModal
        visible={!!drillDownMonth}
        yearMonth={drillDownMonth || ''}
        onClose={() => setDrillDownMonth(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  outerContainer: { flex: 1, backgroundColor: 'transparent', overflow: 'hidden' },
  content: { padding: Spacing.md, paddingBottom: Spacing.xl },
  center: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },
  errorCard: { backgroundColor: Colors.redDim, borderColor: Colors.red + '30' },
  error: { color: Colors.red, fontSize: FontSize.sm },

  cardHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4,
  },
  sectionLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, letterSpacing: 0.8, fontWeight: '600' },
  bigValue: { fontSize: FontSize.xxl, fontWeight: '700', color: Colors.text, marginBottom: Spacing.xs },

  cardRow: { flexDirection: 'row', gap: Spacing.sm },
  halfCard: { flex: 1 },
  miniLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '500', marginBottom: 4 },
  cardValue: { fontSize: FontSize.lg, fontWeight: '700' },
  miniSub: { fontSize: FontSize.xs, color: Colors.textDim, marginTop: 2 },

  cocRow: { flexDirection: 'row', alignItems: 'center' },
  cocHalf: { flex: 1, alignItems: 'center', paddingVertical: Spacing.sm },
  cocDivider: { width: StyleSheet.hairlineWidth, backgroundColor: Colors.border, height: '100%' },
  cocLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, marginBottom: 4 },
  cocValue: { fontSize: FontSize.xl, fontWeight: '700' },
  cocPlaceholder: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.xs,
  },
  cocPlaceholderText: { fontSize: FontSize.sm, color: Colors.textDim, flex: 1 },

  propExpRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  propExpInfo: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  propExpName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.text },
  propExpPct: { fontSize: FontSize.xs, color: Colors.textDim },
  propExpAmt: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.red },
  propExpBarTrack: { height: 4, backgroundColor: Colors.border, borderRadius: 2, overflow: 'hidden', marginBottom: 4 },
  propExpBarFill: { height: '100%', backgroundColor: Colors.red + '60', borderRadius: 2 },
  propExpDivider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border, marginVertical: Spacing.sm },

  plRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm, marginBottom: Spacing.xs },
  plCol: { flex: 1 },
  plLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '500', marginBottom: 2 },
  plValue: { fontSize: FontSize.lg, fontWeight: '700' },
  plSummary: { fontSize: FontSize.xs, color: Colors.textDim, marginTop: Spacing.xs },
  plPropName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  plBarRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.xs },
  plBarTrack: { flex: 1, height: 6, backgroundColor: Colors.border, borderRadius: 3, overflow: 'hidden', flexDirection: 'row' },
  plBarGreen: { height: '100%', backgroundColor: Colors.green + '70' },
  plBarRed: { height: '100%', backgroundColor: Colors.red + '70' },
  plMarginText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600', width: 44, textAlign: 'right' },
  plEmptyText: { fontSize: FontSize.sm, color: Colors.textDim, textAlign: 'center', paddingVertical: Spacing.md },
});

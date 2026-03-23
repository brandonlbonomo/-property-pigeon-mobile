import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
  ActivityIndicator, TouchableOpacity, Dimensions,
  Animated, Platform,
  NativeSyntheticEvent, NativeScrollEvent,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
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

function YearChevrons({ years, selected, onSelect }: { years: number[]; selected: number; onSelect: (y: number) => void }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      {open && (
        <TouchableOpacity
          activeOpacity={1}
          style={{ position: 'absolute', top: -500, bottom: -500, left: -500, right: -500, zIndex: 9 }}
          onPress={() => setOpen(false)}
        />
      )}
      <View style={yearStyles.container}>
        <TouchableOpacity
          activeOpacity={0.7}
          style={yearStyles.pill}
          onPress={() => setOpen(!open)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={yearStyles.pillText}>{selected}</Text>
          <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={12} color={Colors.textSecondary} />
        </TouchableOpacity>
        {open && (
          <View style={yearStyles.dropdown}>
            {years.map(y => (
              <TouchableOpacity
                key={y}
                activeOpacity={0.7}
                style={[yearStyles.dropItem, y === selected && yearStyles.dropItemActive]}
                onPress={() => { onSelect(y); setOpen(false); }}
              >
                <Text style={[yearStyles.dropText, y === selected && yearStyles.dropTextActive]}>{y}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>
    </>
  );
}

const yearStyles = StyleSheet.create({
  container: {
    zIndex: 10,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.glassDark,
    borderRadius: Radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
  },
  pillText: {
    fontSize: FontSize.xs,
    fontWeight: '700',
    color: Colors.textSecondary,
  },
  dropdown: {
    position: 'absolute',
    top: 30,
    right: 0,
    backgroundColor: Colors.glassOverlay,
    borderRadius: Radius.md,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    paddingVertical: 4,
    minWidth: 60,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 10 },
    }),
  },
  dropItem: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignItems: 'center',
  },
  dropItemActive: {
    backgroundColor: Colors.greenDim,
  },
  dropText: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  dropTextActive: {
    color: Colors.green,
    fontWeight: '700',
  },
  label: {
    fontSize: FontSize.xs,
    fontWeight: '700',
    color: Colors.text,
    minWidth: 36,
    textAlign: 'center',
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
  const startingUnits = (profile?.properties || []).reduce((sum, p) => sum + (p.units || 1), 0);
  const unitsPerYear = profile?.unitsPerYear ?? 0;
  // Total investment = sum of (purchasePrice * downPaymentPct/100) across all properties
  // Falls back to profile.totalInvestment if no per-property data
  const totalInvestment = useMemo(() => {
    const properties = profile?.properties || [];
    const perPropTotal = properties.reduce((sum, p) => {
      if (p.purchasePrice && p.downPaymentPct) {
        return sum + (p.purchasePrice * p.downPaymentPct / 100);
      }
      return sum;
    }, 0);
    return perPropTotal > 0 ? perPropTotal : (profile?.totalInvestment || 0);
  }, [profile?.properties, profile?.totalInvestment]);

  const { fetchCockpit } = useDataStore();
  const [cockpit, setCockpit] = useState<any>(null);
  // Properties from Manage Properties — single source of truth
  const props = useMemo(() => (profile?.properties || []).map((p: any) => ({
    id: p.id || p.name, prop_id: p.id || p.name, label: p.label || p.name,
  })), [profile?.properties]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [periodState, setPeriod] = useState<Period>(fixedPeriod || 'Monthly');
  const period = fixedPeriod || periodState;

  // Per-card year selection (Monthly/Quarterly only)
  const currentYear = new Date().getFullYear();
  const years = useMemo(() => getAvailableYears(), []);
  const [revYear, setRevYear] = useState(currentYear);
  const [netYear, setNetYear] = useState(currentYear);

  // Selected bar index per card — tapping a bar updates the card's displayed values
  const [selectedRevBar, setSelectedRevBar] = useState<number | null>(null);
  const [selectedNetBar, setSelectedNetBar] = useState<number | null>(null);

  // Horizontal scroll for period pages
  const scrollX = useRef(new Animated.Value(0)).current;
  const horizontalRef = useRef<ScrollView>(null);

  const { fetchTransactions, fetchCategoryTags } = useDataStore();
  const [monthlyActuals, setMonthlyActuals] = useState<Record<string, { revenue: number; expenses: number }>>({});
  const [strLtrSplit, setStrLtrSplit] = useState<{ str: number; ltr: number }>({ str: 0, ltr: 0 });

  const load = useCallback(async (force = false) => {
    try {
      setError('');
      const [c, txs, catTags] = await Promise.all([
        fetchCockpit(force),
        fetchTransactions(force),
        fetchCategoryTags(force),
      ]);
      setCockpit(c);

      // Compute actual monthly revenue/expenses from tagged transactions
      const actuals: Record<string, { revenue: number; expenses: number }> = {};
      const INCOME_CATS = new Set(['__rental_income__', '__cleaning_income__']);
      const EXCLUDED_CATS = new Set(['__delete__', '__internal_transfer__']);
      // Build STR property set from Manage Properties
      const userProps = profile?.properties || [];
      const strPropIds = new Set(userProps.filter((p: any) => p.isAirbnb).map((p: any) => p.id || p.name));
      let strRevTotal = 0, ltrRevTotal = 0;

      for (const tx of (txs || [])) {
        const catTag = catTags?.[tx.id] || tx.category_tag;
        const propTag = tx.property_tag;

        // Skip untagged and excluded
        if (!propTag && !catTag) continue;
        if (EXCLUDED_CATS.has(catTag)) continue;
        if (propTag === 'deleted' || propTag === 'transfer') continue;
        if (tx.pending) continue;

        const month = (tx.date || '').slice(0, 7);
        if (!month) continue;
        if (!actuals[month]) actuals[month] = { revenue: 0, expenses: 0 };

        const amount = Math.abs(tx.amount ?? 0);
        const isIncome = INCOME_CATS.has(catTag) || (!catTag && (tx.type === 'in' || tx.amount < 0));
        if (isIncome) {
          actuals[month].revenue += amount;
          // STR vs non-STR: property's isAirbnb flag is the source of truth
          if (propTag && strPropIds.has(propTag)) {
            strRevTotal += amount;
          } else if (propTag) {
            // Has a property tag that's NOT in STR set = non-STR
            ltrRevTotal += amount;
          } else {
            // No property tag (category only) — can't determine, default STR
            strRevTotal += amount;
          }
        } else {
          actuals[month].expenses += amount;
        }
      }
      setMonthlyActuals(actuals);
      setStrLtrSplit({ str: strRevTotal, ltr: ltrRevTotal });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [fetchCockpit, fetchTransactions, fetchCategoryTags]);

  useEffect(() => { load(); }, []);

  // Auto-reload when cockpit cache is invalidated (e.g. after tagging a transaction)
  const cockpitCache = useDataStore(s => s.cockpit);
  useEffect(() => {
    // cockpit was invalidated (set to null) — reload fresh data
    if (!cockpitCache && !loading) {
      load(true);
    }
  }, [cockpitCache]);

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

  // FY projected revenue/expenses — same formula as Projections tab
  const fyRevenue = useMemo(() => {
    const timeline = generateYearTimeline(revenue, priorRev, projectionStyle, currentYear);
    return timeline.reduce((s, m) => s + m.value, 0);
  }, [revenue, priorRev, projectionStyle, currentYear]);
  const fyExpenses = useMemo(() => {
    const timeline = generateYearTimeline(expenses, priorExp, projectionStyle, currentYear);
    return timeline.reduce((s, m) => s + m.value, 0);
  }, [expenses, priorExp, projectionStyle, currentYear]);

  // STR vs non-STR revenue — computed from actual tagged transactions in load()
  const airbnbRev = strLtrSplit.str;
  const nonAirbnbRev = strLtrSplit.ltr;

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

  // Build monthly bars from ACTUAL transaction data — single source of truth
  const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  type Metric = 'revenue' | 'expenses' | 'net' | 'margin';

  function detectMetric(current: number): Metric {
    if (current === revenue) return 'revenue';
    if (current === expenses) return 'expenses';
    if (current === net) return 'net';
    return 'margin';
  }

  // Seasonal projection: for each month, blend same-month prior year data
  // with YTD average. This adapts to new tags and captures seasonality.
  const projectionByMonth = useMemo(() => {
    const now = new Date();
    const curMonth = now.getMonth();
    const curYear = now.getFullYear();

    // YTD average as fallback
    let ytdRevSum = 0, ytdExpSum = 0, ytdCount = 0;
    for (let m = 0; m <= curMonth; m++) {
      const key = `${curYear}-${String(m + 1).padStart(2, '0')}`;
      const data = monthlyActuals[key];
      if (data && (data.revenue > 0 || data.expenses > 0)) {
        ytdRevSum += data.revenue;
        ytdExpSum += data.expenses;
        ytdCount++;
      }
    }
    const ytdAvgRev = ytdCount > 0 ? ytdRevSum / ytdCount : 0;
    const ytdAvgExp = ytdCount > 0 ? ytdExpSum / ytdCount : 0;

    // Per-month seasonal data from prior years
    const byMonth: Record<number, { rev: number; exp: number }> = {};
    for (let m = 0; m < 12; m++) {
      let revTotal = 0, expTotal = 0, count = 0;
      // Look back up to 3 prior years for seasonal signal
      for (let yOff = 1; yOff <= 3; yOff++) {
        const key = `${curYear - yOff}-${String(m + 1).padStart(2, '0')}`;
        const data = monthlyActuals[key];
        if (data && (data.revenue > 0 || data.expenses > 0)) {
          // Weight recent years more: year-1 = 3x, year-2 = 2x, year-3 = 1x
          const w = 4 - yOff;
          revTotal += data.revenue * w;
          expTotal += data.expenses * w;
          count += w;
        }
      }
      if (count > 0) {
        byMonth[m] = { rev: revTotal / count, exp: expTotal / count };
      }
    }

    // ── Trend line from ALL actual revenue data (applies to every portfolio type) ──
    const trendPoints: { x: number; y: number }[] = [];
    for (let m = 0; m <= curMonth; m++) {
      const key = `${curYear}-${String(m + 1).padStart(2, '0')}`;
      const data = monthlyActuals[key];
      if (data && data.revenue > 0) {
        trendPoints.push({ x: m, y: data.revenue });
      }
    }
    for (let yOff = 1; yOff <= 2; yOff++) {
      for (let m = 0; m < 12; m++) {
        const key = `${curYear - yOff}-${String(m + 1).padStart(2, '0')}`;
        const data = monthlyActuals[key];
        if (data && data.revenue > 0) {
          trendPoints.push({ x: m - (yOff * 12), y: data.revenue });
        }
      }
    }
    // Linear regression
    let trendSlope = 0;
    let trendIntercept = ytdAvgRev;
    if (trendPoints.length >= 2) {
      const n = trendPoints.length;
      const sumX = trendPoints.reduce((s, p) => s + p.x, 0);
      const sumY = trendPoints.reduce((s, p) => s + p.y, 0);
      const sumXY = trendPoints.reduce((s, p) => s + p.x * p.y, 0);
      const sumX2 = trendPoints.reduce((s, p) => s + p.x * p.x, 0);
      const denom = n * sumX2 - sumX * sumX;
      if (denom !== 0) {
        trendSlope = (n * sumXY - sumX * sumY) / denom;
        trendIntercept = (sumY - trendSlope * sumX) / n;
      }
    }

    // STR seasonal multipliers (summer peak, winter low)
    const strSeasonality = [0.75, 0.80, 0.90, 0.95, 1.05, 1.15, 1.20, 1.15, 1.05, 0.95, 0.85, 0.80];
    const isLTR = portfolioType === 'ltr';
    const isBoth = portfolioType === 'both';

    const result: Record<number, { rev: number; exp: number }> = {};
    for (let m = 0; m < 12; m++) {
      const seasonal = byMonth[m];
      // Trend-based projection for this month
      const trendRev = Math.max(0, trendIntercept + trendSlope * m);

      if (seasonal) {
        // Prior year seasonal data exists — blend with trend
        const seasonalAvg = (seasonal.rev + seasonal.exp) / 2 || 1;
        const ytdAvg = (ytdAvgRev + ytdAvgExp) / 2 || 1;
        const growthFactor = ytdAvg / seasonalAvg;
        const scaledRev = seasonal.rev * Math.min(growthFactor, 3);
        const scaledExp = seasonal.exp * Math.min(growthFactor, 3);
        // Blend: 40% seasonal, 30% trend, 30% YTD avg
        result[m] = {
          rev: scaledRev * 0.4 + trendRev * 0.3 + ytdAvgRev * 0.3,
          exp: scaledExp * 0.4 + (ytdAvgExp > 0 ? ytdAvgExp : scaledExp * 0.35) * 0.6,
        };
      } else if (isLTR) {
        // LTR: trend line is primary — rent is predictable
        result[m] = {
          rev: trendRev,
          exp: ytdAvgExp > 0 ? ytdAvgExp + trendSlope * 0.3 * m : trendRev * 0.3,
        };
      } else if (isBoth) {
        // BOTH: split — trend line for the stable LTR portion,
        // seasonal adjustment for the STR portion
        // Estimate LTR as the floor (minimum monthly revenue = likely rent)
        const minRev = trendPoints.length > 0 ? Math.min(...trendPoints.map(p => p.y)) : ytdAvgRev * 0.5;
        const ltrPortion = Math.max(minRev * 0.7, trendRev * 0.4); // stable base
        const strPortion = Math.max(0, trendRev - ltrPortion);
        const seasonFactor = strSeasonality[m];
        result[m] = {
          rev: ltrPortion + strPortion * seasonFactor,
          exp: ytdAvgExp > 0 ? ytdAvgExp * (0.95 + seasonFactor * 0.05) : trendRev * 0.3,
        };
      } else {
        // STR: trend line + seasonal curve
        const seasonFactor = strSeasonality[m];
        // Blend trend with seasonal-adjusted average
        const seasonalRev = ytdAvgRev * seasonFactor;
        result[m] = {
          rev: trendRev * 0.5 + seasonalRev * 0.5,
          exp: ytdAvgExp > 0
            ? ytdAvgExp * (0.9 + seasonFactor * 0.1)
            : trendRev * 0.3,
        };
      }
    }
    return result;
  }, [monthlyActuals]);

  function getMonthMetric(targetYear: number, month: number, metric: Metric, useProjection = false): number {
    const key = `${targetYear}-${String(month + 1).padStart(2, '0')}`;
    const data = monthlyActuals[key];
    const now = new Date();
    const isFuture = targetYear > now.getFullYear() || (targetYear === now.getFullYear() && month > now.getMonth());

    let rev = data?.revenue ?? 0;
    let exp = data?.expenses ?? 0;

    // For future months, use seasonal projection so lines don't flatline
    if (useProjection && isFuture && rev === 0 && exp === 0) {
      const proj = projectionByMonth[month];
      if (proj) {
        rev = proj.rev;
        exp = proj.exp;
      }
    }

    switch (metric) {
      case 'revenue': return rev;
      case 'expenses': return exp;
      case 'net': return rev - exp;
      case 'margin': return rev > 0 ? ((rev - exp) / rev) * 100 : 0;
    }
  }

  function yearBars(_current: number, _priorVal: number, targetYear: number, p: Period, useProjection = false): BarData[] {
    const now = new Date();
    const curMonth = now.getMonth();
    const curYear = now.getFullYear();
    const metric = detectMetric(_current);

    const monthly: BarData[] = [];
    for (let m = 0; m < 12; m++) {
      const val = getMonthMetric(targetYear, m, metric, useProjection);
      const isPast = targetYear < curYear || (targetYear === curYear && m <= curMonth);
      monthly.push({
        label: MONTH_ABBR[m],
        value: val,
        isActual: isPast,
        isCurrent: targetYear === curYear && m === curMonth,
        month: `${targetYear}-${String(m + 1).padStart(2, '0')}`,
        year: targetYear,
        priorValue: m > 0 ? getMonthMetric(targetYear, m - 1, metric) : undefined,
        priorLabel: m > 0 ? MONTH_ABBR[m - 1] : undefined,
      });
    }

    if (p === 'Quarterly') {
      const quarters: BarData[] = [];
      for (let q = 0; q < 4; q++) {
        const qMonths = monthly.slice(q * 3, q * 3 + 3);
        const qVal = qMonths.reduce((s, m) => s + m.value, 0);
        const hasActual = qMonths.some(m => m.isActual);
        const hasCurrent = qMonths.some(m => m.isCurrent);
        quarters.push({
          label: `Q${q + 1}`,
          value: qVal,
          isActual: hasActual,
          isCurrent: hasCurrent,
          month: `${targetYear}-Q${q + 1}`,
          year: targetYear,
          priorValue: q > 0 ? quarters[q - 1].value : undefined,
          priorLabel: q > 0 ? quarters[q - 1].label : undefined,
        });
      }
      return quarters;
    }

    return monthly;
  }

  function annualBars(_current: number, _priorVal: number, useProjection = false): BarData[] {
    const metric = detectMetric(_current);

    // Same growth factors as Projections tab — identical formula
    const sf: Record<string, { r: number; e: number }> = {
      conservative: { r: 0.02, e: 0.03 },
      normal: { r: 0.04, e: 0.03 },
      bullish: { r: 0.06, e: 0.025 },
    };
    const f = sf[projectionStyle] || sf.normal;

    // Base: FY projected revenue/expenses — same source as Projections tab
    const baseAnnualRev = fyRevenue;
    const baseAnnualExp = fyExpenses;
    // Per-unit base (identical to generate30YearProjection)
    const revPerUnit = startingUnits > 0 ? baseAnnualRev / startingUnits : baseAnnualRev;
    const expPerUnit = startingUnits > 0 ? baseAnnualExp / startingUnits : baseAnnualExp;

    return years.map((y, idx) => {
      const yearsAhead = y - currentYear;
      let total = 0;

      if (yearsAhead <= 0 || !useProjection) {
        // Current or past year — use actual data
        if (metric === 'margin') {
          let totalRev = 0, totalExp = 0;
          for (let m = 0; m < 12; m++) {
            totalRev += getMonthMetric(y, m, 'revenue', useProjection);
            totalExp += getMonthMetric(y, m, 'expenses', useProjection);
          }
          total = totalRev > 0 ? ((totalRev - totalExp) / totalRev) * 100 : 0;
        } else {
          for (let m = 0; m < 12; m++) total += getMonthMetric(y, m, metric, useProjection);
        }
      } else {
        // Future year — EXACT same formula as generate30YearProjection
        const units = startingUnits + unitsPerYear * yearsAhead;
        const futRev = units * revPerUnit * Math.pow(1 + f.r, yearsAhead);
        const futExp = units * expPerUnit * Math.pow(1 + f.e, yearsAhead);

        if (metric === 'margin') {
          total = futRev > 0 ? ((futRev - futExp) / futRev) * 100 : 0;
        } else if (metric === 'net') {
          total = futRev - futExp;
        } else if (metric === 'expenses') {
          total = futExp;
        } else {
          total = futRev;
        }
      }

      const hasActual = Object.keys(monthlyActuals).some(k => k.startsWith(String(y)));
      const isCurrent = y === currentYear;
      return {
        label: String(y), value: total, isActual: hasActual || yearsAhead <= 0, isCurrent,
        year: y, month: String(y),
      };
    });
  }

  function displayValue(_current: number, _priorVal: number, selectedYear: number, p: Period): number {
    const metric = detectMetric(_current);
    const now = new Date();
    const curMonth = now.getMonth();

    if (metric === 'margin') {
      // Margin: compute from actual rev/exp totals
      let totalRev = 0, totalExp = 0;
      const startMonth = p === 'Quarterly' && selectedYear === currentYear
        ? Math.floor(curMonth / 3) * 3 : 0;
      const endMonth = p === 'Quarterly' && selectedYear === currentYear
        ? startMonth + 3 : (p === 'Monthly' ? curMonth + 1 : 12);
      for (let m = startMonth; m < endMonth; m++) {
        totalRev += getMonthMetric(selectedYear, m, 'revenue');
        totalExp += getMonthMetric(selectedYear, m, 'expenses');
      }
      return totalRev > 0 ? ((totalRev - totalExp) / totalRev) * 100 : 0;
    }

    if (p === 'Annual') {
      let total = 0;
      for (let m = 0; m < 12; m++) total += getMonthMetric(selectedYear, m, metric);
      return total;
    }
    if (p === 'Quarterly') {
      if (selectedYear === currentYear) {
        const q = Math.floor(curMonth / 3);
        let total = 0;
        for (let m = q * 3; m < q * 3 + 3; m++) total += getMonthMetric(selectedYear, m, metric);
        return total;
      }
      let total = 0;
      for (let m = 0; m < 12; m++) total += getMonthMetric(selectedYear, m, metric);
      return total;
    }
    // Monthly — show current month
    if (selectedYear === currentYear) {
      return getMonthMetric(selectedYear, curMonth, metric);
    }
    return getMonthMetric(selectedYear, curMonth, metric);
  }

  const revenueLabel = portfolioType === 'str' ? 'STR Revenue' : portfolioType === 'both' ? 'Total Revenue' : 'Revenue';
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

    // Pre-compute bar data so we can reference values for dynamic display
    const revBars = isAnnual ? annualBars(revenue, priorRev, true) : yearBars(revenue, priorRev, revYear, p, true);
    const expLineBars = isAnnual ? annualBars(expenses, priorExp, true) : yearBars(expenses, priorExp, revYear, p, true);
    // Actual expense bars (no projections) — for card header display only
    const expActualBars = isAnnual ? annualBars(expenses, priorExp) : yearBars(expenses, priorExp, revYear, p);
    const netBars = isAnnual ? annualBars(net, priorNet, true) : yearBars(net, priorNet, netYear, p, true);
    const marginLineBars = isAnnual ? annualBars(margin, priorMargin, true) : yearBars(margin, priorMargin, netYear, p, true);
    const marginActualBars = isAnnual ? annualBars(margin, priorMargin) : yearBars(margin, priorMargin, netYear, p);

    // Dynamic values: if a bar is selected, show ACTUAL value (no projections); otherwise show default
    const revDisplayVal = selectedRevBar != null && revBars[selectedRevBar]
      ? revBars[selectedRevBar].value
      : (isAnnual ? displayValue(revenue, priorRev, currentYear, p) : displayValue(revenue, priorRev, revYear, p));
    const expDisplayVal = selectedRevBar != null && expLineBars[selectedRevBar]
      ? expLineBars[selectedRevBar].value
      : (isAnnual ? displayValue(expenses, priorExp, currentYear, p) : displayValue(expenses, priorExp, revYear, p));
    const revDisplayLabel = selectedRevBar != null && revBars[selectedRevBar]
      ? revBars[selectedRevBar].label : null;
    const revIsProjection = selectedRevBar != null && revBars[selectedRevBar] && !revBars[selectedRevBar].isActual;

    const netDisplayVal = selectedNetBar != null && netBars[selectedNetBar]
      ? netBars[selectedNetBar].value
      : (isAnnual ? annualNetValue : displayValue(net, priorNet, netYear, p));
    const marginDisplayVal = selectedNetBar != null && marginLineBars[selectedNetBar]
      ? marginLineBars[selectedNetBar].value
      : (isAnnual ? margin : displayValue(margin, priorMargin, netYear, p));
    const netDisplayLabel = selectedNetBar != null && netBars[selectedNetBar]
      ? netBars[selectedNetBar].label : null;
    const netIsProjection = selectedNetBar != null && netBars[selectedNetBar] && !netBars[selectedNetBar].isActual;

    // Monthly / Quarterly / Annual shared layout
    return (
      <>
        {!isAnnual && (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.xs }}>
            <Text style={{ fontSize: 10, fontWeight: '700', color: Colors.textDim, letterSpacing: 0.5 }}>REVENUE / EXPENSES</Text>
            <YearChevrons years={years} selected={revYear} onSelect={(y) => { setRevYear(y); setSelectedRevBar(null); }} />
          </View>
        )}
        <Card padding={Spacing.sm}>
          <View style={styles.cardHeader}>
            <View style={styles.cardHeaderLabels}>
              <Text style={[styles.sectionLabel, { color: Colors.green }]}>{revenueLabel.toUpperCase()}</Text>
              <Text style={styles.sectionLabelSep}>/</Text>
              <Text style={[styles.sectionLabel, { color: Colors.red }]}>EXPENSES</Text>
              {revDisplayLabel && <Text style={styles.selectedLabel}>{revDisplayLabel}</Text>}
              {revIsProjection && <View style={styles.projBadge}><Text style={styles.projBadgeText}>Proj.</Text></View>}
            </View>
            <View style={styles.cardHeaderBadges}>
              <DeltaBadge value={pct.revenue} />
              <DeltaBadge value={pct.expenses} invert />
            </View>
          </View>
          <View style={styles.dualBigRow}>
            <Text style={styles.compactValue}>{fmt$(revDisplayVal)}</Text>
            <Text style={styles.bigValueSep}>/</Text>
            <Text style={[styles.compactValue, { color: Colors.red }]}>{fmt$(expDisplayVal)}</Text>
          </View>
          {isAnnual && unitsPerYear > 0 && (
            <Text style={{ fontSize: 9, color: Colors.textDim, marginBottom: Spacing.xs }}>
              Assuming +{unitsPerYear} unit{unitsPerYear !== 1 ? 's' : ''}/yr · {projectionStyle} growth
            </Text>
          )}
          <BarChart
            bars={revBars}
            overlayLine={{ data: expLineBars, color: Colors.red }}
            color={Colors.green}
            onBarTap={(_bar, idx) => setSelectedRevBar(idx)}
            onDismiss={() => setSelectedRevBar(null)}
            onDoubleTap={handleDoubleTap}
          />
        </Card>

        {!isAnnual && (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.xs, marginTop: Spacing.sm }}>
            <Text style={{ fontSize: 10, fontWeight: '700', color: Colors.textDim, letterSpacing: 0.5 }}>NET INCOME / MARGIN</Text>
            <YearChevrons years={years} selected={netYear} onSelect={(y) => { setNetYear(y); setSelectedNetBar(null); }} />
          </View>
        )}
        <Card padding={Spacing.sm}>
          <View style={styles.cardHeader}>
            <View style={styles.cardHeaderLabels}>
              <Text style={styles.sectionLabel}>NET INCOME</Text>
              <Text style={styles.sectionLabelSep}>/</Text>
              <Text style={[styles.sectionLabel, { color: Colors.primary }]}>MARGIN</Text>
              {netDisplayLabel && <Text style={styles.selectedLabel}>{netDisplayLabel}</Text>}
              {netIsProjection && <View style={styles.projBadge}><Text style={styles.projBadgeText}>Proj.</Text></View>}
            </View>
            <View style={styles.cardHeaderBadges}>
              <DeltaBadge value={pct.net} />
            </View>
          </View>
          <View style={styles.netRow}>
            <Text style={[styles.compactValue, {
              marginBottom: 0,
              color: netDisplayVal >= 0 ? Colors.green : Colors.red
            }]}>
              {fmt$(netDisplayVal)}
            </Text>
            <View style={styles.marginChip}>
              <Text style={styles.marginChipLabel}>MARGIN</Text>
              <Text style={[styles.marginChipValue, {
                color: marginDisplayVal >= 0 ? Colors.green : Colors.red
              }]}>
                {marginDisplayVal.toFixed(1)}%
              </Text>
            </View>
          </View>
          <BarChart
            bars={netBars}
            overlayLine={{ data: marginLineBars, color: Colors.primary }}
            color={Colors.green}
            showNegative
            onBarTap={(_bar, idx) => setSelectedNetBar(idx)}
            onDismiss={() => setSelectedNetBar(null)}
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

      </>
    );
  };

  return (
    <View style={styles.outerContainer}>
      {/* Horizontal paginated content — scrolls behind the sub-pill overlay */}
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
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={"#1A1A1A"} colors={["#1A1A1A"]} />}
              onTouchStart={dismissAllChartTooltips}
            >
              {renderPeriodContent(p)}
            </ScrollView>
          </View>
        ))}
      </Animated.ScrollView>

      {/* ── Frosted glass sub-pill overlay ── */}
      {!fixedPeriod && (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, paddingTop: 150, paddingBottom: 25, paddingHorizontal: Spacing.md }} pointerEvents="box-none">
          <LinearGradient
            colors={[
              'rgba(248,249,250,0.95)',
              'rgba(248,249,250,0.85)',
              'rgba(248,249,250,0.5)',
              'rgba(248,249,250,0)',
            ]}
            locations={[0, 0.65, 0.85, 1]}
            style={StyleSheet.absoluteFillObject}
            pointerEvents="none"
          />
          {error ? <Card style={[styles.errorCard, { marginBottom: Spacing.sm }]}><Text style={styles.error}>{error}</Text></Card> : null}
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
  content: { padding: Spacing.md, paddingTop: 195, paddingBottom: Spacing.xl },
  center: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },
  errorCard: { backgroundColor: Colors.redDim, borderColor: Colors.red + '30' },
  error: { color: Colors.red, fontSize: FontSize.sm },

  cardHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2,
  },
  sectionLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, letterSpacing: 0.8, fontWeight: '600' },
  bigValue: { fontSize: FontSize.xxl, fontWeight: '700', color: Colors.text, marginBottom: Spacing.xs },
  compactValue: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginBottom: 2 },

  cardRow: { flexDirection: 'row', gap: Spacing.sm },
  halfCard: { flex: 1 },
  miniLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '500', marginBottom: 4 },
  cardValue: { fontSize: FontSize.lg, fontWeight: '700' },
  miniSub: { fontSize: FontSize.xs, color: Colors.textDim, marginTop: 2 },

  // Compact revenue split chips
  chipCard: { flex: 1, paddingVertical: Spacing.xs, paddingHorizontal: Spacing.sm },
  chipRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chipLabel: { fontSize: FontSize.xs - 1, color: Colors.textSecondary, fontWeight: '600', letterSpacing: 0.3 },
  chipValue: { fontSize: FontSize.sm, fontWeight: '700' },

  // Combined rev/exp header
  cardHeaderLabels: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cardHeaderBadges: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  sectionLabelSep: { fontSize: FontSize.xs, color: Colors.textDim, fontWeight: '400' },
  selectedLabel: {
    fontSize: FontSize.xs - 1, fontWeight: '700', color: Colors.primary,
    marginLeft: 6, backgroundColor: Colors.greenDim, borderRadius: Radius.pill,
    paddingHorizontal: 6, paddingVertical: 1, overflow: 'hidden',
  },
  projBadge: {
    marginLeft: 4, backgroundColor: Colors.yellowDim, borderRadius: Radius.pill,
    paddingHorizontal: 5, paddingVertical: 1,
  },
  projBadgeText: {
    fontSize: 9, fontWeight: '700', color: Colors.yellow,
  },
  dualBigRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4, marginBottom: 2 },
  bigValueSep: { fontSize: FontSize.lg, fontWeight: '400', color: Colors.textDim },

  // Net income + margin row
  netRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 },
  marginChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: Colors.glassDark, borderRadius: Radius.pill,
    paddingHorizontal: 10, paddingVertical: 4,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
  },
  marginChipLabel: { fontSize: 9, fontWeight: '700', color: Colors.textDim, letterSpacing: 0.5 },
  marginChipValue: { fontSize: FontSize.sm, fontWeight: '700' },

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

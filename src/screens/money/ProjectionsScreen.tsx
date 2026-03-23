import React, { useState, useMemo, useCallback, useEffect } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
  TouchableOpacity, Platform, Dimensions, ActivityIndicator,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';

import { useUserStore } from '../../store/userStore';
import { useDataStore } from '../../store/dataStore';
import { useSubscriptionGate } from '../../hooks/useSubscriptionGate';
import { useProCheckout } from '../../hooks/useProCheckout';
import { Card } from '../../components/Card';
import { BarChart, BarData, dismissAllChartTooltips } from '../../components/BarChart';
import { fmt$, fmtCompact } from '../../utils/format';
import { generateYearTimeline } from '../../utils/projections';


const { width: SCREEN_W } = Dimensions.get('window');

// ── 30-Year Projection Engine ──

interface YearRow {
  year: number;
  yearOffset: number;
  units: number;
  revenue: number;
  expenses: number;
  netCF: number;
  portfolioValue: number;
  equity: number;
}

function generate30YearProjection(
  startingUnits: number,
  unitsPerYear: number,
  currentRevenue: number,     // monthly
  currentExpenses: number,    // monthly
  projectionStyle: string,
): YearRow[] {
  const curYear = new Date().getFullYear();
  const revenuePerUnit = startingUnits > 0 ? (currentRevenue * 12) / startingUnits : 0;
  const expensePerUnit = startingUnits > 0 ? (currentExpenses * 12) / startingUnits : 0;

  // Growth assumptions
  const styleFactors: Record<string, { revGrowth: number; expGrowth: number; appreciation: number }> = {
    conservative: { revGrowth: 0.02, expGrowth: 0.03, appreciation: 0.03 },
    normal:       { revGrowth: 0.04, expGrowth: 0.03, appreciation: 0.04 },
    bullish:      { revGrowth: 0.06, expGrowth: 0.025, appreciation: 0.06 },
  };
  const factors = styleFactors[projectionStyle] || styleFactors.normal;

  const valuePerUnit = 150000; // avg property value assumption
  const ltv = 0.75; // loan-to-value
  const mortgageRate = 0.065; // 6.5% annual
  const years: YearRow[] = [];

  for (let i = 0; i <= 30; i += 5) {
    const yearOffset = i;
    const year = curYear + i;
    const units = startingUnits + unitsPerYear * i;

    // Revenue and expenses grow per unit and with more units
    const revPerUnit = revenuePerUnit * Math.pow(1 + factors.revGrowth, i);
    const expPerUnit = expensePerUnit * Math.pow(1 + factors.expGrowth, i);
    const revenue = units * revPerUnit;
    const expenses = units * expPerUnit;

    // Mortgage cost for financed units (only units added after year 0)
    const addedUnits = Math.max(0, units - startingUnits);
    const mortgageCost = addedUnits * valuePerUnit * ltv * mortgageRate;

    const netCF = revenue - expenses - mortgageCost;

    // Portfolio value with appreciation
    const portfolioValue = units * valuePerUnit * Math.pow(1 + factors.appreciation, i);

    // Equity = value minus outstanding mortgage on added units
    // Simplified: assume each property gains equity via appreciation + principal paydown
    const outstandingMortgage = addedUnits * valuePerUnit * ltv * Math.max(0, 1 - i * 0.033); // ~3.3% principal paydown/yr
    const equity = portfolioValue - outstandingMortgage;

    years.push({ year, yearOffset, units, revenue, expenses, netCF, portfolioValue, equity });
  }

  return years;
}

// ── Milestone Cards ──

// ── Wealth Builder Card — cumulative revenue + portfolio value over time ──
function WealthBuilderCard({ data }: { data: YearRow[] }) {
  if (data.length < 2) return null;

  // Annual revenue at each milestone — shows growth trajectory clearly
  const revBars: BarData[] = data.map((row, i) => ({
    label: `Yr${row.yearOffset}`,
    value: row.revenue,
    isActual: row.yearOffset === 0,
    isCurrent: row.yearOffset === 0,
    priorValue: i > 0 ? data[i - 1].revenue : undefined,
    priorLabel: i > 0 ? `Yr${data[i - 1].yearOffset}` : undefined,
  }));

  // Total cumulative for display
  const cumulativeRev = data.reduce((s, r) => s + r.revenue * 5, 0); // ~5yr per interval


  // Key milestones
  const yr10 = data.find(r => r.yearOffset === 10);
  const yr20 = data.find(r => r.yearOffset === 20);
  const yr30 = data.find(r => r.yearOffset === 30);

  return (
    <Card>
      <Text style={wbStyles.title}>Wealth Accumulation</Text>
      <Text style={wbStyles.subtitle}>Annual revenue at each milestone</Text>
      <BarChart
        bars={revBars}
        color={Colors.green}
        height={140}
      />
      <View style={wbStyles.milestonesRow}>
        {yr10 && (
          <View style={wbStyles.milestone}>
            <Text style={wbStyles.milestoneLabel}>YEAR 10</Text>
            <Text style={wbStyles.milestoneUnits}>{yr10.units} units</Text>
            <Text style={wbStyles.milestoneValue}>{fmtCompact(yr10.portfolioValue)}</Text>
            <Text style={wbStyles.milestoneSub}>portfolio</Text>
          </View>
        )}
        {yr20 && (
          <View style={wbStyles.milestone}>
            <Text style={wbStyles.milestoneLabel}>YEAR 20</Text>
            <Text style={wbStyles.milestoneUnits}>{yr20.units} units</Text>
            <Text style={wbStyles.milestoneValue}>{fmtCompact(yr20.portfolioValue)}</Text>
            <Text style={wbStyles.milestoneSub}>portfolio</Text>
          </View>
        )}
        {yr30 && (
          <View style={wbStyles.milestone}>
            <Text style={wbStyles.milestoneLabel}>YEAR 30</Text>
            <Text style={wbStyles.milestoneUnits}>{yr30.units} units</Text>
            <Text style={wbStyles.milestoneValue}>{fmtCompact(yr30.portfolioValue)}</Text>
            <Text style={wbStyles.milestoneSub}>portfolio</Text>
          </View>
        )}
      </View>
      <View style={wbStyles.totalRow}>
        <Text style={wbStyles.totalLabel}>Est. 30yr total revenue</Text>
        <Text style={wbStyles.totalValue}>{fmtCompact(cumulativeRev)}</Text>
      </View>
      <View style={wbStyles.totalRow}>
        <Text style={wbStyles.totalLabel}>30yr total equity</Text>
        <Text style={[wbStyles.totalValue, { color: Colors.green }]}>{fmtCompact(yr30?.equity || 0)}</Text>
      </View>
    </Card>
  );
}

const wbStyles = StyleSheet.create({
  title: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  subtitle: { fontSize: FontSize.xs, color: Colors.textDim, marginBottom: Spacing.md },
  milestonesRow: {
    flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.md,
  },
  milestone: {
    flex: 1, alignItems: 'center', paddingVertical: Spacing.sm,
    backgroundColor: Colors.glassDark, borderRadius: Radius.md,
    borderWidth: 0.5, borderColor: Colors.glassBorder,
  },
  milestoneLabel: { fontSize: 8, fontWeight: '800', color: Colors.textDim, letterSpacing: 0.5 },
  milestoneUnits: { fontSize: 10, color: Colors.textSecondary, marginBottom: 2 },
  milestoneValue: { fontSize: FontSize.md, fontWeight: '800', color: Colors.green },
  milestoneSub: { fontSize: 8, color: Colors.textDim },
  totalRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingTop: Spacing.xs, marginTop: Spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border,
  },
  totalLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },
  totalValue: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text },
});

// ── Projection Bar Chart using shared BarChart ──

function ProjectionBarChartCard({ data }: { data: YearRow[] }) {
  const projBars: BarData[] = data.map((row, i) => ({
    label: `Yr${row.yearOffset}`,
    value: row.netCF,
    isActual: true,
    isCurrent: row.yearOffset === 0,
    priorValue: i > 0 ? data[i - 1].netCF : undefined,
    priorLabel: i > 0 ? `Yr${data[i - 1].yearOffset}` : undefined,
  }));

  return (
    <Card>
      <Text style={projBarStyles.title}>Annual Net Cash Flow</Text>
      <BarChart
        bars={projBars}
        color={Colors.green}
        height={140}
        showNegative
      />
      <View style={projBarStyles.footer}>
        <Text style={projBarStyles.footerText}>
          Yr 30 value <Text style={{ color: Colors.green, fontWeight: '700' }}>{fmtCompact(data[data.length - 1]?.portfolioValue || 0)}</Text>
        </Text>
        <Text style={projBarStyles.footerText}>
          Equity <Text style={{ color: Colors.green, fontWeight: '700' }}>{fmtCompact(data[data.length - 1]?.equity || 0)}</Text>
        </Text>
      </View>
    </Card>
  );
}

const projBarStyles = StyleSheet.create({
  title: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginBottom: Spacing.md },
  footer: {
    flexDirection: 'row', justifyContent: 'space-between',
    marginTop: Spacing.md, paddingTop: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border,
  },
  footerText: { fontSize: FontSize.sm, color: Colors.textSecondary },
});

// ── Main Projections Screen ──

export function ProjectionsScreen() {
  const { isReadOnly } = useSubscriptionGate();
  const checkout = useProCheckout();
  const profile = useUserStore(s => s.profile);
  const setProfile = useUserStore(s => s.setProfile);
  const { fetchCockpit } = useDataStore();
  const [cockpit, setCockpit] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const projStyle = profile?.projectionStyle || 'normal';
  const startingUnits = (profile?.properties || []).reduce((sum, p) => sum + (p.units || 1), 0);
  const savedUnitsPerYear = profile?.unitsPerYear ?? 0;
  const [unitsPerYear, setUnitsPerYear] = useState(savedUnitsPerYear);

  // Reset to saved value when screen regains focus or profile changes
  useEffect(() => {
    setUnitsPerYear(savedUnitsPerYear);
  }, [savedUnitsPerYear]);

  const load = useCallback(async (force = false) => {
    try {
      setError(null);
      const c = await fetchCockpit(force);
      setCockpit(c);
    } catch (err: any) {
      setError('Could not load projection data. Pull down to retry.');
    } finally { setLoading(false); setRefreshing(false); }
  }, [fetchCockpit]);

  useEffect(() => { load(); }, []);

  const dataVersion = useDataStore(s => s.dataVersion);
  useEffect(() => { if (dataVersion > 0) load(true); }, [dataVersion]);
  const onRefresh = () => { setRefreshing(true); load(true); };

  // Current actuals
  const kpis = cockpit?.kpis || {};
  const revenue = kpis.revenue_mtd ?? 0;
  const expenses = kpis.expenses_mtd ?? 0;
  const net = revenue - expenses;
  const prior = cockpit?.prior || {};
  const priorRev = prior.revenue ?? 0;

  // YTD — sum actual months from timeline (not MTD × month count)
  const curMonth = new Date().getMonth() + 1; // 1-indexed
  const ytdRevenue = useMemo(() => {
    const timeline = generateYearTimeline(revenue, priorRev, projStyle, new Date().getFullYear());
    return timeline.filter(m => m.month < curMonth).reduce((s, m) => s + m.value, 0) + revenue;
  }, [revenue, priorRev, projStyle, curMonth]);
  const ytdExpenses = useMemo(() => {
    const timeline = generateYearTimeline(expenses, prior.expenses ?? 0, projStyle, new Date().getFullYear());
    return timeline.filter(m => m.month < curMonth).reduce((s, m) => s + m.value, 0) + expenses;
  }, [expenses, prior.expenses, projStyle, curMonth]);
  const ytdNet = ytdRevenue - ytdExpenses;
  const ytdMargin = ytdRevenue > 0 ? (ytdNet / ytdRevenue) * 100 : 0;

  // FY Projected (annualized from current month)
  const fyRevenue = useMemo(() => {
    const timeline = generateYearTimeline(revenue, priorRev, projStyle, new Date().getFullYear());
    return timeline.reduce((s, m) => s + m.value, 0);
  }, [revenue, priorRev, projStyle]);
  const fyExpenses = useMemo(() => {
    const timeline = generateYearTimeline(expenses, prior.expenses ?? 0, projStyle, new Date().getFullYear());
    return timeline.reduce((s, m) => s + m.value, 0);
  }, [expenses, prior.expenses, projStyle]);
  const fyNet = fyRevenue - fyExpenses;
  const fyMargin = fyRevenue > 0 ? (fyNet / fyRevenue) * 100 : 0;

  // Prior FY annualized
  const priorFYRev = (prior.revenue ?? 0) * 12;
  const yoyDiff = fyRevenue - priorFYRev;
  const yoyPct = priorFYRev > 0 ? (yoyDiff / priorFYRev) * 100 : 0;

  // 30-year projection — pass monthly equivalent of FY totals
  // generate30YearProjection internally does (monthly * 12 / units) to get per-unit annual
  const projection = useMemo(
    () => generate30YearProjection(startingUnits, unitsPerYear, fyRevenue / 12, fyExpenses / 12, projStyle),
    [startingUnits, unitsPerYear, fyRevenue, fyExpenses, projStyle],
  );

  const handleUnitsChange = (delta: number) => {
    const next = Math.max(0, unitsPerYear + delta);
    setUnitsPerYear(next);
    setProfile({ unitsPerYear: next });
  };

  const hasPlaid = !!profile?.plaidConnected;
  const hasAnySource = hasPlaid || revenue > 0 || expenses > 0;

  if (isReadOnly) {
    return (
      <View style={styles.lockedContainer}>
        <View style={styles.lockedCircle}>
          <Ionicons name="lock-closed" size={36} color={Colors.textDim} />
        </View>
        <Text style={styles.lockedTitle}>Unlock Projections</Text>
        <Text style={styles.lockedDesc}>
          Subscribe to Pro to access full financial projections, 30-year portfolio modeling, and year-over-year comparisons.
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
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={"#1A1A1A"} colors={["#1A1A1A"]} />}
      onTouchStart={dismissAllChartTooltips}
      {...({delaysContentTouches: false} as any)}
    >
      {error && (
        <View style={styles.errorBanner}>
          <Ionicons name="cloud-offline-outline" size={16} color={Colors.red} />
          <Text style={styles.errorBannerText}>{error}</Text>
        </View>
      )}
      {!hasAnySource && (
        <View style={styles.emptyBanner}>
          <Ionicons name="information-circle-outline" size={18} color={Colors.textDim} />
          <Text style={styles.emptyBannerText}>
            Connect Plaid or enter manual income in Settings to generate projections based on your actual numbers.
          </Text>
        </View>
      )}

      {/* ── YTD vs Projected ── */}
      <Card>
        <View style={styles.ytdHeader}>
          <Text style={styles.sectionLabel}>YTD · {curMonth}MO ACTUAL</Text>
          <Text style={[styles.sectionLabel, { color: Colors.primary }]}>{new Date().getFullYear()} PROJECTED</Text>
        </View>

        {[
          { label: 'Revenue', actual: ytdRevenue, projected: fyRevenue, color: Colors.green },
          { label: 'Expenses', actual: ytdExpenses, projected: fyExpenses, color: Colors.red },
          { label: 'Net', actual: ytdNet, projected: fyNet, color: ytdNet >= 0 ? Colors.green : Colors.red },
          { label: 'Margin', actual: ytdMargin, projected: fyMargin, isPercent: true },
        ].map((row, i) => (
          <View key={row.label} style={[styles.ytdRow, i > 0 && styles.ytdRowBorder]}>
            <Text style={styles.ytdLabel}>{row.label}</Text>
            <Text style={[styles.ytdActual, { color: row.color || (row.actual as number >= 0 ? Colors.text : Colors.red) }]}>
              {row.isPercent ? `${(row.actual as number).toFixed(1)}%` : fmt$(row.actual as number)}
            </Text>
            <Text style={[styles.ytdProjected, { color: row.color || Colors.primary }]}>
              {row.isPercent ? `${(row.projected as number).toFixed(1)}%` : fmt$(row.projected as number)}
            </Text>
          </View>
        ))}

        <View style={[styles.ytdRow, styles.ytdRowBorder]}>
          <Text style={styles.ytdLabel}>vs FY {new Date().getFullYear() - 1} (ann. {curMonth}mo)</Text>
          <View />
          <Text style={[styles.ytdYoy, { color: yoyDiff >= 0 ? Colors.green : Colors.red }]}>
            {yoyDiff >= 0 ? '▲' : '▼'} {fmt$(Math.abs(yoyDiff))} ({yoyPct >= 0 ? '+' : ''}{yoyPct.toFixed(1)}%)
          </Text>
        </View>
      </Card>

      {/* ── 30-Year Projection Header ── */}
      <Card>
        <View style={styles.projHeader}>
          <Text style={styles.projTitle}>30-Year Projection</Text>
          <View style={styles.unitsControl}>
            <TouchableOpacity activeOpacity={0.7}
          style={styles.unitBtn}
              onPress={() => handleUnitsChange(-1)}
            >
              <Ionicons name="remove" size={16} color={Colors.textSecondary} />
            </TouchableOpacity>
            <Text style={styles.unitsText}>{unitsPerYear} units/yr</Text>
            <TouchableOpacity activeOpacity={0.7}
          style={styles.unitBtn}
              onPress={() => handleUnitsChange(1)}
            >
              <Ionicons name="add" size={16} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.projSummary}>
          <Text style={styles.projSummaryText}>
            Portfolio value: <Text style={{ fontWeight: '700' }}>{fmtCompact(projection[0]?.portfolioValue || 0)}</Text>
          </Text>
          <Text style={styles.projSummaryText}>
            Equity today: <Text style={{ fontWeight: '700', color: Colors.green }}>{fmtCompact(projection[0]?.equity || 0)}</Text>
          </Text>
          <Text style={styles.projSummaryText}>
            Current units: <Text style={{ fontWeight: '700' }}>{startingUnits}</Text>
          </Text>
        </View>

        {/* Year-by-year table */}
        <View style={styles.tableHeader}>
          <Text style={[styles.tableHeaderCell, { flex: 0.8 }]}>YEAR</Text>
          <Text style={[styles.tableHeaderCell, { flex: 0.7 }]}>UNITS</Text>
          <Text style={styles.tableHeaderCell}>REVENUE</Text>
          <Text style={styles.tableHeaderCell}>NET CF</Text>
          <Text style={styles.tableHeaderCell}>VALUE</Text>
        </View>
        {projection.map((row, i) => (
          <View key={row.year} style={[styles.tableRow, i % 2 === 0 && styles.tableRowAlt]}>
            <Text style={[styles.tableCell, styles.tableCellBold, { flex: 0.8 }]}>{row.year}</Text>
            <Text style={[styles.tableCell, { flex: 0.7 }]}>{row.units}</Text>
            <Text style={[styles.tableCell, { color: Colors.green }]}>{fmtCompact(row.revenue)}</Text>
            <Text style={[styles.tableCell, { color: Colors.green }]}>{fmtCompact(row.netCF)}</Text>
            <Text style={[styles.tableCell, { color: Colors.green }]}>{fmtCompact(row.portfolioValue)}</Text>
          </View>
        ))}
      </Card>

      {/* ── Wealth Accumulation Chart ── */}
      <WealthBuilderCard data={projection} />

      {/* ── Net Cash Flow Bar Chart ── */}
      <ProjectionBarChartCard data={projection} />

      {/* ── Projection Note ── */}
      <View style={styles.noteRow}>
        <Ionicons name="analytics-outline" size={14} color={Colors.textDim} />
        <Text style={styles.noteText}>
          Based on {projStyle} projections · {unitsPerYear} units acquired per year
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  content: { padding: Spacing.md, paddingTop: 160, paddingBottom: Spacing.xl * 2 },

  // YTD table
  sectionLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, letterSpacing: 0.8, fontWeight: '600' },
  ytdHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: Spacing.sm },
  ytdRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: Spacing.sm,
  },
  ytdRowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border },
  ytdLabel: { flex: 1, fontSize: FontSize.sm, color: Colors.textSecondary },
  ytdActual: { flex: 1, fontSize: FontSize.md, fontWeight: '700', textAlign: 'center' },
  ytdProjected: { flex: 1, fontSize: FontSize.md, fontWeight: '700', textAlign: 'right' },
  ytdYoy: { flex: 2, fontSize: FontSize.sm, fontWeight: '600', textAlign: 'right' },

  // Projection header
  projHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.sm },
  projTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  unitsControl: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  unitBtn: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: Colors.glassDark, borderWidth: 0.5, borderColor: Colors.glassBorder,
    alignItems: 'center', justifyContent: 'center',
  },
  unitsText: { fontSize: FontSize.sm, color: Colors.textSecondary },

  // Projection summary
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

  // Empty banner
  emptyBanner: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.glassDark, borderRadius: Radius.md,
    padding: Spacing.sm, marginBottom: Spacing.md,
  },
  emptyBannerText: {
    fontSize: FontSize.xs, color: Colors.textDim, flex: 1, lineHeight: 16,
  },

  loadingContainer: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },
  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: 'rgba(239,68,68,0.08)', borderRadius: Radius.md,
    padding: Spacing.sm, marginBottom: Spacing.md, borderWidth: 0.5, borderColor: 'rgba(239,68,68,0.20)',
  },
  errorBannerText: { fontSize: FontSize.xs, color: Colors.red, flex: 1, lineHeight: 16 },

  // Note
  noteRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: Spacing.sm,
  },
  noteText: { fontSize: 11, color: Colors.textDim, fontStyle: 'italic' },

  // Locked state
  lockedContainer: {
    flex: 1, backgroundColor: Colors.bg,
    alignItems: 'center', justifyContent: 'center',
    padding: Spacing.xl,
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

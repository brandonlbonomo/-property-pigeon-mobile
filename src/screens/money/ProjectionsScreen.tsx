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
import { generateYearTimeline, generate30YearProjection, YearRow } from '../../utils/projections';

import { ScenarioComparison } from './projections/ScenarioComparison';
import { BreakEvenCalculator } from './projections/BreakEvenCalculator';
import { RefiModeler } from './projections/RefiModeler';
import { DebtPaydownCurve } from './projections/DebtPaydownCurve';
import { MonteCarloBand } from './projections/MonteCarloBand';
import { TaxDragEstimate } from './projections/TaxDragEstimate';

const { width: SCREEN_W } = Dimensions.get('window');
const INFLATION_RATE = 0.03;

function realVal(nominal: number, yearOffset: number, adjusted: boolean): number {
  if (!adjusted || yearOffset === 0) return nominal;
  return nominal / Math.pow(1 + INFLATION_RATE, yearOffset);
}

// ── Milestone Cards ──

function MilestoneCard({ row, inflationAdjusted }: { row: YearRow; inflationAdjusted: boolean }) {
  const netCF = realVal(row.netCF, row.yearOffset, inflationAdjusted);
  const value = realVal(row.portfolioValue, row.yearOffset, inflationAdjusted);
  return (
    <View style={milestoneStyles.card}>
      <Text style={milestoneStyles.yearLabel}>YEAR {row.yearOffset}</Text>
      <Text style={milestoneStyles.units}>{row.units} units</Text>
      <Text style={milestoneStyles.netCF}>{fmtCompact(netCF)}</Text>
      <Text style={milestoneStyles.netCFLabel}>net CF/yr{inflationAdjusted ? ' (real)' : ''}</Text>
      <Text style={milestoneStyles.value}>{fmtCompact(value)}</Text>
      <Text style={milestoneStyles.valueLabel}>portfolio value</Text>
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
  units: { fontSize: 11, color: Colors.textSecondary, marginBottom: 4 },
  netCF: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.green },
  netCFLabel: { fontSize: 9, color: Colors.textDim, marginBottom: 6 },
  value: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },
  valueLabel: { fontSize: 9, color: Colors.textDim },
});

// ── Projection Bar Chart using shared BarChart ──

function ProjectionBarChartCard({ data, inflationAdjusted }: { data: YearRow[]; inflationAdjusted: boolean }) {
  const projBars: BarData[] = data.map((row, i) => {
    const val = realVal(row.netCF, row.yearOffset, inflationAdjusted);
    const priorVal = i > 0 ? realVal(data[i - 1].netCF, data[i - 1].yearOffset, inflationAdjusted) : undefined;
    return {
      label: `Yr${row.yearOffset}`,
      value: val,
      isActual: true,
      isCurrent: row.yearOffset === 0,
      priorValue: priorVal,
      priorLabel: i > 0 ? `Yr${data[i - 1].yearOffset}` : undefined,
    };
  });

  const lastRow = data[data.length - 1];
  const displayValue = realVal(lastRow?.portfolioValue || 0, lastRow?.yearOffset || 30, inflationAdjusted);
  const displayEquity = realVal(lastRow?.equity || 0, lastRow?.yearOffset || 30, inflationAdjusted);

  return (
    <Card>
      <Text style={projBarStyles.title}>
        Annual Net Cash Flow{inflationAdjusted ? ' (Real $)' : ''}
      </Text>
      <BarChart
        bars={projBars}
        color={Colors.green}
        height={140}
        showNegative
      />
      <View style={projBarStyles.footer}>
        <Text style={projBarStyles.footerText}>
          Yr 30 value <Text style={{ color: Colors.green, fontWeight: '700' }}>{fmtCompact(displayValue)}</Text>
        </Text>
        <Text style={projBarStyles.footerText}>
          Equity <Text style={{ color: Colors.green, fontWeight: '700' }}>{fmtCompact(displayEquity)}</Text>
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
  const [inflationAdjusted, setInflationAdjusted] = useState(false);

  const projStyle = profile?.projectionStyle || 'normal';
  const startingUnits = (profile?.properties || []).reduce((sum, p) => sum + (p.units || 1), 0);
  const savedUnitsPerYear = profile?.unitsPerYear ?? 0;
  const [unitsPerYear, setUnitsPerYear] = useState(savedUnitsPerYear);

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

  // YTD
  const curMonth = new Date().getMonth() + 1;
  const ytdRevenue = revenue * curMonth;
  const ytdExpenses = expenses * curMonth;
  const ytdNet = ytdRevenue - ytdExpenses;
  const ytdMargin = ytdRevenue > 0 ? (ytdNet / ytdRevenue) * 100 : 0;

  // FY Projected
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

  // Prior FY
  const priorFYRev = (prior.revenue ?? 0) * 12;
  const yoyDiff = fyRevenue - priorFYRev;
  const yoyPct = priorFYRev > 0 ? (yoyDiff / priorFYRev) * 100 : 0;

  // 30-year projection
  const projection = useMemo(
    () => generate30YearProjection(startingUnits, unitsPerYear, revenue, expenses, projStyle),
    [startingUnits, unitsPerYear, revenue, expenses, projStyle],
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
          <View style={styles.projHeaderRight}>
            {/* Inflation toggle */}
            <TouchableOpacity
              activeOpacity={0.7}
              style={[styles.inflationToggle, inflationAdjusted && styles.inflationToggleActive]}
              onPress={() => setInflationAdjusted(v => !v)}
            >
              <Text style={[styles.inflationToggleText, inflationAdjusted && styles.inflationToggleTextActive]}>
                {inflationAdjusted ? 'Real $' : 'Nominal'}
              </Text>
            </TouchableOpacity>
            {/* Units control */}
            <View style={styles.unitsControl}>
              <TouchableOpacity activeOpacity={0.7} style={styles.unitBtn} onPress={() => handleUnitsChange(-1)}>
                <Ionicons name="remove" size={16} color={Colors.textSecondary} />
              </TouchableOpacity>
              <Text style={styles.unitsText}>{unitsPerYear} units/yr</Text>
              <TouchableOpacity activeOpacity={0.7} style={styles.unitBtn} onPress={() => handleUnitsChange(1)}>
                <Ionicons name="add" size={16} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>
          </View>
        </View>

        {inflationAdjusted && (
          <View style={styles.inflationBanner}>
            <Ionicons name="information-circle-outline" size={13} color={Colors.textDim} />
            <Text style={styles.inflationBannerText}>
              Showing real (inflation-adjusted) values at 3%/yr · {new Date().getFullYear()} dollars
            </Text>
          </View>
        )}

        <View style={styles.projSummary}>
          <Text style={styles.projSummaryText}>
            Portfolio value: <Text style={{ fontWeight: '700' }}>{fmtCompact(projection[0]?.portfolioValue || 0)}</Text>
          </Text>
          <Text style={styles.projSummaryText}>
            Equity today: <Text style={{ fontWeight: '700', color: Colors.green }}>{fmtCompact(projection[0]?.equity || 0)}</Text>
          </Text>
          <Text style={styles.projSummaryText}>
            Starting units: <Text style={{ fontWeight: '700' }}>{startingUnits}</Text>
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
            <Text style={[styles.tableCell, { color: Colors.green }]}>
              {fmtCompact(realVal(row.revenue, row.yearOffset, inflationAdjusted))}
            </Text>
            <Text style={[styles.tableCell, { color: Colors.green }]}>
              {fmtCompact(realVal(row.netCF, row.yearOffset, inflationAdjusted))}
            </Text>
            <Text style={[styles.tableCell, { color: Colors.green }]}>
              {fmtCompact(realVal(row.portfolioValue, row.yearOffset, inflationAdjusted))}
            </Text>
          </View>
        ))}
      </Card>

      {/* ── Milestone Cards ── */}
      <Text style={styles.milestoneTitle}>30-Year Portfolio Projection</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.milestoneScroll}>
        {projection.filter(r => r.yearOffset > 0).map(row => (
          <View key={row.yearOffset} style={{ marginRight: Spacing.sm }}>
            <MilestoneCard row={row} inflationAdjusted={inflationAdjusted} />
          </View>
        ))}
      </ScrollView>

      {/* ── Bar Chart ── */}
      <ProjectionBarChartCard data={projection} inflationAdjusted={inflationAdjusted} />

      {/* ── Projection Note ── */}
      <View style={styles.noteRow}>
        <Ionicons name="analytics-outline" size={14} color={Colors.textDim} />
        <Text style={styles.noteText}>
          Based on {projStyle} projections · {unitsPerYear} units acquired per year
          {inflationAdjusted ? ' · 3% inflation deflator' : ''}
        </Text>
      </View>

      {/* ── Advanced Features ── */}
      <View style={styles.advancedHeader}>
        <Text style={styles.advancedTitle}>Advanced Analysis</Text>
        <Text style={styles.advancedSubtitle}>Tap any section to expand</Text>
      </View>

      <ScenarioComparison
        startingUnits={startingUnits}
        currentUnitsPerYear={unitsPerYear}
        revenue={revenue}
        expenses={expenses}
        projStyle={projStyle}
      />

      <MonteCarloBand projection={projection} />

      <DebtPaydownCurve projection={projection} />

      <BreakEvenCalculator
        properties={profile?.properties || []}
        monthlyRevenue={revenue}
        monthlyExpenses={expenses}
        startingUnits={startingUnits}
      />

      <RefiModeler
        projection={projection}
        startingUnits={startingUnits}
        unitsPerYear={unitsPerYear}
        revenue={revenue}
        expenses={expenses}
        projStyle={projStyle}
      />

      <TaxDragEstimate projection={projection} startingUnits={startingUnits} />
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
  projHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },

  // Inflation toggle
  inflationToggle: {
    paddingHorizontal: Spacing.sm, paddingVertical: 5,
    backgroundColor: Colors.glassDark,
    borderRadius: Radius.pill, borderWidth: 0.5, borderColor: Colors.border,
  },
  inflationToggleActive: { backgroundColor: Colors.greenDim, borderColor: Colors.green },
  inflationToggleText: { fontSize: 11, fontWeight: '700', color: Colors.textSecondary, letterSpacing: 0.2 },
  inflationToggleTextActive: { color: Colors.green },
  inflationBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: Colors.greenDim, borderRadius: Radius.md,
    padding: Spacing.xs, paddingHorizontal: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  inflationBannerText: { fontSize: 11, color: Colors.textSecondary, flex: 1 },

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
  noteText: { fontSize: 11, color: Colors.textDim, fontStyle: 'italic', flex: 1 },

  // Advanced section header
  advancedHeader: {
    flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between',
    marginTop: Spacing.md, marginBottom: Spacing.sm,
  },
  advancedTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  advancedSubtitle: { fontSize: FontSize.xs, color: Colors.textDim },

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

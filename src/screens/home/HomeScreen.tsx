import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
  ActivityIndicator, Platform, TouchableOpacity,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { GradientHeader } from '../../components/GradientHeader';
import { useDataStore } from '../../store/dataStore';
import { useUserStore } from '../../store/userStore';
import { fmt$, fmtDate } from '../../utils/format';
import { GlossyHorizontalBar } from '../../components/GlossyHorizontalBar';
import { MonthDetailModal } from '../../components/MonthDetailModal';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export function HomeScreen() {
  const profile = useUserStore(s => s.profile);
  const portfolioType = profile?.portfolioType;
  const { fetchCockpit, fetchCalendarEvents, fetchInvGroups, fetchAnalytics } = useDataStore();
  const lastError = useDataStore(s => s.lastError);
  const [cockpit, setCockpit] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [invGroups, setInvGroups] = useState<any[]>([]);
  const [analytics, setAnalytics] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [drillDownMonth, setDrillDownMonth] = useState<string | null>(null);

  const isSTR = portfolioType === 'str' || portfolioType === 'both';
  const isLTR = portfolioType === 'ltr';
  const properties = profile?.properties || [];

  const load = useCallback(async (force = false) => {
    try {
      const results = await Promise.all([
        fetchCockpit(force),
        isSTR ? fetchCalendarEvents(force).catch(() => []) : Promise.resolve([]),
        isSTR ? fetchInvGroups(force).catch(() => []) : Promise.resolve([]),
        isSTR ? fetchAnalytics(force).catch(() => null) : Promise.resolve(null),
      ]);
      setCockpit(results[0]);
      setEvents(results[1] || []);
      setInvGroups(results[2] || []);
      setAnalytics(results[3]);
    } catch (err: any) {
      // load failed
    }
    setLoading(false);
    setRefreshing(false);
  }, [fetchCockpit, fetchCalendarEvents, fetchInvGroups, fetchAnalytics, isSTR]);

  useEffect(() => { load(); }, []);

  // Auto-reload when cockpit cache is invalidated (e.g. after tagging)
  const cockpitCache = useDataStore(s => s.cockpit);
  useEffect(() => {
    if (!cockpitCache && !loading) load(true);
  }, [cockpitCache]);

  const onRefresh = () => { setRefreshing(true); load(true); };

  // Derived data — all hooks must be above early returns
  const kpis = cockpit?.kpis || {};
  const prior = cockpit?.prior || {};
  const now = new Date();

  const revenue = kpis.revenue_mtd ?? 0;
  const expenses = kpis.expenses_mtd ?? 0;
  const net = kpis.net_mtd ?? 0;
  const priorRev = prior.revenue ?? 0;
  // Occupancy data (STR only)
  const upcomingCheckins = useMemo(() => {
    if (!isSTR || !events.length) return [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekOut = new Date(today);
    weekOut.setDate(weekOut.getDate() + 14);
    return events.filter((e: any) => {
      const checkIn = new Date(e.check_in || e.start);
      return checkIn >= today && checkIn <= weekOut;
    });
  }, [events, isSTR]);

  const activeStays = useMemo(() => {
    if (!isSTR || !events.length) return 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return events.filter((e: any) => {
      const checkIn = new Date(e.check_in || e.start);
      const checkOut = new Date(e.check_out || e.end);
      return checkIn <= today && checkOut >= today;
    }).length;
  }, [events, isSTR]);

  // Cleanings data (STR only) - check-outs within 7 days
  const upcomingCleanings = useMemo(() => {
    if (!isSTR || !events.length) return 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekOut = new Date(today);
    weekOut.setDate(weekOut.getDate() + 7);
    return events.filter((e: any) => {
      const checkOut = new Date(e.check_out || e.end);
      return checkOut >= today && checkOut <= weekOut;
    }).length;
  }, [events, isSTR]);

  // Inventory data (STR only)
  const inventoryStats = useMemo(() => {
    if (!isSTR || !invGroups.length) return null;
    let totalItems = 0;
    let lowItems = 0;
    for (const group of invGroups) {
      for (const item of (group.items || [])) {
        totalItems++;
        const restocks = (item.restocks || []).reduce((s: number, r: any) => s + (r.qty || 0), 0);
        const currentQty = (item.initialQty || 0) + restocks;
        if (currentQty <= (item.threshold || 0)) lowItems++;
      }
    }
    return totalItems > 0 ? { totalItems, lowItems } : null;
  }, [invGroups, isSTR]);

  const nextCheckinDate = upcomingCheckins.length > 0
    ? fmtDate(upcomingCheckins[0].check_in || upcomingCheckins[0].start)
    : null;

  if (loading && !profile?.properties?.length) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.green} />
      </View>
    );
  }

  const hasPlaid = !!profile?.plaidConnected;
  const hasAnySource = hasPlaid || revenue !== 0 || expenses !== 0;
  const hasData = revenue !== 0 || expenses !== 0;

  // FY annualized (rough: current month x 12)
  const fyCurrentAnnual = revenue * 12;
  const fyPriorAnnual = priorRev * 12;

  // Quarter
  const currentQ = Math.ceil((now.getMonth() + 1) / 3);
  const qStartMonth = (currentQ - 1) * 3;
  const qStart = new Date(now.getFullYear(), qStartMonth, 1);
  const qEnd = new Date(now.getFullYear(), qStartMonth + 3, 0);
  const totalDays = Math.ceil((qEnd.getTime() - qStart.getTime()) / 86400000);
  const elapsed = Math.min(totalDays, Math.ceil((now.getTime() - qStart.getTime()) / 86400000));

  // Margin
  const margin = revenue > 0 ? (net / revenue) * 100 : 0;

  // Current month for drill-down
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  return (
    <View style={{ flex: 1, backgroundColor: 'transparent' }}>
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={"#1A1A1A"} colors={["#1A1A1A"]} />}
      {...({delaysContentTouches: false} as any)}
    >
      {/* ── Hero Date ── */}
      <Text style={styles.heroDate}>{MONTHS[now.getMonth()]} {now.getFullYear()}</Text>

      {/* ── Error banner ── */}
      {lastError && (
        <View style={styles.errorBanner}>
          <Ionicons name="cloud-offline-outline" size={16} color={Colors.red} />
          <Text style={styles.errorBannerText}>{lastError}</Text>
        </View>
      )}

      {/* ── No data banner — hidden once any source is connected ── */}
      {!hasAnySource && (
        <View style={styles.noDataBanner}>
          <Ionicons name="information-circle-outline" size={18} color={Colors.textDim} />
          <Text style={styles.noDataBannerText}>
            {isLTR
              ? 'Connect Plaid or enter manual income in Settings to see your portfolio dashboard.'
              : 'Connect Plaid or enter manual income in Settings to populate your dashboard.'}
          </Text>
        </View>
      )}

      {/* ── FY Year-over-Year ── */}
      <View style={styles.fyCard}>
        <View style={styles.fyRow}>
          <View style={{ flex: 1, backgroundColor: 'transparent' }}>
            <Text style={styles.fyLabel}>FY {now.getFullYear() - 1}</Text>
          </View>
          <Text style={styles.fyAmount}>{fmt$(fyPriorAnnual)}</Text>
        </View>
        <View style={styles.fyRow}>
          <View style={{ flex: 1, backgroundColor: 'transparent' }}>
            <Text style={styles.fyLabel}>FY {now.getFullYear()} Projected</Text>
          </View>
          <Text style={styles.fyAmount}>{fmt$(fyCurrentAnnual)}</Text>
        </View>
        <View style={styles.fyLine} />
        {(() => {
          const delta = fyCurrentAnnual - fyPriorAnnual;
          const pctVal = fyPriorAnnual !== 0 ? (delta / Math.abs(fyPriorAnnual)) * 100 : 0;
          const isUp = delta >= 0;
          const color = isUp ? Colors.green : Colors.red;
          return (
            <View style={styles.fyRow}>
              <Text style={[styles.fyLabel, { color: Colors.textSecondary }]}>YoY</Text>
              <View style={styles.fyDeltaRow}>
                <Ionicons name={isUp ? 'arrow-up' : 'arrow-down'} size={14} color={color} />
                <Text style={[styles.fyDelta, { color }]}>
                  {fmt$(Math.abs(delta))} ({Math.abs(pctVal).toFixed(0)}%)
                </Text>
              </View>
            </View>
          );
        })()}
      </View>

      {/* ── Quarterly Snapshot ── */}
      <Text style={styles.sectionTitle}>
        Q{currentQ} {now.getFullYear()} SNAPSHOT
      </Text>
      <TouchableOpacity activeOpacity={0.7} onPress={() => setDrillDownMonth(currentMonth)}>
        <View style={styles.qCard}>
          {/* Progress bar */}
          <View style={styles.qProgressRow}>
            <Text style={styles.qProgressLabel}>
              {elapsed} of {totalDays} days elapsed
            </Text>
            <Text style={styles.qProgressPct}>
              {((elapsed / totalDays) * 100).toFixed(0)}%
            </Text>
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${(elapsed / totalDays) * 100}%` }]} />
          </View>

          {/* Stats row */}
          <View style={styles.qStats}>
            <View style={styles.qStat}>
              <Text style={styles.qStatLabel}>REV</Text>
              <Text style={[styles.qStatValue, { color: Colors.green }]}>{fmt$(revenue)}</Text>
            </View>
            <View style={styles.qDivider} />
            <View style={styles.qStat}>
              <Text style={styles.qStatLabel}>EXP</Text>
              <Text style={[styles.qStatValue, { color: Colors.red }]}>{fmt$(expenses)}</Text>
            </View>
            <View style={styles.qDivider} />
            <View style={styles.qStat}>
              <Text style={styles.qStatLabel}>NET</Text>
              <Text style={[styles.qStatValue, { color: net >= 0 ? Colors.green : Colors.red }]}>
                {net > 0 ? '+' : ''}{fmt$(net)}
              </Text>
            </View>
          </View>
        </View>
      </TouchableOpacity>

      {/* ══════════════════════════════ */}
      {/* ── SUMMARY BRUSH CARDS ──     */}
      {/* ══════════════════════════════ */}

      {/* ── Performance Brush Card ── */}
      <Text style={styles.sectionTitle}>PERFORMANCE</Text>
      <View style={styles.brushCard}>
        <View style={styles.brushRow}>
          <View style={styles.brushStat}>
            <Text style={styles.brushStatLabel}>Revenue MTD</Text>
            <Text style={[styles.brushStatValue, { color: Colors.green }]}>{fmt$(revenue)}</Text>
          </View>
          <View style={styles.brushStat}>
            <Text style={styles.brushStatLabel}>Expenses MTD</Text>
            <Text style={[styles.brushStatValue, { color: Colors.red }]}>{fmt$(expenses)}</Text>
          </View>
          <View style={styles.brushStat}>
            <Text style={styles.brushStatLabel}>Net Margin</Text>
            <Text style={[styles.brushStatValue, { color: margin >= 0 ? Colors.green : Colors.red }]}>
              {margin.toFixed(1)}%
            </Text>
          </View>
        </View>
        {/* Mini bar: revenue vs expenses */}
        <View style={styles.brushBarTrack}>
          <GlossyHorizontalBar
            width={280}
            height={5}
            radius={3}
            segments={[
              {
                fraction: (revenue || 1) / ((revenue || 1) + (expenses || 1)),
                colors: ['#0D9668', '#10B981', '#6EE7B7'],
              },
              {
                fraction: (expenses || 1) / ((revenue || 1) + (expenses || 1)),
                colors: ['#DC2626', '#EF4444', '#FCA5A5'],
              },
            ]}
          />
        </View>
      </View>

      {/* ── Occupancy Card (STR & BOTH only) ── */}
      {isSTR && (upcomingCheckins.length > 0 || activeStays > 0) && (
        <>
          <Text style={styles.sectionTitle}>OCCUPANCY</Text>
          <View style={styles.brushCard}>
            <View style={styles.occFooterRow}>
              <Ionicons name="calendar-outline" size={13} color={Colors.textDim} />
              <Text style={styles.occFooterText}>
                {activeStays} current · {upcomingCheckins.length} upcoming
                {nextCheckinDate ? ` · Next: ${nextCheckinDate}` : ''}
              </Text>
            </View>
          </View>
        </>
      )}

      {/* ── Inventory Brush Card (STR & BOTH only) ── */}
      {isSTR && inventoryStats && (
        <>
          <Text style={styles.sectionTitle}>INVENTORY</Text>
          <View style={styles.brushCard}>
            <View style={styles.brushCompactRow}>
              <Ionicons name="cube-outline" size={16} color={Colors.primary} />
              <Text style={styles.brushCompactText}>
                {inventoryStats.totalItems} items
                {inventoryStats.lowItems > 0
                  ? ` · ${inventoryStats.lowItems} low stock`
                  : ' · All stocked'}
              </Text>
              {inventoryStats.lowItems === 0 && (
                <View style={styles.brushBadge}>
                  <Text style={styles.brushBadgeText}>OK</Text>
                </View>
              )}
            </View>
          </View>
        </>
      )}

      {/* ── Cleanings Brush Card (STR & BOTH only) ── */}
      {isSTR && (portfolioType === 'str' || portfolioType === 'both') && (
        <>
          <Text style={styles.sectionTitle}>CLEANINGS</Text>
          <View style={styles.brushCard}>
            <View style={styles.brushCompactRow}>
              <Ionicons name="sparkles-outline" size={16} color={Colors.primary} />
              <Text style={styles.brushCompactText}>
                {upcomingCleanings > 0
                  ? `${upcomingCleanings} cleaning${upcomingCleanings !== 1 ? 's' : ''} this week`
                  : 'No cleanings scheduled'}
              </Text>
            </View>
          </View>
        </>
      )}

      {/* empty state handled by noDataBanner at top */}

      {/* Drill-down modal */}
      <MonthDetailModal
        visible={!!drillDownMonth}
        yearMonth={drillDownMonth || ''}
        onClose={() => setDrillDownMonth(null)}
      />
    </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  content: { padding: Spacing.md, paddingTop: 140, paddingBottom: Spacing.xl * 2 },
  center: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },

  // Hero date
  heroDate: {
    fontSize: 24,
    fontWeight: '800',
    color: Colors.text,
    letterSpacing: -0.5,
    marginBottom: Spacing.sm,
    paddingTop: Spacing.xs,
  },

  // Section title — 11px uppercase
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: Spacing.md,
    marginBottom: Spacing.sm,
  },

  // ── FY Year-over-Year Card ──
  fyCard: {
    backgroundColor: Colors.glassHeavy,
    borderRadius: Radius.xl,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight,
    borderTopWidth: 1,
    overflow: 'hidden',
    padding: Spacing.md,
    marginBottom: Spacing.sm,
    ...Platform.select({
      ios: {
        shadowColor: Colors.glassShadow,
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.35,
        shadowRadius: 20,
      },
    }),
  },
  fyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  fyLabel: {
    fontSize: 12,
    color: Colors.textDim,
    fontWeight: '500',
  },
  fyAmount: {
    fontSize: 16,
    fontWeight: '800',
    color: Colors.text,
    letterSpacing: -0.3,
  },
  fyLine: {
    height: 1,
    backgroundColor: Colors.glassBorder,
    marginVertical: 4,
  },
  fyDeltaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  fyDelta: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: -0.2,
  },

  // ── Quarterly Snapshot ──
  qCard: {
    backgroundColor: Colors.glassHeavy,
    borderRadius: Radius.xl,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight,
    borderTopWidth: 1,
    overflow: 'hidden',
    padding: Spacing.md,
    ...Platform.select({
      ios: {
        shadowColor: Colors.glassShadow,
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.35,
        shadowRadius: 20,
      },
    }),
  },
  qProgressRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  qProgressLabel: {
    fontSize: 12,
    color: Colors.textSecondary,
    fontWeight: '500',
  },
  qProgressPct: {
    fontSize: 12,
    color: Colors.green,
    fontWeight: '700',
  },
  progressTrack: {
    height: 4,
    backgroundColor: Colors.glassDark,
    borderRadius: 2,
    overflow: 'hidden',
    marginBottom: Spacing.md,
  },
  progressFill: {
    height: '100%',
    backgroundColor: Colors.green,
    borderRadius: 2,
  },
  qStats: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  qStat: {
    flex: 1,
    alignItems: 'center',
  },
  qStatLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  qStatValue: {
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  qDivider: {
    width: 1,
    height: 32,
    backgroundColor: Colors.glassBorder,
  },

  // ── Brush Cards (summary cards) ──
  brushCard: {
    backgroundColor: Colors.glassHeavy,
    borderRadius: Radius.xl,
    borderWidth: 0.5,
    borderColor: Colors.glassBorder,
    borderTopColor: Colors.glassHighlight,
    borderTopWidth: 1,
    overflow: 'hidden',
    padding: Spacing.md,
    ...Platform.select({
      ios: {
        shadowColor: Colors.glassShadow,
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.35,
        shadowRadius: 20,
      },
    }),
  },
  brushRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  brushStat: {
    flex: 1,
    alignItems: 'center',
  },
  brushStatLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: Colors.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  brushStatValue: {
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  brushBarTrack: {
    flexDirection: 'row',
    height: 5,
    borderRadius: 3,
    overflow: 'hidden',
    marginTop: Spacing.sm,
  },
  brushCompactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  brushCompactText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontWeight: '500',
    flex: 1,
  },
  brushBadge: {
    backgroundColor: 'rgba(16,185,129,0.12)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: Radius.pill,
  },
  brushBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: Colors.green,
  },

  // ── Error banner ──
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.redDim,
    borderRadius: Radius.md,
    padding: Spacing.sm,
    marginBottom: Spacing.md,
    borderWidth: 0.5,
    borderColor: Colors.red + '30',
  },
  errorBannerText: {
    fontSize: FontSize.xs,
    color: Colors.red,
    flex: 1,
    lineHeight: 16,
  },

  // ── Occupancy ──
  occRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  occCol: {
    flex: 1,
    alignItems: 'center',
  },
  occLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: Colors.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  occValue: {
    fontSize: 20,
    fontWeight: '800',
    color: Colors.text,
    letterSpacing: -0.3,
    marginBottom: 6,
  },
  occBarTrack: {
    width: '80%',
    height: 4,
    backgroundColor: Colors.glassDark,
    borderRadius: 2,
    overflow: 'hidden',
  },
  occBarFill: {
    height: '100%',
    borderRadius: 2,
  },
  occDivider: {
    width: 1,
    height: 40,
    backgroundColor: Colors.glassBorder,
    marginTop: 10,
  },
  occMarketRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: Spacing.sm,
    paddingTop: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.glassBorder,
  },
  occMarketText: {
    fontSize: 11,
    color: Colors.textDim,
    fontWeight: '500',
  },
  occPropRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 3,
  },
  occPropLabel: {
    fontSize: FontSize.xs, fontWeight: '500', color: Colors.text, width: 80,
  },
  occPropPct: {
    fontSize: FontSize.xs, fontWeight: '700', color: Colors.text, width: 32, textAlign: 'right',
  },
  occFooterRow: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    marginTop: Spacing.sm,
    paddingTop: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.glassBorder,
  },
  occFooterText: {
    fontSize: 11,
    color: Colors.textSecondary,
    fontWeight: '500',
  },

  // ── No data banner ──
  noDataBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.glassDark,
    borderRadius: Radius.md,
    padding: Spacing.sm,
    marginBottom: Spacing.md,
  },
  noDataBannerText: {
    fontSize: FontSize.xs,
    color: Colors.textDim,
    flex: 1,
    lineHeight: 16,
  },
});

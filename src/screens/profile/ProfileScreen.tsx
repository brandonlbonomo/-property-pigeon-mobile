import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl, Platform,
  TouchableOpacity, Modal, Switch, ActivityIndicator, Image, Dimensions, FlatList, TextInput, KeyboardAvoidingView,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useUserStore, UserProperty } from '../../store/userStore';
import { useDataStore } from '../../store/dataStore';
import { Card } from '../../components/Card';
import { PortfolioScoreBubble } from '../../components/PortfolioScoreBubble';
import { useSubscriptionGate } from '../../hooks/useSubscriptionGate';
import { fmt$, fmtCompact, fmtDate } from '../../utils/format';
import { apiGetPortfolioScore, apiFetch } from '../../services/api';
import { MAPS_PROXY_URL } from '../../constants/api';
import {
  OWNER_CATEGORIES, SPECIAL_TAGS as CATEGORY_SPECIAL_TAGS,
  getCategoryById, isExcludedTag, isIncomeCategory, isExpenseCategory,
} from '../../constants/categoryTags';
import {
  generateYearTimeline,
  aggregateToQuarters,
} from '../../utils/projections';
import { MonthDetailModal } from '../../components/MonthDetailModal';
import { PropertyStreetView } from '../../components/PropertyStreetView';
import * as ImagePicker from 'expo-image-picker';
import { glassAlert } from '../../components/GlassAlert';


// Module-level trigger for opening customize modal from outside (e.g. FAB)
let _triggerCustomize: (() => void) | null = null;
export function triggerCustomize() { _triggerCustomize?.(); }

const CARD_OPTIONS = [
  { key: 'portfolioPL', label: 'Portfolio P/L', icon: 'receipt-outline', desc: 'Per-property profit & loss summary' },
  { key: 'fyComparison', label: 'FY Comparison', icon: 'swap-vertical-outline', desc: 'Year-over-year revenue comparison' },
  { key: 'quarterSnapshot', label: 'Quarter Snapshot', icon: 'timer-outline', desc: 'Current quarter progress & financials' },
  { key: 'thisMonth', label: 'This Month', icon: 'calendar-outline', desc: 'Revenue, expenses, net for current month' },
  { key: 'quarterly', label: 'Quarterly Breakdown', icon: 'bar-chart-outline', desc: 'Q1–Q4 revenue, expenses, net' },
  { key: 'annual', label: 'Annual Tracking', icon: 'trending-up-outline', desc: 'Projected annual financials' },
  // Properties card is now fixed at top — not customizable
  // Transactions section is also fixed at top — not customizable
  { key: 'performance', label: 'Performance', icon: 'analytics-outline', desc: 'Revenue vs expenses bar' },
  { key: 'projections', label: 'Projections', icon: 'rocket-outline', desc: '30-year portfolio projection' },
  { key: 'occupancy', label: 'Occupancy', icon: 'bed-outline', desc: 'Current stays & upcoming check-ins', strOnly: true },
  { key: 'inventory', label: 'Inventory', icon: 'cube-outline', desc: 'Stock levels & low alerts', strOnly: true },
  { key: 'cleanings', label: 'Cleanings', icon: 'sparkles-outline', desc: 'Upcoming cleaning schedule', strOnly: true },
];

const DEFAULT_CARD_ORDER = CARD_OPTIONS.map(o => o.key);

const DEFAULT_CARDS: Record<string, boolean> = {
  portfolioPL: true,
  fyComparison: true,
  quarterSnapshot: true,
  thisMonth: true,
  quarterly: true,
  annual: true,
  // properties + transactions are now fixed at top
  performance: false,
  projections: false,
  occupancy: false,
  inventory: false,
  cleanings: false,
};

// 30-year projection (same as HomeScreen)
interface YearRow { year: number; yearOffset: number; units: number; revenue: number; expenses: number; netCF: number; portfolioValue: number; equity: number; }
function generate30YearProjection(startingUnits: number, unitsPerYear: number, currentRevenue: number, currentExpenses: number, projectionStyle: string): YearRow[] {
  const curYear = new Date().getFullYear();
  const revenuePerUnit = startingUnits > 0 ? (currentRevenue * 12) / startingUnits : 12000;
  const expensePerUnit = startingUnits > 0 ? (currentExpenses * 12) / startingUnits : 8000;
  const sf: Record<string, { r: number; e: number; a: number }> = { conservative: { r: 0.02, e: 0.03, a: 0.03 }, normal: { r: 0.04, e: 0.03, a: 0.04 }, bullish: { r: 0.06, e: 0.025, a: 0.06 } };
  const f = sf[projectionStyle] || sf.normal;
  const vpu = 150000; const ltv = 0.75; const mr = 0.065; const years: YearRow[] = [];
  for (let i = 0; i <= 30; i += 5) { const u = startingUnits + unitsPerYear * i; const rev = u * revenuePerUnit * Math.pow(1 + f.r, i); const exp = u * expensePerUnit * Math.pow(1 + f.e, i); const added = Math.max(0, u - startingUnits); const mc = added * vpu * ltv * mr; const pv = u * vpu * Math.pow(1 + f.a, i); const om = added * vpu * ltv * Math.max(0, 1 - i * 0.033); years.push({ year: curYear + i, yearOffset: i, units: u, revenue: rev, expenses: exp, netCF: rev - exp - mc, portfolioValue: pv, equity: pv - om }); }
  return years;
}

export function ProfileScreen() {
  const profile = useUserStore(s => s.profile);
  const setProfile = useUserStore(s => s.setProfile);
  const { isActive: isPro } = useSubscriptionGate();
  const { fetchCockpit, fetchCalendarEvents, fetchInvGroups, fetchTransactions, fetchCategoryTags, saveCategoryTag, fetchCustomCategories } = useDataStore();
  const [cockpit, setCockpit] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [invGroups, setInvGroups] = useState<any[]>([]);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCustomize, setShowCustomize] = useState(false);
  const [portfolioScore, setPortfolioScore] = useState<number | null>(null);
  const [drillDownMonth, setDrillDownMonth] = useState<string | null>(null);
  const [categoryTags, setCategoryTags] = useState<Record<string, string>>({});
  const [txTaggingId, setTxTaggingId] = useState<string | null>(null);
  const [txTagStep, setTxTagStep] = useState<'idle' | 'property' | 'category' | 'split'>('idle');
  const [splitData, setSplitData] = useState<any>(null);
  const [splitLoading, setSplitLoading] = useState(false);
  const [txTagSaving, setTxTagSaving] = useState(false);
  const [txShowAll, setTxShowAll] = useState(false);
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedTxIds, setSelectedTxIds] = useState<Set<string>>(new Set());
  const [customCategories, setCustomCategories] = useState<any[]>([]);
  const [selectedProperty, setSelectedProperty] = useState<UserProperty | null>(null);
  const [viewerPhotos, setViewerPhotos] = useState<string[]>([]);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [viewerLabel, setViewerLabel] = useState('');
  const screenWidth = Dimensions.get('window').width;
  const [propertiesExpanded, setPropertiesExpanded] = useState(false);

  // Register module-level trigger for FAB
  useEffect(() => {
    _triggerCustomize = () => setShowCustomize(true);
    return () => { _triggerCustomize = null; };
  }, []);

  const portfolioType = profile?.portfolioType;
  const isSTR = portfolioType === 'str' || portfolioType === 'both';
  const cardVisibility = { ...DEFAULT_CARDS, ...profile?.profileCards };

  const load = useCallback(async (force = false) => {
    try {
      setError(null);
      const results = await Promise.all([
        fetchCockpit(force),
        isSTR ? fetchCalendarEvents(force).catch(() => []) : Promise.resolve([]),
        isSTR ? fetchInvGroups(force).catch(() => []) : Promise.resolve([]),
        apiGetPortfolioScore().catch(() => ({ score: null })),
        fetchTransactions(force).catch(() => []),
        fetchCategoryTags(force).catch(() => ({})),
        fetchCustomCategories(force).catch(() => []),
      ]);
      setCockpit(results[0]);
      setEvents(results[1] || []);
      setInvGroups(results[2] || []);
      setPortfolioScore(results[3]?.score ?? null);
      const txs = results[4] || [];
      const catTags = results[5] || {};
      // Merge category_tag into each transaction so tagged/untagged filters work
      const merged = txs.map((t: any) => {
        const ct = catTags[t.id];
        return ct ? { ...t, category_tag: ct } : t;
      });
      setTransactions([...merged].sort((a: any, b: any) => (b.date || '').localeCompare(a.date || '')));
      setCategoryTags(catTags);
      setCustomCategories(results[6] || []);
    } catch (err: any) {
      setError('Could not load profile data. Pull down to retry.');
    }
    setLoading(false);
    setRefreshing(false);
  }, [fetchCockpit, fetchCalendarEvents, fetchInvGroups, fetchTransactions, fetchCategoryTags, fetchCustomCategories, isSTR]);

  useEffect(() => { load(); }, []);

  const dataVersion = useDataStore(s => s.dataVersion);
  useEffect(() => { if (dataVersion > 0) load(true); }, [dataVersion]);
  const onRefresh = () => { setRefreshing(true); load(true); };

  // ── Actuals ──
  const kpis = cockpit?.kpis || {};
  const revenue = kpis.revenue_mtd ?? 0;
  const expenses = kpis.expenses_mtd ?? 0;
  const net = kpis.net_mtd ?? 0;
  const pctChanges = cockpit?.pct_changes || {};
  const prior = cockpit?.prior || {};

  // ── Profile data ──
  const propertyCount = profile?.properties?.length ?? 0;
  const totalUnits = (profile?.properties || []).reduce((sum, p) => sum + (p.units || 0), 0);
  const isPlaidConnected = profile?.plaidConnected === true;
  const projStyle = profile?.projectionStyle || 'normal';
  const totalInvestment = useMemo(() => {
    const properties = profile?.properties || [];
    const perPropTotal = properties.reduce((sum: number, p: any) => {
      if (p.purchasePrice && p.downPaymentPct) {
        return sum + (p.purchasePrice * p.downPaymentPct / 100);
      }
      return sum;
    }, 0);
    return perPropTotal > 0 ? perPropTotal : (profile?.totalInvestment || 0);
  }, [profile?.properties, profile?.totalInvestment]);

  // ── Per-property P/L ──
  const revByProp = cockpit?.revenue_by_property || {};
  const expByProp = cockpit?.expenses_by_property || {};
  const portfolioPL = useMemo(() => {
    const allPids = new Set([...Object.keys(revByProp), ...Object.keys(expByProp)]);
    const entries = Array.from(allPids).map(pid => {
      const rev = revByProp[pid] ?? 0;
      const exp = expByProp[pid] ?? 0;
      const netVal = rev - exp;
      const marginPct = rev > 0 ? (netVal / rev) * 100 : (exp > 0 ? -100 : 0);
      // Resolve label from profile properties
      const prop = (profile?.properties || []).find(p => p.id === pid || p.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-') === pid);
      const label = prop?.name || pid.split('-')[0]?.toUpperCase() || pid;
      return { pid, label, revenue: rev, expenses: exp, net: netVal, margin: marginPct };
    });
    entries.sort((a, b) => b.net - a.net);
    const totRev = entries.reduce((s, e) => s + e.revenue, 0);
    const totExp = entries.reduce((s, e) => s + e.expenses, 0);
    const totNet = totRev - totExp;
    const totMargin = totRev > 0 ? (totNet / totRev) * 100 : 0;
    return { entries, totRev, totExp, totNet, totMargin };
  }, [revByProp, expByProp, profile?.properties]);

  const displayName = profile?.username || 'User';
  const initial = displayName[0].toUpperCase();

  // ── Projections ──
  const curYear = new Date().getFullYear();

  const revenueTimeline = useMemo(
    () => generateYearTimeline(revenue, prior.revenue ?? 0, projStyle, curYear),
    [revenue, prior.revenue, projStyle, curYear],
  );
  const expenseTimeline = useMemo(
    () => generateYearTimeline(expenses, prior.expenses ?? 0, projStyle, curYear),
    [expenses, prior.expenses, projStyle, curYear],
  );
  const netTimeline = useMemo(
    () => revenueTimeline.map((r, i) => ({
      ...r,
      value: r.value - expenseTimeline[i].value,
    })),
    [revenueTimeline, expenseTimeline],
  );

  // Annual projected totals
  const annualRevenue = revenueTimeline.reduce((s, m) => s + m.value, 0);
  const annualExpenses = expenseTimeline.reduce((s, m) => s + m.value, 0);
  const annualNet = annualRevenue - annualExpenses;

  // Quarterly
  const revenueQuarters = useMemo(() => aggregateToQuarters(revenueTimeline), [revenueTimeline]);
  const expenseQuarters = useMemo(() => aggregateToQuarters(expenseTimeline), [expenseTimeline]);
  const netQuarters = useMemo(() => aggregateToQuarters(netTimeline), [netTimeline]);
  const currentQIdx = netQuarters.findIndex(q => q.isCurrent);

  // Net margin
  const netMargin = revenue > 0 ? (net / revenue) * 100 : 0;
  const annualMargin = annualRevenue > 0 ? (annualNet / annualRevenue) * 100 : 0;

  // Cash on Cash
  const cashOnCash = totalInvestment > 0 ? (annualNet / totalInvestment) * 100 : null;

  // ── Widget data: FY Comparison ──
  const fyCurrentAnnual = revenue * 12;
  const fyPriorAnnual = (prior.revenue ?? 0) * 12;
  const fyDelta = fyCurrentAnnual - fyPriorAnnual;
  const fyPctVal = fyPriorAnnual !== 0 ? (fyDelta / Math.abs(fyPriorAnnual)) * 100 : 0;

  // ── Widget data: Quarter Snapshot ──
  const now = new Date();
  const currentQ = Math.ceil((now.getMonth() + 1) / 3);
  const qStartMonth = (currentQ - 1) * 3;
  const qStart = new Date(now.getFullYear(), qStartMonth, 1);
  const qEnd = new Date(now.getFullYear(), qStartMonth + 3, 0);
  const totalDays = Math.ceil((qEnd.getTime() - qStart.getTime()) / 86400000);
  const elapsed = Math.min(totalDays, Math.ceil((now.getTime() - qStart.getTime()) / 86400000));
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // ── Widget data: Performance ──
  const margin = revenue > 0 ? (net / revenue) * 100 : 0;

  // ── Widget data: 30-Year Projections ──
  const startingUnits = (profile?.properties || []).reduce((sum, p) => sum + (p.units || 0), 0);
  const unitsPerYear = profile?.unitsPerYear ?? 0;
  const projection = useMemo(
    () => generate30YearProjection(startingUnits, unitsPerYear, revenue, expenses, projStyle),
    [startingUnits, unitsPerYear, revenue, expenses, projStyle],
  );
  const fyRevenue = useMemo(() => {
    return revenueTimeline.reduce((s: number, m: any) => s + m.value, 0);
  }, [revenueTimeline]);

  // ── Widget data: Occupancy ──
  const upcomingCheckins = useMemo(() => {
    if (!isSTR || !events.length) return [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const out = new Date(today); out.setDate(out.getDate() + 14);
    return events.filter((e: any) => { const d = new Date(e.check_in || e.start); return d >= today && d <= out; });
  }, [events, isSTR]);
  const activeStays = useMemo(() => {
    if (!isSTR || !events.length) return 0;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return events.filter((e: any) => { const ci = new Date(e.check_in || e.start); const co = new Date(e.check_out || e.end); return ci <= today && co >= today; }).length;
  }, [events, isSTR]);
  const nextCheckinDate = upcomingCheckins.length > 0 ? fmtDate(upcomingCheckins[0].check_in || upcomingCheckins[0].start) : null;

  // ── Widget data: Cleanings ──
  const upcomingCleanings = useMemo(() => {
    if (!isSTR || !events.length) return 0;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const out = new Date(today); out.setDate(out.getDate() + 7);
    return events.filter((e: any) => { const co = new Date(e.check_out || e.end); return co >= today && co <= out; }).length;
  }, [events, isSTR]);

  // ── Widget data: Inventory ──
  const inventoryStats = useMemo(() => {
    if (!isSTR || !invGroups.length) return null;
    let totalItems = 0; let lowItems = 0;
    for (const g of invGroups) { for (const item of (g.items || [])) { totalItems++; const restocks = (item.restocks || []).reduce((s: number, r: any) => s + (r.qty || 0), 0); if ((item.initialQty || 0) + restocks <= (item.threshold || 0)) lowItems++; } }
    return totalItems > 0 ? { totalItems, lowItems } : null;
  }, [invGroups, isSTR]);

  // ── Widget data: Transactions ──
  const accountType = profile?.accountType || 'owner';

  // Merge default + custom categories for picker
  const allCategories = useMemo(() => [
    ...OWNER_CATEGORIES,
    ...customCategories.map((c: any) => ({
      id: c.id,
      label: c.label,
      icon: c.type === 'income' ? 'arrow-down-outline' : 'arrow-up-outline',
      color: c.color || '#A1A1AA',
      bgColor: c.bgColor || 'rgba(255,255,255,0.08)',
      type: c.type,
    })),
  ], [customCategories]);

  const untaggedTxs = useMemo(() => transactions.filter((t: any) => !t.property_tag && !t.category_tag), [transactions]);
  const taggedTxs = useMemo(() => transactions.filter((t: any) => !!t.property_tag || !!t.category_tag), [transactions]);
  const untaggedCount = untaggedTxs.length;
  const visibleTxs = useMemo(() => {
    const list = [...untaggedTxs, ...taggedTxs];
    return txShowAll ? list : list.slice(0, 20);
  }, [untaggedTxs, taggedTxs, txShowAll]);

  const promptCreateRule = useCallback((txId: string, tagValue: string) => {
    const tx = transactions.find((t: any) => t.id === txId);
    const payee = tx?.payee || tx?.name || '';
    if (!payee || payee.length < 3) return;
    const tagLabel = tagValue.startsWith('__')
      ? (tagValue === '__rental_income__' ? 'Rental Income' : tagValue === '__internal_transfer__' ? 'Internal Transfer' : tagValue)
      : propLabel(tagValue);
    glassAlert(
      'Create Auto-Tag Rule?',
      `Automatically tag all future "${payee}" transactions as "${tagLabel}"?`,
      [
        { text: 'No Thanks', style: 'cancel' },
        { text: 'Create Rule', onPress: async () => {
          try {
            const res = await apiFetch('/api/tags/rule', {
              method: 'POST',
              body: JSON.stringify({ payee, prop_id: tagValue }),
            });
            if (res.applied > 0) {
              useDataStore.setState({ cockpit: null, transactions: null, tags: null, categoryTags: null });
              load(true);
            }
          } catch {}
        }},
      ],
    );
  }, [transactions, propLabel]);

  const handleTagTransaction = useCallback(async (txId: string, propertyId: string | null) => {
    // Optimistic UI — update instantly
    setTransactions(prev => prev.map(t => t.id === txId ? { ...t, property_tag: propertyId } : t));
    setTxTagSaving(false);

    // Fire API and invalidate cockpit after it confirms
    apiFetch('/api/transactions/update', {
      method: 'POST',
      body: JSON.stringify({ id: txId, property_tag: propertyId }),
    }).then(() => {
      // Invalidate cockpit so Money tab refetches with new tag data
      useDataStore.setState({ cockpit: null, transactions: null });
    }).catch(() => {
      setTransactions(prev => prev.map(t => t.id === txId ? { ...t, property_tag: null } : t));
      glassAlert('Error', 'Failed to save tag. Please try again.');
    });
  }, []);

  const handleCategoryTag = useCallback(async (txId: string, categoryId: string | null) => {
    // Optimistic UI — update instantly
    setCategoryTags(prev => {
      const updated = { ...prev };
      if (categoryId) updated[txId] = categoryId;
      else delete updated[txId];
      return updated;
    });
    setTransactions(prev => prev.map(t => t.id === txId ? { ...t, category_tag: categoryId } : t));
    setTxTagSaving(false);

    // Fire API and invalidate after it confirms
    saveCategoryTag(txId, categoryId).then(() => {
      useDataStore.setState({ cockpit: null, transactions: null });
    }).catch(() => {
      setCategoryTags(prev => { const u = { ...prev }; delete u[txId]; return u; });
      setTransactions(prev => prev.map(t => t.id === txId ? { ...t, category_tag: null } : t));
      glassAlert('Error', 'Failed to save tag. Please try again.');
    });
  }, [saveCategoryTag]);

  const handleBatchTagProperty = useCallback(async (propertyId: string | null) => {
    // Optimistic — update UI instantly
    const prevTransactions = transactions;
    const ids = new Set(selectedTxIds);
    setTransactions(prev => prev.map(t =>
      ids.has(t.id) ? { ...t, property_tag: propertyId } : t
    ));
    // Don't clear selectedTxIds yet — category step needs them
    // setTxTagStep will be set by the caller

    // Fire all API calls in background
    Promise.all(
      Array.from(ids).map(txId =>
        apiFetch('/api/transactions/update', {
          method: 'POST',
          body: JSON.stringify({ id: txId, property_tag: propertyId }),
        })
      )
    ).then(() => {
      useDataStore.setState({ cockpit: null, transactions: null });
    }).catch(() => {
      setTransactions(prevTransactions);
      glassAlert('Error', 'Some tags failed to save. Please try again.');
    });
  }, [selectedTxIds, transactions]);

  const handleBatchCategoryTag = useCallback(async (categoryId: string | null) => {
    // Optimistic — update UI instantly
    const prevTransactions = transactions;
    const prevCategoryTags = { ...categoryTags };
    const ids = new Set(selectedTxIds);
    setCategoryTags(prev => {
      const updated = { ...prev };
      ids.forEach(txId => {
        if (categoryId) updated[txId] = categoryId;
        else delete updated[txId];
      });
      return updated;
    });
    setTransactions(prev => prev.map(t =>
      ids.has(t.id) ? { ...t, category_tag: categoryId } : t
    ));
    setSelectedTxIds(new Set());
    setMultiSelectMode(false);
    setTxTagStep('idle');
    useDataStore.setState({ cockpit: null, transactions: null, tags: null, categoryTags: null });

    // Fire all API calls in background
    Promise.all(
      Array.from(ids).map(txId => saveCategoryTag(txId, categoryId))
    ).catch(() => {
      setTransactions(prevTransactions);
      setCategoryTags(prevCategoryTags);
      glassAlert('Error', 'Some tags failed to save. Please try again.');
    });
  }, [selectedTxIds, saveCategoryTag, transactions, categoryTags]);

  const toggleTxSelection = useCallback((txId: string) => {
    setSelectedTxIds(prev => {
      const next = new Set(prev);
      if (next.has(txId)) next.delete(txId);
      else next.add(txId);
      return next;
    });
  }, []);

  const propLabel = useCallback((pid: string) => {
    const p = (profile?.properties || []).find((pr: any) => (pr.id || pr.prop_id) === pid);
    return p?.label || p?.name || pid;
  }, [profile?.properties]);

  // Card ordering
  const cardOrder = profile?.profileCardOrder || DEFAULT_CARD_ORDER;
  // Ensure any new cards not yet in the saved order are appended
  const fullOrder = useMemo(() => {
    const allKeys = CARD_OPTIONS.map(o => o.key);
    const ordered = cardOrder.filter(k => allKeys.includes(k));
    const missing = allKeys.filter(k => !ordered.includes(k));
    return [...ordered, ...missing];
  }, [cardOrder]);

  // Filter card options based on portfolio type, in saved order
  const availableCards = useMemo(() => {
    const filtered = CARD_OPTIONS.filter(opt => !opt.strOnly || isSTR);
    const keySet = new Set(filtered.map(o => o.key));
    return fullOrder.filter(k => keySet.has(k)).map(k => filtered.find(o => o.key === k)!);
  }, [fullOrder, isSTR]);

  const toggleCard = (key: string) => {
    const updated = { ...cardVisibility, [key]: !cardVisibility[key] };
    setProfile({ profileCards: updated });
  };

  const moveCard = (key: string, direction: 'up' | 'down') => {
    const keys = availableCards.map(c => c.key);
    const idx = keys.indexOf(key);
    if (idx < 0) return;
    const newIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= keys.length) return;
    const updated = [...keys];
    [updated[idx], updated[newIdx]] = [updated[newIdx], updated[idx]];
    setProfile({ profileCardOrder: updated });
  };

  if (loading && !profile?.properties?.length) {
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
      {...({delaysContentTouches: false} as any)}
    >
      {error && (
        <View style={styles.errorBanner}>
          <Ionicons name="cloud-offline-outline" size={16} color={Colors.red} />
          <Text style={styles.errorBannerText}>{error}</Text>
        </View>
      )}
      {/* ── Instagram-style header: Score + Stats + Menu ── */}
      <View style={styles.profileHeader}>
        <PortfolioScoreBubble score={(profile?.properties?.length ?? 0) === 0 ? 0 : portfolioScore} size={76} showLabel />
        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text style={styles.statNumber}>0</Text>
            <Text style={styles.statLabel}>Followers</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statNumber}>0</Text>
            <Text style={styles.statLabel}>Following</Text>
          </View>
        </View>
      </View>

      {/* ── Name + Verified ── */}
      <View style={styles.nameLeft}>
        <Text style={styles.username}>{displayName}</Text>
        {isPro && (
          <Ionicons name="checkmark-circle" size={18} color={Colors.primary} />
        )}
      </View>

      {/* ── Fixed Transactions Section (not a Card) ── */}
      {transactions.length > 0 && (
        <View style={txStyles.section}>
          <View style={txStyles.header}>
            <Text style={styles.sectionLabel}>TRANSACTIONS</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {untaggedCount > 0 && (
                <View style={txStyles.untaggedBadge}>
                  <Text style={txStyles.untaggedBadgeText}>{untaggedCount} untagged</Text>
                </View>
              )}
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => {
                  setMultiSelectMode(!multiSelectMode);
                  setSelectedTxIds(new Set());
                }}
              >
                <Text style={{ color: Colors.green, fontSize: 13, fontWeight: '600' }}>
                  {multiSelectMode ? 'Cancel' : 'Select'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
          {visibleTxs.map((t: any, i: number) => {
            const amt = t.amount ?? 0;
            const isTagging = txTaggingId === t.id;
            const excluded = isExcludedTag(t.property_tag) || isExcludedTag(t.category_tag);
            const isIncome = amt < 0;
            const displayAmt = Math.abs(amt);
            const prefix = isIncome ? '+' : '-';
            const amtColor = excluded ? Colors.textDim : (isIncome ? Colors.green : Colors.red);
            const catDef = t.category_tag ? getCategoryById(t.category_tag, accountType) : null;
            return (
              <View key={t.id}>
                <TouchableOpacity
                  activeOpacity={0.7}
                  style={[txStyles.row, excluded && { opacity: 0.45 }, multiSelectMode && selectedTxIds.has(t.id) && { backgroundColor: Colors.greenDim }]}
                  onPress={() => {
                    if (multiSelectMode) {
                      toggleTxSelection(t.id);
                    } else {
                      setTxTaggingId(t.id);
                      setTxTagStep('property');
                    }
                  }}
                  onLongPress={() => {
                    if (!multiSelectMode) {
                      setMultiSelectMode(true);
                      setSelectedTxIds(new Set([t.id]));
                    }
                  }}
                >
                  {multiSelectMode && (
                    <Ionicons
                      name={selectedTxIds.has(t.id) ? 'checkbox' : 'square-outline'}
                      size={20}
                      color={selectedTxIds.has(t.id) ? Colors.green : Colors.textDim}
                      style={{ marginRight: 8 }}
                    />
                  )}
                  <View style={txStyles.rowInfo}>
                    <Text style={[txStyles.rowName, excluded && { textDecorationLine: 'line-through' }]} numberOfLines={1}>
                      {t.payee || t.name || t.merchant || t.description || 'Unknown'}
                    </Text>
                    <Text style={txStyles.rowDate}>
                      {fmtDate(t.date || '')}
                      {t.property_tag && !t.property_tag.startsWith('__') ? ` · ${propLabel(t.property_tag)}` : ''}
                      {catDef ? ` · ${catDef.label}` : ''}
                      {t.auto_tagged ? ' · auto' : ''}
                    </Text>
                  </View>
                  <Text style={[txStyles.rowAmt, { color: amtColor }]}>
                    {prefix}{fmt$(displayAmt)}
                  </Text>
                  {!t.property_tag && !t.category_tag && (
                    <View style={txStyles.tagDot} />
                  )}
                </TouchableOpacity>
              </View>
            );
          })}
          {transactions.length > 20 && (
            <TouchableOpacity
              activeOpacity={0.7}
              style={txStyles.showAllBtn}
              onPress={() => setTxShowAll(!txShowAll)}
            >
              <Text style={txStyles.showAllText}>
                {txShowAll ? 'Show Less' : `Show All ${transactions.length} Transactions`}
              </Text>
            </TouchableOpacity>
          )}

          {/* Floating batch tag bar */}
          {multiSelectMode && selectedTxIds.size > 0 && (
            <TouchableOpacity
              activeOpacity={0.7}
              style={{
                backgroundColor: Colors.green, borderRadius: Radius.md,
                padding: Spacing.md, marginTop: Spacing.sm,
                flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
              }}
              onPress={() => setTxTagStep('property')}
            >
              <Ionicons name="pricetag" size={16} color="#fff" />
              <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>
                Tag {selectedTxIds.size} Transaction{selectedTxIds.size !== 1 ? 's' : ''}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* ── Fixed Properties Card (non-cleaners only) ── */}
      {profile?.accountType !== 'cleaner' && (() => {
        const props = profile?.properties || [];
        const needsDropdown = props.length > 5;
        const visibleProps = needsDropdown && !propertiesExpanded ? [] : props;
        return (
          <Card>
            {needsDropdown ? (
              <TouchableOpacity activeOpacity={0.7} style={styles.infoRow}
                onPress={() => setPropertiesExpanded(!propertiesExpanded)}>
                <Ionicons name="home-outline" size={18} color={Colors.textSecondary} />
                <Text style={styles.infoLabel}>Properties</Text>
                <Text style={styles.infoValue}>{propertyCount}</Text>
                <Ionicons name={propertiesExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={Colors.textDim} style={{ marginLeft: Spacing.xs }} />
              </TouchableOpacity>
            ) : (
              <View style={styles.infoRow}>
                <Ionicons name="home-outline" size={18} color={Colors.textSecondary} />
                <Text style={styles.infoLabel}>Properties</Text>
                <Text style={styles.infoValue}>{propertyCount}</Text>
              </View>
            )}
            {visibleProps.length > 0 ? visibleProps.map((p, i) => (
              <TouchableOpacity key={i} activeOpacity={0.7} style={styles.propertyRow}
                onPress={() => setSelectedProperty(p)}>
                {p.lat && p.lng ? (
                  <Image
                    source={{ uri: `${MAPS_PROXY_URL}/api/streetview?lat=${p.lat}&lng=${p.lng}&width=96&height=96` }}
                    style={styles.propertyThumb}
                  />
                ) : (
                  <View style={[styles.propertyThumb, styles.propertyThumbPlaceholder]}>
                    <Ionicons name="home-outline" size={16} color={Colors.textDim} />
                  </View>
                )}
                <View style={styles.propertyInfo}>
                  <Text style={styles.propertyName}>{p.name}</Text>
                  <Text style={styles.propertyUnits}>
                    {p.units} {p.units === 1 ? 'unit' : 'units'}
                    {p.market ? ` · ${p.market}` : ''}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={14} color={Colors.textDim} />
              </TouchableOpacity>
            )) : !needsDropdown ? (
              <Text style={styles.widgetCompactText}>No properties added yet</Text>
            ) : null}
          </Card>
        );
      })()}

      {/* ── Ordered Cards ── */}
      {availableCards.map(opt => {
        if (cardVisibility[opt.key] === false) return null;
        switch (opt.key) {
          case 'portfolioPL': {
            if (portfolioPL.entries.length === 0) return (
              <Card key="portfolioPL">
                <Text style={styles.sectionLabel}>PORTFOLIO P/L</Text>
                <Text style={styles.widgetCompactText}>No per-property data yet</Text>
              </Card>
            );
            return (
              <Card key="portfolioPL">
                <Text style={styles.sectionLabel}>
                  PORTFOLIO P/L — {cockpit?.month ? new Date(cockpit.month + '-01').toLocaleDateString('en-US', { month: 'short' }).toUpperCase() : 'MTD'}
                </Text>
                <View style={plStyles.totalsRow}>
                  <View style={plStyles.totalCol}>
                    <Text style={plStyles.totalLabel}>Revenue</Text>
                    <Text style={[plStyles.totalValue, { color: Colors.green }]}>{fmt$(portfolioPL.totRev)}</Text>
                  </View>
                  <View style={plStyles.totalCol}>
                    <Text style={plStyles.totalLabel}>Expenses</Text>
                    <Text style={[plStyles.totalValue, { color: Colors.red }]}>{fmt$(portfolioPL.totExp)}</Text>
                  </View>
                  <View style={plStyles.totalCol}>
                    <Text style={plStyles.totalLabel}>Net</Text>
                    <Text style={[plStyles.totalValue, { color: portfolioPL.totNet >= 0 ? Colors.green : Colors.red }]}>
                      {fmt$(portfolioPL.totNet)}
                    </Text>
                  </View>
                </View>
                <View style={plStyles.divider} />
                {portfolioPL.entries.map((entry, i) => {
                  const maxBar = Math.max(entry.revenue, entry.expenses, 1);
                  return (
                    <View key={entry.pid} style={[plStyles.propRow, i > 0 && { marginTop: Spacing.sm }]}>
                      <View style={plStyles.propHeader}>
                        <Text style={plStyles.propName}>{entry.label}</Text>
                        <Text style={[plStyles.propNet, { color: entry.net >= 0 ? Colors.green : Colors.red }]}>
                          {fmt$(entry.net)}
                        </Text>
                      </View>
                      <View style={plStyles.barRow}>
                        <View style={plStyles.barTrack}>
                          <View style={[plStyles.barGreen, { width: `${(entry.revenue / maxBar) * 100}%` }]} />
                          <View style={[plStyles.barRed, { width: `${(entry.expenses / maxBar) * 100}%` }]} />
                        </View>
                        <Text style={plStyles.marginText}>
                          {entry.margin > -999 ? `${entry.margin.toFixed(0)}%` : '--'}
                        </Text>
                      </View>
                    </View>
                  );
                })}
                <Text style={plStyles.summary}>
                  {portfolioPL.entries.length} {portfolioPL.entries.length === 1 ? 'property' : 'properties'} · {portfolioPL.totMargin.toFixed(1)}% margin
                </Text>
              </Card>
            );
          }
          case 'fyComparison': return (
            <View key="fyComparison" style={styles.fyCard}>
              <View style={styles.fyRow}>
                <Text style={styles.fyLabel}>FY {curYear - 1}</Text>
                <Text style={styles.fyAmount}>{fmt$(fyPriorAnnual)}</Text>
              </View>
              <View style={styles.fyRow}>
                <Text style={styles.fyLabel}>FY {curYear} Projected</Text>
                <Text style={styles.fyAmount}>{fmt$(fyCurrentAnnual)}</Text>
              </View>
              <View style={styles.fyLine} />
              <View style={styles.fyRow}>
                <Text style={[styles.fyLabel, { color: Colors.textSecondary }]}>YoY</Text>
                <View style={styles.fyDeltaRow}>
                  <Ionicons name={fyDelta >= 0 ? 'arrow-up' : 'arrow-down'} size={14} color={fyDelta >= 0 ? Colors.green : Colors.red} />
                  <Text style={[styles.fyDelta, { color: fyDelta >= 0 ? Colors.green : Colors.red }]}>
                    {fmt$(Math.abs(fyDelta))} ({Math.abs(fyPctVal).toFixed(0)}%)
                  </Text>
                </View>
              </View>
            </View>
          );
          case 'quarterSnapshot': return (
            <React.Fragment key="quarterSnapshot">
              <Text style={styles.sectionLabel}>Q{currentQ} {curYear} SNAPSHOT</Text>
              <TouchableOpacity activeOpacity={0.7} onPress={() => setDrillDownMonth(currentMonth)}>
                <Card>
                  <View style={styles.qProgressRow}>
                    <Text style={styles.qProgressLabel}>{elapsed} of {totalDays} days elapsed</Text>
                    <Text style={styles.qProgressPct}>{((elapsed / totalDays) * 100).toFixed(0)}%</Text>
                  </View>
                  <View style={styles.progressTrack}>
                    <View style={[styles.progressFill, { width: `${(elapsed / totalDays) * 100}%` }]} />
                  </View>
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
                </Card>
              </TouchableOpacity>
            </React.Fragment>
          );
          case 'thisMonth': return (
            <Card key="thisMonth">
              <Text style={styles.sectionLabel}>THIS MONTH</Text>
              <View style={styles.metricsRow}>
                <View style={styles.metric}>
                  <Text style={styles.metricLabel}>Revenue</Text>
                  <Text style={[styles.metricValue, { color: Colors.green }]}>{fmt$(revenue)}</Text>
                  {pctChanges.revenue != null && <PctBadge value={pctChanges.revenue} />}
                </View>
                <View style={styles.metricDivider} />
                <View style={styles.metric}>
                  <Text style={styles.metricLabel}>Expenses</Text>
                  <Text style={[styles.metricValue, { color: Colors.red }]}>{fmt$(expenses)}</Text>
                  {pctChanges.expenses != null && <PctBadge value={pctChanges.expenses} invert />}
                </View>
                <View style={styles.metricDivider} />
                <View style={styles.metric}>
                  <Text style={styles.metricLabel}>Net</Text>
                  <Text style={[styles.metricValue, { color: net >= 0 ? Colors.green : Colors.red }]}>{fmt$(net)}</Text>
                  <Text style={styles.marginLabel}>{netMargin.toFixed(1)}% margin</Text>
                </View>
              </View>
            </Card>
          );
          case 'quarterly': return (
            <Card key="quarterly">
              <Text style={styles.sectionLabel}>QUARTERLY — {curYear}</Text>
              {netQuarters.map((q, i) => {
                const qRev = revenueQuarters[i]?.value ?? 0;
                const qExp = expenseQuarters[i]?.value ?? 0;
                const qNet = q.value;
                const isCur = i === currentQIdx;
                return (
                  <View key={q.label} style={[styles.quarterRow, isCur && styles.quarterRowCurrent]}>
                    <View style={styles.quarterHeader}>
                      <Text style={[styles.quarterLabel, isCur && styles.quarterLabelCurrent]}>{q.label}</Text>
                      {!q.isActual && <Text style={styles.projBadge}>Projected</Text>}
                      {isCur && <Text style={styles.currentBadge}>Current</Text>}
                    </View>
                    <View style={styles.quarterMetrics}>
                      <View style={styles.quarterMetric}>
                        <Text style={styles.quarterMetricLabel}>Revenue</Text>
                        <Text style={[styles.quarterMetricValue, { color: Colors.green }]}>{fmt$(qRev)}</Text>
                      </View>
                      <View style={styles.quarterMetric}>
                        <Text style={styles.quarterMetricLabel}>Expenses</Text>
                        <Text style={[styles.quarterMetricValue, { color: Colors.red }]}>{fmt$(qExp)}</Text>
                      </View>
                      <View style={styles.quarterMetric}>
                        <Text style={styles.quarterMetricLabel}>Net</Text>
                        <Text style={[styles.quarterMetricValue, { color: qNet >= 0 ? Colors.green : Colors.red }]}>{fmt$(qNet)}</Text>
                      </View>
                    </View>
                  </View>
                );
              })}
            </Card>
          );
          case 'annual': return (
            <Card key="annual">
              <Text style={styles.sectionLabel}>ANNUAL TRACKING — {curYear}</Text>
              <View style={styles.annualGrid}>
                <View style={styles.annualItem}>
                  <Text style={styles.annualLabel}>Projected Revenue</Text>
                  <Text style={[styles.annualValue, { color: Colors.green }]}>{fmt$(annualRevenue)}</Text>
                </View>
                <View style={styles.annualItem}>
                  <Text style={styles.annualLabel}>Projected Expenses</Text>
                  <Text style={[styles.annualValue, { color: Colors.red }]}>{fmt$(annualExpenses)}</Text>
                </View>
                <View style={styles.annualItem}>
                  <Text style={styles.annualLabel}>Projected Net Income</Text>
                  <Text style={[styles.annualValue, { color: annualNet >= 0 ? Colors.green : Colors.red }]}>{fmt$(annualNet)}</Text>
                </View>
                <View style={styles.annualItem}>
                  <Text style={styles.annualLabel}>Projected Net Margin</Text>
                  <Text style={[styles.annualValue, { color: annualMargin >= 0 ? Colors.green : Colors.red }]}>{annualMargin.toFixed(1)}%</Text>
                </View>
                {cashOnCash !== null && (
                  <View style={styles.annualItem}>
                    <Text style={styles.annualLabel}>Cash on Cash Return</Text>
                    <Text style={[styles.annualValue, { color: cashOnCash >= 0 ? Colors.green : Colors.red }]}>{cashOnCash.toFixed(1)}%</Text>
                  </View>
                )}
              </View>
              <View style={styles.projectionNote}>
                <Ionicons name="analytics-outline" size={14} color={Colors.textDim} />
                <Text style={styles.projectionNoteText}>
                  Based on {projStyle} projections using current trends
                </Text>
              </View>
            </Card>
          );
          // 'properties' is now fixed at top — not part of customizable cards
          case 'performance': return (
            <Card key="performance">
              <Text style={styles.sectionLabel}>PERFORMANCE</Text>
              <View style={styles.metricsRow}>
                <View style={styles.metric}>
                  <Text style={styles.metricLabel}>Revenue MTD</Text>
                  <Text style={[styles.metricValue, { color: Colors.green }]}>{fmt$(revenue)}</Text>
                </View>
                <View style={styles.metricDivider} />
                <View style={styles.metric}>
                  <Text style={styles.metricLabel}>Expenses MTD</Text>
                  <Text style={[styles.metricValue, { color: Colors.red }]}>{fmt$(expenses)}</Text>
                </View>
                <View style={styles.metricDivider} />
                <View style={styles.metric}>
                  <Text style={styles.metricLabel}>Net Margin</Text>
                  <Text style={[styles.metricValue, { color: margin >= 0 ? Colors.green : Colors.red }]}>{margin.toFixed(1)}%</Text>
                </View>
              </View>
              <View style={styles.perfBar}>
                <View style={[styles.perfBarGreen, { flex: revenue || 1 }]} />
                <View style={[styles.perfBarRed, { flex: expenses || 1 }]} />
              </View>
            </Card>
          );
          case 'projections': return (
            <Card key="projections">
              <Text style={styles.sectionLabel}>PROJECTIONS</Text>
              <View style={styles.metricsRow}>
                <View style={styles.metric}>
                  <Text style={styles.metricLabel}>FY Projected</Text>
                  <Text style={[styles.metricValue, { color: Colors.green }]}>{fmtCompact(fyRevenue)}</Text>
                </View>
                <View style={styles.metricDivider} />
                <View style={styles.metric}>
                  <Text style={styles.metricLabel}>Yr 5 Net CF</Text>
                  <Text style={[styles.metricValue, { color: Colors.green }]}>{fmtCompact(projection[1]?.netCF || 0)}</Text>
                </View>
                <View style={styles.metricDivider} />
                <View style={styles.metric}>
                  <Text style={styles.metricLabel}>Yr 30 Value</Text>
                  <Text style={[styles.metricValue, { color: Colors.primary }]}>{fmtCompact(projection[projection.length - 1]?.portfolioValue || 0)}</Text>
                </View>
              </View>
            </Card>
          );
          case 'occupancy': return isSTR ? (
            <Card key="occupancy">
              <Text style={styles.sectionLabel}>OCCUPANCY</Text>
              <View style={styles.widgetCompactRow}>
                <Ionicons name="calendar-outline" size={16} color={Colors.primary} />
                <Text style={styles.widgetCompactText}>
                  {events.length > 0
                    ? `${upcomingCheckins.length} upcoming · ${activeStays} active${nextCheckinDate ? ` · Next: ${nextCheckinDate}` : ''}`
                    : 'No occupancy data yet'}
                </Text>
              </View>
            </Card>
          ) : null;
          case 'inventory': return isSTR ? (
            <Card key="inventory">
              <Text style={styles.sectionLabel}>INVENTORY</Text>
              <View style={styles.widgetCompactRow}>
                <Ionicons name="cube-outline" size={16} color={Colors.primary} />
                <Text style={styles.widgetCompactText}>
                  {inventoryStats
                    ? `${inventoryStats.totalItems} items${inventoryStats.lowItems > 0 ? ` · ${inventoryStats.lowItems} low stock` : ' · All stocked'}`
                    : 'No inventory data yet'}
                </Text>
                {inventoryStats && inventoryStats.lowItems === 0 && (
                  <View style={styles.okBadge}><Text style={styles.okBadgeText}>OK</Text></View>
                )}
              </View>
            </Card>
          ) : null;
          case 'cleanings': return isSTR ? (
            <Card key="cleanings">
              <Text style={styles.sectionLabel}>CLEANINGS</Text>
              <View style={styles.widgetCompactRow}>
                <Ionicons name="sparkles-outline" size={16} color={Colors.primary} />
                <Text style={styles.widgetCompactText}>
                  {upcomingCleanings > 0 ? `${upcomingCleanings} cleaning${upcomingCleanings !== 1 ? 's' : ''} this week` : 'No cleanings scheduled'}
                </Text>
              </View>
            </Card>
          ) : null;
          default: return null;
        }
      })}

      {/* ── Step 1: Property / Rental Income Bottom Sheet ── */}
      <Modal
        visible={txTagStep === 'property' && (!!txTaggingId || (multiSelectMode && selectedTxIds.size > 0))}
        transparent
        animationType="slide"
        onRequestClose={() => { setTxTagStep('idle'); setTxTaggingId(null); }}
      >
        <TouchableOpacity activeOpacity={1} style={tagSheetStyles.overlay}
          onPress={() => { setTxTagStep('idle'); setTxTaggingId(null); }}>
          <View style={tagSheetStyles.sheet} onStartShouldSetResponder={() => true}>
            <View style={tagSheetStyles.handle} />
            <Text style={tagSheetStyles.title}>
              {multiSelectMode && selectedTxIds.size > 0
                ? `TAG ${selectedTxIds.size} TRANSACTION${selectedTxIds.size !== 1 ? 'S' : ''}`
                : 'TAG TRANSACTION'}
            </Text>
            <Text style={tagSheetStyles.subtitle}>
              {multiSelectMode && selectedTxIds.size > 0
                ? `Apply tag to ${selectedTxIds.size} selected`
                : (transactions.find((t: any) => t.id === txTaggingId)?.payee
                  || transactions.find((t: any) => t.id === txTaggingId)?.name
                  || 'Transaction')}
            </Text>

            {/* Rental Income shortcut */}
            <TouchableOpacity
              activeOpacity={0.7}
              style={[tagSheetStyles.option, { borderColor: Colors.green + '40', backgroundColor: Colors.greenDim }]}
              onPress={async () => {
                // Fetch split suggestion from backend
                const ids = multiSelectMode && selectedTxIds.size > 0
                  ? Array.from(selectedTxIds)
                  : txTaggingId ? [txTaggingId] : [];
                if (ids.length === 0) return;

                const props = profile?.properties || [];
                if (props.filter((p: any) => p.isAirbnb).length <= 1) {
                  // Only 1 or 0 STR properties — no split needed, tag directly
                  if (multiSelectMode && selectedTxIds.size > 0) {
                    await handleBatchCategoryTag('__rental_income__');
                  } else if (txTaggingId) {
                    await handleCategoryTag(txTaggingId, '__rental_income__');
                  }
                  setTxTagStep('idle');
                  setTxTaggingId(null);
                  return;
                }

                // Multiple STR properties — show split screen
                setSplitLoading(true);
                setTxTagStep('split');
                try {
                  const res = await apiFetch('/api/income/split-suggest', {
                    method: 'POST',
                    body: JSON.stringify({ tx_ids: ids }),
                  });
                  setSplitData(res);
                } catch {
                  // Fallback: tag directly without split
                  if (multiSelectMode && selectedTxIds.size > 0) {
                    await handleBatchCategoryTag('__rental_income__');
                  } else if (txTaggingId) {
                    await handleCategoryTag(txTaggingId, '__rental_income__');
                  }
                  setTxTagStep('idle');
                  setTxTaggingId(null);
                }
                setSplitLoading(false);
              }}
              disabled={txTagSaving}
            >
              <Ionicons name="logo-usd" size={16} color={Colors.green} />
              <View style={tagSheetStyles.optionText}>
                <Text style={[tagSheetStyles.optionLabel, { color: Colors.green }]}>Rental Income</Text>
                <Text style={tagSheetStyles.optionHint}>Split across properties by booking nights</Text>
              </View>
            </TouchableOpacity>

            {/* Properties */}
            {(profile?.properties || []).map((p: any) => (
              <TouchableOpacity
                key={p.id}
                activeOpacity={0.7}
                style={tagSheetStyles.option}
                onPress={async () => {
                  if (multiSelectMode && selectedTxIds.size > 0) {
                    await handleBatchTagProperty(p.id);
                    setTxTagStep('category');
                    return;
                  }
                  if (!txTaggingId) return;
                  await handleTagTransaction(txTaggingId, p.id);
                  setTxTagStep('category');
                }}
                disabled={txTagSaving}
              >
                <Ionicons name="home" size={16} color={Colors.primary} />
                <View style={tagSheetStyles.optionText}>
                  <Text style={tagSheetStyles.optionLabel}>{p.label || p.name}</Text>
                  <Text style={tagSheetStyles.optionHint}>
                    {p.units} unit{p.units !== 1 ? 's' : ''}{p.market ? ` · ${p.market}` : ''}
                  </Text>
                </View>
              </TouchableOpacity>
            ))}

            {/* Internal Transfer — exclude from calculations, no step 2 */}
            <TouchableOpacity
              activeOpacity={0.7}
              style={[tagSheetStyles.option, { borderColor: 'rgba(161,161,170,0.25)', backgroundColor: 'rgba(255,255,255,0.08)' }]}
              onPress={async () => {
                if (multiSelectMode && selectedTxIds.size > 0) {
                  await handleBatchCategoryTag('__internal_transfer__');
                  return;
                }
                if (!txTaggingId) return;
                await handleCategoryTag(txTaggingId, '__internal_transfer__');
                setTxTagStep('idle');
                setTxTaggingId(null);
              }}
              disabled={txTagSaving}
            >
              <Ionicons name="swap-horizontal-outline" size={16} color="#A1A1AA" />
              <View style={tagSheetStyles.optionText}>
                <Text style={[tagSheetStyles.optionLabel, { color: '#A1A1AA' }]}>Internal Transfer</Text>
                <Text style={tagSheetStyles.optionHint}>Exclude from all calculations</Text>
              </View>
            </TouchableOpacity>

            {/* Delete — exclude from calculations, no step 2 */}
            <TouchableOpacity
              activeOpacity={0.7}
              style={[tagSheetStyles.option, { borderColor: Colors.red + '30', backgroundColor: Colors.redDim }]}
              onPress={async () => {
                if (multiSelectMode && selectedTxIds.size > 0) {
                  await handleBatchCategoryTag('__delete__');
                  return;
                }
                if (!txTaggingId) return;
                await handleCategoryTag(txTaggingId, '__delete__');
                setTxTagStep('idle');
                setTxTaggingId(null);
              }}
              disabled={txTagSaving}
            >
              <Ionicons name="trash-outline" size={16} color={Colors.red} />
              <View style={tagSheetStyles.optionText}>
                <Text style={[tagSheetStyles.optionLabel, { color: Colors.red }]}>Delete</Text>
                <Text style={tagSheetStyles.optionHint}>Exclude from all calculations</Text>
              </View>
            </TouchableOpacity>

            {/* Untag — only if already tagged */}
            {(() => {
              const tx = transactions.find((t: any) => t.id === txTaggingId);
              if (tx?.property_tag || tx?.category_tag) {
                return (
                  <TouchableOpacity
                    activeOpacity={0.7}
                    style={[tagSheetStyles.option, { borderColor: Colors.red + '30', backgroundColor: Colors.redDim }]}
                    onPress={async () => {
                      if (!txTaggingId) return;
                      if (tx.property_tag) await handleTagTransaction(txTaggingId, null);
                      if (tx.category_tag) await handleCategoryTag(txTaggingId, null);
                      setTxTagStep('idle');
                      setTxTaggingId(null);
                    }}
                    disabled={txTagSaving}
                  >
                    <Ionicons name="close-circle" size={16} color={Colors.red} />
                    <Text style={[tagSheetStyles.optionLabel, { color: Colors.red }]}>Untag</Text>
                  </TouchableOpacity>
                );
              }
              return null;
            })()}

            <TouchableOpacity activeOpacity={0.7} style={tagSheetStyles.cancelBtn}
              onPress={() => { setTxTagStep('idle'); setTxTaggingId(null); }}>
              <Text style={tagSheetStyles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ── Step 2: Category Bottom Sheet ── */}
      <Modal
        visible={txTagStep === 'category' && (!!txTaggingId || selectedTxIds.size > 0)}
        transparent
        animationType="slide"
        onRequestClose={() => { setTxTagStep('idle'); setTxTaggingId(null); }}
      >
        <TouchableOpacity activeOpacity={1} style={tagSheetStyles.overlay}
          onPress={() => { setTxTagStep('idle'); setTxTaggingId(null); }}>
          <View style={tagSheetStyles.sheet} onStartShouldSetResponder={() => true}>
            <View style={tagSheetStyles.handle} />
            <Text style={tagSheetStyles.title}>SELECT CATEGORY</Text>
            <Text style={tagSheetStyles.subtitle}>
              {(() => {
                const tx = transactions.find((t: any) => t.id === txTaggingId);
                const pName = tx?.property_tag ? propLabel(tx.property_tag) : '';
                return pName ? `${tx?.payee || tx?.name || 'Transaction'} → ${pName}` : (tx?.payee || tx?.name || 'Transaction');
              })()}
            </Text>

            <ScrollView style={{ maxHeight: 340 }} showsVerticalScrollIndicator={false}>
              {allCategories.map(cat => (
                <TouchableOpacity
                  key={cat.id}
                  activeOpacity={0.7}
                  style={[tagSheetStyles.option, { borderColor: cat.color + '30' }]}
                  onPress={async () => {
                    if (selectedTxIds.size > 0) {
                      await handleBatchCategoryTag(cat.id);
                      return;
                    }
                    if (!txTaggingId) return;
                    await handleCategoryTag(txTaggingId, cat.id);
                    setTxTagStep('idle');
                    setTxTaggingId(null);
                  }}
                  disabled={txTagSaving}
                >
                  <Ionicons name={cat.icon as any} size={16} color={cat.color} />
                  <Text style={tagSheetStyles.optionLabel}>{cat.label}</Text>
                </TouchableOpacity>
              ))}
              {CATEGORY_SPECIAL_TAGS.map(tag => (
                <TouchableOpacity
                  key={tag.id}
                  activeOpacity={0.7}
                  style={[tagSheetStyles.option, { borderColor: tag.color + '30' }]}
                  onPress={async () => {
                    if (selectedTxIds.size > 0) {
                      await handleBatchCategoryTag(tag.id);
                      return;
                    }
                    if (!txTaggingId) return;
                    await handleCategoryTag(txTaggingId, tag.id);
                    setTxTagStep('idle');
                    setTxTaggingId(null);
                  }}
                  disabled={txTagSaving}
                >
                  <Ionicons name={tag.icon as any} size={16} color={tag.color} />
                  <Text style={tagSheetStyles.optionLabel}>{tag.label}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <TouchableOpacity activeOpacity={0.7} style={tagSheetStyles.cancelBtn}
              onPress={() => { setTxTagStep('idle'); setTxTaggingId(null); }}>
              <Text style={tagSheetStyles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ── Income Split Modal ── */}
      <Modal
        visible={txTagStep === 'split'}
        transparent
        animationType="slide"
        onRequestClose={() => { setTxTagStep('idle'); setTxTaggingId(null); setSplitData(null); }}
      >
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <TouchableOpacity activeOpacity={1} style={tagSheetStyles.overlay}
          onPress={() => { setTxTagStep('idle'); setTxTaggingId(null); setSplitData(null); }}>
          <View style={[tagSheetStyles.sheet, { maxHeight: '70%' }]} onStartShouldSetResponder={() => true}>
            <View style={tagSheetStyles.handle} />
            <Text style={tagSheetStyles.title}>SPLIT AIRBNB INCOME</Text>
            {splitLoading ? (
              <ActivityIndicator color={Colors.green} style={{ marginVertical: Spacing.xl }} />
            ) : splitData ? (
              <>
                <Text style={tagSheetStyles.subtitle}>
                  {splitData.has_ical
                    ? `Split ${fmt$(splitData.total_amount)} based on ${splitData.splits.reduce((s: number, sp: any) => s + sp.nights, 0)} booking nights`
                    : `No bookings found — adjust split manually`}
                </Text>
                <ScrollView style={{ maxHeight: 300 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
                  {(splitData.splits || []).map((sp: any, idx: number) => (
                    <View key={sp.prop_id} style={[tagSheetStyles.option, { flexDirection: 'column', alignItems: 'stretch', gap: 6 }]}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                          <Ionicons name="home" size={14} color={Colors.green} />
                          <Text style={tagSheetStyles.optionLabel}>{sp.prop_label}</Text>
                        </View>
                        <Text style={{ color: Colors.green, fontSize: FontSize.md, fontWeight: '700' }}>
                          {fmt$(splitData.total_amount * (sp.pct / 100))}
                        </Text>
                      </View>
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Text style={{ color: Colors.textDim, fontSize: FontSize.xs }}>
                          {sp.nights > 0 ? `${sp.nights} nights` : 'Manual'}
                        </Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          <TextInput
                            style={{
                              backgroundColor: Colors.bg, borderWidth: 1, borderColor: Colors.border,
                              borderRadius: Radius.sm, paddingHorizontal: 8, paddingVertical: 4,
                              color: Colors.text, fontSize: FontSize.sm, fontWeight: '600',
                              width: 55, textAlign: 'right',
                            }}
                            value={String(sp.pct)}
                            onChangeText={(val) => {
                              const num = parseFloat(val) || 0;
                              const newSplits = [...splitData.splits];
                              newSplits[idx] = { ...newSplits[idx], pct: num, amount: splitData.total_amount * (num / 100) };
                              setSplitData({ ...splitData, splits: newSplits });
                            }}
                            keyboardType="decimal-pad"
                            maxLength={5}
                          />
                          <Text style={{ color: Colors.textSecondary, fontSize: FontSize.sm }}>%</Text>
                        </View>
                      </View>
                    </View>
                  ))}
                  {/* Show total percentage */}
                  {(() => {
                    const totalPct = (splitData.splits || []).reduce((s: number, sp: any) => s + (sp.pct || 0), 0);
                    const isValid = Math.abs(totalPct - 100) < 0.5;
                    return (
                      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', paddingVertical: 4, paddingHorizontal: Spacing.sm }}>
                        <Text style={{ color: isValid ? Colors.green : Colors.red, fontSize: FontSize.xs, fontWeight: '600' }}>
                          Total: {totalPct.toFixed(1)}%{!isValid ? ' (must equal 100%)' : ''}
                        </Text>
                      </View>
                    );
                  })()}
                </ScrollView>

                <TouchableOpacity
                  activeOpacity={0.7}
                  style={{ backgroundColor: Colors.green, borderRadius: Radius.md, padding: Spacing.md, alignItems: 'center', marginTop: Spacing.sm }}
                  onPress={async () => {
                    try {
                      await apiFetch('/api/income/split-apply', {
                        method: 'POST',
                        body: JSON.stringify({
                          tx_ids: splitData.tx_ids,
                          splits: splitData.splits,
                        }),
                      });
                      // Update local state
                      const splitMap = Object.fromEntries(
                        (splitData.splits || []).map((s: any) => [s.prop_id, s.pct])
                      );
                      setTransactions(prev => prev.map(t =>
                        splitData.tx_ids.includes(t.id)
                          ? { ...t, category_tag: '__rental_income__', revenue_split: splitMap }
                          : t
                      ));
                      useDataStore.setState({ cockpit: null, transactions: null });
                    } catch {
                      glassAlert('Error', 'Failed to apply split.');
                    }
                    setTxTagStep('idle');
                    setTxTaggingId(null);
                    setSelectedTxIds(new Set());
                    setMultiSelectMode(false);
                    setSplitData(null);
                  }}
                >
                  <Text style={{ color: '#fff', fontSize: FontSize.md, fontWeight: '700' }}>
                    Confirm Split
                  </Text>
                </TouchableOpacity>
              </>
            ) : null}

            <TouchableOpacity activeOpacity={0.7}
              style={{ alignItems: 'center', paddingVertical: Spacing.sm, marginTop: Spacing.xs }}
              onPress={() => { setTxTagStep('idle'); setTxTaggingId(null); setSplitData(null); }}>
              <Text style={{ color: Colors.textSecondary, fontSize: FontSize.sm }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>

      {/* Drill-down modal */}
      <MonthDetailModal
        visible={!!drillDownMonth}
        yearMonth={drillDownMonth || ''}
        onClose={() => setDrillDownMonth(null)}
      />

      {/* ── Property Detail Modal ── */}
      <Modal visible={!!selectedProperty} animationType="slide" presentationStyle="pageSheet"
        onRequestClose={() => { setSelectedProperty(null); setViewerPhotos([]); }}>
        <View style={{ flex: 1, backgroundColor: Colors.bg }}>
          {viewerPhotos.length > 0 ? (
            /* ── Full-screen Photo Viewer ── */
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.md, paddingTop: Spacing.sm, paddingBottom: Spacing.sm }}>
                <TouchableOpacity activeOpacity={0.7} onPress={() => setViewerPhotos([])}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Ionicons name="chevron-back" size={22} color={Colors.primary} />
                  <Text style={{ fontSize: FontSize.md, color: Colors.primary }}>Back</Text>
                </TouchableOpacity>
                <View style={{ flex: 1, alignItems: 'center' }}>
                  {viewerLabel ? <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text }}>{viewerLabel}</Text> : null}
                  <Text style={{ fontSize: FontSize.xs, fontWeight: '600', color: Colors.textDim }}>
                    {viewerIndex + 1} / {viewerPhotos.length}
                  </Text>
                </View>
                <View style={{ width: 60 }} />
              </View>
              <FlatList
                data={viewerPhotos}
                horizontal
                pagingEnabled
                showsHorizontalScrollIndicator={false}
                initialScrollIndex={viewerIndex}
                getItemLayout={(_, index) => ({ length: screenWidth, offset: screenWidth * index, index })}
                onMomentumScrollEnd={(e) => {
                  setViewerIndex(Math.round(e.nativeEvent.contentOffset.x / screenWidth));
                }}
                keyExtractor={(_, i) => String(i)}
                renderItem={({ item }) => (
                  <View style={{ width: screenWidth, flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: Spacing.sm }}>
                    <Image source={{ uri: item }}
                      style={{ width: screenWidth - Spacing.sm * 2, flex: 1, borderRadius: Radius.lg }}
                      resizeMode="contain" />
                  </View>
                )}
              />
            </View>
          ) : (
          <>
          <View style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 4 }}>
            <View style={{ width: 36, height: 4, backgroundColor: 'rgba(0,0,0,0.12)', borderRadius: 2 }} />
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: Spacing.lg, paddingBottom: Spacing.xl * 2 }}
            showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets
            scrollEventThrottle={16} bounces={true}>
            <Text style={modalStyles.title}>{selectedProperty?.name}</Text>
            {selectedProperty?.address ? (
              <Text style={modalStyles.subtitle}>{selectedProperty.address}</Text>
            ) : null}
            {selectedProperty?.market ? (
              <Text style={[modalStyles.desc, { marginBottom: Spacing.sm }]}>{selectedProperty.market}</Text>
            ) : null}

            {/* Interactive Street View */}
            {selectedProperty?.lat && selectedProperty?.lng && (
              <PropertyStreetView lat={selectedProperty.lat} lng={selectedProperty.lng} height={200} interactive />
            )}

            {/* Photos Section */}
            {(() => {
              const units = selectedProperty?.units || 1;
              const isSingleUnit = units <= 1;

              const pickPhotosFor = async (unitKey?: string) => {
                const result = await ImagePicker.launchImageLibraryAsync({
                  mediaTypes: ['images'],
                  allowsMultipleSelection: true,
                  quality: 0.7,
                  selectionLimit: 10,
                });
                if (result.canceled || !result.assets?.length) return;
                const newUris = result.assets.map(a => a.uri);
                const props = [...(profile?.properties || [])];
                const idx = props.findIndex(p => p.id === selectedProperty?.id);
                if (idx < 0) return;
                if (isSingleUnit || !unitKey) {
                  const existing = props[idx].photos || [];
                  props[idx] = { ...props[idx], photos: [...existing, ...newUris] };
                } else {
                  const unitPhotos = { ...(props[idx].unitPhotos || {}) };
                  const existing = unitPhotos[unitKey] || [];
                  unitPhotos[unitKey] = [...existing, ...newUris];
                  props[idx] = { ...props[idx], unitPhotos };
                }
                await setProfile({ properties: props });
                setSelectedProperty(props[idx]);
              };

              if (isSingleUnit) {
                const photos = selectedProperty?.photos || [];
                return (
                  <View style={{ marginTop: Spacing.sm, gap: Spacing.sm }}>
                    {photos.length > 0 ? (
                      <TouchableOpacity activeOpacity={0.7} onPress={() => { setViewerPhotos(photos); setViewerIndex(0); setViewerLabel('Photos'); }}
                        style={propModalStyles.unitCover}>
                        <Image source={{ uri: photos[0] }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
                        <View style={propModalStyles.coverOverlay}>
                          <Ionicons name="images-outline" size={18} color="#fff" />
                          <Text style={propModalStyles.coverText}>{photos.length} Photo{photos.length !== 1 ? 's' : ''}</Text>
                        </View>
                      </TouchableOpacity>
                    ) : null}
                    <TouchableOpacity activeOpacity={0.7} style={propModalStyles.addPhotoBtn}
                      onPress={() => pickPhotosFor()}>
                      <Ionicons name="camera-outline" size={14} color={Colors.primary} />
                      <Text style={propModalStyles.addPhotoText}>
                        {photos.length ? 'Add More Photos' : 'Add Property Photos'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                );
              }

              // Multi-unit – liquid glass cover cards
              const unitPhotosMap = selectedProperty?.unitPhotos || {};
              return (
                <View style={{ marginTop: Spacing.sm, gap: Spacing.sm }}>
                  {Array.from({ length: units }, (_, i) => {
                    const customLabel = selectedProperty?.unitLabels?.[i];
                    const unitKey = customLabel || `Unit ${i + 1}`;
                    const photos = unitPhotosMap[unitKey] || [];
                    return (
                      <View key={unitKey}>
                        {photos.length > 0 ? (
                          <TouchableOpacity activeOpacity={0.7}
                            onPress={() => { setViewerPhotos(photos); setViewerIndex(0); setViewerLabel(unitKey.toUpperCase()); }}
                            style={propModalStyles.unitCover}>
                            <Image source={{ uri: photos[0] }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
                            <View style={propModalStyles.coverOverlay}>
                              <Text style={propModalStyles.coverLabel}>{unitKey.toUpperCase()}</Text>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                <Ionicons name="images-outline" size={14} color="#fff" />
                                <Text style={propModalStyles.coverCount}>{photos.length}</Text>
                              </View>
                            </View>
                          </TouchableOpacity>
                        ) : (
                          <View style={propModalStyles.unitCardEmpty}>
                            <Text style={propModalStyles.unitLabel}>{unitKey.toUpperCase()}</Text>
                          </View>
                        )}
                        <TouchableOpacity activeOpacity={0.7}
                          style={photos.length > 0 ? propModalStyles.addPhotoBtnCompact : propModalStyles.unitAddBtn}
                          onPress={() => pickPhotosFor(unitKey)}>
                          <Ionicons name="camera-outline" size={13} color={Colors.primary} />
                          <Text style={photos.length > 0 ? propModalStyles.addPhotoTextCompact : propModalStyles.addPhotoText}>
                            {photos.length ? 'Add More' : 'Add Photos'}
                          </Text>
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                </View>
              );
            })()}

            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: Spacing.md }}>
              <Text style={styles.propertyUnits}>
                {selectedProperty?.units} {selectedProperty?.units === 1 ? 'unit' : 'units'}
              </Text>
              <Text style={[styles.propertyUnits, { color: selectedProperty?.isAirbnb ? Colors.primary : Colors.green }]}>
                {selectedProperty?.isAirbnb ? 'Airbnb / STR' : 'Long-Term'}
              </Text>
            </View>

            {/* ── Per-Property P&L ── */}
            {(() => {
              const pid = selectedProperty?.id;
              if (!pid) return null;

              // Filter transactions tagged to this property
              const propTxs = transactions.filter((t: any) => {
                if (isExcludedTag(t.property_tag) || isExcludedTag(t.category_tag)) return false;
                return t.property_tag === pid;
              });

              if (propTxs.length === 0) return (
                <View style={plDetailStyles.section}>
                  <Text style={plDetailStyles.sectionTitle}>PROFIT & LOSS</Text>
                  <Text style={{ fontSize: FontSize.sm, color: Colors.textDim }}>
                    No tagged transactions for this property yet
                  </Text>
                </View>
              );

              // Separate income vs expense transactions
              let totalIncome = 0;
              let totalExpenses = 0;
              const incomeTxs: any[] = [];
              const expenseByCat: Record<string, { label: string; color: string; total: number; txs: any[] }> = {};

              for (const tx of propTxs) {
                const catId = tx.category_tag;
                const amt = Math.abs(tx.amount ?? 0);

                if (catId && isIncomeCategory(catId)) {
                  totalIncome += amt;
                  incomeTxs.push(tx);
                } else if (catId && isExpenseCategory(catId)) {
                  totalExpenses += amt;
                  const catDef = getCategoryById(catId, 'owner');
                  const key = catId;
                  if (!expenseByCat[key]) {
                    expenseByCat[key] = { label: catDef?.label || catId, color: catDef?.color || Colors.red, total: 0, txs: [] };
                  }
                  expenseByCat[key].total += amt;
                  expenseByCat[key].txs.push(tx);
                } else if (!catId) {
                  // Fallback to Plaid type when no category tag
                  if (tx.amount < 0) {
                    totalIncome += amt;
                    incomeTxs.push(tx);
                  } else {
                    totalExpenses += amt;
                    const key = '__uncategorized__';
                    if (!expenseByCat[key]) {
                      expenseByCat[key] = { label: 'Uncategorized', color: Colors.textDim, total: 0, txs: [] };
                    }
                    expenseByCat[key].total += amt;
                    expenseByCat[key].txs.push(tx);
                  }
                }
              }

              const netPL = totalIncome - totalExpenses;
              const sortedExpCats = Object.values(expenseByCat).sort((a, b) => b.total - a.total);

              return (
                <View style={plDetailStyles.section}>
                  <Text style={plDetailStyles.sectionTitle}>PROFIT & LOSS</Text>

                  {/* Income */}
                  <View style={plDetailStyles.lineItem}>
                    <View style={plDetailStyles.lineHeader}>
                      <Text style={[plDetailStyles.lineLabel, { color: Colors.green }]}>Income</Text>
                      <Text style={[plDetailStyles.lineTotal, { color: Colors.green }]}>+{fmt$(totalIncome)}</Text>
                    </View>
                    {incomeTxs.map((tx: any) => (
                      <View key={tx.id} style={plDetailStyles.txRow}>
                        <Text style={plDetailStyles.txName} numberOfLines={1}>
                          {tx.payee || tx.name || tx.merchant || 'Unknown'}
                        </Text>
                        <Text style={plDetailStyles.txDate}>{fmtDate(tx.date || '')}</Text>
                        <Text style={[plDetailStyles.txAmt, { color: Colors.green }]}>+{fmt$(Math.abs(tx.amount ?? 0))}</Text>
                      </View>
                    ))}
                  </View>

                  {/* Expense categories */}
                  {sortedExpCats.map(cat => (
                    <View key={cat.label} style={plDetailStyles.lineItem}>
                      <View style={plDetailStyles.lineHeader}>
                        <Text style={[plDetailStyles.lineLabel, { color: cat.color }]}>{cat.label}</Text>
                        <Text style={[plDetailStyles.lineTotal, { color: Colors.red }]}>-{fmt$(cat.total)}</Text>
                      </View>
                      {cat.txs.map((tx: any) => (
                        <View key={tx.id} style={plDetailStyles.txRow}>
                          <Text style={plDetailStyles.txName} numberOfLines={1}>
                            {tx.payee || tx.name || tx.merchant || 'Unknown'}
                          </Text>
                          <Text style={plDetailStyles.txDate}>{fmtDate(tx.date || '')}</Text>
                          <Text style={[plDetailStyles.txAmt, { color: Colors.red }]}>-{fmt$(Math.abs(tx.amount ?? 0))}</Text>
                        </View>
                      ))}
                    </View>
                  ))}

                  {/* Net P&L */}
                  <View style={plDetailStyles.netRow}>
                    <Text style={plDetailStyles.netLabel}>Net Profit / Loss</Text>
                    <Text style={[plDetailStyles.netValue, { color: netPL >= 0 ? Colors.green : Colors.red }]}>
                      {netPL >= 0 ? '+' : ''}{fmt$(netPL)}
                    </Text>
                  </View>
                  <Text style={plDetailStyles.txCount}>
                    {propTxs.length} tagged transaction{propTxs.length !== 1 ? 's' : ''}
                  </Text>
                </View>
              );
            })()}

            <TouchableOpacity activeOpacity={0.7} style={modalStyles.doneBtn} onPress={() => { setSelectedProperty(null); setViewerPhotos([]); }}>
              <Text style={modalStyles.doneText}>Close</Text>
            </TouchableOpacity>
          </ScrollView>
          </>
          )}
        </View>
      </Modal>

      {/* Photo viewer is now inline within the property detail pageSheet */}

      {/* ── Customize Profile Modal ── */}
      <Modal visible={showCustomize} transparent animationType="slide" onRequestClose={() => setShowCustomize(false)}>
        <TouchableOpacity activeOpacity={1} style={modalStyles.overlay} onPress={() => setShowCustomize(false)}>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ justifyContent: 'flex-end', flexGrow: 1 }} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
          <View style={modalStyles.card} onStartShouldSetResponder={() => true}>
            <View style={modalStyles.handle} />
            <Text style={modalStyles.title}>CUSTOMIZE PROFILE</Text>
            <Text style={modalStyles.subtitle}>
              Toggle visibility and reorder cards on your public profile.
            </Text>
            {availableCards.map((opt, i) => (
              <React.Fragment key={opt.key}>
                <View style={modalStyles.row}>
                  <View style={modalStyles.reorderBtns}>
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={() => moveCard(opt.key, 'up')}
                      disabled={i === 0}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <Ionicons name="chevron-up" size={16} color={i === 0 ? Colors.border : Colors.textDim} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={() => moveCard(opt.key, 'down')}
                      disabled={i === availableCards.length - 1}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <Ionicons name="chevron-down" size={16} color={i === availableCards.length - 1 ? Colors.border : Colors.textDim} />
                    </TouchableOpacity>
                  </View>
                  <View style={modalStyles.iconWrap}>
                    <Ionicons name={opt.icon as any} size={18} color={Colors.primary} />
                  </View>
                  <View style={modalStyles.labelWrap}>
                    <Text style={modalStyles.label}>{opt.label}</Text>
                    <Text style={modalStyles.desc}>{opt.desc}</Text>
                  </View>
                  <Switch
                    value={cardVisibility[opt.key] !== false}
                    onValueChange={() => toggleCard(opt.key)}
                    trackColor={{ true: Colors.green, false: 'rgba(0,0,0,0.12)' }}
                  />
                </View>
                {i < availableCards.length - 1 && <View style={modalStyles.divider} />}
              </React.Fragment>
            ))}
            <TouchableOpacity activeOpacity={0.7}
          style={modalStyles.doneBtn} onPress={() => setShowCustomize(false)}>
              <Text style={modalStyles.doneText}>Done</Text>
            </TouchableOpacity>
          </View>
          </ScrollView>
        </TouchableOpacity>
      </Modal>
    </ScrollView>
  );
}

// ── Percent Change Badge ──
function PctBadge({ value, invert = false }: { value: number; invert?: boolean }) {
  const isPositive = value >= 0;
  const isGood = invert ? !isPositive : isPositive;
  const color = isGood ? Colors.green : Colors.red;
  const icon = isPositive ? 'trending-up' : 'trending-down';

  return (
    <View style={[pctStyles.badge, { backgroundColor: color + '15' }]}>
      <Ionicons name={icon as any} size={10} color={color} />
      <Text style={[pctStyles.text, { color }]}>
        {isPositive ? '+' : ''}{value.toFixed(1)}%
      </Text>
    </View>
  );
}

const plStyles = StyleSheet.create({
  totalsRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm, marginBottom: Spacing.xs },
  totalCol: { flex: 1 },
  totalLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '500', marginBottom: 2 },
  totalValue: { fontSize: FontSize.lg, fontWeight: '700' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border, marginVertical: Spacing.sm },
  propRow: {},
  propHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  propName: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  propNet: { fontSize: FontSize.sm, fontWeight: '700' },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  barTrack: { flex: 1, height: 5, backgroundColor: Colors.border, borderRadius: 3, overflow: 'hidden', flexDirection: 'row' },
  barGreen: { height: '100%', backgroundColor: Colors.green + '70' },
  barRed: { height: '100%', backgroundColor: Colors.red + '70' },
  marginText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600', width: 36, textAlign: 'right' },
  summary: { fontSize: FontSize.xs, color: Colors.textDim, marginTop: Spacing.sm },
});

const pctStyles = StyleSheet.create({
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: 2,
    paddingHorizontal: 5, paddingVertical: 2, borderRadius: 6,
    marginTop: 3,
  },
  text: { fontSize: 9, fontWeight: '700' },
});

const propModalStyles = StyleSheet.create({
  photo: {
    width: 140, height: 100, borderRadius: Radius.md,
  },
  addPhotoBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs,
    padding: Spacing.sm,
    borderWidth: 1.5, borderColor: Colors.primary + '40', borderStyle: 'dashed',
    borderRadius: Radius.md, backgroundColor: Colors.greenDim,
  },
  addPhotoText: {
    fontSize: FontSize.sm, color: Colors.primary, fontWeight: '500',
  },
  addPhotoBtnCompact: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    marginTop: 6, paddingVertical: 4,
    borderWidth: 1, borderColor: Colors.primary + '30', borderStyle: 'dashed',
    borderRadius: Radius.sm,
  },
  addPhotoTextCompact: {
    fontSize: FontSize.xs, color: Colors.primary, fontWeight: '500',
  },
  unitCover: {
    height: 100,
    borderRadius: Radius.lg,
    overflow: 'hidden',
    backgroundColor: Colors.glassDark,
  },
  coverOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.60)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
  },
  coverLabel: {
    fontSize: FontSize.md,
    fontWeight: '700',
    letterSpacing: 1,
    color: '#fff',
  },
  coverText: {
    fontSize: FontSize.sm,
    fontWeight: '600',
    color: '#fff',
  },
  coverCount: {
    fontSize: FontSize.sm,
    fontWeight: '600',
    color: '#fff',
  },
  unitCardEmpty: {
    backgroundColor: Colors.glass,
    borderRadius: Radius.lg,
    padding: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
    borderTopWidth: 1,
    borderTopColor: Colors.glassHighlight,
  },
  unitLabel: {
    fontSize: FontSize.xs,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: Colors.textDim,
  },
  unitAddBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs,
    marginTop: Spacing.xs, paddingVertical: 6,
    borderWidth: 1.5, borderColor: Colors.primary + '40', borderStyle: 'dashed',
    borderRadius: Radius.md, backgroundColor: Colors.greenDim,
  },
});

const modalStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.60)', justifyContent: 'flex-end', paddingTop: 120 },
  card: {
    backgroundColor: Colors.glassOverlay, borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl,
    padding: Spacing.lg, paddingBottom: Spacing.xl * 2,
  },
  handle: {
    width: 36, height: 4, backgroundColor: 'rgba(0,0,0,0.12)', borderRadius: 2,
    alignSelf: 'center', marginBottom: Spacing.lg,
  },
  title: {
    fontSize: FontSize.xs, fontWeight: '700', letterSpacing: 0.8,
    color: Colors.textDim, textTransform: 'uppercase', marginBottom: Spacing.xs,
  },
  subtitle: {
    fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20,
    marginBottom: Spacing.lg,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.md, gap: Spacing.sm,
  },
  iconWrap: {
    width: 30, height: 30, borderRadius: 7, backgroundColor: Colors.greenDim,
    alignItems: 'center', justifyContent: 'center',
  },
  reorderBtns: {
    alignItems: 'center', justifyContent: 'center', gap: 2,
  },
  labelWrap: { flex: 1 },
  label: { fontSize: FontSize.md, color: Colors.text },
  desc: { fontSize: FontSize.xs, color: Colors.textDim, marginTop: 1 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border, marginLeft: 42 },
  doneBtn: {
    marginTop: Spacing.lg, backgroundColor: Colors.green, borderRadius: Radius.md,
    padding: Spacing.md, alignItems: 'center',
  },
  doneText: { fontSize: FontSize.md, fontWeight: '600', color: '#fff' },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  content: { padding: Spacing.md, paddingTop: 140, paddingBottom: Spacing.xl },
  loadingContainer: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },
  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: 'rgba(239,68,68,0.08)', borderRadius: Radius.md,
    padding: Spacing.sm, marginBottom: Spacing.md, borderWidth: 0.5, borderColor: 'rgba(239,68,68,0.20)',
  },
  errorBannerText: { fontSize: FontSize.xs, color: Colors.red, flex: 1, lineHeight: 16 },

  // ── Profile Header (Instagram-style) ──
  profileHeader: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.xl,
    marginBottom: Spacing.sm,
  },
  avatarCircle: {
    width: 76, height: 76, borderRadius: 38,
    backgroundColor: Colors.green,
    alignItems: 'center', justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.25, shadowRadius: 20 },
    }),
  },
  avatarText: { fontSize: 30, fontWeight: '700', color: '#fff' },
  statsRow: { flex: 1, flexDirection: 'row', justifyContent: 'space-evenly', alignSelf: 'center' },
  stat: { alignItems: 'center' },
  statNumber: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  statLabel: { fontSize: 11, color: Colors.textSecondary, marginTop: 1 },

  // ── Name ──
  nameLeft: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: Spacing.md },
  username: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },

  // ── FY Comparison ──
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

  // ── Quarter Snapshot ──
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

  // ── This Month ──
  sectionLabel: {
    fontSize: FontSize.xs, color: Colors.textSecondary,
    letterSpacing: 0.8, fontWeight: '600', marginBottom: Spacing.sm,
  },
  metricsRow: { flexDirection: 'row', alignItems: 'flex-start' },
  metric: { flex: 1, alignItems: 'center' },
  metricDivider: { width: StyleSheet.hairlineWidth, height: 50, backgroundColor: Colors.border, marginTop: 4 },
  metricLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, marginBottom: 2 },
  metricValue: { fontSize: FontSize.lg, fontWeight: '700' },
  marginLabel: { fontSize: 9, color: Colors.textDim, marginTop: 3 },

  // ── Quarterly ──
  quarterRow: {
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  quarterRowCurrent: {
    backgroundColor: Colors.greenDim,
    marginHorizontal: -Spacing.md,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.md,
    borderBottomWidth: 0,
  },
  quarterHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  quarterLabel: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text },
  quarterLabelCurrent: { color: Colors.primary },
  projBadge: {
    fontSize: 9, fontWeight: '600', color: Colors.textDim,
    backgroundColor: Colors.border, paddingHorizontal: 6, paddingVertical: 1,
    borderRadius: 4, overflow: 'hidden',
  },
  currentBadge: {
    fontSize: 9, fontWeight: '600', color: Colors.primary,
    backgroundColor: Colors.green + '18', paddingHorizontal: 6, paddingVertical: 1,
    borderRadius: 4, overflow: 'hidden',
  },
  quarterMetrics: { flexDirection: 'row' },
  quarterMetric: { flex: 1 },
  quarterMetricLabel: { fontSize: 10, color: Colors.textSecondary, marginBottom: 1 },
  quarterMetricValue: { fontSize: FontSize.sm, fontWeight: '700' },

  // ── Annual ──
  annualGrid: { gap: Spacing.sm },
  annualItem: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
  },
  annualLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },
  annualValue: { fontSize: FontSize.md, fontWeight: '700' },
  projectionNote: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: Spacing.sm, paddingTop: Spacing.sm,
  },
  projectionNoteText: { fontSize: 11, color: Colors.textDim, fontStyle: 'italic' },

  // ── Properties ──
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: Spacing.sm },
  infoLabel: { flex: 1, fontSize: FontSize.sm, fontWeight: '500', color: Colors.text },
  infoValue: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text },
  propertyRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingVertical: 8, paddingLeft: 26,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border,
  },
  propertyThumb: {
    width: 40, height: 40, borderRadius: Radius.sm,
  },
  propertyThumbPlaceholder: {
    backgroundColor: Colors.glassDark,
    alignItems: 'center', justifyContent: 'center',
  },
  propertyInfo: { flex: 1 },
  propertyName: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '500' },
  propertyUnits: { fontSize: FontSize.xs, color: Colors.textDim, marginTop: 1 },

  // ── Widget styles ──
  perfBar: {
    flexDirection: 'row', height: 5, borderRadius: 3, overflow: 'hidden', marginTop: Spacing.sm,
  },
  perfBarGreen: { height: '100%', backgroundColor: Colors.green + '60' },
  perfBarRed: { height: '100%', backgroundColor: Colors.red + '60' },
  widgetCompactRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
  },
  widgetCompactText: {
    fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500', flex: 1,
  },
  okBadge: {
    backgroundColor: 'rgba(16,185,129,0.12)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: Radius.pill,
  },
  okBadgeText: { fontSize: 10, fontWeight: '700', color: Colors.green },
});

const txStyles = StyleSheet.create({
  section: {
    marginBottom: Spacing.md,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.xs,
  },
  untaggedBadge: {
    backgroundColor: Colors.red + '15', paddingHorizontal: 8, paddingVertical: 2, borderRadius: Radius.pill,
  },
  untaggedBadgeText: { fontSize: 10, fontWeight: '700', color: Colors.red },
  row: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 10,
  },
  rowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border,
  },
  rowInfo: { flex: 1, marginRight: Spacing.sm },
  rowName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.text },
  rowDate: { fontSize: FontSize.xs, color: Colors.textDim, marginTop: 1 },
  rowAmt: { fontSize: FontSize.sm, fontWeight: '700' },
  tagDot: {
    width: 6, height: 6, borderRadius: 3, backgroundColor: Colors.red,
    marginLeft: 6,
  },
  tagPills: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 6,
    paddingBottom: Spacing.sm, paddingLeft: Spacing.xs,
  },
  tagPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: Radius.pill,
    backgroundColor: Colors.glassDark, borderWidth: 1, borderColor: Colors.glassBorder,
  },
  tagPillActive: {
    backgroundColor: Colors.green + '18', borderColor: Colors.primary,
  },
  tagPillText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary },
  tagPillTextActive: { color: Colors.primary },
  tagStepLabel: {
    fontSize: FontSize.xs, fontWeight: '700', color: Colors.textSecondary,
    width: '100%', marginBottom: 2,
  },
  tagPillSkip: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: Radius.pill,
    backgroundColor: Colors.glassDark, borderWidth: 1, borderColor: Colors.glassBorder,
  },
  tagPillSkipText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.primary },
  tagPillRemove: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 8, paddingVertical: 5, borderRadius: Radius.pill,
    backgroundColor: Colors.red + '10', borderWidth: 1, borderColor: Colors.red + '30',
  },
  tagPillRemoveText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.red },
  showAllBtn: {
    alignItems: 'center', paddingVertical: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border,
    marginTop: Spacing.xs,
  },
  showAllText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.primary },
});

const tagSheetStyles = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.60)', justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Colors.glassOverlay,
    borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl,
    padding: Spacing.lg, paddingBottom: Spacing.xl * 2,
    borderTopColor: Colors.glassHighlight, borderTopWidth: 1,
    ...Platform.select({
      ios: { shadowColor: Colors.glassShadow, shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.25, shadowRadius: 16 },
      android: { elevation: 8 },
    }),
  },
  handle: {
    width: 36, height: 4, backgroundColor: 'rgba(0,0,0,0.12)', borderRadius: 2,
    alignSelf: 'center', marginBottom: Spacing.lg,
  },
  title: {
    fontSize: FontSize.xs, fontWeight: '700', letterSpacing: 0.8,
    color: Colors.textDim, textTransform: 'uppercase', marginBottom: Spacing.xs,
  },
  subtitle: {
    fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.md,
  },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    padding: Spacing.md, borderRadius: Radius.md,
    backgroundColor: Colors.glass, borderWidth: 0.5, borderColor: Colors.glassBorder,
    marginBottom: Spacing.sm,
  },
  optionText: { flex: 1 },
  optionLabel: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  optionHint: { fontSize: FontSize.xs, color: Colors.textDim, marginTop: 1 },
  cancelBtn: {
    marginTop: Spacing.sm, padding: Spacing.md, borderRadius: Radius.pill,
    backgroundColor: Colors.glass, alignItems: 'center',
    borderWidth: 0.5, borderColor: Colors.glassBorder,
  },
  cancelText: { fontSize: FontSize.md, color: Colors.textSecondary },
});

const plDetailStyles = StyleSheet.create({
  section: {
    marginTop: Spacing.lg, paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border,
  },
  sectionTitle: {
    fontSize: FontSize.xs, fontWeight: '700', letterSpacing: 0.8,
    color: Colors.textDim, marginBottom: Spacing.md,
  },
  lineItem: {
    marginBottom: Spacing.md,
  },
  lineHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: Spacing.xs,
  },
  lineLabel: { fontSize: FontSize.sm, fontWeight: '700' },
  lineTotal: { fontSize: FontSize.sm, fontWeight: '700' },
  txRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 4, paddingLeft: Spacing.sm,
    gap: Spacing.xs,
  },
  txName: { flex: 1, fontSize: FontSize.xs, color: Colors.textSecondary },
  txDate: { fontSize: FontSize.xs, color: Colors.textDim },
  txAmt: { fontSize: FontSize.xs, fontWeight: '600', minWidth: 60, textAlign: 'right' },
  netRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingTop: Spacing.sm, marginTop: Spacing.xs,
    borderTopWidth: 1, borderTopColor: Colors.border,
  },
  netLabel: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  netValue: { fontSize: FontSize.lg, fontWeight: '800' },
  txCount: { fontSize: FontSize.xs, color: Colors.textDim, marginTop: Spacing.xs },
});

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
  TouchableOpacity, TextInput, Alert, Platform, ActivityIndicator,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as SecureStore from 'expo-secure-store';
import { Colors, FontSize, Spacing, Radius } from '../../constants/theme';
import { useUserStore } from '../../store/userStore';
import { useCleanerStore } from '../../store/cleanerStore';
import { useDataStore } from '../../store/dataStore';
import { Card } from '../../components/Card';
import { BarChart, BarData } from '../../components/BarChart';
import { fmt$, fmtDate } from '../../utils/format';
import { SqftRates } from '../../navigation/CleanerNavigator';
import { apiFetch } from '../../services/api';
import {
  CLEANER_CATEGORIES, SPECIAL_TAGS as CATEGORY_SPECIAL_TAGS,
  getCategoryById, isExcludedTag,
} from '../../constants/categoryTags';

const RATES_KEY = 'pp_cleaning_rates';

const SQ_FT_DISPLAY = [
  { key: 'small', label: 'Small', desc: '< 1,000 sqft' },
  { key: 'medium', label: 'Medium', desc: '1,000 – 2,000 sqft' },
  { key: 'large', label: 'Large', desc: '2,000 – 3,000 sqft' },
  { key: 'xl', label: 'XL', desc: '3,000+ sqft' },
];

export function CleanerProfileScreen({ sqftRates, onOpenRates }: { sqftRates?: SqftRates | null; onOpenRates?: () => void }) {
  const profile = useUserStore(s => s.profile);
  const { schedule, owners, fetchSchedule, fetchOwners, fetchHistory, history } = useCleanerStore();
  const { fetchTransactions, fetchCategoryTags, saveCategoryTag, fetchCustomCategories } = useDataStore();
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rates, setRates] = useState<Record<string, number>>({});
  const [editingRate, setEditingRate] = useState<string | null>(null);
  const [rateInput, setRateInput] = useState('');
  const [rating, setRating] = useState<{ average: number | null; count: number }>({ average: null, count: 0 });
  const [transactions, setTransactions] = useState<any[]>([]);
  const [categoryTags, setCategoryTags] = useState<Record<string, string>>({});
  const [txTaggingId, setTxTaggingId] = useState<string | null>(null);
  const [txTagSaving, setTxTagSaving] = useState(false);
  const [txShowAll, setTxShowAll] = useState(false);
  const [customCategories, setCustomCategories] = useState<any[]>([]);

  const displayName = profile?.username || 'Cleaner';
  const initial = displayName[0].toUpperCase();
  const isPro = profile?.isSubscriptionActive || profile?.isFounder || profile?.lifetimeFree;

  const fetchRating = useCallback(async () => {
    try {
      const data = await apiFetch('/api/cleaner/my-rating');
      setRating(data);
    } catch {}
  }, []);

  // Show rates banner when no rates have been set yet
  const hasAnyRate = sqftRates && Object.values(sqftRates.ranges).some(v => v != null);

  useEffect(() => {
    Promise.all([
      loadRates(), fetchSchedule(), fetchOwners(), fetchHistory(), fetchRating(),
      fetchTransactions().catch(() => []),
      fetchCategoryTags().catch(() => ({})),
      fetchCustomCategories().catch(() => []),
    ])
      .then(results => {
        const txs = results[5] || [];
        setTransactions([...txs].sort((a: any, b: any) => (b.date || '').localeCompare(a.date || '')));
        setCategoryTags(results[6] || {});
        setCustomCategories(results[7] || []);
      })
      .catch(() => setError('Could not load profile data.'))
      .finally(() => setLoading(false));
  }, []);

  const loadRates = async () => {
    try {
      const raw = await SecureStore.getItemAsync(RATES_KEY);
      if (raw) setRates(JSON.parse(raw));
    } catch {}
  };

  const saveRate = async (propId: string) => {
    const val = parseFloat(rateInput);
    if (isNaN(val) || val <= 0) { Alert.alert('Invalid', 'Enter a valid rate'); return; }
    const updated = { ...rates, [propId]: val };
    await SecureStore.setItemAsync(RATES_KEY, JSON.stringify(updated));
    setRates(updated);
    setEditingRate(null);
    setRateInput('');
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const [,,,, txs, catTags] = await Promise.all([
        fetchSchedule(true), fetchOwners(), fetchHistory(true), fetchRating(),
        fetchTransactions(true).catch(() => []),
        fetchCategoryTags(true).catch(() => ({})),
      ]);
      await loadRates();
      setTransactions([...(txs || [])].sort((a: any, b: any) => (b.date || '').localeCompare(a.date || '')));
      setCategoryTags(catTags || {});
    } catch { setError('Could not load profile data.'); }
    finally { setRefreshing(false); }
  }, [fetchSchedule, fetchOwners, fetchHistory, fetchRating, fetchTransactions, fetchCategoryTags]);

  // All events (history + schedule)
  const allEvents = useMemo(() => {
    const combined = [...history, ...schedule];
    const seen = new Set<string>();
    return combined.filter(e => {
      if (seen.has(e.uid)) return false;
      seen.add(e.uid);
      return true;
    });
  }, [history, schedule]);

  // Stats
  const totalCleanings = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return allEvents.filter(e => (e.check_out || '').slice(0, 10) <= today).length;
  }, [allEvents]);

  const hostCount = owners.length;

  // Unique properties across all events
  const uniqueProps = useMemo(() => {
    const map = new Map<string, string>();
    allEvents.forEach(e => {
      if (e.prop_id && !map.has(e.prop_id)) map.set(e.prop_id, e.prop_name);
    });
    return Array.from(map.entries());
  }, [allEvents]);

  // This month stats
  const thisMonth = new Date().toISOString().slice(0, 7);
  const monthCleanings = useMemo(() => {
    return allEvents.filter(e => (e.check_out || '').slice(0, 7) === thisMonth).length;
  }, [allEvents, thisMonth]);

  const monthRevenue = useMemo(() => {
    return allEvents
      .filter(e => (e.check_out || '').slice(0, 7) === thisMonth)
      .reduce((sum, e) => sum + (rates[e.prop_id] || 0), 0);
  }, [allEvents, thisMonth, rates]);

  const avgRate = useMemo(() => {
    const rateVals = Object.values(rates);
    if (rateVals.length === 0) return 0;
    return rateVals.reduce((s, r) => s + r, 0) / rateVals.length;
  }, [rates]);

  // Monthly revenue bars (last 6 months)
  const monthlyBars: BarData[] = useMemo(() => {
    const bars: BarData[] = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const ym = d.toISOString().slice(0, 7);
      const label = d.toLocaleDateString('en-US', { month: 'short' });
      const rev = allEvents
        .filter(e => (e.check_out || '').slice(0, 7) === ym)
        .reduce((sum, e) => sum + (rates[e.prop_id] || 0), 0);
      bars.push({
        label,
        value: rev,
        isActual: true,
        isCurrent: i === 0,
      });
    }
    return bars;
  }, [allEvents, rates]);

  // Merge default + custom categories for cleaner picker
  const allCleanerCategories = useMemo(() => [
    ...CLEANER_CATEGORIES,
    ...customCategories.map((c: any) => ({
      id: c.id,
      label: c.label,
      icon: c.type === 'income' ? 'arrow-down-outline' : 'arrow-up-outline',
      color: c.color || '#A1A1AA',
      bgColor: c.bgColor || 'rgba(255,255,255,0.08)',
      type: c.type,
    })),
  ], [customCategories]);

  // ── Transaction data ──
  const untaggedTxs = useMemo(() => transactions.filter((t: any) => !t.property_tag && !t.category_tag), [transactions]);
  const taggedTxs = useMemo(() => transactions.filter((t: any) => !!t.property_tag || !!t.category_tag), [transactions]);
  const untaggedCount = untaggedTxs.length;
  const visibleTxs = useMemo(() => {
    const list = [...untaggedTxs, ...taggedTxs];
    return txShowAll ? list : list.slice(0, 20);
  }, [untaggedTxs, taggedTxs, txShowAll]);

  const handleCategoryTag = useCallback(async (txId: string, categoryId: string | null) => {
    setTxTagSaving(true);
    try {
      await saveCategoryTag(txId, categoryId);
      setCategoryTags(prev => {
        const updated = { ...prev };
        if (categoryId) updated[txId] = categoryId;
        else delete updated[txId];
        return updated;
      });
      setTransactions(prev => prev.map(t => t.id === txId ? { ...t, category_tag: categoryId } : t));
      setTxTaggingId(null);
    } catch {}
    setTxTagSaving(false);
  }, [saveCategoryTag]);

  // Hosts with property counts
  const hostProps = useMemo(() => {
    const map = new Map<string, { name: string; props: Set<string> }>();
    allEvents.forEach(e => {
      if (!e.owner_id) return;
      if (!map.has(e.owner_id)) map.set(e.owner_id, { name: e.owner, props: new Set() });
      map.get(e.owner_id)!.props.add(e.prop_id);
    });
    return Array.from(map.entries()).map(([id, data]) => ({
      id, name: data.name, propCount: data.props.size,
    }));
  }, [allEvents]);


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
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={"#FFFFFF"} colors={["#FFFFFF"]} />}
    >
      {error && (
        <View style={styles.errorBanner}>
          <Ionicons name="cloud-offline-outline" size={16} color={Colors.red} />
          <Text style={styles.errorBannerText}>{error}</Text>
        </View>
      )}
      {/* Rates banner — shown until rates are set, tappable to open rate modal */}
      {!hasAnyRate && (
        <TouchableOpacity activeOpacity={0.7} style={styles.ratesBanner} onPress={onOpenRates}>
          <View style={styles.ratesBannerContent}>
            <Ionicons name="pricetag-outline" size={20} color={Colors.primary} />
            <Text style={styles.ratesBannerText}>
              Set cleaner rates so hosts can see your prices!
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={Colors.primary} />
        </TouchableOpacity>
      )}

      {/* Header */}
      <View style={styles.profileHeader}>
        <View style={styles.avatarCircle}>
          <Text style={styles.avatarText}>{initial}</Text>
        </View>
        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text style={styles.statNumber}>{totalCleanings}</Text>
            <Text style={styles.statLabel}>Cleanings</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statNumber}>{hostCount}</Text>
            <Text style={styles.statLabel}>Hosts</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statNumber}>
              {rating.average != null ? rating.average.toFixed(1) : '--'}
            </Text>
            <Text style={styles.statLabel}>Rating</Text>
          </View>
        </View>
      </View>

      <View style={styles.nameRow}>
        <Text style={styles.username}>{displayName}</Text>
        <View style={styles.cleanerBadge}>
          <Text style={styles.cleanerBadgeText}>Cleaner</Text>
        </View>
        {isPro && <Ionicons name="checkmark-circle" size={18} color={Colors.primary} />}
      </View>

      {/* ── Fixed Transactions Section (not a Card) ── */}
      {transactions.length > 0 && (
        <View style={txStyles.section}>
          <View style={txStyles.header}>
            <Text style={styles.sectionLabel}>TRANSACTIONS</Text>
            {untaggedCount > 0 && (
              <View style={txStyles.untaggedBadge}>
                <Text style={txStyles.untaggedBadgeText}>{untaggedCount} untagged</Text>
              </View>
            )}
          </View>
          {visibleTxs.map((t: any, i: number) => {
            const amt = t.amount ?? 0;
            const isTagging = txTaggingId === t.id;
            const excluded = isExcludedTag(t.property_tag) || isExcludedTag(t.category_tag);
            const isIncome = amt < 0;
            const displayAmt = Math.abs(amt);
            const prefix = isIncome ? '+' : '-';
            const amtColor = excluded ? Colors.textDim : (isIncome ? Colors.green : Colors.red);
            const catDef = t.category_tag ? getCategoryById(t.category_tag, 'cleaner') : null;
            return (
              <View key={t.id}>
                <TouchableOpacity
                  activeOpacity={0.7}
                  style={[txStyles.row, excluded && { opacity: 0.45 }]}
                  onPress={() => setTxTaggingId(isTagging ? null : t.id)}
                >
                  <View style={txStyles.rowInfo}>
                    <Text style={[txStyles.rowName, excluded && { textDecorationLine: 'line-through' }]} numberOfLines={1}>
                      {t.payee || t.name || t.merchant || t.description || 'Unknown'}
                    </Text>
                    <Text style={txStyles.rowDate}>
                      {fmtDate(t.date || '')}
                      {catDef ? ` · ${catDef.label}` : ''}
                    </Text>
                  </View>
                  <Text style={[txStyles.rowAmt, { color: amtColor }]}>
                    {prefix}{fmt$(displayAmt)}
                  </Text>
                  {!t.property_tag && !t.category_tag && (
                    <View style={txStyles.tagDot} />
                  )}
                </TouchableOpacity>
                {isTagging && (
                  <View style={txStyles.tagPills}>
                    {/* Cleaner category tags */}
                    {allCleanerCategories.map(cat => (
                      <TouchableOpacity
                        key={cat.id}
                        activeOpacity={0.7}
                        style={[
                          txStyles.tagPill,
                          { borderColor: cat.color + '40' },
                          t.category_tag === cat.id && { backgroundColor: cat.bgColor, borderColor: cat.color },
                        ]}
                        onPress={() => handleCategoryTag(t.id, cat.id)}
                        disabled={txTagSaving}
                      >
                        <Ionicons name={cat.icon as any} size={11} color={t.category_tag === cat.id ? cat.color : Colors.textDim} />
                        <Text style={[
                          txStyles.tagPillText,
                          t.category_tag === cat.id && { color: cat.color },
                        ]}>
                          {cat.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                    {/* Special tags */}
                    {CATEGORY_SPECIAL_TAGS.map(tag => (
                      <TouchableOpacity
                        key={tag.id}
                        activeOpacity={0.7}
                        style={[
                          txStyles.tagPill,
                          { borderColor: tag.color + '40' },
                          t.category_tag === tag.id && { backgroundColor: tag.bgColor, borderColor: tag.color },
                        ]}
                        onPress={() => handleCategoryTag(t.id, tag.id)}
                        disabled={txTagSaving}
                      >
                        <Ionicons name={tag.icon as any} size={11} color={t.category_tag === tag.id ? tag.color : Colors.textDim} />
                        <Text style={[
                          txStyles.tagPillText,
                          t.category_tag === tag.id && { color: tag.color },
                        ]}>
                          {tag.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                    {/* Untag option */}
                    {t.category_tag && (
                      <TouchableOpacity
                        activeOpacity={0.7}
                        style={txStyles.tagPillRemove}
                        onPress={() => handleCategoryTag(t.id, null)}
                        disabled={txTagSaving}
                      >
                        <Ionicons name="close-circle" size={12} color={Colors.red} />
                        <Text style={txStyles.tagPillRemoveText}>Untag</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}
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
        </View>
      )}

      {/* This Month */}
      <Card>
        <Text style={styles.sectionLabel}>THIS MONTH</Text>
        <View style={styles.metricsRow}>
          <View style={styles.metric}>
            <Text style={styles.metricLabel}>Revenue</Text>
            <Text style={[styles.metricValue, { color: Colors.green }]}>{fmt$(monthRevenue)}</Text>
          </View>
          <View style={styles.metricDivider} />
          <View style={styles.metric}>
            <Text style={styles.metricLabel}>Cleanings</Text>
            <Text style={styles.metricValue}>{monthCleanings}</Text>
          </View>
          <View style={styles.metricDivider} />
          <View style={styles.metric}>
            <Text style={styles.metricLabel}>Avg Rate</Text>
            <Text style={styles.metricValue}>{avgRate > 0 ? fmt$(avgRate) : '--'}</Text>
          </View>
        </View>
      </Card>

      {/* Hosts */}
      <Card>
        <Text style={styles.sectionLabel}>HOSTS</Text>
        {hostProps.length === 0 ? (
          <Text style={styles.emptyText}>No hosts yet. Follow an owner from the Owners tab.</Text>
        ) : (
          hostProps.map((h, i) => (
            <View key={h.id} style={[styles.hostRow, i > 0 && styles.hostRowBorder]}>
              <View style={styles.hostAvatar}>
                <Text style={styles.hostAvatarText}>{h.name[0]?.toUpperCase() || '?'}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.hostName}>{h.name}</Text>
                <Text style={styles.hostSub}>{h.propCount} {h.propCount === 1 ? 'property' : 'properties'}</Text>
              </View>
            </View>
          ))
        )}
      </Card>

      {/* Performance — mini bar chart */}
      <Card>
        <Text style={styles.sectionLabel}>PERFORMANCE</Text>
        <BarChart bars={monthlyBars} color={Colors.green} height={100} />
      </Card>

      {/* Cleaning Rates by Square Footage */}
      {sqftRates?.showOnProfile && (
        <Card>
          <Text style={styles.sectionLabel}>CLEANING RATES</Text>
          {SQ_FT_DISPLAY.map((r, i) => {
            const val = sqftRates.ranges[r.key];
            if (val == null) return null;
            return (
              <View key={r.key} style={[styles.rateRow, i > 0 && styles.hostRowBorder]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.ratePropName}>{r.label}</Text>
                  <Text style={styles.rateDesc}>{r.desc}</Text>
                </View>
                <Text style={styles.rateAmount}>{fmt$(val)}</Text>
              </View>
            );
          })}
          {Object.values(sqftRates.ranges).every(v => v == null) && (
            <Text style={styles.emptyText}>No rates set yet. Use the menu to set rates.</Text>
          )}
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  content: { padding: Spacing.md, paddingBottom: Spacing.xl },
  loadingContainer: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },
  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: 'rgba(239,68,68,0.08)', borderRadius: Radius.md,
    padding: Spacing.sm, marginBottom: Spacing.md, borderWidth: 0.5, borderColor: 'rgba(239,68,68,0.20)',
  },
  errorBannerText: { fontSize: FontSize.xs, color: Colors.red, flex: 1, lineHeight: 16 },

  ratesBanner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.primaryDim, borderRadius: Radius.md,
    borderWidth: 1, borderColor: 'rgba(59,130,246,0.15)',
    padding: Spacing.sm, paddingHorizontal: Spacing.md,
    marginBottom: Spacing.md,
  },
  ratesBannerContent: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, flex: 1 },
  ratesBannerText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.primary, flex: 1 },

  profileHeader: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.xl,
    marginBottom: Spacing.sm,
  },
  avatarCircle: {
    width: 76, height: 76, borderRadius: 38,
    backgroundColor: Colors.primary,
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

  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: Spacing.md },
  username: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  cleanerBadge: {
    backgroundColor: Colors.yellowDim, paddingHorizontal: 8, paddingVertical: 2,
    borderRadius: Radius.pill,
  },
  cleanerBadgeText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.yellow },

  sectionLabel: {
    fontSize: FontSize.xs, color: Colors.textSecondary,
    letterSpacing: 0.8, fontWeight: '600', marginBottom: Spacing.sm,
  },
  metricsRow: { flexDirection: 'row', alignItems: 'flex-start' },
  metric: { flex: 1, alignItems: 'center' },
  metricDivider: { width: StyleSheet.hairlineWidth, height: 50, backgroundColor: Colors.border, marginTop: 4 },
  metricLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, marginBottom: 2 },
  metricValue: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },

  emptyText: { fontSize: FontSize.sm, color: Colors.textDim },

  hostRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingVertical: Spacing.sm,
  },
  hostRowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border },
  hostAvatar: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: Colors.glassDark, borderWidth: 0.5, borderColor: Colors.glassBorder,
    alignItems: 'center', justifyContent: 'center',
  },
  hostAvatarText: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.textSecondary },
  hostName: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  hostSub: { fontSize: FontSize.xs, color: Colors.textDim },

  rateRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingVertical: Spacing.sm,
  },
  ratePropName: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  rateDesc: { fontSize: FontSize.xs, color: Colors.textDim, marginTop: 1 },
  rateAmount: { fontSize: FontSize.md, fontWeight: '700', color: Colors.green },
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
  tagPillText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary },
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

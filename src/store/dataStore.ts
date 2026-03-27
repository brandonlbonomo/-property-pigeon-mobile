import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { apiFetch } from '../services/api';
import { useUserStore } from './userStore';
import { findCatalogItem } from '../constants/inventoryCatalog';

const COCKPIT_CACHE_KEY = 'pp_cockpit_cache';

const CACHE_TTL = 30 * 1000; // 30 seconds — match server cache, never serve stale data

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

function isFresh<T>(entry: CacheEntry<T> | null): boolean {
  return !!entry && Date.now() - entry.fetchedAt < CACHE_TTL;
}

/** Returns true if the current user has activated data sources.
 *  New users who haven't connected anything see empty screens. */
function isDataActive(): boolean {
  return useUserStore.getState().profile?.hasActivatedData ?? false;
}

// In-flight request deduplication: if a fetch is already in progress,
// return the existing promise instead of firing a duplicate API call.
const _inflight: Record<string, Promise<any>> = {};
function dedup<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (_inflight[key]) return _inflight[key];
  _inflight[key] = fn().finally(() => { delete _inflight[key]; });
  return _inflight[key];
}

// Empty defaults reused across methods
const EMPTY_COCKPIT = {
  kpis: { revenue_mtd: 0, expenses_mtd: 0, net_mtd: 0, occupancy_mtd: 0 },
  pct_changes: {}, month: '', prior: { revenue: 0, expenses: 0, net: 0 },
  expenses_by_property: {}, revenue_by_property: {}, raw: null,
};

interface DataState {
  cockpit: CacheEntry<any> | null;
  transactions: CacheEntry<any[]> | null;
  tags: CacheEntry<Record<string, string>> | null;
  categoryTags: CacheEntry<Record<string, string>> | null;
  merchantMemory: CacheEntry<Record<string, string>> | null;
  props: CacheEntry<any[]> | null;
  icalEvents: CacheEntry<any[]> | null;
  invGroups: CacheEntry<any[]> | null;
  analytics: CacheEntry<any> | null;
  customCategories: CacheEntry<any[]> | null;
  lastError: string | null;
  /** Increments on property add/delete/edit — screens watch this to reload */
  dataVersion: number;

  fetchCockpit: (force?: boolean) => Promise<any>;
  fetchTransactions: (force?: boolean) => Promise<any[]>;
  fetchTags: (force?: boolean) => Promise<Record<string, string>>;
  fetchCategoryTags: (force?: boolean) => Promise<Record<string, string>>;
  fetchMerchantMemory: (force?: boolean) => Promise<Record<string, string>>;
  saveCategoryTag: (txId: string, categoryId: string | null) => Promise<void>;
  saveMerchantMemory: (payee: string, propId: string) => Promise<void>;
  fetchProps: (force?: boolean) => Promise<any[]>;
  fetchCalendarEvents: (force?: boolean) => Promise<any[]>;
  fetchInvGroups: (force?: boolean) => Promise<any[]>;
  fetchAnalytics: (force?: boolean) => Promise<any>;
  fetchCustomCategories: (force?: boolean) => Promise<any[]>;
  saveCustomCategory: (label: string, type: 'income' | 'expense') => Promise<void>;
  deleteCustomCategory: (id: string) => Promise<void>;
  fetchTransactionsByMonth: (yearMonth: string, force?: boolean) => Promise<any[]>;
  fetchReceivedInvoices: (force?: boolean) => Promise<any[]>;
  deleteProperty: (propId: string) => Promise<any>;
  clearError: () => void;
  invalidateAll: () => void;
  /** Clears only cockpit + analytics cache. Use after saving income/financial data
   *  to avoid triggering a full reload cascade across all mounted screens. */
  invalidateFinancials: () => void;
}

export const useDataStore = create<DataState>((set, get) => ({
  cockpit: null,
  transactions: null,
  tags: null,
  categoryTags: null,
  merchantMemory: null,
  props: null,
  icalEvents: null,
  invGroups: null,
  analytics: null,
  customCategories: null,
  lastError: null,
  dataVersion: 0,

  // API returns: { current: { total_revenue, total_expenses, net_income, expenses: { by_property } }, pct_changes, prior, month }
  // Normalize to: { kpis: { revenue_mtd, expenses_mtd, net_mtd, ... }, pct_changes, prior, month, raw }
  fetchCockpit: async (force = false) => {
    const cached = get().cockpit;
    // If nothing in memory, try loading from disk (instant display on relaunch)
    if (!cached) {
      try {
        const stored = await SecureStore.getItemAsync(COCKPIT_CACHE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          set({ cockpit: { data: parsed, fetchedAt: 0 } }); // fetchedAt=0 so it refetches
        }
      } catch {}
    }
    if (!force && isFresh(cached)) return cached!.data;
    if (!isDataActive()) {
      set({ cockpit: { data: EMPTY_COCKPIT, fetchedAt: Date.now() } });
      return EMPTY_COCKPIT;
    }
    return dedup('cockpit', async () => {
      try {
        const raw = await apiFetch('/api/cockpit');
        const c = raw?.current ?? {};
        const pct = raw?.pct_changes ?? {};
        const prior = raw?.prior ?? {};
        const data = {
          kpis: {
            revenue_mtd: c.total_revenue ?? 0,
            expenses_mtd: c.total_expenses ?? 0,
            net_mtd: c.net_income ?? 0,
            occupancy_mtd: 0,
          },
          pct_changes: pct,
          month: raw?.month ?? '',
          prior: {
            revenue: prior.total_revenue ?? 0,
            expenses: prior.total_expenses ?? 0,
            net: prior.net_income ?? 0,
          },
          expenses_by_property: c.expenses?.by_property ?? {},
          revenue_by_property: c.revenue?.by_property ?? {},
          raw,
        };
        set({ cockpit: { data, fetchedAt: Date.now() }, lastError: null });
        // Persist for instant relaunch — don't await
        SecureStore.setItemAsync(COCKPIT_CACHE_KEY, JSON.stringify(data)).catch(() => {});
        return data;
      } catch (e: any) {
        set({ cockpit: { data: EMPTY_COCKPIT, fetchedAt: Date.now() }, lastError: 'Could not load financial data. Pull down to retry.' });
        return EMPTY_COCKPIT;
      }
    });
  },

  // 404 — gracefully return empty array
  fetchTransactions: async (force = false) => {
    const cached = get().transactions;
    if (!force && isFresh(cached)) return cached!.data;
    if (!isDataActive()) {
      set({ transactions: { data: [], fetchedAt: Date.now() } });
      return [];
    }
    return dedup('transactions', async () => {
      try {
        const raw = await apiFetch('/api/transactions');
        const data = Array.isArray(raw) ? raw : (raw?.transactions ?? []);
        set({ transactions: { data, fetchedAt: Date.now() } });
        return data;
      } catch {
        // transactions unavailable
        const data: any[] = [];
        set({ transactions: { data, fetchedAt: Date.now() } });
        return data;
      }
    });
  },

  fetchTags: async (force = false) => {
    const cached = get().tags;
    if (!force && isFresh(cached)) return cached!.data;
    if (!isDataActive()) {
      set({ tags: { data: {}, fetchedAt: Date.now() } });
      return {};
    }
    return dedup('tags', async () => {
      try {
        const raw = await apiFetch('/api/tags');
        const data = raw?.tags ?? raw ?? {};
        set({ tags: { data, fetchedAt: Date.now() } });
        return data;
      } catch {
        // tags fetch failed
        set({ tags: { data: {}, fetchedAt: Date.now() } });
        return {};
      }
    });
  },

  fetchCategoryTags: async (force = false) => {
    const cached = get().categoryTags;
    if (!force && isFresh(cached)) return cached!.data;
    if (!isDataActive()) {
      set({ categoryTags: { data: {}, fetchedAt: Date.now() } });
      return {};
    }
    return dedup('categoryTags', async () => {
      try {
        const raw = await apiFetch('/api/category-tags');
        const data = raw?.category_tags ?? {};
        set({ categoryTags: { data, fetchedAt: Date.now() } });
        return data;
      } catch {
        set({ categoryTags: { data: {}, fetchedAt: Date.now() } });
        return {};
      }
    });
  },

  fetchMerchantMemory: async (force = false) => {
    const cached = get().merchantMemory;
    if (!force && isFresh(cached)) return cached!.data;
    if (!isDataActive()) {
      set({ merchantMemory: { data: {}, fetchedAt: Date.now() } });
      return {};
    }
    return dedup('merchantMemory', async () => {
      try {
        const raw = await apiFetch('/api/merchant-memory');
        const data = raw?.merchant_memory ?? {};
        set({ merchantMemory: { data, fetchedAt: Date.now() } });
        return data;
      } catch {
        set({ merchantMemory: { data: {}, fetchedAt: Date.now() } });
        return {};
      }
    });
  },

  saveCategoryTag: async (txId: string, categoryId: string | null) => {
    try {
      await apiFetch('/api/category-tags', {
        method: 'POST',
        body: JSON.stringify({ id: txId, category: categoryId }),
      });
      // Update local cache + invalidate cockpit so Money tab reflects the change
      const cached = get().categoryTags?.data ?? {};
      const updated = { ...cached };
      if (categoryId) {
        updated[txId] = categoryId;
      } else {
        delete updated[txId];
      }
      set({ categoryTags: { data: updated, fetchedAt: Date.now() }, cockpit: null, transactions: null });
    } catch {}
  },

  saveMerchantMemory: async (payee: string, propId: string) => {
    try {
      await apiFetch('/api/merchant-memory', {
        method: 'POST',
        body: JSON.stringify({ payee, property_id: propId }),
      });
      const cached = get().merchantMemory?.data ?? {};
      set({ merchantMemory: { data: { ...cached, [payee.toLowerCase().trim()]: propId }, fetchedAt: Date.now() } });
    } catch {}
  },

  // Properties: merge API props with local userStore properties
  fetchProps: async (force = false) => {
    const cached = get().props;
    if (!force && isFresh(cached)) return cached!.data;

    const localProps = (useUserStore.getState().profile?.properties || []).map(p => ({
      id: p.id || p.name,
      prop_id: p.id || p.name,
      label: p.label || p.name,
      name: p.name,
      isAirbnb: p.isAirbnb,
      units: p.units,
    }));

    if (!isDataActive()) {
      set({ props: { data: localProps, fetchedAt: Date.now() } });
      return localProps;
    }
    return dedup('props', async () => {
      try {
        const raw = await apiFetch('/api/props');
        const apiData = Array.isArray(raw) ? raw : (raw?.props ?? []);

        // If local properties list is empty, trust the backend entirely
        // (user may have just signed in on a new device)
        if (localProps.length === 0) {
          const result = apiData.map((p: any) => ({
            id: p.id || p.prop_id,
            prop_id: p.id || p.prop_id,
            label: p.label || p.name,
            name: p.name,
            address: p.address || '',
            isAirbnb: p.isAirbnb ?? true,
            units: p.units,
            market: p.market,
            lat: p.lat,
            lng: p.lng,
            unitLabels: p.unitLabels,
            purchasePrice: p.purchasePrice,
            purchaseDate: p.purchaseDate,
            downPaymentPct: p.downPaymentPct,
            icalUrls: p.icalUrls,
          }));
          // Sync backend properties into the local profile
          if (result.length > 0) {
            useUserStore.getState().setProfile({ properties: result });
          }
          set({ props: { data: result, fetchedAt: Date.now() } });
          return result;
        }

        // Local props exist — merge with backend, preserving local fields
        // (backend may not return address, lat/lng, etc.)
        const localById = new Map(localProps.map(p => [p.id, p]));
        const apiIds = new Set(apiData.map((p: any) => p.id || p.prop_id));
        const merged = apiData.map((p: any) => {
          const apiId = p.id || p.prop_id;
          const local = localById.get(apiId);
          // Merge: local data is the base, API data overrides only defined fields
          return { ...local, id: apiId, prop_id: apiId, name: p.name || local?.name, isAirbnb: p.isAirbnb ?? local?.isAirbnb ?? true, units: p.units ?? local?.units };
        });
        // Add any local-only props not on the server
        const localOnly = localProps.filter(p => p.id && !apiIds.has(p.id));
        const result = [...merged, ...localOnly];
        set({ props: { data: result, fetchedAt: Date.now() } });
        return result;
      } catch {
        // props fetch failed — fall back to local
        set({ props: { data: localProps, fetchedAt: Date.now() } });
        return localProps;
      }
    });
  },

  // Fetch calendar events from Airbnb iCal feeds
  // First sync is awaited so data appears immediately; subsequent syncs are background
  fetchCalendarEvents: async (force = false) => {
    // No properties = no calendar data. Period. Check BEFORE cache.
    const props = useUserStore.getState().profile?.properties || [];
    if (props.length === 0) {
      set({ icalEvents: { data: [], fetchedAt: Date.now() } });
      return [];
    }
    // No iCal URLs on any property = no calendar data.
    const hasIcalUrls = props.some(p => p.icalUrls?.some(u => u));
    if (!hasIcalUrls) {
      set({ icalEvents: { data: [], fetchedAt: Date.now() } });
      return [];
    }

    const cached = get().icalEvents;
    if (!force && isFresh(cached)) return cached!.data;
    if (!isDataActive()) {
      set({ icalEvents: { data: [], fetchedAt: Date.now() } });
      return [];
    }

    return dedup('icalEvents', async () => {
      try {
        // Await sync when we have no cached events (first load / after invalidation).
        // Background sync on subsequent refreshes so UI stays fast.
        const hasCachedEvents = (get().icalEvents?.data?.length ?? 0) > 0;
        if (hasCachedEvents && !force) {
          apiFetch('/api/ical/sync', { method: 'POST' }).catch(() => {});
        } else {
          try { await apiFetch('/api/ical/sync', { method: 'POST' }); } catch {}
        }
        const raw = await apiFetch('/api/calendar/events');
        const events = Array.isArray(raw) ? raw : (raw?.events ?? []);

        // Only include events for properties the user actually has
        const propIds = new Set(props.map(p => p.id || p.name));
        const data = events
          .filter((e: any) => propIds.has(e.prop_id))
          .map((e: any) => ({
            check_in: (e.check_in ?? '').slice(0, 10),
            check_out: (e.check_out ?? '').slice(0, 10),
            prop_id: e.prop_id ?? '',
            feed_key: e.feed_key ?? e.prop_id ?? '',
            summary: e.summary ?? '',
            nights: e.nights ?? 0,
            booking_source: e.booking_source ?? '',
            guest_name: e.guest_name ?? null,
            listing_name: e.listing_name ?? '',
            event_type: e.event_type ?? '',
          }));

        set({ icalEvents: { data, fetchedAt: Date.now() }, lastError: null });
        return data;
      } catch (err: any) {
        const msg = err?.message || 'Could not load calendar events. Pull down to retry.';
        set({ icalEvents: { data: [], fetchedAt: Date.now() }, lastError: msg });
        return [];
      }
    });
  },

  // API returns: { groups: [{ id, name, linkType?, propertyId?, city?, items: [...] }] }
  // Normalize items with depletion engine: base_qty, effective_qty
  fetchInvGroups: async (force = false) => {
    const cached = get().invGroups;
    if (!force && isFresh(cached)) return cached!.data;
    return dedup('invGroups', async () => {
      try {
        // Fetch inventory + calendar events in parallel for depletion calc
        const [raw, icalEvents] = await Promise.all([
          apiFetch('/api/inv-groups'),
          get().fetchCalendarEvents().catch(() => [] as any[]),
        ]);
        const properties = useUserStore.getState().profile?.properties || [];
        const today = new Date();
        today.setHours(23, 59, 59, 999);

        const groups = Array.isArray(raw) ? raw : (raw?.groups ?? []);
        const data = groups.map((g: any) => {
          // Resolve which property IDs this group covers
          const groupPropIdsList: string[] = [];
          if (g.linkType === 'property' && g.propertyId) {
            groupPropIdsList.push(g.propertyId);
          } else if (g.linkType === 'city' && g.city) {
            const cityLower = g.city.toLowerCase();
            properties.forEach((p: any) => {
              if (p.isAirbnb && p.market?.toLowerCase() === cityLower) {
                groupPropIdsList.push(p.id);
              }
            });
          }
          const groupPropIds = new Set(groupPropIdsList);

          return {
            id: g.id,
            name: g.name ?? g.city ?? 'Group',
            linkType: g.linkType ?? null,
            propertyId: g.propertyId ?? null,
            city: g.city ?? null,
            items: (g.items ?? []).map((item: any) => {
              // Base qty = initialQty + restocks (no depletion)
              const restocks = item.restocks ?? [];
              const restockTotal = restocks.reduce(
                (sum: number, r: any) => sum + (r.units ?? r.qty ?? r.quantity ?? 0), 0
              );
              const initialQty = item.initialQty ?? item.current_qty ?? 0;
              const baseQty = initialQty + restockTotal;

              // Determine effective perStay rate
              let perStay = item.perStay ?? 0;
              if (!perStay) {
                const cat = findCatalogItem(item.catalogName || item.name);
                if (cat) {
                  perStay = item.isCleanerOnly
                    ? (cat.cleanerPerStay ?? cat.defaultPerStay)
                    : cat.defaultPerStay;
                }
              }

              // Compute depletion from iCal checkouts
              let effectiveQty = baseQty;
              if (perStay > 0 && groupPropIds.size > 0) {
                // Baseline = later of (createdAt, last restock date)
                const createdAt = item.createdAt ? new Date(item.createdAt) : null;
                const lastRestock = restocks.reduce((latest: Date | null, r: any) => {
                  const d = r.date || r.ts;
                  if (!d) return latest;
                  const rd = new Date(typeof d === 'number' ? d * 1000 : d);
                  return (!latest || rd > latest) ? rd : latest;
                }, null as Date | null);
                const baseline = [createdAt, lastRestock].filter(Boolean)
                  .reduce((a: Date | null, b: any) => (a && b && a > b ? a : b), null);

                if (baseline) {
                  const checkouts = icalEvents.filter((e: any) => {
                    if (!groupPropIds.has(e.prop_id)) return false;
                    const co = new Date(e.check_out);
                    return co >= baseline && co <= today;
                  }).length;
                  effectiveQty = Math.max(0, baseQty - perStay * checkouts);
                }
              }

              return {
                id: item.id,
                name: item.name ?? item.label ?? 'Item',
                base_qty: baseQty,
                effective_qty: effectiveQty,
                current_qty: effectiveQty, // alias for backward compat
                reorder_threshold: item.threshold ?? item.reorder_threshold ?? 0,
                capacity: item.capacity ?? item.max_qty ?? 0,
                unit: item.unit ?? '',
                perStay,
                reorder_url: item.reorder_url ?? null,
                category: item.category ?? null,
                catalogName: item.catalogName ?? null,
                isCleanerOnly: item.isCleanerOnly ?? false,
                isStatic: findCatalogItem(item.catalogName || item.name)?.isStatic ?? false,
                createdAt: item.createdAt ?? null,
              };
            }),
          };
        });
        set({ invGroups: { data, fetchedAt: Date.now() } });
        return data;
      } catch {
        // inv-groups fetch failed
        set({ invGroups: { data: [], fetchedAt: Date.now() }, lastError: 'Could not load inventory. Pull down to retry.' });
        return [];
      }
    });
  },

  fetchAnalytics: async (force = false) => {
    const cached = get().analytics;
    if (!force && isFresh(cached)) return cached!.data;
    if (!isDataActive()) {
      set({ analytics: { data: null, fetchedAt: Date.now() } });
      return null;
    }
    return dedup('analytics', async () => {
      try {
        const data = await apiFetch('/api/analytics/portfolio');
        set({ analytics: { data, fetchedAt: Date.now() } });
        return data;
      } catch {
        // analytics fetch failed
        return null;
      }
    });
  },

  fetchCustomCategories: async (force = false) => {
    const cached = get().customCategories;
    if (!force && isFresh(cached)) return cached!.data;
    return dedup('customCategories', async () => {
      try {
        const raw = await apiFetch('/api/custom-categories');
        const data = raw?.categories ?? [];
        set({ customCategories: { data, fetchedAt: Date.now() } });
        return data;
      } catch {
        set({ customCategories: { data: [], fetchedAt: Date.now() } });
        return [];
      }
    });
  },

  saveCustomCategory: async (label: string, type: 'income' | 'expense') => {
    try {
      await apiFetch('/api/custom-categories', {
        method: 'POST',
        body: JSON.stringify({ label, type }),
      });
      // Refresh cache
      const raw = await apiFetch('/api/custom-categories');
      const data = raw?.categories ?? [];
      set({ customCategories: { data, fetchedAt: Date.now() } });
    } catch {}
  },

  deleteCustomCategory: async (id: string) => {
    try {
      await apiFetch('/api/custom-categories', {
        method: 'DELETE',
        body: JSON.stringify({ id }),
      });
      const cached = get().customCategories?.data ?? [];
      set({ customCategories: { data: cached.filter((c: any) => c.id !== id), fetchedAt: Date.now() } });
    } catch {}
  },

  fetchTransactionsByMonth: async (yearMonth: string, force = false) => {
    const all = await get().fetchTransactions(force);
    // Handle quarterly format: "2026-Q1" → months 01-03
    if (yearMonth.includes('-Q')) {
      const [yr, q] = yearMonth.split('-Q');
      const qNum = parseInt(q, 10);
      const startMonth = (qNum - 1) * 3 + 1;
      const months = [startMonth, startMonth + 1, startMonth + 2]
        .map(m => `${yr}-${String(m).padStart(2, '0')}`);
      return all.filter((t: any) => {
        const d = t.date || '';
        return months.some(prefix => d.startsWith(prefix));
      });
    }
    // Handle year-only format: "2026" → all months in that year
    // Handle monthly format: "2026-03" → exact month prefix
    return all.filter((t: any) => (t.date || '').startsWith(yearMonth));
  },

  fetchReceivedInvoices: async (force = false) => {
    try {
      const res = await apiFetch('/api/host/invoices');
      return res.invoices || [];
    } catch {
      return [];
    }
  },

  deleteProperty: async (propId: string) => {
    const res = await apiFetch(`/api/props/${encodeURIComponent(propId)}`, { method: 'DELETE' });
    // Cascade: clear all caches since property deletion affects everything
    set(s => ({
      cockpit: null, transactions: null, tags: null, categoryTags: null, merchantMemory: null,
      props: null, icalEvents: null,
      invGroups: null, analytics: null, lastError: null, dataVersion: s.dataVersion + 1,
    }));
    return res;
  },

  clearError: () => set({ lastError: null }),

  invalidateAll: () => set(s => ({
    cockpit: null, transactions: null, tags: null, categoryTags: null, merchantMemory: null,
    props: null, icalEvents: null,
    invGroups: null, analytics: null, customCategories: null, lastError: null,
    dataVersion: s.dataVersion + 1,
  })),

  invalidateFinancials: () => set({ cockpit: null, analytics: null }),
}));

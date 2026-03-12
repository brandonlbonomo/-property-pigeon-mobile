import { create } from 'zustand';
import { apiFetch } from '../services/api';

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

function isFresh<T>(entry: CacheEntry<T> | null): boolean {
  return !!entry && Date.now() - entry.fetchedAt < CACHE_TTL;
}

interface DataState {
  cockpit: CacheEntry<any> | null;
  transactions: CacheEntry<any[]> | null;
  tags: CacheEntry<Record<string, string>> | null;
  props: CacheEntry<any[]> | null;
  icalEvents: CacheEntry<any[]> | null;
  plBookings: CacheEntry<any[]> | null;
  invGroups: CacheEntry<any[]> | null;
  analytics: CacheEntry<any> | null;

  fetchCockpit: (force?: boolean) => Promise<any>;
  fetchTransactions: (force?: boolean) => Promise<any[]>;
  fetchTags: (force?: boolean) => Promise<Record<string, string>>;
  fetchProps: (force?: boolean) => Promise<any[]>;
  fetchIcalEvents: (force?: boolean) => Promise<any[]>;
  fetchPlBookings: (force?: boolean) => Promise<any[]>;
  fetchInvGroups: (force?: boolean) => Promise<any[]>;
  fetchAnalytics: (force?: boolean) => Promise<any>;
  invalidateAll: () => void;
}

export const useDataStore = create<DataState>((set, get) => ({
  cockpit: null,
  transactions: null,
  tags: null,
  props: null,
  icalEvents: null,
  plBookings: null,
  invGroups: null,
  analytics: null,

  fetchCockpit: async (force = false) => {
    const cached = get().cockpit;
    if (!force && isFresh(cached)) return cached!.data;
    const data = await apiFetch('/api/cockpit');
    set({ cockpit: { data, fetchedAt: Date.now() } });
    return data;
  },

  fetchTransactions: async (force = false) => {
    const cached = get().transactions;
    if (!force && isFresh(cached)) return cached!.data;
    const data = await apiFetch('/api/transactions');
    set({ transactions: { data, fetchedAt: Date.now() } });
    return data;
  },

  fetchTags: async (force = false) => {
    const cached = get().tags;
    if (!force && isFresh(cached)) return cached!.data;
    const data = await apiFetch('/api/tags');
    set({ tags: { data, fetchedAt: Date.now() } });
    return data;
  },

  fetchProps: async (force = false) => {
    const cached = get().props;
    if (!force && isFresh(cached)) return cached!.data;
    const data = await apiFetch('/api/props');
    set({ props: { data, fetchedAt: Date.now() } });
    return data;
  },

  fetchIcalEvents: async (force = false) => {
    const cached = get().icalEvents;
    if (!force && isFresh(cached)) return cached!.data;
    const data = await apiFetch('/api/ical/events');
    set({ icalEvents: { data, fetchedAt: Date.now() } });
    return data;
  },

  fetchPlBookings: async (force = false) => {
    const cached = get().plBookings;
    if (!force && isFresh(cached)) return cached!.data;
    const data = await apiFetch('/api/pl-bookings');
    set({ plBookings: { data, fetchedAt: Date.now() } });
    return data;
  },

  fetchInvGroups: async (force = false) => {
    const cached = get().invGroups;
    if (!force && isFresh(cached)) return cached!.data;
    const data = await apiFetch('/api/inv-groups');
    set({ invGroups: { data, fetchedAt: Date.now() } });
    return data;
  },

  fetchAnalytics: async (force = false) => {
    const cached = get().analytics;
    if (!force && isFresh(cached)) return cached!.data;
    const data = await apiFetch('/api/analytics/portfolio');
    set({ analytics: { data, fetchedAt: Date.now() } });
    return data;
  },

  invalidateAll: () => set({
    cockpit: null, transactions: null, tags: null,
    props: null, icalEvents: null, plBookings: null,
    invGroups: null, analytics: null,
  }),
}));

import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { apiFetch } from '../services/api';
import { useUserStore } from './userStore';

const SEEN_UIDS_KEY = 'pp_cleaner_seen_uids';

export interface CleanerEvent {
  check_in: string;
  check_out: string;
  prop_id: string;
  prop_name: string;
  owner: string;
  owner_id: string;
  uid: string;
  feed_key: string;
  unit_name: string;
  guest_name: string;
}

export interface FollowedOwner {
  id: string;
  user_id: string;
  username: string;
  role: string;
  type: string;
  property_count: number;
  selected_properties: string[];
  portfolio_score?: number | null;
}

export interface InvoiceLineItem {
  date: string;
  propertyName: string;
  cleaningType: string;
  rate: number;
  amount: number;
  quantity?: number;
  uid?: string;
  unit_name?: string;
  feed_key?: string;
  description?: string;
}

export interface PropertyUnit {
  feed_key: string;
  unit_name: string;
}

export interface OwnerProperty {
  prop_id: string;
  prop_label: string;
  units: PropertyUnit[];
}

export type InvoiceStatus = 'draft' | 'sent' | 'viewed' | 'paid' | 'overdue';
export type DisputeStatus = 'none' | 'disputed' | 'resolved';
export type PaymentMethod = 'card' | 'ach' | 'offline' | null;
export type InvoiceFrequency = 'every' | 'every_2' | 'every_4' | 'monthly';

export interface InvoicePreferences {
  autoGenerate: boolean;
  frequency: InvoiceFrequency;
  dueDateDays: number; // net N days
  businessName: string;
  businessEmail: string;
  businessPhone: string;
  taxRate: number; // percentage, 0 = no tax
  venmoHandle: string;
  paypalHandle: string;
  zelleHandle: string;
}

export const DEFAULT_INVOICE_PREFS: InvoicePreferences = {
  autoGenerate: false,
  frequency: 'every',
  dueDateDays: 7,
  businessName: '',
  businessEmail: '',
  businessPhone: '',
  venmoHandle: '',
  paypalHandle: '',
  zelleHandle: '',
  taxRate: 0,
};

export interface CleanerInvoice {
  id: string;
  hostId: string;
  hostName: string;
  hostEmail?: string;
  period: string;
  lineItems: InvoiceLineItem[];
  subtotal: number;
  taxRate?: number;
  taxAmount?: number;
  total: number;
  status: InvoiceStatus;
  createdAt: string;
  event_uids: string[];
  invoiceNumber?: string; // INV-0001
  invoiceDate?: string;
  dueDate?: string;
  notes?: string;
  paymentMethod?: PaymentMethod;
  viewedAt?: string;
  paidAt?: string;
  disputeStatus?: DisputeStatus;
  disputeNotes?: { from: 'host' | 'cleaner'; text: string; date: string }[];
  cleanerBusinessName?: string;
  cleanerEmail?: string;
  cleanerPhone?: string;
}

const INVOICE_PREFS_KEY = 'pp_invoice_prefs';

interface CleanerState {
  schedule: CleanerEvent[];
  history: CleanerEvent[];
  owners: FollowedOwner[];
  invoices: CleanerInvoice[];
  invoicedUids: Set<string>;
  loading: boolean;
  newBookingUids: Set<string>;
  seenUidsLoaded: boolean;
  invoicePrefs: InvoicePreferences;

  fetchSchedule: (force?: boolean) => Promise<void>;
  fetchHistory: (force?: boolean) => Promise<void>;
  fetchOwners: () => Promise<void>;
  followOwner: (codeOrUsername: string) => Promise<{ ok: boolean; error?: string }>;
  selectProperties: (followId: string, propertyIds: string[]) => Promise<void>;
  unfollowOwner: (followId: string) => Promise<void>;
  fetchInvoices: () => Promise<void>;
  createInvoice: (invoice: Omit<CleanerInvoice, 'id' | 'createdAt'>) => Promise<CleanerInvoice | null>;
  updateInvoice: (id: string, updates: Partial<CleanerInvoice>) => void;
  deleteInvoice: (id: string) => Promise<void>;
  sendInvoice: (invoiceId: string) => Promise<void>;
  fetchInvoicedUids: () => Promise<void>;
  fetchOwnerUnits: (ownerId: string) => Promise<OwnerProperty[]>;
  dismissNewBookings: () => void;
  loadInvoicePrefs: () => Promise<void>;
  saveInvoicePrefs: (prefs: Partial<InvoicePreferences>) => Promise<void>;
  disputeInvoice: (invoiceId: string, notes: string) => Promise<void>;
  resolveDispute: (invoiceId: string) => Promise<void>;
  resendInvoice: (invoiceId: string) => Promise<void>;
}

export const useCleanerStore = create<CleanerState>((set, get) => ({
  schedule: [],
  history: [],
  owners: [],
  invoices: [],
  invoicedUids: new Set<string>(),
  loading: false,
  newBookingUids: new Set<string>(),
  seenUidsLoaded: false,
  invoicePrefs: { ...DEFAULT_INVOICE_PREFS },

  fetchSchedule: async (force) => {
    set({ loading: true });
    try {
      const res = await apiFetch('/api/cleaner/my-schedule');
      const events: CleanerEvent[] = res.events || [];
      const allUids = new Set(events.map(e => e.uid));

      // Load persisted seen UIDs on first fetch
      let { seenUidsLoaded, newBookingUids } = get();
      let seenUids = new Set<string>();
      if (!seenUidsLoaded) {
        try {
          const stored = await SecureStore.getItemAsync(SEEN_UIDS_KEY);
          if (stored) seenUids = new Set<string>(JSON.parse(stored));
        } catch { /* ignore */ }
      }

      // Detect new bookings: UIDs not in persisted seen set
      // First-ever fetch (no stored data) → seed all as seen, no new bookings
      const newUids = new Set<string>();
      if (seenUids.size > 0) {
        events.forEach(e => { if (!seenUids.has(e.uid)) newUids.add(e.uid); });
      }
      // Merge with any undismissed new bookings from prior fetches this session
      if (seenUidsLoaded) {
        newBookingUids.forEach(uid => { if (allUids.has(uid)) newUids.add(uid); });
      }

      // Persist all UIDs (cap at 500 to prevent unbounded growth)
      const merged = [...new Set([...seenUids, ...allUids])];
      const trimmed = merged.length > 500 ? merged.slice(merged.length - 500) : merged;
      try { await SecureStore.setItemAsync(SEEN_UIDS_KEY, JSON.stringify(trimmed)); } catch { /* ignore */ }

      set({ schedule: events, loading: false, newBookingUids: newUids, seenUidsLoaded: true });
    } catch {
      set({ loading: false });
    }
  },

  fetchHistory: async (force) => {
    try {
      const res = await apiFetch('/api/cleaner/my-schedule?all=true');
      set({ history: res.events || [] });
    } catch {
      // If endpoint doesn't support ?all=true, fall back to schedule
      const current = get().schedule;
      if (current.length > 0) set({ history: current });
    }
  },

  fetchOwners: async () => {
    try {
      const res = await apiFetch('/api/follow/following');
      set({ owners: res.following || [] });
    } catch {
      // ignore
    }
  },

  followOwner: async (codeOrUsername) => {
    // Free tier: max 1 host
    const profile = useUserStore.getState().profile;
    const isPro = profile?.isSubscriptionActive || profile?.isFounder || profile?.lifetimeFree;
    if (!isPro && get().owners.length >= 1) {
      return { ok: false, error: 'Free tier allows following 1 host. Upgrade to Cleaner Pro for unlimited hosts.' };
    }
    try {
      const isCode = codeOrUsername.toUpperCase().startsWith('PPG-');
      const body = isCode
        ? { follow_code: codeOrUsername }
        : { username: codeOrUsername };
      await apiFetch('/api/follow/request', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.serverError || err.message || 'Failed to follow' };
    }
  },

  selectProperties: async (followId, propertyIds) => {
    try {
      await apiFetch('/api/follow/properties', {
        method: 'POST',
        body: JSON.stringify({ follow_id: followId, property_ids: propertyIds }),
      });
      set(s => ({
        owners: s.owners.map(o =>
          o.id === followId ? { ...o, selected_properties: propertyIds } : o
        ),
      }));
    } catch {
      // ignore
    }
  },

  unfollowOwner: async (followId) => {
    try {
      await apiFetch('/api/follow/remove', {
        method: 'DELETE',
        body: JSON.stringify({ follow_id: followId }),
      });
      set(s => ({ owners: s.owners.filter(o => o.id !== followId) }));
    } catch {
      // ignore
    }
  },

  fetchInvoices: async () => {
    try {
      const res = await apiFetch('/api/cleaner/invoices');
      set({ invoices: res.invoices || [] });
    } catch {
      // ignore
    }
  },

  createInvoice: async (invoice) => {
    try {
      const res = await apiFetch('/api/cleaner/invoices', {
        method: 'POST',
        body: JSON.stringify(invoice),
      });
      const created = res.invoice;
      if (created) {
        set(s => ({ invoices: [created, ...s.invoices] }));
        return created;
      }
      return null;
    } catch {
      return null;
    }
  },

  updateInvoice: (id, updates) => {
    const prev = get().invoices;
    set(s => ({
      invoices: s.invoices.map(inv =>
        inv.id === id ? { ...inv, ...updates } : inv
      ),
    }));
    const payload: any = { invoice_id: id, ...updates };
    // Map lineItems to line_items for API compatibility
    if (updates.lineItems) {
      payload.line_items = updates.lineItems;
      delete payload.lineItems;
    }
    apiFetch('/api/cleaner/invoices/update', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }).catch(() => {
      set({ invoices: prev });
    });
  },

  deleteInvoice: async (id) => {
    const prev = get().invoices;
    set(s => ({ invoices: s.invoices.filter(inv => inv.id !== id) }));
    try {
      await apiFetch('/api/cleaner/invoices/delete', {
        method: 'DELETE',
        body: JSON.stringify({ invoice_id: id }),
      });
    } catch {
      set({ invoices: prev });
    }
  },

  sendInvoice: async (invoiceId) => {
    try {
      await apiFetch('/api/cleaner/invoices/send', {
        method: 'POST',
        body: JSON.stringify({ invoice_id: invoiceId }),
      });
      set(s => ({
        invoices: s.invoices.map(inv =>
          inv.id === invoiceId ? { ...inv, status: 'sent' as const } : inv
        ),
      }));
    } catch {
      // ignore
    }
  },

  fetchInvoicedUids: async () => {
    try {
      const res = await apiFetch('/api/cleaner/invoiced-uids');
      set({ invoicedUids: new Set<string>(res.uids || []) });
    } catch {
      // ignore
    }
  },

  fetchOwnerUnits: async (ownerId: string) => {
    try {
      const res = await apiFetch(`/api/cleaner/owner-units/${ownerId}`);
      return res.properties || [];
    } catch {
      return [];
    }
  },

  dismissNewBookings: () => {
    set({ newBookingUids: new Set<string>() });
  },

  loadInvoicePrefs: async () => {
    try {
      const raw = await SecureStore.getItemAsync(INVOICE_PREFS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        set({ invoicePrefs: { ...DEFAULT_INVOICE_PREFS, ...parsed } });
      }
    } catch { /* ignore */ }
  },

  saveInvoicePrefs: async (prefs) => {
    const current = get().invoicePrefs;
    const merged = { ...current, ...prefs };
    set({ invoicePrefs: merged });
    try {
      await SecureStore.setItemAsync(INVOICE_PREFS_KEY, JSON.stringify(merged));
      await apiFetch('/api/cleaner/invoice-prefs', {
        method: 'PUT',
        body: JSON.stringify(merged),
      });
    } catch { /* ignore */ }
  },

  disputeInvoice: async (invoiceId, notes) => {
    const prev = get().invoices;
    set(s => ({
      invoices: s.invoices.map(inv =>
        inv.id === invoiceId ? { ...inv, disputeStatus: 'disputed' as const } : inv
      ),
    }));
    try {
      await apiFetch('/api/cleaner/invoices/dispute', {
        method: 'POST',
        body: JSON.stringify({ invoice_id: invoiceId, notes }),
      });
    } catch {
      set({ invoices: prev });
    }
  },

  resolveDispute: async (invoiceId) => {
    const prev = get().invoices;
    set(s => ({
      invoices: s.invoices.map(inv =>
        inv.id === invoiceId ? { ...inv, disputeStatus: 'resolved' as const } : inv
      ),
    }));
    try {
      await apiFetch('/api/cleaner/invoices/resolve-dispute', {
        method: 'POST',
        body: JSON.stringify({ invoice_id: invoiceId }),
      });
    } catch {
      set({ invoices: prev });
    }
  },

  resendInvoice: async (invoiceId) => {
    try {
      await apiFetch('/api/cleaner/invoices/resend', {
        method: 'POST',
        body: JSON.stringify({ invoice_id: invoiceId }),
      });
    } catch { /* ignore */ }
  },
}));

import { create } from 'zustand';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { setToken, apiFetch } from '../services/api';
import { checkProEntitlement, logoutUser as rcLogout } from '../services/revenueCat';

const PROFILE_KEY = 'pp_user_profile';

export interface UserProperty {
  id?: string;
  label?: string;
  name: string;
  address: string;
  units: number;
  isAirbnb: boolean;
  market?: string;
  lat?: number;
  lng?: number;
  photos?: string[];
  /** Custom unit labels e.g. ["22 B", "24 B", "26 B"] */
  unitLabels?: string[];
  /** Per-unit photos keyed by unit label e.g. "22 B" */
  unitPhotos?: Record<string, string[]>;
  /** Valuation fields */
  purchasePrice?: number;
  purchaseDate?: string; // YYYY-MM-DD
  valuationOptOut?: boolean;
  /** Down payment percentage (0-100) for cash-on-cash return calculation */
  downPaymentPct?: number;
  /** Per-unit Airbnb iCal feed URLs. icalUrls[0] = unit 0's feed. */
  icalUrls?: string[];
}

/** Generate a stable ID for a property from its name */
export function generatePropertyId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36);
}

export interface UserProfile {
  username?: string;
  email: string;
  portfolioType: 'str' | 'ltr' | 'both';
  properties: UserProperty[];
  plaidConnected?: boolean;
  unitCount?: number;
  projectionStyle?: 'conservative' | 'normal' | 'bullish';
  hasActivatedData?: boolean;
  totalInvestment?: number;
  unitsPerYear?: number;
  accountType?: 'owner' | 'cleaner';
  cleanerTier?: 'free' | 'pro';
  hostsPerYear?: number;
  market?: string;
  pillOrder?: string[];
  profileCards?: Record<string, boolean>;
  profileCardOrder?: string[];
  followCode?: string;
  // Billing
  subscriptionStatus?: string;
  subscriptionPlan?: string;
  currentPeriodEnd?: number;
  isFounder?: boolean;
  lifetimeFree?: boolean;
  isSubscriptionActive?: boolean;
}

interface UserState {
  profile: UserProfile | null;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setProfile: (partial: Partial<UserProfile>) => Promise<void>;
  activateData: () => Promise<void>;
  fetchBillingStatus: () => Promise<void>;
  fetchFollowCode: () => Promise<string | null>;
  clearAll: () => Promise<void>;
}

export const useUserStore = create<UserState>((set, get) => ({
  profile: null,
  hydrated: false,

  hydrate: async () => {
    try {
      const raw = await SecureStore.getItemAsync(PROFILE_KEY);
      if (raw) {
        const profile = JSON.parse(raw);
        set({ profile });
      }
      // Restore token from SecureStore so API calls are authenticated
      const storedToken = await SecureStore.getItemAsync('pp_token');
      if (storedToken) {
        setToken(storedToken);
      }
    } catch {
      // ignore
    }
    set({ hydrated: true });
  },

  setProfile: async (partial) => {
    const current = get().profile;
    const updated = { ...current, ...partial } as UserProfile;
    await SecureStore.setItemAsync(PROFILE_KEY, JSON.stringify(updated));
    set({ profile: updated });
  },

  activateData: async () => {
    const current = get().profile;
    if (current && !current.hasActivatedData) {
      const updated = { ...current, hasActivatedData: true };
      await SecureStore.setItemAsync(PROFILE_KEY, JSON.stringify(updated));
      set({ profile: updated });
    }
  },

  fetchBillingStatus: async () => {
    const current = get().profile;
    if (!current) return;

    if (Platform.OS === 'ios') {
      // iOS: RevenueCat is primary, server-side is fallback
      let rcActive = false;
      try {
        rcActive = await checkProEntitlement();
      } catch {}

      // Also fetch server-side flags (founder, lifetimeFree, is_active)
      try {
        const res = await apiFetch('/api/billing/status');
        const updated = {
          ...current,
          isFounder: res.is_founder,
          lifetimeFree: res.lifetime_free,
          isSubscriptionActive: rcActive || res.is_active || res.is_founder || res.lifetime_free,
        };
        await SecureStore.setItemAsync(PROFILE_KEY, JSON.stringify(updated));
        set({ profile: updated });
      } catch {
        // If API fails, preserve current subscription state (don't reset to false)
        if (rcActive !== current.isSubscriptionActive) {
          const updated = {
            ...current,
            isSubscriptionActive: rcActive || current.isSubscriptionActive || current.isFounder || current.lifetimeFree,
          };
          await SecureStore.setItemAsync(PROFILE_KEY, JSON.stringify(updated));
          set({ profile: updated });
        }
      }
    } else {
      // Non-iOS: Stripe is the source of truth
      try {
        const res = await apiFetch('/api/billing/status');
        const updated = {
          ...current,
          subscriptionStatus: res.subscription_status,
          subscriptionPlan: res.subscription_plan,
          currentPeriodEnd: res.subscription_current_period_end,
          isFounder: res.is_founder,
          lifetimeFree: res.lifetime_free,
          isSubscriptionActive: res.is_active,
        };
        await SecureStore.setItemAsync(PROFILE_KEY, JSON.stringify(updated));
        set({ profile: updated });
      } catch {}
    }
  },

  fetchFollowCode: async () => {
    try {
      const res = await apiFetch('/api/follow/code');
      const code = res.follow_code || null;
      if (code) {
        const current = get().profile;
        if (current) {
          const updated = { ...current, followCode: code };
          await SecureStore.setItemAsync(PROFILE_KEY, JSON.stringify(updated));
          set({ profile: updated });
        }
      }
      return code;
    } catch {
      return null;
    }
  },

  clearAll: async () => {
    await SecureStore.deleteItemAsync(PROFILE_KEY);
    setToken(null);
    await rcLogout();
    set({ profile: null });
  },
}));

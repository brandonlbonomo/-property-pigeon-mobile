import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';

const ONBOARDING_KEY = 'pp_onboarding_complete';
const PORTFOLIO_TYPE_KEY = 'pp_portfolio_type';
const BIOMETRIC_KEY = 'pp_biometric';

export type PortfolioType = 'str' | 'ltr' | 'both' | null;

export interface PendingCredentials {
  username: string;
  email: string;
  password: string;
  role: 'owner' | 'cleaner';
}

interface OnboardingState {
  hasCompleted: boolean;
  isLoading: boolean;
  portfolioType: PortfolioType;
  biometricEnabled: boolean;
  pendingCredentials: PendingCredentials | null;
  pendingFollows: string[]; // usernames to follow after registration

  hydrate: () => Promise<void>;
  complete: (portfolioType?: PortfolioType) => Promise<void>;
  setPortfolioType: (type: PortfolioType) => Promise<void>;
  setBiometric: (enabled: boolean) => Promise<void>;
  setPendingCredentials: (creds: PendingCredentials) => void;
  addPendingFollow: (username: string) => void;
  clearPendingFollows: () => void;
  reset: () => Promise<void>;
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  hasCompleted: false,
  isLoading: true,
  portfolioType: null,
  biometricEnabled: false,
  pendingCredentials: null,
  pendingFollows: [],

  hydrate: async () => {
    try {
      const [val, pt, bio] = await Promise.all([
        SecureStore.getItemAsync(ONBOARDING_KEY),
        SecureStore.getItemAsync(PORTFOLIO_TYPE_KEY),
        SecureStore.getItemAsync(BIOMETRIC_KEY),
      ]);
      set({
        hasCompleted: val === 'true',
        portfolioType: (pt as PortfolioType) || null,
        biometricEnabled: bio === 'true',
        isLoading: false,
      });
    } catch {
      set({ isLoading: false });
    }
  },

  complete: async (portfolioType?: PortfolioType) => {
    await SecureStore.setItemAsync(ONBOARDING_KEY, 'true');
    if (portfolioType) {
      await SecureStore.setItemAsync(PORTFOLIO_TYPE_KEY, portfolioType);
    }
    set({ hasCompleted: true, portfolioType: portfolioType || null });
  },

  setPortfolioType: async (type: PortfolioType) => {
    if (type) {
      await SecureStore.setItemAsync(PORTFOLIO_TYPE_KEY, type);
    } else {
      await SecureStore.deleteItemAsync(PORTFOLIO_TYPE_KEY);
    }
    set({ portfolioType: type });
  },

  setBiometric: async (enabled: boolean) => {
    await SecureStore.setItemAsync(BIOMETRIC_KEY, enabled ? 'true' : 'false');
    set({ biometricEnabled: enabled });
  },

  setPendingCredentials: (creds: PendingCredentials) => {
    set({ pendingCredentials: creds });
  },

  addPendingFollow: (username: string) => {
    const current = get().pendingFollows;
    if (!current.includes(username)) {
      set({ pendingFollows: [...current, username] });
    }
  },

  clearPendingFollows: () => {
    set({ pendingFollows: [] });
  },

  reset: async () => {
    await Promise.all([
      SecureStore.deleteItemAsync(ONBOARDING_KEY),
      SecureStore.deleteItemAsync(PORTFOLIO_TYPE_KEY),
      SecureStore.deleteItemAsync(BIOMETRIC_KEY),
    ]);
    set({
      hasCompleted: false,
      portfolioType: null,
      biometricEnabled: false,
      pendingCredentials: null,
      pendingFollows: [],
    });
  },
}));

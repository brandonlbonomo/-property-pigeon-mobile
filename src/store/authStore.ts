import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { setToken } from '../services/api';

const TOKEN_KEY = 'pp_token';

interface AuthState {
  token: string | null;
  isLoading: boolean;
  hydrate: () => Promise<void>;
  signIn: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  isLoading: true,

  hydrate: async () => {
    try {
      const t = await SecureStore.getItemAsync(TOKEN_KEY);
      setToken(t);
      set({ token: t, isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  signIn: async (token: string) => {
    await SecureStore.setItemAsync(TOKEN_KEY, token);
    setToken(token);
    set({ token });
  },

  signOut: async () => {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    setToken(null);
    set({ token: null });
  },
}));

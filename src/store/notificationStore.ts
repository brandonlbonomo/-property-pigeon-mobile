import { create } from 'zustand';
import { apiFetch } from '../services/api';

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, any>;
  read: boolean;
  created_at: string;
}

interface NotificationState {
  notifications: AppNotification[];
  unreadCount: number;
  pushToken: string | null;
  preferences: Record<string, boolean>;

  setPushToken: (token: string | null) => void;
  fetchNotifications: () => Promise<void>;
  markRead: (ids?: string[]) => Promise<void>;
  markAllRead: () => Promise<void>;
  fetchPreferences: () => Promise<void>;
  updatePreferences: (prefs: Record<string, boolean>) => Promise<void>;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  unreadCount: 0,
  pushToken: null,
  preferences: {
    cleaning: true,
    checkin: true,
    inventory: true,
    financial: true,
    milestones: true,
    // Cleaner-specific
    newBooking: true,
    cleaningNeeded: true,
    invoiceReminder: true,
  },

  setPushToken: (token) => set({ pushToken: token }),

  fetchNotifications: async () => {
    try {
      const res = await apiFetch('/api/notifications');
      set({
        notifications: res.notifications || [],
        unreadCount: res.unread || 0,
      });
    } catch {
      // ignore
    }
  },

  markRead: async (ids) => {
    try {
      await apiFetch('/api/notifications/read', {
        method: 'POST',
        body: JSON.stringify({ ids: ids || [] }),
      });
      const notifs = get().notifications.map(n =>
        (!ids || ids.includes(n.id)) ? { ...n, read: true } : n
      );
      set({
        notifications: notifs,
        unreadCount: notifs.filter(n => !n.read).length,
      });
    } catch {
      // ignore
    }
  },

  markAllRead: async () => {
    try {
      await apiFetch('/api/notifications/read', {
        method: 'POST',
        body: JSON.stringify({ ids: [] }),
      });
      set(s => ({
        notifications: s.notifications.map(n => ({ ...n, read: true })),
        unreadCount: 0,
      }));
    } catch {
      // ignore
    }
  },

  fetchPreferences: async () => {
    try {
      const prefs = await apiFetch('/api/push/preferences');
      set({ preferences: prefs });
    } catch {
      // ignore
    }
  },

  updatePreferences: async (prefs) => {
    try {
      await apiFetch('/api/push/preferences', {
        method: 'POST',
        body: JSON.stringify(prefs),
      });
      set(s => ({ preferences: { ...s.preferences, ...prefs } }));
    } catch {
      // ignore
    }
  },
}));

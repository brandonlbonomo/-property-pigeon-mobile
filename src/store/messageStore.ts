import { create } from 'zustand';
import { apiFetch } from '../services/api';

export interface Attachment {
  file_id: string;
  filename: string;
  file_url: string;
  mime_type: string;
  size: number;
  is_image: boolean;
}

export interface SystemData {
  type: 'property_request' | 'property_invite';
  request_id: string;
  target_id: string;
  property_labels: string[];
  requester_name: string;
  status: 'pending' | 'approved' | 'denied';
}

export interface Message {
  id: string;
  sender_id: string;
  sender_name?: string;
  text: string;
  timestamp: string;
  read?: boolean;
  read_by?: string[];
  attachments?: Attachment[];
  system?: boolean;
  system_data?: SystemData;
}

export interface Conversation {
  id: string;
  is_group?: boolean;
  group_name?: string;
  participant_count?: number;
  other_user?: { id: string; username: string; role?: string; portfolio_score?: number | null };
  last_message: { text: string; timestamp: string; sender_id: string; sender_name?: string; has_attachments?: boolean };
  unread_count: number;
  updated_at: string;
}

interface ActiveConversation {
  id: string;
  is_group: boolean;
  group_name?: string;
  other_user?: { id: string; username: string; role?: string };
  participants?: string[];
  participant_names?: Record<string, string>;
  current_user_id?: string;
  linked_properties?: string[];
}

interface MessageState {
  conversations: Conversation[];
  activeMessages: Message[];
  activeOtherUser: { id: string; username: string; role?: string } | null;
  activeConversation: ActiveConversation | null;
  linkedProperties: string[];
  currentUserId: string | null;
  unreadTotal: number;
  loading: boolean;

  fetchConversations: () => Promise<void>;
  fetchMessages: (otherUserId: string) => Promise<void>;
  fetchConvMessages: (convId: string) => Promise<void>;
  sendMessage: (toUserId: string, text: string, attachments?: Attachment[]) => Promise<Message | null>;
  sendGroupMessage: (convId: string, text: string, attachments?: Attachment[]) => Promise<Message | null>;
  createGroup: (participantIds: string[], groupName?: string) => Promise<string | null>;
  markRead: (otherUserId: string) => Promise<void>;
  markConvRead: (convId: string) => Promise<void>;
  deleteConversation: (convId: string) => Promise<boolean>;
  fetchUnreadCount: () => Promise<void>;
}

export const useMessageStore = create<MessageState>((set, get) => ({
  conversations: [],
  activeMessages: [],
  activeOtherUser: null,
  activeConversation: null,
  linkedProperties: [],
  currentUserId: null,
  unreadTotal: 0,
  loading: false,

  fetchConversations: async () => {
    try {
      const data = await apiFetch('/api/messages/conversations');
      set({ conversations: data.conversations || [] });
    } catch {}
  },

  fetchMessages: async (otherUserId: string) => {
    const isInitial = get().activeMessages.length === 0;
    if (isInitial) set({ loading: true });
    try {
      const data = await apiFetch(`/api/messages/${otherUserId}`);
      set({
        activeMessages: data.messages || [],
        activeOtherUser: data.other_user || { id: otherUserId, username: otherUserId.slice(0, 8) },
        activeConversation: null,
        linkedProperties: data.linked_properties || [],
        currentUserId: data.current_user_id || null,
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },

  fetchConvMessages: async (convId: string) => {
    const isInitial = get().activeMessages.length === 0;
    if (isInitial) set({ loading: true });
    try {
      const data = await apiFetch(`/api/messages/conv/${convId}`);
      set({
        activeMessages: data.messages || [],
        activeOtherUser: data.other_user || null,
        activeConversation: {
          id: convId,
          is_group: data.is_group || false,
          group_name: data.group_name,
          other_user: data.other_user,
          participants: data.participants,
          participant_names: data.participant_names,
          current_user_id: data.current_user_id,
          linked_properties: data.linked_properties,
        },
        linkedProperties: data.linked_properties || [],
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },

  sendMessage: async (toUserId: string, text: string, attachments?: Attachment[]) => {
    try {
      const payload: any = { to_user_id: toUserId, text };
      if (attachments?.length) payload.attachments = attachments;
      const data = await apiFetch('/api/messages/send', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (data.message) {
        set(s => ({ activeMessages: [...s.activeMessages, data.message] }));
        return data.message;
      }
    } catch {}
    return null;
  },

  sendGroupMessage: async (convId: string, text: string, attachments?: Attachment[]) => {
    try {
      const payload: any = { conv_id: convId, text };
      if (attachments?.length) payload.attachments = attachments;
      const data = await apiFetch('/api/messages/send', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (data.message) {
        set(s => ({ activeMessages: [...s.activeMessages, data.message] }));
        return data.message;
      }
    } catch {}
    return null;
  },

  createGroup: async (participantIds: string[], groupName?: string) => {
    try {
      const data = await apiFetch('/api/messages/group/create', {
        method: 'POST',
        body: JSON.stringify({ participant_ids: participantIds, group_name: groupName }),
      });
      if (data.ok && data.conv_id) {
        return data.conv_id;
      }
    } catch {}
    return null;
  },

  markRead: async (otherUserId: string) => {
    try {
      await apiFetch(`/api/messages/read/${otherUserId}`, { method: 'POST' });
      set(s => ({
        conversations: s.conversations.map(c =>
          c.other_user?.id === otherUserId ? { ...c, unread_count: 0 } : c
        ),
        activeMessages: s.activeMessages.map(m => ({ ...m, read: true })),
      }));
    } catch {}
  },

  markConvRead: async (convId: string) => {
    try {
      await apiFetch(`/api/messages/read/${convId}`, { method: 'POST' });
      set(s => ({
        conversations: s.conversations.map(c =>
          c.id === convId ? { ...c, unread_count: 0 } : c
        ),
      }));
    } catch {}
  },

  deleteConversation: async (convId: string) => {
    try {
      await apiFetch(`/api/messages/conversations/${convId}`, { method: 'DELETE' });
      set(s => ({ conversations: s.conversations.filter(c => c.id !== convId) }));
      return true;
    } catch {
      return false;
    }
  },

  fetchUnreadCount: async () => {
    try {
      const data = await apiFetch('/api/messages/unread-count');
      set({ unreadTotal: data.unread_count || 0 });
    } catch {}
  },
}));

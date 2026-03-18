import { create } from 'zustand';
import { apiFetch } from '../services/api';

export interface FeedPost {
  id: string;
  user_id: string;
  username: string;
  role?: string;
  portfolio_score?: number | null;
  type: string;
  title: string;
  body: string;
  created_at: string;
}

interface FeedState {
  posts: FeedPost[];
  loading: boolean;
  page: number;
  hasMore: boolean;

  fetchFeed: (refresh?: boolean) => Promise<void>;
  loadMore: () => Promise<void>;
}

export const useFeedStore = create<FeedState>((set, get) => ({
  posts: [],
  loading: false,
  page: 0,
  hasMore: true,

  fetchFeed: async (refresh = false) => {
    set({ loading: true });
    try {
      const res = await apiFetch('/api/feed?page=0');
      set({
        posts: res.feed || [],
        page: 0,
        hasMore: (res.feed || []).length < (res.total || 0),
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },

  loadMore: async () => {
    const { page, hasMore, loading } = get();
    if (!hasMore || loading) return;
    const nextPage = page + 1;
    set({ loading: true });
    try {
      const res = await apiFetch(`/api/feed?page=${nextPage}`);
      const newPosts = res.feed || [];
      set(s => ({
        posts: [...s.posts, ...newPosts],
        page: nextPage,
        hasMore: s.posts.length + newPosts.length < (res.total || 0),
        loading: false,
      }));
    } catch {
      set({ loading: false });
    }
  },
}));

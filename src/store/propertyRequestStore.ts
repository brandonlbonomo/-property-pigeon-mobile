import { create } from 'zustand';
import { apiFetch } from '../services/api';

export interface PropertyUnit {
  feed_key: string;
  unit_name: string;
}

/** A property with optional unit-level listing IDs (mapped from PriceLabs) */
export interface ICalProperty {
  id: string;
  label: string;
  units?: PropertyUnit[];
}

export interface PropertyRequest {
  id: string;
  type: 'request' | 'invite';
  requester_id: string;
  target_id: string;
  host_id: string;
  cleaner_id: string;
  property_ids: string[];
  property_labels: string[];
  feed_keys?: string[];
  unit_labels?: string[];
  status: 'pending' | 'approved' | 'denied';
  created_at: string;
  resolved_at: string | null;
}

interface PropertyRequestState {
  loading: boolean;

  fetchHostICalProperties: () => Promise<ICalProperty[]>;
  createRequest: (
    targetUserId: string,
    propertyIds: string[],
    type: 'request' | 'invite',
    feedKeys?: string[],
  ) => Promise<{ ok: boolean; error?: string }>;
  respondToRequest: (
    requestId: string,
    action: 'approve' | 'deny',
  ) => Promise<{ ok: boolean; status?: string; error?: string }>;
}

export const usePropertyRequestStore = create<PropertyRequestState>((set) => ({
  loading: false,

  fetchHostICalProperties: async () => {
    try {
      const res = await apiFetch('/api/host/ical-properties');
      return res.properties || [];
    } catch {
      return [];
    }
  },

  createRequest: async (targetUserId, propertyIds, type, feedKeys) => {
    set({ loading: true });
    try {
      const payload: any = { target_user_id: targetUserId, property_ids: propertyIds, type };
      if (feedKeys?.length) payload.feed_keys = feedKeys;
      const res = await apiFetch('/api/property-request/create', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      set({ loading: false });
      return { ok: true };
    } catch (err: any) {
      set({ loading: false });
      return { ok: false, error: err.serverError || err.message || 'Failed to create request' };
    }
  },

  respondToRequest: async (requestId, action) => {
    set({ loading: true });
    try {
      const res = await apiFetch('/api/property-request/respond', {
        method: 'POST',
        body: JSON.stringify({ request_id: requestId, action }),
      });
      set({ loading: false });
      return { ok: true, status: res.status };
    } catch (err: any) {
      set({ loading: false });
      return { ok: false, error: err.serverError || err.message || 'Failed to respond' };
    }
  },
}));

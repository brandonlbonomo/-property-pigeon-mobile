import { API_BASE } from '../constants/api';

let _token: string | null = null;
let _onAuthExpired: (() => void) | null = null;

export function setToken(t: string | null) {
  _token = t;
}

export function getToken(): string | null {
  return _token;
}

/** Register a callback for when a 401 is received (token expired) */
export function onAuthExpired(cb: () => void) {
  _onAuthExpired = cb;
}

export async function apiFetch(path: string, opts: RequestInit = {}): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> || {}),
  };
  if (_token) {
    headers['Authorization'] = `Bearer ${_token}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...opts,
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);

      // Handle 401 — token expired or invalid
      if (res.status === 401) {
        _token = null;
        _onAuthExpired?.();
      }

      // Try to parse JSON error
      try {
        const errJson = JSON.parse(text);
        const err = new Error(errJson.error || `${res.status}: ${text}`) as any;
        err.status = res.status;
        err.serverError = errJson.error;
        throw err;
      } catch (parseErr: any) {
        if (parseErr.status) throw parseErr;
        throw new Error(`${res.status}: ${text}`);
      }
    }

    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : await res.text();
    return data;
  } catch (err: any) {
    clearTimeout(timeout);
    throw err;
  }
}

// ── Auth helpers ──

export async function apiRegister(
  email: string,
  password: string,
  opts?: { role?: string; username?: string; referral_code?: string }
): Promise<{ ok: boolean; token: string; user_id: number; email: string }> {
  const res = await apiFetch('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, ...opts }),
  });
  if (res.token) {
    setToken(res.token);
  }
  return res;
}

export async function apiLogin(email: string, password: string): Promise<{ ok: boolean; token: string; user_id: number; email: string; username?: string; role?: string }> {
  const res = await apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  if (res.token) {
    setToken(res.token);
  }
  return res;
}

export async function apiCheckUsername(username: string): Promise<{ available: boolean }> {
  return apiFetch('/api/auth/check-username', {
    method: 'POST',
    body: JSON.stringify({ username }),
  });
}

export async function apiUpdateUsername(username: string): Promise<{ ok: boolean; username: string }> {
  return apiFetch('/api/auth/update-username', {
    method: 'POST',
    body: JSON.stringify({ username }),
  });
}

export async function apiDeleteAccount(password?: string): Promise<{ ok: boolean }> {
  return apiFetch('/api/auth/delete', {
    method: 'POST',
    body: JSON.stringify({ password: password || '' }),
  });
}

// ── Social auth helpers ──

export async function apiAppleSignIn(
  identityToken: string,
  fullName?: { givenName?: string | null; familyName?: string | null } | null,
  email?: string | null,
): Promise<{ ok: boolean; token: string; user_id: number; email: string; username?: string; role?: string; is_new?: boolean }> {
  const res = await apiFetch('/api/auth/apple', {
    method: 'POST',
    body: JSON.stringify({
      identity_token: identityToken,
      full_name: fullName ? `${fullName.givenName || ''} ${fullName.familyName || ''}`.trim() : undefined,
      email: email || undefined,
    }),
  });
  if (res.token) {
    setToken(res.token);
  }
  return res;
}

export async function apiGoogleSignIn(
  idToken: string,
): Promise<{ ok: boolean; token: string; user_id: number; email: string; username?: string; role?: string; is_new?: boolean }> {
  const res = await apiFetch('/api/auth/google', {
    method: 'POST',
    body: JSON.stringify({ id_token: idToken }),
  });
  if (res.token) {
    setToken(res.token);
  }
  return res;
}

// ── Cleaner search & follow helpers ──

export async function apiSearchUsers(
  query: string,
  options?: { market?: string },
): Promise<{ users: Array<{ user_id: string; username: string; role: string; plaid_verified_pct?: number | null }> }> {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (options?.market) params.set('market', options.market);
  return apiFetch(`/api/users/search?${params.toString()}`);
}

export async function apiGetCities(query: string): Promise<{ cities: string[] }> {
  return apiFetch(`/api/cities?q=${encodeURIComponent(query)}`);
}

export async function apiGetPortfolioScore(): Promise<{ score: number | null }> {
  return apiFetch('/api/portfolio-score');
}

export async function apiGetFollowCode(): Promise<{ follow_code: string }> {
  return apiFetch('/api/follow/code');
}

export async function apiFollowRequest(username: string): Promise<{ ok: boolean; follow_id: string; status: string }> {
  return apiFetch('/api/follow/request', {
    method: 'POST',
    body: JSON.stringify({ username }),
  });
}

// ── File upload for messaging ──

export async function apiUploadFile(
  uri: string,
  filename: string,
  mimeType: string,
): Promise<{ file_id: string; filename: string; file_url: string; mime_type: string; size: number; is_image: boolean }> {
  const formData = new FormData();
  formData.append('file', {
    uri,
    name: filename,
    type: mimeType,
  } as any);

  const headers: Record<string, string> = {};
  if (_token) {
    headers['Authorization'] = `Bearer ${_token}`;
  }
  // Do NOT set Content-Type — let fetch auto-set multipart boundary

  const controller = new AbortController();
  const uploadTimeout = setTimeout(() => controller.abort(), 30000);

  const res = await fetch(`${API_BASE}/api/messages/upload`, {
    method: 'POST',
    headers,
    body: formData,
    signal: controller.signal,
  });
  clearTimeout(uploadTimeout);

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Upload failed: ${res.status} ${text}`);
  }

  return res.json();
}

import os
import json
import re
import hashlib
import bcrypt
import base64
import threading
import time as _time
import secrets
import tempfile
import functools
import logging
import requests
from email.utils import parsedate_to_datetime

# ── Logging configuration ────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("portfoliopigeon")
from flask import Flask, jsonify, request, redirect, send_file, g
from flask_cors import CORS
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
import plaid
from plaid.api import plaid_api
from plaid.model.link_token_create_request import LinkTokenCreateRequest
from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest
from plaid.model.transactions_sync_request import TransactionsSyncRequest
from plaid.model.transactions_get_request import TransactionsGetRequest
from plaid.model.transactions_get_request_options import TransactionsGetRequestOptions
from plaid.model.accounts_balance_get_request import AccountsBalanceGetRequest
from plaid.model.item_webhook_update_request import ItemWebhookUpdateRequest
from plaid.model.transactions_refresh_request import TransactionsRefreshRequest
from plaid.model.products import Products
from plaid.model.country_code import CountryCode
from cryptography.fernet import Fernet
from dotenv import load_dotenv

load_dotenv()

# ── Encryption helpers for sensitive per-user data ──────────
_FERNET = None

def _get_fernet():
    """Return a cached Fernet instance using ENCRYPTION_KEY env var."""
    global _FERNET
    if _FERNET is None:
        key = os.environ.get("ENCRYPTION_KEY", "")
        if not key:
            # Dev fallback: generate ephemeral key (data won't survive restart)
            key = Fernet.generate_key().decode()
            logger.warning("ENCRYPTION_KEY not set — using ephemeral key (dev only)")
        _FERNET = Fernet(key.encode() if isinstance(key, str) else key)
    return _FERNET

def _encrypt(plaintext: str) -> str:
    """Encrypt a string and return the Fernet token as a UTF-8 string."""
    return _get_fernet().encrypt(plaintext.encode()).decode()

def _decrypt(ciphertext: str) -> str:
    """Decrypt a Fernet token back to the original string."""
    return _get_fernet().decrypt(ciphertext.encode()).decode()

app = Flask(__name__, static_folder=".", static_url_path="")
CORS(app, origins=[
    "https://portfoliopigeon.com",
    "http://localhost:3000",
    "http://localhost:8081",
])
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16 MB global request size limit

PLAID_ENV         = os.getenv("PLAID_ENV", "development")
PLAID_CLIENT_ID   = os.getenv("PLAID_CLIENT_ID")
PLAID_SECRET      = os.getenv("PLAID_SECRET")
PLAID_WEBHOOK_URL = os.getenv("PLAID_WEBHOOK_URL", "")  # e.g. https://your-app.onrender.com/api/webhook

env_map = {
    "sandbox":     "https://sandbox.plaid.com",
    "development": "https://development.plaid.com",
    "production":  "https://production.plaid.com",
}

configuration = plaid.Configuration(
    host=env_map.get(PLAID_ENV, "https://development.plaid.com"),
    api_key={"clientId": PLAID_CLIENT_ID, "secret": PLAID_SECRET}
)
api_client   = plaid.ApiClient(configuration)
plaid_client = plaid_api.PlaidApi(api_client)

PLAID_HOST = env_map.get(PLAID_ENV, "https://development.plaid.com")
logger.info("Plaid env : %s", PLAID_ENV)
logger.info("Plaid host : %s", PLAID_HOST)
logger.warning("Client ID : %s..." if PLAID_CLIENT_ID else " PLAID_CLIENT_ID not set", PLAID_CLIENT_ID[:6])
logger.info("Webhook URL: %s", PLAID_WEBHOOK_URL or '(not set — webhooks disabled)')

# ── Stripe billing config ─────────────────────────────────────
import stripe
stripe.api_key = os.getenv("STRIPE_SECRET_KEY", "")
STRIPE_PUBLISHABLE_KEY = os.getenv("STRIPE_PUBLISHABLE_KEY", "")
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET", "")
STRIPE_PRODUCTS = {}

def _ensure_stripe_products():
    """Idempotent: find-or-create Stripe products + prices using lookup_key."""
    global STRIPE_PRODUCTS
    if not stripe.api_key:
        logger.warning("STRIPE_SECRET_KEY not set — billing disabled")
        return
    plans = {
        "pp_pro_monthly": {"name": "Portfolio Pigeon Pro", "amount": 1299},
        "cleaner_pro_monthly": {"name": "Cleaner Pro", "amount": 799},
    }
    for lookup_key, info in plans.items():
        try:
            prices = stripe.Price.list(lookup_keys=[lookup_key], limit=1)
            if prices.data:
                STRIPE_PRODUCTS[lookup_key] = prices.data[0].id
                logger.info("Found price %s: %s", lookup_key, prices.data[0].id)
            else:
                product = stripe.Product.create(name=info["name"])
                price = stripe.Price.create(
                    product=product.id,
                    unit_amount=info["amount"],
                    currency="usd",
                    recurring={"interval": "month"},
                    lookup_key=lookup_key,
                )
                STRIPE_PRODUCTS[lookup_key] = price.id
                logger.info("Created price %s: %s", lookup_key, price.id)
        except Exception as e:
            logger.error("Stripe product setup error (%s): %s", lookup_key, e)

    # Ensure referral coupon exists
    try:
        stripe.Coupon.retrieve("referral_50_off")
        logger.info("Found coupon referral_50_off")
    except Exception:
        try:
            stripe.Coupon.create(
                id="referral_50_off",
                percent_off=50,
                duration="once",
                name="Referral Reward — 50% Off",
            )
            logger.info("Created coupon referral_50_off")
        except Exception as e:
            logger.error("Stripe coupon setup error: %s", e)

_ensure_stripe_products()
logger.info("Stripe products: %s", STRIPE_PRODUCTS)

# OAuth states stored in persistent file store so all gunicorn workers share them

# ── Persistent store ─────────────────────────────────────────
# store = {
#   "accounts": [ { "access_token": "...", "item_id": "...", "cursor": "...", "name": "..." } ]
# }
# Use persistent disk if available, fall back to local
import os as _os
STORE_FILE = "/data/plaid_store.json" if _os.path.isdir("/data") else "plaid_store.json"
logger.info("Store file: %s", STORE_FILE)
STORE_ENV   = "PLAID_STORE_JSON"  # Render env var — survives deploys and filesystem wipes

def _user_store_file():
    """Return per-user store file path if authenticated, else global."""
    try:
        uid = getattr(g, 'user_id', None)
        if uid:
            # Validate user_id format to prevent path traversal
            if not re.match(r'^u_[0-9a-f]{16}$', uid):
                return None
            base = "/data" if _os.path.isdir("/data") else "."
            return f"{base}/store_{uid}.json"
    except RuntimeError:
        pass  # Outside request context (scheduler jobs)
    return None

def load_store():
    # Per-request cache: avoid re-reading disk within the same request
    try:
        cached = getattr(g, '_store_cache', None)
        if cached is not None:
            return cached
    except RuntimeError:
        pass  # Outside request context

    # Per-user store if authenticated
    user_sf = _user_store_file()
    if user_sf:
        try:
            with open(user_sf, "r") as f:
                data = json.load(f)
                if "accounts" not in data:
                    data["accounts"] = []
                try:
                    g._store_cache = data
                except RuntimeError:
                    pass
                return data
        except Exception:
            return {"accounts": []}

    # No authenticated user — return empty store (data isolation)
    # The global STORE_FILE is only used by scheduler jobs (outside request context)
    try:
        # Check if we're in a request context
        _ = g.user_id
        # In a request but no user — return empty (prevents data leaks)
        return {"accounts": []}
    except RuntimeError:
        pass

    # Outside request context (scheduler jobs) — use global store
    try:
        with open(STORE_FILE, "r") as f:
            data = json.load(f)
            if "accounts" not in data:
                data["accounts"] = []
            return data
    except Exception:
        pass
    # Disk file missing (e.g. after redeploy) — try env var backup
    try:
        raw = os.environ.get(STORE_ENV, "")
        if raw:
            data = json.loads(raw)
            if "accounts" not in data:
                data["accounts"] = []
            logger.info("Loaded store from env var backup")
            # Restore to disk immediately
            with open(STORE_FILE, "w") as f:
                json.dump(data, f)
            return data
    except Exception as e:
        logger.error("Env var restore failed: %s", e)
    return {"accounts": []}

def save_store(data):
    # Invalidate per-request cache so subsequent reads see the new data
    try:
        g._store_cache = data
    except RuntimeError:
        pass
    # Per-user store if authenticated
    user_sf = _user_store_file()
    if user_sf:
        lock = _get_store_lock(user_sf)
        _atomic_write_json(user_sf, data, lock)
        return  # No env var backup for per-user stores

    # Global store — save to disk
    lock = _get_store_lock(STORE_FILE)
    _atomic_write_json(STORE_FILE, data, lock)
    # Update in-process env var immediately — survives dyno sleep/wake within same process
    try:
        os.environ[STORE_ENV] = json.dumps(data)
    except Exception as e:
        logger.error("In-process env var update failed: %s", e)
    # Also update env var via Render API in background — survives redeploys
    def _render_backup():
        try:
            api_key    = os.environ.get("RENDER_API_KEY", "")
            service_id = os.environ.get("RENDER_SERVICE_ID", "")
            if not (api_key and service_id):
                return
            import urllib.request
            req = urllib.request.Request(
                f"https://api.render.com/v1/services/{service_id}/env-vars",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=8) as r:
                existing = json.loads(r.read())
            env_list = existing if isinstance(existing, list) else existing.get("envVars", [])
            updated = False
            for ev in env_list:
                if ev.get("key") == STORE_ENV:
                    ev["value"] = json.dumps(data)
                    updated = True
            if not updated:
                env_list.append({"key": STORE_ENV, "value": json.dumps(data)})
            patch = urllib.request.Request(
                f"https://api.render.com/v1/services/{service_id}/env-vars",
                data=json.dumps(env_list).encode(),
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                method="PUT"
            )
            with urllib.request.urlopen(patch, timeout=8):
                pass
            logger.info("Env var backup updated")
        except Exception as e:
            logger.warning("Env var backup skipped: %s", e)
    import threading
    threading.Thread(target=_render_backup, daemon=True).start()

# Don't cache store in memory — always read/write disk so nothing is lost on restart
# store global only used as fallback; all routes call load_store() directly

# ── Auth: users file ─────────────────────────────────────────
USERS_FILE = "/data/users.json" if _os.path.isdir("/data") else "users.json"

def load_users():
    try:
        with open(USERS_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {}

def save_users(data):
    _atomic_write_json(USERS_FILE, data, _users_file_lock)
    # Invalidate the user-id index cache
    global _user_id_index, _user_id_index_ts
    _user_id_index = None
    _user_id_index_ts = 0

# ── User ID reverse index (O(1) lookup by user_id) ──────────
_user_id_index = None  # {user_id: email}
_user_id_index_ts = 0

def _build_user_id_index(users):
    """Build/refresh user_id → email reverse index."""
    global _user_id_index, _user_id_index_ts
    _user_id_index = {u["id"]: email for email, u in users.items() if "id" in u}
    _user_id_index_ts = _time.time()
    return _user_id_index

def _find_user_by_id(users, user_id):
    """O(1) lookup: returns (email, user_dict) or (None, None)."""
    global _user_id_index
    if _user_id_index is None or _time.time() - _user_id_index_ts > 60:
        _build_user_id_index(users)
    email = _user_id_index.get(user_id)
    if email and email in users:
        return email, users[email]
    # Fallback: index stale, do linear scan + rebuild
    for e, u in users.items():
        if u.get("id") == user_id:
            _user_id_index[user_id] = e
            return e, u
    return None, None

# ── Atomic write utility (Phase 2) ───────────────────────────
_users_file_lock = threading.Lock()
_store_file_locks = {}  # per-path locks for user store files
_store_file_locks_lock = threading.Lock()

def _get_store_lock(path):
    """Get or create a lock for a specific store file path."""
    with _store_file_locks_lock:
        if path not in _store_file_locks:
            _store_file_locks[path] = threading.Lock()
        return _store_file_locks[path]

def _atomic_write_json(filepath, data, lock=None):
    """Write JSON atomically: write to temp file, then os.replace (POSIX atomic)."""
    dir_name = os.path.dirname(filepath) or "."
    try:
        fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(data, f)
            os.replace(tmp_path, filepath)
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
    except Exception as e:
        logger.error("Failed to save %s: %s", filepath, e)

# ── In-memory token cache (Phase 1) ──────────────────────────
_token_cache = {}  # token → (user_id, issued_at)
_token_cache_lock = threading.Lock()

def _cache_token(token, user_id, issued_at):
    with _token_cache_lock:
        _token_cache[token] = (user_id, issued_at)

def _invalidate_token(token):
    with _token_cache_lock:
        _token_cache.pop(token, None)

def _invalidate_user_tokens(user_id):
    """Remove all cached tokens for a given user_id."""
    with _token_cache_lock:
        to_remove = [t for t, (uid, _) in _token_cache.items() if uid == user_id]
        for t in to_remove:
            del _token_cache[t]

def _warm_token_cache():
    """Populate token cache from users.json on startup."""
    users = load_users()
    with _token_cache_lock:
        for email, u in users.items():
            token = u.get("token")
            if token:
                _token_cache[token] = (u["id"], u.get("token_issued_at", 0))
    logger.info("Token cache warmed: %s tokens cached", len(_token_cache))

# ── Rate limiter (Phase 3) ───────────────────────────────────
_rate_buckets = {}  # (endpoint, ip) → [timestamp, ...]
_rate_buckets_lock = threading.Lock()

def _rate_limit_check(key, max_requests, window_seconds):
    """Check rate limit for a key. Returns True if allowed, False if exceeded."""
    now = _time.time()
    with _rate_buckets_lock:
        timestamps = _rate_buckets.get(key, [])
        # Remove expired entries
        cutoff = now - window_seconds
        timestamps = [t for t in timestamps if t > cutoff]
        if len(timestamps) >= max_requests:
            _rate_buckets[key] = timestamps
            return False
        timestamps.append(now)
        _rate_buckets[key] = timestamps
        return True

def rate_limit(max_requests, window_seconds):
    """Decorator: rate limit by IP address."""
    def decorator(f):
        @functools.wraps(f)
        def wrapper(*args, **kwargs):
            ip = request.headers.get("X-Forwarded-For", request.remote_addr) or "unknown"
            key = (f.__name__, ip)
            if not _rate_limit_check(key, max_requests, window_seconds):
                return jsonify({"error": "Too many requests. Please try again later."}), 429
            return f(*args, **kwargs)
        return wrapper
    return decorator

def _cleanup_rate_buckets():
    """Remove expired rate limit entries (run periodically)."""
    now = _time.time()
    with _rate_buckets_lock:
        expired_keys = []
        for key, timestamps in _rate_buckets.items():
            timestamps[:] = [t for t in timestamps if t > now - 600]
            if not timestamps:
                expired_keys.append(key)
        for key in expired_keys:
            del _rate_buckets[key]

# ── Error sanitization (Phase 5) ─────────────────────────────
def _safe_error(e, context="operation"):
    """Log full error server-side, return sanitized message to client."""
    err_str = str(e)
    logger.error("%s error: %s", context, err_str, exc_info=True)

    # Plaid-specific safe messages
    if "ITEM_LOGIN_REQUIRED" in err_str:
        return "Bank connection expired — please re-authenticate", 400
    if "INVALID_ACCESS_TOKEN" in err_str:
        return "Bank connection is invalid — please re-link your account", 400
    if "RATE_LIMIT" in err_str or "rate limit" in err_str.lower():
        return "Service rate limit reached — please try again in a few minutes", 429
    if "INSTITUTION_NOT_RESPONDING" in err_str:
        return "Your bank is not responding — please try again later", 503
    if "INSTITUTION_DOWN" in err_str:
        return "Your bank is currently unavailable — please try again later", 503

    # Stripe-specific safe messages
    if "stripe" in context.lower() or "billing" in context.lower() or "checkout" in context.lower():
        return "Billing service error — please try again", 500

    # Generic safe message
    return f"{context} failed — please try again", 500

# ── Response caching (Phase 6) ───────────────────────────────
_response_cache = {}  # (endpoint, user_id) → {"data": ..., "ts": float}
_response_cache_lock = threading.Lock()

def _get_cached_response(endpoint, user_id, ttl_seconds):
    """Return cached response if fresh, else None."""
    with _response_cache_lock:
        key = (endpoint, user_id)
        entry = _response_cache.get(key)
        if entry and (_time.time() - entry["ts"]) < ttl_seconds:
            return entry["data"]
    return None

def _set_cached_response(endpoint, user_id, data):
    """Cache a response."""
    with _response_cache_lock:
        _response_cache[(endpoint, user_id)] = {"data": data, "ts": _time.time()}

def _invalidate_cache(endpoint, user_id=None):
    """Invalidate cache for an endpoint, optionally for a specific user.
    Supports prefix matching: _invalidate_cache("cockpit") clears "cockpit", "cockpit:2026-03", etc."""
    with _response_cache_lock:
        if user_id:
            keys = [k for k in _response_cache if k[0] == endpoint or k[0].startswith(endpoint + ":")]
            keys = [k for k in keys if k[1] == user_id]
            for k in keys:
                del _response_cache[k]
        else:
            keys = [k for k in _response_cache if k[0] == endpoint or k[0].startswith(endpoint + ":")]
            for k in keys:
                del _response_cache[k]

# ── SSRF protection ───────────────────────────────────────────
import ipaddress as _ipaddress
import urllib.parse as _urlparse

def _is_safe_url(url):
    """Validate URL is safe to fetch server-side (prevent SSRF)."""
    try:
        parsed = _urlparse.urlparse(url)
        # Only allow HTTP(S)
        if parsed.scheme not in ("http", "https"):
            return False
        hostname = parsed.hostname or ""
        # Block empty hostname
        if not hostname:
            return False
        # Block localhost variants
        if hostname in ("localhost", "127.0.0.1", "0.0.0.0", "[::1]"):
            return False
        # Block private/reserved IP ranges
        try:
            ip = _ipaddress.ip_address(hostname)
            if ip.is_private or ip.is_reserved or ip.is_loopback or ip.is_link_local:
                return False
        except ValueError:
            pass  # hostname is a domain, not an IP — that's fine
        # Block cloud metadata endpoints
        if hostname in ("169.254.169.254", "metadata.google.internal"):
            return False
        return True
    except Exception:
        return False

# ── User ID format validation ────────────────────────────────
_USER_ID_RE = re.compile(r'^u_[0-9a-f]{16}$')

def _is_valid_user_id(uid):
    """Validate user_id matches expected format to prevent path traversal."""
    return bool(_USER_ID_RE.match(uid))

# ── Billing meta (lifetime-free counter) ─────────────────────
BILLING_META_FILE = "/data/billing_meta.json" if _os.path.isdir("/data") else "billing_meta.json"

def _load_billing_meta():
    try:
        with open(BILLING_META_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {"plaid_free_users": []}

def _save_billing_meta(data):
    _atomic_write_json(BILLING_META_FILE, data)

PUSH_TOKENS_FILE = "/data/push_tokens.json" if _os.path.isdir("/data") else "push_tokens.json"
FOLLOWS_FILE = "/data/follows.json" if _os.path.isdir("/data") else "follows.json"
NOTIFICATIONS_FILE = "/data/notifications.json" if _os.path.isdir("/data") else "notifications.json"
PROPERTY_REQUESTS_FILE = "/data/property_requests.json" if _os.path.isdir("/data") else "property_requests.json"

def _load_json_file(path):
    try:
        with open(path, "r") as f:
            return json.load(f)
    except Exception:
        return {}

def _save_json_file(path, data):
    _atomic_write_json(path, data)

def _send_push(tokens, title, body, data=None):
    """Send push notification via Expo push API."""
    import urllib.request
    messages = []
    for token in tokens:
        if not token or not token.startswith("ExponentPushToken"):
            continue
        msg = {"to": token, "title": title, "body": body, "sound": "default"}
        if data:
            msg["data"] = data
        messages.append(msg)
    if not messages:
        return
    try:
        req = urllib.request.Request(
            "https://exp.host/--/api/v2/push/send",
            data=json.dumps(messages).encode(),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        logger.error("Push send error: %s", e)

def _store_notification(user_id, ntype, title, body, data=None):
    """Store notification in history."""
    notifs = _load_json_file(NOTIFICATIONS_FILE)
    user_notifs = notifs.get(user_id, [])
    user_notifs.insert(0, {
        "id": "n_" + secrets.token_hex(6),
        "type": ntype,
        "title": title,
        "body": body,
        "data": data or {},
        "read": False,
        "created_at": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()),
    })
    # Keep last 100
    notifs[user_id] = user_notifs[:100]
    _save_json_file(NOTIFICATIONS_FILE, notifs)

def _get_user_push_tokens(user_id):
    """Get push tokens for a user."""
    pt = _load_json_file(PUSH_TOKENS_FILE)
    entry = pt.get(user_id, {})
    return entry.get("tokens", [])

def _load_store_for_user(user_id):
    """Load store for a specific user (for cross-user data access)."""
    if not re.match(r'^u_[0-9a-f]{16}$', user_id):
        return {"accounts": [], "transactions": {}}
    base = "/data" if _os.path.isdir("/data") else "."
    sf = f"{base}/store_{user_id}.json"
    try:
        with open(sf, "r") as f:
            data = json.load(f)
            if "accounts" not in data:
                data["accounts"] = []
            return data
    except Exception:
        return {"accounts": [], "transactions": {}}

# ── Auth: before_request middleware ───────────────────────────
PUBLIC_PREFIXES = (
    "/api/auth/", "/api/health", "/api/webhook",
    "/api/billing/webhook", "/api/billing/success", "/api/billing/cancel",
    "/api/billing/portal-return",
    "/api/iap/apple-notifications",
    "/manifest.json", "/icon-",
    "/api/users/search", "/api/users/profile/", "/api/cities",
    "/api/referral/validate",
    "/privacy", "/terms",
    "/api/messages/files/",
    "/api/pricelabs/diagnose",
)

@app.before_request
def check_bearer_token():
    """Validate Bearer token and enforce auth on non-public routes."""
    g.user_id = None

    # Extract token if present
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth[7:]
        # Phase 1: O(1) cache lookup first
        with _token_cache_lock:
            cached = _token_cache.get(token)
        if cached:
            user_id, issued_at = cached
            if _time.time() - issued_at <= 30 * 86400:
                g.user_id = user_id
            # else: expired — fall through as unauthenticated
        else:
            # Cache miss — fall back to disk scan, then populate cache
            users = load_users()
            for email, u in users.items():
                if u.get("token") == token:
                    issued = u.get("token_issued_at", 0)
                    if _time.time() - issued > 30 * 86400:
                        break  # expired
                    g.user_id = u["id"]
                    _cache_token(token, u["id"], issued)
                    break

    # Allow public routes without auth
    path = request.path
    if path == "/" or any(path.startswith(p) for p in PUBLIC_PREFIXES):
        return  # Allow through

    # All other routes require valid auth
    if g.user_id is None:
        return jsonify({"error": "Not authenticated"}), 401

@app.after_request
def _log_request(response):
    """Log every request with method, path, status, user, and elapsed time."""
    try:
        elapsed = (_time.time() - getattr(g, '_request_start', _time.time())) * 1000
        uid = getattr(g, 'user_id', None) or '-'
        ip = request.headers.get('X-Forwarded-For', request.remote_addr) or '-'
        level = logging.WARNING if response.status_code >= 400 else logging.INFO
        logger.log(level, "%s %s %s %.0fms user=%s ip=%s",
                   request.method, request.path, response.status_code,
                   elapsed, uid, ip)
    except Exception:
        pass
    return response

@app.before_request
def _start_timer():
    g._request_start = _time.time()

# ── Auth endpoints ────────────────────────────────────────────
@app.route("/api/auth/register", methods=["POST"])
@app.route("/api/register", methods=["POST"])
@rate_limit(5, 300)  # 5 requests per 5 minutes per IP
def auth_register():
    body = request.get_json(force=True) or {}
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    if not email or not password:
        return jsonify({"ok": False, "error": "Email and password required"}), 400
    if len(password) < 8:
        return jsonify({"ok": False, "error": "Password must be at least 8 characters"}), 400
    if "@" not in email or not _has_valid_mx(email.split("@")[1]):
        return jsonify({"ok": False, "error": "Please use a valid email address"}), 400
    users = load_users()
    if email in users:
        return jsonify({"ok": False, "error": "Account already exists"}), 409
    user_id = "u_" + secrets.token_hex(8)
    token = secrets.token_hex(32)
    pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    role = body.get("role", "owner")  # "owner" or "cleaner"
    username = (body.get("username") or "").strip().lower()
    # Check username uniqueness (case-insensitive, also checks email prefixes)
    if username:
        for reg_email, u in users.items():
            stored = (u.get("username") or "").lower()
            email_prefix = reg_email.split("@")[0].lower()
            if stored == username or email_prefix == username:
                return jsonify({"ok": False, "error": "Username is already taken"}), 409
    follow_code = "PPG-" + secrets.token_hex(3).upper() if role == "owner" else ""
    referral_code = "REF-" + secrets.token_hex(3).upper()

    # Check if registering with a referral code
    referred_by = None
    input_referral = (body.get("referral_code") or "").strip().upper()
    if input_referral:
        for _, u in users.items():
            if u.get("referral_code") == input_referral:
                referred_by = u["id"]
                break

    users[email] = {
        "id": user_id,
        "password_hash": pw_hash,
        "token": token,
        "token_issued_at": _time.time(),
        "role": role,
        "username": username,
        "follow_code": follow_code,
        "referral_code": referral_code,
        "referred_by": referred_by,
        "referral_rewarded": False,
        "created_at": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()),
    }
    with _users_file_lock:
        save_users(users)
    _cache_token(token, user_id, _time.time())
    logger.info("Registered user %s -> %s%s", email, user_id, " (referred by %s)" % referred_by if referred_by else "")
    return jsonify({"ok": True, "user_id": user_id, "token": token, "email": email})

def _has_valid_mx(domain):
    """Check if domain has real MX records (not null MX)."""
    try:
        import dns.resolver
        answers = dns.resolver.resolve(domain, 'MX')
        for rdata in answers:
            mx = str(rdata.exchange).rstrip('.')
            if mx and mx != '.':
                return True
        return False
    except Exception:
        return False

@app.route("/api/auth/check-email", methods=["POST"])
@rate_limit(20, 60)  # 20 requests per minute per IP
def auth_check_email():
    body = request.get_json(force=True) or {}
    email = (body.get("email") or "").strip().lower()
    if not email or "@" not in email:
        return jsonify({"available": False, "error": "Invalid email"}), 400
    domain = email.split("@")[1]
    if not domain or "." not in domain:
        return jsonify({"available": False, "error": "Invalid email"}), 400
    # Check domain has real mail servers
    if not _has_valid_mx(domain):
        return jsonify({"available": False, "error": "Invalid email domain"})
    users = load_users()
    if email in users:
        return jsonify({"available": False, "error": "Email already registered"})
    return jsonify({"available": True})

@app.route("/api/auth/check-username", methods=["POST"])
@rate_limit(20, 60)  # 20 requests per minute per IP
def auth_check_username():
    body = request.get_json(force=True) or {}
    username = (body.get("username") or "").strip().lower()
    if not username or len(username) < 3:
        return jsonify({"available": False}), 400
    # If authenticated, exclude self so users can claim their own email prefix
    current_uid = None
    try:
        current_uid, _, _ = _authenticate()
    except Exception:
        pass
    users = load_users()
    for email, u in users.items():
        # Skip self when checking availability
        if current_uid and u.get("id") == current_uid:
            continue
        stored = (u.get("username") or "").lower()
        email_prefix = email.split("@")[0].lower()
        if stored == username or email_prefix == username:
            return jsonify({"available": False})
    return jsonify({"available": True})

@app.route("/api/auth/update-username", methods=["POST"])
def auth_update_username():
    uid, status, error = _authenticate()
    if error:
        return error, status
    body = request.get_json(force=True) or {}
    username = (body.get("username") or "").strip().lower()
    if not username or len(username) < 3:
        return jsonify({"ok": False, "error": "Username must be at least 3 characters"}), 400
    if not re.match(r'^[a-zA-Z0-9._-]+$', username):
        return jsonify({"ok": False, "error": "Username can only contain letters, numbers, dots, dashes, underscores"}), 400
    users = load_users()
    # Find current user's email
    current_email = None
    for email, u in users.items():
        if u.get("id") == uid:
            current_email = email
            break
    if not current_email:
        return jsonify({"ok": False, "error": "User not found"}), 404
    # Check uniqueness (exclude self)
    for email, u in users.items():
        if email == current_email:
            continue
        stored = (u.get("username") or "").lower()
        email_prefix = email.split("@")[0].lower()
        if stored == username or email_prefix == username:
            return jsonify({"ok": False, "error": "Username is already taken"}), 409
    users[current_email]["username"] = username
    with _users_file_lock:
        save_users(users)
    return jsonify({"ok": True, "username": username})

@app.route("/api/auth/login", methods=["POST"])
@app.route("/api/login", methods=["POST"])
@rate_limit(10, 300)  # 10 requests per 5 minutes per IP
def auth_login():
    body = request.get_json(force=True) or {}
    identifier = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    if not identifier or not password:
        return jsonify({"ok": False, "error": "Email or username and password required"}), 400
    users = load_users()
    ip = request.headers.get('X-Forwarded-For', request.remote_addr) or 'unknown'
    # Try direct email lookup first
    email = identifier
    user = users.get(identifier)
    # If not found by email, search by username or email prefix
    if not user:
        for user_email, u in users.items():
            stored_username = (u.get("username") or "").lower()
            email_prefix = user_email.split("@")[0].lower()
            if (stored_username and stored_username == identifier) or email_prefix == identifier:
                user = u
                email = user_email
                break
    if not user:
        logger.warning("Login failed: unknown identifier=%s ip=%s", identifier, ip)
        return jsonify({"ok": False, "error": "Invalid credentials"}), 401
    stored_hash = user["password_hash"]
    # Transparent migration: old SHA256 hashes are 64 hex chars
    if len(stored_hash) == 64:
        # Legacy SHA256 check
        if hashlib.sha256(password.encode()).hexdigest() != stored_hash:
            logger.warning("Login failed: bad password email=%s ip=%s", email, ip)
            return jsonify({"ok": False, "error": "Invalid credentials"}), 401
        # Upgrade to bcrypt on successful login
        user["password_hash"] = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    else:
        # bcrypt check
        if not bcrypt.checkpw(password.encode(), stored_hash.encode()):
            logger.warning("Login failed: bad password email=%s ip=%s", email, ip)
            return jsonify({"ok": False, "error": "Invalid credentials"}), 401
    # Invalidate old token from cache before issuing new one
    old_token = user.get("token")
    if old_token:
        _invalidate_token(old_token)
    # Generate a fresh token on each login
    token = secrets.token_hex(32)
    user["token"] = token
    user["token_issued_at"] = _time.time()
    with _users_file_lock:
        save_users(users)
    _cache_token(token, user["id"], user["token_issued_at"])
    logger.info("Login success: email=%s user=%s ip=%s", email, user["id"], ip)
    return jsonify({"ok": True, "user_id": user["id"], "token": token, "email": email, "username": user.get("username", ""), "role": user.get("role", "owner")})

@app.route("/api/auth/me", methods=["GET"])
def auth_me():
    """Return current user's profile info including role."""
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Not authenticated"}), 401
    users = load_users()
    for email, u in users.items():
        if u.get("id") == uid:
            return jsonify({
                "ok": True,
                "user_id": uid,
                "email": email,
                "username": u.get("username", ""),
                "role": u.get("role", "owner"),
            })
    return jsonify({"error": "User not found"}), 404


@app.route("/api/auth/delete", methods=["POST"])
def auth_delete():
    # Must be authenticated
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    users = load_users()
    target_email = None
    for email, u in users.items():
        if u["id"] == uid:
            target_email = email
            break
    if not target_email:
        return jsonify({"ok": False, "error": "User not found"}), 404
    # Invalidate token cache before deleting
    old_token = users[target_email].get("token")
    if old_token:
        _invalidate_token(old_token)
    del users[target_email]
    with _users_file_lock:
        save_users(users)
    # Delete per-user store file
    base = "/data" if _os.path.isdir("/data") else "."
    store_file = f"{base}/store_{uid}.json"
    try:
        os.remove(store_file)
    except Exception:
        pass
    logger.info("Deleted user %s (%s)", target_email, uid)
    return jsonify({"ok": True})

# ── Forgot / Reset password ──────────────────────────────────
@app.route("/api/auth/forgot-password", methods=["POST"])
@rate_limit(3, 600)  # 3 requests per 10 minutes per IP
def auth_forgot_password():
    body = request.get_json(force=True) or {}
    email = (body.get("email") or "").strip().lower()
    if not email:
        return jsonify({"ok": False, "error": "Email required"}), 400
    users = load_users()
    user = users.get(email)
    if not user:
        # Don't reveal whether email exists — return ok either way
        return jsonify({"ok": True})
    code = str(secrets.randbelow(900000) + 100000)  # 6-digit numeric
    user["reset_code"] = code
    user["reset_code_expires"] = _time.time() + 900  # 15 minutes
    save_users(users)
    logger.info("Password reset code generated for %s", email)
    return jsonify({"ok": True})

@app.route("/api/auth/reset-password", methods=["POST"])
@rate_limit(5, 300)  # 5 requests per 5 minutes per IP
def auth_reset_password():
    body = request.get_json(force=True) or {}
    email = (body.get("email") or "").strip().lower()
    code = (body.get("code") or "").strip()
    new_password = body.get("new_password") or ""
    if not email or not code or not new_password:
        return jsonify({"ok": False, "error": "Email, code, and new_password required"}), 400
    if len(new_password) < 8:
        return jsonify({"ok": False, "error": "Password must be at least 8 characters"}), 400
    users = load_users()
    user = users.get(email)
    if not user:
        return jsonify({"ok": False, "error": "Invalid code"}), 400
    stored_code = user.get("reset_code")
    expires = user.get("reset_code_expires", 0)
    if not stored_code or not secrets.compare_digest(stored_code, code):
        return jsonify({"ok": False, "error": "Invalid code"}), 400
    if _time.time() > expires:
        return jsonify({"ok": False, "error": "Code expired"}), 400
    pw_hash = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt()).decode()
    user["password_hash"] = pw_hash
    user.pop("reset_code", None)
    user.pop("reset_code_expires", None)
    # Invalidate old token — force re-login after password reset
    old_token = user.get("token")
    if old_token:
        _invalidate_token(old_token)
    new_token = secrets.token_hex(32)
    user["token"] = new_token
    user["token_issued_at"] = _time.time()
    with _users_file_lock:
        save_users(users)
    _cache_token(new_token, user["id"], _time.time())
    logger.info("Password reset for %s", email)
    return jsonify({"ok": True, "token": new_token})

# ── Referral endpoints ────────────────────────────────────────
@app.route("/api/referral/validate", methods=["POST"])
@rate_limit(10, 60)  # 10 requests per minute per IP
def referral_validate():
    body = request.get_json(force=True) or {}
    code = (body.get("referral_code") or "").strip().upper()
    if not code:
        return jsonify({"valid": False})
    users = load_users()
    for _, u in users.items():
        if u.get("referral_code") == code:
            return jsonify({"valid": True})
    return jsonify({"valid": False})


@app.route("/api/referral/code", methods=["GET"])
def referral_code():
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Authentication required"}), 401
    users = load_users()
    user = None
    for _, u in users.items():
        if u.get("id") == uid:
            user = u
            break
    if not user:
        return jsonify({"error": "User not found"}), 404
    # Count how many users this person has referred
    referral_count = sum(1 for _, u in users.items() if u.get("referred_by") == uid)
    return jsonify({
        "referral_code": user.get("referral_code"),
        "referred_by": user.get("referred_by"),
        "referral_count": referral_count,
    })


def _handle_referral_reward(paying_user_id):
    """Apply 50% off coupon to referrer when referred user's first payment succeeds."""
    users = load_users()
    paying_user = None
    for _, u in users.items():
        if u.get("id") == paying_user_id:
            paying_user = u
            break
    if not paying_user:
        return
    referred_by = paying_user.get("referred_by")
    if not referred_by or paying_user.get("referral_rewarded"):
        return
    # Find the referrer
    referrer = None
    for _, u in users.items():
        if u.get("id") == referred_by:
            referrer = u
            break
    if not referrer:
        return
    referrer_sub = referrer.get("subscription_id")
    referrer_customer = referrer.get("stripe_customer_id")
    if not referrer_sub or not referrer_customer:
        return
    try:
        stripe.Subscription.modify(referrer_sub, coupon="referral_50_off")
        # Mark as rewarded to prevent duplicate rewards
        for _, u in users.items():
            if u.get("id") == paying_user_id:
                u["referral_rewarded"] = True
                break
        save_users(users)
        logger.info("Referral reward: applied 50% off to %s for referring %s", referred_by, paying_user_id)
    except Exception as e:
        logger.error("Referral reward failed for %s: %s", paying_user_id, e)


# ── Frontend ──────────────────────────────────────────────────
@app.route("/")
def frontend():
    response = app.make_response(app.send_static_file("index.html"))
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

# ── PWA manifest ──────────────────────────────────────────────
@app.route("/manifest.json")
def manifest():
    return jsonify({
        "name": "Portfolio Pigeon",
        "short_name": "Pigeon",
        "start_url": "/",
        "display": "standalone",
        "background_color": "#f5f5f7",
        "theme_color": "#1a1a2e",
        "icons": [
            {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable"}
        ]
    })

@app.route("/icon-192.png")
def icon192():
    return send_file("icon-192.png", mimetype="image/png")

@app.route("/icon-512.png")
def icon512():
    return send_file("icon-512.png", mimetype="image/png")

# ── Health ────────────────────────────────────────────────────
@app.route("/api/health")
def health():
    store = load_store()
    return jsonify({
        "ok":               True,
        "plaid_env":        PLAID_ENV,
        "plaid_host":       PLAID_HOST,
        "webhook_url":      PLAID_WEBHOOK_URL or None,
        "webhooks_enabled": bool(PLAID_WEBHOOK_URL),
        "account_count":    len(store["accounts"]),
        "transaction_count": len(store.get("transactions", {})),
        "accounts":         [a.get("name") for a in store["accounts"]],
    })

# ── Legal pages ───────────────────────────────────────────────
@app.route("/privacy")
def privacy_policy():
    return """<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Privacy Policy — Portfolio Pigeon</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:720px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.7}
h1{font-size:28px}h2{font-size:20px;margin-top:32px}p,li{font-size:15px}a{color:#3B82F6}</style></head>
<body>
<h1>Privacy Policy</h1>
<p><strong>Last updated:</strong> March 15, 2026</p>
<p>Portfolio Pigeon ("we", "us", "our") operates the Portfolio Pigeon mobile application (the "App"). This policy explains what data we collect, how we use it, and your rights.</p>

<h2>1. Information We Collect</h2>
<p><strong>Account information:</strong> Email address, username, and a securely hashed password when you create an account.</p>
<p><strong>Financial data (optional):</strong> If you connect a bank account via Plaid, we receive transaction data (dates, amounts, merchant names) and account metadata. We never receive or store your bank login credentials — Plaid handles authentication directly.</p>
<p><strong>Property data:</strong> Property names, addresses, calendar feeds (iCal URLs), rental income, expense records, and inventory information you choose to enter.</p>
<p><strong>Biometric data:</strong> If you enable Face ID / Touch ID, authentication is handled entirely on your device by Apple's LocalAuthentication framework. We do not collect, store, or transmit any biometric data.</p>
<p><strong>Device information:</strong> Push notification tokens (if you enable notifications), device type, and operating system version for crash reporting and compatibility.</p>
<p><strong>Usage data:</strong> We may collect anonymized usage analytics such as feature usage frequency and screen views to improve the App. This data is not linked to your identity.</p>

<h2>2. How We Use Your Data</h2>
<ul>
<li>Display your financial dashboard, calendar, and inventory within the App</li>
<li>Sync transactions from connected bank accounts via Plaid</li>
<li>Send push notifications you've opted into (e.g., cleaning schedules, follow requests)</li>
<li>Process subscription payments via Apple In-App Purchase and Stripe</li>
<li>Improve and personalize your experience within the App</li>
</ul>

<h2>3. Third-Party Services</h2>
<p>We use the following third-party services that may receive your data:</p>
<ul>
<li><strong>Apple (In-App Purchase):</strong> Subscription payment processing. <a href="https://www.apple.com/legal/privacy/">Apple's privacy policy</a> applies.</li>
<li><strong>RevenueCat:</strong> Subscription management and entitlement verification. RevenueCat processes purchase receipts from Apple.</li>
<li><strong>Plaid:</strong> Bank account linking and transaction data retrieval. <a href="https://plaid.com/legal/">Plaid's end-user privacy policy</a> applies.</li>
<li><strong>Stripe:</strong> Payment processing for web-based subscriptions. <a href="https://stripe.com/privacy">Stripe's privacy policy</a> applies.</li>
<li><strong>Render:</strong> Cloud hosting infrastructure for our backend servers.</li>
<li><strong>Expo / React Native:</strong> Application framework and push notification delivery.</li>
</ul>
<p>We do not sell, rent, or share your personal data with third parties for advertising or marketing purposes. We do not use your data for tracking across other apps or websites.</p>

<h2>4. Data Storage & Security</h2>
<p>Your data is stored on secure servers hosted by Render. Authentication tokens are stored on-device using Apple's encrypted Keychain (via expo-secure-store). Passwords are hashed with bcrypt. All API communication uses HTTPS/TLS encryption in transit.</p>

<h2>5. Data Retention & Deletion</h2>
<p>We retain your data for as long as your account is active. You can delete your account at any time from Settings &gt; Account &gt; Delete Account, which permanently and irreversibly removes all your data from our servers within 30 days. Upon deletion, all associated properties, transactions, calendar feeds, and personal information are erased.</p>

<h2>6. Your Rights</h2>
<p>Depending on your jurisdiction, you may have the right to:</p>
<ul>
<li><strong>Access:</strong> Request a copy of the personal data we hold about you</li>
<li><strong>Correction:</strong> Request correction of inaccurate personal data</li>
<li><strong>Deletion:</strong> Delete your account and all associated data via the in-app deletion feature</li>
<li><strong>Portability:</strong> Request your data in a machine-readable format</li>
</ul>
<p>California residents have additional rights under the CCPA/CPRA, including the right to know what data is collected and the right to opt out of sale (we do not sell personal data). EU/EEA residents have rights under GDPR.</p>

<h2>7. Children's Privacy</h2>
<p>The App is not directed to children under 13 (or under 16 in the EU/EEA). We do not knowingly collect personal data from children. If we become aware that we have collected data from a child without parental consent, we will promptly delete it.</p>

<h2>8. International Data Transfers</h2>
<p>Your data may be transferred to and processed in the United States, where our servers are located. By using the App, you consent to this transfer. We take appropriate measures to protect your data in accordance with this Privacy Policy.</p>

<h2>9. Changes to This Policy</h2>
<p>We may update this policy from time to time. We will notify you of material changes via the App or email. Continued use of the App after changes constitutes acceptance of the updated policy.</p>

<h2>10. Contact Us</h2>
<p>If you have questions about this Privacy Policy or wish to exercise your data rights, contact us at <a href="mailto:brandonlbonomo@gmail.com">brandonlbonomo@gmail.com</a>.</p>
</body></html>"""

@app.route("/terms")
def terms_of_service():
    return """<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Terms of Service — Portfolio Pigeon</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:720px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.7}
h1{font-size:28px}h2{font-size:20px;margin-top:32px}p,li{font-size:15px}a{color:#3B82F6}</style></head>
<body>
<h1>Terms of Service</h1>
<p><strong>Last updated:</strong> March 15, 2026</p>
<p>By using Portfolio Pigeon ("the App"), you agree to the following terms. These terms constitute a legally binding agreement between you and Portfolio Pigeon.</p>

<h2>1. Acceptance of Terms</h2>
<p>By creating an account or using the App, you agree to these Terms of Service and our <a href="/privacy">Privacy Policy</a>. If you do not agree, do not use the App.</p>

<h2>2. Description of Service</h2>
<p>Portfolio Pigeon is a property management tool for short-term and long-term rental owners and cleaning professionals. The App provides financial dashboards, calendar management, inventory tracking, invoicing, and related features. The App is provided "as is" and is intended for informational purposes only — it does not provide financial, tax, or legal advice.</p>

<h2>3. Account Responsibilities</h2>
<ul>
<li>You must provide accurate information when creating an account</li>
<li>You are responsible for maintaining the security of your account credentials</li>
<li>You must be at least 18 years old to use the App</li>
<li>One person may not maintain more than one account</li>
<li>You are responsible for all activity that occurs under your account</li>
</ul>

<h2>4. Financial Data Disclaimer</h2>
<p>The App displays financial information from connected bank accounts and user-entered data. This information is for personal reference only and does not constitute financial, tax, or legal advice. You should consult a qualified professional for financial decisions. We are not responsible for the accuracy of data provided by third-party services such as Plaid.</p>

<h2>5. Subscriptions & Auto-Renewable Payments</h2>
<p>Portfolio Pigeon Pro is available as an auto-renewable subscription. The following terms apply:</p>
<ul>
<li>Payment is charged to your Apple ID account at confirmation of purchase</li>
<li>Subscriptions automatically renew unless auto-renew is turned off at least 24 hours before the end of the current period</li>
<li>Your account will be charged for renewal within 24 hours prior to the end of the current period at the same price</li>
<li>You can manage and cancel your subscriptions by going to your Account Settings on the App Store after purchase</li>
<li>Any unused portion of a free trial period, if offered, will be forfeited when you purchase a subscription</li>
</ul>
<p>Subscription prices may vary by region. Current pricing is displayed in the App before purchase. All prices are in your local currency as determined by the App Store.</p>

<h2>6. Free Trial</h2>
<p>We may offer a free trial period for new subscribers. During the free trial, you have full access to Pro features at no charge. If you do not cancel before the trial ends, your subscription will automatically convert to a paid subscription at the displayed price.</p>

<h2>7. Acceptable Use</h2>
<p>You agree not to:</p>
<ul>
<li>Use the App for any unlawful purpose</li>
<li>Attempt to gain unauthorized access to other users' data</li>
<li>Interfere with the App's infrastructure or security</li>
<li>Scrape, harvest, or collect data from other users</li>
<li>Use the App to send spam or unsolicited messages</li>
<li>Reverse-engineer, decompile, or disassemble the App</li>
</ul>

<h2>8. Intellectual Property</h2>
<p>The App, its design, code, and content are owned by Portfolio Pigeon and protected by copyright and intellectual property laws. You are granted a limited, non-exclusive, non-transferable license to use the App for personal, non-commercial purposes. You retain ownership of any data you enter into the App.</p>

<h2>9. Disclaimer of Warranties</h2>
<p>THE APP IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE APP WILL BE UNINTERRUPTED, ERROR-FREE, OR SECURE.</p>

<h2>10. Limitation of Liability</h2>
<p>TO THE MAXIMUM EXTENT PERMITTED BY LAW, PORTFOLIO PIGEON SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES ARISING FROM YOUR USE OF THE APP, INCLUDING BUT NOT LIMITED TO LOSS OF DATA, REVENUE, OR PROFITS. OUR TOTAL LIABILITY SHALL NOT EXCEED THE AMOUNT YOU PAID FOR THE APP IN THE 12 MONTHS PRECEDING THE CLAIM.</p>

<h2>11. Indemnification</h2>
<p>You agree to indemnify and hold harmless Portfolio Pigeon from any claims, damages, losses, or expenses arising from your use of the App or violation of these terms.</p>

<h2>12. Termination</h2>
<p>We reserve the right to suspend or terminate accounts that violate these terms. You may delete your account at any time from Settings. Upon termination, your right to use the App ceases immediately.</p>

<h2>13. Governing Law</h2>
<p>These terms shall be governed by and construed in accordance with the laws of the State of New York, United States, without regard to its conflict of law provisions.</p>

<h2>14. Changes to Terms</h2>
<p>We may modify these terms at any time. We will notify you of material changes via the App. Continued use of the App after changes constitutes acceptance of the updated terms.</p>

<h2>15. Contact</h2>
<p>Questions about these terms? Contact us at <a href="mailto:brandonlbonomo@gmail.com">brandonlbonomo@gmail.com</a>.</p>
</body></html>"""

# ── Link status ───────────────────────────────────────────────
@app.route("/api/link-status")
def link_status():
    store = load_store()
    accounts = [{"item_id": a["item_id"], "name": a.get("name", "Bank Account"),
                  "needs_reauth": a.get("needs_reauth", False)} for a in store["accounts"]]
    return jsonify({"linked": len(store["accounts"]) > 0, "accounts": accounts})

# Alias: frontend calls /api/plaid/accounts
@app.route("/api/plaid/accounts", methods=["GET"])
def plaid_accounts_alias():
    return link_status()

@app.route("/api/plaid/accounts/<item_id>", methods=["DELETE"])
def plaid_accounts_delete_alias(item_id):
    store = load_store()
    store["accounts"] = [a for a in store["accounts"] if a["item_id"] != item_id]
    save_store(store)
    return jsonify({"ok": True})

# ── Batch init — single request for mobile app startup ────────
@app.route("/api/init", methods=["GET"])
def batch_init():
    """Return all data needed for mobile app startup in one request.
    Eliminates 6-8 separate API calls on app launch."""
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Not authenticated"}), 401
    store = load_store()  # Single disk read, cached for this request
    tx_store = store.get("transactions", {})
    tags = store.get("tags", {})
    cat_tags = store.get("category_tags", {})
    # Merge tags into transactions
    txs = []
    for tx in tx_store.values():
        t = dict(tx)
        tid = t.get("id", "")
        if tid in tags:
            t["property_tag"] = tags[tid]
        if tid in cat_tags:
            t["category_tag"] = cat_tags[tid]
        txs.append(t)
    return jsonify({
        "cockpit": None,  # Cockpit requires computation — use /api/cockpit
        "transactions": txs,
        "tags": tags,
        "props": store.get("custom_props", []),
        "inv_groups": store.get("inv_groups", []),
        "settings": store.get("settings", {}),
        "manual_income": store.get("manual_income", {}),
        "linked": len(store["accounts"]) > 0,
        "accounts": [{"item_id": a["item_id"], "name": a.get("name", "Bank Account"),
                       "needs_reauth": a.get("needs_reauth", False)} for a in store["accounts"]],
    })

# ── Create link token ─────────────────────────────────────────
@app.route("/api/create-link-token", methods=["POST"])
def create_link_token():
    store = load_store()
    try:
        kwargs = dict(
            user=LinkTokenCreateRequestUser(client_user_id="pigeon-user"),
            client_name="Portfolio Pigeon",
            products=[Products("transactions")],
            country_codes=[CountryCode("US")],
            language="en",
        )
        if PLAID_WEBHOOK_URL:
            kwargs["webhook"] = PLAID_WEBHOOK_URL
        req = LinkTokenCreateRequest(**kwargs)
        response = plaid_client.link_token_create(req)
        return jsonify({"link_token": response["link_token"]})
    except Exception as e:
        msg, code = _safe_error(e, "Plaid link token")
        return jsonify({"error": msg}), code

@app.route("/api/create-update-token", methods=["POST"])
def create_update_token():
    """Create a Plaid Link token in update mode to fix a broken/expired connection."""
    item_id = (request.json or {}).get("item_id")
    if not item_id:
        return jsonify({"error": "item_id required"}), 400
    store = load_store()
    account = next((a for a in store.get("accounts", []) if a["item_id"] == item_id), None)
    if not account:
        return jsonify({"error": "Account not found"}), 404
    try:
        req = LinkTokenCreateRequest(
            user=LinkTokenCreateRequestUser(client_user_id="pigeon-user"),
            client_name="Portfolio Pigeon",
            access_token=account["access_token"],
            country_codes=[CountryCode("US")],
            language="en",
        )
        response = plaid_client.link_token_create(req)
        return jsonify({"link_token": response["link_token"]})
    except Exception as e:
        msg, code = _safe_error(e, "Plaid update token")
        return jsonify({"error": msg}), code

# ══════════════════════════════════════════════════════════════
# ── Stripe Billing endpoints ─────────────────────────────────
# ══════════════════════════════════════════════════════════════

def _get_user_billing_fields(user_id):
    """Get billing-related fields for a user."""
    users = load_users()
    _, u = _find_user_by_id(users, user_id)
    if u:
        return {
            "stripe_customer_id": u.get("stripe_customer_id"),
            "subscription_id": u.get("subscription_id"),
            "subscription_status": u.get("subscription_status"),
            "subscription_plan": u.get("subscription_plan"),
            "subscription_current_period_end": u.get("subscription_current_period_end"),
            "is_founder": u.get("is_founder", False),
            "lifetime_free": u.get("lifetime_free", False),
        }
    return None

def _update_user_billing(user_id, fields):
    """Update billing fields for a user by user_id."""
    users = load_users()
    email, u = _find_user_by_id(users, user_id)
    if u:
        u.update(fields)
        save_users(users)
        return True
    return False

def _find_user_by_stripe_customer(customer_id):
    """Find user_id by stripe_customer_id."""
    users = load_users()
    for email, u in users.items():
        if u.get("stripe_customer_id") == customer_id:
            return u.get("id"), email
    return None, None

def _is_subscription_active(billing):
    """Check if subscription is active (or user has free access)."""
    if not billing:
        return True  # No billing info = allow access (backwards compat)
    if billing.get("is_founder") or billing.get("lifetime_free"):
        return True
    status = billing.get("subscription_status")
    return status in ("active", "trialing")


@app.route("/api/billing/status", methods=["GET"])
def billing_status():
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Authentication required"}), 401
    billing = _get_user_billing_fields(uid)
    if not billing:
        return jsonify({"error": "User not found"}), 404
    billing["is_active"] = _is_subscription_active(billing)
    return jsonify(billing)


@app.route("/api/billing/create-checkout", methods=["POST"])
def billing_create_checkout():
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Authentication required"}), 401
    if not stripe.api_key:
        return jsonify({"error": "Billing not configured"}), 503

    body = request.get_json(force=True) or {}
    plan = body.get("plan", "pp_pro_monthly")
    price_id = STRIPE_PRODUCTS.get(plan)
    if not price_id:
        return jsonify({"error": f"Unknown plan: {plan}"}), 400

    # Find or create Stripe customer
    billing = _get_user_billing_fields(uid)
    customer_id = billing.get("stripe_customer_id") if billing else None

    # Validate existing customer (may fail if switching live/test mode)
    if customer_id:
        try:
            stripe.Customer.retrieve(customer_id)
        except Exception:
            logger.error("Stored customer %s invalid — creating new one", customer_id)
            customer_id = None

    if not customer_id:
        # Get user email
        users = load_users()
        user_email = None
        for email, u in users.items():
            if u.get("id") == uid:
                user_email = email
                break
        customer = stripe.Customer.create(email=user_email, metadata={"user_id": uid})
        customer_id = customer.id
        _update_user_billing(uid, {"stripe_customer_id": customer_id})

    base_url = os.getenv("APP_BASE_URL", "https://portfoliopigeon.com")
    try:
        session = stripe.checkout.Session.create(
            customer=customer_id,
            payment_method_types=["card"],
            line_items=[{"price": price_id, "quantity": 1}],
            mode="subscription",
            subscription_data={"trial_period_days": 14},
            success_url=f"{base_url}/api/billing/success?session_id={{CHECKOUT_SESSION_ID}}",
            cancel_url=f"{base_url}/api/billing/cancel",
        )
        return jsonify({"checkout_url": session.url, "session_id": session.id})
    except Exception as e:
        msg, code = _safe_error(e, "Checkout")
        return jsonify({"error": msg}), code


@app.route("/api/billing/create-portal", methods=["POST"])
def billing_create_portal():
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Authentication required"}), 401
    if not stripe.api_key:
        return jsonify({"error": "Billing not configured"}), 503

    billing = _get_user_billing_fields(uid)
    customer_id = billing.get("stripe_customer_id") if billing else None
    if not customer_id:
        return jsonify({"error": "No billing account found"}), 404

    base_url = os.getenv("APP_BASE_URL", "https://portfoliopigeon.com")
    try:
        session = stripe.billing_portal.Session.create(
            customer=customer_id,
            return_url=f"{base_url}/api/billing/portal-return",
        )
        return jsonify({"portal_url": session.url})
    except Exception as e:
        msg, code = _safe_error(e, "Billing portal")
        return jsonify({"error": msg}), code


@app.route("/api/billing/verify-session", methods=["POST"])
def billing_verify_session():
    """Verify a checkout session and activate subscription (no webhook dependency)."""
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Authentication required"}), 401
    if not stripe.api_key:
        return jsonify({"error": "Billing not configured"}), 503

    body = request.get_json(force=True) or {}
    session_id = body.get("session_id")
    if not session_id:
        return jsonify({"error": "session_id required"}), 400

    try:
        session = stripe.checkout.Session.retrieve(session_id, expand=["subscription"])

        # Verify this session belongs to the authenticated user
        if session.customer:
            customer_uid, _ = _find_user_by_stripe_customer(
                session.customer if isinstance(session.customer, str) else session.customer.id
            )
            if customer_uid and customer_uid != uid:
                return jsonify({"error": "Session does not belong to this user"}), 403

        # Session is complete if paid or if using a trial (no_payment_required)
        is_complete = (
            session.status == "complete"
            or session.payment_status in ("paid", "no_payment_required")
        )
        if not is_complete:
            billing = _get_user_billing_fields(uid)
            billing["is_active"] = _is_subscription_active(billing) if billing else False
            return jsonify(billing)

        sub = session.subscription
        if sub:
            # Stripe StripeObject supports dict-like access via .get()
            sub_id = sub.id if hasattr(sub, 'id') else (sub.get("id") if isinstance(sub, dict) else str(sub))
            sub_status = sub.status if hasattr(sub, 'status') else (sub.get("status", "active") if isinstance(sub, dict) else "active")
            sub_period_end = sub.current_period_end if hasattr(sub, 'current_period_end') else (sub.get("current_period_end") if isinstance(sub, dict) else None)

            # Determine plan from subscription items
            plan = "unknown"
            items_data = None
            if hasattr(sub, 'items') and sub.items and hasattr(sub.items, 'data'):
                items_data = sub.items.data
            elif isinstance(sub, dict) and sub.get("items", {}).get("data"):
                items_data = sub["items"]["data"]

            if items_data and len(items_data) > 0:
                price = items_data[0]
                if hasattr(price, 'price'):
                    price = price.price
                elif isinstance(price, dict):
                    price = price.get("price", price)
                lk = price.lookup_key if hasattr(price, 'lookup_key') else (price.get("lookup_key") if isinstance(price, dict) else None)
                pid = price.id if hasattr(price, 'id') else (price.get("id", "unknown") if isinstance(price, dict) else "unknown")
                plan = lk or pid

            _update_user_billing(uid, {
                "subscription_id": sub_id,
                "subscription_status": sub_status,
                "subscription_plan": plan,
                "subscription_current_period_end": sub_period_end,
            })
            logger.info("Verified session %s: %s (%s) for user %s", session_id, sub_status, plan, uid)

        billing = _get_user_billing_fields(uid)
        billing["is_active"] = _is_subscription_active(billing)
        return jsonify(billing)
    except Exception as e:
        msg, code = _safe_error(e, "Billing verification")
        return jsonify({"error": msg}), code


@app.route("/api/billing/success")
def billing_success():
    return """<!DOCTYPE html>
<html><head><title>Success</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;
min-height:100vh;margin:0;background:#F2F2F7;color:#111827;text-align:center}
.card{background:#fff;border-radius:20px;padding:40px;max-width:360px;box-shadow:0 4px 20px rgba(0,0,0,0.1)}
h1{font-size:24px;margin:0 0 8px} p{color:#6B7280;font-size:14px;margin:0}</style></head>
<body><div class="card"><h1>You're all set!</h1><p>Your subscription is active. You can close this window.</p></div></body></html>"""


@app.route("/api/billing/cancel")
def billing_cancel():
    return """<!DOCTYPE html>
<html><head><title>Cancelled</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;
min-height:100vh;margin:0;background:#F2F2F7;color:#111827;text-align:center}
.card{background:#fff;border-radius:20px;padding:40px;max-width:360px;box-shadow:0 4px 20px rgba(0,0,0,0.1)}
h1{font-size:24px;margin:0 0 8px} p{color:#6B7280;font-size:14px;margin:0}</style></head>
<body><div class="card"><h1>Checkout cancelled</h1><p>No worries! You can subscribe anytime from Settings.</p></div></body></html>"""


@app.route("/api/billing/portal-return")
def billing_portal_return():
    return """<!DOCTYPE html>
<html><head><title>Done</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;
min-height:100vh;margin:0;background:#F2F2F7;color:#111827;text-align:center}
.card{background:#fff;border-radius:20px;padding:40px;max-width:360px;box-shadow:0 4px 20px rgba(0,0,0,0.1)}
h1{font-size:24px;margin:0 0 8px} p{color:#6B7280;font-size:14px;margin:0}</style></head>
<body><div class="card"><h1>All done</h1><p>Your billing changes have been saved. You can close this window.</p></div></body></html>"""


@app.route("/api/billing/webhook", methods=["POST"])
def billing_webhook():
    payload = request.get_data(as_text=True)
    sig_header = request.headers.get("Stripe-Signature", "")

    if STRIPE_WEBHOOK_SECRET:
        try:
            event = stripe.Webhook.construct_event(payload, sig_header, STRIPE_WEBHOOK_SECRET)
        except ValueError:
            logger.error("Stripe webhook: invalid payload")
            return "Invalid payload", 400
        except stripe.error.SignatureVerificationError:
            logger.error("Stripe webhook: invalid signature")
            return "Invalid signature", 400
    else:
        # No secret configured — reject in production
        if os.getenv("RENDER") or os.getenv("FLASK_ENV") == "production":
            logger.warning("Stripe webhook: STRIPE_WEBHOOK_SECRET not configured")
            return "Webhook secret not configured", 500
        event = json.loads(payload)

    event_type = event.get("type", "")
    data_obj = event.get("data", {}).get("object", {})
    logger.info("Webhook: %s", event_type)

    if event_type in (
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.resumed",
    ):
        customer_id = data_obj.get("customer")
        uid, _ = _find_user_by_stripe_customer(customer_id)
        if uid:
            # Determine plan from price lookup_key
            plan = "unknown"
            items = data_obj.get("items", {}).get("data", [])
            if items:
                price = items[0].get("price", {})
                plan = price.get("lookup_key") or price.get("id", "unknown")

            _update_user_billing(uid, {
                "subscription_id": data_obj.get("id"),
                "subscription_status": data_obj.get("status"),
                "subscription_plan": plan,
                "subscription_current_period_end": data_obj.get("current_period_end"),
            })
            logger.info("Updated subscription for %s: %s (%s)", uid, data_obj.get('status'), plan)

    elif event_type == "customer.subscription.deleted":
        customer_id = data_obj.get("customer")
        uid, _ = _find_user_by_stripe_customer(customer_id)
        if uid:
            _update_user_billing(uid, {
                "subscription_status": "canceled",
                "subscription_current_period_end": data_obj.get("current_period_end"),
            })
            logger.info("Subscription canceled for %s", uid)

    elif event_type == "invoice.payment_succeeded":
        customer_id = data_obj.get("customer")
        uid, _ = _find_user_by_stripe_customer(customer_id)
        if uid:
            _handle_referral_reward(uid)

    elif event_type == "invoice.payment_failed":
        customer_id = data_obj.get("customer")
        uid, _ = _find_user_by_stripe_customer(customer_id)
        if uid:
            _update_user_billing(uid, {"subscription_status": "past_due"})
            logger.error("Payment failed for %s", uid)

    return "ok", 200

# ── Exchange token ────────────────────────────────────────────
@app.route("/api/exchange-token", methods=["POST"])
@rate_limit(10, 60)  # 10 per minute — bank linking
def exchange_token():
    store = load_store()
    body = request.json or {}
    public_token  = body.get("public_token")
    account_name  = body.get("account_name", "Bank Account")
    if not public_token:
        return jsonify({"error": "public_token required"}), 400
    try:
        response = plaid_client.item_public_token_exchange(
            ItemPublicTokenExchangeRequest(public_token=public_token)
        )
        access_token = response["access_token"]
        item_id      = response["item_id"]

        # Check if already linked — keep cursor so Plaid doesn't replay old transactions
        existing = next((a for a in store["accounts"] if a["item_id"] == item_id), None)
        if existing:
            existing["access_token"] = access_token
            existing["name"]         = account_name
            # DO NOT reset cursor — that causes transaction duplication
        else:
            store["accounts"].append({
                "access_token": access_token,
                "item_id":      item_id,
                "cursor":       None,  # None = start from beginning (first link only)
                "name":         account_name,
            })

        save_store(store)

        # ── First 3 Plaid users get lifetime free ──
        uid = getattr(g, 'user_id', None)
        if uid and not existing:  # Only on first-time link (not re-link)
            meta = _load_billing_meta()
            free_users = meta.get("plaid_free_users", [])
            if uid not in free_users and len(free_users) < 3:
                free_users.append(uid)
                meta["plaid_free_users"] = free_users
                _save_billing_meta(meta)
                # Mark user as lifetime free
                users = load_users()
                for email, u in users.items():
                    if u.get("id") == uid:
                        u["lifetime_free"] = True
                        save_users(users)
                        logger.info("User %s gets lifetime free (Plaid early adopter #%s)", uid, len(free_users))
                        break

        logger.info("Linked: %s (%s)", account_name, item_id)
        return jsonify({"ok": True, "item_id": item_id})
    except Exception as e:
        msg, code = _safe_error(e, "Bank account linking")
        return jsonify({"error": msg}), code

# ── Remove account ────────────────────────────────────────────
@app.route("/api/remove-account", methods=["POST"])
def remove_account():
    store = load_store()
    body = request.json or {}
    item_id = body.get("item_id")
    store["accounts"] = [a for a in store["accounts"] if a["item_id"] != item_id]
    save_store(store)
    return jsonify({"ok": True})

# ── Sync core logic (used by route + scheduler) ───────────────
def run_sync():
    """Pull latest transactions from Plaid for all connected accounts.
    Returns a summary dict; raises no exceptions (errors are logged per-account)."""
    store = load_store()
    if not store["accounts"]:
        logger.info("Scheduled sync: no accounts linked, skipping.")
        return {"total_stored": 0, "total": 0}

    tx_store = store.get("transactions", {})
    all_added, all_modified, all_removed_ids = [], [], []

    for account in store["accounts"]:
        name = account.get("name", "Bank Account")
        try:
            added, modified, removed = [], [], []
            cursor   = account.get("cursor")
            has_more = True
            page     = 0

            logger.info("Syncing %s — cursor=%s", name, 'set' if cursor else 'none (full sync)')

            while has_more:
                page += 1
                kwargs = {"access_token": account["access_token"], "count": 500}
                if cursor:
                    kwargs["cursor"] = cursor
                try:
                    response = plaid_client.transactions_sync(TransactionsSyncRequest(**kwargs))
                except Exception as sync_err:
                    err_str = str(sync_err)
                    # If cursor is invalid/expired, reset it and retry as a full sync
                    if cursor and ("INVALID_CURSOR" in err_str or "cursor" in err_str.lower()):
                        logger.error("Invalid cursor for %s — resetting and retrying full sync", name)
                        account["cursor"] = None
                        cursor = None
                        save_store(store)
                        response = plaid_client.transactions_sync(
                            TransactionsSyncRequest(access_token=account["access_token"], count=500)
                        )
                    else:
                        raise
                data          = response.to_dict()
                page_added    = data.get("added",    [])
                page_modified = data.get("modified", [])
                page_removed  = data.get("removed",  [])
                added    += page_added
                modified += page_modified
                removed  += page_removed
                has_more  = data.get("has_more", False)
                cursor    = data.get("next_cursor")
                logger.info("Page %s: +%s added, ~%s modified, -%s removed%s",
                      page, len(page_added), len(page_modified), len(page_removed),
                      ", more..." if has_more else "")

            account["cursor"] = cursor
            logger.info("%s: %s added, %s modified, %s removed | cursor=%s",
                  name, len(added), len(modified), len(removed), "set" if cursor else "none")

            def normalize(tx):
                amount = tx.get("amount", 0)
                return {
                    "id":      tx.get("transaction_id"),
                    "date":    str(tx.get("date", "")),
                    "payee":   tx.get("merchant_name") or tx.get("name", ""),
                    "amount":  amount,
                    "type":    "out" if amount > 0 else "in",
                    "pending": tx.get("pending", False),
                    "account": account.get("name", "Bank Account"),
                }

            for tx in added:
                n = normalize(tx)
                if n["id"]:
                    tx_store[n["id"]] = n   # store pending AND posted
            for tx in modified:
                n = normalize(tx)
                if n["id"]:
                    existing = tx_store.get(n["id"], {})
                    # Preserve all user-edited fields through Plaid sync
                    for ufield, field in [("user_date", "date"), ("user_amount", "amount"),
                                          ("user_name", "name"), ("user_category", "category")]:
                        if existing.get(ufield) is not None:
                            n[field] = existing[ufield]
                            n[ufield] = existing[ufield]
                    tx_store[n["id"]] = n

            # Carry tags forward when pending txs settle (removed + re-added with new ID).
            # Build lookup of removed tagged transactions for matching.
            tags = store.get("tags", {})
            cat_tags = store.get("category_tags", {})
            removed_tagged = []
            for r in removed:
                rid = r.get("transaction_id")
                if rid and rid in tx_store:
                    if rid in tags or rid in cat_tags:
                        removed_tagged.append({
                            "id": rid,
                            "payee": tx_store[rid].get("payee", ""),
                            "amount": tx_store[rid].get("amount", 0),
                            "tag": tags.get(rid),
                            "cat_tag": cat_tags.get(rid),
                        })
                    del tx_store[rid]
                    all_removed_ids.append(rid)

            # Match removed tagged txs to newly added txs by payee+amount
            if removed_tagged:
                for rt in removed_tagged:
                    for a in added:
                        na = normalize(a)
                        if (na["id"]
                                and na["payee"] == rt["payee"]
                                and abs(na["amount"] - rt["amount"]) < 0.01):
                            if rt["tag"] and na["id"] not in tags:
                                tags[na["id"]] = rt["tag"]
                            if rt["cat_tag"] and na["id"] not in cat_tags:
                                cat_tags[na["id"]] = rt["cat_tag"]
                            logger.info("Tags carried forward: %s → %s (%s)",
                                        rt["id"], na["id"], rt["payee"])
                            break
                    # Clean up orphaned tags from removed tx
                    if rt["id"] in tags:
                        del tags[rt["id"]]
                    if rt["id"] in cat_tags:
                        del cat_tags[rt["id"]]
                store["tags"] = tags
                store["category_tags"] = cat_tags

            all_added    += [normalize(t) for t in added]
            all_modified += [normalize(t) for t in modified]

        except Exception as e:
            err_str = str(e)
            if "ITEM_LOGIN_REQUIRED" in err_str:
                account["needs_reauth"] = True
                save_store(store)
                logger.warning("%s: Chase connection expired — re-authentication required (ITEM_LOGIN_REQUIRED)", name)
            else:
                logger.error("Sync error for %s: %s", name, e)
            continue

    store["transactions"] = tx_store

    # ── Auto-tag new transactions using saved rules ──
    rules = store.get("rules", {})
    tags = store.get("tags", {})
    cat_tags = store.get("category_tags", {})
    auto_tagged_count = 0
    if rules:
        # Build case-insensitive lookup: lowercase payee → rule value
        rule_lookup = {}
        for payee_pattern, rule_val in rules.items():
            rule_lookup[payee_pattern.lower().strip()] = {
                "payee": payee_pattern,
                "value": rule_val,
            }

        for tx_id, tx in tx_store.items():
            # Skip already-tagged transactions
            if tx_id in tags or tx_id in cat_tags:
                continue
            payee = (tx.get("payee") or tx.get("name") or "").lower().strip()
            if not payee:
                continue
            # Check for exact match or substring match
            matched_rule = rule_lookup.get(payee)
            if not matched_rule:
                # Try substring matching
                for pattern, rule in rule_lookup.items():
                    if pattern in payee or payee in pattern:
                        matched_rule = rule
                        break
            if matched_rule:
                val = matched_rule["value"]
                # Value can be a property ID or a category tag (starts with __)
                if val.startswith("__"):
                    cat_tags[tx_id] = val
                else:
                    tags[tx_id] = val
                tx_store[tx_id]["auto_tagged"] = True
                auto_tagged_count += 1

        if auto_tagged_count > 0:
            store["tags"] = tags
            store["category_tags"] = cat_tags
            logger.info("Auto-tagged %d transactions from %d rules", auto_tagged_count, len(rules))

    save_store(store)

    # Invalidate caches after sync
    _invalidate_cache("cockpit")
    _invalidate_cache("transactions")

    return {
        "added":         all_added,
        "modified":      all_modified,
        "removed":       all_removed_ids,
        "total":         len(all_added),
        "total_stored":  len(tx_store),
        "needs_reauth":  [a.get("name") for a in store["accounts"] if a.get("needs_reauth")],
    }

# ── Sync all accounts ─────────────────────────────────────────
@app.route("/api/transactions/sync", methods=["GET", "POST"])
@rate_limit(10, 60)  # 10 per minute — expensive Plaid call
def sync_transactions():
    store = load_store()
    if not store["accounts"]:
        return jsonify({"error": "No bank account linked yet"}), 400
    result = run_sync()
    return jsonify(result)

# ── Force Plaid to re-poll the bank ───────────────────────────
# Requires "transactions_refresh" product enabled in Plaid dashboard.
# Tells Plaid to immediately fetch fresh data from the bank, then Plaid
# fires a SYNC_UPDATES_AVAILABLE webhook which triggers run_sync().
@app.route("/api/transactions/refresh", methods=["POST"])
def refresh_transactions():
    store = load_store()
    if not store["accounts"]:
        return jsonify({"error": "No bank account linked yet"}), 400
    results, errors = [], []
    for account in store["accounts"]:
        try:
            plaid_client.transactions_refresh(TransactionsRefreshRequest(
                access_token=account["access_token"]
            ))
            results.append(account.get("name"))
            logger.info("Transactions refresh triggered for %s", account.get('name'))
        except Exception as e:
            msg, _ = _safe_error(e, f"Transactions refresh ({account.get('name')})")
            errors.append(f"{account.get('name')}: {msg}")
    return jsonify({
        "ok":        len(errors) == 0,
        "refreshed": results,
        "errors":    errors,
        "note":      "Plaid will fire SYNC_UPDATES_AVAILABLE webhook within minutes, "
                     "which auto-syncs new transactions.",
    })

# ── Plaid webhook receiver ────────────────────────────────────────────────
# Plaid calls this URL when new transaction data is available.
# Set PLAID_WEBHOOK_URL=https://<your-host>/api/webhook and then call
# /api/update-webhook once to register it on all existing linked items.
#
# Security note: Plaid signs webhooks with a JWT in the Plaid-Verification
# header. Full JWT verification is omitted here; instead we validate that
# the item_id is one we actually own before acting on the payload.
@app.route("/api/webhook", methods=["POST"])
def plaid_webhook():
    data         = request.get_json(silent=True) or {}
    webhook_type = data.get("webhook_type", "")
    webhook_code = data.get("webhook_code", "")
    item_id      = data.get("item_id", "")

    logger.info("Plaid webhook: %s/%s item=%s", webhook_type, webhook_code, item_id)

    # Only act on transaction webhooks
    if webhook_type != "TRANSACTIONS":
        return jsonify({"ok": True, "action": "ignored"})

    SYNC_CODES = {
        "SYNC_UPDATES_AVAILABLE",  # primary code for transactions/sync flow
        "INITIAL_UPDATE",          # fired after a new item is linked
        "HISTORICAL_UPDATE",       # fired when 2-year history is ready
        "DEFAULT_UPDATE",          # new transactions (legacy code, still fired)
        "TRANSACTIONS_REMOVED",    # transactions deleted from Plaid
    }
    if webhook_code not in SYNC_CODES:
        return jsonify({"ok": True, "action": "ignored"})

    # Verify this item_id belongs to an account we actually own
    store = load_store()
    if item_id and not any(a["item_id"] == item_id for a in store["accounts"]):
        logger.warning("Webhook item_id %s not found in store — ignoring", item_id)
        return jsonify({"ok": True, "action": "unknown_item"})

    # Paginate through ALL available updates (run_sync loops has_more automatically)
    try:
        result = run_sync()
        logger.info("Webhook sync done: %s new, %s total stored",
              result.get('total', 0), result.get('total_stored', 0))
        return jsonify({
            "ok":          True,
            "action":      "synced",
            "new":         result.get("total", 0),
            "total_stored": result.get("total_stored", 0),
        })
    except Exception as e:
        msg, code = _safe_error(e, "Webhook sync")
        return jsonify({"error": msg}), code


# ── Register webhook on existing Plaid items ──────────────────────────────
# Call this once after setting PLAID_WEBHOOK_URL to push the URL to every
# already-linked item. New links pick it up automatically via create_link_token.
@app.route("/api/update-webhook", methods=["POST"])
def update_webhook():
    store       = load_store()
    webhook_url = (request.get_json(silent=True) or {}).get("webhook_url") or PLAID_WEBHOOK_URL
    if not webhook_url:
        return jsonify({"error": "webhook_url required (or set PLAID_WEBHOOK_URL env var)"}), 400

    updated, errors = [], []
    for account in store["accounts"]:
        try:
            plaid_client.item_webhook_update(
                ItemWebhookUpdateRequest(
                    access_token=account["access_token"],
                    webhook=webhook_url,
                )
            )
            updated.append(account.get("name", account["item_id"]))
            logger.info("Webhook registered for %s: %s", account.get('name'), webhook_url)
        except Exception as e:
            msg, _ = _safe_error(e, f"Webhook update ({account.get('name')})")
            errors.append(f"{account.get('name')}: {msg}")

    return jsonify({"ok": True, "webhook_url": webhook_url, "updated": updated, "errors": errors})


# ── Historical pull — fetches up to 2 years back via transactions/get ────
# Call this once after linking a new account to backfill history.
# transactions/sync alone only returns ~90 days on first call.
@app.route("/api/transactions/historical", methods=["POST"])
@app.route("/api/plaid/history", methods=["POST"])
@rate_limit(3, 300)  # 3 per 5 min — very heavy Plaid call
def historical_pull():
    store = load_store()
    body = request.json or {}
    item_id = body.get("item_id")  # optional: pull for specific account only
    if not store["accounts"]:
        return jsonify({"error": "No accounts linked"}), 400

    from datetime import date
    # Request all available history — Plaid will return whatever it has
    # (typically up to 24 months in production; sandbox may vary).
    start_date = date(2000, 1, 1)
    end_date   = date.today()

    tx_store = store.get("transactions", {})
    total_added = 0
    errors = []

    accounts_to_pull = [a for a in store["accounts"] if not item_id or a["item_id"] == item_id]

    MAX_HISTORY_PAGES = 50  # 50 pages × 500 txns = 25,000 max
    for account in accounts_to_pull:
        try:
            offset = 0
            batch_size = 500
            pages = 0
            while True:
                options = TransactionsGetRequestOptions(
                    count=batch_size,
                    offset=offset,
                    include_personal_finance_category=True
                )
                req = TransactionsGetRequest(
                    access_token=account["access_token"],
                    start_date=start_date,
                    end_date=end_date,
                    options=options
                )
                response = plaid_client.transactions_get(req)
                data = response.to_dict()
                txs  = data.get("transactions", [])
                total_txs = data.get("total_transactions", 0)

                for tx in txs:
                    tid    = tx.get("transaction_id")
                    amount = tx.get("amount", 0)
                    if not tid:
                        continue
                    tx_store[tid] = {
                        "id":      tid,
                        "date":    str(tx.get("date", "")),
                        "payee":   tx.get("merchant_name") or tx.get("name", ""),
                        "amount":  amount,
                        "type":    "out" if amount > 0 else "in",
                        "pending": tx.get("pending", False),
                        "account": account.get("name", "Bank Account"),
                    }
                    total_added += 1

                offset += len(txs)
                pages += 1
                if offset >= total_txs or not txs or pages >= MAX_HISTORY_PAGES:
                    break

            logger.info("Historical pull: %s — %s transactions fetched", account.get('name'), offset)

        except Exception as e:
            msg, _ = _safe_error(e, f"Historical pull ({account.get('name')})")
            errors.append(f"{account.get('name')}: {msg}")

    store["transactions"] = tx_store
    save_store(store)
    return jsonify({
        "ok": True,
        "total_stored": len(tx_store),
        "pulled": total_added,
        "errors": errors,
    })

# ── Delete transactions (bulk) ───────────────────────────────
@app.route("/api/transactions/delete", methods=["POST"])
def delete_transactions():
    store = load_store()
    body = request.json or {}
    ids = body.get("ids", [])
    tx_store = store.get("transactions", {})
    if ids == "__ALL__":
        deleted = len(tx_store)
        store["transactions"] = {}
    else:
        deleted = 0
        for tid in ids:
            if tid in tx_store:
                del tx_store[tid]
                deleted += 1
        store["transactions"] = tx_store
    save_store(store)
    return jsonify({"ok": True, "deleted": deleted})

# ── POST /api/transactions/update ─────────────────────────────
@app.route("/api/transactions/update", methods=["POST"])
def update_transaction():
    """Update user-editable fields on a stored transaction (e.g. date override)."""
    body  = request.json or {}
    tx_id = body.get("id")
    store    = load_store()
    tx_store = store.get("transactions", {})
    if tx_id not in tx_store:
        return jsonify({"ok": False, "error": "Transaction not found"}), 404
    if "date" in body and body["date"]:
        tx_store[tx_id]["date"]      = body["date"]
        tx_store[tx_id]["user_date"] = body["date"]  # survives future Plaid sync
        logger.info("Transaction %s: date overridden to %s", tx_id, body['date'])
    if "amount" in body and body["amount"] is not None:
        tx_store[tx_id]["amount"]      = float(body["amount"])
        tx_store[tx_id]["user_amount"] = float(body["amount"])
    if "name" in body and body["name"] is not None:
        tx_store[tx_id]["name"]      = body["name"]
        tx_store[tx_id]["user_name"] = body["name"]
    if "category" in body and body["category"] is not None:
        tx_store[tx_id]["category"]      = body["category"]
        tx_store[tx_id]["user_category"] = body["category"]
    # Tag (property assignment) — stored in tags dict
    if "property_tag" in body:
        tags = store.get("tags", {})
        if body["property_tag"]:
            tags[tx_id] = body["property_tag"]
        elif tx_id in tags:
            del tags[tx_id]
        store["tags"] = tags
    store["transactions"] = tx_store
    save_store(store)
    # Invalidate caches so the next GET returns fresh data with the tag
    uid = getattr(g, 'user_id', None)
    _invalidate_cache("transactions", uid)
    _invalidate_cache("tags", uid)
    _invalidate_cache("cockpit", uid)
    return jsonify({"ok": True})


# ── POST /api/transactions/csv ─────────────────────────────────
@app.route("/api/transactions/csv", methods=["POST"])
@rate_limit(10, 60)  # 10 per minute — CSV import
def import_csv():
    """Import transactions from a parsed Chase CSV export.
    Expects JSON: {rows: [{date, payee, amount, type?}]}
    Chase CSV amounts: negative = debit (money out), positive = credit (money in).
    """
    body  = request.json or {}
    rows  = body.get("rows", [])
    if len(rows) > 50000:
        return jsonify({"ok": False, "error": "Too many rows (max 50,000)"}), 400
    store    = load_store()
    tx_store = store.get("transactions", {})
    added = 0
    for row in rows:
        raw_amount = float(row.get("amount", 0))
        # Chase CSV: negative = charge (out), positive = deposit (in)
        tx_type = "in" if raw_amount > 0 else "out"
        amount  = abs(raw_amount)
        date    = (row.get("date") or "").strip()
        payee   = (row.get("payee") or "").strip()
        # Stable dedup key from date + payee + amount
        key_str = f"csv-{date}-{payee[:30]}-{raw_amount}".lower()
        txid    = re.sub(r"[^a-z0-9\-]", "-", key_str)[:80]
        if txid in tx_store:
            continue
        tx_store[txid] = {
            "id":      txid,
            "date":    date,
            "payee":   payee,
            "amount":  amount,
            "type":    tx_type,
            "pending": False,
            "account": row.get("account", "Chase CSV"),
            "source":  "csv",
        }
        added += 1
    store["transactions"] = tx_store
    save_store(store)
    logger.info("CSV import: %s new transactions added (%s total)", added, len(tx_store))
    return jsonify({"ok": True, "added": added, "total": len(tx_store)})


@app.route("/api/transactions/manual", methods=["POST"])
def manual_transaction():
    """Add a manual expense transaction (not from Plaid)."""
    import time as _time
    body = request.json or {}
    amt = body.get("amount")
    date = body.get("date")
    prop_id = body.get("prop_id", "llc")
    if not amt or not date:
        return jsonify({"ok": False, "error": "amount and date required"}), 400
    try:
        amt_float = float(amt)
    except (ValueError, TypeError):
        return jsonify({"ok": False, "error": "Invalid amount"}), 400
    if abs(amt_float) > 10_000_000:
        return jsonify({"ok": False, "error": "Amount exceeds maximum allowed value"}), 400
    tx = {
        "id":      f"manual-{date}-{int(float(amt)*100)}-{int(_time.time())}",
        "date":    date,
        "payee":   body.get("description", "Manual entry"),
        "amount":  abs(float(amt)),
        "type":    "out",
        "pending": False,
        "account": "Manual",
        "source":  "manual",
    }
    store = load_store()
    store.setdefault("transactions", {})[tx["id"]] = tx
    store.setdefault("tags", {})[tx["id"]] = prop_id
    save_store(store)
    return jsonify({"ok": True, "tx": tx})


_last_csv_debug = {}  # kept for CSV importer debug logging


@app.route("/api/import/csv", methods=["POST"])


def import_csv_universal():
    """
    Universal CSV importer.
    Accepts raw CSV text, auto-detects type (PriceLabs bookings, Chase transactions,
    Airbnb reservations), parses, and stores the data.
    Body: {"csv": "<raw csv text>"}
    """
    import csv as _csv, io as _io
    body    = request.json or {}
    raw_csv = body.get("csv", "")
    if not raw_csv:
        return jsonify({"error": "No CSV data provided"}), 400
    # Phase 4: CSV size guards
    if len(raw_csv) > 5 * 1024 * 1024:
        return jsonify({"error": "CSV too large (max 5 MB)"}), 413

    reader = _csv.reader(_io.StringIO(raw_csv))
    rows   = list(reader)
    if len(rows) < 2:
        return jsonify({"error": "CSV has no data rows"}), 400
    if len(rows) > 50000:
        return jsonify({"error": "CSV too many rows (max 50,000)"}), 413

    # Auto-detect header row — Excel reports often have title/blank rows before headers.
    # Scan first 8 rows; pick the first that has 3+ non-empty cells and scores >= 2.
    header_row_idx = 0
    detected = 'unknown'
    for i, row in enumerate(rows[:8]):
        non_empty = [c for c in row if c.strip()]
        if len(non_empty) >= 3:
            t = _detect_csv_type(row)
            if t != 'unknown':
                header_row_idx = i
                detected = t
                break
    # If still unknown, fall back to row 0 and detect best-effort
    if detected == 'unknown':
        # Try each of the first 8 rows anyway, pick highest-scoring
        best_score, best_idx = -1, 0
        for i, row in enumerate(rows[:8]):
            if len([c for c in row if c.strip()]) >= 3:
                t = _detect_csv_type(row)
                # Score by non-empty cell count as proxy
                s = len([c for c in row if c.strip()])
                if s > best_score:
                    best_score = s
                    best_idx = i
        header_row_idx = best_idx
        detected = _detect_csv_type(rows[best_idx])

    headers   = rows[header_row_idx]
    data_rows = rows[header_row_idx + 1:]

    # Store debug info for /api/debug/csv-last
    _last_csv_debug.clear()
    _last_csv_debug.update({
        "header_row_idx": header_row_idx,
        "detected":       detected,
        "headers":        headers,
        "first_data_rows": [list(r) for r in data_rows[:5]],
        "raw_first_8_rows": [list(r) for r in rows[:8]],
    })
    logger.info("[CSV IMPORT] header_row_idx=%s, detected=%s", header_row_idx, detected)
    logger.info("[CSV IMPORT] headers=%s", headers[:8])
    logger.info("[CSV IMPORT] first data row=%s", data_rows[0][:5] if data_rows else 'EMPTY')

    # ── PriceLabs Revenue on the Books (monthly summary) ────────
    if detected == 'pricelabs_revenue_monthly':
        rows_parsed = _parse_pl_revenue_monthly_csv(headers, data_rows)
        if not rows_parsed:
            return jsonify({"error": "Parsed 0 rows — check that the file has a month column and a Rental Revenue column"}), 422
        store   = load_store()
        monthly = store.get("pl_monthly_revenue", {})
        # Merge: keyed by "YYYY-MM" (or "prop_id:YYYY-MM" if listing present)
        added = 0
        for r in rows_parsed:
            key = f"{r['prop_id']}:{r['month']}" if r['prop_id'] else r['month']
            if key not in monthly:
                added += 1
            monthly[key] = round((monthly.get(key) or 0) + r['rental_revenue'], 2) \
                if key in monthly and r.get('prop_id') else r['rental_revenue']
        store["pl_monthly_revenue"] = monthly
        save_store(store)
        months_hit = sorted({r['month'] for r in rows_parsed})
        props_hit  = sorted({r['prop_id'] for r in rows_parsed if r['prop_id']})
        unmatched  = sorted({r.get('listing_name','') for r in rows_parsed if not r['prop_id'] and r.get('listing_name')})
        props_matched = [{"listing_name": r.get('listing_name',''), "prop_id": r['prop_id']}
                         for r in rows_parsed if r['prop_id']]
        # Deduplicate matched by prop_id
        seen_ids = set()
        props_matched_dedup = []
        for pm in props_matched:
            if pm['prop_id'] not in seen_ids:
                seen_ids.add(pm['prop_id'])
                props_matched_dedup.append(pm)
        logger.info("PriceLabs Revenue CSV: %s monthly rows, months %s–%s", len(rows_parsed), months_hit[0], months_hit[-1])
        return jsonify({
            "detected_type":      "pricelabs_revenue_monthly",
            "imported":           len(rows_parsed),
            "months":             months_hit,
            "properties":         props_hit,
            "properties_matched": props_matched_dedup,
            "unmatched":          unmatched,
            "summary":            f"Imported {len(rows_parsed)} months of revenue data ({months_hit[0]} – {months_hit[-1]})",
        })

    # ── PriceLabs bookings ──────────────────────────────────────
    if detected == 'pricelabs_bookings':
        bookings, parse_dbg = _parse_pl_bookings_csv(headers, data_rows)
        store    = load_store()
        existing = store.get("pl_bookings", [])
        exist_keys = {(b['listing_name'], b['check_in']) for b in existing}
        new_bk   = [b for b in bookings if (b['listing_name'], b['check_in']) not in exist_keys]
        store["pl_bookings"] = existing + new_bk
        save_store(store)
        # Persist parse debug so /api/debug/csv-last shows it
        _last_csv_debug.update({"parse_debug": parse_dbg})
        logger.warning("PriceLabs CSV: %s new bookings (skipped %s dupes)", len(new_bk), len(bookings)-len(new_bk))
        props_hit = list({b['prop_id'] for b in new_bk if b['prop_id']})
        unmatched_names = sorted({b['listing_name'] for b in new_bk if not b['prop_id']})
        # Build properties_matched: one entry per unique prop_id with sample listing_name
        seen_pm = {}
        for b in new_bk:
            if b['prop_id'] and b['prop_id'] not in seen_pm:
                seen_pm[b['prop_id']] = {"listing_name": b['listing_name'], "prop_id": b['prop_id']}
        props_matched = list(seen_pm.values())
        months_hit = sorted({b['check_in'][:7] for b in new_bk if b.get('check_in') and len(b['check_in']) >= 7})
        resp = {
            "detected_type":      "pricelabs_bookings",
            "imported":           len(new_bk),
            "skipped_dupes":      len(bookings) - len(new_bk),
            "total_stored":       len(store["pl_bookings"]),
            "properties":         props_hit,
            "properties_matched": props_matched,
            "unmatched":          unmatched_names,
            "months":             months_hit,
            "summary":            f"Imported {len(new_bk)} reservations across {len(props_hit)} properties",
        }
        if len(new_bk) == 0:
            skips = parse_dbg.get("skip_counts", {})
            col_map = parse_dbg.get("col_map", {})
            missing_cols = [k for k, v in col_map.items() if v < 0 and k in ('listing','check_in')]
            resp["why_zero"] = {
                "skip_counts":   skips,
                "missing_cols":  missing_cols,
                "headers_found": parse_dbg.get("headers_raw", []),
                "hint": "Check server logs for full column map",
            }
            if missing_cols:
                resp["summary"] = f"0 imported — columns not found: {', '.join(missing_cols)}. Headers seen: {parse_dbg.get('headers_raw',[])[:8]}"
            elif skips.get("no_checkin", 0) > 0:
                resp["summary"] = f"0 imported — check-in dates could not be parsed ({skips['no_checkin']} rows)"
            elif skips.get("cancelled", 0) > 0:
                resp["summary"] = f"0 imported — all {skips['cancelled']} rows appear cancelled"
        return jsonify(resp)

    # ── Chase bank CSV ──────────────────────────────────────────
    elif detected == 'chase_transactions':
        h        = [_re.sub(r'[\s\-]+', '_', hdr.strip().lower()) for hdr in headers]
        date_idx = next((i for i,v in enumerate(h) if 'transaction_date' in v or v == 'date'), -1)
        desc_idx = next((i for i,v in enumerate(h) if 'description' in v or v == 'payee'), -1)
        amt_idx  = next((i for i,v in enumerate(h) if 'amount' in v), -1)
        store    = load_store()
        tx_store = store.get("transactions", {})
        added    = 0
        for row in data_rows:
            try:
                raw_amount = float((row[amt_idx] if amt_idx >= 0 and amt_idx < len(row) else '0').strip())
            except ValueError:
                continue
            date  = (row[date_idx].strip() if date_idx >= 0 and date_idx < len(row) else '')
            payee = (row[desc_idx].strip() if desc_idx >= 0 and desc_idx < len(row) else '')
            if not date or not payee:
                continue
            key_str = f"csv-{date}-{payee[:30]}-{raw_amount}".lower()
            txid    = _re.sub(r"[^a-z0-9\-]", "-", key_str)[:80]
            if txid in tx_store:
                continue
            tx_store[txid] = {
                "id": txid, "date": date, "payee": payee,
                "amount": abs(raw_amount), "type": "in" if raw_amount > 0 else "out",
                "pending": False, "account": "Chase CSV", "source": "csv",
            }
            added += 1
        store["transactions"] = tx_store
        save_store(store)
        logger.info("Chase CSV: %s new transactions", added)
        return jsonify({
            "detected_type": "chase_transactions",
            "imported": added,
            "summary":  f"Imported {added} Chase transactions",
        })

    # ── Airbnb reservation CSV ──────────────────────────────────
    elif detected == 'airbnb_reservations':
        bookings, parse_dbg = _parse_pl_bookings_csv(headers, data_rows)  # same parser works
        store    = load_store()
        existing = store.get("pl_bookings", [])
        exist_keys = {(b['listing_name'], b['check_in']) for b in existing}
        new_bk   = [b for b in bookings if (b['listing_name'], b['check_in']) not in exist_keys]
        store["pl_bookings"] = existing + new_bk
        save_store(store)
        _last_csv_debug.update({"parse_debug": parse_dbg})
        props_hit = list({b['prop_id'] for b in new_bk if b['prop_id']})
        return jsonify({
            "detected_type": "airbnb_reservations",
            "imported":      len(new_bk),
            "skipped_dupes": len(bookings) - len(new_bk),
            "total_stored":  len(store["pl_bookings"]),
            "properties":    props_hit,
            "summary":       f"Imported {len(new_bk)} Airbnb reservations",
        })

    # ── Unknown ─────────────────────────────────────────────────
    else:
        # Return first 8 rows so we can debug what SheetJS extracted
        first_rows = [[c for c in r if c.strip()] for r in rows[:8]]
        return jsonify({
            "detected_type":  "unknown",
            "headers_found":  headers[:12],
            "header_row_idx": header_row_idx,
            "first_rows":     first_rows,
            "error": "Could not identify CSV format. Check server logs for raw content.",
        }), 422


@app.route("/api/pl-bookings")
def get_pl_bookings():
    """Legacy stub — PriceLabs bookings removed. Returns empty."""
    return jsonify({"bookings": [], "count": 0})


# ── Get all stored transactions (called on page load) ─────────
@app.route("/api/transactions/all")
@app.route("/api/transactions")
def get_all_transactions():
    uid = getattr(g, 'user_id', None)
    # Support server-side month filtering
    month_filter = request.args.get("month", "")
    cache_key = f"transactions:{month_filter}" if month_filter else "transactions"
    cached = _get_cached_response(cache_key, uid, 30) if uid else None
    if cached is not None:
        return jsonify(cached)
    store = load_store()
    tx_store = store.get("transactions", {})
    tags = store.get("tags", {})
    cat_tags = store.get("category_tags", {})

    # Clean orphaned tags: remove tags pointing to properties that no longer exist
    valid_props = set(_get_str_properties())
    if valid_props:
        orphan_tag_ids = [tid for tid, pid in tags.items()
                          if pid and not pid.startswith("__") and pid not in valid_props]
        if orphan_tag_ids:
            for tid in orphan_tag_ids:
                del tags[tid]
            store["tags"] = tags
            save_store(store)
            logger.info("Auto-cleaned %d orphaned property tags", len(orphan_tag_ids))

    # Merge property_tag and category_tag into each transaction so mobile has it
    txs = []
    for tx in tx_store.values():
        t = dict(tx)
        tid = t.get("id", "")
        if tid in tags:
            t["property_tag"] = tags[tid]
        if tid in cat_tags:
            t["category_tag"] = cat_tags[tid]
        # Server-side month filter
        if month_filter and not (t.get("date", "") or "").startswith(month_filter):
            continue
        txs.append(t)
    result = {"transactions": txs}
    if uid:
        _set_cached_response(cache_key, uid, result)
    return jsonify(result)

# ── Tags ──────────────────────────────────────────────────────
@app.route("/api/props", methods=["GET"])
def get_props():
    uid = getattr(g, 'user_id', None)
    cached = _get_cached_response("props", uid, 30) if uid else None
    if cached is not None:
        return jsonify(cached)
    store = load_store()
    # Only return props that exist in the user's properties list (single source of truth)
    valid_ids = set()
    for p in store.get("properties", []):
        pid = p.get("id") or p.get("name")
        if pid:
            valid_ids.add(pid)
    custom = store.get("custom_props", [])
    if valid_ids:
        # Filter to only valid properties — no orphaned names leak through
        filtered = [p for p in custom if (p.get("id") or p.get("name")) in valid_ids]
    else:
        filtered = custom  # No properties key yet — return all (backward compat)
    result = {"props": filtered}
    if uid:
        _set_cached_response("props", uid, result)
    return jsonify(result)

@app.route("/api/props", methods=["POST"])
def save_props():
    store = load_store()
    props_data = request.json.get("props", [])
    # Safety: never overwrite existing properties with an empty array
    # This prevents accidental wipes from login or app restarts
    existing = store.get("properties", []) or store.get("custom_props", [])
    if not props_data and existing:
        logger.warning("Blocked attempt to overwrite %d properties with empty array", len(existing))
        return jsonify({"ok": True, "blocked": True})
    store["custom_props"] = props_data
    store["properties"] = props_data  # Keep both keys in sync
    save_store(store)
    _invalidate_cache("props", getattr(g, 'user_id', None))
    return jsonify({"ok": True})

@app.route("/api/props/<prop_id>", methods=["DELETE"])
def delete_property_cascade(prop_id):
    """Delete a property and cascade-remove ALL associated data:
    transaction tags, category tags, inventory groups, merchant memory,
    and manual income."""
    store = load_store()
    uid = getattr(g, 'user_id', None)

    # 1. Remove property from custom_props
    props = store.get("custom_props", [])
    store["custom_props"] = [p for p in props if (p.get("id") or p.get("name")) != prop_id]

    # 2. Remove transaction tags (property_tag) pointing to this property
    tags = store.get("tags", {})
    tag_keys_to_remove = [tid for tid, pid in tags.items() if pid == prop_id]
    for tid in tag_keys_to_remove:
        del tags[tid]
    store["tags"] = tags

    # 3. Remove category tags for transactions that were tagged to this property
    # (category tags are per-transaction, not per-property, so keep them)

    # 4. Remove inventory groups linked to this property
    inv_groups = store.get("inv_groups", [])
    store["inv_groups"] = [g for g in inv_groups if g.get("propertyId") != prop_id]
    inv_removed = len(inv_groups) - len(store["inv_groups"])

    # 5. Remove merchant memory entries mapping to this property
    merchant_mem = store.get("merchant_memory", {})
    store["merchant_memory"] = {k: v for k, v in merchant_mem.items() if v != prop_id}

    # 6. Remove manual income entries for this property
    manual_income = store.get("manual_income", {})
    if prop_id in manual_income:
        del manual_income[prop_id]
    store["manual_income"] = manual_income

    # 7. Remove iCal events for this property
    ical_events = store.get("ical_events", [])
    store["ical_events"] = [e for e in ical_events if e.get("prop_id") != prop_id]

    save_store(store)

    # Invalidate all caches
    for cache_key in ["props", "tags", "transactions", "cockpit"]:
        _invalidate_cache(cache_key, uid)

    logger.info("Cascade delete property %s: tags=%d, inv=%d",
                prop_id, len(tag_keys_to_remove), inv_removed)

    return jsonify({
        "ok": True,
        "deleted": {
            "tags": len(tag_keys_to_remove),
            "inv_groups": inv_removed,
        },
    })


@app.route("/api/tags", methods=["GET"])
def get_tags():
    uid = getattr(g, 'user_id', None)
    cached = _get_cached_response("tags", uid, 30) if uid else None
    if cached is not None:
        return jsonify(cached)
    store = load_store()
    result = {"tags": store.get("tags", {})}
    if uid:
        _set_cached_response("tags", uid, result)
    return jsonify(result)

@app.route("/api/tags", methods=["POST"])
def save_tags():
    store = load_store()
    store["tags"] = request.json.get("tags", {})
    save_store(store)
    uid = getattr(g, 'user_id', None)
    _invalidate_cache("tags", uid)
    _invalidate_cache("transactions", uid)  # tags affect transaction display
    return jsonify({"ok": True})

# ── Category Tags (per-transaction category classification) ────
@app.route("/api/category-tags", methods=["GET"])
def get_category_tags():
    store = load_store()
    return jsonify({"category_tags": store.get("category_tags", {})})

@app.route("/api/category-tags", methods=["POST"])
def save_category_tag():
    body = request.json or {}
    tx_id = body.get("id")
    category = body.get("category")
    if not tx_id:
        return jsonify({"ok": False, "error": "Missing transaction id"}), 400
    store = load_store()
    cat_tags = store.get("category_tags", {})
    if category:
        cat_tags[tx_id] = category
    elif tx_id in cat_tags:
        del cat_tags[tx_id]
    store["category_tags"] = cat_tags
    save_store(store)
    uid = getattr(g, 'user_id', None)
    _invalidate_cache("cockpit", uid)  # category tags affect financial calculations
    _invalidate_cache("transactions", uid)  # category_tag is merged into transaction objects
    return jsonify({"ok": True})

# ── Merchant Memory (payee → property auto-mapping) ───────────
@app.route("/api/merchant-memory", methods=["GET"])
def get_merchant_memory():
    store = load_store()
    return jsonify({"merchant_memory": store.get("merchant_memory", {})})

@app.route("/api/merchant-memory", methods=["POST"])
def save_merchant_memory():
    body = request.json or {}
    payee = body.get("payee", "").lower().strip()
    prop_id = body.get("property_id")
    if not payee:
        return jsonify({"ok": False, "error": "Missing payee"}), 400
    store = load_store()
    mem = store.get("merchant_memory", {})
    if prop_id:
        mem[payee] = prop_id
    elif payee in mem:
        del mem[payee]
    store["merchant_memory"] = mem
    save_store(store)
    return jsonify({"ok": True})

# ── Manual Income ──────────────────────────────────────────────
@app.route("/api/manual-income", methods=["GET"])
def get_manual_income():
    store = load_store()
    return jsonify({"manual": store.get("manual_income", {})})

@app.route("/api/manual-income", methods=["POST"])
@app.route("/api/income/manual", methods=["POST"])
def save_manual_income():
    store = load_store()
    store["manual_income"] = request.json.get("manual", {})
    save_store(store)
    return jsonify({"ok": True})

@app.route("/api/manual-pierce", methods=["GET"])
def get_manual_pierce():
    store = load_store()
    return jsonify({"manual": store.get("manual_pierce", {})})

@app.route("/api/manual-pierce", methods=["POST"])
def save_manual_pierce():
    store = load_store()
    store["manual_pierce"] = request.json.get("manual", {})
    save_store(store)
    return jsonify({"ok": True})

# ── Inventory groups ──────────────────────────────────────────
@app.route("/api/inv-groups", methods=["GET","POST"])
def inv_groups_api():
    store = load_store()
    if request.method == "POST":
        body = request.get_json(force=True) or {}
        # Support individual group creation: { name: "..." }
        if "name" in body and "groups" not in body:
            groups = store.get("inv_groups", [])
            new_group = {
                "id": "ig_" + secrets.token_hex(6),
                "name": body["name"],
                "linkType": body.get("linkType"),        # "city" | "property"
                "propertyId": body.get("propertyId"),    # property ID when linkType=property
                "city": body.get("city"),                # city string when linkType=city
                "items": [],
            }
            groups.append(new_group)
            store["inv_groups"] = groups
            save_store(store)
            return jsonify({"ok": True, "group": new_group})
        # Legacy: full replacement
        store["inv_groups"] = body.get("groups", [])
        save_store(store)
        return jsonify({"ok": True})
    return jsonify({"groups": store.get("inv_groups", [])})

@app.route("/api/inv-groups/<group_id>", methods=["DELETE"])
def inv_group_delete(group_id):
    store = load_store()
    groups = store.get("inv_groups", [])
    store["inv_groups"] = [g for g in groups if g.get("id") != group_id]
    save_store(store)
    return jsonify({"ok": True})

@app.route("/api/inv-groups/<group_id>/items", methods=["POST"])
def inv_group_add_item(group_id):
    store = load_store()
    groups = store.get("inv_groups", [])
    body = request.get_json(force=True) or {}
    for g in groups:
        if g.get("id") == group_id:
            import datetime as _dt
            item = {
                "id": "ii_" + secrets.token_hex(6),
                "name": body.get("name", "Item"),
                "unit": body.get("unit", ""),
                "initialQty": body.get("initialQty", 0),
                "perStay": body.get("perStay", 0),
                "threshold": body.get("threshold", 5),
                "category": body.get("category"),            # catalog category key
                "catalogName": body.get("catalogName"),       # original catalog item name
                "isCleanerOnly": body.get("isCleanerOnly", False),
                "createdAt": body.get("createdAt") or _dt.datetime.utcnow().isoformat() + "Z",
                "restocks": [],
            }
            g.setdefault("items", []).append(item)
            store["inv_groups"] = groups
            save_store(store)
            return jsonify({"ok": True, "item": item})
    return jsonify({"error": "Group not found"}), 404

@app.route("/api/inventory/update", methods=["POST"])
def inventory_update_qty():
    store = load_store()
    body = request.get_json(force=True) or {}
    item_id = body.get("itemId", "")
    new_qty = body.get("quantity", 0)
    groups = store.get("inv_groups", [])
    for g in groups:
        for item in g.get("items", []):
            if item.get("id") == item_id:
                added = new_qty - item.get("initialQty", 0)
                restocks = item.get("restocks", [])
                # Record as a restock
                restocks.append({
                    "qty": max(0, added),
                    "date": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()),
                })
                item["restocks"] = restocks
                item["initialQty"] = new_qty
                store["inv_groups"] = groups
                save_store(store)
                return jsonify({"ok": True})
    return jsonify({"error": "Item not found"}), 404

# ── Investment amounts ─────────────────────────────────────────
@app.route("/api/invest", methods=["GET","POST"])
def invest_api():
    store = load_store()
    if request.method == "POST":
        store["invest"] = request.json.get("invest", {})
        save_store(store)
        return jsonify({"ok": True})
    return jsonify({"invest": store.get("invest", {})})

# ── Tag history (auto-rule frequency counts) ──────────────────
@app.route("/api/tag-history", methods=["GET","POST"])
def tag_history_api():
    store = load_store()
    if request.method == "POST":
        store["tag_history"] = request.json.get("history", {})
        save_store(store)
        return jsonify({"ok": True})
    return jsonify({"history": store.get("tag_history", {})})

# ── Balances ──────────────────────────────────────────────────
@app.route("/api/balances")
def balances():
    store = load_store()
    if not store["accounts"]:
        return jsonify({"error": "No bank account linked yet"}), 400
    all_accounts = []
    for account in store["accounts"]:
        try:
            response = plaid_client.accounts_balance_get(
                AccountsBalanceGetRequest(access_token=account["access_token"])
            )
            for a in response["accounts"]:
                all_accounts.append({
                    "bank":      account.get("name", "Bank Account"),
                    "name":      a["name"],
                    "type":      str(a["type"]),
                    "current":   a["balances"]["current"],
                    "available": a["balances"].get("available"),
                    "currency":  a["balances"].get("iso_currency_code", "USD"),
                })
        except Exception as e:
            logger.error("Balance error for %s: %s", account.get('name'), e)
    return jsonify({"accounts": all_accounts})

@app.route("/api/rules", methods=["GET"])
def get_rules():
    store = load_store()
    return jsonify({"rules": store.get("rules", {})})

@app.route("/api/rules", methods=["POST"])
def save_rules():
    store = load_store()
    store["rules"] = request.json.get("rules", {})
    save_store(store)
    return jsonify({"ok": True})

@app.route("/api/settings", methods=["GET"])
def get_settings():
    store = load_store()
    return jsonify({"settings": store.get("settings", {})})

@app.route("/api/settings", methods=["POST"])
def save_settings():
    store = load_store()
    store["settings"] = request.json.get("settings", {})
    save_store(store)
    return jsonify({"ok": True})


# ── GET /api/inventory ───────────────────────────────────────
@app.route("/api/inventory")
def get_inventory():
    store = load_store()
    items = list(store.get("inventory", {}).values())
    items.sort(key=lambda x: x.get("date") or "", reverse=True)
    return jsonify({"inventory": items, "total": len(items)})


# ── POST /api/inventory ──────────────────────────────────────
# Add a manual inventory item or update fields (prop_tag, excluded, unit_count…)
@app.route("/api/inventory", methods=["POST"])
def update_inventory():
    store     = load_store()
    inventory = store.get("inventory", {})
    item      = request.json or {}
    iid       = item.get("id") or f"manual-{int(_time.time()*1000)}"
    _INV_UPDATE_FIELDS = {"item", "quantity", "unit_count", "user_unit_count", "volume_oz",
        "user_volume_oz", "volume_oz_locked", "unit_count_locked", "price", "date",
        "order_num", "prop_tag", "excluded", "classified", "city_tag", "group",
        "manual_stock", "manual_stock_date", "subject", "reorder_url"}
    if iid in inventory:
        inventory[iid].update({k: v for k, v in item.items() if k in _INV_UPDATE_FIELDS})
    else:
        name = item.get("item", "")
        classified = item.get("classified")  # "inventory" | None
        city_tag   = item.get("city_tag")
        # Generate inventory_key if classifying as inventory
        inv_key = None
        if classified == "inventory" and name:
            stop  = {"the","a","an","of","for","with","and","or","in","by","to","from"}
            words = re.sub(r"[^a-z0-9\s]", "", name.lower()).split()
            inv_key = " ".join(w for w in words if len(w) > 2 and w not in stop)[:60]
        vol_oz    = item.get("volume_oz")
        unit_cnt  = item.get("unit_count", 1)
        inventory[iid] = {
            "id":               iid,
            "item":             name,
            "quantity":         item.get("quantity", 1),
            "unit_count":       unit_cnt,
            "user_unit_count":  unit_cnt,   # user-set; reclean never touches user_* fields
            "volume_oz":        vol_oz,
            "user_volume_oz":   vol_oz,     # user-set
            "volume_oz_locked": vol_oz is not None,
            "unit_count_locked": True,       # prevent reclean from overwriting
            "price":            item.get("price"),
            "date":             item.get("date"),
            "order_num":        item.get("order_num", ""),
            "subject":          name,
            "prop_tag":         item.get("prop_tag"),
            "excluded":         classified == "not_inventory",
            "source":           "manual",
            "classified":       classified,
            "city_tag":         city_tag,
            "inventory_key":    inv_key,
            "group":            item.get("group"),
        }
        ms = item.get("manual_stock")
        if ms is not None:
            from datetime import datetime as _dt3, timezone as _tz3
            inventory[iid]["manual_stock"]      = int(ms)
            inventory[iid]["manual_stock_date"] = item.get("manual_stock_date") or _dt3.now(_tz3.utc).date().isoformat()
    store["inventory"] = inventory
    save_store(store)
    return jsonify({"ok": True, "id": iid, "item": inventory[iid]})


# ── POST /api/inventory/bulk ──────────────────────────────────
# Apply an action to multiple items at once: tag or exclude
@app.route("/api/inventory/bulk", methods=["POST"])
def bulk_inventory():
    store     = load_store()
    inventory = store.get("inventory", {})
    body      = request.json or {}
    ids       = body.get("ids", [])
    action    = body.get("action")         # "tag" | "exclude"
    prop_tag  = body.get("prop_tag")       # for action="tag"
    updated   = 0
    for iid in ids:
        if iid not in inventory:
            continue
        if action == "tag":
            inventory[iid]["prop_tag"] = prop_tag
        elif action == "exclude":
            inventory[iid]["excluded"] = True
        elif action == "include":
            inventory[iid]["excluded"] = False
        updated += 1
    store["inventory"] = inventory
    save_store(store)
    return jsonify({"ok": True, "updated": updated})


# ── POST /api/inventory/delete ───────────────────────────────
@app.route("/api/inventory/delete", methods=["POST"])
def delete_inventory_items():
    """Permanently remove a list of inventory item IDs from the store."""
    body  = request.json or {}
    ids   = body.get("ids", [])
    store = load_store()
    inv   = store.get("inventory", {})
    removed = [iid for iid in ids if iid in inv]
    for iid in removed:
        del inv[iid]
    store["inventory"] = inv
    save_store(store)
    return jsonify({"ok": True, "removed": len(removed)})


# ── POST /api/inventory/classify ─────────────────────────────
@app.route("/api/inventory/classify", methods=["POST"])
def classify_inventory_item():
    """Classify a single inventory item as 'inventory' or 'not_inventory'."""
    body           = request.json or {}
    item_id        = body.get("id")
    classified     = body.get("classified")    # "inventory" | "not_inventory" | None
    city_tag       = body.get("city_tag")      # "houston" | "niagara" | None
    item_name      = body.get("item_name")     # optional user-edited name
    override_key   = body.get("inventory_key") # force a specific key (link to existing row)
    override_qty   = body.get("unit_count")    # user-confirmed quantity override

    store     = load_store()
    inventory = store.get("inventory", {})
    if item_id not in inventory:
        return jsonify({"ok": False, "error": "Item not found"}), 404

    it = inventory[item_id]
    it["classified"] = classified
    it["excluded"]   = (classified == "not_inventory")

    if classified == "inventory":
        it["city_tag"] = city_tag
        if item_name:
            it["item"]        = item_name
            it["name_locked"] = True
        if override_key:
            # Link to an existing inventory row — lock key so reclean never regenerates it
            it["inventory_key"]        = override_key
            it["inventory_key_locked"] = True
        else:
            # Auto-generate key from (possibly updated) item name
            name  = it.get("item", "")
            stop  = {"the","a","an","of","for","with","and","or","in","by","to","from"}
            words = re.sub(r"[^a-z0-9\s]", "", name.lower()).split()
            it["inventory_key"] = " ".join(w for w in words if len(w) > 2 and w not in stop)[:60]
        if override_qty is not None:
            it["unit_count"]        = max(1, int(override_qty))
            it["user_unit_count"]   = max(1, int(override_qty))
            it["unit_count_locked"] = True
    else:
        it["city_tag"]      = None
        it["inventory_key"] = None

    store["inventory"] = inventory
    save_store(store)
    return jsonify({"ok": True})


# ── POST /api/inventory/edit ─────────────────────────────────
@app.route("/api/inventory/edit", methods=["POST"])
def edit_inventory_items():
    """Update item name and/or unit_count for a list of inventory item IDs."""
    body       = request.json or {}
    ids        = body.get("ids", [])
    item_name  = body.get("item_name")   # new canonical name (optional)
    unit_count = body.get("unit_count")  # new unit count integer (optional)
    volume_oz  = body.get("volume_oz")   # oz per bottle; None clears it

    store     = load_store()
    inventory = store.get("inventory", {})
    stop      = {"the","a","an","of","for","with","and","or","in","by","to","from"}
    updated   = 0
    for iid in ids:
        it = inventory.get(iid)
        if not it:
            continue
        if item_name:
            it["item"]                 = item_name
            it["name_locked"]          = True   # prevent reclean from overwriting
            it["inventory_key_locked"] = True   # prevent reclean from regenerating key
            words = re.sub(r"[^a-z0-9\s]", "", item_name.lower()).split()
            it["inventory_key"] = " ".join(w for w in words if len(w) > 2 and w not in stop)[:60]
        if unit_count is not None:
            it["unit_count"]        = max(1, int(unit_count))
            it["user_unit_count"]   = max(1, int(unit_count))  # user-set; survives reclean
            it["unit_count_locked"] = True   # prevent reclean from overwriting
        if "volume_oz" in body:  # explicit key presence — allows clearing with null
            it["volume_oz"]        = volume_oz  # None = revert to count-based
            it["user_volume_oz"]   = volume_oz  # user-set; survives reclean
            it["volume_oz_locked"] = (volume_oz is not None)
        if "per_stay" in body:
            per_stay_val = body.get("per_stay")
            if per_stay_val is None:
                it.pop("per_stay", None)
                it.pop("user_per_stay", None)
            else:
                it["per_stay"]      = float(per_stay_val)
                it["user_per_stay"] = float(per_stay_val)  # user-set; survives reclean
        if "date" in body and body["date"] is not None:
            it["date"] = body["date"]  # allow date override from client
        if "group" in body:
            if body["group"] is None:
                it.pop("group", None)
            else:
                it["group"] = body["group"]
        if "manual_stock" in body:
            ms = body.get("manual_stock")
            if ms is None:
                it.pop("manual_stock", None)
                it.pop("manual_stock_date", None)
            else:
                from datetime import datetime as _dt2, timezone as _tz
                it["manual_stock"]      = int(ms)
                it["manual_stock_date"] = body.get("manual_stock_date") or _dt2.now(_tz.utc).date().isoformat()
        if "prop_tag" in body:
            pt = body.get("prop_tag")
            if pt is None:
                it.pop("prop_tag", None)
            else:
                it["prop_tag"] = pt
        updated += 1

    store["inventory"] = inventory
    save_store(store)
    return jsonify({"ok": True, "updated": updated})



# ── GET /api/consumption-settings ────────────────────────────
@app.route("/api/consumption-settings")
def get_consumption_settings():
    store = load_store()
    return jsonify({"settings": store.get("consumption_settings", {})})


# ── POST /api/consumption-settings ───────────────────────────
@app.route("/api/consumption-settings", methods=["POST"])
def save_consumption_settings():
    store = load_store()
    store["consumption_settings"] = request.json.get("settings", {})
    save_store(store)
    return jsonify({"ok": True})


# ── City list ─────────────────────────────────────────────────────
@app.route("/api/city-list")
def get_city_list():
    store = load_store()
    return jsonify({"cities": store.get("city_list", [])})


@app.route("/api/city-list", methods=["POST"])
def save_city_list():
    store = load_store()
    cities = request.json.get("cities", [])
    store["city_list"] = cities
    save_store(store)
    return jsonify({"ok": True, "cities": cities})


# ── iCal Feed Parser & Sync ──────────────────────────────────────────────────

def _parse_ical_feed(text):
    """Pure string-split iCal parser. Extracts bookings from Airbnb VCALENDAR feeds.
    Returns list of dicts: {check_in, check_out, nights, guest_name, summary}."""
    events = []
    blocks = text.split("BEGIN:VEVENT")
    for block in blocks[1:]:  # skip preamble before first VEVENT
        end = block.find("END:VEVENT")
        if end >= 0:
            block = block[:end]
        fields = {}
        for line in block.splitlines():
            line = line.strip()
            if ":" in line:
                key, _, val = line.partition(":")
                # Handle properties with params like DTSTART;VALUE=DATE:20260301
                key = key.split(";")[0].upper()
                fields[key] = val.strip()

        summary = fields.get("SUMMARY", "")
        # Skip owner blocks
        if "not available" in summary.lower() or not summary:
            continue

        dtstart = fields.get("DTSTART", "").split("T")[0][:10]
        dtend = fields.get("DTEND", "").split("T")[0][:10]
        if not dtstart:
            continue

        # Normalise dates: 20260301 → 2026-03-01
        if len(dtstart) == 8 and "-" not in dtstart:
            dtstart = f"{dtstart[:4]}-{dtstart[4:6]}-{dtstart[6:8]}"
        if len(dtend) == 8 and "-" not in dtend:
            dtend = f"{dtend[:4]}-{dtend[4:6]}-{dtend[6:8]}"

        # Calculate nights
        nights = 0
        if dtstart and dtend:
            try:
                from datetime import date as _d
                d1 = _d.fromisoformat(dtstart)
                d2 = _d.fromisoformat(dtend)
                nights = (d2 - d1).days
            except Exception:
                pass

        # Extract guest name from summary (Airbnb format: "Guest Name - XXXXXX" or just name)
        guest_name = summary.split(" - ")[0].strip() if " - " in summary else summary
        if guest_name.lower() in ("reserved", "airbnb"):
            guest_name = None

        events.append({
            "check_in": dtstart,
            "check_out": dtend,
            "nights": nights,
            "guest_name": guest_name,
            "summary": summary,
        })
    return events


@app.route("/api/ical/sync", methods=["POST"])
def ical_sync():
    """Fetch all Airbnb iCal feeds for user's properties, parse, and full-replace ical_events."""
    store = load_store()
    uid = getattr(g, 'user_id', None)

    # Read properties from store (synced by frontend)
    props = store.get("custom_props", [])
    all_events = []
    errors = []

    for prop in props:
        ical_urls = prop.get("icalUrls") or []
        prop_id = prop.get("id") or prop.get("name") or ""
        prop_name = prop.get("label") or prop.get("name") or prop_id

        for unit_idx, url in enumerate(ical_urls):
            if not url or not url.strip():
                continue
            url = url.strip()
            unit_label = f"{prop_name} Unit {unit_idx + 1}" if len(ical_urls) > 1 else prop_name
            try:
                resp = requests.get(url, timeout=15)
                resp.raise_for_status()
                parsed = _parse_ical_feed(resp.text)
                for ev in parsed:
                    all_events.append({
                        "check_in": ev["check_in"],
                        "check_out": ev["check_out"],
                        "nights": ev["nights"],
                        "guest_name": ev["guest_name"],
                        "summary": ev["summary"],
                        "prop_id": prop_id,
                        "unit_index": unit_idx,
                        "listing_name": unit_label,
                        "feed_key": f"{prop_id}_{unit_idx}",
                        "booking_source": "airbnb",
                        "event_type": "booking",
                    })
            except Exception as e:
                errors.append(f"{prop_name} unit {unit_idx}: {str(e)[:100]}")
                logger.warning("iCal fetch failed for %s unit %d: %s", prop_name, unit_idx, e)

    # Full replace — no merging, no dedup, no orphans
    store["ical_events"] = all_events
    save_store(store)
    if uid:
        _invalidate_cache("calendar_events", uid)

    logger.info("iCal sync: %d events from %d properties (%d errors)", len(all_events), len(props), len(errors))
    return jsonify({"ok": True, "events_count": len(all_events), "errors": errors})


@app.route("/api/calendar/events", methods=["GET"])
def calendar_events():
    """Return calendar events from iCal feed data."""
    uid = getattr(g, 'user_id', None)
    cached = _get_cached_response("calendar_events", uid, 30) if uid else None
    if cached is not None:
        return jsonify(cached)

    store = load_store()
    ical_events = store.get("ical_events", [])

    events = []
    for ev in ical_events:
        ci = ev.get("check_in", "")
        co = ev.get("check_out", "")
        if not ci:
            continue
        events.append({
            "check_in": ci,
            "check_out": co,
            "prop_id": ev.get("prop_id", ""),
            "feed_key": ev.get("feed_key", ev.get("prop_id", "")),
            "nights": ev.get("nights", 0),
            "booking_source": ev.get("booking_source", "airbnb"),
            "guest_name": ev.get("guest_name"),
            "listing_name": ev.get("listing_name", ""),
            "summary": ev.get("summary", ""),
            "event_type": ev.get("event_type", "booking"),
        })

    result = {"events": events, "count": len(events), "source": "ical"}
    if uid:
        _set_cached_response("calendar_events", uid, result)
    return jsonify(result)

# ══════════════════════════════════════════════════════════════
# STR Analytics Engine
# Data sources: PriceLabs bookings, per-property income, PriceLabs API
# ══════════════════════════════════════════════════════════════

# Dynamic STR property IDs — loaded from user store, no more hardcoded lists
def _get_str_properties():
    """Return property IDs from the user's store, not a hardcoded list."""
    store = load_store()
    props = store.get("custom_props", []) + store.get("properties", [])
    return [p.get("id") or p.get("name") for p in props if p.get("id") or p.get("name")]

STR_PROPERTIES = []  # Legacy — use _get_str_properties() instead


def _ical_to_events(store):
    """Convert iCal events to the event format used by analytics functions."""
    events = []
    for b in store.get("ical_events", []):
        ci = b.get("check_in", "")
        co = b.get("check_out", "")
        if not ci:
            continue
        prop_id = b.get("prop_id", "")
        guest = b.get("guest_name", "")
        summary = guest or b.get("summary", "Reserved")
        nights = b.get("nights") or 0
        events.append({
            "propId": prop_id,
            "start": ci[:10],
            "end": co[:10] if co else ci[:10],
            "summary": summary,
            "guest_name": guest,
            "nights": nights,
            "nightly_rate": None,
            "booking_source": b.get("booking_source", "airbnb"),
            "pl_id": "",
        })
    return events


def _is_block_event(ev):
    """True if a calendar event is an owner-block / maintenance hold, not a guest stay."""
    summary = (ev.get("summary") or "").lower().strip()
    guest   = (ev.get("guest_name") or "").strip()
    _BLOCK_EXACT = {
        "reserved", "not available", "unavailable", "blocked",
        "airbnb (not available)", "owner block", "owner hold",
        "maintenance", "hold", "turnaround", "changeover",
    }
    if summary in _BLOCK_EXACT and not guest:
        return True
    if not guest and any(kw in summary for kw in
                         ("not available", "unavailable", "blocked", "hold", "owner")):
        return True
    return False


def _compute_listing_analytics(events, prop_id, start_date_str, end_date_str):
    """
    Compute occupancy and performance metrics for a single listing over a date range.
    events            — full list of calendar events (all properties)
    prop_id           — property identifier string
    start/end_date_str — ISO date strings (inclusive start, exclusive end)
    """
    from datetime import date as _d, timedelta as _td
    from collections import defaultdict

    start_date = _d.fromisoformat(start_date_str)
    end_date   = _d.fromisoformat(end_date_str)
    total_days = (end_date - start_date).days
    if total_days <= 0:
        return {"error": "end_date must be after start_date"}

    # ── Filter and classify events ────────────────────────────────────────────
    reservations = []   # actual guest stays
    blocks       = []   # owner blocks / maintenance
    for ev in events:
        if ev.get("propId") != prop_id:
            continue
        try:
            s = _d.fromisoformat(ev["start"])
            e = _d.fromisoformat(ev["end"])
        except Exception:
            continue
        s_clip = max(s, start_date)
        e_clip = min(e, end_date)
        if s_clip >= e_clip:
            continue
        record = {**ev, "_s": s_clip, "_e": e_clip, "_nights": (e_clip - s_clip).days}
        (blocks if _is_block_event(ev) else reservations).append(record)

    # ── Build per-day sets ────────────────────────────────────────────────────
    reserved_days = set()
    blocked_days  = set()
    for res in reservations:
        d = res["_s"]
        while d < res["_e"]:
            reserved_days.add(d)
            d += _td(days=1)
    for blk in blocks:
        d = blk["_s"]
        while d < blk["_e"]:
            blocked_days.add(d)
            d += _td(days=1)

    # available = not purely blocked (reserved days count as available)
    unavailable = blocked_days - reserved_days
    available_nights = total_days - len(unavailable)
    reserved_nights  = len(reserved_days)
    open_nights      = available_nights - reserved_nights
    occupancy_rate   = reserved_nights / available_nights if available_nights > 0 else 0.0

    # ── Average stay ──────────────────────────────────────────────────────────
    avg_stay = (sum(r["_nights"] for r in reservations) / len(reservations)
                if reservations else 0.0)

    # ── Turnover gaps + orphan gaps ───────────────────────────────────────────
    sorted_res = sorted(reservations, key=lambda r: r["_s"])
    gaps = []
    for i in range(1, len(sorted_res)):
        gap = (sorted_res[i]["_s"] - sorted_res[i - 1]["_e"]).days
        if gap >= 0:
            gaps.append(gap)
    avg_turnover = sum(gaps) / len(gaps) if gaps else 0.0
    orphan_gaps  = [g for g in gaps if 1 <= g <= 2]

    # ── Weekend vs weekday (Fri=4, Sat=5) ────────────────────────────────────
    w_booked = w_avail = wd_booked = wd_avail = 0
    d = start_date
    while d < end_date:
        if d not in unavailable:
            if d.weekday() in (4, 5):
                w_avail += 1
                if d in reserved_days: w_booked += 1
            else:
                wd_avail += 1
                if d in reserved_days: wd_booked += 1
        d += _td(days=1)

    # ── Monthly breakdown ─────────────────────────────────────────────────────
    monthly = defaultdict(lambda: {"reserved": 0, "available": 0})
    d = start_date
    while d < end_date:
        mo = d.strftime("%Y-%m")
        if d not in unavailable:
            monthly[mo]["available"] += 1
        if d in reserved_days:
            monthly[mo]["reserved"] += 1
        d += _td(days=1)
    monthly_occupancy = [
        {
            "month":          mo,
            "reserved":       v["reserved"],
            "available":      v["available"],
            "occupancy_rate": round(v["reserved"] / v["available"], 4)
                              if v["available"] > 0 else 0.0,
        }
        for mo, v in sorted(monthly.items())
    ]

    # ── ADR ───────────────────────────────────────────────────────────────────
    rates = [float(r["nightly_rate"]) for r in reservations
             if r.get("nightly_rate") is not None]
    adr = round(sum(rates) / len(rates), 2) if rates else None

    return {
        "listing_id":         prop_id,
        "period":             {"start": start_date_str, "end": end_date_str},
        "total_days":         total_days,
        "total_bookings":     len(reservations),
        "reserved_nights":    reserved_nights,
        "available_nights":   available_nights,
        "blocked_nights":     len(unavailable),
        "open_nights":        open_nights,
        "occupancy_rate":     round(occupancy_rate, 4),
        "average_stay":       round(avg_stay, 2),
        "avg_turnover_days":  round(avg_turnover, 2),
        "orphan_gaps":        len(orphan_gaps),
        "orphan_gap_nights":  orphan_gaps,
        "adr":                adr,
        "weekend_occupancy":  round(w_booked / w_avail,  4) if w_avail  > 0 else 0.0,
        "weekday_occupancy":  round(wd_booked / wd_avail, 4) if wd_avail > 0 else 0.0,
        "weekend_vs_weekday": {
            "weekend_booked":    w_booked,
            "weekend_available": w_avail,
            "weekday_booked":    wd_booked,
            "weekday_available": wd_avail,
        },
        "monthly_occupancy":  monthly_occupancy,
    }


def _compute_portfolio_analytics(events, start_date_str, end_date_str):
    """Aggregate analytics across all STR properties that have calendar events."""
    # Discover which prop_ids actually have events (union of STR_PROPERTIES + any in feed)
    active_props = list({ev["propId"] for ev in events
                         if ev.get("propId") and ev["propId"] in STR_PROPERTIES})
    if not active_props:
        # Fall back to all STR_PROPERTIES even if no events yet
        active_props = STR_PROPERTIES

    listings = {}
    for prop_id in active_props:
        data = _compute_listing_analytics(events, prop_id, start_date_str, end_date_str)
        if "error" not in data:
            listings[prop_id] = data

    if not listings:
        return {"listings": {}, "portfolio": {}}

    total_booked    = sum(v["reserved_nights"]  for v in listings.values())
    total_available = sum(v["available_nights"] for v in listings.values())
    total_bookings  = sum(v["total_bookings"]   for v in listings.values())
    portfolio_occ   = total_booked / total_available if total_available > 0 else 0.0

    by_occ  = sorted(listings.items(), key=lambda x: x[1]["occupancy_rate"], reverse=True)
    by_adr  = sorted([(k, v) for k, v in listings.items() if v["adr"] is not None],
                     key=lambda x: x[1]["adr"], reverse=True)
    vacancy = sorted(listings.items(), key=lambda x: x[1]["open_nights"], reverse=True)

    return {
        "listings": listings,
        "portfolio": {
            "total_booked_nights":    total_booked,
            "total_available_nights": total_available,
            "total_bookings":         total_bookings,
            "portfolio_occupancy":    round(portfolio_occ, 4),
            "best_listing":           by_occ[0][0]  if by_occ  else None,
            "weakest_listing":        by_occ[-1][0] if by_occ  else None,
            "highest_adr_listing":    by_adr[0][0]  if by_adr  else None,
            "lowest_adr_listing":     by_adr[-1][0] if by_adr  else None,
            "vacancy_heavy_listing":  vacancy[0][0] if vacancy else None,
        },
    }


# ── Analytics API routes ──────────────────────────────────────────────────────

def _analytics_range(req):
    """Parse ?start=&end= query params, defaulting to trailing 12 months."""
    from datetime import date as _d
    today = _d.today()
    end   = req.args.get("end",   today.isoformat())
    start = req.args.get("start", _d(today.year - 1, today.month, 1).isoformat())
    return start, end


@app.route("/api/analytics/listing/<prop_id>")
def analytics_listing(prop_id):
    """Per-listing occupancy, ADR, orphan gaps, monthly breakdown."""
    store  = load_store()
    events = _ical_to_events(store)
    start, end = _analytics_range(request)
    return jsonify(_compute_listing_analytics(events, prop_id, start, end))


@app.route("/api/analytics/portfolio")
def analytics_portfolio():
    """Portfolio-wide: occupancy, total booked nights, best/worst listings."""
    # Phase 6: per-user response cache (120s TTL)
    uid = getattr(g, 'user_id', None)
    range_param = request.args.get("start", "") + ":" + request.args.get("end", "")
    cache_key = f"portfolio:{range_param}"
    if uid:
        cached = _get_cached_response(cache_key, uid, 120)
        if cached is not None:
            return jsonify(cached)
    store  = load_store()
    events = _ical_to_events(store)
    start, end = _analytics_range(request)
    result_data = _compute_portfolio_analytics(events, start, end)
    if uid:
        _set_cached_response(cache_key, uid, result_data)
    return jsonify(result_data)


@app.route("/api/pricelabs/config", methods=["POST"])
def pricelabs_config():
    """Save PriceLabs API key and property→listing mapping from the Settings UI.
    Validates the API key before saving by testing a listings fetch."""
    body    = request.json or {}
    store   = load_store()
    api_key = body.get("api_key", "").strip()
    validated = False
    if api_key:
        # Validate key by attempting a listings fetch
        try:
            import urllib.request, urllib.parse
            test_url = "https://api.pricelabs.co/v1/listings"
            req = urllib.request.Request(test_url, headers={
                "X-API-Key": api_key,
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            })
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status == 200:
                    validated = True
        except Exception as e:
            logger.warning("[PriceLabs] API key validation failed: %s", e)
            return jsonify({"ok": False, "error": "Invalid PriceLabs API key — could not connect. Check the key and try again."}), 400
        # Store key encrypted if ENCRYPTION_KEY is stable, otherwise plaintext
        if os.environ.get("ENCRYPTION_KEY"):
            store["pricelabs_api_key"] = _encrypt(api_key)
        else:
            store["pricelabs_api_key"] = api_key
    if body.get("mapping"):
        mapping = store.get("pricelabs_mapping", {})
        mapping.update(body["mapping"])
        store["pricelabs_mapping"] = mapping
    save_store(store)
    # After saving key, refresh listings + reservations in background
    if validated:
        def _bg_refresh():
            try:
                import urllib.request
                with app.test_request_context():
                    pricelabs_listings()          # refresh listings cache
                    s = load_store()
                    _sync_pricelabs_reservations(s)  # pull reservation data
            except Exception as ex:
                logger.error("[PriceLabs] Post-config refresh failed: %s", ex)
        threading.Thread(target=_bg_refresh, daemon=True).start()
    return jsonify({"ok": True, "validated": validated})


def _sync_pricelabs_reservations(store=None):
    """Fetch reservation data from PriceLabs API for all known listings and store as pl_bookings.
    Merges with existing bookings, deduplicating by (listing_id, check_in, check_out)."""
    import datetime as _dt
    if store is None:
        store = load_store()
    listings = store.get("pricelabs_listings_raw", [])
    if not listings:
        logger.info("[PL Reservations] No listings cached — skipping reservation sync")
        return 0
    listing_ids = [str(l.get("id") or "") for l in listings if l.get("id")]
    if not listing_ids:
        return 0
    # Build name lookup: pl_id → canonical_name
    name_by_id = store.get("pricelabs_short_names", {})
    today = _dt.date.today()
    start = (today - _dt.timedelta(days=90)).isoformat()
    end   = (today + _dt.timedelta(days=365)).isoformat()
    new_bookings = []
    # Try fetching reservation_data for all listings at once, then per-listing fallback
    try:
        data = _pricelabs_get("/reservation_data", {
            "listing_ids": ",".join(listing_ids),
            "start_date": start,
            "end_date": end,
        })
        reservations = data if isinstance(data, list) else (data.get("reservations") or data.get("data") or [])
        for r in reservations:
            lid = str(r.get("listing_id") or r.get("id") or "")
            listing_name = name_by_id.get(lid, "")
            pid = _infer_prop_from_listing(listing_name) or _infer_prop_from_listing(r.get("listing_name", ""))
            ci = (r.get("check_in") or r.get("checkin") or r.get("start_date") or "")[:10]
            co = (r.get("check_out") or r.get("checkout") or r.get("end_date") or "")[:10]
            if not ci:
                continue
            nights = r.get("nights") or r.get("length_of_stay") or 0
            if not nights and ci and co:
                try:
                    nights = (_dt.date.fromisoformat(co) - _dt.date.fromisoformat(ci)).days
                except Exception:
                    pass
            new_bookings.append({
                "listing_id":   lid,
                "listing_name": listing_name or r.get("listing_name", ""),
                "prop_id":      pid,
                "check_in":     ci,
                "check_out":    co,
                "nights":       nights,
                "guest_name":   r.get("guest_name") or r.get("guest") or "",
                "channel":      r.get("channel") or r.get("source") or r.get("booking_source") or "",
                "status":       r.get("status") or "confirmed",
                "revenue":      r.get("revenue") or r.get("total_price") or r.get("payout") or 0,
                "source":       "pricelabs_api",
            })
        logger.info("[PL Reservations] Fetched %s reservations for %s listings", len(new_bookings), len(listing_ids))
    except RuntimeError as e:
        logger.warning("[PL Reservations] Bulk fetch failed (%s), trying per-listing", e)
        for lid in listing_ids:
            try:
                data = _pricelabs_get("/reservation_data", {
                    "listing_id": lid,
                    "start_date": start,
                    "end_date": end,
                })
                items = data if isinstance(data, list) else (data.get("reservations") or data.get("data") or [])
                listing_name = name_by_id.get(lid, "")
                pid = _infer_prop_from_listing(listing_name)
                for r in items:
                    ci = (r.get("check_in") or r.get("checkin") or r.get("start_date") or "")[:10]
                    co = (r.get("check_out") or r.get("checkout") or r.get("end_date") or "")[:10]
                    if not ci:
                        continue
                    nights = r.get("nights") or r.get("length_of_stay") or 0
                    if not nights and ci and co:
                        try:
                            nights = (_dt.date.fromisoformat(co) - _dt.date.fromisoformat(ci)).days
                        except Exception:
                            pass
                    new_bookings.append({
                        "listing_id":   lid,
                        "listing_name": listing_name or r.get("listing_name", ""),
                        "prop_id":      pid,
                        "check_in":     ci,
                        "check_out":    co,
                        "nights":       nights,
                        "guest_name":   r.get("guest_name") or r.get("guest") or "",
                        "channel":      r.get("channel") or r.get("source") or r.get("booking_source") or "",
                        "status":       r.get("status") or "confirmed",
                        "revenue":      r.get("revenue") or r.get("total_price") or r.get("payout") or 0,
                        "source":       "pricelabs_api",
                    })
            except Exception as ex:
                logger.warning("[PL Reservations] Failed for listing %s: %s", lid, ex)
    if not new_bookings:
        return 0
    # Merge with existing bookings, dedup by (listing_id, check_in, check_out)
    existing = store.get("pl_bookings", [])
    seen = set()
    for b in existing:
        key = (b.get("listing_id", ""), b.get("check_in", ""), b.get("check_out", ""))
        seen.add(key)
    added = 0
    for b in new_bookings:
        key = (b.get("listing_id", ""), b.get("check_in", ""), b.get("check_out", ""))
        if key not in seen:
            seen.add(key)
            existing.append(b)
            added += 1
        else:
            # Update existing booking with fresh data
            for i, ex in enumerate(existing):
                ex_key = (ex.get("listing_id", ""), ex.get("check_in", ""), ex.get("check_out", ""))
                if ex_key == key:
                    existing[i] = {**ex, **b}
                    break
    store["pl_bookings"] = existing
    save_store(store)
    logger.info("[PL Reservations] %s new, %s updated, %s total bookings", added, len(new_bookings) - added, len(existing))
    return len(new_bookings)


def _pl_canonical_short(short_label, prop_id):
    """
    Generate the canonical short name shown everywhere in the app UI.
    Generic: if short_label is a generic 'Unit N' pattern, prefix with prop_id title.
    Otherwise return short_label as-is.
    """
    m = re.search(r'^(?:unit\s+)?(\d+)$', short_label.strip(), re.IGNORECASE)
    if m and prop_id:
        # Generic unit label — prefix with property name for clarity
        return f"{prop_id.replace('_', ' ').title()} {m.group(1)}"
    return short_label


def _pl_parse_name(raw):
    """
    PriceLabs name format: "Unit 2--Unit 2 · Modern EaDo Apartment Near Downtown"
    - short_label: "Unit 2"  (before --)
    - full_name:   "Unit 2 · Modern EaDo Apartment Near Downtown"  (after --)
    Returns (short_label, full_name).
    """
    raw = raw.strip()
    if "--" in raw:
        parts = raw.split("--", 1)
        short = parts[0].strip()
        full  = parts[1].strip()
        return short, full
    return raw, raw


# Dynamic per-user property mapping (no hardcoded constants)
import re as _re

# Empty — kept for backward compat but unused; per-user mapping is built dynamically
_PL_CITY_TO_PROP = {}


def _get_user_properties(store=None):
    """Return list of user property dicts from store."""
    if store is None:
        store = load_store()
    return store.get("custom_props", []) + store.get("properties", [])


def _build_city_to_prop(store=None):
    """Build city→prop_id mapping from the user's own properties."""
    props = _get_user_properties(store)
    city_map = {}
    for p in props:
        pid = p.get("id") or p.get("name")
        if not pid:
            continue
        # Use city/address fields if available
        for field in ("city", "location", "address"):
            val = (p.get(field) or "").lower().strip()
            if val and val not in city_map:
                city_map[val] = pid
    return city_map


def _pl_prop_from_name(raw_name, store=None):
    """Return prop_id by matching listing name against user's property labels/ids/names."""
    if not raw_name:
        return None
    props = _get_user_properties(store)
    name_lower = raw_name.lower()
    for p in props:
        pid = p.get("id") or p.get("name")
        if not pid:
            continue
        # Check if prop id, label, or name appears in the listing name
        for field in ("id", "name", "label", "short_label"):
            val = (p.get(field) or "").lower().strip()
            if val and len(val) >= 3 and val in name_lower:
                return pid
    return None


def _infer_prop_from_listing(name, store=None):
    """Dynamic prop_id mapping: checks user properties, then pricelabs_mapping reverse lookup."""
    if not name:
        return None
    if store is None:
        store = load_store()
    # 1) Match against user property labels/ids/names
    pid = _pl_prop_from_name(name, store)
    if pid:
        return pid
    # 2) Reverse lookup from pricelabs_mapping (listing_id → prop_id)
    mapping = store.get("pricelabs_mapping", {})
    rev = {str(v): k for k, v in mapping.items()}
    # Check if name matches any mapped listing
    for listing_id, prop_id in rev.items():
        if listing_id in name:
            return prop_id
    return None


def _extract_month_key(s):
    """Permissively extract YYYY-MM from any date-like string. Returns 'YYYY-MM' or None."""
    if not s:
        return None
    s = s.strip()
    # Full ISO or slash-ISO: 2026-03-08, 2026/03/08
    m = _re.search(r'(20\d{2})[-/](\d{1,2})', s)
    if m:
        return f"{m.group(1)}-{m.group(2).zfill(2)}"
    # MM/DD/YYYY or MM-DD-YYYY (4-digit year)
    m = _re.match(r'^(\d{1,2})[/\-](\d{1,2})[/\-](20\d{2})', s)
    if m:
        return f"{m.group(3)}-{m.group(1).zfill(2)}"
    # Month name: "Mar 8, 2026", "08-Mar-2026", "2026 Mar", etc.
    _mon = {'jan':'01','feb':'02','mar':'03','apr':'04','may':'05','jun':'06',
            'jul':'07','aug':'08','sep':'09','oct':'10','nov':'11','dec':'12'}
    m = _re.search(r'([a-zA-Z]{3})[a-z]*[\s,\-/]+\d{1,2}[\s,\-/]+(20\d{2})', s)
    if m:
        mo = _mon.get(m.group(1).lower())
        if mo:
            return f"{m.group(2)}-{mo}"
    m = _re.search(r'(20\d{2})[\s,\-/]+([a-zA-Z]{3})', s)
    if m:
        mo = _mon.get(m.group(2).lower())
        if mo:
            return f"{m.group(1)}-{mo}"
    # MM/DD/YY or M/D/YY (2-digit year)
    m = _re.match(r'^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2})$', s)
    if m:
        return f"20{m.group(3)}-{m.group(1).zfill(2)}"
    # Excel serial date number
    m = _re.match(r'^(\d{5})(?:\.\d*)?$', s)
    if m:
        n = int(m.group(1))
        if 40000 <= n <= 60000:
            import datetime as _dt2
            try:
                d = _dt2.date(1899, 12, 30) + _dt2.timedelta(days=n)
                return f"{d.year}-{str(d.month).zfill(2)}"
            except Exception:
                pass
    return None


def _normalize_date(s):
    """Coerce various date string formats → YYYY-MM-DD, or None."""
    if not s:
        return None
    s = s.strip()
    # Already ISO (YYYY-MM-DD or YYYY/MM/DD)
    m = _re.match(r'^(\d{4})[-/](\d{1,2})[-/](\d{1,2})', s)
    if m:
        return f"{m.group(1)}-{m.group(2).zfill(2)}-{m.group(3).zfill(2)}"
    # MM/DD/YYYY or MM-DD-YYYY
    m = _re.match(r'^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})', s)
    if m:
        return f"{m.group(3)}-{m.group(1).zfill(2)}-{m.group(2).zfill(2)}"
    # DD-Mon-YYYY  (e.g. 15-Oct-2025)
    _mon = {'jan':'01','feb':'02','mar':'03','apr':'04','may':'05','jun':'06',
            'jul':'07','aug':'08','sep':'09','oct':'10','nov':'11','dec':'12'}
    m = _re.match(r'^(\d{1,2})[/\-]([a-zA-Z]{3})[/\-](\d{4})', s)
    if m:
        mo = _mon.get(m.group(2).lower())
        if mo:
            return f"{m.group(3)}-{mo}-{m.group(1).zfill(2)}"
    # Mon DD, YYYY  (e.g. Oct 15, 2025)
    m = _re.match(r'^([a-zA-Z]{3})\s+(\d{1,2}),?\s+(\d{4})', s)
    if m:
        mo = _mon.get(m.group(1).lower())
        if mo:
            return f"{m.group(3)}-{mo}-{m.group(2).zfill(2)}"
    # DD/MM/YYYY (European format — only if first number > 12 making MM/DD impossible)
    m = _re.match(r'^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2})$', s)
    if m:
        # YYYY with 2-digit year: treat as 20YY
        return f"20{m.group(3)}-{m.group(1).zfill(2)}-{m.group(2).zfill(2)}"
    # Excel serial date number (days since Dec 30, 1899)
    # Range 40000–60000 covers ~2009–2064
    m = _re.match(r'^(\d{5})(?:\.\d*)?$', s)
    if m:
        n = int(m.group(1))
        if 40000 <= n <= 60000:
            import datetime as _dt2
            try:
                dt = _dt2.date(1899, 12, 30) + _dt2.timedelta(days=n)
                return dt.strftime('%Y-%m-%d')
            except Exception:
                pass
    return None


def _detect_csv_type(headers):
    """Score CSV headers to identify the data type."""
    h = set(_re.sub(r'[\s\-&]+', '_', hdr.strip().lower()) for hdr in headers)
    # Also keep original cleaned versions for partial matching
    h_list = [_re.sub(r'[\s\-&]+', '_', hdr.strip().lower()) for hdr in headers]

    def has(candidates):
        return bool(h & set(candidates))
    def contains(substr):
        return any(substr in v for v in h_list)

    # PriceLabs Revenue on the Books (monthly summary: Year & Month + Rental Revenue)
    pl_monthly_score = sum([
        contains('rental_revenue'),
        contains('year') and contains('month') or 'year__month' in h or 'year___month' in h
            or any('year' in v and 'month' in v for v in h_list),
        contains('occupancy'),
        contains('revpar'),
    ])

    # PriceLabs individual bookings (check-in/out + revenue per reservation)
    pl_booking_score = sum([
        has({'rental_revenue','revenue','total_revenue','booking_revenue','net_revenue',
             'payout','total_payout','earnings','gross_earnings','accommodation_fare',
             'host_earnings','net_payout','host_payout','gross_revenue'}),
        has({'check_in','checkin','check_in_date','arrival','arrival_date','start_date',
             'from','date_in','in_date'}),
        has({'check_out','checkout','check_out_date','departure','departure_date','end_date',
             'to','date_out','out_date'}),
        has({'listing_name','property_name','listing','property','unit_name','name',
             'property_title','rental_name'})
            or contains('listing') or contains('property'),
        has({'adr','average_daily_rate','nightly_rate','daily_rate','avg_nightly_rate','rate'}),
        has({'booked_date','booking_date','date_booked','reservation_date','created','booked'}),
        has({'nights','night_count','duration','length_of_stay','num_nights','los'}),
    ])

    chase_score = sum([
        has({'transaction_date','date'}),
        'post_date' in h,
        'description' in h,
        'category' in h,
        'amount' in h,
    ])

    airbnb_res_score = sum([
        has({'confirmation_code','confirmation'}),
        has({'listing_name','listing','property_name'}),
        has({'start_date','check_in','arrival_date'}),
        has({'total_payout','payout','earnings','amount','gross_earnings'}),
    ])

    scores = [
        ('pricelabs_revenue_monthly', pl_monthly_score),
        ('pricelabs_bookings',        pl_booking_score),
        ('chase_transactions',        chase_score),
        ('airbnb_reservations',       airbnb_res_score),
    ]
    best, score = max(scores, key=lambda x: x[1])
    return best if score >= 2 else 'unknown'


def _parse_pl_revenue_monthly_csv(header_row, data_rows):
    """
    Parse PriceLabs Revenue on the Books monthly summary CSV.
    Returns list of {month: 'YYYY-MM', rental_revenue: float, listing_name: str|None}
    """
    h = [_re.sub(r'[\s\-&]+', '_', hdr.strip().lower()) for hdr in header_row]

    def col_idx(*names):
        for name in names:
            n = _re.sub(r'[\s\-&]+', '_', name.strip().lower())
            if n in h:
                return h.index(n)
            # partial match
            for i, v in enumerate(h):
                if n in v or v in n:
                    return i
        return -1

    # Find month column — "Year & Month", "Month", "Date", "Period"
    mo_idx  = col_idx('year___month', 'year__month', 'year_month', 'month', 'date', 'period', 'year___month')
    # Fallback: find any column whose name contains both 'year' and 'month'
    if mo_idx < 0:
        for i, v in enumerate(h):
            if 'year' in v and 'month' in v:
                mo_idx = i; break
    if mo_idx < 0:
        for i, v in enumerate(h):
            if 'month' in v or 'date' in v or 'period' in v:
                mo_idx = i; break

    rev_idx     = col_idx('rental_revenue', 'revenue', 'total_revenue')
    listing_idx = col_idx('listing_name', 'property_name', 'listing', 'property', 'unit')

    results = []
    for row in data_rows:
        if not any(c.strip() for c in row):
            continue
        mo_raw  = row[mo_idx].strip() if mo_idx >= 0 and mo_idx < len(row) else ''
        rev_raw = row[rev_idx].strip() if rev_idx >= 0 and rev_idx < len(row) else ''
        listing = row[listing_idx].strip() if listing_idx >= 0 and listing_idx < len(row) else None

        if not mo_raw or not rev_raw:
            continue

        # Parse month → YYYY-MM
        # Handle all formats: "2026-01 (Jan)", "2026-01", "January 2026", "Jan 2026", "10/2025"
        month = None
        # 1. Starts with YYYY-MM — just grab the first 7 chars (handles "2026-01 (Jan)" etc.)
        m = _re.match(r'^(\d{4}-\d{2})', mo_raw.strip())
        if m:
            month = m.group(1)
        # 2. "Month YYYY" or "Mon YYYY"
        if not month:
            _mon_names = {'january':'01','february':'02','march':'03','april':'04','may':'05',
                          'june':'06','july':'07','august':'08','september':'09','october':'10',
                          'november':'11','december':'12',
                          'jan':'01','feb':'02','mar':'03','apr':'04','jun':'06',
                          'jul':'07','aug':'08','sep':'09','oct':'10','nov':'11','dec':'12'}
            m = _re.match(r'^([a-zA-Z]+)\s+(\d{4})', mo_raw.strip())
            if m:
                mo_num = _mon_names.get(m.group(1).lower())
                if mo_num:
                    month = f"{m.group(2)}-{mo_num}"
        # 3. MM/YYYY or M/YYYY
        if not month:
            m = _re.match(r'^(\d{1,2})[/\-](\d{4})$', mo_raw.strip())
            if m:
                month = f"{m.group(2)}-{m.group(1).zfill(2)}"
        # 4. Generic fallback
        if not month:
            month = _normalize_date(mo_raw)
            if month:
                month = month[:7]
        if not month:
            continue

        try:
            revenue = float(_re.sub(r'[^\d.]', '', rev_raw.replace(',', '')))
        except ValueError:
            continue
        if revenue <= 0:
            continue

        prop_id = _infer_prop_from_listing(listing) if listing else None
        results.append({
            'month':          month,
            'rental_revenue': revenue,
            'listing_name':   listing,
            'prop_id':        prop_id,
        })
    return results


def _parse_pl_bookings_csv(header_row, data_rows):
    """Parse a PriceLabs (or similar) bookings CSV into booking dicts.
    Returns (bookings_list, debug_dict).
    debug_dict contains 'col_map', 'headers_norm', and 'skip_counts'.
    """
    def _norm(s):
        """Normalise a header/name: lowercase, collapse all non-alpha/digit to underscore."""
        return _re.sub(r'[\s\-&/().,]+', '_', s.strip().lower()).strip('_')

    h_raw  = [hdr.strip() for hdr in header_row]
    h      = [_norm(hdr) for hdr in h_raw]

    def _col_idx(*names):
        """Find column index: exact match first, then substring partial match."""
        candidates = [_norm(n) for n in names]
        # 1) Exact match
        for n in candidates:
            if n in h:
                return h.index(n)
        # 2) Partial: any header that CONTAINS the candidate (longer header, shorter name)
        for n in candidates:
            if len(n) < 3:
                continue
            for i, hv in enumerate(h):
                if n in hv:
                    return i
        # 3) Partial reverse: candidate contains the header (shorter header, longer name)
        for n in candidates:
            if len(n) < 3:
                continue
            for i, hv in enumerate(h):
                if len(hv) >= 3 and hv in n:
                    return i
        return -1

    def _get(row, idx):
        if idx < 0 or idx >= len(row):
            return ''
        return row[idx].strip()

    def parse_money(s):
        if not s:
            return None
        cleaned = _re.sub(r'[^\d.]', '', s.replace(',', ''))
        try:
            return float(cleaned) if cleaned else None
        except ValueError:
            return None

    # Build column map once
    col_map = {
        'listing':   _col_idx('listing_name','property_name','listing','property',
                              'unit_name','unit','name','property_title','rental_name'),
        'check_in':  _col_idx('check_in','checkin','check_in_date','arrival',
                              'arrival_date','start_date','from','date_in','in_date'),
        'check_out': _col_idx('check_out','checkout','check_out_date','departure',
                              'departure_date','end_date','to','date_out','out_date'),
        'booked_dt': _col_idx('booked_date','booking_date','date_booked',
                              'reservation_date','created','created_at','booked'),
        'nights':    _col_idx('nights','night_count','duration','length_of_stay',
                              'num_nights','stay_length','los'),
        'adr':       _col_idx('adr','average_daily_rate','nightly_rate','daily_rate',
                              'avg_nightly_rate','rate'),
        'revenue':   _col_idx('rental_revenue','revenue','total_revenue','booking_revenue',
                              'net_revenue','gross_revenue','payout','total_payout',
                              'earnings','gross_earnings','accommodation_fare',
                              'host_earnings','net_payout','host_payout'),
        'status':    _col_idx('status','reservation_status','booking_status','state'),
        'channel':   _col_idx('channel','source','platform','booking_source','pms',
                              'booking_channel','ota'),
        'conf_code': _col_idx('confirmation_code','confirmation','reservation_id',
                              'booking_id','code','ref','reference'),
    }

    logger.debug("[CSV BOOKINGS] headers_raw=%s", h_raw[:12])
    logger.debug("[CSV BOOKINGS] headers_norm=%s", h[:12])
    logger.debug("[CSV BOOKINGS] col_map=%s", col_map)

    skip_no_listing  = 0
    skip_no_checkin  = 0
    skip_cancelled   = 0
    skip_future_only = 0

    bookings = []
    for row in data_rows:
        if not any(c.strip() for c in row):
            continue

        listing   = _get(row, col_map['listing'])
        raw_ci    = _get(row, col_map['check_in'])
        raw_co    = _get(row, col_map['check_out'])
        raw_bd    = _get(row, col_map['booked_dt'])
        status    = _get(row, col_map['status']) or 'confirmed'

        if not listing:
            skip_no_listing += 1
            continue
        if 'cancel' in status.lower():
            skip_cancelled += 1
            continue

        # Try to get month from check_in first, then check_out, then booked_date
        month_key = (_extract_month_key(raw_ci) or
                     _extract_month_key(raw_co) or
                     _extract_month_key(raw_bd))
        if not month_key:
            skip_no_checkin += 1
            continue

        # Best-effort full date parse; fall back to first of month
        check_in  = _normalize_date(raw_ci) or f"{month_key}-01"
        check_out = _normalize_date(raw_co)
        booked_dt = _normalize_date(raw_bd)

        nights_s  = _get(row, col_map['nights'])
        adr_s     = _get(row, col_map['adr'])
        rev_s     = _get(row, col_map['revenue'])
        channel   = _get(row, col_map['channel']) or ''
        conf_code = _get(row, col_map['conf_code']) or ''

        nights  = int(float(nights_s)) if nights_s and _re.match(r'^\d+(\.\d+)?$', nights_s.strip()) else None
        adr     = parse_money(adr_s)
        revenue = parse_money(rev_s)
        if revenue is None and adr and nights:
            revenue = round(adr * nights, 2)

        prop_id = _infer_prop_from_listing(listing)

        bookings.append({
            'listing_name':   listing,
            'prop_id':        prop_id,
            'check_in':       check_in,
            'check_out':      check_out,
            'booked_date':    booked_dt,
            'nights':         nights,
            'adr':            adr,
            'rental_revenue': revenue,
            'status':         status,
            'channel':        channel,
            'conf_code':      conf_code,
        })

    skip_counts = {
        'no_listing':  skip_no_listing,
        'no_checkin':  skip_no_checkin,
        'cancelled':   skip_cancelled,
    }
    logger.warning("[CSV BOOKINGS] Parsed %s, skipped=%s", len(bookings), skip_counts)
    debug = {
        'col_map':      col_map,
        'headers_norm': h[:20],
        'headers_raw':  h_raw[:20],
        'skip_counts':  skip_counts,
    }
    return bookings, debug


@app.route("/api/analytics/pricelabs/listings")
def pricelabs_listings():
    """Fetch all PriceLabs listings, extract clean names, auto-map by city, persist to store."""
    try:
        data = _pricelabs_get("/listings")

        # Response: {"listings": [...]}  or  just [...]
        if isinstance(data, list):
            listings = data
        else:
            listings = data.get("listings") or data.get("data") or []

        store   = load_store()
        mapping = store.get("pricelabs_mapping", {})          # prop_id → pl_id (manual)
        rev     = {str(v): k for k, v in mapping.items()}     # pl_id   → prop_id

        result       = []
        name_by_plid = {}   # pl_id   → full Airbnb name
        name_by_prop = {}   # prop_id → list of full Airbnb names

        for l in listings:
            lid      = str(l.get("id") or l.get("listing_id") or "")
            raw_name = (l.get("name") or lid).strip()
            short, full = _pl_parse_name(raw_name)
            city     = (l.get("city_name") or "").lower().strip()

            # Determine prop_id: manual mapping wins, then city auto-map, then name match
            city_map = _build_city_to_prop(store)
            pid = rev.get(lid) or city_map.get(city) or _pl_prop_from_name(raw_name, store)

            # Canonical short name for UI ("Lockwood 1", "22 B", etc.)
            canonical = _pl_canonical_short(short, pid) if pid else short

            name_by_plid[lid] = canonical          # pl_id → "Lockwood 1"
            if pid:
                name_by_prop.setdefault(pid, []).append(canonical)

            result.append({
                "id":                    lid,
                "short_label":           short,   # "Unit 2"
                "name":                  full,    # "Unit 2 · Modern EaDo Apartment Near Downtown"
                "city":                  l.get("city_name", ""),
                "state":                 l.get("state", ""),
                "country":               l.get("country", ""),
                "bedrooms":              l.get("no_of_bedrooms"),
                "latitude":              l.get("latitude"),
                "longitude":             l.get("longitude"),
                "pms":                   l.get("pms"),
                "base_price":            l.get("base"),
                "min_price":             l.get("min"),
                "max_price":             l.get("max"),
                "cleaning_fee":          l.get("cleaning_fees"),
                "recommended_base":      l.get("recommended_base_price"),
                "occ_next_30":           l.get("occupancy_next_30"),
                "occ_next_60":           l.get("occupancy_next_60"),
                "occ_past_30":           l.get("occupancy_past_30"),
                "occ_past_60":           l.get("occupancy_past_60"),
                "market_occ_next_30":    l.get("market_occupancy_next_30"),
                "market_occ_next_60":    l.get("market_occupancy_next_60"),
                "market_occ_past_30":    l.get("market_occupancy_past_30"),
                "market_occ_past_60":    l.get("market_occupancy_past_60"),
                "booking_pickup_60":     l.get("booking_pickup_past_60"),
                "push_enabled":          l.get("push_enabled"),
                "last_pushed":           l.get("last_date_pushed"),
                "group":                 l.get("group"),
                "subgroup":              l.get("subgroup"),
                "tags":                  l.get("tags"),
                "notes":                 l.get("notes"),
                "canonical_name":         canonical,   # "Lockwood 1", "22 B"
                "prop_id":               pid,
            })

        # Sort result: by prop_id then by unit number within prop
        def _sort_key(r):
            m = re.search(r'\d+', r.get("canonical_name",""))
            return (r.get("prop_id",""), int(m.group()) if m else 999)
        result.sort(key=_sort_key)

        logger.info("[PriceLabs] %s listings loaded", len(result))
        for r in result:
            logger.info("%s → \"%s\" (%s) → prop_id=%s", r['id'], r['canonical_name'], r['city'], r['prop_id'])

        # flat_names: {prop_id: "Lockwood 1, Lockwood 2, Lockwood 3, Lockwood 4"}
        flat_names   = {pid: ", ".join(sorted(names, key=lambda n: int(re.search(r'\d+',n).group()) if re.search(r'\d+',n) else 999))
                        for pid, names in name_by_prop.items()}
        # short_names: {pl_id: "Lockwood 1"}  — canonical unit display names
        short_names  = name_by_plid

        store["pricelabs_listing_names"]       = flat_names
        store["pricelabs_listing_names_by_id"] = short_names    # {pl_id: "Lockwood 1"}
        store["pricelabs_short_names"]         = short_names
        store["pricelabs_listings_raw"]        = result
        save_store(store)

        return jsonify({"listings": result, "names": flat_names, "names_by_id": short_names})
    except Exception as e:
        msg, _ = _safe_error(e, "PriceLabs listings")
        return jsonify({"error": msg, "listings": []})


@app.route("/api/pricelabs/diagnose")
def pricelabs_diagnose():
    """Diagnostic: show what PriceLabs data we have and can fetch."""
    # Try authenticated store first, fall back to scanning for any store with PL key
    store = load_store()
    if not store.get("pricelabs_api_key"):
        base = "/data" if _os.path.isdir("/data") else "."
        for f in sorted(_os.listdir(base)):
            if f.startswith("store_") and f.endswith(".json"):
                try:
                    with open(f"{base}/{f}") as fh:
                        s = json.load(fh)
                        if s.get("pricelabs_api_key"):
                            store = s
                            break
                except Exception:
                    continue
    diag = {
        "api_key_set": bool(store.get("pricelabs_api_key")),
        "listings_cached": len(store.get("pricelabs_listings_raw", [])),
        "pl_bookings_count": len(store.get("pl_bookings", [])),
        "short_names": store.get("pricelabs_short_names", {}),
        "mapping": store.get("pricelabs_mapping", {}),
    }
    # Resolve API key from this store
    import urllib.request, urllib.parse, datetime as _dt
    raw_key = store.get("pricelabs_api_key", "")
    api_key = None
    if raw_key:
        try:
            api_key = _decrypt(raw_key)
            diag["key_decrypted"] = True
        except Exception:
            if raw_key.startswith("gAAA"):
                diag["key_decrypted"] = False
                diag["key_error"] = "Encrypted key unrecoverable — re-save in Settings"
            else:
                api_key = raw_key
                diag["key_decrypted"] = "plaintext"
    if not api_key:
        diag["error"] = "No usable API key"
        return jsonify(diag)
    headers = {"X-API-Key": api_key, "Accept": "application/json",
               "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}
    # Test /listings
    listings = store.get("pricelabs_listings_raw", [])
    if not listings:
        try:
            url = PRICELABS_BASE + "/listings"
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as r:
                raw_listings = json.loads(r.read().decode())
            ls = raw_listings if isinstance(raw_listings, list) else (raw_listings.get("listings") or raw_listings.get("data") or [])
            diag["listings_live"] = {"count": len(ls), "sample_keys": list(ls[0].keys()) if ls else []}
            listings = ls
        except Exception as e:
            diag["listings_live"] = {"error": str(e)}
    # Test /reservation_data with first listing
    if listings:
        lid = str(listings[0].get("id") or listings[0].get("listing_id") or "")
        today = _dt.date.today()
        start = (today - _dt.timedelta(days=30)).isoformat()
        end = (today + _dt.timedelta(days=60)).isoformat()
        for params in [
            {"listing_id": lid, "start_date": start, "end_date": end},
            {"listing_ids": lid, "start_date": start, "end_date": end},
            {"start_date": start, "end_date": end},
        ]:
            label = "res_" + list(params.keys())[0]
            try:
                url = PRICELABS_BASE + "/reservation_data?" + urllib.parse.urlencode(params)
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=15) as r:
                    body = json.loads(r.read().decode())
                diag[label] = {
                    "status": "ok",
                    "type": type(body).__name__,
                    "keys": list(body.keys()) if isinstance(body, dict) else None,
                    "len": len(body) if isinstance(body, list) else None,
                    "sample": json.dumps(body)[:600],
                }
            except urllib.error.HTTPError as e:
                diag[label] = {"http_error": e.code, "body": e.read().decode()[:300]}
            except Exception as e:
                diag[label] = {"error": str(e)}
    # Show existing pl_bookings
    bks = store.get("pl_bookings", [])
    if bks:
        diag["sample_bookings"] = bks[:3]
    return jsonify(diag)


@app.route("/api/pricelabs/sync-reservations", methods=["POST"])
def pricelabs_sync_reservations():
    """Trigger a reservation data sync from PriceLabs API. Stores results as pl_bookings."""
    try:
        store = load_store()
        count = _sync_pricelabs_reservations(store)
        bookings = store.get("pl_bookings", [])
        return jsonify({"ok": True, "fetched": count, "total_bookings": len(bookings)})
    except Exception as e:
        msg, _ = _safe_error(e, "PriceLabs reservation sync")
        return jsonify({"ok": False, "error": msg}), 500


@app.route("/api/pricelabs/raw/reservation_data")
def pricelabs_raw_reservation_data():
    """
    Debug endpoint: tries GET and POST variations of /v1/reservation_data.
    """
    import urllib.request, urllib.parse

    store   = load_store()
    # Dynamic: read listing IDs from user's cached PriceLabs listings
    cached_listings = store.get("pricelabs_listings_raw", [])
    LISTING_IDS = [str(l.get("id") or "") for l in cached_listings if l.get("id")]
    if not LISTING_IDS:
        return jsonify({"error": "No PriceLabs listings cached — sync listings first"}), 400
    START = "2025-10-01"
    END   = "2026-12-31"
    try:
        api_key = _resolve_pl_key(store)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 400
    HEADERS = {
        "X-API-Key":    api_key,
        "Accept":       "application/json",
        "Content-Type": "application/json",
        "User-Agent":   "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    }

    def do_get(params=None):
        url = PRICELABS_BASE + "/reservation_data"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers=HEADERS)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return {"status": r.status, "body": json.loads(r.read().decode())}
        except urllib.error.HTTPError as e:
            return {"http_error": e.code, "body": e.read().decode("utf-8","replace")}
        except Exception as ex:
            return {"exception": str(ex)}

    def do_post(payload):
        url = PRICELABS_BASE + "/reservation_data"
        data = json.dumps(payload).encode()
        req = urllib.request.Request(url, data=data, headers=HEADERS, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return {"status": r.status, "body": json.loads(r.read().decode())}
        except urllib.error.HTTPError as e:
            return {"http_error": e.code, "body": e.read().decode("utf-8","replace")}
        except Exception as ex:
            return {"exception": str(ex)}

    results = {
        # GET attempts
        "get_no_params":          do_get(),
        "get_dates_only":         do_get({"start_date": START, "end_date": END}),
        "get_listing_ids_csv":    do_get({"listing_ids": ",".join(LISTING_IDS), "start_date": START, "end_date": END}),
        "get_single_listing_id":  do_get({"listing_id": LISTING_IDS[0], "start_date": START, "end_date": END}),
        # POST attempts
        "post_empty":             do_post({}),
        "post_dates_only":        do_post({"start_date": START, "end_date": END}),
        "post_listing_ids_array": do_post({"listing_ids": LISTING_IDS, "start_date": START, "end_date": END}),
        "post_listing_ids_csv":   do_post({"listing_ids": ",".join(LISTING_IDS), "start_date": START, "end_date": END}),
        "post_single_listing":    do_post({"listing_id": LISTING_IDS[0], "start_date": START, "end_date": END}),
    }
    return jsonify(results)


@app.route("/api/pricelabs/config")
def pricelabs_config_get():
    """Return current PriceLabs config for settings page persistence."""
    store   = load_store()
    raw_key = store.get("pricelabs_api_key", "")
    api_key = ""
    if raw_key:
        try:
            api_key = _resolve_pl_key(store)
        except Exception:
            api_key = raw_key  # backward compat: legacy plaintext keys
    preview = ""
    if api_key:
        preview = api_key[:4] + "••••" + api_key[-4:] if len(api_key) > 8 else "••••"
    return jsonify({
        "api_key_set":     bool(api_key),
        "api_key_preview": preview,
        "listings":        store.get("pricelabs_listings_raw", []),
        "short_names":     store.get("pricelabs_short_names", {}),
    })


@app.route("/api/pricelabs/names")
def pricelabs_names():
    """Return stored PriceLabs names: by prop_id and by individual listing id."""
    store = load_store()
    return jsonify({
        "names":       store.get("pricelabs_listing_names", {}),       # {prop_id: "Unit 1, Unit 2, ..."}
        "names_by_id": store.get("pricelabs_listing_names_by_id", {}), # {pl_id: "Unit 2"}
        "listings":    store.get("pricelabs_listings_raw", []),         # full listing data
    })


def _parse_pl_pct(s):
    """'55 %' → 55.0, None on failure."""
    if s is None:
        return None
    try:
        return float(str(s).replace("%", "").strip())
    except (ValueError, TypeError):
        return None


@app.route("/api/pricelabs/stats")
def pricelabs_stats():
    """
    Per-listing and per-property occupancy + revenue estimates from cached PriceLabs data.
    Frontend uses this for the Home 30-day snapshot and Money per-property breakdown.
    No live API call — reads from store (updated by /api/analytics/pricelabs/listings).
    """
    store    = load_store()
    listings = store.get("pricelabs_listings_raw", [])

    result = []
    for l in listings:
        # stored keys (from pricelabs_listings): occ_next_30, recommended_base, etc.
        base   = float(l.get("recommended_base") or l.get("base_price") or 0)
        o_n30  = _parse_pl_pct(l.get("occ_next_30"))
        o_n60  = _parse_pl_pct(l.get("occ_next_60"))
        o_p30  = _parse_pl_pct(l.get("occ_past_30"))
        o_p60  = _parse_pl_pct(l.get("occ_past_60"))
        mo_n30 = _parse_pl_pct(l.get("market_occ_next_30"))
        mo_p30 = _parse_pl_pct(l.get("market_occ_past_30"))

        result.append({
            "id":              l.get("id"),
            "name":            l.get("name", ""),
            "canonical_name":  l.get("canonical_name", ""),
            "prop_id":         l.get("prop_id", ""),
            "base_price":      base,
            "occ_next_30":     o_n30,
            "occ_next_60":     o_n60,
            "occ_past_30":     o_p30,
            "occ_past_60":     o_p60,
            "market_occ_next_30": mo_n30,
            "market_occ_past_30": mo_p30,
            # Simple revenue estimate: base_price × occupancy × 30 days
            "est_rev_next_30": round(base * (o_n30 / 100) * 30) if o_n30 is not None else None,
            "est_rev_past_30": round(base * (o_p30 / 100) * 30) if o_p30 is not None else None,
            "booking_pickup_60": l.get("booking_pickup_past_60"),
        })

    # Roll up to property level
    by_prop = {}
    for item in result:
        pid = item.get("prop_id")
        if not pid:
            continue
        if pid not in by_prop:
            by_prop[pid] = []
        by_prop[pid].append(item)

    prop_summary = {}
    for pid, items in by_prop.items():
        on30_vals  = [i["occ_next_30"]     for i in items if i["occ_next_30"]     is not None]
        op30_vals  = [i["occ_past_30"]     for i in items if i["occ_past_30"]     is not None]
        rev_n_vals = [i["est_rev_next_30"] for i in items if i["est_rev_next_30"] is not None]
        rev_p_vals = [i["est_rev_past_30"] for i in items if i["est_rev_past_30"] is not None]
        prop_summary[pid] = {
            "avg_occ_next_30":  round(sum(on30_vals) / len(on30_vals), 1) if on30_vals else None,
            "avg_occ_past_30":  round(sum(op30_vals) / len(op30_vals), 1) if op30_vals else None,
            "est_rev_next_30":  sum(rev_n_vals) if rev_n_vals else None,
            "est_rev_past_30":  sum(rev_p_vals) if rev_p_vals else None,
            "unit_count":       len(items),
            "low_occ_alert":    any(v < 50 for v in on30_vals) if on30_vals else False,
            "units":            items,
        }

    return jsonify({"listings": result, "by_prop": prop_summary})


@app.route("/api/raw/pricelabs/listings")
def raw_pricelabs_listings():
    """
    Zero-transformation passthrough: fetch /v1/listings from PriceLabs and
    return the exact JSON the API sends back. Also prints to server logs.
    """
    import urllib.request, urllib.error
    try:
        api_key = _resolve_pl_key()
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 400

    url = "https://api.pricelabs.co/v1/listings"
    req = urllib.request.Request(url, headers={
        "X-API-Key": api_key,
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read().decode("utf-8")
        logger.debug("=" * 60)
        logger.debug("RAW PRICELABS /v1/listings")
        logger.debug("%s", raw)
        logger.debug("=" * 60)
        return raw, 200, {"Content-Type": "application/json"}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        logger.error("[RAW PRICELABS ERROR] HTTP %s: %s", e.code, body)
        return jsonify({"error": f"HTTP {e.code}", "body": body}), 502
    except Exception as ex:
        logger.error("[RAW PRICELABS ERROR] %s", ex)
        return jsonify({"error": str(ex)}), 502







@app.route("/api/analytics/pricelabs/map", methods=["POST"])
def pricelabs_map():
    """
    Save prop_id → PriceLabs listing_id mappings.
    Body: {"mapping": {"lockwood": "12345", "everton": "67890"}}
    """
    body    = request.json or {}
    store   = load_store()
    mapping = store.get("pricelabs_mapping", {})
    mapping.update(body.get("mapping", {}))
    store["pricelabs_mapping"] = mapping
    save_store(store)
    return jsonify({"ok": True, "mapping": mapping})


@app.route("/api/analytics/pricelabs/<prop_id>")
def analytics_pricelabs_listing(prop_id):
    """PriceLabs recommended prices + listing config for a single property."""
    start, end = _analytics_range(request)
    return jsonify(_fetch_pricelabs_listing(prop_id, start, end))


@app.route("/api/analytics/pricelabs")
def analytics_pricelabs_all():
    """PriceLabs data for all mapped STR listings."""
    store   = load_store()
    mapping = store.get("pricelabs_mapping", {})
    start, end = _analytics_range(request)
    results = {p: _fetch_pricelabs_listing(p, start, end)
               for p in STR_PROPERTIES if p in mapping}
    return jsonify({
        "results":  results,
        "unmapped": [p for p in STR_PROPERTIES if p not in mapping],
    })


# ── Per-property monthly income ───────────────────────────────────────────────
# Airbnb payouts from Plaid cannot be split per-property, so revenue is entered
# manually per property per month.
# store["property_income"] = {prop_id: {"YYYY-MM": {revenue, cleaning_fees, payout_total}}}


@app.route("/api/income/property", methods=["GET"])
def get_property_income():
    """Return all per-property income records plus the legacy portfolio total."""
    store = load_store()
    return jsonify({
        "property_income": store.get("property_income", {}),
        "manual_income":   store.get("manual_income",   {}),
    })


@app.route("/api/income/property", methods=["POST"])
def save_property_income():
    """
    Upsert income entries for one or many properties.
    Body: {"entries": [
        {"prop_id": "lockwood", "month": "2026-02",
         "revenue": 3200, "cleaning_fees": 250, "payout_total": 3450}
    ]}
    """
    body    = request.json or {}
    entries = body.get("entries", [])
    store   = load_store()
    pi      = store.get("property_income", {})
    for e in entries:
        pid   = (e.get("prop_id") or "").strip()
        month = (e.get("month")   or "").strip()
        if not pid or not month:
            continue
        if pid not in pi:
            pi[pid] = {}
        pi[pid][month] = {
            "revenue":       float(e.get("revenue")       or 0),
            "cleaning_fees": float(e.get("cleaning_fees") or 0),
            "payout_total":  float(e.get("payout_total")  or 0),
        }
    store["property_income"] = pi
    save_store(store)
    return jsonify({"ok": True, "updated": len(entries)})


@app.route("/api/income/csv", methods=["POST"])
def upload_income_csv():
    """
    Upload property income data as CSV.
    Accepts multipart/form-data (field name: 'file') or JSON body {"csv": "<raw text>"}.
    Expected columns (flexible header matching):
        property_name | month | revenue | cleaning_fees | payout_total
    Month formats accepted: YYYY-MM, MM/YYYY, MMM YYYY, MMMM YYYY
    Property names matched to prop_ids case-insensitively.
    """
    import csv, io
    from datetime import datetime as _dtt

    # ── Read raw CSV text ─────────────────────────────────────────────────────
    raw_csv = ""
    if request.content_type and "multipart" in request.content_type:
        f = request.files.get("file")
        if not f:
            return jsonify({"error": "No 'file' field in form data"}), 400
        raw_csv = f.read().decode("utf-8", errors="replace")
    else:
        raw_csv = (request.json or {}).get("csv", "")
    if not raw_csv.strip():
        return jsonify({"error": "Empty CSV"}), 400

    # ── Parse ─────────────────────────────────────────────────────────────────
    reader      = csv.DictReader(io.StringIO(raw_csv))
    raw_headers = reader.fieldnames or []

    def _norm(s):
        return re.sub(r"[\s\-]+", "_", (s or "").lower().strip())

    col_map = {_norm(h): h for h in raw_headers}

    def _col(row, *keys):
        for k in keys:
            if k in col_map:
                v = row.get(col_map[k], "").strip()
                if v:
                    return v
        return ""

    def _parse_month(s):
        s = s.strip()
        for fmt in ("%Y-%m", "%m/%Y", "%m-%Y", "%b %Y", "%B %Y", "%b %y", "%B %y"):
            try:
                return _dtt.strptime(s, fmt).strftime("%Y-%m")
            except ValueError:
                pass
        return None

    def _money(s):
        s = re.sub(r"[,$\s]", "", s or "")
        try:
            return float(s)
        except Exception:
            return 0.0

    # Build dynamic prop label mapping from user's properties
    _user_props = _get_user_properties(store)
    _prop_labels = {}
    for _p in _user_props:
        _pid = _p.get("id") or _p.get("name")
        if not _pid:
            continue
        # Map various forms of the property name/label/id to its canonical id
        for _field in ("id", "name", "label", "short_label"):
            _val = (_p.get(_field) or "").lower().strip()
            if _val and _val not in _prop_labels:
                _prop_labels[_val] = _pid
        # Also map with underscores/spaces normalized
        _pid_lower = _pid.lower()
        _prop_labels[_pid_lower] = _pid
        _prop_labels[_pid_lower.replace("_", " ")] = _pid
        _prop_labels[_pid_lower.replace(" ", "_")] = _pid

    entries = []
    errors  = []
    for i, row in enumerate(reader, start=2):
        prop_raw  = _col(row, "property_name", "property", "prop", "listing")
        month_raw = _col(row, "month", "date", "period")
        rev_raw   = _col(row, "revenue", "gross_revenue", "gross")
        clean_raw = _col(row, "cleaning_fees", "cleaning_fee", "cleaning")
        pay_raw   = _col(row, "payout_total", "payout", "net", "total_payout", "total")

        prop_id = _prop_labels.get(prop_raw.lower().strip())
        month   = _parse_month(month_raw)

        if not prop_id:
            errors.append(f"Row {i}: unknown property '{prop_raw}'")
            continue
        if not month:
            errors.append(f"Row {i}: could not parse month '{month_raw}'")
            continue

        entries.append({
            "prop_id":       prop_id,
            "month":         month,
            "revenue":       _money(rev_raw),
            "cleaning_fees": _money(clean_raw),
            "payout_total":  _money(pay_raw),
        })

    if not entries:
        return jsonify({"error": "No valid rows parsed", "row_errors": errors}), 400

    # ── Persist ────────────────────────────────────────────────────────────────
    store = load_store()
    pi    = store.get("property_income", {})
    for e in entries:
        pid = e["prop_id"]
        if pid not in pi:
            pi[pid] = {}
        pi[pid][e["month"]] = {
            "revenue":       e["revenue"],
            "cleaning_fees": e["cleaning_fees"],
            "payout_total":  e["payout_total"],
        }
    store["property_income"] = pi
    save_store(store)
    return jsonify({
        "ok":         True,
        "imported":   len(entries),
        "row_errors": errors,
        "properties": sorted({e["prop_id"] for e in entries}),
    })


# ══════════════════════════════════════════════════════════════
# Revenue Analytics, Advanced Metrics & Cockpit Data Layer
# Prompt 2 extensions
# ══════════════════════════════════════════════════════════════

# ── Reservation–iCal event matching ──────────────────────────────────────────

def _build_reservation_index(reservations):
    """Build {check_in_date: [reservation, ...]} index for fast lookup."""
    idx = {}
    for r in reservations.values():
        ci = r.get("check_in")
        if ci:
            idx.setdefault(ci, []).append(r)
    return idx


def _match_event_to_reservation(ev, res_index, tolerance_days=1):
    """
    Find the best matching reservation for an iCal event.
    Matches on check-in date ± tolerance_days, then on nights if available.
    """
    from datetime import date as _d, timedelta as _td
    ci_str = ev.get("start")
    if not ci_str:
        return None
    try:
        ci = _d.fromisoformat(ci_str)
    except Exception:
        return None

    ev_nights = ev.get("nights")
    for delta in range(tolerance_days + 1):
        for sign in (0, 1, -1):
            candidate = (ci + _td(days=delta * sign)).isoformat()
            if candidate in res_index:
                matches = res_index[candidate]
                # Prefer matching nights count
                for r in matches:
                    r_nights = r.get("nights")
                    if r_nights is None or ev_nights is None or r_nights == ev_nights:
                        return r
                return matches[0]
    return None


# ── Extended analytics ────────────────────────────────────────────────────────

def _compute_extended_analytics(events, store, prop_id, start_date_str, end_date_str):
    """
    Extends _compute_listing_analytics with:
    - Revenue: booked_revenue, projected_revenue, booked_adr, revpar
    - Timing:  avg/median lead time, booking velocity by week
    - Distributions: stay_distribution, demand_curve by month
    - PriceLabs: expected_adr, pricing_mismatches (>15% under recommended)
    - Insight cards: actionable alerts with estimated $ impact
    """
    from datetime import date as _d, timedelta as _td
    from collections import defaultdict
    import statistics as _stats

    base = _compute_listing_analytics(events, prop_id, start_date_str, end_date_str)
    if "error" in base:
        return base

    start_date = _d.fromisoformat(start_date_str)
    end_date   = _d.fromisoformat(end_date_str)

    reservations = store.get("airbnb_reservations", {})
    pl_mapping   = store.get("pricelabs_mapping",    {})
    pl_id        = pl_mapping.get(prop_id)

    # Clip + enrich events with matched reservation data
    res_index       = _build_reservation_index(reservations)
    enriched_events = []
    for ev in events:
        if ev.get("propId") != prop_id or _is_block_event(ev):
            continue
        try:
            s = _d.fromisoformat(ev["start"])
            e = _d.fromisoformat(ev["end"])
        except Exception:
            continue
        s_clip = max(s, start_date)
        e_clip = min(e, end_date)
        if s_clip >= e_clip:
            continue
        matched = _match_event_to_reservation(ev, res_index)
        enriched_events.append({
            **ev,
            "_s":           s_clip,
            "_e":           e_clip,
            "_nights":      (e_clip - s_clip).days,
            "_reservation": matched,
        })

    # ── Revenue ───────────────────────────────────────────────────────────────
    booked_revenue = 0.0
    booked_rates   = []
    lead_times     = []

    for ev in enriched_events:
        r  = ev.get("_reservation")
        pt = r.get("payout_total") if r else None
        if pt is not None:
            booked_revenue += float(pt)
        nr = (r.get("nightly_rate") if r else None) or ev.get("nightly_rate")
        if nr is not None:
            booked_rates.append(float(nr))
        if r:
            bc = r.get("booking_created")
            ci = r.get("check_in") or ev.get("start")
            if bc and ci:
                try:
                    lt = (_d.fromisoformat(ci) - _d.fromisoformat(bc)).days
                    if lt >= 0:
                        lead_times.append(lt)
                except Exception:
                    pass

    available_nights  = base["available_nights"]
    reserved_nights   = base["reserved_nights"]
    booked_adr        = round(sum(booked_rates) / len(booked_rates), 2) if booked_rates else None
    revpar            = round(booked_revenue / available_nights, 2) if available_nights > 0 else None
    projected_revenue = (round(booked_adr * available_nights * base["occupancy_rate"], 2)
                         if booked_adr and available_nights > 0 else None)

    avg_lead_time    = round(_stats.mean(lead_times),   1) if lead_times else None
    median_lead_time = round(_stats.median(lead_times), 1) if lead_times else None

    # ── Booking velocity — bookings created per ISO week ─────────────────────
    weekly_counts = defaultdict(int)
    for ev in enriched_events:
        r = ev.get("_reservation")
        if r and r.get("booking_created"):
            try:
                bc = _d.fromisoformat(r["booking_created"])
                weekly_counts[bc.strftime("%G-W%V")] += 1
            except Exception:
                pass
    booking_velocity = [{"week": w, "bookings": c}
                        for w, c in sorted(weekly_counts.items())[-8:]]

    # ── Stay length distribution ──────────────────────────────────────────────
    stay_dist = defaultdict(int)
    for ev in enriched_events:
        stay_dist[ev["_nights"]] += 1
    stay_distribution = {str(k): v for k, v in sorted(stay_dist.items())}

    # ── Demand curve — monthly bookings + ADR + occupancy ────────────────────
    mo_demand = defaultdict(lambda: {"bookings": 0, "rates": [], "reserved": 0, "available": 0})
    for ev in enriched_events:
        mo = ev["_s"].strftime("%Y-%m")
        mo_demand[mo]["bookings"] += 1
        r  = ev.get("_reservation")
        nr = (r.get("nightly_rate") if r else None) or ev.get("nightly_rate")
        if nr:
            mo_demand[mo]["rates"].append(float(nr))
    for mo_data in base["monthly_occupancy"]:
        mo = mo_data["month"]
        mo_demand[mo]["reserved"]  = mo_data["reserved"]
        mo_demand[mo]["available"] = mo_data["available"]
    demand_curve = [
        {
            "month":           mo,
            "bookings":        v["bookings"],
            "avg_nightly_rate":round(sum(v["rates"]) / len(v["rates"]), 2) if v["rates"] else None,
            "reserved":        v["reserved"],
            "available":       v["available"],
            "occupancy_rate":  round(v["reserved"] / v["available"], 4) if v["available"] > 0 else 0.0,
        }
        for mo, v in sorted(mo_demand.items())
    ]

    # ── PriceLabs pricing mismatch ────────────────────────────────────────────
    pricing_mismatches = []
    expected_adr       = None
    if pl_id:
        try:
            pl_resp = _pricelabs_get("/listing_prices", {
                "listing_id": pl_id,
                "start_date": start_date_str,
                "end_date":   end_date_str,
            })
            # Normalise to {date: price} regardless of PriceLabs response shape
            pl_calendar = {}
            price_list  = pl_resp if isinstance(pl_resp, list) else (
                pl_resp.get("data") or pl_resp.get("prices") or
                pl_resp.get("result") or [])
            for entry in (price_list if isinstance(price_list, list) else []):
                dt  = entry.get("date") or entry.get("day")
                rec = (entry.get("price") or entry.get("recommended_price") or
                       entry.get("base_price"))
                if dt and rec is not None:
                    try: pl_calendar[dt] = float(rec)
                    except Exception: pass

            # Compare each reservation's rate against PL recommended per night
            for ev in enriched_events:
                r  = ev.get("_reservation")
                nr = (r.get("nightly_rate") if r else None) or ev.get("nightly_rate")
                if nr is None:
                    continue
                nr = float(nr)
                d  = ev["_s"]
                while d < ev["_e"]:
                    ds     = d.isoformat()
                    pl_rec = pl_calendar.get(ds)
                    if pl_rec and pl_rec > 0 and nr / pl_rec < 0.85:
                        pricing_mismatches.append({
                            "date":          ds,
                            "booked_rate":   round(nr,     2),
                            "recommended":   round(pl_rec, 2),
                            "gap":           round(pl_rec - nr, 2),
                            "gap_pct":       round((1 - nr / pl_rec) * 100, 1),
                            "guest":         ev.get("guest_name"),
                            "nights_in_stay":ev["_nights"],
                        })
                    d += _td(days=1)

            # Expected ADR = average PL rate over reserved nights
            res_pl_rates = []
            for ev in enriched_events:
                d = ev["_s"]
                while d < ev["_e"]:
                    v = pl_calendar.get(d.isoformat())
                    if v:
                        res_pl_rates.append(v)
                    d += _td(days=1)
            if res_pl_rates:
                expected_adr = round(sum(res_pl_rates) / len(res_pl_rates), 2)

        except Exception as pl_err:
            logger.error("PriceLabs extended analytics error for %s: %s", prop_id, pl_err)

    insight_cards = _generate_insight_cards(
        base, booked_adr, expected_adr, pricing_mismatches, prop_id)

    return {
        **base,
        "booked_revenue":    round(booked_revenue, 2),
        "projected_revenue": projected_revenue,
        "booked_adr":        booked_adr,
        "expected_adr":      expected_adr,
        "revpar":            revpar,
        "avg_lead_time":     avg_lead_time,
        "median_lead_time":  median_lead_time,
        "booking_velocity":  booking_velocity,
        "stay_distribution": stay_distribution,
        "demand_curve":      demand_curve,
        "pricing_mismatches":pricing_mismatches,
        "underpriced_nights":len(pricing_mismatches),
        "insight_cards":     insight_cards,
    }


def _generate_insight_cards(base, booked_adr, expected_adr, pricing_mismatches, prop_id):
    """Generate structured insight alerts with estimated $ impact."""
    from datetime import date as _d
    cards = []

    # ── Orphan gaps ───────────────────────────────────────────────────────────
    orphan_count = base.get("orphan_gaps", 0)
    if orphan_count > 0 and booked_adr:
        estimated_gain = round(orphan_count * 1.5 * booked_adr)
        mo = _d.today().strftime("%B")
        cards.append({
            "type":       "orphan_gap",
            "severity":   "opportunity",
            "listing":    prop_id,
            "title":      f"{orphan_count} orphan gap{'s' if orphan_count > 1 else ''} this month",
            "message":    (
                f"{prop_id.title()} has {orphan_count} unbooked 1-2 night "
                f"gap{'s' if orphan_count > 1 else ''} in {mo} — "
                f"filling them adds roughly ${estimated_gain:,}"
            ),
            "impact_usd": estimated_gain,
        })

    # ── Weekday vs weekend occupancy gap ─────────────────────────────────────
    w_occ  = base.get("weekend_occupancy", 0)
    wd_occ = base.get("weekday_occupancy", 0)
    if w_occ > 0 and wd_occ < w_occ * 0.7:
        gap_pct = round((w_occ - wd_occ) * 100)
        cards.append({
            "type":     "weekday_occupancy",
            "severity": "warning",
            "listing":  prop_id,
            "title":    "Weekday occupancy significantly below weekend",
            "message":  (
                f"{prop_id.title()} weekday occupancy is {gap_pct}% below weekend "
                f"({round(wd_occ * 100)}% vs {round(w_occ * 100)}%) — "
                f"consider lowering weekday minimum stay or pricing"
            ),
            "gap_pct":  gap_pct,
        })

    # ── ADR vs PriceLabs expected ─────────────────────────────────────────────
    if booked_adr and expected_adr and booked_adr < expected_adr * 0.90:
        diff = round(expected_adr - booked_adr, 2)
        cards.append({
            "type":     "adr_below_expected",
            "severity": "warning",
            "listing":  prop_id,
            "title":    f"ADR ${diff:.0f} below PriceLabs recommended",
            "message":  (
                f"{prop_id.title()} average booked rate is ${booked_adr} vs "
                f"PriceLabs expected ${expected_adr} — ${diff:.0f} gap per night"
            ),
            "booked_adr":  booked_adr,
            "expected_adr":expected_adr,
            "gap_usd":     diff,
        })

    # ── Top 3 most costly individual pricing mismatches ───────────────────────
    top_mm = sorted(pricing_mismatches, key=lambda x: x["gap"], reverse=True)[:3]
    for mm in top_mm:
        total_gap = round(mm["gap"] * mm["nights_in_stay"], 2)
        cards.append({
            "type":        "pricing_mismatch",
            "severity":    "opportunity",
            "listing":     prop_id,
            "title":       f"Underpriced booking on {mm['date']}",
            "message":     (
                f"{prop_id.title()} {mm['date']} booked at ${mm['booked_rate']} "
                f"but PriceLabs recommends ${mm['recommended']} — "
                f"you left ~${total_gap:.0f} on the table"
            ),
            "date":        mm["date"],
            "booked_rate": mm["booked_rate"],
            "recommended": mm["recommended"],
            "impact_usd":  total_gap,
        })

    return cards


# ── Extended analytics routes ─────────────────────────────────────────────────

@app.route("/api/analytics/listing/<prop_id>/extended")
def analytics_listing_extended(prop_id):
    """Extended per-listing analytics: revenue, PriceLabs comparison, insight cards."""
    store  = load_store()
    events = _ical_to_events(store)
    start, end = _analytics_range(request)
    return jsonify(_compute_extended_analytics(events, store, prop_id, start, end))


@app.route("/api/analytics/portfolio/extended")
def analytics_portfolio_extended():
    """Extended portfolio analytics across all STR listings."""
    store  = load_store()
    events = _ical_to_events(store)
    start, end = _analytics_range(request)

    listings = {}
    for prop_id in STR_PROPERTIES:
        data = _compute_extended_analytics(events, store, prop_id, start, end)
        if "error" not in data:
            listings[prop_id] = data

    if not listings:
        return jsonify({"listings": {}, "portfolio": {}})

    total_rev    = sum(v.get("booked_revenue", 0)              for v in listings.values())
    proj_rev     = sum(v.get("projected_revenue") or 0         for v in listings.values())
    total_avail  = sum(v["available_nights"]                   for v in listings.values())
    total_res    = sum(v["reserved_nights"]                    for v in listings.values())
    port_revpar  = round(total_rev / total_avail, 2)           if total_avail  > 0 else None
    adr_list     = [v["booked_adr"] for v in listings.values() if v.get("booked_adr")]
    port_adr     = round(sum(adr_list) / len(adr_list), 2)     if adr_list else None
    all_cards    = sorted(
        [c for v in listings.values() for c in v.get("insight_cards", [])],
        key=lambda c: c.get("impact_usd", 0), reverse=True)

    by_occ = sorted(listings.items(), key=lambda x: x[1]["occupancy_rate"],       reverse=True)
    by_rev = sorted(listings.items(), key=lambda x: x[1].get("booked_revenue", 0), reverse=True)

    return jsonify({
        "listings": listings,
        "portfolio": {
            "total_booked_revenue":   round(total_rev, 2),
            "projected_revenue":      round(proj_rev,  2),
            "portfolio_occupancy":    round(total_res / total_avail, 4) if total_avail > 0 else 0,
            "portfolio_revpar":       port_revpar,
            "portfolio_adr":          port_adr,
            "total_available_nights": total_avail,
            "total_reserved_nights":  total_res,
            "best_listing":           by_occ[0][0]  if by_occ else None,
            "weakest_listing":        by_occ[-1][0] if by_occ else None,
            "highest_revenue_listing":by_rev[0][0]  if by_rev else None,
            "all_insight_cards":      all_cards[:10],
        },
    })


# ── Cockpit data API ──────────────────────────────────────────────────────────
# Returns verified, traceable monthly financials.
# Design rules:
#   1. % change shown ONLY when prior month has data (no fabricated comparisons)
#   2. Manual income overrides Plaid Airbnb revenue for that month
#   3. Each bucket includes tx IDs for drilldown — every number is traceable
#   4. Revenue and expense numbers match the M-object logic in the frontend

@app.route("/api/cockpit")
def cockpit_data():
    """
    Verified monthly financial summary with full traceability.
    ?month=YYYY-MM  (defaults to current month)
    """
    # Phase 6: per-user response cache (60s TTL)
    uid = getattr(g, 'user_id', None)
    month_param = request.args.get("month", "")
    cache_key = f"cockpit:{month_param}"
    if uid:
        cached = _get_cached_response(cache_key, uid, 60)
        if cached is not None:
            return jsonify(cached)

    from datetime import date as _d, timedelta as _td

    today     = _d.today()
    month_str = request.args.get("month", today.strftime("%Y-%m"))
    try:
        year, mo = map(int, month_str.split("-"))
        _d(year, mo, 1)          # validate
    except Exception:
        return jsonify({"error": "Invalid month, use YYYY-MM"}), 400

    prev_date = (_d(year, mo, 1) - _td(days=1)).replace(day=1)
    prev_str  = prev_date.strftime("%Y-%m")

    store    = load_store()
    tags     = store.get("tags",           {})
    txs_dict = store.get("transactions",   {})
    manual   = store.get("manual_income",  {})
    prop_inc = store.get("property_income",{})

    # Dynamic property IDs from user's store (no more hardcoded lists)
    user_props = store.get("properties", [])
    all_prop_ids = set(p.get("id") or p.get("name") for p in user_props if p.get("id") or p.get("name"))

    cat_tags = store.get("category_tags", {})
    INCOME_CATS  = {"__rental_income__", "__cleaning_income__"}
    EXCLUDED_CATS = {"__delete__", "__internal_transfer__"}

    def _month_financials(month_key):
        total_rev      = 0.0
        revenue_tx_ids = []
        expenses       = 0.0
        expense_tx_ids = []
        expense_by_prop= {}
        revenue_by_prop= {}

        for tx_id, tx in txs_dict.items():
            if (tx.get("date") or "")[:7] != month_key:
                continue
            if tx.get("pending"):
                continue

            cat_tag = cat_tags.get(tx_id)
            prop_id = tags.get(tx_id)

            # Skip transactions excluded by category tag
            if cat_tag in EXCLUDED_CATS:
                continue
            # Skip legacy excluded property tags
            if prop_id in ("deleted", "transfer"):
                continue

            # Must have at least one tag (property or category) to be included
            if not prop_id and not cat_tag:
                continue

            amount  = abs(tx.get("amount", 0))
            tx_type = tx.get("type", "out")

            # Category tag determines income/expense; falls back to tx_type
            is_income = cat_tag in INCOME_CATS or (not cat_tag and tx_type == "in")

            if is_income:
                if month_key not in manual:
                    total_rev += amount
                    revenue_tx_ids.append(tx_id)
                    if prop_id:
                        revenue_by_prop[prop_id] = revenue_by_prop.get(prop_id, 0.0) + amount
            else:
                expenses += amount
                expense_tx_ids.append(tx_id)
                if prop_id:
                    expense_by_prop[prop_id] = expense_by_prop.get(prop_id, 0.0) + amount

        # Manual income overrides Plaid revenue for this month
        is_manual = False
        if month_key in manual and manual[month_key]:
            total_rev      = float(manual[month_key])
            revenue_tx_ids = []
            is_manual      = True
            revenue_by_prop.clear()

        # Per-property income supplements if no manual_income entry
        if month_key not in manual:
            for pid, months in prop_inc.items():
                if month_key in months:
                    pi = months[month_key]
                    payout = float(pi.get("payout_total") or 0)
                    total_rev += payout
                    if payout:
                        revenue_by_prop[pid] = revenue_by_prop.get(pid, 0.0) + payout

        total_rev_r = round(total_rev, 2)
        total_exp   = round(expenses, 2)
        result = {
            "total_revenue":  total_rev_r,
            "total_expenses": total_exp,
            "net_income":     round(total_rev_r - total_exp, 2),
            "expenses": {
                "total":       total_exp,
                "by_property": {k: round(v, 2) for k, v in expense_by_prop.items()},
                "tx_ids":      expense_tx_ids,
            },
            "revenue": {
                "total":       total_rev_r,
                "tx_ids":      revenue_tx_ids,
                "is_manual":   is_manual,
                "by_property": {k: round(v, 2) for k, v in revenue_by_prop.items()},
            },
        }
        # Backward compat: include "airbnb" and "pierce" keys with dynamic data
        result["airbnb"] = {
            "revenue":   total_rev_r,
            "tx_ids":    revenue_tx_ids,
            "is_manual": is_manual,
        }
        result["pierce"] = {
            "revenue":   0.0,
            "tx_ids":    [],
        }
        return result

    def _safe_pct(cur_val, prev_val):
        """Return % change only when prior month is non-zero (no fabricated comparisons)."""
        if not prev_val:
            return None
        return round(((cur_val - prev_val) / prev_val) * 100, 1)

    cur  = _month_financials(month_str)
    prev = _month_financials(prev_str)

    has_prior = prev["total_revenue"] > 0 or prev["total_expenses"] > 0

    result_data = {
        "month":      month_str,
        "prev_month": prev_str,
        "has_prior_data": has_prior,
        "current":    cur,
        "prior":      prev if has_prior else None,
        "pct_changes": {
            "revenue":    _safe_pct(cur["total_revenue"],         prev["total_revenue"]),
            "expenses":   _safe_pct(cur["total_expenses"],        prev["total_expenses"]),
            "net":        _safe_pct(cur["net_income"],            prev["net_income"]),
            "airbnb_rev": _safe_pct(cur["airbnb"]["revenue"],     prev["airbnb"]["revenue"]),
            "pierce_rev": _safe_pct(cur["pierce"]["revenue"],     prev["pierce"]["revenue"]),
        } if has_prior else None,
        "integrity_note": (
            "% changes are null when prior month has no data. "
            "Revenue uses manual_income override when set. "
            "tx_ids arrays are the source of truth for each number."
        ),
    }
    # Phase 6: cache result
    if uid:
        _set_cached_response(cache_key, uid, result_data)
    return jsonify(result_data)


# ── Property configuration ────────────────────────────────────────────────────
# Defines primary (Airbnb STR) vs secondary ("Other Properties") groupings.
# Drives the app restructure: Airbnb is the main focus; Pierce is secondary.

def _build_default_prop_config(store=None):
    """Build default property config dynamically from the user's actual properties."""
    props = _get_user_properties(store)
    all_ids = [p.get("id") or p.get("name") for p in props if p.get("id") or p.get("name")]
    return {
        "primary_group": {
            "id":          "portfolio",
            "label":       "Property Portfolio",
            "prop_ids":    all_ids,
            "description": "All user properties",
        },
        "secondary_groups": [],
        "excluded_from_analytics": ["transfer", "deleted"],
    }

# Kept for backward compat — will be overridden by store or dynamic builder
_DEFAULT_PROP_CONFIG = _build_default_prop_config()


@app.route("/api/properties/config", methods=["GET"])
def get_properties_config():
    """Return property grouping: primary (Airbnb STR) and secondary (Other)."""
    store  = load_store()
    config = store.get("properties_config") or _build_default_prop_config(store)
    return jsonify(config)


@app.route("/api/properties/config", methods=["POST"])
def save_properties_config():
    """Update property grouping configuration."""
    body   = request.json or {}
    store  = load_store()
    config = store.get("properties_config") or _build_default_prop_config(store)
    for k in ("primary_group", "secondary_groups", "excluded_from_analytics"):
        if k in body:
            config[k] = body[k]
    store["properties_config"] = config
    save_store(store)
    return jsonify({"ok": True, "config": config})


# ── Push Notification endpoints ─────────────────────────────
@app.route("/api/push/register", methods=["POST"])
def push_register():
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    body = request.get_json(force=True) or {}
    token = body.get("token", "")
    if not token:
        return jsonify({"ok": False, "error": "Token required"}), 400
    pt = _load_json_file(PUSH_TOKENS_FILE)
    if uid not in pt:
        pt[uid] = {"tokens": [], "preferences": {
            "cleaning": True, "checkin": True, "inventory": True,
            "financial": True, "milestones": True, "messages": True
        }}
    if token not in pt[uid]["tokens"]:
        pt[uid]["tokens"].append(token)
    _save_json_file(PUSH_TOKENS_FILE, pt)
    return jsonify({"ok": True})

@app.route("/api/push/unregister", methods=["DELETE"])
def push_unregister():
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    body = request.get_json(force=True) or {}
    token = body.get("token", "")
    pt = _load_json_file(PUSH_TOKENS_FILE)
    if uid in pt and token in pt[uid].get("tokens", []):
        pt[uid]["tokens"].remove(token)
        _save_json_file(PUSH_TOKENS_FILE, pt)
    return jsonify({"ok": True})

@app.route("/api/push/preferences", methods=["GET", "POST"])
def push_preferences():
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    pt = _load_json_file(PUSH_TOKENS_FILE)
    entry = pt.get(uid, {"tokens": [], "preferences": {}})
    if request.method == "GET":
        return jsonify(entry.get("preferences", {}))
    body = request.get_json(force=True) or {}
    entry["preferences"] = {**entry.get("preferences", {}), **body}
    pt[uid] = entry
    _save_json_file(PUSH_TOKENS_FILE, pt)
    return jsonify({"ok": True, "preferences": entry["preferences"]})

@app.route("/api/notifications", methods=["GET"])
def get_notifications():
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    notifs = _load_json_file(NOTIFICATIONS_FILE)
    user_notifs = notifs.get(uid, [])
    return jsonify({"notifications": user_notifs[:50], "unread": sum(1 for n in user_notifs if not n.get("read"))})

@app.route("/api/notifications/read", methods=["POST"])
def mark_notifications_read():
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    body = request.get_json(force=True) or {}
    ids = body.get("ids", [])
    notifs = _load_json_file(NOTIFICATIONS_FILE)
    user_notifs = notifs.get(uid, [])
    for n in user_notifs:
        if not ids or n["id"] in ids:
            n["read"] = True
    notifs[uid] = user_notifs
    _save_json_file(NOTIFICATIONS_FILE, notifs)
    return jsonify({"ok": True})

# ── Follow system endpoints ──────────────────────────────────
@app.route("/api/follow/code", methods=["GET"])
def follow_code():
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    users = load_users()
    email, u = _find_user_by_id(users, uid)
    if not u:
        return jsonify({"ok": False, "error": "User not found"}), 404
    code = u.get("follow_code", "")
    if not code:
        code = "PPG-" + secrets.token_hex(3).upper()
        u["follow_code"] = code
        save_users(users)
    return jsonify({"follow_code": code})

@app.route("/api/follow/request", methods=["POST"])
@rate_limit(20, 60)  # 20 per minute — follow requests
def follow_request():
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    body = request.get_json(force=True) or {}
    follow_code = body.get("follow_code", "").strip().upper()
    username = body.get("username", "").strip().lower()

    users = load_users()
    target_id = None
    target_role = None

    for email, u in users.items():
        if follow_code and u.get("follow_code", "").upper() == follow_code:
            target_id = u["id"]
            target_role = u.get("role", "owner")
            break
        if username and (u.get("username", "").lower() == username or email.split("@")[0].lower() == username):
            target_id = u["id"]
            target_role = u.get("role", "owner")
            break

    if not target_id:
        return jsonify({"ok": False, "error": "User not found"}), 404
    if target_id == uid:
        return jsonify({"ok": False, "error": "Cannot follow yourself"}), 400

    # Check for existing follow
    follows = _load_json_file(FOLLOWS_FILE)
    for fid, f in follows.items():
        if f["follower_id"] == uid and f["following_id"] == target_id:
            return jsonify({"ok": False, "error": "Already following or pending", "status": f["status"]}), 409

    # Determine follow type
    _, follower_u = _find_user_by_id(users, uid)
    follower_role = follower_u.get("role", "owner") if follower_u else "owner"

    follow_type = "cleaner" if follower_role == "cleaner" else "investor"

    # Check if target account is private → pending, otherwise auto-approve
    target_private = False
    for email, u in users.items():
        if u["id"] == target_id:
            target_private = u.get("is_private", False)
            break
    follow_status = "pending" if target_private else "approved"

    follow_id = "f_" + secrets.token_hex(6)
    follows[follow_id] = {
        "follower_id": uid,
        "following_id": target_id,
        "type": follow_type,
        "status": follow_status,
        "requested_at": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()),
        "selected_properties": [],
    }
    _save_json_file(FOLLOWS_FILE, follows)

    # Notify the target
    tokens = _get_user_push_tokens(target_id)
    follower_name = ""
    for email, u in users.items():
        if u["id"] == uid:
            follower_name = u.get("username", email)
            break
    follow_data = {"sender_id": uid, "sender_name": follower_name}
    if follow_status == "pending":
        _send_push(tokens, "Follow Request", f"{follower_name} wants to follow you")
        _store_notification(target_id, "follow_request", "Follow Request", f"{follower_name} wants to follow you", follow_data)
    else:
        _send_push(tokens, "New Follower", f"{follower_name} started following you")
        _store_notification(target_id, "follow", "New Follower", f"{follower_name} started following you", follow_data)

    return jsonify({"ok": True, "follow_id": follow_id, "status": follow_status})

@app.route("/api/follow/pending", methods=["GET"])
def follow_pending():
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    follows = _load_json_file(FOLLOWS_FILE)
    users = load_users()
    pending = []
    for fid, f in follows.items():
        if f["following_id"] == uid and f["status"] == "pending":
            name = ""
            role = "owner"
            for email, u in users.items():
                if u["id"] == f["follower_id"]:
                    name = u.get("username", email)
                    role = u.get("role", "owner")
                    break
            pending.append({"id": fid, "username": name, "role": role, "type": f["type"], "requested_at": f["requested_at"]})
    return jsonify({"pending": pending})

@app.route("/api/follow/respond", methods=["POST"])
def follow_respond():
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    body = request.get_json(force=True) or {}
    follow_id = body.get("follow_id", "")
    action = body.get("action", "")
    follows = _load_json_file(FOLLOWS_FILE)
    f = follows.get(follow_id)
    if not f or f["following_id"] != uid:
        return jsonify({"ok": False, "error": "Not found"}), 404
    if action == "approve":
        f["status"] = "approved"
    elif action == "reject":
        f["status"] = "rejected"
    else:
        return jsonify({"ok": False, "error": "Invalid action"}), 400
    follows[follow_id] = f
    _save_json_file(FOLLOWS_FILE, follows)
    return jsonify({"ok": True})

@app.route("/api/follow/following", methods=["GET"])
def follow_following():
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    follows = _load_json_file(FOLLOWS_FILE)
    users = load_users()
    result = []
    for fid, f in follows.items():
        if f["follower_id"] == uid and f["status"] == "approved":
            name = ""
            role = "owner"
            prop_count = 0
            for email, u in users.items():
                if u["id"] == f["following_id"]:
                    name = u.get("username", email)
                    role = u.get("role", "owner")
                    try:
                        s = _load_store_for_user(f["following_id"])
                        prop_count = len(s.get("properties", []))
                    except Exception:
                        logger.warning("Failed to load store for user %s", f.get("following_id"))
                    break
            p_score = _compute_portfolio_score(f["following_id"]) if role != "cleaner" else None
            result.append({
                "id": fid, "user_id": f["following_id"], "username": name, "role": role,
                "type": f["type"], "property_count": prop_count,
                "selected_properties": f.get("selected_properties", []),
                "portfolio_score": p_score,
            })
    return jsonify({"following": result})

@app.route("/api/follow/followers", methods=["GET"])
def follow_followers():
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    follows = _load_json_file(FOLLOWS_FILE)
    users = load_users()
    result = []
    for fid, f in follows.items():
        if f["following_id"] == uid and f["status"] == "approved":
            name = ""
            role = "owner"
            for email, u in users.items():
                if u["id"] == f["follower_id"]:
                    name = u.get("username", email)
                    role = u.get("role", "owner")
                    break
            result.append({
                "id": fid, "user_id": f["follower_id"], "username": name, "role": role,
                "type": f["type"], "selected_properties": f.get("selected_properties", []),
            })
    return jsonify({"followers": result})

@app.route("/api/follow/properties", methods=["POST"])
def follow_properties():
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    body = request.get_json(force=True) or {}
    follow_id = body.get("follow_id", "")
    property_ids = body.get("property_ids", [])
    follows = _load_json_file(FOLLOWS_FILE)
    f = follows.get(follow_id)
    if not f or f["follower_id"] != uid:
        return jsonify({"ok": False, "error": "Not found"}), 404
    f["selected_properties"] = property_ids
    follows[follow_id] = f
    _save_json_file(FOLLOWS_FILE, follows)
    return jsonify({"ok": True})

@app.route("/api/follow/remove", methods=["DELETE"])
def follow_remove():
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    body = request.get_json(force=True) or {}
    follow_id = body.get("follow_id", "")
    follows = _load_json_file(FOLLOWS_FILE)
    f = follows.get(follow_id)
    if not f or (f["follower_id"] != uid and f["following_id"] != uid):
        return jsonify({"ok": False, "error": "Not found"}), 404
    del follows[follow_id]
    _save_json_file(FOLLOWS_FILE, follows)
    return jsonify({"ok": True})

@app.route("/api/profile/privacy", methods=["POST"])
def profile_privacy():
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Not authenticated"}), 401
    body = request.get_json(force=True) or {}
    is_private = bool(body.get("is_private", False))
    users = load_users()
    for email, u in users.items():
        if u["id"] == uid:
            u["is_private"] = is_private
            save_users(users)
            return jsonify({"ok": True, "is_private": is_private})
    return jsonify({"error": "User not found"}), 404

@app.route("/api/follow/approve", methods=["POST"])
def follow_approve():
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    body = request.get_json(force=True) or {}
    follow_id = body.get("follow_id", "")
    follows = _load_json_file(FOLLOWS_FILE)
    f = follows.get(follow_id)
    if not f or f["following_id"] != uid:
        return jsonify({"ok": False, "error": "Not found"}), 404
    f["status"] = "approved"
    follows[follow_id] = f
    _save_json_file(FOLLOWS_FILE, follows)
    # Notify the follower
    tokens = _get_user_push_tokens(f["follower_id"])
    users = load_users()
    owner_name = ""
    for email, u in users.items():
        if u["id"] == uid:
            owner_name = u.get("username", email)
            break
    _send_push(tokens, "Follow Approved", f"{owner_name} accepted your follow request")
    _store_notification(f["follower_id"], "follow", "Follow Approved", f"{owner_name} accepted your follow request",
                        {"sender_id": uid, "sender_name": owner_name})
    return jsonify({"ok": True})

@app.route("/api/follow/reject", methods=["POST"])
def follow_reject():
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    body = request.get_json(force=True) or {}
    follow_id = body.get("follow_id", "")
    follows = _load_json_file(FOLLOWS_FILE)
    f = follows.get(follow_id)
    if not f or f["following_id"] != uid:
        return jsonify({"ok": False, "error": "Not found"}), 404
    del follows[follow_id]
    _save_json_file(FOLLOWS_FILE, follows)
    return jsonify({"ok": True})

# ── US Cities (loaded from JSON — ~30,000 city/state pairs across all 50 states) ──
import os as _os
_cities_path = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "us_cities.json")
try:
    with open(_cities_path, "r") as _cf:
        _raw_cities = json.load(_cf)
    # Support both formats: [{c, s}] (new) or ["city"] (old)
    if _raw_cities and isinstance(_raw_cities[0], dict):
        US_CITIES = [f"{e['c']}, {e['s']}" for e in _raw_cities]
    else:
        US_CITIES = _raw_cities
except Exception:
    US_CITIES = []
    logger.warning("Failed to load us_cities.json")


@app.route("/api/cities", methods=["GET"])
def cities_search():
    q = (request.args.get("q", "") or "").strip().lower()
    if len(q) < 2:
        return jsonify({"cities": []})
    seen = set()
    matches = []
    # Prioritize cities that START with the query, then contains
    starts = []
    contains = []
    for c in US_CITIES:
        cl = c.lower()
        if cl in seen:
            continue
        if cl.startswith(q):
            seen.add(cl)
            starts.append(c)
        elif q in cl:
            seen.add(cl)
            contains.append(c)
        if len(starts) + len(contains) >= 20:
            break
    matches = starts + contains
    return jsonify({"cities": matches[:20]})

# ── User search + profile endpoints ──────────────────────────
@app.route("/api/users/search", methods=["GET"])
@rate_limit(30, 60)  # 30 requests per minute per IP
def users_search():
    q = (request.args.get("q", "") or "").strip().lower()
    market = (request.args.get("market", "") or "").strip().lower()

    if len(q) < 2 and not market:
        return jsonify({"users": []})

    users = load_users()
    results = []

    for email, u in users.items():
        uname = u.get("username", "").lower()
        if not uname:
            continue

        if market and not q:
            # Market-based discovery: find owners with Airbnb properties in this market
            role = u.get("role", "owner")
            if role != "owner":
                continue
            uid = u.get("id")
            if not uid:
                continue
            try:
                s = _load_store_for_user(uid)
                props = s.get("custom_props", [])
                has_market = any(
                    p.get("isAirbnb") and (p.get("market") or "").lower() == market
                    for p in props
                )
                if not has_market:
                    continue
            except Exception:
                continue
            entry = {
                "user_id": uid,
                "username": uname,
                "role": role,
                "is_private": u.get("is_private", False),
                "market": market,
            }
            if role != "cleaner":
                entry["portfolio_score"] = _compute_portfolio_score(uid, s)
            results.append(entry)
        else:
            # Username substring search
            if q not in uname:
                continue
            role = u.get("role", "owner")
            entry = {
                "user_id": u["id"],
                "username": uname,
                "role": role,
                "is_private": u.get("is_private", False),
            }
            if role != "cleaner":
                entry["portfolio_score"] = _compute_portfolio_score(u["id"])
            results.append(entry)

    return jsonify({"users": results[:20]})

def _compute_portfolio_score(user_id, user_data=None):
    """Compute a portfolio score (0-100) for a non-cleaner user.
    Factors: data completeness, Plaid integration, financial health, portfolio depth."""
    try:
        s = _load_store_for_user(user_id) if user_data is None else user_data
        users = load_users()
        _email, u = _find_user_by_id(users, user_id)
        if not u:
            return None

        score = 0.0

        # ── 1. Data Completeness (20 pts) ──
        props = s.get("custom_props", s.get("properties", []))
        prop_count = len(props)

        # No properties = no portfolio to score
        if prop_count == 0:
            return 0

        if prop_count >= 3:
            score += 8
        elif prop_count >= 2:
            score += 5
        elif prop_count >= 1:
            score += 3

        pl_listings = s.get("pricelabs_listings_raw", [])
        if len(pl_listings) > 0:
            score += 4

        if u.get("username"):
            score += 3

        manual = s.get("manual_income", {})
        prop_inc = s.get("property_income", {})
        has_manual = any(
            isinstance(v, dict) and any(v.values()) for v in manual.values()
        ) if isinstance(manual, dict) else bool(manual)
        has_prop_inc = any(
            isinstance(v, dict) and any(v.values()) for v in prop_inc.values()
        ) if isinstance(prop_inc, dict) else bool(prop_inc)
        if has_manual or has_prop_inc:
            score += 5

        # ── 2. Plaid Integration (20 pts) ──
        accounts = s.get("accounts", [])
        plaid_linked = len(accounts) > 0
        if plaid_linked:
            score += 8
        tx_store = s.get("transactions", {})
        plaid_total = sum(abs(float(t.get("amount", 0))) for t in tx_store.values())
        manual_total = 0.0
        if isinstance(manual, dict):
            for _k, months in manual.items():
                if isinstance(months, dict):
                    for _m, val in months.items():
                        manual_total += abs(float(val)) if val else 0
                elif months:
                    manual_total += abs(float(months))
        data_total = plaid_total + manual_total
        if data_total > 0:
            plaid_pct = plaid_total / data_total
            score += round(plaid_pct * 12, 1)
        elif plaid_linked:
            score += 12

        # ── 3. Financial Health (35 pts) ──
        tags = s.get("tags", {})
        # Collect monthly revenue/expense data
        monthly_rev = {}
        monthly_exp = {}
        for tx_id, tx in tx_store.items():
            month_key = (tx.get("date") or "")[:7]
            if not month_key or tx.get("pending"):
                continue
            prop_id = tags.get(tx_id)
            if not prop_id or prop_id in ("deleted", "transfer"):
                continue
            amount = abs(tx.get("amount", 0))
            tx_type = tx.get("type", "out")
            if tx_type == "in":
                monthly_rev[month_key] = monthly_rev.get(month_key, 0) + amount
            else:
                monthly_exp[month_key] = monthly_exp.get(month_key, 0) + amount

        # Add manual income months
        if isinstance(manual, dict):
            for month_key, val in manual.items():
                if val and isinstance(val, (int, float, str)):
                    try:
                        monthly_rev[month_key] = monthly_rev.get(month_key, 0) + abs(float(val))
                    except (ValueError, TypeError):
                        pass

        total_rev = sum(monthly_rev.values())
        total_exp = sum(monthly_exp.values())

        # Has any revenue (5 pts)
        if total_rev > 0:
            score += 5

        # Positive net income margin (0-10 pts)
        if total_rev > 0:
            net_margin = (total_rev - total_exp) / total_rev
            if net_margin > 0:
                score += min(10, round(net_margin * 20, 1))

        # Revenue consistency — months with data (0-10 pts)
        months_with_data = len(monthly_rev)
        if months_with_data >= 6:
            score += 10
        elif months_with_data >= 3:
            score += 7
        elif months_with_data >= 1:
            score += 3

        # Expense tracking active (0-5 pts)
        tagged_expenses = sum(1 for tid in tags if tags[tid] not in ("deleted", "transfer") and tx_store.get(tid, {}).get("type", "out") != "in")
        if tagged_expenses >= 10:
            score += 5
        elif tagged_expenses >= 3:
            score += 3
        elif tagged_expenses >= 1:
            score += 1

        # Revenue trend (0-5 pts) — compare recent vs older months
        sorted_months = sorted(monthly_rev.keys())
        if len(sorted_months) >= 2:
            mid = len(sorted_months) // 2
            older_avg = sum(monthly_rev[m] for m in sorted_months[:mid]) / mid
            newer_avg = sum(monthly_rev[m] for m in sorted_months[mid:]) / (len(sorted_months) - mid)
            if older_avg > 0:
                growth = (newer_avg - older_avg) / older_avg
                if growth >= 0:
                    score += min(5, round(growth * 10, 1))
                else:
                    score += max(0, 2 + round(growth * 5, 1))

        # ── 4. Portfolio Depth (25 pts) ──
        total_units = sum(p.get("units", 0) for p in props)
        if total_units >= 10:
            score += 10
        elif total_units >= 5:
            score += 6
        elif total_units >= 1:
            score += 3

        settings = s.get("settings", {})
        units_per_year = settings.get("unitsPerYear") or u.get("unitsPerYear", 0)
        if units_per_year and int(units_per_year) > 0:
            score += 5

        total_investment = settings.get("totalInvestment") or u.get("totalInvestment", 0)
        if total_investment and float(total_investment) > 0:
            score += 5

        proj_style = settings.get("projectionStyle") or u.get("projectionStyle")
        if proj_style:
            score += 5

        return min(100, max(0, round(score)))
    except Exception:
        logger.warning("Failed to compute portfolio score for %s", user_id)
        return None


@app.route("/api/portfolio-score", methods=["GET"])
def get_portfolio_score():
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    score = _compute_portfolio_score(uid)
    return jsonify({"score": score})


@app.route("/api/users/profile/<user_id>", methods=["GET"])
def users_profile(user_id):
    users = load_users()
    email, u = _find_user_by_id(users, user_id)
    if not u:
        return jsonify({"ok": False, "error": "User not found"}), 404
    prop_count = 0
    plaid_verified_pct = None
    portfolio_score = None
    try:
        s = _load_store_for_user(user_id)
        props = s.get("custom_props", s.get("properties", []))
        prop_count = len(props)
        # Compute Plaid verification percentage
        plaid_linked = len(s.get("accounts", [])) > 0
        tx_store = s.get("transactions", {})
        plaid_total = sum(abs(float(t.get("amount", 0))) for t in tx_store.values())
        manual = s.get("manual_income", {})
        manual_total = 0.0
        for _prop_id, months in manual.items():
            if isinstance(months, dict):
                for _month, val in months.items():
                    manual_total += abs(float(val)) if val else 0
        total = plaid_total + manual_total
        if total > 0:
            plaid_verified_pct = round(plaid_total / total * 100)
        elif plaid_linked:
            plaid_verified_pct = 100  # Has Plaid but no transactions yet
        # Portfolio score for non-cleaner users
        if u.get("role", "owner") != "cleaner":
            portfolio_score = _compute_portfolio_score(user_id, s)
    except Exception:
        logger.warning("Failed to load store for user %s", user_id)
    # Cleaner rating
    avg_rating = None
    rating_count = 0
    try:
        ratings = _load_ratings()
        reviews = ratings.get(user_id, {}).get("reviews", [])
        if reviews:
            avg_rating = round(sum(r["rating"] for r in reviews) / len(reviews), 1)
            rating_count = len(reviews)
    except Exception:
        pass
    result = {
        "user_id": u["id"],
        "username": u.get("username", (email or "").split("@")[0]),
        "role": u.get("role", "owner"),
        "property_count": prop_count,
        "is_private": u.get("is_private", False),
        "plaid_verified_pct": plaid_verified_pct,
        "portfolio_score": portfolio_score,
        "avg_rating": avg_rating,
        "rating_count": rating_count,
    }
    # Only show follow_code to the profile owner
    if getattr(g, 'user_id', None) == user_id:
        result["follow_code"] = u.get("follow_code", "")
    return jsonify(result)

# ── Feed endpoint ────────────────────────────────────────────
@app.route("/api/feed", methods=["GET"])
def get_feed():
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    follows = _load_json_file(FOLLOWS_FILE)
    users = load_users()

    # Get IDs of people I follow (investors only)
    following_ids = []
    for fid, f in follows.items():
        if f["follower_id"] == uid and f["status"] == "approved" and f["type"] == "investor":
            following_ids.append(f["following_id"])

    feed = []
    for fuid in following_ids:
        # Get username + role
        uname = ""
        urole = "owner"
        for email, u in users.items():
            if u["id"] == fuid:
                uname = u.get("username", email.split("@")[0])
                urole = u.get("role", "owner")
                break

        p_score = _compute_portfolio_score(fuid) if urole != "cleaner" else None

        # Get their notifications (milestones, financial)
        notifs = _load_json_file(NOTIFICATIONS_FILE)
        user_notifs = notifs.get(fuid, [])
        for n in user_notifs[:10]:
            if n.get("type") in ("milestone", "financial", "property_added"):
                feed.append({
                    "id": n["id"],
                    "user_id": fuid,
                    "username": uname,
                    "role": urole,
                    "portfolio_score": p_score,
                    "type": n["type"],
                    "title": n["title"],
                    "body": n["body"],
                    "created_at": n["created_at"],
                })

    feed.sort(key=lambda x: x.get("created_at", ""), reverse=True)

    page = int(request.args.get("page", 0))
    per_page = 20
    return jsonify({"feed": feed[page*per_page:(page+1)*per_page], "total": len(feed)})

# ── Cleaner endpoints ────────────────────────────────────────
@app.route("/api/cleaner/my-schedule", methods=["GET"])
def cleaner_schedule():
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    follows = _load_json_file(FOLLOWS_FILE)
    users = load_users()

    events = []
    for fid, f in follows.items():
        if f["follower_id"] != uid or f["status"] != "approved" or f["type"] != "cleaner":
            continue
        owner_id = f["following_id"]
        selected_props = f.get("selected_properties", [])

        # Get owner name
        owner_name = ""
        for email, u in users.items():
            if u["id"] == owner_id:
                owner_name = u.get("username", email.split("@")[0])
                break

        # Load owner's PriceLabs bookings
        try:
            owner_store = _load_store_for_user(owner_id)
            owner_bookings = owner_store.get("ical_events", [])
            owner_props = owner_store.get("properties", [])
            prop_labels = {p.get("id", ""): p.get("label", p.get("id", "")) for p in owner_props}

            short_names = owner_store.get("pricelabs_short_names", {})

            for b in owner_bookings:
                prop_id = b.get("prop_id", "")
                if selected_props and prop_id not in selected_props:
                    continue
                pl_id = str(b.get("listing_id") or b.get("pl_id") or "")
                unit_name = short_names.get(pl_id, "") if pl_id else ""
                events.append({
                    "check_in": b.get("check_in", ""),
                    "check_out": b.get("check_out", ""),
                    "prop_id": prop_id,
                    "prop_name": prop_labels.get(prop_id, prop_id),
                    "owner": owner_name,
                    "owner_id": owner_id,
                    "uid": b.get("uid", ""),
                    "pl_id": pl_id,
                    "unit_name": unit_name,
                    "guest_name": b.get("guest_name", ""),
                })
        except Exception as e:
            logger.error("Error loading schedule for owner %s: %s", owner_id, e)

    events.sort(key=lambda x: x.get("check_out", ""))
    return jsonify({"events": events})

@app.route("/api/cleaner/owner-properties/<owner_id>", methods=["GET"])
def cleaner_owner_properties(owner_id):
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    # Verify follow relationship
    follows = _load_json_file(FOLLOWS_FILE)
    has_follow = False
    for fid, f in follows.items():
        if f["follower_id"] == uid and f["following_id"] == owner_id and f["status"] == "approved":
            has_follow = True
            break
    if not has_follow:
        return jsonify({"ok": False, "error": "Not following this owner"}), 403
    try:
        owner_store = _load_store_for_user(owner_id)
        props = owner_store.get("properties", [])
        pl_listings = owner_store.get("pricelabs_listings_raw", [])
        pl_prop_ids = set(l.get("prop_id", "") for l in pl_listings if l.get("prop_id"))
        # Only return properties with at least one PriceLabs listing
        result = [{"id": p.get("id",""), "label": p.get("label", p.get("id",""))}
                  for p in props if p.get("id","") in pl_prop_ids]
        return jsonify({"properties": result})
    except Exception:
        logger.warning("Failed to load owner store for %s", owner_id)
        return jsonify({"properties": []})

@app.route("/api/cleaner/owner-units/<owner_id>", methods=["GET"])
def cleaner_owner_units(owner_id):
    """Returns properties with per-unit breakdown from PriceLabs listings."""
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    follows = _load_json_file(FOLLOWS_FILE)
    has_follow = False
    for fid, f in follows.items():
        if f["follower_id"] == uid and f["following_id"] == owner_id and f["status"] == "approved":
            has_follow = True
            break
    if not has_follow:
        return jsonify({"ok": False, "error": "Not following this owner"}), 403
    try:
        owner_store = _load_store_for_user(owner_id)
        props = owner_store.get("properties", [])
        short_names = owner_store.get("pricelabs_short_names", {})
        pl_listings = owner_store.get("pricelabs_listings_raw", [])

        result = []
        for p in props:
            pid = p.get("id", "")
            plabel = p.get("label", p.get("id", ""))
            # Find PriceLabs listings mapped to this property
            prop_listings = [l for l in pl_listings if l.get("prop_id") == pid]
            units = []
            for l in prop_listings:
                lid = str(l.get("id", ""))
                uname = short_names.get(lid, l.get("short_label", ""))
                if not uname:
                    uname = plabel
                units.append({"pl_id": lid, "unit_name": uname})
            # If no listings, still include the property with an empty unit
            if not units:
                units.append({"pl_id": "", "unit_name": plabel})
            result.append({"prop_id": pid, "prop_label": plabel, "units": units})
        return jsonify({"properties": result})
    except Exception as e:
        logger.warning("Failed to load owner units for %s: %s", owner_id, e)
        return jsonify({"properties": []})


# ── Daily sync scheduler ──────────────────────────────────────
def scheduled_sync():
    logger.info("Scheduled daily sync starting...")
    try:
        result = run_sync()
        logger.info("Scheduled sync complete — %s transactions stored", result.get('total_stored', 0))
    except Exception as e:
        logger.error("Scheduled sync failed: %s", e)

scheduler = BackgroundScheduler(daemon=True)
# Plaid fallback sync every 6 hours
scheduler.add_job(scheduled_sync, IntervalTrigger(hours=6), id="periodic_sync", replace_existing=True)
# Phase 3: periodic rate limit cleanup
scheduler.add_job(_cleanup_rate_buckets, IntervalTrigger(minutes=30), id='rate_limit_cleanup', replace_existing=True)
scheduler.start()
logger.info("Scheduler started: Plaid sync every 6 hours")

# Phase 1: warm token cache on startup
_warm_token_cache()

# ── Startup sync ──────────────────────────────────────────────────────────

def startup_sync():
    _time.sleep(4)  # let gunicorn fully start before hitting Plaid
    store    = load_store()
    accounts = store.get("accounts", [])
    tx_count = len(store.get("transactions", {}))
    if not accounts:
        logger.info("Startup: no accounts linked — skipping sync")
        return
    logger.info("Startup: %s account(s) linked, %s transactions cached — syncing…", len(accounts), tx_count)
    try:
        result = run_sync()
        logger.info("Startup sync done: %s new, %s total stored",
              result.get('total', 0), result.get('total_stored', 0))
    except Exception as e:
        logger.error("Startup sync failed: %s", e)

threading.Thread(target=startup_sync, daemon=True).start()
logger.info("Startup sync scheduled (runs in background after 4s)")


# PriceLabs startup refresh removed — calendar now uses Airbnb iCal feeds

# ── /cleaner — Public turnover page for cleaning crew ─────────────────────────

_CLEANER_CACHE = {"data": None, "ts": 0}
_CLEANER_LOCK  = threading.Lock()
_CLEANER_TTL   = 1800  # 30 minutes


def _get_cleaner_feeds():
    """Return active feeds from store, or empty list if none configured."""
    try:
        stored = load_store().get("cleaner_feeds")
        if stored and isinstance(stored, list) and len(stored) > 0:
            return stored
    except Exception:
        pass
    return []


def _fetch_cleaner_data():
    """Return cleaner schedule events from iCal booking data."""
    from datetime import date, timedelta
    events_out = []
    today_d = date.today()
    cutoff  = today_d + timedelta(days=60)
    store = load_store()
    ical_events = store.get("ical_events", [])
    for b in ical_events:
        b_ci = b.get("check_in", "")
        b_co = b.get("check_out", "")
        if not b_ci:
            continue
        try:
            ci_d = date.fromisoformat(b_ci[:10])
            co_d = date.fromisoformat(b_co[:10]) if b_co else ci_d + timedelta(days=int(b.get("nights") or 1))
        except Exception:
            continue
        guest = (b.get("guest_name") or "").strip()
        nights = int(b.get("nights") or (co_d - ci_d).days)
        unit_name = b.get("listing_name", "")
        if today_d <= co_d <= cutoff:
            events_out.append({
                "type": "checkout", "date": b_co[:10],
                "unit": unit_name, "guest_name": guest,
                "nights": nights, "time": "10:00 AM",
            })
        if today_d <= ci_d <= cutoff:
            events_out.append({
                "type": "checkin", "date": b_ci[:10],
                "unit": unit_name, "guest_name": guest,
                "nights": nights, "time": "3:00 PM",
            })
    return events_out


@app.route("/api/cleaner/schedule")
def cleaner_schedule_api():
    force = request.args.get("force") == "1"
    with _CLEANER_LOCK:
        age = _time.time() - _CLEANER_CACHE["ts"]
        if force or _CLEANER_CACHE["data"] is None or age > _CLEANER_TTL:
            _CLEANER_CACHE["data"] = _fetch_cleaner_data()
            _CLEANER_CACHE["ts"]   = _time.time()
    return jsonify({"events": _CLEANER_CACHE["data"],
                    "fetched_at": int(_CLEANER_CACHE["ts"])})


def _check_cleaner_pin(pin):
    expected = os.getenv("CLEANER_ADMIN_PIN", os.getenv("CLEANER_PIN", "1234"))
    return str(pin) == expected


@app.route("/api/cleaner/feeds", methods=["GET"])
def cleaner_feeds_get():
    feeds = _get_cleaner_feeds()
    return jsonify({"feeds": feeds})


@app.route("/api/cleaner/feeds", methods=["POST"])
def cleaner_feeds_post():
    body = request.json or {}
    feeds = body.get("feeds")
    if not isinstance(feeds, list):
        return jsonify({"error": "feeds must be an array"}), 400
    # Validate each entry
    clean = []
    for f in feeds:
        name = str(f.get("name", "")).strip()
        url  = str(f.get("url",  "")).strip()
        if not name:
            continue
        entry = {"name": name, "url": url if url and _is_safe_url(url) else ""}
        # Store optional user search fields
        if f.get("user_id"):
            entry["user_id"] = str(f["user_id"])
        if f.get("username"):
            entry["username"] = str(f["username"])
        if f.get("propId"):
            entry["propId"] = str(f["propId"])
        clean.append(entry)
    store = load_store()
    store["cleaner_feeds"] = clean
    save_store(store)
    # Invalidate cache so next fetch uses new feeds
    with _CLEANER_LOCK:
        _CLEANER_CACHE["data"] = None
        _CLEANER_CACHE["ts"]   = 0
    return jsonify({"ok": True, "feeds": clean})


# ── Cleaner Ratings ────────────────────────────────────────────
RATINGS_FILE = "/data/cleaner_ratings.json" if _os.path.isdir("/data") else "cleaner_ratings.json"

def _load_ratings():
    try:
        with open(RATINGS_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {}

def _save_ratings(data):
    try:
        with open(RATINGS_FILE, "w") as f:
            json.dump(data, f)
    except Exception as e:
        logger.error("Failed to save ratings: %s", e)


@app.route("/api/cleaner/rate", methods=["POST"])
def rate_cleaner():
    """Host rates a cleaner 1-5. Rolling: allowed every 10 new cleanings."""
    uid = getattr(g, "user_id", None)
    if not uid:
        return jsonify({"error": "Authentication required"}), 401
    body = request.get_json(force=True) or {}
    cleaner_id = body.get("cleaner_id", "")
    rating = body.get("rating")
    if not cleaner_id or not isinstance(rating, (int, float)) or rating < 1 or rating > 5:
        return jsonify({"error": "cleaner_id and rating (1-5) required"}), 400
    rating = round(rating)

    now_str = _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime())
    store = load_store()
    schedule = store.get("cleaner_schedule", [])

    # Find last rating timestamp from this host for this cleaner
    ratings = _load_ratings()
    if cleaner_id not in ratings:
        ratings[cleaner_id] = {"reviews": [], "pending_notifications": []}
    existing = next((r for r in ratings[cleaner_id]["reviews"] if r.get("host_id") == uid), None)
    last_rated_at = None
    if existing:
        last_rated_at = existing.get("updated_at") or existing.get("created_at")

    # Count cleanings completed after last rating (or all if no prior rating)
    cleaning_count = 0
    for ev in schedule:
        if ev.get("cleaner_id") != cleaner_id:
            continue
        co = ev.get("check_out", "")
        if co > now_str:
            continue  # Not yet completed
        if last_rated_at and co <= last_rated_at:
            continue  # Before last rating
        cleaning_count += 1

    if cleaning_count < 10:
        return jsonify({
            "error": f"You need 10 new cleanings since your last rating to rate again ({cleaning_count}/10)",
            "cleaning_count": cleaning_count,
        }), 403

    # Store/update rating
    if existing:
        existing["rating"] = rating
        existing["updated_at"] = now_str
    else:
        ratings[cleaner_id]["reviews"].append({
            "host_id": uid,
            "rating": rating,
            "created_at": now_str,
        })
    # Schedule delayed notification (24-48 hour random delay)
    import random
    delay_hours = random.randint(24, 48)
    notify_at = _time.time() + delay_hours * 3600
    ratings[cleaner_id]["pending_notifications"].append({
        "notify_at": notify_at,
        "created_at": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()),
    })
    _save_ratings(ratings)
    return jsonify({"ok": True, "message": "Rating submitted anonymously"})


@app.route("/api/cleaner/my-rating", methods=["GET"])
def cleaner_my_rating():
    """Get the current cleaner's average rating."""
    uid = getattr(g, "user_id", None)
    if not uid:
        return jsonify({"error": "Authentication required"}), 401
    ratings = _load_ratings()
    my_ratings = ratings.get(uid, {}).get("reviews", [])
    if not my_ratings:
        return jsonify({"average": None, "count": 0})
    avg = sum(r["rating"] for r in my_ratings) / len(my_ratings)
    return jsonify({"average": round(avg, 1), "count": len(my_ratings)})


@app.route("/api/cleaner/rating-notifications", methods=["GET"])
def cleaner_rating_notifications():
    """Check for matured rating notifications (24-48h delay passed)."""
    uid = getattr(g, "user_id", None)
    if not uid:
        return jsonify({"error": "Authentication required"}), 401
    ratings = _load_ratings()
    entry = ratings.get(uid, {})
    pending = entry.get("pending_notifications", [])
    now = _time.time()
    matured = [n for n in pending if n["notify_at"] <= now]
    # Remove matured notifications
    if matured:
        entry["pending_notifications"] = [n for n in pending if n["notify_at"] > now]
        ratings[uid] = entry
        _save_ratings(ratings)
    return jsonify({"new_ratings": len(matured)})

# ── Cleaner invoice CRUD ─────────────────────────────────────
_INV_DIR = os.path.join("/data" if os.path.isdir("/data") else ".", "invoices")
os.makedirs(_INV_DIR, exist_ok=True)

def _inv_file(user_id):
    return os.path.join(_INV_DIR, f"invoices_{user_id}.json")

def _load_invoices(user_id):
    try:
        with open(_inv_file(user_id), "r") as f:
            return json.load(f)
    except Exception:
        return []

def _save_invoices(user_id, invoices):
    with open(_inv_file(user_id), "w") as f:
        json.dump(invoices, f)

@app.route("/api/cleaner/invoices", methods=["GET"])
def cleaner_invoices_get():
    uid = g.user_id
    return jsonify({"invoices": _load_invoices(uid)})

@app.route("/api/cleaner/invoiced-uids", methods=["GET"])
def cleaner_invoiced_uids():
    """Returns all event UIDs across all invoices for this cleaner."""
    uid = g.user_id
    invoices = _load_invoices(uid)
    uids = []
    for inv in invoices:
        uids.extend(inv.get("event_uids", []))
    return jsonify({"uids": list(set(uids))})

@app.route("/api/cleaner/invoices", methods=["POST"])
def cleaner_invoices_create():
    uid = g.user_id
    body = request.get_json(force=True) or {}
    event_uids = body.get("event_uids", [])

    # Validate no double-invoicing: check submitted UIDs against existing invoices
    if event_uids:
        existing_invoices = _load_invoices(uid)
        existing_uids = set()
        for inv in existing_invoices:
            for u in inv.get("event_uids", []):
                existing_uids.add(u)
        overlap = set(event_uids) & existing_uids
        if overlap:
            return jsonify({"error": "Some cleanings have already been invoiced", "overlapping_uids": list(overlap)}), 409

    invoice = {
        "id": "inv_" + secrets.token_hex(6),
        "hostId": body.get("hostId", ""),
        "hostName": body.get("hostName", ""),
        "period": body.get("period", ""),
        "lineItems": body.get("lineItems", []),
        "total": body.get("total", 0),
        "status": body.get("status", "draft"),
        "createdAt": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()),
        "cleanerId": uid,
        "event_uids": event_uids,
    }
    invoices = _load_invoices(uid)
    invoices.insert(0, invoice)
    _save_invoices(uid, invoices)
    return jsonify({"invoice": invoice})

@app.route("/api/cleaner/invoices/update", methods=["PUT"])
def cleaner_invoices_update():
    uid = g.user_id
    body = request.get_json(force=True) or {}
    invoice_id = body.get("invoice_id", "")
    invoices = _load_invoices(uid)
    for inv in invoices:
        if inv["id"] == invoice_id and inv.get("status") == "draft":
            inv["lineItems"] = body.get("line_items", inv["lineItems"])
            inv["total"] = body.get("total", inv["total"])
            _save_invoices(uid, invoices)
            return jsonify({"ok": True, "invoice": inv})
    return jsonify({"error": "Invoice not found or not editable"}), 404

@app.route("/api/cleaner/invoices/delete", methods=["DELETE"])
def cleaner_invoices_delete():
    uid = g.user_id
    body = request.get_json(force=True) or {}
    invoice_id = body.get("invoice_id", "")
    invoices = _load_invoices(uid)
    original_len = len(invoices)
    invoices = [inv for inv in invoices if inv["id"] != invoice_id]
    if len(invoices) == original_len:
        return jsonify({"error": "Invoice not found"}), 404
    _save_invoices(uid, invoices)
    return jsonify({"ok": True})

def _received_inv_file(user_id):
    return os.path.join(_INV_DIR, f"received_invoices_{user_id}.json")

def _load_received_invoices(user_id):
    try:
        with open(_received_inv_file(user_id), "r") as f:
            return json.load(f)
    except Exception:
        return []

def _save_received_invoices(user_id, invoices):
    with open(_received_inv_file(user_id), "w") as f:
        json.dump(invoices, f)

@app.route("/api/cleaner/invoices/send", methods=["POST"])
def cleaner_invoices_send():
    uid = g.user_id
    body = request.get_json(force=True) or {}
    invoice_id = body.get("invoice_id", "")
    invoices = _load_invoices(uid)
    for inv in invoices:
        if inv["id"] == invoice_id and inv.get("status") == "draft":
            inv["status"] = "sent"
            inv["sentAt"] = _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime())
            _save_invoices(uid, invoices)

            # Copy invoice to host's received invoices
            host_id = inv.get("hostId")
            if host_id:
                users = load_users()
                cleaner_name = ""
                for email, u in users.items():
                    if u["id"] == uid:
                        cleaner_name = u.get("username") or email.split("@")[0]
                        break

                # Save copy to host's received_invoices store
                host_copy = {**inv, "cleanerName": cleaner_name, "cleanerId": uid}
                received = _load_received_invoices(host_id)
                received.insert(0, host_copy)
                _save_received_invoices(host_id, received)

                # Notify host (in-app + push)
                _store_notification(host_id, "invoice",
                    "Invoice Received",
                    f"{cleaner_name} sent you an invoice for {inv.get('period', 'recent cleanings')}: ${inv.get('total', 0):.2f}")
                tokens = _get_user_push_tokens(host_id)
                if tokens:
                    _send_push(tokens, "Invoice Received",
                        f"{cleaner_name} sent you an invoice for ${inv.get('total', 0):.2f}")
            return jsonify({"ok": True})
    return jsonify({"error": "Invoice not found or already sent"}), 404

# ── Host invoice endpoints ───────────────────────────────────

@app.route("/api/host/invoices", methods=["GET"])
def host_invoices_get():
    """Returns invoices received by the authenticated host user."""
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Authentication required"}), 401
    return jsonify({"invoices": _load_received_invoices(uid)})

@app.route("/api/host/invoices/mark-paid", methods=["POST"])
def host_invoices_mark_paid():
    """Host marks an invoice as paid."""
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Authentication required"}), 401
    body = request.get_json(force=True) or {}
    invoice_id = body.get("invoice_id", "")
    received = _load_received_invoices(uid)
    found = False
    for inv in received:
        if inv["id"] == invoice_id:
            inv["status"] = "paid"
            inv["paidAt"] = _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime())
            found = True
            break
    if not found:
        return jsonify({"error": "Invoice not found"}), 404
    _save_received_invoices(uid, received)

    # Also update the cleaner's copy
    cleaner_id = None
    for inv in received:
        if inv["id"] == invoice_id:
            cleaner_id = inv.get("cleanerId")
            break
    if cleaner_id:
        cleaner_invoices = _load_invoices(cleaner_id)
        for inv in cleaner_invoices:
            if inv["id"] == invoice_id:
                inv["status"] = "paid"
                inv["paidAt"] = _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime())
                break
        _save_invoices(cleaner_id, cleaner_invoices)
        # Notify cleaner
        users = load_users()
        host_name = ""
        for email, u in users.items():
            if u["id"] == uid:
                host_name = u.get("username") or email.split("@")[0]
                break
        _store_notification(cleaner_id, "invoice",
            "Invoice Paid",
            f"{host_name} marked your invoice as paid")
        tokens = _get_user_push_tokens(cleaner_id)
        if tokens:
            _send_push(tokens, "Invoice Paid",
                f"{host_name} marked your invoice as paid")

    return jsonify({"ok": True})


_CLEANER_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Schedule</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,'SF Pro Text','Helvetica Neue',sans-serif;background:#f2f2f7;color:#1c1c1e;min-height:100vh;-webkit-font-smoothing:antialiased}
/* ── Header ── */
.hdr{background:#fff;padding:16px 20px 0;position:sticky;top:0;z-index:100;border-bottom:0.5px solid rgba(0,0,0,0.15)}
.hdr-title{font-size:28px;font-weight:700;letter-spacing:-.5px;padding-bottom:12px}
/* ── Segment control ── */
.seg{display:flex;background:rgba(118,118,128,.12);border-radius:9px;padding:2px;margin:0 20px 0}
.seg-btn{flex:1;padding:7px 0;border:none;background:transparent;font-family:inherit;font-size:13px;font-weight:500;color:#3c3c43;cursor:pointer;border-radius:7px;-webkit-tap-highlight-color:transparent;transition:all .15s}
.seg-btn.active{background:#fff;color:#000;font-weight:600;box-shadow:0 1px 4px rgba(0,0,0,.13),0 0 0 .5px rgba(0,0,0,.04)}
/* ── Summary ── */
.sum-row{display:flex;gap:0;padding:16px 20px 4px;font-size:13px;color:#8e8e93;font-weight:400;letter-spacing:-.01em}
.sum-sep{margin:0 6px;color:#c7c7cc}
.sum-val{font-weight:600;color:#1c1c1e}
/* ── Filter chips ── */
.chips{display:flex;gap:8px;overflow-x:auto;padding:8px 20px;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.chips::-webkit-scrollbar{display:none}
.chip{flex:0 0 auto;padding:5px 14px;border-radius:16px;font-size:13px;font-weight:500;background:rgba(118,118,128,.12);color:#3c3c43;cursor:pointer;-webkit-tap-highlight-color:transparent}
.chip.active{background:#1c1c1e;color:#fff}
/* ── Date strip ── */
.dstrip{display:flex;gap:4px;overflow-x:auto;padding:4px 20px 10px;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.dstrip::-webkit-scrollbar{display:none}
.dpill{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;padding:6px 8px 5px;border-radius:10px;cursor:pointer;min-width:40px;border:1px solid transparent;-webkit-tap-highlight-color:transparent}
.dn{font-size:10px;font-weight:500;text-transform:uppercase;color:#8e8e93;letter-spacing:.04em}
.dd{font-size:17px;font-weight:600;margin-top:1px}
.ddot{width:4px;height:4px;border-radius:50%;margin-top:3px}
.dpill.sel{background:#007AFF}
.dpill.sel .dn,.dpill.sel .dd{color:#fff}
.dpill.sel .ddot{background:#fff!important}
.dpill.tod:not(.sel){border-color:rgba(0,122,255,.4)}
.dpill.tod:not(.sel) .dn,.dpill.tod:not(.sel) .dd{color:#007AFF}
/* ── Refresh bar ── */
.rfbar{display:flex;justify-content:space-between;align-items:center;padding:2px 20px 6px;font-size:11px;color:#aeaeb2}
.rfbtn{background:none;border:none;color:#007AFF;font-weight:500;font-size:11px;font-family:inherit;cursor:pointer}
/* ── Cards ── */
.list{padding:0 20px 56px}
.sec-hdr{font-size:13px;font-weight:600;color:#8e8e93;padding:14px 0 6px;letter-spacing:-.01em}
.sec-hdr.tod{color:#007AFF}
.card{background:#fff;border-radius:12px;padding:14px 16px;margin-bottom:8px;position:relative;overflow:hidden}
.card-bar{position:absolute;left:0;top:0;bottom:0;width:3px}
.card-bar.clean{background:#FF3B30}
.card-bar.ci{background:#34C759}
.card-bar.tv{background:#FF9500}
.card-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px}
.lbl-clean{color:#FF3B30}
.lbl-ci{color:#34C759}
.lbl-tv{color:#FF9500}
.card-unit{font-size:17px;font-weight:600;letter-spacing:-.01em;margin-bottom:3px}
.card-detail{font-size:13px;color:#8e8e93;line-height:1.5}
.card-note{font-size:12px;font-weight:500;color:#3c3c43;margin-top:8px;padding-top:7px;border-top:0.5px solid rgba(0,0,0,.1)}
/* ── Calendar ── */
.cal-wrap{padding:0 20px 56px}
.cal-mo-hdr{font-size:17px;font-weight:600;letter-spacing:-.01em;padding:16px 0 10px}
.cal-wk{display:grid;grid-template-columns:repeat(7,1fr);margin-bottom:4px}
.cal-wd{font-size:10px;font-weight:500;text-transform:uppercase;color:#8e8e93;text-align:center;letter-spacing:.04em}
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}
.cal-cell{aspect-ratio:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding-top:6px;border-radius:9px;background:rgba(255,255,255,0.82);box-shadow:0 2px 14px rgba(0,0,0,.06),0 .5px 2px rgba(0,0,0,.04),inset 0 1px 0 rgba(255,255,255,.85);cursor:pointer;position:relative;-webkit-tap-highlight-color:transparent;border:0.5px solid rgba(255,255,255,.7)}
.cal-cell.pad{background:transparent;pointer-events:none;box-shadow:none;border-color:transparent}
.cal-cell.past{opacity:.38}
.cal-num{font-size:12px;font-weight:500;color:#1c1c1e}
.cal-cell.tod{box-shadow:0 0 0 1.5px rgba(0,122,255,.45),0 2px 14px rgba(0,0,0,.06)}
.cal-cell.tod .cal-num{color:#007AFF;font-weight:700}
.cal-cell.has-clean{background:rgba(239,68,68,0.13);border:1.5px solid rgba(239,68,68,.35)}
.cal-cell.has-clean .cal-num{color:#FF3B30}
.cal-c-lbl{font-size:9px;font-weight:800;color:#FF3B30;line-height:1;margin-top:2px;letter-spacing:-.01em}
.cal-ci-dot{width:4px;height:4px;border-radius:50%;background:#34C759;margin-top:3px}
.cal-tv-dot{position:absolute;top:2px;right:2px;width:5px;height:5px;border-radius:50%;background:#FF3B30;box-shadow:0 0 0 1.5px rgba(255,255,255,.9)}
/* ── Day detail ── */
.detail-ov{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:200;align-items:flex-end}
.detail-ov.open{display:flex}
.detail-sh{background:#f2f2f7;border-radius:16px 16px 0 0;padding:20px 20px 44px;width:100%;max-height:70vh;overflow-y:auto}
.detail-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.detail-title{font-size:17px;font-weight:600}
.detail-close{background:none;border:none;font-size:24px;color:#8e8e93;cursor:pointer;line-height:1;padding:0}
.detail-row{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:0.5px solid rgba(0,0,0,.1)}
.detail-bar{width:3px;border-radius:2px;flex-shrink:0;align-self:stretch}
/* ── Loading / empty ── */
.loading{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;gap:10px;color:#8e8e93;font-size:14px}
.spin{width:24px;height:24px;border:2px solid #e5e5ea;border-top-color:#007AFF;border-radius:50%;animation:sp .8s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
.empty{text-align:center;padding:56px 24px;color:#8e8e93;font-size:14px}
</style>
</head>
<body>
<div id="app"><div class="loading"><div class="spin"></div><span>Loading…</span></div></div>

<!-- Day detail sheet -->
<div id="detail-ov" class="detail-ov" onclick="if(event.target===this)closeDetail()">
  <div class="detail-sh">
    <div class="detail-hdr">
      <div id="detail-title" class="detail-title"></div>
      <button class="detail-close" onclick="closeDetail()">×</button>
    </div>
    <div id="detail-rows"></div>
  </div>
</div>

<script>
const WD  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const WD2 = ["Su","Mo","Tu","We","Th","Fr","Sa"];
const MO  = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MOS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

let S={events:[],units:[],filter:"All",tab:"clean",selDate:null,fetchedAt:null,loading:true,error:null};

function toYMD(d){return d.toLocaleDateString("en-CA");}
function today(){return toYMD(new Date());}
function addDays(n){const d=new Date();d.setDate(d.getDate()+n);return toYMD(d);}
function fmtLong(ymd){const d=new Date(ymd+"T12:00:00");return MOS[d.getMonth()].toUpperCase()+" "+d.getDate();}
function isTv(evs,u,dt){return evs.some(e=>e.type==="checkout"&&e.unit===u&&e.date===dt)&&evs.some(e=>e.type==="checkin"&&e.unit===u&&e.date===dt);}
function esc(s){return(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");}

async function load(force){
  try{
    const r=await fetch("/api/cleaner/schedule"+(force?"?force=1":""));
    const d=await r.json();
    S.events=d.events||[];
    S.units=[...new Set(S.events.map(e=>e.unit))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
    S.fetchedAt=d.fetched_at;S.error=null;
  }catch(e){S.error="Unable to load schedule.";}
  S.loading=false;render();
}

function render(){document.getElementById("app").innerHTML=buildHTML();bind();}

function buildHTML(){
  if(S.loading)return`<div class="loading"><div class="spin"></div><span>Loading…</span></div>`;
  if(S.error)return`<div class="loading"><span>${S.error}</span><br><button onclick="location.reload()" style="margin-top:10px;padding:8px 20px;border-radius:8px;border:1px solid rgba(0,122,255,.3);background:rgba(0,122,255,.06);color:#007AFF;font-size:13px;font-weight:600;cursor:pointer">Retry</button></div>`;

  const dates=Array.from({length:30},(_,i)=>addDays(i));
  const td=today();
  const fevs=S.filter==="All"?S.events:S.events.filter(e=>e.unit===S.filter);
  const d7=dates.slice(0,7);
  const e7=fevs.filter(e=>d7.includes(e.date));
  const nCo=e7.filter(e=>e.type==="checkout").length;
  const nCi=e7.filter(e=>e.type==="checkin").length;
  const ft=S.fetchedAt?new Date(S.fetchedAt*1000).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):"";

  const seg=`<div class="seg">
    <button class="seg-btn${S.tab==="clean"?" active":""}" data-tab="clean">Cleanings</button>
    <button class="seg-btn${S.tab==="cal"?" active":""}" data-tab="cal">Calendar</button>
    <button class="seg-btn${S.tab==="ci"?" active":""}" data-tab="ci">Check-ins</button>
  </div>`;

  const chips=["All",...S.units].map(u=>`<div class="chip${S.filter===u?" active":""}" data-prop="${esc(u)}">${esc(u)}</div>`).join("");

  let strip="";
  if(S.tab!=="cal"){
    const dotClr=S.tab==="clean"?"#FF3B30":"#34C759";
    strip=dates.slice(0,14).map(ymd=>{
      const d=new Date(ymd+"T12:00:00"),isSel=ymd===S.selDate,isT=ymd===td;
      const hasEv=S.tab==="clean"?fevs.some(e=>e.date===ymd&&e.type==="checkout"):fevs.some(e=>e.date===ymd&&e.type==="checkin");
      const cls="dpill"+(isSel?" sel":"")+(isT?" tod":"");
      return`<div class="${cls}" data-date="${ymd}"><div class="dn">${WD[d.getDay()]}</div><div class="dd">${d.getDate()}</div><div class="ddot" style="background:${hasEv?(isSel?"#fff":dotClr):"transparent"}"></div></div>`;
    }).join("");
    strip=`<div class="dstrip">${strip}</div>`;
  }

  const main=S.tab==="clean"?cleanView(fevs,dates,td):S.tab==="ci"?ciView(fevs,dates,td):calView(fevs,td);

  return`<div class="hdr">
  <div class="hdr-title">Schedule</div>
  ${seg}
  <div class="sum-row">
    <span class="sum-val">${nCo}</span> cleanings this week
    <span class="sum-sep">·</span>
    <span class="sum-val">${nCi}</span> check-ins
  </div>
</div>
<div class="chips">${chips}</div>
${strip}
<div class="rfbar"><span>${ft?"Updated "+ft:""}</span><button class="rfbtn" onclick="forceRefresh()">Refresh</button></div>
${main}`;
}

function card(ev,barCls,lblCls,badge,details,note,isSameDayTv){
  const tvPill=isSameDayTv?`<div style="display:flex;align-items:center;gap:4px;background:rgba(255,59,48,0.1);border-radius:6px;padding:2px 7px;flex-shrink:0"><div style="width:5px;height:5px;border-radius:50%;background:#FF3B30"></div><span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#FF3B30">Same day</span></div>`:"";
  return`<div class="card">
    <div class="card-bar ${barCls}"></div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px"><div class="card-lbl ${lblCls}" style="margin-bottom:0">${badge}</div>${tvPill}</div>
    <div class="card-unit">${esc(ev.unit)}</div>
    ${details?`<div class="card-detail">${details}</div>`:""}
    ${note?`<div class="card-note">${note}</div>`:""}
  </div>`;
}

function secHdr(ymd,td){
  const isT=ymd===td;
  return`<div class="sec-hdr${isT?" tod":""}">${isT?"Today — ":""}${fmtLong(ymd)}</div>`;
}

function cleanView(fevs,dates,td){
  const show=S.selDate?[S.selDate]:dates;
  let any=false;
  const secs=show.map(ymd=>{
    const cos=fevs.filter(e=>e.date===ymd&&e.type==="checkout");
    if(!cos.length)return"";
    any=true;
    const cards=cos.map(ev=>{
      const tv=isTv(fevs,ev.unit,ymd);
      const sameCI=fevs.find(e=>e.date===ymd&&e.type==="checkin"&&e.unit===ev.unit);
      const bar=tv?"tv":"clean",lbl=tv?"lbl-tv":"lbl-clean",badge=tv?"Same-day turnover":"Cleaning needed";
      const det=[ev.nights>0?ev.nights+" night stay":null,ev.guest_name?"Checked out at 10:00 AM":null].filter(Boolean).join(" · ");
      return card(ev,bar,lbl,badge,det||null,sameCI?"Next guest arrives at 3:00 PM":null,tv);
    }).join("");
    return secHdr(ymd,td)+cards;
  }).join("");
  if(!any)return`<div class="empty">No cleanings scheduled${S.selDate?" on this date":""}</div>`;
  return`<div class="list">${secs}</div>`;
}

function ciView(fevs,dates,td){
  const show=S.selDate?[S.selDate]:dates;
  let any=false;
  const secs=show.map(ymd=>{
    const cis=fevs.filter(e=>e.date===ymd&&e.type==="checkin");
    if(!cis.length)return"";
    any=true;
    const cards=cis.map(ev=>{
      const tv=isTv(fevs,ev.unit,ymd);
      const prevCO=fevs.find(e=>e.date===ymd&&e.type==="checkout"&&e.unit===ev.unit);
      const bar=tv?"tv":"ci",lbl=tv?"lbl-tv":"lbl-ci",badge=tv?"Same-day turnover":"Check-in";
      const det=[ev.guest_name?esc(ev.guest_name):null,"3:00 PM arrival",ev.nights>0?ev.nights+" night stay":null].filter(Boolean).join(" · ");
      return card(ev,bar,lbl,badge,det,prevCO?"Previous guest departs at 10:00 AM":null,tv);
    }).join("");
    return secHdr(ymd,td)+cards;
  }).join("");
  if(!any)return`<div class="empty">No upcoming check-ins</div>`;
  return`<div class="list">${secs}</div>`;
}

function calView(fevs,td){
  const now=new Date();
  const months=[];
  for(let i=0;i<3;i++){const m=(now.getMonth()+i)%12;const y=now.getFullYear()+Math.floor((now.getMonth()+i)/12);months.push([y,m]);}
  const grids=months.map(([y,m])=>{
    const first=new Date(y,m,1).getDay();
    const total=new Date(y,m+1,0).getDate();
    let cells="";
    for(let i=0;i<first;i++)cells+=`<div class="cal-cell pad"></div>`;
    for(let d=1;d<=total;d++){
      const ymd=`${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
      const devs=fevs.filter(e=>e.date===ymd);
      const cos=devs.filter(e=>e.type==="checkout"),cis=devs.filter(e=>e.type==="checkin");
      const isPast=ymd<td,isT=ymd===td;
      const hasClean=cos.length>0,hasCi=cis.length>0;
      const hasSameDayTv=cos.some(co=>cis.some(ci=>ci.unit===co.unit));
      const cls="cal-cell"+(isPast?" past":"")+(isT?" tod":"")+(hasClean?" has-clean":"");
      let inner=`<div class="cal-num">${d}</div>`;
      if(hasClean)inner+=`<div class="cal-c-lbl">${cos.length===1?"C":"C\xD7"+cos.length}</div>`;
      else if(hasCi)inner+=`<div class="cal-ci-dot"></div>`;
      if(hasSameDayTv)inner+=`<div class="cal-tv-dot"></div>`;
      const click=devs.length?`onclick="openDetail('${ymd}')"` :"";
      cells+=`<div class="${cls}" ${click}>${inner}</div>`;
    }
    const wds=WD2.map(w=>`<div class="cal-wd">${w}</div>`).join("");
    return`<div style="margin-bottom:28px"><div class="cal-mo-hdr">${MO[m]} ${y}</div><div class="cal-wk">${wds}</div><div class="cal-grid">${cells}</div></div>`;
  }).join("");
  return`<div class="cal-wrap">${grids}</div>`;
}

function bind(){
  document.querySelectorAll(".seg-btn").forEach(el=>el.addEventListener("click",()=>{S.tab=el.dataset.tab;S.selDate=null;render();}));
  document.querySelectorAll(".chip").forEach(el=>el.addEventListener("click",()=>{S.filter=el.dataset.prop;render();}));
  document.querySelectorAll(".dpill").forEach(el=>el.addEventListener("click",()=>{const d=el.dataset.date;S.selDate=(S.selDate===d)?null:d;render();}));
}

function openDetail(ymd){
  const fevs=S.filter==="All"?S.events:S.events.filter(e=>e.unit===S.filter);
  const devs=fevs.filter(e=>e.date===ymd);
  if(!devs.length)return;
  document.getElementById("detail-title").textContent=fmtLong(ymd);
  const rows=devs.map(ev=>{
    const isCo=ev.type==="checkout",col=isCo?"#FF3B30":"#34C759";
    const lbl=isCo?"Cleaning needed":"Check-in";
    const sub=ev.time+(ev.nights>0?" · "+ev.nights+"n":"");
    return`<div class="detail-row">
      <div class="detail-bar" style="background:${col}"></div>
      <div>
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:${col};margin-bottom:2px">${lbl}</div>
        <div style="font-size:15px;font-weight:600">${esc(ev.unit)}</div>
        <div style="font-size:12px;color:#8e8e93;margin-top:1px">${sub}</div>
      </div>
    </div>`;
  }).join("");
  document.getElementById("detail-rows").innerHTML=rows;
  document.getElementById("detail-ov").classList.add("open");
}
function closeDetail(){document.getElementById("detail-ov").classList.remove("open");}

function forceRefresh(){S.loading=true;render();load(true);}
setInterval(()=>load(false),30*60*1000);
load(false);
</script>
</body>
</html>"""


@app.route("/cleaner")
def cleaner_page():
    from flask import make_response
    resp = make_response(_CLEANER_HTML)
    resp.headers["Content-Type"]  = "text/html; charset=utf-8"
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp



# ────────────────────────────────────────────────────────────
#  MESSAGING
# ────────────────────────────────────────────────────────────

import uuid as _uuid
from datetime import datetime as _dt_msg

MESSAGES_DIR = os.path.join("/data" if os.path.isdir("/data") else ".", "messages")
os.makedirs(MESSAGES_DIR, exist_ok=True)

MESSAGE_FILES_DIR = os.path.join("/data" if os.path.isdir("/data") else ".", "message_files")
os.makedirs(MESSAGE_FILES_DIR, exist_ok=True)
ALLOWED_MEDIA_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.heic', '.webp',
                            '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.zip'}
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB

def _conv_id(uid1, uid2):
    """Deterministic conversation ID from two user IDs."""
    return "_".join(sorted([uid1, uid2]))

def _conv_path(conv_id):
    return os.path.join(MESSAGES_DIR, f"{conv_id}.json")

def _load_conv(conv_id):
    path = _conv_path(conv_id)
    if os.path.exists(path):
        with open(path, "r") as f:
            return json.load(f)
    return None

def _save_conv(conv_id, data):
    path = _conv_path(conv_id)
    with open(path, "w") as f:
        json.dump(data, f)

def _get_username(user_id):
    """Look up username for a user_id."""
    # Check auth users first (canonical source of usernames)
    try:
        users = load_users()
        for email, u in users.items():
            if u.get("id") == user_id:
                uname = u.get("username")
                if uname:
                    return uname
                return email.split("@")[0]
    except Exception:
        pass
    # Fallback to store profile
    try:
        store = _load_store_for_user(user_id)
        return store.get("profile", {}).get("username", user_id[:8])
    except Exception:
        return user_id[:8]

def _get_linked_properties(uid, other_id):
    """Get property names linked between two users via cleaner follow."""
    try:
        follows = _load_json_file(FOLLOWS_FILE)
        for fid, f in follows.items():
            if f.get("type") != "cleaner" or f.get("status") != "approved":
                continue
            # Check both directions
            if (f["follower_id"] == other_id and f["following_id"] == uid) or \
               (f["follower_id"] == uid and f["following_id"] == other_id):
                owner_id = f["following_id"]
                selected = f.get("selected_properties", [])
                if not selected:
                    return []
                owner_store = _load_store_for_user(owner_id)
                props = owner_store.get("properties", [])
                return [p.get("label", p.get("id", "")) for p in props
                        if p.get("id") in selected]
    except Exception:
        pass
    return []


@app.route("/api/messages/cleanings/<other_user_id>", methods=["GET"])
def messages_cleanings(other_user_id):
    """Get upcoming cleanings for properties linked between current user and other user."""
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Not authenticated"}), 401
    follows = _load_json_file(FOLLOWS_FILE)
    users = load_users()
    from datetime import datetime as _dt_clean
    today = _dt_clean.utcnow().strftime("%Y-%m-%d")
    events = []
    for fid, f in follows.items():
        if f.get("type") != "cleaner" or f.get("status") != "approved":
            continue
        # Match: one is follower (cleaner), other is following (owner)
        if not ((f["follower_id"] == uid and f["following_id"] == other_user_id) or
                (f["follower_id"] == other_user_id and f["following_id"] == uid)):
            continue
        owner_id = f["following_id"]
        selected_props = f.get("selected_properties", [])
        owner_name = ""
        for email, u in users.items():
            if u["id"] == owner_id:
                owner_name = u.get("username", email.split("@")[0])
                break
        try:
            owner_store = _load_store_for_user(owner_id)
            owner_bookings = owner_store.get("ical_events", [])
            owner_props = owner_store.get("properties", [])
            prop_labels = {p.get("id", ""): p.get("label", p.get("id", "")) for p in owner_props}
            short_names = owner_store.get("pricelabs_short_names", {})
            for b in owner_bookings:
                prop_id = b.get("prop_id", "")
                if selected_props and prop_id not in selected_props:
                    continue
                check_out = b.get("check_out", "")
                if check_out < today:
                    continue
                pl_id = str(b.get("listing_id") or b.get("pl_id") or "")
                unit_name = short_names.get(pl_id, "") if pl_id else ""
                events.append({
                    "check_in": b.get("check_in", ""),
                    "check_out": check_out,
                    "prop_id": prop_id,
                    "prop_name": prop_labels.get(prop_id, prop_id),
                    "unit_name": unit_name,
                    "guest_name": b.get("guest_name", ""),
                })
        except Exception:
            pass
    events.sort(key=lambda x: x.get("check_out", ""))
    return jsonify({"events": events})


@app.route("/api/messages/upload", methods=["POST"])
def messages_upload():
    """Upload a file for messaging."""
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Not authenticated"}), 401
    if 'file' not in request.files:
        return jsonify({"error": "No file provided"}), 400
    f = request.files['file']
    if not f.filename:
        return jsonify({"error": "No filename"}), 400
    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in ALLOWED_MEDIA_EXTENSIONS:
        return jsonify({"error": f"File type {ext} not allowed"}), 400
    # Check size
    f.seek(0, 2)
    size = f.tell()
    f.seek(0)
    if size > MAX_FILE_SIZE:
        return jsonify({"error": "File too large (max 10MB)"}), 400
    file_id = str(_uuid.uuid4())
    saved_name = file_id + ext
    save_path = os.path.join(MESSAGE_FILES_DIR, saved_name)
    f.save(save_path)
    import mimetypes
    mime = mimetypes.guess_type(f.filename)[0] or "application/octet-stream"
    is_image = mime.startswith("image/")
    return jsonify({
        "file_id": file_id,
        "filename": f.filename,
        "file_url": f"/api/messages/files/{saved_name}",
        "mime_type": mime,
        "size": size,
        "is_image": is_image,
    })


@app.route("/api/messages/files/<filename>", methods=["GET"])
def messages_file_serve(filename):
    """Serve uploaded message files."""
    safe = os.path.basename(filename)
    path = os.path.join(MESSAGE_FILES_DIR, safe)
    if not os.path.exists(path):
        return jsonify({"error": "File not found"}), 404
    return send_file(path)


@app.route("/api/messages/conversations", methods=["GET"])
def messages_conversations():
    """List all conversations for the current user."""
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Not authenticated"}), 401
    convos = []
    users = load_users()
    if os.path.exists(MESSAGES_DIR):
        for fname in os.listdir(MESSAGES_DIR):
            if not fname.endswith(".json"):
                continue
            conv_id = fname[:-5]
            data = _load_conv(conv_id)
            if not data or not data.get("messages"):
                continue
            participants = data.get("participants", [])
            if uid not in participants:
                continue
            msgs = data["messages"]
            last_msg = msgs[-1]
            is_group = data.get("is_group", False)

            if is_group:
                # Group conversation
                unread = sum(1 for m in msgs if m["sender_id"] != uid and uid not in m.get("read_by", []))
                last_msg_out = {
                    "text": last_msg["text"],
                    "timestamp": last_msg["timestamp"],
                    "sender_id": last_msg["sender_id"],
                    "sender_name": last_msg.get("sender_name", ""),
                    "has_attachments": bool(last_msg.get("attachments")),
                }
                convos.append({
                    "id": conv_id,
                    "is_group": True,
                    "group_name": data.get("group_name", "Group Chat"),
                    "participant_count": len(participants),
                    "last_message": last_msg_out,
                    "unread_count": unread,
                    "updated_at": last_msg["timestamp"],
                })
            else:
                # 1:1 conversation — use participants array (not conv_id split)
                others = [p for p in participants if p != uid]
                other_id = others[0] if others else conv_id.replace(uid, "").strip("_")
                unread = sum(1 for m in msgs if m["sender_id"] != uid and not m.get("read", False))
                other_role = "owner"
                for _e, _u in users.items():
                    if _u.get("id") == other_id:
                        other_role = _u.get("role", "owner")
                        break
                other_score = None
                if other_role != "cleaner":
                    other_score = _compute_portfolio_score(other_id)
                convos.append({
                    "id": conv_id,
                    "is_group": False,
                    "other_user": {
                        "id": other_id,
                        "username": _get_username(other_id),
                        "role": other_role,
                        "portfolio_score": other_score,
                    },
                    "last_message": {
                        "text": last_msg["text"],
                        "timestamp": last_msg["timestamp"],
                        "sender_id": last_msg["sender_id"],
                        "has_attachments": bool(last_msg.get("attachments")),
                    },
                    "unread_count": unread,
                    "updated_at": last_msg["timestamp"],
                })
    convos.sort(key=lambda c: c["updated_at"], reverse=True)
    return jsonify({"conversations": convos})

@app.route("/api/messages/<other_user_id>", methods=["GET"])
def messages_get(other_user_id):
    """Get messages between current user and another user."""
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Not authenticated"}), 401
    conv_id = _conv_id(uid, other_user_id)
    data = _load_conv(conv_id)
    messages = data["messages"] if data else []
    limit = request.args.get("limit", 50, type=int)
    messages = messages[-limit:]
    # Look up other user's role
    other_role = "owner"
    users = load_users()
    for _e, _u in users.items():
        if _u.get("id") == other_user_id:
            other_role = _u.get("role", "owner")
            break
    linked_props = _get_linked_properties(uid, other_user_id)
    return jsonify({
        "messages": messages,
        "other_user": {"id": other_user_id, "username": _get_username(other_user_id), "role": other_role},
        "linked_properties": linked_props,
        "current_user_id": uid,
    })

@app.route("/api/messages/send", methods=["POST"])
@rate_limit(30, 60)  # 30 per minute — messaging
def messages_send():
    """Send a message to a user or group conversation."""
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Not authenticated"}), 401
    body = request.get_json(force=True) or {}
    text = body.get("text", "").strip()
    attachments = body.get("attachments", [])

    # Validate attachments
    if attachments:
        if len(attachments) > 5:
            return jsonify({"error": "Max 5 attachments per message"}), 400
        for att in attachments:
            if not att.get("file_id") or not att.get("file_url"):
                return jsonify({"error": "Each attachment requires file_id and file_url"}), 400

    if not text and not attachments:
        return jsonify({"error": "text or attachments required"}), 400

    conv_id_param = body.get("conv_id", "").strip()
    to_user_id = body.get("to_user_id", "").strip()

    sender_name = _get_username(uid)
    # Notification text fallback for attachment-only messages
    notif_text = text[:100] if text else ("Sent a photo" if any(a.get("is_image") for a in attachments) else "Sent a file")

    if conv_id_param and conv_id_param.startswith("grp_"):
        # ── Group message ──
        data = _load_conv(conv_id_param)
        if not data or not data.get("is_group"):
            return jsonify({"error": "Group not found"}), 404
        if uid not in data.get("participants", []):
            return jsonify({"error": "Not a participant"}), 403
        msg = {
            "id": str(_uuid.uuid4()),
            "sender_id": uid,
            "sender_name": sender_name,
            "text": text,
            "timestamp": _dt_msg.utcnow().isoformat() + "Z",
            "read_by": [uid],
        }
        if attachments:
            msg["attachments"] = attachments
        data["messages"].append(msg)
        _save_conv(conv_id_param, data)

        # Notify all other participants
        for pid in data["participants"]:
            if pid == uid:
                continue
            _store_notification(pid, "message",
                f"{sender_name} in {data.get('group_name', 'Group Chat')}",
                notif_text,
                {"sender_id": uid, "sender_name": sender_name, "conv_id": conv_id_param})
            pt = _load_json_file(PUSH_TOKENS_FILE)
            prefs = pt.get(pid, {}).get("preferences", {})
            if prefs.get("messages", True):
                tokens = _get_user_push_tokens(pid)
                if tokens:
                    _send_push(tokens,
                        f"{sender_name} in {data.get('group_name', 'Group Chat')}",
                        notif_text,
                        {"type": "message", "conv_id": conv_id_param, "sender_id": uid})

        return jsonify({"message": msg})

    # ── 1:1 message ──
    if not to_user_id:
        return jsonify({"error": "to_user_id or conv_id required"}), 400
    if to_user_id == uid:
        return jsonify({"error": "Cannot message yourself"}), 400
    conv_id = _conv_id(uid, to_user_id)
    data = _load_conv(conv_id)
    if not data:
        data = {"participants": sorted([uid, to_user_id]), "messages": []}
    msg = {
        "id": str(_uuid.uuid4()),
        "sender_id": uid,
        "text": text,
        "timestamp": _dt_msg.utcnow().isoformat() + "Z",
        "read": False,
    }
    if attachments:
        msg["attachments"] = attachments
    data["messages"].append(msg)
    _save_conv(conv_id, data)

    # Push + in-app notification to recipient
    _store_notification(to_user_id, "message",
        f"Message from {sender_name}",
        notif_text,
        {"sender_id": uid, "sender_name": sender_name, "conv_id": conv_id})
    pt = _load_json_file(PUSH_TOKENS_FILE)
    prefs = pt.get(to_user_id, {}).get("preferences", {})
    if prefs.get("messages", True):
        tokens = _get_user_push_tokens(to_user_id)
        if tokens:
            _send_push(tokens,
                f"Message from {sender_name}",
                notif_text,
                {"type": "message", "conv_id": conv_id, "sender_id": uid})

    return jsonify({"message": msg})

@app.route("/api/messages/group/create", methods=["POST"])
def messages_group_create():
    """Create a group conversation."""
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Not authenticated"}), 401
    body = request.get_json(force=True) or {}
    participant_ids = body.get("participant_ids", [])
    group_name = body.get("group_name", "").strip() or "Group Chat"
    # Auto-include creator
    if uid not in participant_ids:
        participant_ids.insert(0, uid)
    if len(participant_ids) < 3:
        return jsonify({"error": "Group requires at least 3 participants"}), 400
    conv_id = "grp_" + str(_uuid.uuid4())
    # Resolve participant names
    participant_names = {}
    for pid in participant_ids:
        participant_names[pid] = _get_username(pid)
    data = {
        "participants": participant_ids,
        "is_group": True,
        "group_name": group_name,
        "created_by": uid,
        "created_at": _dt_msg.utcnow().isoformat() + "Z",
        "participant_names": participant_names,
        "messages": [],
    }
    _save_conv(conv_id, data)
    return jsonify({"ok": True, "conv_id": conv_id, "group_name": group_name})

@app.route("/api/messages/conv/<conv_id>", methods=["GET"])
def messages_conv_get(conv_id):
    """Get messages for a specific conversation (1:1 or group)."""
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Not authenticated"}), 401
    data = _load_conv(conv_id)
    if not data:
        return jsonify({"error": "Conversation not found"}), 404
    if uid not in data.get("participants", []):
        return jsonify({"error": "Not a participant"}), 403
    limit = request.args.get("limit", 50, type=int)
    messages = data.get("messages", [])[-limit:]
    is_group = data.get("is_group", False)
    result = {
        "messages": messages,
        "participants": data.get("participants", []),
        "is_group": is_group,
        "current_user_id": uid,
    }
    if is_group:
        result["group_name"] = data.get("group_name", "Group Chat")
        result["participant_names"] = data.get("participant_names", {})
    else:
        others = [p for p in data.get("participants", []) if p != uid]
        other_id = others[0] if others else None
        if other_id:
            other_role = "owner"
            users = load_users()
            for _e, _u in users.items():
                if _u.get("id") == other_id:
                    other_role = _u.get("role", "owner")
                    break
            result["other_user"] = {"id": other_id, "username": _get_username(other_id), "role": other_role}
            result["linked_properties"] = _get_linked_properties(uid, other_id)
    return jsonify(result)

@app.route("/api/messages/read/<target_id>", methods=["POST"])
def messages_read(target_id):
    """Mark messages as read. target_id = grp_xxx for groups, user_id for 1:1."""
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Not authenticated"}), 401
    if target_id.startswith("grp_"):
        # Group read — add user to read_by arrays
        data = _load_conv(target_id)
        if not data:
            return jsonify({"ok": True})
        if uid not in data.get("participants", []):
            return jsonify({"ok": True})
        changed = False
        for msg in data["messages"]:
            if msg["sender_id"] != uid:
                read_by = msg.get("read_by", [])
                if uid not in read_by:
                    read_by.append(uid)
                    msg["read_by"] = read_by
                    changed = True
        if changed:
            _save_conv(target_id, data)
    else:
        # 1:1 read
        conv_id = _conv_id(uid, target_id)
        data = _load_conv(conv_id)
        if not data:
            return jsonify({"ok": True})
        changed = False
        for msg in data["messages"]:
            if msg["sender_id"] != uid and not msg.get("read", False):
                msg["read"] = True
                changed = True
        if changed:
            _save_conv(conv_id, data)
    return jsonify({"ok": True})

@app.route("/api/messages/unread-count", methods=["GET"])
def messages_unread_count():
    """Get total unread message count for current user."""
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Not authenticated"}), 401
    total = 0
    if os.path.exists(MESSAGES_DIR):
        for fname in os.listdir(MESSAGES_DIR):
            if not fname.endswith(".json"):
                continue
            conv_id = fname[:-5]
            data = _load_conv(conv_id)
            if not data:
                continue
            participants = data.get("participants", [])
            if uid not in participants:
                continue
            is_group = data.get("is_group", False)
            for m in data["messages"]:
                if m["sender_id"] == uid:
                    continue
                if is_group:
                    if uid not in m.get("read_by", []):
                        total += 1
                else:
                    if not m.get("read", False):
                        total += 1
    return jsonify({"unread_count": total})


@app.route("/api/messages/conversations/<conv_id>", methods=["DELETE"])
def messages_delete_conversation(conv_id):
    """Remove user from a conversation (soft-delete for that user)."""
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Not authenticated"}), 401
    data = _load_conv(conv_id)
    if not data:
        return jsonify({"ok": False, "error": "Conversation not found"}), 404
    participants = data.get("participants", [])
    if uid not in participants:
        return jsonify({"ok": False, "error": "Not in this conversation"}), 403
    # Remove user from participants
    data["participants"] = [p for p in participants if p != uid]
    # If no participants left, delete the file entirely
    conv_path = os.path.join(MESSAGES_DIR, f"{conv_id}.json")
    if not data["participants"]:
        try:
            os.remove(conv_path)
        except OSError:
            pass
    else:
        _save_conv(conv_id, data)
    return jsonify({"ok": True})


# ── Property Valuation Engine ─────────────────────────────────

# City-based annual appreciation rates (national average 3.5%)
CITY_APPRECIATION_RATES = {
    "austin": 0.055, "boise": 0.05, "nashville": 0.05, "raleigh": 0.048,
    "tampa": 0.047, "phoenix": 0.046, "dallas": 0.045, "charlotte": 0.045,
    "denver": 0.044, "atlanta": 0.043, "houston": 0.04, "orlando": 0.04,
    "jacksonville": 0.04, "san antonio": 0.038, "las vegas": 0.038,
    "seattle": 0.042, "portland": 0.035, "miami": 0.04, "fort lauderdale": 0.04,
    "san diego": 0.038, "los angeles": 0.035, "san francisco": 0.03,
    "new york": 0.028, "chicago": 0.025, "detroit": 0.03, "cleveland": 0.022,
    "st louis": 0.02, "baltimore": 0.025, "philadelphia": 0.03,
    "minneapolis": 0.032, "kansas city": 0.033, "indianapolis": 0.035,
    "columbus": 0.038, "salt lake city": 0.045, "savannah": 0.04,
    "charleston": 0.042, "asheville": 0.04, "gatlinburg": 0.045,
    "pigeon forge": 0.045, "destin": 0.04, "gulf shores": 0.038,
    "myrtle beach": 0.035, "panama city": 0.035, "scottsdale": 0.046,
    "sedona": 0.04, "park city": 0.042, "big bear": 0.035,
    "joshua tree": 0.04, "palm springs": 0.038, "key west": 0.035,
}

def _get_appreciation_rate(market: str) -> float:
    """Return city-specific appreciation rate, or 3.5% national average."""
    if not market:
        return 0.035
    m = market.lower().strip()
    # Try exact match, then substring
    if m in CITY_APPRECIATION_RATES:
        return CITY_APPRECIATION_RATES[m]
    for city, rate in CITY_APPRECIATION_RATES.items():
        if city in m or m in city:
            return rate
    return 0.035  # National average


# ── Federal Funds Rate Cache ──
_fed_rate_cache = {"rate": 5.25, "fetched_at": 0}
_fed_rate_lock = threading.Lock()

def _fetch_federal_funds_rate():
    """Scrape current federal funds rate from federalreserve.gov.
    Cache for 15 days. On failure, use last cached value or default 5.25%."""
    with _fed_rate_lock:
        now = _time.time()
        if now - _fed_rate_cache["fetched_at"] < 15 * 86400:
            return _fed_rate_cache["rate"]
    try:
        import urllib.request
        url = "https://www.federalreserve.gov/releases/h15/default.htm"
        req = urllib.request.Request(url, headers={"User-Agent": "PortfolioPigeon/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
        # Parse federal funds effective rate from the H.15 page
        import re
        # Look for the effective rate pattern near "Federal funds"
        match = re.search(r'Federal funds.*?(\d+\.\d+)\s*</td>', html, re.DOTALL | re.IGNORECASE)
        if match:
            rate = float(match.group(1))
            with _fed_rate_lock:
                _fed_rate_cache["rate"] = rate
                _fed_rate_cache["fetched_at"] = now
            logger.info("Federal funds rate updated: %.2f%%", rate)
            return rate
    except Exception as e:
        logger.warning("Failed to fetch federal funds rate: %s", e)
    return _fed_rate_cache["rate"]


@app.route("/api/properties/<prop_id>/valuation", methods=["GET"])
def property_valuation(prop_id):
    """Portfolio Pigeon proprietary 4-method blended valuation."""
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Not authenticated"}), 401

    store = load_store()
    props = store.get("properties", []) + store.get("custom_props", [])
    prop = None
    for p in props:
        if (p.get("id") or p.get("name")) == prop_id:
            prop = p
            break
    if not prop:
        return jsonify({"error": "Property not found"}), 404

    if prop.get("valuationOptOut"):
        return jsonify({"valuation": None, "opted_out": True})

    purchase_price = prop.get("purchasePrice")
    purchase_date = prop.get("purchaseDate")
    if not purchase_price or not purchase_date:
        return jsonify({"valuation": None, "missing_data": True})

    from datetime import date as _d
    try:
        pd = _d.fromisoformat(purchase_date)
    except Exception:
        return jsonify({"valuation": None, "error": "Invalid purchase date"}), 400

    today = _d.today()
    years_owned = max((today - pd).days / 365.25, 0)
    market = prop.get("market", "")
    appreciation_rate = _get_appreciation_rate(market)
    is_str = prop.get("isAirbnb", False)
    cap_rate = 0.065  # Default 6.5%

    # ── Gather transaction data ──
    tags = store.get("tags", {})
    cat_tags = store.get("category_tags", {})
    txs = store.get("transactions", {})
    INCOME_CATS = {"__rental_income__", "__cleaning_income__"}
    EXCLUDED_CATS = {"__delete__", "__internal_transfer__"}

    total_rev = 0.0
    total_exp = 0.0
    earliest_date = None
    latest_date = None
    # Per-year revenue for trend calculation
    rev_by_year = {}

    for tx_id, tx in txs.items():
        prop_tag = tags.get(tx_id)
        cat_tag = cat_tags.get(tx_id)
        if not prop_tag and not cat_tag:
            continue
        if cat_tag in EXCLUDED_CATS:
            continue

        # Only count transactions tagged to this property or income categories
        belongs = (prop_tag == prop_id) or (cat_tag in INCOME_CATS and not prop_tag)
        if not belongs:
            continue

        amount = abs(tx.get("amount", 0))
        tx_type = tx.get("type", "out")
        is_income = cat_tag in INCOME_CATS or (not cat_tag and tx_type == "in")
        d = tx.get("date", "")

        if is_income:
            total_rev += amount
            if d and len(d) >= 4:
                yr = d[:4]
                rev_by_year[yr] = rev_by_year.get(yr, 0) + amount
        else:
            total_exp += amount

        if d:
            if not earliest_date or d < earliest_date:
                earliest_date = d
            if not latest_date or d > latest_date:
                latest_date = d

    # Annualize revenue and expenses
    annual_rev = 0.0
    annual_exp = 0.0
    months_of_data = 0
    if earliest_date and latest_date and total_rev > 0:
        try:
            e = _d.fromisoformat(earliest_date)
            l = _d.fromisoformat(latest_date)
            days = max((l - e).days, 30)
            months_of_data = days / 30.44
            annual_rev = (total_rev / days) * 365.25
            annual_exp = (total_exp / days) * 365.25 if total_exp > 0 else 0
        except Exception:
            annual_rev = total_rev
            annual_exp = total_exp

    # If no revenue, use appreciation only at 100%
    if annual_rev <= 0:
        appreciation_value = purchase_price * ((1 + appreciation_rate) ** years_owned)
        equity_gain = appreciation_value - purchase_price
        return jsonify({
            "valuation": {
                "estimate": round(appreciation_value, 0),
                "equity_gain": round(equity_gain, 0),
                "purchase_price": purchase_price,
                "years_owned": round(years_owned, 1),
                "method": "appreciation_only",
            },
        })

    # ══ METHOD 1: Appreciation (30%) ══
    m1_value = purchase_price * ((1 + appreciation_rate) ** years_owned)

    # ══ METHOD 2: Income/Cap Rate (35%) ══
    # NOI = gross revenue - actual expenses (or gross × 0.35 if no expense data)
    noi = annual_rev - annual_exp if annual_exp > 0 else annual_rev * 0.35
    m2_value = noi / cap_rate if cap_rate > 0 else 0

    # Federal funds rate adjustment
    fed_rate = _fetch_federal_funds_rate()
    if fed_rate > 5.0:
        m2_value *= 0.97  # Compress 3%
    elif fed_rate < 3.0:
        m2_value *= 1.03  # Expand 3%

    # ══ METHOD 3: GRM (15%) ══
    grm = 10 if is_str else 12
    m3_value = annual_rev * grm

    # ══ METHOD 4: Revenue Trend Premium (20%) ══
    # Compare last 2 years of revenue for YoY growth
    sorted_years = sorted(rev_by_year.keys())
    trend_multiplier = 1.0
    if len(sorted_years) >= 2:
        cur_yr_rev = rev_by_year[sorted_years[-1]]
        prev_yr_rev = rev_by_year[sorted_years[-2]]
        if prev_yr_rev > 0:
            yoy_growth = (cur_yr_rev - prev_yr_rev) / prev_yr_rev
            # Scale linearly: -15% → 0.85x, 0% → 1.0x, +15% → 1.15x
            trend_multiplier = max(0.85, min(1.15, 1.0 + yoy_growth))
    # If < 12 months or no prior year, neutral 1.0x (already default)
    m4_value = m2_value * trend_multiplier

    # ══ BLEND ══
    blended = (m1_value * 0.30) + (m2_value * 0.35) + (m3_value * 0.15) + (m4_value * 0.20)

    # ── Additional adjustments ──
    # Stability premium: 5+ years owned → 1.5% boost
    if years_owned >= 5:
        blended *= 1.015

    equity_gain = blended - purchase_price

    return jsonify({
        "valuation": {
            "estimate": round(blended, 0),
            "equity_gain": round(equity_gain, 0),
            "purchase_price": purchase_price,
            "years_owned": round(years_owned, 1),
            "method": "blended_4x",
        },
    })


# ── Airbnb Payout Split Engine ─────────────────────────────────

@app.route("/api/income/split-suggest", methods=["POST"])
def income_split_suggest():
    """Given a transaction ID tagged as Airbnb income, suggest a per-property split
    based on PriceLabs booking nights in the payout period.
    Returns: { splits: [{prop_id, prop_label, nights, pct, amount}], has_data: bool }
    If no booking data, returns has_data: false so frontend can ask user for manual split."""
    body = request.json or {}
    tx_ids = body.get("tx_ids", [])
    if isinstance(tx_ids, str):
        tx_ids = [tx_ids]
    if not tx_ids:
        return jsonify({"error": "tx_ids required"}), 400

    store = load_store()
    txs = store.get("transactions", {})
    pl_bookings = store.get("ical_events", [])
    props = store.get("properties", []) + store.get("custom_props", [])

    # Dedupe props
    seen = set()
    unique_props = []
    for p in props:
        pid = p.get("id") or p.get("name")
        if pid and pid not in seen:
            seen.add(pid)
            unique_props.append(p)

    # Get total amount and date range from selected transactions
    total_amount = 0.0
    min_date = None
    max_date = None
    for tid in tx_ids:
        tx = txs.get(tid)
        if not tx:
            continue
        total_amount += abs(tx.get("amount", 0))
        d = tx.get("date", "")
        if d:
            if not min_date or d < min_date:
                min_date = d
            if not max_date or d > max_date:
                max_date = d

    if total_amount <= 0:
        return jsonify({"error": "No valid transactions"}), 400

    # Expand date window: payouts cover ~30 days before the payout date
    from datetime import date as _d, timedelta as _td
    try:
        end_date = _d.fromisoformat(max_date) if max_date else _d.today()
        start_date = _d.fromisoformat(min_date) - _td(days=35) if min_date else end_date - _td(days=35)
    except Exception:
        end_date = _d.today()
        start_date = end_date - _td(days=35)

    # Count nights per property from PriceLabs bookings in the payout window
    nights_by_prop = {}

    for b in pl_bookings:
        prop_id = b.get("prop_id")
        if not prop_id:
            continue
        status = (b.get("status") or "").lower()
        if "cancel" in status:
            continue
        b_ci = b.get("check_in", "")
        b_co = b.get("check_out", "")
        if not b_ci:
            continue
        try:
            es = _d.fromisoformat(b_ci[:10])
            ee = _d.fromisoformat(b_co[:10]) if b_co else es + _td(days=int(b.get("nights") or 1))
        except Exception:
            continue
        overlap_start = max(es, start_date)
        overlap_end = min(ee, end_date)
        overlap_nights = max(0, (overlap_end - overlap_start).days)
        if overlap_nights > 0:
            nights_by_prop[prop_id] = nights_by_prop.get(prop_id, 0) + overlap_nights

    total_nights = sum(nights_by_prop.values())
    has_data = total_nights > 0

    if has_data:
        # Proportional split based on nights
        splits = []
        for pid, nights in sorted(nights_by_prop.items(), key=lambda x: -x[1]):
            pct = nights / total_nights
            prop = next((p for p in unique_props if (p.get("id") or p.get("name")) == pid), None)
            splits.append({
                "prop_id": pid,
                "prop_label": (prop.get("label") or prop.get("name") or pid) if prop else pid,
                "nights": nights,
                "pct": round(pct * 100, 1),
                "amount": round(total_amount * pct, 2),
            })
    else:
        # No booking data — return all STR properties with equal split for user to adjust
        str_props = [p for p in unique_props if p.get("isAirbnb")]
        if not str_props:
            str_props = unique_props
        equal_pct = 100.0 / max(len(str_props), 1)
        splits = [{
            "prop_id": p.get("id") or p.get("name"),
            "prop_label": p.get("label") or p.get("name") or "Property",
            "nights": 0,
            "pct": round(equal_pct, 1),
            "amount": round(total_amount * equal_pct / 100, 2),
        } for p in str_props]

    return jsonify({
        "splits": splits,
        "has_data": has_data,
        "total_amount": round(total_amount, 2),
        "tx_ids": tx_ids,
        "window": {"start": str(start_date), "end": str(end_date)},
    })


@app.route("/api/income/split-apply", methods=["POST"])
def income_split_apply():
    """Apply a user-confirmed split: tag each tx proportionally to properties."""
    body = request.json or {}
    tx_ids = body.get("tx_ids", [])
    splits = body.get("splits", [])
    if not tx_ids or not splits:
        return jsonify({"error": "tx_ids and splits required"}), 400

    store = load_store()
    tags = store.get("tags", {})
    cat_tags = store.get("category_tags", {})
    txs = store.get("transactions", {})

    # Store split metadata on transactions
    split_data = {s["prop_id"]: s["pct"] for s in splits}
    for tid in tx_ids:
        if tid not in txs:
            continue
        # Tag as rental income
        cat_tags[tid] = "__rental_income__"
        # Store the split info on the transaction for per-property revenue calculation
        txs[tid]["revenue_split"] = split_data
        # Tag to the highest-percentage property for primary display
        primary = max(splits, key=lambda s: s["pct"])
        tags[tid] = primary["prop_id"]

    store["tags"] = tags
    store["category_tags"] = cat_tags
    store["transactions"] = txs
    save_store(store)

    uid = getattr(g, 'user_id', None)
    _invalidate_cache("transactions", uid)
    _invalidate_cache("tags", uid)
    _invalidate_cache("cockpit", uid)

    return jsonify({"ok": True, "applied": len(tx_ids)})


# ── Investor Network Map ──────────────────────────────────────
@app.route("/api/map/properties", methods=["GET"])
def map_properties():
    """Return all public properties with lat/lng for the network map.
    Each property includes owner info and projected annual revenue."""
    all_props = []
    users = load_users()
    requesting_uid = getattr(g, 'user_id', None)

    for email, user_data in users.items():
        uid = user_data.get("id")
        username = user_data.get("username", "")
        role = user_data.get("role", "owner")
        if role != "owner":
            continue

        # Load this user's store for properties and financials
        base = "/data" if _os.path.isdir("/data") else "."
        store_file = f"{base}/store_{uid}.json"
        if not _os.path.exists(store_file):
            continue
        try:
            with open(store_file) as f:
                store = json.load(f)
        except Exception:
            continue

        # Check both properties and custom_props (mobile saves to custom_props)
        props = store.get("properties", []) + store.get("custom_props", [])
        # Deduplicate by id
        seen_ids = set()
        deduped = []
        for p in props:
            pid = p.get("id") or p.get("name")
            if pid and pid not in seen_ids:
                seen_ids.add(pid)
                deduped.append(p)
        props = deduped
        tags = store.get("tags", {})
        cat_tags = store.get("category_tags", {})
        txs = store.get("transactions", {})
        INCOME_CATS = {"__rental_income__", "__cleaning_income__"}

        for p in props:
            lat = p.get("lat")
            lng = p.get("lng")
            if not lat or not lng:
                continue
            # Skip private properties
            if p.get("private"):
                continue

            pid = p.get("id") or p.get("name")
            is_own = uid == requesting_uid

            # Compute annual revenue from tagged transactions
            annual_rev = 0.0
            for tx_id, tx in txs.items():
                prop_tag = tags.get(tx_id)
                cat_tag = cat_tags.get(tx_id)
                if prop_tag != pid and cat_tag not in INCOME_CATS:
                    continue
                if prop_tag == pid or (cat_tag in INCOME_CATS and not prop_tag):
                    amount = abs(tx.get("amount", 0))
                    tx_type = tx.get("type", "out")
                    is_income = cat_tag in INCOME_CATS or (not cat_tag and tx_type == "in")
                    if is_income:
                        annual_rev += amount

            all_props.append({
                "id": pid,
                "lat": lat,
                "lng": lng,
                "label": p.get("label") or p.get("name", ""),
                "address": p.get("address", ""),
                "units": p.get("units", 1),
                "isAirbnb": p.get("isAirbnb", False),
                "market": p.get("market", ""),
                "revenue": round(annual_rev, 0),
                "owner_id": uid,
                "owner_username": username,
                "is_own": is_own,
                "photos": (p.get("photos") or [])[:1],  # Only first photo
            })

    return jsonify({"properties": all_props})


# ── Tag rules ─────────────────────────────────────────────────
@app.route("/api/tags/rule", methods=["POST"])
def add_tag_rule():
    body = request.get_json(force=True) or {}
    payee = body.get("payee")
    prop_id = body.get("prop_id")  # property ID or category tag (e.g. __rental_income__)
    if not payee or not prop_id:
        return jsonify({"ok": False, "error": "payee and prop_id required"}), 400
    store = load_store()
    if "rules" not in store:
        store["rules"] = {}
    store["rules"][payee] = prop_id
    save_store(store)

    # Retroactively apply rule to existing untagged transactions
    tags = store.get("tags", {})
    cat_tags = store.get("category_tags", {})
    tx_store = store.get("transactions", {})
    applied = 0
    payee_lower = payee.lower().strip()
    for tx_id, tx in tx_store.items():
        if tx_id in tags or tx_id in cat_tags:
            continue
        tx_payee = (tx.get("payee") or tx.get("name") or "").lower().strip()
        if payee_lower in tx_payee or tx_payee in payee_lower:
            if prop_id.startswith("__"):
                cat_tags[tx_id] = prop_id
            else:
                tags[tx_id] = prop_id
            tx_store[tx_id]["auto_tagged"] = True
            applied += 1
    if applied > 0:
        store["tags"] = tags
        store["category_tags"] = cat_tags
        store["transactions"] = tx_store
        save_store(store)
        uid = getattr(g, 'user_id', None)
        _invalidate_cache("transactions", uid)
        _invalidate_cache("tags", uid)
        _invalidate_cache("cockpit", uid)
    return jsonify({"ok": True, "applied": applied})

@app.route("/api/tags/rule", methods=["DELETE"])
def delete_tag_rule():
    body = request.get_json(force=True) or {}
    payee = body.get("payee")
    if not payee:
        return jsonify({"ok": False, "error": "payee required"}), 400
    store = load_store()
    rules = store.get("rules", {})
    rules.pop(payee, None)
    store["rules"] = rules
    save_store(store)
    return jsonify({"ok": True})

# ── Inventory update ──────────────────────────────────────────
@app.route("/api/inventory/update", methods=["POST"])
def inventory_update():
    body = request.get_json(force=True) or {}
    item_id = body.get("itemId")
    quantity = body.get("quantity")
    if item_id is None or quantity is None:
        return jsonify({"ok": False, "error": "itemId and quantity required"}), 400
    store = load_store()
    groups = store.get("inv_groups", [])
    found = False
    for group in groups:
        for item in group.get("items", []):
            if item.get("id") == item_id:
                # Calculate current qty: initialQty + sum(restocks) - threshold losses
                initial = item.get("initialQty", 0)
                restocks = item.get("restocks", [])
                current = initial + sum(r.get("qty", 0) for r in restocks)
                diff = quantity - current
                if diff != 0:
                    restocks.append({"qty": diff, "ts": _time.time()})
                    item["restocks"] = restocks
                found = True
                break
        if found:
            break
    if not found:
        return jsonify({"ok": False, "error": "Item not found"}), 404
    store["inv_groups"] = groups
    save_store(store)
    return jsonify({"ok": True})

# ── Combined sync (transactions) ──────────────────────────────
@app.route("/api/sync", methods=["POST"])
def combined_sync():
    results = {}
    # Transactions sync
    try:
        tx_result = run_sync()
        results["transactions"] = tx_result
    except Exception as e:
        msg, _ = _safe_error(e, "Transaction sync")
        results["transactions"] = {"ok": False, "error": msg}
    return jsonify(results)


# ═══════════════════════════════════════════════════
# ──  IN-APP PURCHASE / APPLE ENDPOINTS
# ═══════════════════════════════════════════════════

APPLE_VERIFY_RECEIPT_PROD = "https://buy.itunes.apple.com/verifyReceipt"
APPLE_VERIFY_RECEIPT_SANDBOX = "https://sandbox.itunes.apple.com/verifyReceipt"

@app.route("/api/iap/apple-notifications", methods=["POST"])
def apple_server_notifications():
    """
    Receives App Store Server Notifications (v2).
    Apple sends these when subscription events occur:
    renewal, cancellation, refund, grace period, etc.
    """
    try:
        payload = request.get_json(force=True) or {}
        signed_payload = payload.get("signedPayload", "")

        if not signed_payload:
            return jsonify({"error": "Missing signedPayload"}), 400

        # Decode the JWS payload (JWT without full verification for now)
        # In production, verify with Apple's certificate chain
        parts = signed_payload.split(".")
        if len(parts) != 3:
            return jsonify({"error": "Invalid JWS format"}), 400

        # Decode payload (base64url)
        padded = parts[1] + "=" * (4 - len(parts[1]) % 4)
        decoded = base64.urlsafe_b64decode(padded)
        notification = json.loads(decoded)

        notification_type = notification.get("notificationType", "")
        subtype = notification.get("subtype", "")

        # Extract transaction info if available
        data = notification.get("data", {})
        signed_transaction = data.get("signedTransactionInfo", "")
        signed_renewal = data.get("signedRenewalInfo", "")

        # Decode transaction info
        transaction_info = {}
        if signed_transaction:
            try:
                tx_parts = signed_transaction.split(".")
                if len(tx_parts) == 3:
                    tx_padded = tx_parts[1] + "=" * (4 - len(tx_parts[1]) % 4)
                    transaction_info = json.loads(base64.urlsafe_b64decode(tx_padded))
            except Exception:
                pass

        app_account_token = transaction_info.get("appAccountToken", "")
        product_id = transaction_info.get("productId", "")
        original_transaction_id = transaction_info.get("originalTransactionId", "")

        # Log the notification
        app.logger.info(
            f"Apple Notification: type={notification_type} subtype={subtype} "
            f"product={product_id} txn={original_transaction_id} "
            f"user={app_account_token}"
        )

        # Handle specific notification types
        if notification_type in ("DID_RENEW", "SUBSCRIBED", "OFFER_REDEEMED"):
            # Subscription active — update user if we can identify them
            if app_account_token:
                _update_iap_status(app_account_token, product_id, "active")
        elif notification_type in ("EXPIRED", "REVOKE"):
            if app_account_token:
                _update_iap_status(app_account_token, product_id, "expired")
        elif notification_type == "DID_FAIL_TO_RENEW":
            if app_account_token:
                _update_iap_status(app_account_token, product_id, "past_due")
        elif notification_type == "REFUND":
            if app_account_token:
                _update_iap_status(app_account_token, product_id, "refunded")
        elif notification_type == "GRACE_PERIOD_EXPIRED":
            if app_account_token:
                _update_iap_status(app_account_token, product_id, "expired")

        return jsonify({"status": "ok"}), 200

    except Exception as e:
        app.logger.error(f"Apple notification error: {e}")
        return jsonify({"status": "ok"}), 200  # Always return 200 to Apple


def _update_iap_status(user_identifier, product_id, status):
    """Update a user's IAP subscription status in the users JSON store."""
    try:
        users = load_users()
        # app_account_token is the user's email
        if user_identifier not in users:
            return
        users[user_identifier]["iap_status"] = {
            "product_id": product_id,
            "status": status,
            "updated_at": _time.time(),
        }
        save_users(users)
    except Exception as e:
        app.logger.error(f"IAP status update error: {e}")


@app.route("/api/iap/verify-receipt", methods=["POST"])
def verify_apple_receipt():
    """
    Validates an Apple App Store receipt.
    The client sends the receipt data, we verify it with Apple's servers,
    and return the subscription status.
    """
    user_id = g.user_id
    data = request.get_json(force=True) or {}
    receipt_data = data.get("receipt_data", "")

    if not receipt_data:
        return jsonify({"error": "Missing receipt_data"}), 400

    # Verify with Apple — try production first, fall back to sandbox
    verify_payload = {
        "receipt-data": receipt_data,
        "exclude-old-transactions": True,
    }

    try:
        # Try production first
        resp = requests.post(APPLE_VERIFY_RECEIPT_PROD, json=verify_payload, timeout=15)
        result = resp.json()

        # Status 21007 means sandbox receipt sent to production — retry with sandbox
        if result.get("status") == 21007:
            resp = requests.post(APPLE_VERIFY_RECEIPT_SANDBOX, json=verify_payload, timeout=15)
            result = resp.json()

        status = result.get("status", -1)

        if status != 0:
            return jsonify({
                "valid": False,
                "is_active": False,
                "error": f"Receipt validation failed (status {status})",
            }), 200

        # Parse latest receipt info
        latest_receipt_info = result.get("latest_receipt_info", [])
        pending_renewal = result.get("pending_renewal_info", [])

        # Check for active subscription
        is_active = False
        product_id = None
        expires_date = None

        for receipt in latest_receipt_info:
            exp_ms = int(receipt.get("expires_date_ms", "0"))
            if exp_ms > int(_time.time() * 1000):
                is_active = True
                product_id = receipt.get("product_id")
                expires_date = exp_ms / 1000
                break

        # Check if in billing retry / grace period
        in_grace_period = False
        for renewal in pending_renewal:
            if renewal.get("is_in_billing_retry_period") == "1":
                in_grace_period = True
                is_active = True  # Grant access during grace period
                break

        return jsonify({
            "valid": True,
            "is_active": is_active,
            "product_id": product_id,
            "expires_date": expires_date,
            "in_grace_period": in_grace_period,
        }), 200

    except Exception as e:
        app.logger.error(f"Receipt verification error: {e}")
        return jsonify({
            "valid": False,
            "is_active": False,
            "error": "Could not verify receipt",
        }), 500


# ── Property Link Requests (request/invite) ──────────────────

def _load_property_requests():
    return _load_json_file(PROPERTY_REQUESTS_FILE)

def _save_property_requests(data):
    _save_json_file(PROPERTY_REQUESTS_FILE, data)

def _inject_system_message(user_a, user_b, system_data):
    """Insert a system message into the 1:1 conversation between two users."""
    cid = _conv_id(user_a, user_b)
    conv = _load_conv(cid)
    if conv is None:
        conv = {"participants": sorted([user_a, user_b]), "messages": []}
    msg = {
        "id": str(_uuid.uuid4()),
        "sender_id": "__system__",
        "text": "",
        "timestamp": _dt_msg.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "system": True,
        "system_data": system_data,
    }
    conv["messages"].append(msg)
    _save_conv(cid, conv)
    return msg["id"]

def _update_system_message(user_a, user_b, message_id, updates):
    """Update system_data fields on an existing system message."""
    cid = _conv_id(user_a, user_b)
    conv = _load_conv(cid)
    if not conv:
        return
    for m in conv["messages"]:
        if m.get("id") == message_id and m.get("system"):
            m["system_data"] = {**m.get("system_data", {}), **updates}
            break
    _save_conv(cid, conv)

@app.route("/api/property-request/create", methods=["POST"])
def property_request_create():
    """Create a property link request (cleaner→host) or invite (host→cleaner)."""
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Not authenticated"}), 401
    body = request.get_json(force=True) or {}
    target_user_id = body.get("target_user_id", "")
    property_ids = body.get("property_ids", [])
    feed_keys = body.get("feed_keys", [])  # optional unit-level selection
    req_type = body.get("type", "request")  # "request" or "invite"

    if not target_user_id or not property_ids:
        return jsonify({"error": "target_user_id and property_ids required"}), 400
    if req_type not in ("request", "invite"):
        return jsonify({"error": "type must be 'request' or 'invite'"}), 400

    # Determine host_id and cleaner_id
    if req_type == "request":
        cleaner_id = uid
        host_id = target_user_id
    else:
        host_id = uid
        cleaner_id = target_user_id

    # Validate properties belong to host and have PriceLabs listings
    host_store = _load_store_for_user(host_id)
    host_props = host_store.get("properties", [])
    pl_listings = host_store.get("pricelabs_listings_raw", [])
    pl_prop_ids = set(l.get("prop_id", "") for l in pl_listings if l.get("prop_id"))
    host_prop_ids = set(p.get("id", "") for p in host_props)

    valid_ids = []
    valid_labels = []
    for pid in property_ids:
        if pid in host_prop_ids and pid in pl_prop_ids:
            valid_ids.append(pid)
            label = next((p.get("label", pid) for p in host_props if p.get("id") == pid), pid)
            valid_labels.append(label)

    if not valid_ids:
        return jsonify({"error": "No valid PriceLabs-linked properties found"}), 400

    # Build unit labels for display if feed_keys provided
    unit_labels = []
    if feed_keys:
        short_names = host_store.get("pricelabs_short_names", {})
        for fk in feed_keys:
            uname = short_names.get(fk, "")
            if not uname:
                uname = fk[:8]
            unit_labels.append(uname)

    display_labels = unit_labels if unit_labels else valid_labels

    # Check for duplicate pending requests
    requests = _load_property_requests()
    for rid, r in requests.items():
        if (r.get("status") == "pending" and
            r.get("cleaner_id") == cleaner_id and
            r.get("host_id") == host_id and
            set(r.get("property_ids", [])) == set(valid_ids)):
            return jsonify({"error": "A pending request for these properties already exists"}), 409

    # Create record
    request_id = "pr_" + secrets.token_hex(8)
    users = load_users()
    requester_name = ""
    for email, u in users.items():
        if u.get("id") == uid:
            requester_name = u.get("username") or email.split("@")[0]
            break

    # Inject system message into chat
    if req_type == "request":
        sys_type = "property_request"
        description = f"{requester_name} requested access to: {', '.join(display_labels)}"
    else:
        sys_type = "property_invite"
        description = f"{requester_name} invited you to: {', '.join(display_labels)}"

    sys_data = {
        "type": sys_type,
        "request_id": request_id,
        "target_id": target_user_id,
        "property_labels": display_labels,
        "requester_name": requester_name,
        "status": "pending",
    }
    message_id = _inject_system_message(uid, target_user_id, sys_data)

    record = {
        "id": request_id,
        "type": req_type,
        "requester_id": uid,
        "target_id": target_user_id,
        "host_id": host_id,
        "cleaner_id": cleaner_id,
        "property_ids": valid_ids,
        "property_labels": valid_labels,
        "feed_keys": feed_keys,
        "unit_labels": unit_labels,
        "status": "pending",
        "created_at": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()),
        "resolved_at": None,
        "message_id": message_id,
    }
    requests[request_id] = record
    _save_property_requests(requests)

    # Notify target
    notif_title = "Property Request" if req_type == "request" else "Property Invite"
    _store_notification(target_user_id, "property_request", notif_title, description,
                        {"request_id": request_id, "from_user_id": uid})
    tokens = _get_user_push_tokens(target_user_id)
    if tokens:
        pt = _load_json_file(PUSH_TOKENS_FILE)
        prefs = pt.get(target_user_id, {}).get("preferences", {})
        if prefs.get("messages", True):
            _send_push(tokens, notif_title, description,
                       {"type": "property_request", "request_id": request_id})

    return jsonify({"ok": True, "request": record})

@app.route("/api/property-request/respond", methods=["POST"])
def property_request_respond():
    """Approve or deny a property link request/invite."""
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Not authenticated"}), 401
    body = request.get_json(force=True) or {}
    request_id = body.get("request_id", "")
    action = body.get("action", "")

    if action not in ("approve", "deny"):
        return jsonify({"error": "action must be 'approve' or 'deny'"}), 400

    requests = _load_property_requests()
    rec = requests.get(request_id)
    if not rec:
        return jsonify({"error": "Request not found"}), 404
    if rec["target_id"] != uid:
        return jsonify({"error": "Only the target can respond"}), 403
    if rec["status"] != "pending":
        return jsonify({"error": "Request already resolved"}), 400

    rec["status"] = "approved" if action == "approve" else "denied"
    rec["resolved_at"] = _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime())
    requests[request_id] = rec
    _save_property_requests(requests)

    # Update the system message in chat
    _update_system_message(rec["requester_id"], rec["target_id"],
                           rec.get("message_id", ""),
                           {"status": rec["status"]})

    if action == "approve":
        # Merge property_ids into follow's selected_properties
        follows = _load_json_file(FOLLOWS_FILE)
        host_id = rec["host_id"]
        cleaner_id = rec["cleaner_id"]

        # Find existing follow or auto-create
        follow_found = None
        for fid, f in follows.items():
            if (f.get("follower_id") == cleaner_id and
                f.get("following_id") == host_id and
                f.get("status") == "approved"):
                follow_found = (fid, f)
                break

        if follow_found:
            fid, f = follow_found
            existing = set(f.get("selected_properties", []))
            existing.update(rec["property_ids"])
            f["selected_properties"] = list(existing)
            follows[fid] = f
        else:
            # Auto-create approved follow for host invites
            new_fid = "f_" + secrets.token_hex(8)
            follows[new_fid] = {
                "follower_id": cleaner_id,
                "following_id": host_id,
                "type": "cleaner",
                "status": "approved",
                "requested_at": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()),
                "selected_properties": rec["property_ids"],
            }
        _save_json_file(FOLLOWS_FILE, follows)

    # Notify the requester
    users = load_users()
    responder_name = ""
    for email, u in users.items():
        if u.get("id") == uid:
            responder_name = u.get("username") or email.split("@")[0]
            break

    status_label = "approved" if action == "approve" else "denied"
    notif_body = f"{responder_name} {status_label} the property {'request' if rec['type'] == 'request' else 'invite'}"
    _store_notification(rec["requester_id"], "property_request_response",
                        f"Request {status_label.title()}", notif_body,
                        {"request_id": request_id, "status": rec["status"]})
    tokens = _get_user_push_tokens(rec["requester_id"])
    if tokens:
        _send_push(tokens, f"Request {status_label.title()}", notif_body,
                   {"type": "property_request_response", "request_id": request_id})

    return jsonify({"ok": True, "status": rec["status"]})

@app.route("/api/invoices/between/<other_user_id>", methods=["GET"])
def invoices_between(other_user_id):
    """Returns all invoices between authenticated user and other_user_id (both directions)."""
    uid = getattr(g, 'user_id', None)
    if not uid:
        return jsonify({"error": "Not authenticated"}), 401

    result = []

    # Invoices sent by uid to other_user_id
    my_invoices = _load_invoices(uid)
    for inv in my_invoices:
        if inv.get("hostId") == other_user_id:
            result.append({**inv, "direction": "sent"})

    # Invoices received by uid from other_user_id
    received = _load_received_invoices(uid)
    for inv in received:
        if inv.get("cleanerId") == other_user_id:
            result.append({**inv, "direction": "received"})

    # Also check: invoices sent by other to uid (from other's cleaner invoices)
    other_invoices = _load_invoices(other_user_id)
    for inv in other_invoices:
        if inv.get("hostId") == uid and inv.get("status") in ("sent", "paid"):
            # Avoid duplicates (already in received)
            if not any(r.get("id") == inv["id"] for r in result):
                result.append({**inv, "direction": "received"})

    result.sort(key=lambda x: x.get("createdAt", ""), reverse=True)
    return jsonify({"invoices": result})


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)

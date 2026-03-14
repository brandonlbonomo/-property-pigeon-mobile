import os
import json
import re
import hashlib
import base64
import threading
import time as _time
import secrets
from email.utils import parsedate_to_datetime
from flask import Flask, jsonify, request, redirect, send_file, g
from flask_cors import CORS
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request as GoogleAuthRequest
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build as google_build
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
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__, static_folder=".", static_url_path="")
CORS(app, origins="*")

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
print(f"🏦 Plaid env  : {PLAID_ENV}")
print(f"🌐 Plaid host : {PLAID_HOST}")
print(f"🔑 Client ID  : {PLAID_CLIENT_ID[:6]}..." if PLAID_CLIENT_ID else "⚠️  PLAID_CLIENT_ID not set")
print(f"🪝 Webhook URL: {PLAID_WEBHOOK_URL or '(not set — webhooks disabled)'}")

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
        print("⚠️  STRIPE_SECRET_KEY not set — billing disabled")
        return
    plans = {
        "pp_pro_monthly": {"name": "Property Pigeon Pro", "amount": 1299},
        "cleaner_pro_monthly": {"name": "Cleaner Pro", "amount": 799},
    }
    for lookup_key, info in plans.items():
        try:
            prices = stripe.Price.list(lookup_keys=[lookup_key], limit=1)
            if prices.data:
                STRIPE_PRODUCTS[lookup_key] = prices.data[0].id
                print(f"💳 Found price {lookup_key}: {prices.data[0].id}")
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
                print(f"💳 Created price {lookup_key}: {price.id}")
        except Exception as e:
            print(f"⚠️  Stripe product setup error ({lookup_key}): {e}")

_ensure_stripe_products()
print(f"💳 Stripe products: {STRIPE_PRODUCTS}")

# ── Gmail OAuth config ────────────────────────────────────────
GMAIL_CLIENT_ID     = os.getenv("GMAIL_CLIENT_ID", "")
GMAIL_CLIENT_SECRET = os.getenv("GMAIL_CLIENT_SECRET", "")
GMAIL_REDIRECT_URI  = os.getenv("GMAIL_REDIRECT_URI", "")
GMAIL_SCOPES        = ["https://www.googleapis.com/auth/gmail.readonly"]
print(f"📧 Gmail client : {GMAIL_CLIENT_ID[:6]}..." if GMAIL_CLIENT_ID else "⚠️  GMAIL_CLIENT_ID not set")

# OAuth states stored in persistent file store so all gunicorn workers share them

# ── Persistent store ─────────────────────────────────────────
# store = {
#   "accounts": [ { "access_token": "...", "item_id": "...", "cursor": "...", "name": "..." } ]
# }
# Use persistent disk if available, fall back to local
import os as _os
STORE_FILE = "/data/plaid_store.json" if _os.path.isdir("/data") else "plaid_store.json"
print(f"Store file: {STORE_FILE}")
STORE_ENV   = "PLAID_STORE_JSON"  # Render env var — survives deploys and filesystem wipes

def _user_store_file():
    """Return per-user store file path if authenticated, else global."""
    try:
        uid = getattr(g, 'user_id', None)
        if uid:
            base = "/data" if _os.path.isdir("/data") else "."
            return f"{base}/store_{uid}.json"
    except RuntimeError:
        pass  # Outside request context (scheduler jobs)
    return None

def load_store():
    # Per-user store if authenticated
    user_sf = _user_store_file()
    if user_sf:
        try:
            with open(user_sf, "r") as f:
                data = json.load(f)
                if "accounts" not in data:
                    data["accounts"] = []
                return data
        except Exception:
            return {"accounts": []}

    # Global store: Priority: 1) disk file  2) env var backup  3) empty
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
            print("✅ Loaded store from env var backup")
            # Restore to disk immediately
            with open(STORE_FILE, "w") as f:
                json.dump(data, f)
            return data
    except Exception as e:
        print(f"Env var restore failed: {e}")
    return {"accounts": []}

def save_store(data):
    # Per-user store if authenticated
    user_sf = _user_store_file()
    if user_sf:
        try:
            with open(user_sf, "w") as f:
                json.dump(data, f)
        except Exception as e:
            print(f"Failed to save user store: {e}")
        return  # No env var backup for per-user stores

    # Global store — save to disk
    try:
        with open(STORE_FILE, "w") as f:
            json.dump(data, f)
    except Exception as e:
        print("Failed to save store to disk:", e)
    # Update in-process env var immediately — survives dyno sleep/wake within same process
    try:
        os.environ[STORE_ENV] = json.dumps(data)
    except Exception as e:
        print(f"In-process env var update failed: {e}")
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
            print("✅ Env var backup updated")
        except Exception as e:
            print(f"Env var backup skipped: {e}")
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
    try:
        with open(USERS_FILE, "w") as f:
            json.dump(data, f)
    except Exception as e:
        print(f"Failed to save users: {e}")

# ── Billing meta (lifetime-free counter) ─────────────────────
BILLING_META_FILE = "/data/billing_meta.json" if _os.path.isdir("/data") else "billing_meta.json"

def _load_billing_meta():
    try:
        with open(BILLING_META_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {"plaid_free_users": []}

def _save_billing_meta(data):
    try:
        with open(BILLING_META_FILE, "w") as f:
            json.dump(data, f)
    except Exception as e:
        print(f"Failed to save billing meta: {e}")

PUSH_TOKENS_FILE = "/data/push_tokens.json" if _os.path.isdir("/data") else "push_tokens.json"
FOLLOWS_FILE = "/data/follows.json" if _os.path.isdir("/data") else "follows.json"
NOTIFICATIONS_FILE = "/data/notifications.json" if _os.path.isdir("/data") else "notifications.json"

def _load_json_file(path):
    try:
        with open(path, "r") as f:
            return json.load(f)
    except Exception:
        return {}

def _save_json_file(path, data):
    try:
        with open(path, "w") as f:
            json.dump(data, f)
    except Exception as e:
        print(f"Failed to save {path}: {e}")

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
        print(f"Push send error: {e}")

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
PUBLIC_PREFIXES = ("/", "/api/auth/", "/api/health", "/api/webhook", "/api/billing/",
                   "/manifest.json",
                   "/icon-", "/cleaner", "/api/debug", "/api/users/")

@app.before_request
def check_bearer_token():
    """Validate Bearer token and set g.user_id for per-user data isolation."""
    g.user_id = None
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth[7:]
        users = load_users()
        for email, u in users.items():
            if u.get("token") == token:
                g.user_id = u["id"]
                break

# ── Auth endpoints ────────────────────────────────────────────
@app.route("/api/auth/register", methods=["POST"])
@app.route("/api/register", methods=["POST"])
def auth_register():
    body = request.get_json(force=True) or {}
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    if not email or not password:
        return jsonify({"ok": False, "error": "Email and password required"}), 400
    users = load_users()
    if email in users:
        return jsonify({"ok": False, "error": "Account already exists"}), 409
    user_id = "u_" + secrets.token_hex(8)
    token = secrets.token_hex(32)
    pw_hash = hashlib.sha256(password.encode()).hexdigest()
    role = body.get("role", "owner")  # "owner" or "cleaner"
    username = body.get("username", "")
    follow_code = "PPG-" + secrets.token_hex(3).upper() if role == "owner" else ""
    users[email] = {
        "id": user_id,
        "password_hash": pw_hash,
        "token": token,
        "role": role,
        "username": username,
        "follow_code": follow_code,
        "created_at": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()),
    }
    save_users(users)
    print(f"✅ Registered user {email} → {user_id}")
    return jsonify({"ok": True, "user_id": user_id, "token": token, "email": email})

@app.route("/api/auth/login", methods=["POST"])
@app.route("/api/login", methods=["POST"])
def auth_login():
    body = request.get_json(force=True) or {}
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    if not email or not password:
        return jsonify({"ok": False, "error": "Email and password required"}), 400
    users = load_users()
    user = users.get(email)
    if not user:
        return jsonify({"ok": False, "error": "Invalid credentials"}), 401
    pw_hash = hashlib.sha256(password.encode()).hexdigest()
    if user["password_hash"] != pw_hash:
        return jsonify({"ok": False, "error": "Invalid credentials"}), 401
    # Generate a fresh token on each login
    token = secrets.token_hex(32)
    user["token"] = token
    save_users(users)
    print(f"✅ Login for {email}")
    return jsonify({"ok": True, "user_id": user["id"], "token": token, "email": email})

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
    del users[target_email]
    save_users(users)
    # Delete per-user store file
    base = "/data" if _os.path.isdir("/data") else "."
    store_file = f"{base}/store_{uid}.json"
    try:
        os.remove(store_file)
    except Exception:
        pass
    print(f"🗑️ Deleted user {target_email} ({uid})")
    return jsonify({"ok": True})

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
        "name": "Property Pigeon",
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

# ── Store diagnostics ─────────────────────────────────────────
@app.route("/api/debug")
def debug():
    store = load_store()
    txs = list(store.get("transactions", {}).values())
    dates = sorted([t["date"] for t in txs if t.get("date")])
    # Per-account breakdown
    by_account = {}
    for t in txs:
        acc = t.get("account", "unknown")
        if acc not in by_account:
            by_account[acc] = {"count": 0, "newest": "", "oldest": "9999"}
        by_account[acc]["count"] += 1
        d = t.get("date", "")
        if d > by_account[acc]["newest"]: by_account[acc]["newest"] = d
        if d < by_account[acc]["oldest"]: by_account[acc]["oldest"] = d
    return jsonify({
        "total_transactions": len(txs),
        "oldest_date":        dates[0]  if dates else None,
        "newest_date":        dates[-1] if dates else None,
        "by_account":         by_account,
        "cursors":            {a["name"]: (a.get("cursor") or "")[:40] + "..." if a.get("cursor") else None
                               for a in store["accounts"]},
    })

# ── Link status ───────────────────────────────────────────────
@app.route("/api/link-status")
def link_status():
    store = load_store()
    accounts = [{"item_id": a["item_id"], "name": a.get("name", "Bank Account"),
                  "needs_reauth": a.get("needs_reauth", False)} for a in store["accounts"]]
    return jsonify({"linked": len(store["accounts"]) > 0, "accounts": accounts})

# ── Create link token ─────────────────────────────────────────
@app.route("/api/create-link-token", methods=["POST"])
def create_link_token():
    store = load_store()
    try:
        kwargs = dict(
            user=LinkTokenCreateRequestUser(client_user_id="pigeon-user"),
            client_name="Property Pigeon",
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
        print("create-link-token error:", str(e))
        return jsonify({"error": str(e)}), 500

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
            client_name="Property Pigeon",
            access_token=account["access_token"],
            country_codes=[CountryCode("US")],
            language="en",
        )
        response = plaid_client.link_token_create(req)
        return jsonify({"link_token": response["link_token"]})
    except Exception as e:
        print("create-update-token error:", str(e))
        return jsonify({"error": str(e)}), 500

# ══════════════════════════════════════════════════════════════
# ── Stripe Billing endpoints ─────────────────────────────────
# ══════════════════════════════════════════════════════════════

def _get_user_billing_fields(user_id):
    """Get billing-related fields for a user."""
    users = load_users()
    for email, u in users.items():
        if u.get("id") == user_id:
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
    for email, u in users.items():
        if u.get("id") == user_id:
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
            print(f"⚠️  Stored customer {customer_id} invalid — creating new one")
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

    base_url = os.getenv("APP_BASE_URL", "https://propertypigeon.onrender.com")
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
        print(f"Checkout error: {e}")
        return jsonify({"error": str(e)}), 500


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

    base_url = os.getenv("APP_BASE_URL", "https://propertypigeon.onrender.com")
    try:
        session = stripe.billing_portal.Session.create(
            customer=customer_id,
            return_url=f"{base_url}/api/billing/portal-return",
        )
        return jsonify({"portal_url": session.url})
    except Exception as e:
        print(f"Portal error: {e}")
        return jsonify({"error": str(e)}), 500


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
            print("⚠️  Stripe webhook: invalid payload")
            return "Invalid payload", 400
        except stripe.error.SignatureVerificationError:
            print("⚠️  Stripe webhook: invalid signature")
            return "Invalid signature", 400
    else:
        # No secret configured — parse raw (dev mode)
        event = json.loads(payload)

    event_type = event.get("type", "")
    data_obj = event.get("data", {}).get("object", {})
    print(f"💳 Webhook: {event_type}")

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
            print(f"💳 Updated subscription for {uid}: {data_obj.get('status')} ({plan})")

    elif event_type == "customer.subscription.deleted":
        customer_id = data_obj.get("customer")
        uid, _ = _find_user_by_stripe_customer(customer_id)
        if uid:
            _update_user_billing(uid, {
                "subscription_status": "canceled",
                "subscription_current_period_end": data_obj.get("current_period_end"),
            })
            print(f"💳 Subscription canceled for {uid}")

    elif event_type == "invoice.payment_failed":
        customer_id = data_obj.get("customer")
        uid, _ = _find_user_by_stripe_customer(customer_id)
        if uid:
            _update_user_billing(uid, {"subscription_status": "past_due"})
            print(f"💳 Payment failed for {uid}")

    return "ok", 200

# ── Exchange token ────────────────────────────────────────────
@app.route("/api/exchange-token", methods=["POST"])
def exchange_token():
    store = load_store()
    public_token  = request.json.get("public_token")
    account_name  = request.json.get("account_name", "Bank Account")
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
                        print(f"🎁 User {uid} gets lifetime free (Plaid early adopter #{len(free_users)})")
                        break

        print(f"✅ Linked: {account_name} ({item_id})")
        return jsonify({"ok": True, "item_id": item_id})
    except Exception as e:
        print("exchange-token error:", str(e))
        return jsonify({"error": str(e)}), 500

# ── Remove account ────────────────────────────────────────────
@app.route("/api/remove-account", methods=["POST"])
def remove_account():
    store = load_store()
    item_id = request.json.get("item_id")
    store["accounts"] = [a for a in store["accounts"] if a["item_id"] != item_id]
    save_store(store)
    return jsonify({"ok": True})

# ── Sync core logic (used by route + scheduler) ───────────────
def run_sync():
    """Pull latest transactions from Plaid for all connected accounts.
    Returns a summary dict; raises no exceptions (errors are logged per-account)."""
    store = load_store()
    if not store["accounts"]:
        print("Scheduled sync: no accounts linked, skipping.")
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

            print(f"🔄 Syncing {name} — cursor={'set' if cursor else 'none (full sync)'}")

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
                        print(f"⚠️  Invalid cursor for {name} — resetting and retrying full sync")
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
                print(f"  Page {page}: +{len(page_added)} added, "
                      f"~{len(page_modified)} modified, -{len(page_removed)} removed"
                      f"{', more…' if has_more else ''}")

            account["cursor"] = cursor
            print(f"  ✅ {name}: {len(added)} added, {len(modified)} modified, "
                  f"{len(removed)} removed | cursor={'set' if cursor else 'none'}")

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
                    if existing.get("user_date"):  # preserve user-edited date through sync
                        n["date"] = existing["user_date"]
                        n["user_date"] = existing["user_date"]
                    tx_store[n["id"]] = n
            for r in removed:
                rid = r.get("transaction_id")
                if rid and rid in tx_store:
                    del tx_store[rid]
                    all_removed_ids.append(rid)

            all_added    += [normalize(t) for t in added]
            all_modified += [normalize(t) for t in modified]

        except Exception as e:
            err_str = str(e)
            if "ITEM_LOGIN_REQUIRED" in err_str:
                account["needs_reauth"] = True
                save_store(store)
                print(f"⚠️  {name}: Chase connection expired — re-authentication required (ITEM_LOGIN_REQUIRED)")
            else:
                print(f"❌ Sync error for {name}: {e}")
            continue

    store["transactions"] = tx_store
    save_store(store)

    return {
        "added":         all_added,
        "modified":      all_modified,
        "removed":       all_removed_ids,
        "total":         len(all_added),
        "total_stored":  len(tx_store),
        "needs_reauth":  [a.get("name") for a in store["accounts"] if a.get("needs_reauth")],
    }

# ── Sync all accounts ─────────────────────────────────────────
@app.route("/api/transactions/sync")
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
            print(f"🔄 Transactions refresh triggered for {account.get('name')}")
        except Exception as e:
            err = f"{account.get('name')}: {str(e)}"
            print(f"❌ Transactions refresh error: {err}")
            errors.append(err)
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

    print(f"📩 Plaid webhook: {webhook_type}/{webhook_code}  item={item_id}")

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
        print(f"⚠️  Webhook item_id {item_id} not found in store — ignoring")
        return jsonify({"ok": True, "action": "unknown_item"})

    # Paginate through ALL available updates (run_sync loops has_more automatically)
    try:
        result = run_sync()
        print(f"✅ Webhook sync done: {result.get('total', 0)} new, "
              f"{result.get('total_stored', 0)} total stored")
        return jsonify({
            "ok":          True,
            "action":      "synced",
            "new":         result.get("total", 0),
            "total_stored": result.get("total_stored", 0),
        })
    except Exception as e:
        print(f"❌ Webhook sync error: {e}")
        return jsonify({"error": str(e)}), 500


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
            print(f"✅ Webhook registered for {account.get('name')}: {webhook_url}")
        except Exception as e:
            err = f"{account.get('name')}: {str(e)}"
            print(f"❌ update-webhook error: {err}")
            errors.append(err)

    return jsonify({"ok": True, "webhook_url": webhook_url, "updated": updated, "errors": errors})


# ── Historical pull — fetches up to 2 years back via transactions/get ────
# Call this once after linking a new account to backfill history.
# transactions/sync alone only returns ~90 days on first call.
@app.route("/api/transactions/historical", methods=["POST"])
def historical_pull():
    store = load_store()
    item_id = request.json.get("item_id")  # optional: pull for specific account only
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

    for account in accounts_to_pull:
        try:
            offset = 0
            batch_size = 500
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
                if offset >= total_txs or not txs:
                    break

            print(f"✅ Historical pull: {account.get('name')} — {offset} transactions fetched")

        except Exception as e:
            err = f"{account.get('name')}: {str(e)}"
            print(f"❌ Historical pull error: {err}")
            errors.append(err)

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
    ids = request.json.get("ids", [])
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
        print(f"📅 Transaction {tx_id}: date overridden to {body['date']}")
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
    return jsonify({"ok": True})


# ── POST /api/transactions/csv ─────────────────────────────────
@app.route("/api/transactions/csv", methods=["POST"])
def import_csv():
    """Import transactions from a parsed Chase CSV export.
    Expects JSON: {rows: [{date, payee, amount, type?}]}
    Chase CSV amounts: negative = debit (money out), positive = credit (money in).
    """
    body  = request.json or {}
    rows  = body.get("rows", [])
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
    print(f"📄 CSV import: {added} new transactions added ({len(tx_store)} total)")
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


_last_csv_debug = {}  # module-level store for last CSV debug info


@app.route("/api/debug/csv-last")
def debug_csv_last():
    """Returns raw first rows of the last uploaded CSV for debugging."""
    return jsonify(_last_csv_debug)


# ── Admin: full hard reset + booking seed ─────────────────────────────────
_SEED_BOOKINGS = [
    # listing_name, check_in, check_out, booked_date, revenue
    ("Unit 4 · EaDo Apt | Walk to Stadiums & Venues","2026-03-12","2026-03-16","2026-03-07",850.00),
    ("Unit 1 · Premium EaDo Apartment | Stadiums Downtown","2026-03-19","2026-03-23","2026-03-07",696.00),
    ("24 B · River & Falls Retreat","2026-05-01","2026-05-03","2026-03-06",325.00),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2026-03-13","2026-03-15","2026-03-05",441.00),
    ("26 B · The Gorge Getaway","2026-03-07","2026-03-20","2026-03-03",1103.80),
    ("24 B · River & Falls Retreat","2026-03-20","2026-03-22","2026-03-02",242.00),
    ("Unit 4 · EaDo Apt | Walk to Stadiums & Venues","2026-03-06","2026-03-10","2026-03-01",569.16),
    ("24 B · River & Falls Retreat","2026-03-29","2026-04-02","2026-03-01",431.00),
    ("Unit 1 · Premium EaDo Apartment | Stadiums Downtown","2026-03-06","2026-03-08","2026-02-28",357.30),
    ("24 B · River & Falls Retreat","2026-04-18","2026-04-20","2026-02-28",256.00),
    ("24 B · River & Falls Retreat","2026-10-01","2026-10-08","2026-02-26",1272.00),
    ("24 B · River & Falls Retreat","2026-04-22","2026-04-25","2026-02-25",354.00),
    ("24 B · River & Falls Retreat","2027-09-09","2027-09-11","2026-02-23",195.00),
    ("Unit 1 · Premium EaDo Apartment | Stadiums Downtown","2026-02-26","2026-03-02","2026-02-22",473.94),
    ("Unit 3 · Stylish EaDo Apt | Walk to Venues","2026-03-20","2026-03-23","2026-02-21",283.20),
    ("Unit 3 · Stylish EaDo Apt | Walk to Venues","2026-02-20","2026-02-25","2026-02-21",327.60),
    ("26 B · The Gorge Getaway","2026-02-20","2026-02-27","2026-02-20",562.50),
    ("Unit 3 · Stylish EaDo Apt | Walk to Venues","2026-03-25","2026-03-29","2026-02-19",356.00),
    ("Unit 4 · EaDo Apt | Walk to Stadiums & Venues","2026-02-26","2026-03-01","2026-02-19",464.43),
    ("24 B · River & Falls Retreat","2026-06-04","2026-06-08","2026-02-18",1017.00),
    ("24 B · River & Falls Retreat","2026-02-17","2026-03-01","2026-02-17",1077.00),
    ("24 B · River & Falls Retreat","2027-09-30","2027-10-02","2026-02-15",189.15),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2026-02-15","2026-02-20","2026-02-15",287.24),
    ("24 B · River & Falls Retreat","2026-02-14","2026-02-15","2026-02-12",88.00),
    ("26 B · The Gorge Getaway","2026-02-13","2026-02-16","2026-02-12",286.60),
    ("Unit 3 · Stylish EaDo Apt | Walk to Venues","2026-02-12","2026-02-16","2026-02-11",373.20),
    ("26 B · The Gorge Getaway","2026-02-10","2026-02-13","2026-02-10",151.90),
    ("24 B · River & Falls Retreat","2026-03-01","2026-03-07","2026-02-10",445.00),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2026-02-22","2026-02-25","2026-02-10",192.00),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2026-03-17","2026-03-20","2026-02-09",264.00),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2026-02-10","2026-02-13","2026-02-08",155.40),
    ("24 B · River & Falls Retreat","2026-07-11","2026-07-14","2026-02-07",643.11),
    ("24 B · River & Falls Retreat","2026-04-08","2026-04-10","2026-02-06",179.45),
    ("24 B · River & Falls Retreat","2026-02-08","2026-02-14","2026-02-06",428.00),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2026-02-03","2026-02-05","2026-02-03",77.00),
    ("22 B · Riverstone Retreat","2026-02-07","2026-06-06","2026-02-02",11291.77),
    ("Unit 3 · Stylish EaDo Apt | Walk to Venues","2026-02-27","2026-03-02","2026-02-02",310.40),
    ("Unit 1 · Premium EaDo Apartment | Stadiums Downtown","2026-02-02","2026-02-06","2026-02-02",159.65),
    ("24 B · River & Falls Retreat","2026-04-02","2026-04-05","2026-02-01",259.96),
    ("Unit 4 · EaDo Apt | Walk to Stadiums & Venues","2026-02-16","2026-02-19","2026-02-01",186.25),
    ("24 B · River & Falls Retreat","2026-08-13","2026-08-17","2026-01-31",844.87),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2026-01-31","2026-02-02","2026-01-30",147.20),
    ("22 B · Riverstone Retreat","2026-01-29","2026-02-06","2026-01-30",470.40),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2026-02-13","2026-02-15","2026-01-30",184.86),
    ("Unit 3 · Stylish EaDo Apt | Walk to Venues","2026-02-05","2026-02-08","2026-01-29",203.00),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2026-02-05","2026-02-08","2026-01-29",198.00),
    ("22 B · Riverstone Retreat","2026-01-28","2026-01-29","2026-01-28",11.00),
    ("Unit 4 · EaDo Apt | Walk to Stadiums & Venues","2026-02-14","2026-02-16","2026-01-27",171.00),
    ("26 B · The Gorge Getaway","2026-01-28","2026-02-08","2026-01-27",600.00),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2026-02-27","2026-03-02","2026-01-27",280.80),
    ("Unit 4 · EaDo Apt | Walk to Stadiums & Venues","2026-02-20","2026-02-24","2026-01-26",320.00),
    ("Unit 1 · Premium EaDo Apartment | Stadiums Downtown","2026-04-02","2026-04-06","2026-01-26",287.04),
    ("Unit 1 · Premium EaDo Apartment | Stadiums Downtown","2026-01-30","2026-02-02","2026-01-25",203.20),
    ("Unit 1 · Premium EaDo Apartment | Stadiums Downtown","2026-02-06","2026-02-11","2026-01-25",320.80),
    ("24 B · River & Falls Retreat","2026-03-07","2026-03-10","2026-01-25",200.79),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2026-03-27","2026-03-30","2026-01-25",280.80),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2026-01-24","2026-01-31","2026-01-24",439.24),
    ("24 B · River & Falls Retreat","2026-05-03","2026-05-07","2026-01-24",326.89),
    ("Unit 3 · Stylish EaDo Apt | Walk to Venues","2026-01-24","2026-02-05","2026-01-24",65.00),
    ("Unit 4 · EaDo Apt | Walk to Stadiums & Venues","2026-03-20","2026-03-23","2026-01-23",385.28),
    ("24 B · River & Falls Retreat","2026-01-23","2026-01-27","2026-01-23",195.00),
    ("24 B · River & Falls Retreat","2026-01-29","2026-02-08","2026-01-23",528.80),
    ("Unit 1 · Premium EaDo Apartment | Stadiums Downtown","2026-02-19","2026-02-23","2026-01-23",286.40),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2026-01-22","2026-01-24","2026-01-23",131.20),
    ("24 B · River & Falls Retreat","2026-05-10","2026-05-12","2026-01-23",137.60),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2026-03-06","2026-03-09","2026-01-23",280.80),
    ("26 B · The Gorge Getaway","2026-01-23","2026-01-25","2026-01-23",141.60),
    ("24 B · River & Falls Retreat","2026-06-15","2026-06-19","2026-01-21",516.80),
    ("Unit 1 · Premium EaDo Apartment | Stadiums Downtown","2026-01-23","2026-01-27","2026-01-21",262.40),
    ("Unit 3 · Stylish EaDo Apt | Walk to Venues","2026-03-05","2026-03-13","2026-01-20",729.60),
    ("Unit 1 · Premium EaDo Apartment | Stadiums Downtown","2026-03-11","2026-03-15","2026-01-19",294.40),
    ("Unit 1 · Premium EaDo Apartment | Stadiums Downtown","2026-02-13","2026-02-16","2026-01-19",220.80),
    ("Unit 4 · EaDo Apt | Walk to Stadiums & Venues","2026-01-09","2026-02-13","2026-01-04",2683.74),
    ("Unit 3 · Stylish EaDo Apt | Walk to Venues","2025-12-31","2026-01-06","2025-12-31",417.20),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2025-12-31","2026-01-05","2025-12-30",402.24),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2025-12-20","2025-12-31","2025-12-20",715.94),
    ("26 B · The Gorge Getaway","2025-12-20","2026-01-23","2025-12-18",2745.10),
    ("Unit 3 · Stylish EaDo Apt | Walk to Venues","2025-12-15","2025-12-19","2025-12-08",301.00),
    ("Unit 3 · Stylish EaDo Apt | Walk to Venues","2025-12-11","2025-12-15","2025-12-05",257.45),
    ("Unit 3 · Stylish EaDo Apt | Walk to Venues","2025-12-19","2025-12-22","2025-12-02",206.15),
    ("Unit 3 · Stylish EaDo Apt | Walk to Venues","2025-12-03","2025-12-09","2025-12-01",372.79),
    ("Unit 1 · Premium EaDo Apartment | Stadiums Downtown","2025-12-07","2025-12-22","2025-11-30",1022.38),
    ("26 B · The Gorge Getaway","2025-12-01","2025-12-13","2025-11-30",820.00),
    ("Unit 1 · Premium EaDo Apartment | Stadiums Downtown","2025-11-26","2025-12-03","2025-11-26",451.75),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2025-11-27","2025-12-20","2025-11-25",1543.75),
    ("26 B · The Gorge Getaway","2025-11-25","2025-11-30","2025-11-24",376.00),
    ("Unit 4 · EaDo Apt | Walk to Stadiums & Venues","2025-11-26","2026-01-09","2025-11-23",2915.00),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2025-11-23","2025-11-27","2025-11-23",245.00),
    ("Unit 1 · Premium EaDo Apartment | Stadiums Downtown","2025-11-22","2025-11-26","2025-11-22",256.08),
    ("Unit 3 · Stylish EaDo Apt | Walk to Venues","2025-11-26","2025-11-29","2025-11-21",206.40),
    ("Unit 3 · Stylish EaDo Apt | Walk to Venues","2025-11-21","2025-11-23","2025-11-21",120.00),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2025-11-21","2025-11-23","2025-11-21",124.00),
    ("Unit 1 · Premium EaDo Apartment | Stadiums Downtown","2025-11-15","2025-11-22","2025-11-15",466.57),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2025-11-14","2025-11-16","2025-11-13",133.00),
    ("Unit 4 · EaDo Apt | Walk to Stadiums & Venues","2025-11-16","2025-11-26","2025-11-10",654.55),
    ("Unit 1 · Premium EaDo Apartment | Stadiums Downtown","2025-11-05","2025-11-09","2025-11-05",259.00),
    ("26 B · The Gorge Getaway","2025-11-06","2025-11-20","2025-11-05",1020.44),
    ("Unit 3 · Stylish EaDo Apt | Walk to Venues","2025-11-05","2025-11-09","2025-11-05",259.20),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2025-11-04","2025-11-10","2025-11-04",390.00),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2025-11-01","2025-11-03","2025-11-02",130.00),
    ("Unit 4 · EaDo Apt | Walk to Stadiums & Venues","2025-11-08","2025-11-10","2025-11-01",175.00),
    ("26 B · The Gorge Getaway","2025-11-01","2025-11-03","2025-10-31",141.00),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2025-10-26","2025-11-01","2025-10-24",435.00),
    ("Unit 4 · EaDo Apt | Walk to Stadiums & Venues","2025-10-27","2025-11-02","2025-10-22",481.00),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2025-10-18","2025-10-25","2025-10-19",425.00),
    ("Unit 2 · Modern EaDo Apartment Near Downtown","2025-10-16","2025-10-18","2025-10-17",110.00),
    ("Unit 4 · EaDo Apt | Walk to Stadiums & Venues","2025-10-17","2025-10-20","2025-10-15",171.00),
    ("Unit 4 · EaDo Apt | Walk to Stadiums & Venues","2025-10-23","2025-10-26","2025-10-15",200.00),
    ("Unit 4 · EaDo Apt | Walk to Stadiums & Venues","2025-10-10","2025-10-12","2025-10-10",135.20),
]

def _listing_to_prop(listing_name):
    """Map a listing name to a canonical prop_id."""
    if not listing_name:
        return None
    return _infer_prop_from_listing(listing_name)

@app.route("/api/admin/hard-reset", methods=["POST"])
def admin_hard_reset():
    """
    Full hard reset: wipe all financial/booking/transaction data, keep credentials.
    Then seed booking records from _SEED_BOOKINGS.
    Body: {"confirm": "HARD_RESET"}
    """
    body = request.json or {}
    if body.get("confirm") != "HARD_RESET":
        return jsonify({"error": "Send {confirm: 'HARD_RESET'}"}), 400

    store = load_store()

    # ── 1. Wipe financial data, keep credentials/connections ──
    keys_to_clear = [
        "pl_bookings", "pl_monthly_revenue", "manual_income", "property_income",
        "transactions", "tags", "rules", "tag_history",
    ]
    for k in keys_to_clear:
        store.pop(k, None)
    # Reset Plaid cursors so next sync pulls everything from scratch
    for account in store.get("accounts", []):
        account.pop("cursor", None)
    save_store(store)
    print("🗑️  Hard reset: cleared financial data, cursors reset")

    # ── 2. Seed booking records ──
    bookings = []
    for (listing, ci, co, bd, rev) in _SEED_BOOKINGS:
        prop_id = _listing_to_prop(listing)
        nights_val = None
        if ci and co:
            import datetime as _dtt
            try:
                d1 = _dtt.date.fromisoformat(ci)
                d2 = _dtt.date.fromisoformat(co)
                nights_val = (d2 - d1).days
            except Exception:
                pass
        bookings.append({
            "listing_name":   listing,
            "prop_id":        prop_id,
            "check_in":       ci,
            "check_out":      co,
            "booked_date":    bd,
            "nights":         nights_val,
            "adr":            round(rev / nights_val, 2) if nights_val else None,
            "rental_revenue": rev,
            "status":         "confirmed",
            "channel":        "Airbnb",
            "conf_code":      f"SEED-{listing[:8].replace(' ','-')}-{ci}",
        })

    store2 = load_store()
    store2["pl_bookings"] = bookings
    save_store(store2)

    # ── 3. Summary ──
    from collections import defaultdict
    by_prop = defaultdict(lambda: {"count": 0, "revenue": 0.0})
    by_month = defaultdict(float)
    for b in bookings:
        pid = b["prop_id"] or "unmatched"
        by_prop[pid]["count"]   += 1
        by_prop[pid]["revenue"] += b["rental_revenue"] or 0
        mo = b["check_in"][:7] if b.get("check_in") else "?"
        by_month[mo] += b["rental_revenue"] or 0

    # Print per-prop and per-month
    print("📊 Seeded bookings:")
    for pid, d in sorted(by_prop.items()):
        print(f"   {pid}: {d['count']} reservations, ${d['revenue']:,.2f}")
    print("📅 Monthly revenue:")
    for mo in sorted(by_month):
        print(f"   {mo}: ${by_month[mo]:,.2f}")

    return jsonify({
        "ok": True,
        "seeded": len(bookings),
        "by_prop": {k: {"count": v["count"], "revenue": round(v["revenue"], 2)}
                    for k, v in by_prop.items()},
        "by_month": {k: round(v, 2) for k, v in sorted(by_month.items())},
        "message": "Hard reset complete. Run /api/transactions/historical to resync Plaid.",
    })


@app.route("/api/reset/transactions", methods=["POST"])
def reset_transactions():
    """Clear all Plaid transactions and tags, reset cursors so next sync re-pulls everything."""
    store = load_store()
    tx_count = len(store.get("transactions", {}))
    store["transactions"] = {}
    store["tags"] = {}
    # Reset Plaid cursors so next sync re-pulls full history
    for account in store.get("accounts", []):
        account.pop("cursor", None)
    save_store(store)
    return jsonify({"ok": True, "cleared_transactions": tx_count})


@app.route("/api/reset/revenue", methods=["POST"])
def reset_revenue():
    """Clear revenue-only keys: pl_bookings, pl_monthly_revenue, manual_income, property_income."""
    body = request.json or {}
    if body.get("confirm") != "RESET":
        return jsonify({"error": "Send {confirm: 'RESET'}"}), 400
    store = load_store()
    for key in ["pl_bookings", "pl_monthly_revenue", "manual_income", "property_income"]:
        store.pop(key, None)
    save_store(store)
    return jsonify({"ok": True, "cleared": ["pl_bookings", "pl_monthly_revenue", "manual_income", "property_income"]})


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

    reader = _csv.reader(_io.StringIO(raw_csv))
    rows   = list(reader)
    if len(rows) < 2:
        return jsonify({"error": "CSV has no data rows"}), 400

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
    print(f"[CSV IMPORT] header_row_idx={header_row_idx}, detected={detected}")
    print(f"[CSV IMPORT] headers={headers[:8]}")
    print(f"[CSV IMPORT] first data row={data_rows[0][:5] if data_rows else 'EMPTY'}")

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
        print(f"📄 PriceLabs Revenue CSV: {len(rows_parsed)} monthly rows, months {months_hit[0]}–{months_hit[-1]}")
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
        print(f"📄 PriceLabs CSV: {len(new_bk)} new bookings (skipped {len(bookings)-len(new_bk)} dupes)")
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
                "hint": "Check /api/debug/csv-last for full column map",
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
        print(f"📄 Chase CSV: {added} new transactions")
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
            "error": "Could not identify CSV format. Check /api/debug/csv-last for raw content.",
        }), 422


@app.route("/api/pricelabs/bookings")
def get_pl_bookings():
    """
    Returns stored PriceLabs/Airbnb booking records + monthly revenue imports.
    Aggregated by month and by prop:month for use in Calendar and Money views.
    Monthly revenue CSV data (pl_monthly_revenue) is merged into by_month.
    """
    import datetime as _dt
    store    = load_store()
    bookings = store.get("pl_bookings", [])

    # ── Retroactively fix any bookings with prop_id = None ──────────────────
    repaired = 0
    fixed_bookings = []
    for b in bookings:
        if not b.get("prop_id") and b.get("listing_name"):
            pid = _infer_prop_from_listing(b["listing_name"])
            if pid:
                b = dict(b, prop_id=pid)
                repaired += 1
        fixed_bookings.append(b)
    if repaired:
        bookings = fixed_bookings
        store["pl_bookings"] = bookings
        save_store(store)
        print(f"[Bookings] Repaired prop_id for {repaired} bookings")

    by_month       = {}
    by_prop_month  = {}
    total_revenue  = 0.0

    # 1. Aggregate from individual booking records
    for b in bookings:
        mo  = (b.get("check_in") or "")[:7]
        if not mo:
            continue
        rev = float(b.get("rental_revenue") or 0)
        pid = b.get("prop_id") or "unknown"
        by_month[mo]            = round(by_month.get(mo, 0) + rev, 2)
        key                     = f"{pid}:{mo}"
        by_prop_month[key]      = round(by_prop_month.get(key, 0) + rev, 2)
        total_revenue          += rev

    # 2. Merge monthly revenue CSV data (Revenue on the Books report)
    #    Only fills months not already covered by individual bookings
    monthly_rev = store.get("pl_monthly_revenue", {})
    for key, rev in monthly_rev.items():
        if ':' in key:
            pid, mo = key.split(':', 1)
            if mo not in by_month:
                by_month[mo] = round(by_month.get(mo, 0) + rev, 2)
                total_revenue += rev
            if key not in by_prop_month:
                by_prop_month[key] = round(by_prop_month.get(key, 0) + rev, 2)
        else:
            mo = key
            if mo not in by_month:
                by_month[mo] = round(by_month.get(mo, 0) + rev, 2)
                total_revenue += rev

    # Rolling 30-day windows
    today    = _dt.date.today().isoformat()
    d30ago   = (_dt.date.today() - _dt.timedelta(days=30)).isoformat()
    d30fwd   = (_dt.date.today() + _dt.timedelta(days=30)).isoformat()

    rev_past_30 = sum(
        float(b.get("rental_revenue") or 0)
        for b in bookings
        if d30ago <= (b.get("check_in") or "") <= today
    )
    rev_next_30 = sum(
        float(b.get("rental_revenue") or 0)
        for b in bookings
        if today < (b.get("check_in") or "") <= d30fwd
    )

    # Per-prop rolling 30-day
    by_prop_past_30 = {}
    by_prop_next_30 = {}
    for b in bookings:
        ci  = b.get("check_in") or ""
        rev = float(b.get("rental_revenue") or 0)
        pid = b.get("prop_id") or "unknown"
        if d30ago <= ci <= today:
            by_prop_past_30[pid] = round(by_prop_past_30.get(pid, 0) + rev, 2)
        if today < ci <= d30fwd:
            by_prop_next_30[pid] = round(by_prop_next_30.get(pid, 0) + rev, 2)

    return jsonify({
        "bookings":         bookings,
        "count":            len(bookings),
        "total_revenue":    round(total_revenue, 2),
        "by_month":         by_month,
        "by_prop_month":    by_prop_month,
        "rev_past_30":      round(rev_past_30, 2),
        "rev_next_30":      round(rev_next_30, 2),
        "by_prop_past_30":  by_prop_past_30,
        "by_prop_next_30":  by_prop_next_30,
    })


# ── Get all stored transactions (called on page load) ─────────
@app.route("/api/transactions/all")
@app.route("/api/transactions")
def get_all_transactions():
    store = load_store()
    tx_store = store.get("transactions", {})
    tags = store.get("tags", {})
    # Merge property_tag into each transaction so mobile has it
    txs = []
    for tx in tx_store.values():
        t = dict(tx)
        tid = t.get("id", "")
        if tid in tags:
            t["property_tag"] = tags[tid]
        txs.append(t)
    return jsonify({"transactions": txs})

# ── Tags ──────────────────────────────────────────────────────
@app.route("/api/props", methods=["GET"])
def get_props():
    store = load_store()
    return jsonify({"props": store.get("custom_props", [])})

@app.route("/api/props", methods=["POST"])
def save_props():
    store = load_store()
    store["custom_props"] = request.json.get("props", [])
    save_store(store)
    return jsonify({"ok": True})

@app.route("/api/tags", methods=["GET"])
def get_tags():
    store = load_store()
    return jsonify({"tags": store.get("tags", {})})

@app.route("/api/tags", methods=["POST"])
def save_tags():
    store = load_store()
    store["tags"] = request.json.get("tags", {})
    save_store(store)
    return jsonify({"ok": True})

# ── Manual Income ──────────────────────────────────────────────
@app.route("/api/manual-income", methods=["GET"])
def get_manual_income():
    store = load_store()
    return jsonify({"manual": store.get("manual_income", {})})

@app.route("/api/manual-income", methods=["POST"])
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
        store["inv_groups"] = request.json.get("groups", [])
        save_store(store)
        return jsonify({"ok": True})
    return jsonify({"groups": store.get("inv_groups", [])})

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
            print(f"Balance error for {account.get('name')}: {e}")
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

# ══════════════════════════════════════════════════════════════
# GMAIL OAUTH + INVENTORY
# ══════════════════════════════════════════════════════════════

def _gmail_flow():
    """Build an OAuth2 flow from env-var credentials."""
    client_config = {"web": {
        "client_id":     GMAIL_CLIENT_ID,
        "client_secret": GMAIL_CLIENT_SECRET,
        "auth_uri":      "https://accounts.google.com/o/oauth2/auth",
        "token_uri":     "https://oauth2.googleapis.com/token",
        "redirect_uris": [GMAIL_REDIRECT_URI],
    }}
    return Flow.from_client_config(client_config, scopes=GMAIL_SCOPES,
                                   redirect_uri=GMAIL_REDIRECT_URI)


def _get_gmail_credentials():
    """Load stored credentials, refresh the access token only when actually expired."""
    from datetime import datetime, timezone
    store = load_store()
    cd    = store.get("gmail_credentials")
    # Fallback: GMAIL_CREDENTIALS_JSON env var survives redeploys even on ephemeral filesystems
    if not cd:
        raw = os.environ.get("GMAIL_CREDENTIALS_JSON", "").strip()
        if raw:
            try:
                cd = json.loads(raw)
                print("📧 Loaded Gmail credentials from GMAIL_CREDENTIALS_JSON env var")
            except Exception as e:
                print(f"⚠️ GMAIL_CREDENTIALS_JSON parse error: {e}")
    if not cd:
        return None
    # Reconstruct expiry so creds.expired is accurate (None expiry = always-expired bug)
    expiry = None
    if cd.get("expiry"):
        try:
            # google-auth compares expiry against utcnow() which is naive UTC —
            # keep it naive too, otherwise we get offset-naive vs offset-aware error
            expiry = datetime.fromisoformat(cd["expiry"])
            if expiry.tzinfo is not None:
                expiry = expiry.replace(tzinfo=None)
        except Exception:
            pass
    creds = Credentials(
        token         = cd.get("token"),
        refresh_token = cd.get("refresh_token"),
        token_uri     = cd.get("token_uri", "https://oauth2.googleapis.com/token"),
        client_id     = GMAIL_CLIENT_ID,
        client_secret = GMAIL_CLIENT_SECRET,
        scopes        = GMAIL_SCOPES,
        expiry        = expiry,
    )
    if creds.expired and creds.refresh_token:
        print("🔄 Gmail token expired/unknown — refreshing…")
        try:
            creds.refresh(GoogleAuthRequest())
            store["gmail_credentials"]["token"]  = creds.token
            exp = creds.expiry
            store["gmail_credentials"]["expiry"] = exp.replace(tzinfo=None).isoformat() if exp else None
            save_store(store)
            print(f"✅ Gmail token refreshed — new expiry: {creds.expiry}")
        except Exception as refresh_err:
            print(f"⚠️ Token refresh failed ({refresh_err}) — trying existing token as-is")
            # The existing token might still be valid; let the API call tell us if not
    return creds


# ── GET /api/gmail/auth ──────────────────────────────────────
@app.route("/api/gmail/auth")
def gmail_auth():
    if not GMAIL_CLIENT_ID or not GMAIL_CLIENT_SECRET:
        return jsonify({"error": "GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not set"}), 500
    if not GMAIL_REDIRECT_URI:
        return jsonify({"error": "GMAIL_REDIRECT_URI not set"}), 500
    try:
        flow = _gmail_flow()
        auth_url, state = flow.authorization_url(
            access_type="offline", include_granted_scopes="true", prompt="consent"
        )
        # Store state in persistent store so all gunicorn workers can validate it
        store = load_store()
        oauth_states = store.get("oauth_states", {})
        oauth_states[state] = True
        store["oauth_states"] = oauth_states
        save_store(store)
        return redirect(auth_url)
    except Exception as e:
        print(f"❌ gmail_auth error: {e}")
        return jsonify({"error": str(e)}), 500


# ── GET /api/gmail/callback ──────────────────────────────────
@app.route("/api/gmail/callback")
def gmail_callback():
    error = request.args.get("error", "")
    if error:
        print(f"❌ OAuth denied by user: {error}")
        return f"""<html><body style="font-family:sans-serif;text-align:center;padding:60px">
<h2>❌ Gmail connection denied</h2><p>{error}</p><p>You can close this tab.</p></body></html>"""
    state = request.args.get("state", "")
    code  = request.args.get("code",  "")
    # Validate state from persistent store (works across gunicorn workers)
    store = load_store()
    oauth_states = store.get("oauth_states", {})
    if state not in oauth_states:
        print(f"❌ Invalid OAuth state: {state!r}")
        return jsonify({"error": "Invalid OAuth state — possible CSRF"}), 400
    del oauth_states[state]
    store["oauth_states"] = oauth_states
    try:
        flow = _gmail_flow()
        flow.fetch_token(code=code)
        creds = flow.credentials
        store["gmail_credentials"] = {
            "token":         creds.token,
            "refresh_token": creds.refresh_token,
            "token_uri":     creds.token_uri,
            # Store expiry as naive UTC — google-auth compares against naive utcnow()
            "expiry": creds.expiry.replace(tzinfo=None).isoformat() if creds.expiry else None,
        }
        save_store(store)
        creds_json = json.dumps(store["gmail_credentials"])
        print(f"✅ Gmail OAuth connected — token expires: {creds.expiry}")
        print(f"📋 Set this in Render env vars to survive redeploys:")
        print(f"   GMAIL_CREDENTIALS_JSON={creds_json}")
    except Exception as e:
        print(f"❌ gmail_callback fetch_token error: {e}")
        return f"""<html><body style="font-family:sans-serif;text-align:center;padding:60px">
<h2>❌ Gmail connection failed</h2><p>{e}</p><p>Close this tab and try again.</p></body></html>""", 500

    # Kick off an immediate sync — non-daemon so it isn't killed if the
    # response is returned before the thread finishes
    threading.Thread(target=run_gmail_sync, daemon=False).start()

    return f"""<html><body style="font-family:sans-serif;padding:40px;max-width:640px;margin:auto">
<h2>✅ Gmail connected!</h2>
<p>Importing your Amazon orders now — check the Inventory tab in a moment.</p>
<hr style="margin:24px 0">
<p style="font-size:13px;color:#555"><strong>To make this permanent across server restarts:</strong><br>
Copy the value below and add it as a Render environment variable named
<code>GMAIL_CREDENTIALS_JSON</code>.</p>
<textarea readonly style="width:100%;height:80px;font-size:11px;font-family:monospace;padding:8px;box-sizing:border-box">{creds_json}</textarea>
<p style="font-size:12px;color:#888">You only need to do this once. After setting the env var, credentials survive redeploys automatically.</p>
</body></html>"""


# ── Email helpers ─────────────────────────────────────────────

# Ordered from most-specific to least-specific.
# Each entry: (regex_to_match_in_title, canonical_display_name)
_PRODUCT_PATTERNS = [
    # Bedding / pillows
    (r'pillow\s*case|pillowcase',                      'Pillowcases'),
    (r'bed\s*sheet|fitted\s*sheet|sheet\s*set',        'Bed Sheets'),
    (r'duvet\s*cover',                                 'Duvet Cover'),
    (r'duvet|comforter',                               'Comforter'),
    (r'mattress\s*protector',                          'Mattress Protector'),
    (r'mattress\s*pad|mattress\s*cover|mattress\s*topper', 'Mattress Pad'),
    (r'bed\s*pillow|pillow',                           'Bed Pillows'),
    # Bath linens
    (r'bath\s*towel',                                  'Bath Towels'),
    (r'hand\s*towel',                                  'Hand Towels'),
    (r'washcloth|wash\s*cloth',                        'Washcloths'),
    (r'bath\s*mat|bath\s*rug',                         'Bath Mat'),
    (r'shower\s*curtain',                              'Shower Curtain'),
    (r'bath\s*robe|bathrobe',                          'Bathrobes'),
    # Paper goods
    (r'toilet\s*paper|bath\s*tissue',                  'Toilet Paper'),
    (r'paper\s*towel',                                 'Paper Towels'),
    (r'facial\s*tissue|tissue\s*box|kleenex',          'Facial Tissue'),
    (r'napkin',                                        'Napkins'),
    (r'paper\s*plate',                                 'Paper Plates'),
    (r'paper\s*cup',                                   'Paper Cups'),
    # Trash bags
    (r'trash\s*bag|garbage\s*bag|bin\s*liner|waste\s*bag|kitchen\s*bag', 'Trash Bags'),
    (r'recycling\s*bag',                               'Recycling Bags'),
    # Personal care — hair
    (r'shampoo',                                       'Shampoo'),
    (r'conditioner',                                   'Conditioner'),
    (r'body\s*wash|bodywash|shower\s*gel',             'Body Wash'),
    # Soap
    (r'hand\s*soap|liquid\s*soap|foaming\s*soap',      'Hand Soap'),
    (r'bar\s*soap|soap\s*bar',                         'Bar Soap'),
    (r'dish\s*soap|dish\s*detergent|dishwashing\s+(?:soap|liquid)', 'Dish Soap'),
    # Dental
    (r'toothbrush',                                    'Toothbrushes'),
    (r'toothpaste',                                    'Toothpaste'),
    (r'dental\s*floss|floss\s*pick',                   'Dental Floss'),
    (r'mouthwash',                                     'Mouthwash'),
    # Skincare
    (r'lotion|moisturizer',                            'Lotion'),
    (r'deodorant|antiperspirant',                      'Deodorant'),
    (r'razor',                                         'Razors'),
    (r'cotton\s*ball',                                 'Cotton Balls'),
    (r'cotton\s*swab|q.tip',                           'Cotton Swabs'),
    # Laundry
    (r'laundry\s*pod|detergent\s*pod|tide\s*pod',      'Laundry Pods'),
    (r'laundry\s*detergent|washing\s*detergent',       'Laundry Detergent'),
    (r'dryer\s*sheet',                                 'Dryer Sheets'),
    (r'fabric\s*softener',                             'Fabric Softener'),
    # Cleaning
    (r'disinfect(?:ant|ing)\s*wipe|antibacterial\s*wipe|lysol\s*wipe', 'Disinfecting Wipes'),
    (r'dishwasher\s*pod|dishwasher\s*tab|dish(?:washer)?\s*tab', 'Dishwasher Pods'),
    (r'bathroom\s*cleaner|toilet\s*bowl\s*cleaner|toilet\s*cleaner', 'Bathroom Cleaner'),
    (r'all.purpose\s*cleaner|multi.surface\s*cleaner|cleaning\s*spray', 'All-Purpose Cleaner'),
    (r'glass\s*cleaner|window\s*cleaner',              'Glass Cleaner'),
    (r'bleach',                                        'Bleach'),
    (r'sponge|scrub\s*pad',                            'Sponges'),
    (r'mop\s*pad|mop\s*head',                          'Mop Pads'),
    (r'air\s*freshener|room\s*spray|plug.in',          'Air Freshener'),
    (r'odor\s*elim|odor\s*remov|odor\s*absorb',        'Odor Eliminator'),
    (r'wipe',                                          'Wipes'),
    # Coffee / kitchen
    (r'coffee\s*pod|k.?cup|kcup',                      'Coffee Pods'),
    (r'coffee\s*filter',                               'Coffee Filters'),
    (r'coffee',                                        'Coffee'),
    (r'tea\s*bag',                                     'Tea Bags'),
    (r'plastic\s*wrap|cling\s*wrap|saran\s*wrap',      'Plastic Wrap'),
    (r'aluminum\s*foil|tin\s*foil',                    'Aluminum Foil'),
    (r'zip.?lock|storage\s*bag|sandwich\s*bag|freezer\s*bag|gallon\s*bag', 'Storage Bags'),
    (r'plastic\s*utensil|plastic\s*fork|plastic\s*knife|plastic\s*spoon', 'Plastic Utensils'),
    (r'plastic\s*cup',                                 'Plastic Cups'),
    # Guest toiletry sizes (small bottles)
    (r'mini\s*shampoo|travel\s*shampoo',               'Mini Shampoo'),
    (r'mini\s*conditioner|travel\s*conditioner',       'Mini Conditioner'),
    (r'mini\s*body\s*wash|travel\s*body\s*wash',       'Mini Body Wash'),
    (r'amenity|toiletry\s*set|guest\s*amenity',        'Guest Amenities'),
    # Miscellaneous
    (r'hand\s*sanitizer',                              'Hand Sanitizer'),
    (r'bandage|band.aid',                              'Bandages'),
    (r'ibuprofen|tylenol|acetaminophen|advil',         'Pain Reliever'),
]

# Product nouns used to anchor fallback name extraction when no pattern matches.
# These are kept (not filtered) and used as pivot words.
_PRODUCT_NOUNS = {
    'pillow','pillows','pillowcase','pillowcases',
    'sheet','sheets','duvet','comforter','blanket','quilt',
    'towel','towels','washcloth','washcloths','bathrobe',
    'mat','rug','curtain','curtains','liner','liners',
    'tissue','napkin','napkins',
    'soap','shampoo','conditioner','lotion','cream','gel','serum',
    'brush','toothbrush','toothpaste','floss','razor','razors',
    'detergent','softener','bleach','sponge','sponges',
    'wipes','cleaner','spray','disinfectant',
    'coffee','wrap','foil','sanitizer','bandage','bandages',
    'cover','protector','pads','pad','insert','inserts',
}

# Stop words for fallback name extraction
_NAME_STOP = {
    'and','the','for','with','of','in','by','to','from','a','an','or','on','at',
    'as','is','it','its','into','via','per','pack','pcs','pieces','piece','count',
    'ct','bulk','premium','quality','hotel','disposable','ultra','extra','super',
    'soft','strong','fresh','clean','quick','easy','new','best','high','plus',
    'size','big','small','large','mini','travel','value','family','mega','jumbo',
    'regular','standard','comfortable','natural','organic','gentle','original',
    'advanced','professional','multi','all','purpose','use','set','lot','box',
    'case','bag','roll','pack','bottle','gallon','oz','lb','inch','inches',
    'double','triple','single','twin','full','queen','king','thread',
    'alternatives','alternative','grade','certified','approved','free','non',
    'down','white','black','blue','green','gray','grey','beige','brown',
}

def _extract_canonical_name(raw_title):
    """
    Given a raw product title (after stripping Amazon prefix boilerplate),
    return a short canonical product name.

    Strategy:
    1. Try keyword matching against _PRODUCT_PATTERNS → return canonical label
    2. Fall back: strip brand words, numbers, fluff, return first 3 useful words
    """
    t = raw_title.lower()

    # 1. Keyword match
    for pattern, canonical in _PRODUCT_PATTERNS:
        if re.search(pattern, t, re.I):
            return canonical

    # 2. Fallback: anchor on a known product noun, or skip leading brand word
    words = re.sub(r'\b\d+\b', '', raw_title)        # strip bare numbers
    words = re.sub(r'[,.()\[\]"\'!?]+', ' ', words)  # strip punctuation
    all_tokens = [w for w in words.split() if len(w) > 1]

    # 2a. Look for a product noun anywhere in the title; build name around it
    for i, w in enumerate(all_tokens):
        if w.lower() in _PRODUCT_NOUNS:
            # Take 0-2 meaningful descriptor words before the noun + noun itself
            window = all_tokens[max(0, i - 2):i + 2]
            clean = [t for t in window if t.lower() not in _NAME_STOP]
            if clean:
                return " ".join(clean[:3]).title()

    # 2b. No product noun found — skip the first word if it looks like a brand
    # (starts with uppercase and isn't a stop word), then take 3 content words
    skip = 1 if all_tokens and all_tokens[0][0].isupper() else 0
    tokens = [w for w in all_tokens[skip:] if w.lower() not in _NAME_STOP]
    if tokens:
        return " ".join(tokens[:3]).title()

    # Last resort — take first 3 non-stop words from the full title
    tokens = [w for w in all_tokens if w.lower() not in _NAME_STOP]
    if tokens:
        return " ".join(tokens[:3]).title()
    return raw_title.strip()


_LIQUID_RE = re.compile(
    r'soap|shampoo|conditioner|body\s*wash|sanitizer|sanitiser|lotion|dish\s*liquid|'
    r'water|detergent|bleach|cleaner|spray|softener|rinse|mouthwash|'
    r'fabric\s*softener|laundry\s*liquid|dish\s*soap',
    re.I)

def _extract_volume_oz(text):
    """
    Parse fluid ounces from a product title string.
    Returns integer oz, or None if not found / not a liquid.
    """
    t = (text or "").lower()
    # Gallons: "1 gallon", "1.25 gal", "5-gallon"
    m = re.search(r'(\d+\.?\d*)\s*-?\s*gal(?:lon)?s?\b', t)
    if m:
        return round(float(m.group(1)) * 128)
    # Fluid oz: "64 fl oz", "64oz", "32 fluid ounces", "32-oz"
    m = re.search(r'(\d+\.?\d*)\s*-?\s*(?:fl\.?\s*oz|fluid\s*oz(?:s|ounce)?|oz\.?)\b', t)
    if m:
        val = round(float(m.group(1)))
        if 1 < val <= 2560:   # sanity: 1 oz – 20 gallons
            return val
    return None


def _clean_item_name(subject):
    """
    Strip Amazon boilerplate from a subject line, then extract a short
    canonical product name (e.g. "Bed Pillows", "Toilet Paper").
    """
    s = subject.strip().strip('"').strip("'")
    # Prefixes — order matters: strip "Delivered: 4 " before "Delivered: "
    prefixes = [
        r"your amazon\.com order of\s+",
        r"your order of\s+",
        r"delivered:\s+\d+\s+",
        r"delivered:\s+",
        r"ordered:\s+\d+\s+",
        r"ordered:\s+",
        r"order confirmation:\s+",
        r"you ordered\s+",
        r"shipped:\s+\d+\s+",
        r"shipped:\s+",
        r"your shipment of\s+",
    ]
    for p in prefixes:
        s = re.sub(p, "", s, flags=re.I)
    # Strip suffixes
    s = re.sub(r'\s+(?:has shipped|have shipped|has been shipped|and \d+ more item[s]?).*$', '', s, flags=re.I)
    s = re.sub(r'\s*\(order #[\w-]+\).*$', '', s, flags=re.I)
    s = s.strip('"').strip("'").strip()
    if not s:
        return subject
    return _extract_canonical_name(s)


def _extract_unit_count(text):
    """
    Parse a product name/description for a pack/quantity indicator.
    Returns the integer unit count, or 1 if nothing found.
    """
    patterns = [
        r'(\d+)\s*-\s*(?:pack|pk|ct|count)',   # 12-pack, 6-pk, 100-ct
        r'(\d+)\s*(?:pack|pk)',                  # 6 pack
        r'pack\s+of\s+(\d+)',                    # pack of 100
        r'set\s+of\s+(\d+)',                     # set of 4
        r'(\d+)\s*(?:count|ct)\.?',              # 100 count / 100ct
        r'(\d+)\s*pc\.?s?',                      # 20 pcs / 20pc
        r'(\d+)\s*piece',                        # 4 piece
        r'(\d+)\s*rolls?',                       # 6 rolls
        r'(\d+)\s*sheets?',                      # 200 sheets
        r'(\d+)\s*bags?',                        # 50 bags
        r'qty[:\s]+(\d+)',                       # qty: 6
        r'quantity[:\s]+(\d+)',                  # quantity: 4
        r'x\s*(\d+)\b',                          # x3
    ]
    for p in patterns:
        m = re.search(p, text, re.I)
        if m:
            val = int(m.group(1))
            if 1 < val <= 2000:   # sanity bounds
                return val
    return 1


# ── Email parser ─────────────────────────────────────────────
def _parse_amazon_email(msg_data):
    """Extract order details from an Amazon order/ship-confirm Gmail message."""
    headers  = {h["name"]: h["value"]
                for h in msg_data.get("payload", {}).get("headers", [])}
    subject  = headers.get("Subject", "")
    date_str = headers.get("Date", "")

    order_date = None
    try:
        order_date = parsedate_to_datetime(date_str).date().isoformat()
    except Exception:
        pass

    # Decode plain-text body (walk MIME tree)
    body = ""
    def _walk(part):
        nonlocal body
        if part.get("mimeType") == "text/plain" and not body:
            raw = part.get("body", {}).get("data", "")
            if raw:
                body = base64.urlsafe_b64decode(raw + "==").decode("utf-8", errors="replace")
        for sub in part.get("parts", []):
            _walk(sub)
    _walk(msg_data.get("payload", {}))

    # Extract canonical product name from email subject
    item = _clean_item_name(subject)

    # If body has a longer product description, check if it gives a better
    # canonical name (e.g. "You ordered: Bounty Quick-Size Paper Towels 12 Rolls")
    if body:
        m2 = re.search(r'(?:You ordered|Item ordered|Ordered):\s*(.+)', body, re.I)
        if m2:
            body_item = m2.group(1).strip()[:200]
            body_canonical = _clean_item_name(body_item)
            # Prefer body result if subject canonical was a single-word (likely brand)
            if body_canonical and len(body_canonical.split()) > len(item.split()):
                item = body_canonical
                # Also update raw title source for unit count extraction below
                subject = body_item

    # Order number  (###-#######-#######)
    order_num = ""
    m3 = re.search(r'(\d{3}-\d{7}-\d{7})', subject + " " + body)
    if m3:
        order_num = m3.group(1)

    # Unit count — extract from original source text BEFORE canonicalization
    unit_count = _extract_unit_count(subject)

    # Volume (oz) — only for liquid products
    volume_oz = None
    if _LIQUID_RE.search(subject) or _LIQUID_RE.search(item):
        volume_oz = _extract_volume_oz(subject)

    # Order quantity — "Ordered: 4 'Product'" has qty before the product name
    qty = 1
    m_subj_qty = re.search(r'^(?:ordered|delivered|shipped):\s+(\d+)\s+["\']', subject.strip(), re.I)
    if m_subj_qty:
        qty = int(m_subj_qty.group(1))
    else:
        m4 = re.search(r'(?:Qty|Quantity|qty):\s*(\d+)', body, re.I)
        if m4:
            qty = int(m4.group(1))

    # Price — first dollar amount in body
    price = None
    prices = re.findall(r'\$\s*(\d+\.\d{2})', body)
    if prices:
        price = float(prices[0])

    return {
        "id":            msg_data["id"],
        "subject":       subject,
        "item":          item or subject,
        "order_num":     order_num,
        "price":         price,
        "quantity":      qty,
        "unit_count":    unit_count,
        "volume_oz":     volume_oz,  # oz per bottle/container; None = count-based
        "date":          order_date,
        "prop_tag":      None,
        "excluded":      False,
        "source":        "amazon",
        "classified":    None,   # None | "inventory" | "not_inventory"
        "city_tag":      None,   # None | "houston" | "niagara"
        "inventory_key": None,   # normalized name for grouping duplicate orders
    }


def _reclean_inventory_store(store):
    """
    Retroactively clean all stored inventory items:
    - Re-apply _clean_item_name to the stored subject → canonical product name
    - Re-extract unit_count from ORIGINAL text (not the canonical name)
    - Auto-exclude untagged delivery notifications
    """
    inventory = store.get("inventory", {})
    for it in inventory.values():
        # Use the raw email subject for canonical extraction (has full product title)
        subject = it.get("subject") or ""
        # Ensure new classification fields exist
        it.setdefault("classified",    None)
        it.setdefault("city_tag",      None)
        it.setdefault("inventory_key", None)
        # Freeze classified items: once classified, protect name/key from reclean
        if it.get("classified") is not None:
            it.setdefault("name_locked", True)
            it.setdefault("inventory_key_locked", True)
        # Auto-exclude delivery notifications only if user hasn't classified them yet
        if it["classified"] is None and re.match(r'^delivered:', subject.strip(), re.I):
            it["excluded"] = True
        if subject:
            # Skip auto-name if the user has manually locked the name
            if not it.get("name_locked"):
                it["item"] = _clean_item_name(subject)
            # Skip auto-unit_count if the user has manually locked it
            if not it.get("unit_count_locked"):
                it["unit_count"] = _extract_unit_count(subject)
            # Auto-extract volume_oz for liquids if not user-locked
            if not it.get("volume_oz_locked"):
                item_name = it.get("item") or ""
                if _LIQUID_RE.search(subject) or _LIQUID_RE.search(item_name):
                    vol = _extract_volume_oz(subject)
                    if vol:
                        it["volume_oz"] = vol
            # Re-extract order quantity from "Ordered: 4 'Product'" pattern
            m = re.search(r'^(?:ordered|delivered|shipped):\s+(\d+)\s+["\']', subject.strip(), re.I)
            if m and it.get("quantity", 1) == 1:
                it["quantity"] = int(m.group(1))
        # Regenerate inventory_key for classified items UNLESS user manually linked it
        if it.get("classified") == "inventory" and it.get("item") and not it.get("inventory_key_locked"):
            name  = it["item"]
            stop  = {"the","a","an","of","for","with","and","or","in","by","to","from"}
            words = re.sub(r"[^a-z0-9\s]", "", name.lower()).split()
            it["inventory_key"] = " ".join(w for w in words if len(w) > 2 and w not in stop)[:60]
    store["inventory"] = inventory
    return store


def run_gmail_sync():
    """Fetch Amazon ship-confirm emails from Gmail, parse, store in inventory."""
    print("📧 run_gmail_sync starting…")
    creds = _get_gmail_credentials()
    if not creds:
        print("📧 Gmail sync skipped — no credentials stored (visit /api/gmail/auth)")
        return {"synced": 0, "total": 0}

    print(f"📧 Credentials loaded — expired={creds.expired}, has_refresh={bool(creds.refresh_token)}")
    service   = google_build("gmail", "v1", credentials=creds)
    store     = load_store()
    inventory = store.get("inventory", {})
    already   = len(inventory)

    # Only order + ship confirmations — exclude delivery/tracking notifications
    q = ("(from:ship-confirm@amazon.com OR from:auto-confirm@amazon.com)"
         " -subject:delivered -subject:\"out for delivery\""
         " -subject:\"delivery attempt\" -subject:\"arriving today\"")
    print(f"📧 Querying Gmail: {q}")
    try:
        results = service.users().messages().list(userId="me", q=q, maxResults=500).execute()
    except Exception as api_err:
        print(f"❌ Gmail API list failed: {api_err}")
        raise RuntimeError(f"Gmail API error: {api_err}") from api_err
    messages = results.get("messages", [])
    new_msgs = [m for m in messages if m["id"] not in inventory]
    print(f"📧 {len(messages)} messages matched query, {len(new_msgs)} are new (not yet in inventory)")

    new_count = 0
    errors    = 0
    for ref in new_msgs:
        mid = ref["id"]
        try:
            msg_data = service.users().messages().get(
                userId="me", id=mid, format="full"
            ).execute()
            parsed = _parse_amazon_email(msg_data)
            inventory[mid] = parsed
            new_count += 1
            print(f"  ✅ Parsed: {parsed.get('item','?')[:60]} | {parsed.get('date')} | ${parsed.get('price')}")
        except Exception as e:
            errors += 1
            print(f"  ⚠️  Skipping message {mid}: {e}")

    from datetime import datetime, timezone
    now_iso = datetime.now(timezone.utc).isoformat()
    store["inventory"]           = inventory
    store["gmail_last_sync"]     = now_iso
    store["gmail_message_count"] = len(messages)
    # Retroactively clean all items (names, unit counts, exclude delivery notifications)
    store = _reclean_inventory_store(store)
    save_store(store)
    print(f"✅ Gmail sync done: {new_count} new, {errors} errors, "
          f"{len(inventory)} total (was {already}) | {len(messages)} matched query")
    return {"synced": new_count, "total": len(inventory),
            "message_count": len(messages), "last_sync": now_iso, "errors": errors}


# Tracks whether a sync is in progress so we don't stack concurrent syncs
_gmail_sync_running = False

# ── GET /api/gmail/sync ──────────────────────────────────────
# Fires sync in a background thread and returns immediately — no HTTP timeout risk
@app.route("/api/gmail/sync")
def gmail_sync_route():
    global _gmail_sync_running
    if _gmail_sync_running:
        store = load_store()
        return jsonify({"ok": True, "status": "running",
                        "message": "Sync already in progress — check back in a moment",
                        "total": len(store.get("inventory", {}))})

    def _bg():
        global _gmail_sync_running
        _gmail_sync_running = True
        try:
            run_gmail_sync()
        except Exception as e:
            print(f"❌ Background Gmail sync error: {e}")
        finally:
            _gmail_sync_running = False

    threading.Thread(target=_bg, daemon=False).start()
    store = load_store()
    return jsonify({"ok": True, "status": "started",
                    "last_sync": store.get("gmail_last_sync"),
                    "total": len(store.get("inventory", {}))})


# ── GET /api/gmail/status ─────────────────────────────────────
@app.route("/api/gmail/status")
def gmail_status():
    store = load_store()
    return jsonify({
        "connected":       bool(store.get("gmail_credentials")),
        "last_sync":       store.get("gmail_last_sync"),
        "inventory_count": len(store.get("inventory", {})),
        "message_count":   store.get("gmail_message_count", 0),
    })


# ── GET /api/gmail/debug ──────────────────────────────────────
# Proves the stored credentials are live and the query actually hits Gmail
@app.route("/api/gmail/debug")
def gmail_debug():
    creds = _get_gmail_credentials()
    if not creds:
        return jsonify({"connected": False, "error": "No credentials stored — visit /api/gmail/auth"})
    try:
        service = google_build("gmail", "v1", credentials=creds)
        profile = service.users().getProfile(userId="me").execute()
        results = service.users().messages().list(
            userId="me",
            q="from:ship-confirm@amazon.com OR from:auto-confirm@amazon.com OR from:order-update@amazon.com",
            maxResults=5
        ).execute()
        store = load_store()
        return jsonify({
            "connected":           True,
            "email":               profile.get("emailAddress"),
            "gmail_total_msgs":    profile.get("messagesTotal"),
            "amazon_msgs_found":   len(results.get("messages", [])),
            "inventory_stored":    len(store.get("inventory", {})),
            "last_sync":           store.get("gmail_last_sync"),
        })
    except Exception as e:
        print(f"❌ Gmail debug error: {e}")
        return jsonify({"connected": False, "error": str(e)}), 500


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
    if iid in inventory:
        inventory[iid].update({k: v for k, v in item.items() if k != "id"})
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


# ── POST /api/inventory/reclean ──────────────────────────────
@app.route("/api/inventory/reclean", methods=["POST"])
def reclean_inventory():
    """Retroactively clean all stored inventory item names and auto-exclude delivery notifications."""
    store = load_store()
    before = {iid: (it.get("item"), it.get("excluded")) for iid, it in store.get("inventory", {}).items()}
    store = _reclean_inventory_store(store)
    save_store(store)
    after = store.get("inventory", {})
    cleaned  = sum(1 for iid, it in after.items() if it.get("item") != before.get(iid, (None,))[0])
    excluded = sum(1 for iid, it in after.items() if it.get("excluded") and not before.get(iid, (None, False))[1])
    return jsonify({"ok": True, "total": len(after), "cleaned": cleaned, "excluded": excluded})


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


# ── iCal helpers ─────────────────────────────────────────────────
def _parse_ics(ics_text, prop_id, feed_key="", pl_id=None):
    """Pure-text VEVENT parser — extracts guest name, rate, check-in/out.
    feed_key: short hash of the iCal URL (stable ID for this feed).
    pl_id: Airbnb/PriceLabs listing ID extracted from the iCal URL.
    """
    events, in_event, current = [], False, {}
    for line in ics_text.splitlines():
        line = line.strip()
        if line == "BEGIN:VEVENT":
            in_event = True; current = {}
        elif line == "END:VEVENT" and in_event:
            in_event = False
            def _dt(v):
                v = v.split(";")[-1].split(":")[-1][:8]
                return f"{v[:4]}-{v[4:6]}-{v[6:8]}"
            start = _dt(current.get("DTSTART","")) if "DTSTART" in current else None
            end   = _dt(current.get("DTEND",""))   if "DTEND"   in current else None
            if start and end:
                from datetime import date as _date
                s,e = _date.fromisoformat(start), _date.fromisoformat(end)
                summary = current.get("SUMMARY","").replace("\\n"," ").strip()
                desc    = current.get("DESCRIPTION","").replace("\\n","\n").strip()

                # Extract guest name from DESCRIPTION (Airbnb embeds FIRST/LAST NAME)
                guest_name = None
                m_first = re.search(r'FIRST NAME:\s*(.+)', desc, re.I)
                m_last  = re.search(r'LAST NAME:\s*(.+)',  desc, re.I)
                if m_first or m_last:
                    first = (m_first.group(1).strip() if m_first else "")
                    last  = (m_last.group(1).strip()  if m_last  else "")
                    guest_name = f"{first} {last}".strip() or None
                # Fallback: use SUMMARY if it looks like a guest name (not "Reserved" etc.)
                if not guest_name and summary and not re.match(
                        r'^(reserved|airbnb|not available|unavailable|blocked)', summary, re.I):
                    guest_name = summary

                # Extract nightly rate from DESCRIPTION
                nightly_rate = None
                m_rate = re.search(r'NIGHTLY RATE:\s*\$?([\d.]+)', desc, re.I)
                if not m_rate:
                    m_rate = re.search(r'\$\s*([\d.]+)\s*/\s*night', desc, re.I)
                if m_rate:
                    try: nightly_rate = float(m_rate.group(1))
                    except: pass

                # Extract check-in / check-out times (from DESCRIPTION first)
                checkin_time  = None
                checkout_time = None
                m_ci = re.search(r'CHECK.?IN(?:\s+TIME)?:\s*(.+)',  desc, re.I)
                m_co = re.search(r'CHECK.?OUT(?:\s+TIME)?:\s*(.+)', desc, re.I)
                if m_ci: checkin_time  = m_ci.group(1).strip()[:20]
                if m_co: checkout_time = m_co.group(1).strip()[:20]
                # Fallback: extract time from DTSTART/DTEND if datetime (not date-only)
                def _extract_time(dt_raw):
                    val = dt_raw.split(":")[-1]
                    if "T" in val and len(val) >= 13:
                        t = val[9:13]
                        if len(t) == 4 and t.isdigit():
                            h, m = int(t[:2]), int(t[2:])
                            if h == 0:   return f"12:{m:02d} AM"
                            if h < 12:   return f"{h}:{m:02d} AM"
                            if h == 12:  return f"12:{m:02d} PM"
                            return       f"{h-12}:{m:02d} PM"
                    return None
                if not checkin_time:
                    checkin_time = _extract_time(current.get("DTSTART",""))
                if not checkout_time:
                    checkout_time = _extract_time(current.get("DTEND",""))

                # Extract number of guests
                num_guests = None
                m_guests = re.search(r'(?:NUMBER OF GUESTS|TOTAL GUESTS|GUESTS|ADULTS):\s*(\d+)', desc, re.I)
                if m_guests:
                    try: num_guests = int(m_guests.group(1))
                    except: pass

                # Extract booking source
                booking_source = None
                m_src = re.search(r'(?:SOURCE|BOOKED VIA|PLATFORM|BOOKED ON|BOOKING SOURCE):\s*(.+)', desc, re.I)
                if m_src:
                    booking_source = m_src.group(1).strip()[:40]
                if not booking_source:
                    uid_lower = current.get("UID","").lower()
                    desc_lower = desc.lower()
                    if "airbnb" in uid_lower or "airbnb" in desc_lower:
                        booking_source = "Airbnb"
                    elif "vrbo" in uid_lower or "vrbo" in desc_lower or "homeaway" in uid_lower:
                        booking_source = "VRBO"
                    elif "booking.com" in desc_lower:
                        booking_source = "Booking.com"

                events.append({
                    "uid":            current.get("UID", f"{prop_id}-{start}"),
                    "propId":         prop_id,
                    "feed_key":       feed_key,   # stable hash of iCal URL — identifies the unit
                    "pl_id":          pl_id,       # Airbnb/PriceLabs listing ID from URL
                    "start":          start,
                    "end":            end,
                    "summary":        summary,
                    "nights":         (e-s).days,
                    "guest_name":     guest_name,
                    "nightly_rate":   nightly_rate,
                    "checkin_time":   checkin_time,
                    "checkout_time":  checkout_time,
                    "num_guests":     num_guests,
                    "booking_source": booking_source,
                })
        elif in_event and ":" in line:
            k,_,v = line.partition(":")
            current[k.split(";")[0]] = v
    return events
def _ical_feed_key(url):
    """Stable 8-char hash of the iCal URL — identifies a specific unit feed."""
    return hashlib.md5(url.encode()).hexdigest()[:8]

def _airbnb_listing_id(url):
    """Extract Airbnb listing ID from iCal URL: /calendar/ical/LISTING_ID.ics"""
    m = re.search(r'/calendar/ical/(\d+)\.ics', url)
    return m.group(1) if m else None

def _sync_ical(store):
    import urllib.request
    feeds = store.get("ical_urls", [])
    # Backward compat: migrate old {propId: url} dict to array
    if isinstance(feeds, dict):
        feeds = [{"propId": k, "url": v} for k, v in feeds.items()]
    all_events = []
    for feed in feeds:
        prop_id = feed.get("propId", "")
        url = feed.get("url", "")
        if not url: continue
        feed_key = _ical_feed_key(url)
        pl_id    = _airbnb_listing_id(url)
        try:
            with urllib.request.urlopen(url, timeout=10) as r:
                ics = r.read().decode("utf-8", errors="replace")
            all_events.extend(_parse_ics(ics, prop_id, feed_key, pl_id))
        except Exception as e:
            print(f"iCal sync failed for {prop_id} ({feed_key}): {e}")
    return all_events

@app.route("/api/ical/urls", methods=["GET","POST"])
def ical_urls_route():
    store = load_store()
    if request.method == "POST":
        store["ical_urls"] = request.json.get("feeds", [])
        save_store(store); return jsonify({"ok": True})
    feeds = store.get("ical_urls", [])
    if isinstance(feeds, dict):
        feeds = [{"propId": k, "url": v} for k, v in feeds.items()]
    # Enrich each feed with stable feed_key, pl_id, and canonical short name from PriceLabs
    short_names = store.get("pricelabs_short_names", {})  # {pl_id: "Lockwood 1"}
    enriched = []
    for f in feeds:
        url      = f.get("url", "")
        feed_key = _ical_feed_key(url) if url else ""
        pl_id    = _airbnb_listing_id(url) if url else None
        canon    = short_names.get(pl_id, "") if pl_id else ""
        enriched.append({**f, "feed_key": feed_key, "pl_id": pl_id, "canonical_name": canon})
    return jsonify({"feeds": enriched})

@app.route("/api/ical/sync", methods=["POST"])
def ical_sync_route():
    store = load_store()
    new_events = _sync_ical(store)
    existing = {e["uid"]: e for e in store.get("ical_events", [])}
    for e in new_events:
        existing[e["uid"]] = e
    merged = list(existing.values())
    store["ical_events"] = merged
    save_store(store); return jsonify({"events": merged, "count": len(merged)})

@app.route("/api/ical/events", methods=["GET"])
def ical_events_route():
    store = load_store()
    return jsonify({"events": store.get("ical_events", [])})

# ══════════════════════════════════════════════════════════════
# STR Analytics Engine
# Data sources: iCal events, per-property income, PriceLabs API
# ══════════════════════════════════════════════════════════════

# Canonical STR property IDs — must match propId values in iCal feeds
STR_PROPERTIES = ["lockwood", "everton", "bstreet", "pierce"]


def _is_block_event(ev):
    """True if an iCal event is an owner-block / maintenance hold, not a guest stay."""
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
    events            — full list of parsed iCal events (all properties)
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
    """Aggregate analytics across all STR properties that have iCal events."""
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


# ── PriceLabs API wrapper ─────────────────────────────────────────────────────
# Docs: https://pricelabs.co/api-docs
# Auth: X-API-Key header; key stored in env var PRICELABS_API_KEY

PRICELABS_BASE = "https://api.pricelabs.co/v1"


def _pricelabs_get(path, params=None):
    """GET request to PriceLabs API. Returns parsed JSON or raises RuntimeError."""
    import urllib.request, urllib.parse
    api_key = os.environ.get("PRICELABS_API_KEY", "")
    if not api_key:
        # Fall back to user-saved key in store
        api_key = load_store().get("pricelabs_api_key", "")
    if not api_key:
        raise RuntimeError("PriceLabs API key not configured. Add it in Settings → PriceLabs.")
    url = PRICELABS_BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url,
        headers={
            "X-API-Key": api_key,
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"PriceLabs {e.code}: {body[:400]}")


def _fetch_pricelabs_listing(prop_id, start_date_str, end_date_str):
    """
    Fetch PriceLabs recommended prices and min-stay rules for one listing.
    Mapping between prop_id ↔ PriceLabs listing_id is stored in
    store["pricelabs_mapping"] = {prop_id: pl_listing_id}.
    """
    store   = load_store()
    mapping = store.get("pricelabs_mapping", {})
    pl_id   = mapping.get(prop_id)
    if not pl_id:
        return {
            "error": (
                f"No PriceLabs listing mapped to '{prop_id}'. "
                f"POST /api/analytics/pricelabs/map with "
                f'body {{"mapping": {{"{prop_id}": "<pl_listing_id>"}}}}'
            )
        }
    try:
        prices       = _pricelabs_get("/listing_prices", {
            "listing_id": pl_id,
            "start_date": start_date_str,
            "end_date":   end_date_str,
        })
        try:
            listing_info = _pricelabs_get("/listings", {"listing_id": pl_id})
        except Exception:
            listing_info = {}
        return {
            "prop_id":        prop_id,
            "pl_listing_id":  pl_id,
            "period":         {"start": start_date_str, "end": end_date_str},
            "prices":         prices,
            "listing_info":   listing_info,
        }
    except RuntimeError as exc:
        return {"error": str(exc)}


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
    events = store.get("ical_events", [])
    start, end = _analytics_range(request)
    return jsonify(_compute_listing_analytics(events, prop_id, start, end))


@app.route("/api/analytics/portfolio")
def analytics_portfolio():
    """Portfolio-wide: occupancy, total booked nights, best/worst listings."""
    store  = load_store()
    events = store.get("ical_events", [])
    start, end = _analytics_range(request)
    return jsonify(_compute_portfolio_analytics(events, start, end))


@app.route("/api/analytics/pricelabs/config", methods=["POST"])
def pricelabs_config():
    """Save PriceLabs API key and property→listing mapping from the Settings UI."""
    body    = request.json or {}
    store   = load_store()
    if body.get("api_key"):
        store["pricelabs_api_key"] = body["api_key"].strip()
    if body.get("mapping"):
        mapping = store.get("pricelabs_mapping", {})
        mapping.update(body["mapping"])
        store["pricelabs_mapping"] = mapping
    save_store(store)
    return jsonify({"ok": True})


def _pl_canonical_short(short_label, prop_id):
    """
    Generate the canonical short name shown everywhere in the app UI.
    'Unit 1' + lockwood  → 'Lockwood 1'
    '22 B'  + bstreet   → '22 B'
    """
    if prop_id == 'lockwood':
        m = re.search(r'\d+', short_label)
        if m:
            return f"Lockwood {m.group()}"
    return short_label   # 22 B, 24 B, 26 B, etc. stay as-is


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


# City name → prop_id auto-mapping (covers the case where no manual mapping exists)
_PL_CITY_TO_PROP = {
    "houston":        "lockwood",
    "niagara falls":  "bstreet",
    "niagara-on-the-lake": "bstreet",
    "everton":        "everton",
}

# Name keyword → prop_id fallback (applied when city mapping fails)
import re as _re
_PL_NAME_KEYWORDS = [
    (_re.compile(r"gorge\s*getaway",           _re.I), "gorge"),
    (_re.compile(r"river\s*[&and]+\s*falls",   _re.I), "river_falls"),
    (_re.compile(r"riverstone",                 _re.I), "riverstone"),
]


def _pl_prop_from_name(raw_name):
    """Return prop_id based on listing name keywords, or None if no match."""
    for pattern, pid in _PL_NAME_KEYWORDS:
        if pattern.search(raw_name):
            return pid
    return None


_LISTING_PROP_KEYWORDS = [
    # Gorge / River / Riverstone first (more specific)
    (_re.compile(r"gorge\s*getaway",         _re.I), "gorge"),
    (_re.compile(r"river\s*[&and]+\s*falls", _re.I), "river_falls"),
    (_re.compile(r"riverstone",              _re.I), "riverstone"),
    # Houston EaDo / Lockwood = lockwood
    (_re.compile(r"eado|e\.?a\.?do",         _re.I), "lockwood"),
    (_re.compile(r"\bunit\s*[1-4]\b",        _re.I), "lockwood"),
    (_re.compile(r"\blockwood\b",            _re.I), "lockwood"),
    # Everton
    (_re.compile(r"everton",                 _re.I), "everton"),
    # B Street / Niagara (not already matched above)
    (_re.compile(r"b\s*street",              _re.I), "bstreet"),
    (_re.compile(r"niagara",                 _re.I), "bstreet"),
    # Pierce
    (_re.compile(r"pierce",                  _re.I), "pierce"),
]


def _infer_prop_from_listing(name):
    """Extended prop_id mapping from any listing/property name string."""
    if not name:
        return None
    pid = _pl_prop_from_name(name)
    if pid:
        return pid
    for pattern, p in _LISTING_PROP_KEYWORDS:
        if pattern.search(name):
            return p
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

    print(f"[CSV BOOKINGS] headers_raw={h_raw[:12]}")
    print(f"[CSV BOOKINGS] headers_norm={h[:12]}")
    print(f"[CSV BOOKINGS] col_map={col_map}")

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
    print(f"[CSV BOOKINGS] Parsed {len(bookings)}, skipped={skip_counts}")
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

            # Determine prop_id: manual mapping wins, then city auto-map, then name keywords
            pid = rev.get(lid) or _PL_CITY_TO_PROP.get(city) or _pl_prop_from_name(raw_name)

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

        print(f"[PriceLabs] {len(result)} listings loaded")
        for r in result:
            print(f"  {r['id']} → \"{r['canonical_name']}\" ({r['city']}) → prop_id={r['prop_id']}")

        # flat_names: {prop_id: "Lockwood 1, Lockwood 2, Lockwood 3, Lockwood 4"}
        flat_names   = {pid: ", ".join(sorted(names, key=lambda n: int(re.search(r'\d+',n).group()) if re.search(r'\d+',n) else 999))
                        for pid, names in name_by_prop.items()}
        # short_names: {pl_id: "Lockwood 1"}  — used by iCal URL enrichment
        short_names  = name_by_plid

        store["pricelabs_listing_names"]       = flat_names
        store["pricelabs_listing_names_by_id"] = short_names    # {pl_id: "Lockwood 1"}
        store["pricelabs_short_names"]         = short_names    # alias for ical_urls_route
        store["pricelabs_listings_raw"]        = result
        save_store(store)

        return jsonify({"listings": result, "names": flat_names, "names_by_id": short_names})
    except Exception as e:
        print(f"[PriceLabs] listings error: {e}")
        return jsonify({"error": str(e), "listings": []})


@app.route("/api/pricelabs/raw/reservation_data")
def pricelabs_raw_reservation_data():
    """
    Debug endpoint: tries GET and POST variations of /v1/reservation_data.
    """
    import urllib.request, urllib.parse

    LISTING_IDS = [
        "1523546771998151986","1523560635012518611","1540191077806734253",
        "1544826815980232108","1546750681335776815","1596469950428197209","1597959000664656537"
    ]
    START = "2025-10-01"
    END   = "2026-12-31"

    store   = load_store()
    api_key = os.environ.get("PRICELABS_API_KEY","") or store.get("pricelabs_api_key","")
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
    api_key = os.environ.get("PRICELABS_API_KEY", "") or store.get("pricelabs_api_key", "")
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
    api_key = os.environ.get("PRICELABS_API_KEY", "") or load_store().get("pricelabs_api_key", "")
    if not api_key:
        return jsonify({"error": "PRICELABS_API_KEY not configured"}), 400

    url = "https://api.pricelabs.co/v1/listings"
    req = urllib.request.Request(url, headers={
        "X-API-Key": api_key,
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read().decode("utf-8")
        print("=" * 60)
        print("[RAW PRICELABS /v1/listings]")
        print(raw)
        print("=" * 60)
        return raw, 200, {"Content-Type": "application/json"}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"[RAW PRICELABS ERROR] HTTP {e.code}: {body}")
        return jsonify({"error": f"HTTP {e.code}", "body": body}), 502
    except Exception as ex:
        print(f"[RAW PRICELABS ERROR] {ex}")
        return jsonify({"error": str(ex)}), 502


@app.route("/api/debug/pricelabs")
def debug_pricelabs():
    """
    Debug: probe PriceLabs API variants in parallel (5s timeout each).
    Returns raw responses for all endpoints tried.
    """
    import urllib.request, urllib.error

    api_key = os.environ.get("PRICELABS_API_KEY", "")
    if not api_key:
        api_key = load_store().get("pricelabs_api_key", "")
    if not api_key:
        return jsonify({"error": "PRICELABS_API_KEY not set in environment or store"}), 400

    key_preview = api_key[:6] + "***" + api_key[-3:]

    def hit(url, use_query_param=False):
        actual_url = url + ("?api_key=" + api_key if use_query_param else "")
        headers = {
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        }
        if not use_query_param:
            headers["X-API-Key"] = api_key
        try:
            req = urllib.request.Request(actual_url, headers=headers)
            with urllib.request.urlopen(req, timeout=5) as r:
                body = r.read().decode("utf-8")
                try:
                    data = json.loads(body)
                except Exception:
                    data = body[:2000]
                print(f"[PL DEBUG] 200 OK: {url}")
                print(json.dumps(data, indent=2, default=str)[:4000])
                return {"ok": True, "status": 200, "data": data}
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            try:
                err = json.loads(body)
            except Exception:
                err = body[:500]
            print(f"[PL DEBUG] {e.code} {url}: {body[:200]}")
            return {"ok": False, "status": e.code, "error": err}
        except Exception as ex:
            print(f"[PL DEBUG] FAIL {url}: {ex}")
            return {"ok": False, "status": "error", "error": str(ex)}

    # Run all probes in parallel so total time = max(5s) not sum
    import concurrent.futures
    probes = [
        ("https://api.pricelabs.co/v1/listings",           False),
        ("https://api.pricelabs.co/v1/listings",           True),   # query param variant
        ("https://api.pricelabs.co/v1/get_pms_listing_data", False),
        ("https://api.pricelabs.co/v2/listings",           False),
        ("https://api.pricelabs.co/v1/properties",         False),
    ]
    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
        futures = {ex.submit(hit, url, qp): url + ("?api_key=..." if qp else "") for url, qp in probes}
        for fut in concurrent.futures.as_completed(futures):
            label = futures[fut]
            results[label] = fut.result()

    return jsonify({"api_key_preview": key_preview, "results": results})


@app.route("/api/debug/pricelabs/booking-history")
def debug_pricelabs_booking_history():
    """
    Diagnostic: probe PriceLabs booking history endpoints.
    Prints the current endpoint in use, then tries all known booking-history variants.
    Returns raw responses so we can identify the correct endpoint for past reservations.
    """
    import urllib.request, urllib.error, urllib.parse

    api_key = os.environ.get("PRICELABS_API_KEY", "") or load_store().get("pricelabs_api_key", "")
    if not api_key:
        return jsonify({"error": "PRICELABS_API_KEY not set"}), 400

    # Report what we currently call (no booking data)
    current = f"GET {PRICELABS_BASE}/listings  (params: none — returns occupancy rates only, NO booking history)"
    print("=" * 70)
    print("[PL BOOKING DIAG] Currently calling:", current)
    print("[PL BOOKING DIAG] Auth: X-API-Key header")
    print("[PL BOOKING DIAG] Probing booking-history endpoints...")
    print("=" * 70)

    from_date = "2025-10-01"
    to_date   = str(datetime.date.today())

    candidates = [
        ("https://api.pricelabs.co/v2/booking_history",
         {"from_date": from_date, "to_date": to_date}),
        ("https://api.pricelabs.co/v2/booking_history",
         {"start_date": from_date, "end_date": to_date}),
        ("https://api.pricelabs.co/v2/bookings",
         {"from_date": from_date, "to_date": to_date}),
        ("https://api.pricelabs.co/v1/booking_history",
         {"from_date": from_date, "to_date": to_date}),
        ("https://api.pricelabs.co/v1/reservations",
         {"start_date": from_date, "end_date": to_date}),
        ("https://api.pricelabs.co/v2/reservations",
         {"start_date": from_date, "end_date": to_date}),
    ]

    results = {}
    for base_url, params in candidates:
        url = base_url + "?" + urllib.parse.urlencode(params)
        label = base_url.replace("https://api.pricelabs.co", "")
        print(f"[PL BOOKING DIAG] Trying: GET {url}")
        try:
            req = urllib.request.Request(url, headers={
                "X-API-Key": api_key,
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            })
            with urllib.request.urlopen(req, timeout=10) as r:
                raw = r.read().decode("utf-8")
            parsed = json.loads(raw)
            print(f"[PL BOOKING DIAG] {label} → 200 OK")
            print(json.dumps(parsed, indent=2, default=str)[:3000])
            results[label] = {"status": 200, "body": parsed}
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            print(f"[PL BOOKING DIAG] {label} → {e.code}: {body[:300]}")
            results[label] = {"status": e.code, "error": body[:300]}
        except Exception as ex:
            print(f"[PL BOOKING DIAG] {label} → error: {ex}")
            results[label] = {"error": str(ex)}

    print("=" * 70)
    return jsonify({
        "current_endpoint": current,
        "date_range_tested": f"{from_date} to {to_date}",
        "booking_history_attempts": results,
    })



def _pl_audit_probe(label, url, api_key, extra_params=None):
    """Module-level helper for PriceLabs audit probes."""
    import urllib.request, urllib.error, urllib.parse
    full_url = url
    if extra_params:
        full_url += "?" + urllib.parse.urlencode(extra_params)
    key_preview = api_key[:4] + "****" + api_key[-4:]
    print(f"\n{'='*60}")
    print(f"[PL AUDIT] {label}")
    print(f"[PL AUDIT] GET {full_url}")
    print(f"[PL AUDIT] Auth: X-API-Key {key_preview}")
    try:
        req = urllib.request.Request(full_url, headers={
            "X-API-Key":  api_key,
            "Accept":     "application/json",
            "User-Agent": "Mozilla/5.0",
        })
        with urllib.request.urlopen(req, timeout=12) as r:
            raw  = r.read().decode("utf-8")
            code = r.getcode()
        print(f"[PL AUDIT] Status: {code}")
        print(f"[PL AUDIT] Raw response:\n{raw[:5000]}")
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = raw
        # Check for booking/revenue keys
        text = json.dumps(parsed).lower() if not isinstance(parsed, str) else parsed.lower()
        booking_keys = ["payout", "guest_name", "booked_date", "confirmation_code",
                        "check_in", "check_out", "revenue", "earnings", "booking_id",
                        "reservation", "total_payout", "booking_amount"]
        found = [k for k in booking_keys if k in text]
        has_booking_data = {"found_keys": found, "verdict": bool(found)}
        return {"label": label, "url": full_url, "status": code, "body": parsed,
                "has_booking_data": has_booking_data}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"[PL AUDIT] HTTP {e.code}: {body[:600]}")
        return {"label": label, "url": full_url, "status": e.code, "error": body[:600]}
    except Exception as ex:
        print(f"[PL AUDIT] Error: {ex}")
        return {"label": label, "url": full_url, "error": str(ex)}


@app.route("/api/debug/pricelabs/reports")
def debug_pricelabs_reports():
    """
    Probe per-listing reporting endpoints with real listing IDs.
    The previous run showed /v1/listings/{id}/bookings|revenue|reservations return 400
    (not 404), meaning they exist but needed a real ID.
    """
    from datetime import date as _d
    import urllib.request, urllib.error, urllib.parse

    api_key = os.environ.get("PRICELABS_API_KEY", "") or load_store().get("pricelabs_api_key", "")
    if not api_key:
        return jsonify({"error": "PRICELABS_API_KEY not set"}), 400

    key_preview = api_key[:4] + "****" + api_key[-4:]
    from_date = "2025-01-01"
    to_date   = str(_d.today())

    # Fetch listing IDs, capture any error
    listings_fetch_error = None
    listing_ids = []
    try:
        req = urllib.request.Request(
            "https://api.pricelabs.co/v1/listings",
            headers={"X-API-Key": api_key, "Accept": "application/json",
                     "User-Agent": "Mozilla/5.0"}
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read().decode("utf-8")
        parsed = json.loads(raw)
        listing_ids = [l.get("id") for l in parsed.get("listings", []) if l.get("id")]
    except Exception as ex:
        listings_fetch_error = str(ex)

    # Fallback: hardcode IDs seen in the previous full-audit
    if not listing_ids:
        listing_ids = [
            "1523546771998151986",  # Unit 2 — lockwood
            "1523560635012518611",  # Unit 4 — lockwood
            "1540191077806734253",  # 26B — Gorge Getaway
            "1544826815980232108",  # Unit 1 — lockwood
            "1546750681335776815",  # Unit 3 — lockwood
            "1596469950428197209",  # 24B — River & Falls Retreat
            "1597959000664656537",  # 22B — Riverstone Retreat
        ]

    p_range  = {"start_date": from_date, "end_date": to_date}
    p_range2 = {"from_date":  from_date, "to_date":  to_date}

    # Focus: per-listing endpoints that returned 400 (not 404) last time — they exist
    probes = []
    for lid in listing_ids[:3]:  # test first 3 to keep response size manageable
        probes += [
            (f"{lid}/bookings",      f"https://api.pricelabs.co/v1/listings/{lid}/bookings",      p_range),
            (f"{lid}/bookings2",     f"https://api.pricelabs.co/v1/listings/{lid}/bookings",      p_range2),
            (f"{lid}/revenue",       f"https://api.pricelabs.co/v1/listings/{lid}/revenue",       p_range),
            (f"{lid}/reservations",  f"https://api.pricelabs.co/v1/listings/{lid}/reservations",  p_range),
            (f"{lid}/reservations2", f"https://api.pricelabs.co/v1/listings/{lid}/reservations",  p_range2),
            # no date params — maybe they're not required
            (f"{lid}/bookings (no dates)", f"https://api.pricelabs.co/v1/listings/{lid}/bookings", None),
            (f"{lid}/revenue (no dates)",  f"https://api.pricelabs.co/v1/listings/{lid}/revenue",  None),
        ]

    # Also try listing_prices with real ID (confirmed working pattern from /v1/listings)
    lid0 = listing_ids[0]
    probes += [
        (f"listing_prices/{lid0}",
         "https://api.pricelabs.co/v1/listing_prices",
         {"listing_id": lid0, "start_date": from_date, "end_date": to_date}),
        # Try the booking pickup endpoint seen in listings response
        ("booking_pickup",
         "https://api.pricelabs.co/v1/booking_pickup",
         {"start_date": from_date, "end_date": to_date}),
        ("booking_pickup_listing",
         f"https://api.pricelabs.co/v1/listings/{lid0}/booking_pickup",
         p_range),
    ]

    results = [_pl_audit_probe(label, url, api_key, params) for label, url, params in probes]

    hits  = [r for r in results if r.get("status") == 200]
    auth  = [r for r in results if r.get("status") in (401, 403)]
    bad   = [r for r in results if r.get("status") == 400]
    miss  = [r for r in results if r.get("status") == 404]

    return jsonify({
        "key_preview":         key_preview,
        "listing_ids_used":    listing_ids,
        "listings_fetch_error": listings_fetch_error,
        "date_range":          f"{from_date} to {to_date}",
        "hits_200":            [r["label"] for r in hits],
        "auth_errors_401_403": [f'{r["label"]} → {r["status"]}' for r in auth],
        "bad_request_400":     [{"label": r["label"], "error": r.get("error","")} for r in bad],
        "not_found_404":       [r["label"] for r in miss],
        "results":             results,
    })


@app.route("/api/debug/pricelabs/full-audit")
def debug_pricelabs_full_audit():
    """
    Comprehensive PriceLabs API audit.
    Calls every known endpoint, returns full raw responses.
    Hit this on Render to see exactly what PriceLabs gives us.
    """
    from datetime import date as _audit_date

    api_key = os.environ.get("PRICELABS_API_KEY", "") or load_store().get("pricelabs_api_key", "")
    if not api_key:
        return jsonify({"error": "PRICELABS_API_KEY not set"}), 400

    key_preview = api_key[:4] + "****" + api_key[-4:]
    from_date   = "2025-10-01"
    to_date     = str(_audit_date.today())

    # Probe list: (label, base_url, params)
    probes = [
        # ── Currently used ────────────────────────────────────────────
        ("CURRENT: /v1/listings (all listings, no date range)",
         "https://api.pricelabs.co/v1/listings", None),

        # ── Booking/reservation history candidates ────────────────────
        ("BOOKING ATTEMPT: /v2/booking_history (from/to)",
         "https://api.pricelabs.co/v2/booking_history",
         {"from_date": from_date, "to_date": to_date}),

        ("BOOKING ATTEMPT: /v2/booking_history (start/end)",
         "https://api.pricelabs.co/v2/booking_history",
         {"start_date": from_date, "end_date": to_date}),

        ("BOOKING ATTEMPT: /v2/bookings",
         "https://api.pricelabs.co/v2/bookings",
         {"start_date": from_date, "end_date": to_date}),

        ("BOOKING ATTEMPT: /v1/booking_history",
         "https://api.pricelabs.co/v1/booking_history",
         {"from_date": from_date, "to_date": to_date}),

        ("BOOKING ATTEMPT: /v1/reservations",
         "https://api.pricelabs.co/v1/reservations",
         {"start_date": from_date, "end_date": to_date}),

        ("BOOKING ATTEMPT: /v2/reservations",
         "https://api.pricelabs.co/v2/reservations",
         {"start_date": from_date, "end_date": to_date}),

        # ── Calendar / pricing data ────────────────────────────────────
        ("PRICING: /v1/listing_prices (no listing_id — expect 400)",
         "https://api.pricelabs.co/v1/listing_prices", None),
    ]

    # Sequential calls — avoids ThreadPoolExecutor pickle issues with closures
    results = [_pl_audit_probe(label, url, api_key, params) for label, url, params in probes]

    # Build clear verdict
    verdict_lines = []
    for r in results:
        st  = r.get("status", "ERR")
        hb  = r.get("has_booking_data", {})
        ok  = st == 200
        has = hb.get("verdict") if isinstance(hb, dict) else False
        tag = "✅ 200 + BOOKING DATA" if (ok and has) else \
              "✅ 200 (no booking data)" if ok else \
              f"❌ {st}"
        verdict_lines.append(f"{tag}  →  {r.get('label','?')}")
        if isinstance(hb, dict) and hb.get("found_keys"):
            verdict_lines.append(f"       booking keys found: {hb['found_keys']}")

    verdict = "\n".join(verdict_lines)
    print("\n" + "="*60)
    print("[PL AUDIT] VERDICT SUMMARY:")
    print(verdict)
    print("="*60)

    return jsonify({
        "api_key_preview": key_preview,
        "date_range_tested": f"{from_date} to {to_date}",
        "verdict_summary": verdict,
        "results": results,
    })


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

    _PROP_LABELS = {
        "lockwood":   "lockwood",
        "everton":    "everton",
        "b street":   "bstreet",
        "bstreet":    "bstreet",
        "b_street":   "bstreet",
        "pierce":     "pierce",
        "pierce ave": "pierce",
        "llc":        "llc",
        "general llc":"llc",
    }

    entries = []
    errors  = []
    for i, row in enumerate(reader, start=2):
        prop_raw  = _col(row, "property_name", "property", "prop", "listing")
        month_raw = _col(row, "month", "date", "period")
        rev_raw   = _col(row, "revenue", "gross_revenue", "gross")
        clean_raw = _col(row, "cleaning_fees", "cleaning_fee", "cleaning")
        pay_raw   = _col(row, "payout_total", "payout", "net", "total_payout", "total")

        prop_id = _PROP_LABELS.get(prop_raw.lower().strip())
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

_AIRBNB_PROP_IDS = ["airbnb", "lockwood", "everton", "bstreet"]
_PIERCE_PROP_IDS = ["pierce"]


# ── Airbnb reservation email parsing ─────────────────────────────────────────

def _parse_airbnb_email(msg_data):
    """
    Parse an Airbnb reservation confirmation email.
    Extracts: reservation_code, check_in/out, nights, nightly_rate,
    cleaning_fee, service_fee, payout_total, booking_created, guest_name.
    """
    import base64
    from email.utils import parsedate_to_datetime as _ptd

    headers  = {h["name"]: h["value"]
                for h in msg_data.get("payload", {}).get("headers", [])}
    subject  = headers.get("Subject", "")
    date_str = headers.get("Date",    "")
    msg_id   = msg_data.get("id", "")

    booking_created = None
    try:
        booking_created = _ptd(date_str).date().isoformat()
    except Exception:
        pass

    # Decode body (walk MIME tree, prefer plain text)
    body = ""
    def _walk(part):
        nonlocal body
        if part.get("mimeType") == "text/plain" and not body:
            raw = part.get("body", {}).get("data", "")
            if raw:
                body = base64.urlsafe_b64decode(raw + "==").decode("utf-8", errors="replace")
        elif part.get("mimeType") == "text/html" and not body:
            raw = part.get("body", {}).get("data", "")
            if raw:
                html = base64.urlsafe_b64decode(raw + "==").decode("utf-8", errors="replace")
                body = re.sub(r"<[^>]+>", " ", html)
                body = re.sub(r"&nbsp;", " ", body)
                body = re.sub(r"&amp;",  "&", body)
                body = re.sub(r"\s+",    " ", body).strip()
        for sub in part.get("parts", []):
            _walk(sub)
    _walk(msg_data.get("payload", {}))

    combined = subject + " " + body

    # ── Reservation code ─────────────────────────────────────────────────────
    reservation_code = None
    m = re.search(r'(?:Reservation|Confirmation)\s*(?:code|#|ID)[:\s]+([A-Z0-9]{8,14})', combined, re.I)
    if m:
        reservation_code = m.group(1)

    # ── Dates ─────────────────────────────────────────────────────────────────
    from datetime import datetime as _dtt, date as _d
    _DATE_FMTS = ["%b %d, %Y", "%B %d, %Y", "%Y-%m-%d", "%m/%d/%Y", "%d %b %Y", "%d %B %Y"]

    def _try_date(s):
        s = re.sub(r"(\d+)(st|nd|rd|th)", r"\1", s.strip())
        for fmt in _DATE_FMTS:
            try:
                return _dtt.strptime(s, fmt).date().isoformat()
            except ValueError:
                pass
        return None

    check_in = check_out = None
    m_ci = re.search(
        r'Check.?in[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{4})',
        body, re.I)
    m_co = re.search(
        r'Check.?out[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{4})',
        body, re.I)
    if m_ci: check_in  = _try_date(m_ci.group(1))
    if m_co: check_out = _try_date(m_co.group(1))

    # Fallback: subject range "Mar 15 – Mar 18, 2026"
    if not check_in:
        m_subj = re.search(
            r'([A-Za-z]+ \d{1,2})\s*[–\-]\s*([A-Za-z]+ \d{1,2}),?\s*(\d{4})', subject)
        if m_subj:
            yr = m_subj.group(3)
            check_in  = _try_date(f"{m_subj.group(1)}, {yr}")
            check_out = _try_date(f"{m_subj.group(2)}, {yr}")

    nights = None
    if check_in and check_out:
        try:
            nights = (_d.fromisoformat(check_out) - _d.fromisoformat(check_in)).days
        except Exception:
            pass
    if not nights:
        m_n = re.search(r'(\d+)\s+night', body, re.I)
        if m_n:
            nights = int(m_n.group(1))

    # ── Guest name ────────────────────────────────────────────────────────────
    guest_name = None
    m_g = re.search(r'(?:from|guest)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)', body, re.I)
    if m_g:
        guest_name = m_g.group(1).strip()

    # ── Listing name ──────────────────────────────────────────────────────────
    listing_name = None
    m_l = re.search(r'(?:listing|property|at)\s*[:\-]\s*([^\n\r]{5,80})', body, re.I)
    if m_l:
        listing_name = m_l.group(1).strip()

    # ── Property ID detection (match known keywords) ──────────────────────────
    property_id = None
    _PROP_KEYWORDS = [
        ("EVERTON STREET", "everton"),   # longer strings first to avoid partial match
        ("B STREET",       "bstreet"),
        ("LOCKWOOD",       "lockwood"),
    ]
    combined_upper = combined.upper()
    for keyword, pid in _PROP_KEYWORDS:
        if keyword in combined_upper:
            property_id = pid
            break

    def _money(pattern, text):
        m = re.search(pattern, text, re.I)
        if m:
            try:
                return float(m.group(1).replace(",", ""))
            except Exception:
                pass
        return None

    nightly_rate = (_money(r'\$\s*([\d,]+(?:\.\d{2})?)\s*[×x\*]\s*\d+\s*night', body) or
                    _money(r'Nightly rate[:\s]+\$?([\d,]+(?:\.\d{2})?)', body))
    cleaning_fee = _money(r'Cleaning fee[:\s]+\$?([\d,]+(?:\.\d{2})?)', body)
    service_fee  = _money(r'(?:Service|Airbnb)\s*fee[:\s]+\$?([\d,]+(?:\.\d{2})?)', body)
    payout_total = (_money(r'(?:You earn|Your payout|Host payout|You get|Total payout)[:\s]+\$?([\d,]+(?:\.\d{2})?)', body) or
                    _money(r'Payout[:\s]+\$?([\d,]+(?:\.\d{2})?)', body))

    return {
        "id":               msg_id,
        "reservation_code": reservation_code,
        "booking_created":  booking_created,
        "listing_name":     listing_name,
        "guest_name":       guest_name,
        "check_in":         check_in,
        "check_out":        check_out,
        "nights":           nights,
        "nightly_rate":     nightly_rate,
        "cleaning_fee":     cleaning_fee,
        "service_fee":      service_fee,
        "payout_total":     payout_total,
        "property_id":      property_id,
        "source":           "airbnb_email",
    }


def run_airbnb_reservation_sync():
    """
    Sync Airbnb reservation confirmation emails from Gmail.
    Stores results in store["airbnb_reservations"] = {msg_id: record}.
    """
    creds = _get_gmail_credentials()
    if not creds:
        return {"synced": 0, "total": 0, "error": "No Gmail credentials"}

    service      = google_build("gmail", "v1", credentials=creds)
    store        = load_store()
    reservations = store.get("airbnb_reservations", {})
    already      = len(reservations)

    q = (
        "(from:airbnb.com OR from:automated@airbnb.com OR from:noreply@airbnb.com) "
        "(subject:\"reservation confirmed\" OR subject:\"new reservation\" "
        " OR subject:\"booking confirmed\")"
    )
    try:
        results = service.users().messages().list(userId="me", q=q, maxResults=500).execute()
    except Exception as e:
        return {"synced": 0, "total": already, "error": str(e)}

    messages  = results.get("messages", [])
    new_msgs  = [m for m in messages if m["id"] not in reservations]
    new_count = 0
    for ref in new_msgs:
        mid = ref["id"]
        try:
            msg_data     = service.users().messages().get(userId="me", id=mid, format="full").execute()
            parsed       = _parse_airbnb_email(msg_data)
            reservations[mid] = parsed
            new_count += 1
            # Auto-assign revenue to property_income if property and payout are known
            if parsed.get("property_id") and parsed.get("payout_total") and parsed.get("check_in"):
                month_key  = parsed["check_in"][:7]
                pi         = store.setdefault("property_income", {})
                prop_months = pi.setdefault(parsed["property_id"], {})
                entry      = prop_months.get(month_key, {"revenue": 0.0, "source": "airbnb_email", "count": 0})
                entry["revenue"] = round((entry.get("revenue") or 0.0) + parsed["payout_total"], 2)
                entry["count"]   = entry.get("count", 0) + 1
                entry["source"]  = "airbnb_email"
                prop_months[month_key] = entry
                print(f"  ✅ Auto-assigned ${parsed['payout_total']} → {parsed['property_id']} {month_key}")
        except Exception as e:
            print(f"  ⚠️  Airbnb reservation parse error {mid}: {e}")

    store["airbnb_reservations"] = reservations
    save_store(store)
    return {"synced": new_count, "total": len(reservations)}


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
            print(f"PriceLabs extended analytics error for {prop_id}: {pl_err}")

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

@app.route("/api/reservations/sync", methods=["POST"])
def reservations_sync_route():
    """Sync Airbnb reservation confirmation emails from Gmail."""
    return jsonify(run_airbnb_reservation_sync())


@app.route("/api/reservations", methods=["GET"])
def get_reservations():
    """Return all synced Airbnb reservation records."""
    store = load_store()
    rsvs  = store.get("airbnb_reservations", {})
    return jsonify({"reservations": list(rsvs.values()), "total": len(rsvs)})


@app.route("/api/analytics/listing/<prop_id>/extended")
def analytics_listing_extended(prop_id):
    """Extended per-listing analytics: revenue, PriceLabs comparison, insight cards."""
    store  = load_store()
    events = store.get("ical_events", [])
    start, end = _analytics_range(request)
    return jsonify(_compute_extended_analytics(events, store, prop_id, start, end))


@app.route("/api/analytics/portfolio/extended")
def analytics_portfolio_extended():
    """Extended portfolio analytics across all STR listings."""
    store  = load_store()
    events = store.get("ical_events", [])
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

    def _month_financials(month_key):
        airbnb_rev     = 0.0
        airbnb_tx_ids  = []
        pierce_rev     = 0.0
        pierce_tx_ids  = []
        expenses       = 0.0
        expense_tx_ids = []
        expense_by_prop= {}
        revenue_by_prop= {}

        for tx_id, tx in txs_dict.items():
            if (tx.get("date") or "")[:7] != month_key:
                continue
            if tx.get("pending"):
                continue
            prop_id = tags.get(tx_id)
            if not prop_id or prop_id in ("deleted", "transfer"):
                continue
            amount  = abs(tx.get("amount", 0))
            tx_type = tx.get("type", "out")

            if tx_type == "in":
                if prop_id in _AIRBNB_PROP_IDS:
                    # Only include Plaid if no manual override for this month
                    if month_key not in manual:
                        airbnb_rev    += amount
                        airbnb_tx_ids.append(tx_id)
                        revenue_by_prop[prop_id] = revenue_by_prop.get(prop_id, 0.0) + amount
                elif prop_id in _PIERCE_PROP_IDS:
                    pierce_rev    += amount
                    pierce_tx_ids.append(tx_id)
                    revenue_by_prop[prop_id] = revenue_by_prop.get(prop_id, 0.0) + amount
            else:
                expenses += amount
                expense_tx_ids.append(tx_id)
                expense_by_prop[prop_id] = expense_by_prop.get(prop_id, 0.0) + amount

        # Manual income overrides Plaid Airbnb revenue for this month
        is_manual = False
        if month_key in manual and manual[month_key]:
            airbnb_rev    = float(manual[month_key])
            airbnb_tx_ids = []
            is_manual     = True
            # Clear Plaid-sourced revenue for Airbnb properties (manual replaces them)
            for apid in _AIRBNB_PROP_IDS:
                revenue_by_prop.pop(apid, None)

        # Per-property income supplements if no manual_income entry
        if month_key not in manual:
            for pid, months in prop_inc.items():
                if month_key in months:
                    pi = months[month_key]
                    payout = float(pi.get("payout_total") or 0)
                    if pid in _AIRBNB_PROP_IDS:
                        airbnb_rev += payout
                    elif pid in _PIERCE_PROP_IDS:
                        pierce_rev += payout
                    if payout:
                        revenue_by_prop[pid] = revenue_by_prop.get(pid, 0.0) + payout

        total_rev = round(airbnb_rev + pierce_rev, 2)
        total_exp = round(expenses, 2)
        return {
            "total_revenue":  total_rev,
            "total_expenses": total_exp,
            "net_income":     round(total_rev - total_exp, 2),
            "airbnb": {
                "revenue":   round(airbnb_rev, 2),
                "tx_ids":    airbnb_tx_ids,
                "is_manual": is_manual,
            },
            "pierce": {
                "revenue":   round(pierce_rev, 2),
                "tx_ids":    pierce_tx_ids,
            },
            "expenses": {
                "total":       total_exp,
                "by_property": {k: round(v, 2) for k, v in expense_by_prop.items()},
                "tx_ids":      expense_tx_ids,
            },
            "revenue": {
                "by_property": {k: round(v, 2) for k, v in revenue_by_prop.items()},
            },
        }

    def _safe_pct(cur_val, prev_val):
        """Return % change only when prior month is non-zero (no fabricated comparisons)."""
        if not prev_val:
            return None
        return round(((cur_val - prev_val) / prev_val) * 100, 1)

    cur  = _month_financials(month_str)
    prev = _month_financials(prev_str)

    has_prior = prev["total_revenue"] > 0 or prev["total_expenses"] > 0

    return jsonify({
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
    })


# ── Property configuration ────────────────────────────────────────────────────
# Defines primary (Airbnb STR) vs secondary ("Other Properties") groupings.
# Drives the app restructure: Airbnb is the main focus; Pierce is secondary.

_DEFAULT_PROP_CONFIG = {
    "primary_group": {
        "id":          "airbnb",
        "label":       "Airbnb Portfolio",
        "prop_ids":    ["lockwood", "everton", "bstreet"],
        "description": "Short-term rental properties — main app focus",
    },
    "secondary_groups": [
        {
            "id":          "other",
            "label":       "Other Properties",
            "prop_ids":    ["pierce"],
            "description": "Section 8 / long-term rentals",
        },
        {
            "id":          "llc",
            "label":       "General LLC",
            "prop_ids":    ["llc"],
            "description": "LLC-level expenses not tied to a specific property",
        },
    ],
    "excluded_from_analytics": ["transfer", "deleted"],
}


@app.route("/api/properties/config", methods=["GET"])
def get_properties_config():
    """Return property grouping: primary (Airbnb STR) and secondary (Other)."""
    store  = load_store()
    config = store.get("properties_config") or _DEFAULT_PROP_CONFIG
    return jsonify(config)


@app.route("/api/properties/config", methods=["POST"])
def save_properties_config():
    """Update property grouping configuration."""
    body   = request.json or {}
    store  = load_store()
    config = store.get("properties_config") or dict(_DEFAULT_PROP_CONFIG)
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
            "financial": True, "milestones": True
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
    for email, u in users.items():
        if u["id"] == uid:
            code = u.get("follow_code", "")
            if not code:
                code = "PPG-" + secrets.token_hex(3).upper()
                u["follow_code"] = code
                save_users(users)
            return jsonify({"follow_code": code})
    return jsonify({"ok": False, "error": "User not found"}), 404

@app.route("/api/follow/request", methods=["POST"])
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
        if username and u.get("username", "").lower() == username:
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
    follower_role = "owner"
    for email, u in users.items():
        if u["id"] == uid:
            follower_role = u.get("role", "owner")
            break

    follow_type = "cleaner" if follower_role == "cleaner" else "investor"

    follow_id = "f_" + secrets.token_hex(6)
    follows[follow_id] = {
        "follower_id": uid,
        "following_id": target_id,
        "type": follow_type,
        "status": "approved",  # auto-approve for now
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
    _send_push(tokens, "New Follower", f"{follower_name} started following you")
    _store_notification(target_id, "follow", "New Follower", f"{follower_name} started following you")

    return jsonify({"ok": True, "follow_id": follow_id, "status": "approved"})

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
                    except:
                        pass
                    break
            result.append({
                "id": fid, "user_id": f["following_id"], "username": name, "role": role,
                "type": f["type"], "property_count": prop_count,
                "selected_properties": f.get("selected_properties", []),
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

# ── User search + profile endpoints ──────────────────────────
@app.route("/api/users/search", methods=["GET"])
def users_search():
    q = (request.args.get("q", "") or "").strip().lower()
    if len(q) < 2:
        return jsonify({"users": []})
    users = load_users()
    results = []
    for email, u in users.items():
        uname = u.get("username", "").lower()
        if q in uname or q in email.lower():
            results.append({
                "user_id": u["id"],
                "username": u.get("username", email.split("@")[0]),
                "role": u.get("role", "owner"),
            })
    return jsonify({"users": results[:20]})

@app.route("/api/users/profile/<user_id>", methods=["GET"])
def users_profile(user_id):
    users = load_users()
    for email, u in users.items():
        if u["id"] == user_id:
            prop_count = 0
            try:
                s = _load_store_for_user(user_id)
                prop_count = len(s.get("properties", []))
            except:
                pass
            return jsonify({
                "user_id": u["id"],
                "username": u.get("username", email.split("@")[0]),
                "role": u.get("role", "owner"),
                "property_count": prop_count,
                "follow_code": u.get("follow_code", ""),
            })
    return jsonify({"ok": False, "error": "User not found"}), 404

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
        # Get username
        uname = ""
        for email, u in users.items():
            if u["id"] == fuid:
                uname = u.get("username", email.split("@")[0])
                break

        # Get their notifications (milestones, financial)
        notifs = _load_json_file(NOTIFICATIONS_FILE)
        user_notifs = notifs.get(fuid, [])
        for n in user_notifs[:10]:
            if n.get("type") in ("milestone", "financial", "property_added"):
                feed.append({
                    "id": n["id"],
                    "user_id": fuid,
                    "username": uname,
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

        # Load owner's ical events
        try:
            owner_store = _load_store_for_user(owner_id)
            owner_events = owner_store.get("ical_events", [])
            owner_props = owner_store.get("properties", [])
            prop_labels = {p.get("id", ""): p.get("label", p.get("id", "")) for p in owner_props}

            for ev in owner_events:
                prop_id = ev.get("prop_id", "")
                if selected_props and prop_id not in selected_props:
                    continue
                events.append({
                    "check_in": ev.get("check_in") or ev.get("start", ""),
                    "check_out": ev.get("check_out") or ev.get("end", ""),
                    "prop_id": prop_id,
                    "prop_name": prop_labels.get(prop_id, prop_id),
                    "owner": owner_name,
                    "owner_id": owner_id,
                    "uid": ev.get("uid", ""),
                })
        except Exception as e:
            print(f"Error loading schedule for owner {owner_id}: {e}")

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
        return jsonify({"properties": [{"id": p.get("id",""), "label": p.get("label", p.get("id",""))} for p in props]})
    except:
        return jsonify({"properties": []})


# ── Daily sync scheduler ──────────────────────────────────────
def scheduled_sync():
    print("⏰ Scheduled daily sync starting...")
    try:
        result = run_sync()
        print(f"✅ Scheduled sync complete — {result.get('total_stored', 0)} transactions stored")
    except Exception as e:
        print(f"❌ Scheduled sync failed: {e}")

scheduler = BackgroundScheduler(daemon=True)
# Plaid fallback sync every 6 hours
scheduler.add_job(scheduled_sync, IntervalTrigger(hours=6), id="periodic_sync", replace_existing=True)
def _bg_ical_sync():
    store = load_store()
    new_events = _sync_ical(store)
    existing = {e["uid"]: e for e in store.get("ical_events", [])}
    for e in new_events:
        existing[e["uid"]] = e
    store["ical_events"] = list(existing.values())
    save_store(store)
    print(f"iCal bg sync done — {len(store['ical_events'])} total events stored")

scheduler.add_job(_bg_ical_sync, IntervalTrigger(hours=6), id='ical_sync', replace_existing=True)
scheduler.start()
print("⏰ Scheduler started: Plaid + Gmail syncs every 6 hours")

# ── Startup sync ──────────────────────────────────────────────────────────

def startup_sync():
    _time.sleep(4)  # let gunicorn fully start before hitting Plaid
    store    = load_store()
    accounts = store.get("accounts", [])
    tx_count = len(store.get("transactions", {}))
    if not accounts:
        print("🚀 Startup: no accounts linked — skipping sync")
        return
    print(f"🚀 Startup: {len(accounts)} account(s) linked, {tx_count} transactions cached — syncing…")
    try:
        result = run_sync()
        print(f"✅ Startup sync done: {result.get('total', 0)} new, "
              f"{result.get('total_stored', 0)} total stored")
    except Exception as e:
        print(f"❌ Startup sync failed: {e}")

threading.Thread(target=startup_sync, daemon=True).start()
print("🚀 Startup sync scheduled (runs in background after 4s)")


def startup_pl_ical():
    """
    On startup: refresh PriceLabs listings (canonical names + occupancy)
    then immediately re-sync iCal so events get tagged with feed_key.
    Runs in background 8s after boot so gunicorn is fully up first.
    """
    _time.sleep(8)
    api_key = os.environ.get("PRICELABS_API_KEY", "")
    store   = load_store()
    if not api_key:
        api_key = store.get("pricelabs_api_key", "")

    if api_key:
        try:
            data = _pricelabs_get("/listings")
            listings = data.get("listings") or data.get("data") or (data if isinstance(data, list) else [])
            mapping  = store.get("pricelabs_mapping", {})
            rev      = {str(v): k for k, v in mapping.items()}
            result, name_by_plid, name_by_prop = [], {}, {}
            for l in listings:
                lid      = str(l.get("id") or "")
                raw_name = (l.get("name") or lid).strip()
                short, full = _pl_parse_name(raw_name)
                city   = (l.get("city_name") or "").lower().strip()
                pid    = rev.get(lid) or _PL_CITY_TO_PROP.get(city) or _pl_prop_from_name(raw_name)
                canonical = _pl_canonical_short(short, pid) if pid else short
                name_by_plid[lid] = canonical
                if pid:
                    name_by_prop.setdefault(pid, []).append(canonical)
                result.append({
                    "id": lid, "short_label": short, "name": full,
                    "city": l.get("city_name",""), "state": l.get("state",""),
                    "bedrooms": l.get("no_of_bedrooms"), "pms": l.get("pms"),
                    "base_price": l.get("base"), "recommended_base": l.get("recommended_base_price"),
                    "min_price": l.get("min"), "cleaning_fee": l.get("cleaning_fees"),
                    "occ_next_30": l.get("occupancy_next_30"), "occ_next_60": l.get("occupancy_next_60"),
                    "occ_past_30": l.get("occupancy_past_30"), "occ_past_60": l.get("occupancy_past_60"),
                    "market_occ_next_30": l.get("market_occupancy_next_30"),
                    "market_occ_past_30": l.get("market_occupancy_past_30"),
                    "booking_pickup_60": l.get("booking_pickup_past_60"),
                    "push_enabled": l.get("push_enabled"), "last_pushed": l.get("last_date_pushed"),
                    "canonical_name": canonical, "prop_id": pid,
                })
            def _sk(r):
                m = re.search(r'\d+', r.get("canonical_name",""))
                return (r.get("prop_id",""), int(m.group()) if m else 999)
            result.sort(key=_sk)
            flat_names = {p: ", ".join(sorted(ns, key=lambda n: int(re.search(r'\d+',n).group()) if re.search(r'\d+',n) else 999))
                          for p, ns in name_by_prop.items()}
            store["pricelabs_listing_names"]       = flat_names
            store["pricelabs_listing_names_by_id"] = name_by_plid
            store["pricelabs_short_names"]         = name_by_plid
            store["pricelabs_listings_raw"]        = result
            save_store(store)
            print(f"🏷️  Startup PriceLabs refresh: {len(result)} listings, canonical names stored")
        except Exception as e:
            print(f"⚠️  Startup PriceLabs refresh failed (non-fatal): {e}")
    else:
        print("ℹ️  No PriceLabs API key — skipping startup PL refresh")

    # Always re-sync iCal so events get tagged with feed_key
    try:
        store   = load_store()
        new_evs = _sync_ical(store)
        existing = {e["uid"]: e for e in store.get("ical_events", [])}
        for e in new_evs:
            existing[e["uid"]] = e
        store["ical_events"] = list(existing.values())
        save_store(store)
        print(f"📅 Startup iCal re-sync: {len(store['ical_events'])} total events (feed_key tagged)")
    except Exception as e:
        print(f"⚠️  Startup iCal sync failed: {e}")


threading.Thread(target=startup_pl_ical, daemon=True).start()
print("🔄 Startup PriceLabs+iCal refresh scheduled (8s)")

# ── /cleaner — Public turnover page for cleaning crew ─────────────────────────

_CLEANER_FEEDS = [
    {"name": "Lockwood 1", "url": "https://www.airbnb.com/calendar/ical/1544826815980232108.ics?t=7f3a5a6f869048e985e7b1a5a6f84ee0&locale=en"},
    {"name": "Lockwood 2", "url": "https://www.airbnb.com/calendar/ical/1523546771998151986.ics?t=72b2cf50c3cc42aeb1a5ecdb783604a6&locale=en"},
    {"name": "Lockwood 3", "url": "https://www.airbnb.com/calendar/ical/1546750681335776815.ics?t=40fde5a666ed4ab8a0a9cc40b2d73caa&locale=en"},
    {"name": "Lockwood 4", "url": "https://www.airbnb.com/calendar/ical/1523560635012518611.ics?t=0d9e5ac5e6fd4099ba53e1dc6bc18e8a&locale=en"},
]
_CLEANER_CACHE = {"data": None, "ts": 0}
_CLEANER_LOCK  = threading.Lock()
_CLEANER_TTL   = 1800  # 30 minutes


def _get_cleaner_feeds():
    """Return active feeds from store, falling back to hardcoded defaults."""
    try:
        stored = load_store().get("cleaner_feeds")
        if stored and isinstance(stored, list) and len(stored) > 0:
            return stored
    except Exception:
        pass
    return _CLEANER_FEEDS   # first-run default


def _fetch_cleaner_data():
    """Fetch & parse all cleaner iCal feeds. Returns list of checkout/checkin events."""
    import urllib.request
    from datetime import date, timedelta
    events_out = []
    today_d = date.today()
    cutoff  = today_d + timedelta(days=60)
    for feed in _get_cleaner_feeds():
        try:
            req = urllib.request.Request(
                feed["url"], headers={"User-Agent": "PropertyPigeon/1.0"})
            with urllib.request.urlopen(req, timeout=15) as r:
                ics_text = r.read().decode("utf-8", errors="replace")
            bookings = _parse_ics(ics_text, prop_id="cleaner", feed_key="")
            for b in bookings:
                summary = (b.get("summary") or "").strip()
                # Skip blocked / unavailable calendar entries
                if re.match(r'^(airbnb|not available|unavailable|blocked)', summary, re.I):
                    continue
                try:
                    ci_d = date.fromisoformat(b["start"])
                    co_d = date.fromisoformat(b["end"])
                except Exception:
                    continue
                guest  = (b.get("guest_name") or "").strip()
                nights = b.get("nights", 0)
                # Checkout event on DTEND date (day guest leaves)
                if today_d <= co_d <= cutoff:
                    events_out.append({
                        "type": "checkout", "date": b["end"],
                        "unit": feed["name"], "guest_name": guest,
                        "nights": nights, "time": "10:00 AM",
                    })
                # Check-in event on DTSTART date (day guest arrives)
                if today_d <= ci_d <= cutoff:
                    events_out.append({
                        "type": "checkin", "date": b["start"],
                        "unit": feed["name"], "guest_name": guest,
                        "nights": nights, "time": "3:00 PM",
                    })
        except Exception as e:
            print(f"⚠️  Cleaner iCal fetch failed for {feed['name']}: {e}")
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
        if name and url:
            clean.append({"name": name, "url": url})
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
        print(f"Failed to save ratings: {e}")


@app.route("/api/cleaner/rate", methods=["POST"])
def rate_cleaner():
    """Host rates a cleaner 1-5. Requires >= 10 cleanings with that cleaner."""
    uid = getattr(g, "user_id", None)
    if not uid:
        return jsonify({"error": "Authentication required"}), 401
    body = request.get_json(force=True) or {}
    cleaner_id = body.get("cleaner_id", "")
    rating = body.get("rating")
    if not cleaner_id or not isinstance(rating, (int, float)) or rating < 1 or rating > 5:
        return jsonify({"error": "cleaner_id and rating (1-5) required"}), 400
    rating = round(rating)

    # Check minimum cleanings threshold (10)
    store = load_store()
    schedule = store.get("cleaner_schedule", [])
    cleaning_count = sum(
        1 for ev in schedule
        if ev.get("cleaner_id") == cleaner_id
        and ev.get("check_out", "") <= _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime())
    )
    if cleaning_count < 10:
        return jsonify({
            "error": f"You need at least 10 completed cleanings to rate this cleaner ({cleaning_count}/10)",
            "cleaning_count": cleaning_count,
        }), 403

    # Store rating anonymously
    ratings = _load_ratings()
    if cleaner_id not in ratings:
        ratings[cleaner_id] = {"reviews": [], "pending_notifications": []}
    # Prevent duplicate ratings from same host
    existing = next((r for r in ratings[cleaner_id]["reviews"] if r.get("host_id") == uid), None)
    if existing:
        existing["rating"] = rating
        existing["updated_at"] = _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime())
    else:
        ratings[cleaner_id]["reviews"].append({
            "host_id": uid,
            "rating": rating,
            "created_at": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()),
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


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)

"""Food Surplus Matcher - Flask + SQLite + Server-Sent Events."""
import json, math, os, queue, secrets, sqlite3, threading, time
from datetime import datetime, timezone, timedelta
from functools import wraps
from flask import Flask, g, jsonify, request, Response, send_from_directory
from itsdangerous import URLSafeTimedSerializer, BadSignature
from werkzeug.security import generate_password_hash, check_password_hash

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE, "data.db")
KEY_FILE = os.path.join(BASE, ".secret")
if not os.path.exists(KEY_FILE):
    open(KEY_FILE, "w").write(secrets.token_hex(32))
signer = URLSafeTimedSerializer(os.environ.get("SECRET_KEY") or open(KEY_FILE).read())
app = Flask(__name__, static_folder="static", static_url_path="")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN('donor','volunteer')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS listings(id INTEGER PRIMARY KEY AUTOINCREMENT, donor_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, diet TEXT NOT NULL CHECK(diet IN('veg','non-veg','packaged')), quantity INTEGER NOT NULL,
  address TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, created_at TEXT NOT NULL, safe_until TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN('available','claimed','collected','expired')),
  claimed_by INTEGER REFERENCES users(id), claimed_at TEXT, collected_at TEXT, code TEXT);
CREATE INDEX IF NOT EXISTS idx_status_safe ON listings(status, safe_until);
CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY AUTOINCREMENT, requester_id INTEGER NOT NULL REFERENCES users(id), meals INTEGER NOT NULL, address TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, note TEXT, needed_by TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL);
"""

def now(): return datetime.now(timezone.utc)
def iso(d): return d.isoformat()

def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH, timeout=10)
        g.db.row_factory = sqlite3.Row
    return g.db

@app.teardown_appcontext
def close_db(_):
    if "db" in g: g.pop("db").close()

EXTRA = """
CREATE TABLE IF NOT EXISTS ratings(id INTEGER PRIMARY KEY AUTOINCREMENT, listing_id INTEGER NOT NULL, rater_id INTEGER NOT NULL, ratee_id INTEGER NOT NULL, stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5), UNIQUE(listing_id, rater_id));
CREATE TABLE IF NOT EXISTS recurring(id INTEGER PRIMARY KEY AUTOINCREMENT, donor_id INTEGER NOT NULL, title TEXT, diet TEXT, quantity INTEGER, address TEXT, lat REAL, lng REAL, days TEXT, at_time TEXT, hours REAL, last_date TEXT);
"""

with sqlite3.connect(DB_PATH) as c:
    c.executescript(SCHEMA); c.execute("PRAGMA journal_mode=WAL")
    c.executescript(EXTRA)
    for ddl in ("ALTER TABLE listings ADD COLUMN code TEXT", "ALTER TABLE listings ADD COLUMN photo TEXT", "ALTER TABLE listings ADD COLUMN available_from TEXT",
                "ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0", "ALTER TABLE users ADD COLUMN verified INTEGER DEFAULT 0"):  # migrate older databases
        try: c.execute(ddl)
        except sqlite3.OperationalError: pass

# ---------- realtime (SSE) ----------
clients, clients_lock = [], threading.Lock()
def broadcast(event="changed", data=None):
    msg = f"event: {event}\ndata: {json.dumps(data or {})}\n\n"
    with clients_lock:
        for q in clients[:]:
            try: q.put_nowait(msg)
            except queue.Full: clients.remove(q)

@app.get("/api/stream")
def stream():
    q = queue.Queue(maxsize=50)
    with clients_lock: clients.append(q)
    def gen():
        try:
            yield "retry: 3000\n\n"
            while True:
                try: yield q.get(timeout=20)
                except queue.Empty: yield ": ping\n\n"
        finally:
            with clients_lock:
                if q in clients: clients.remove(q)
    return Response(gen(), mimetype="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

# ---------- auth ----------
hits = {}
def rate_limit(n=10, per=60):
    def deco(f):
        @wraps(f)
        def w(*a, **k):
            key, t = (request.remote_addr, f.__name__), time.time()
            hits[key] = [x for x in hits.get(key, []) if t - x < per]
            if len(hits[key]) >= n: return jsonify(error="Too many attempts. Wait a minute and try again."), 429
            hits[key].append(t); return f(*a, **k)
        return w
    return deco

def auth(role=None):
    def deco(f):
        @wraps(f)
        def w(*a, **k):
            try: g.user = signer.loads(request.headers.get("Authorization", "").replace("Bearer ", ""), max_age=7 * 86400)
            except BadSignature: return jsonify(error="Please log in"), 401
            if role and g.user["role"] != role: return jsonify(error=f"Only {role}s can do this"), 403
            return f(*a, **k)
        return w
    return deco

def session(u):
    user = {"id": u["id"], "name": u["name"], "role": u["role"], "admin": bool(u["is_admin"])}
    return jsonify(token=signer.dumps(user), user=user)

@app.post("/api/auth/register")
@rate_limit()
def register():
    d = request.get_json(force=True, silent=True) or {}
    name, email, pw, role = (d.get(k, "").strip() for k in ("name", "email", "password", "role"))
    if not (name and "@" in email and role in ("donor", "volunteer")): return jsonify(error="Enter your name, a valid email and a role"), 400
    if len(pw) < 6: return jsonify(error="Password needs at least 6 characters"), 400
    try:
        cur = db().execute("INSERT INTO users(name,email,password,role) VALUES(?,?,?,?)", (name, email.lower(), generate_password_hash(pw), role))
        db().commit()
    except sqlite3.IntegrityError: return jsonify(error="That email is already registered"), 409
    adm = int(email.lower() == os.environ.get("ADMIN_EMAIL", "").lower() or db().execute("SELECT COUNT(*) FROM users").fetchone()[0] == 1)  # first account (or ADMIN_EMAIL) is admin
    if adm: db().execute("UPDATE users SET is_admin=1 WHERE id=?", (cur.lastrowid,)); db().commit()
    return session({"id": cur.lastrowid, "name": name, "role": role, "is_admin": adm})

@app.post("/api/auth/login")
@rate_limit()
def login():
    d = request.get_json(force=True, silent=True) or {}
    u = db().execute("SELECT * FROM users WHERE email=?", (d.get("email", "").lower(),)).fetchone()
    if not u or not check_password_hash(u["password"], d.get("password", "")): return jsonify(error="Wrong email or password"), 401
    return session(u)

# ---------- matching engine ----------
def km(a, b, c, d):
    r = math.radians
    h = math.sin(r(c - a) / 2) ** 2 + math.cos(r(a)) * math.cos(r(c)) * math.sin(r(d - b) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))

def enrich(r, lat=None, lng=None, radius=15):
    """Match score 0-100: urgency 40% + proximity 35% + batch size 25%.
    If the volunteer can't arrive before the food expires (ETA at ~22 km/h + 10 min handover), the score is cut 70%."""
    row = dict(r); row.pop("code", None)  # handover code is never public
    left = (datetime.fromisoformat(r["safe_until"]) - now()).total_seconds() / 60
    window = (datetime.fromisoformat(r["safe_until"]) - datetime.fromisoformat(r["available_from"] or r["created_at"])).total_seconds() / 60
    row["mins_left"], row["window_mins"] = max(0, round(left)), max(1, round(window))
    row["starts_in"] = max(0, round((datetime.fromisoformat(r["available_from"]) - now()).total_seconds() / 60)) if r["available_from"] else 0
    if lat is not None:
        d = km(lat, lng, r["lat"], r["lng"]); eta = d / 22 * 60 + 10
        reachable = eta < left * 0.9
        s = 0.4 * max(0, 1 - left / 240) + 0.35 * max(0, 1 - d / radius) + 0.25 * min(r["quantity"] / 50, 1)
        row.update(distance_km=round(d, 1), eta_mins=round(eta), reachable=reachable, score=round(100 * s * (1 if reachable else 0.3)))
    return row

@app.get("/api/listings")
def listings():
    a = request.args
    lat, lng = a.get("lat", type=float), a.get("lng", type=float)
    radius = a.get("radius", 15, type=float)
    up, t = a.get("when") == "upcoming", iso(now())
    sql, args = "SELECT l.*, u.name donor_name, u.verified donor_verified, (SELECT ROUND(AVG(stars),1) FROM ratings WHERE ratee_id=l.donor_id) donor_rating FROM listings l JOIN users u ON u.id=l.donor_id WHERE l.status='available' AND l.safe_until>? AND " + ("l.available_from>?" if up else "(l.available_from IS NULL OR l.available_from<=?)"), [t, t]
    if a.get("diet") in ("veg", "non-veg", "packaged"): sql += " AND l.diet=?"; args.append(a["diet"])
    rows = [enrich(r, lat, lng, radius) for r in db().execute(sql, args)]
    if lat is not None: rows = [r for r in rows if r["distance_km"] <= radius]
    key = {"urgency": lambda r: r["mins_left"], "distance": lambda r: r.get("distance_km", 0)}.get(a.get("sort"), lambda r: -r.get("score", 0))
    return jsonify(sorted(rows, key=key))

def validate_listing(d):
    try:
        qty, lat, lng = int(d["quantity"]), float(d["lat"]), float(d["lng"])
        until = datetime.fromisoformat(d["safe_until"].replace("Z", "+00:00"))
        if until.tzinfo is None: until = until.astimezone()
    except (KeyError, ValueError, TypeError): return None, "Fill in every field and pick a pickup point on the map"
    if not (d.get("title", "").strip() and d.get("address", "").strip()): return None, "Add a title and pickup address"
    if d.get("diet") not in ("veg", "non-veg", "packaged"): return None, "Choose a food type"
    if not d.get("safety_confirmed"): return None, "Confirm the food is fresh and safely stored"
    if not 1 <= qty <= 5000: return None, "Meals must be between 1 and 5000"
    start, sched = now(), False
    if d.get("ready_from"):  # scheduled / event surplus
        try: start = datetime.fromisoformat(d["ready_from"].replace("Z", "+00:00"))
        except ValueError: return None, "Check the ready time"
        if start.tzinfo is None: start = start.astimezone()
        if start > now() + timedelta(days=7): return None, "Scheduled listings can be at most 7 days ahead"
        sched = start > now(); start = start if sched else now()
    if until <= start: return None, "'Safe until' must be after the food is ready"
    if until > start + timedelta(hours=12): return None, "Cooked food can't be listed for more than 12 hours"
    photo = d.get("photo") or None
    if photo and not (photo.startswith("data:image/jpeg;base64,") and len(photo) < 300000): return None, "Photo must be a small JPEG"
    return (d["title"].strip()[:80], d["diet"], qty, d["address"].strip()[:200], lat, lng, iso(now()), iso(until.astimezone(timezone.utc)), photo, iso(start.astimezone(timezone.utc)) if sched else None), None

@app.post("/api/listings")
@auth("donor")
def create_listing():
    vals, err = validate_listing(request.get_json(force=True, silent=True) or {})
    if err: return jsonify(error=err), 400
    cur = db().execute("INSERT INTO listings(donor_id,title,diet,quantity,address,lat,lng,created_at,safe_until,photo,available_from) VALUES(?,?,?,?,?,?,?,?,?,?,?)", (g.user["id"], *vals))
    db().commit(); broadcast("new", {"title": vals[0], "quantity": vals[2], "lat": vals[4], "lng": vals[5]})
    rpt = (request.get_json(silent=True) or {}).get("repeat")  # repeating donor, e.g. a hostel mess
    if rpt in ("daily", "weekdays", "weekends"):
        st = datetime.fromisoformat(vals[9]) if vals[9] else now()
        db().execute("INSERT INTO recurring(donor_id,title,diet,quantity,address,lat,lng,days,at_time,hours,last_date) VALUES(?,?,?,?,?,?,?,?,?,?,?)", (g.user["id"], vals[0], vals[1], vals[2], vals[3], vals[4], vals[5], rpt, st.astimezone().strftime("%H:%M"), round((datetime.fromisoformat(vals[7]) - st).total_seconds() / 3600, 1), datetime.now().date().isoformat())); db().commit()
    n = sum(1 for q in open_requests() if km(vals[4], vals[5], q["lat"], q["lng"]) <= 10)  # auto-match against open requests
    return jsonify(id=cur.lastrowid, matched=n), 201

def transition(sql, args, err):
    cur = db().execute(sql, args); db().commit()
    if cur.rowcount == 0: return jsonify(error=err), 409
    broadcast(); return jsonify(ok=True)

@app.post("/api/listings/<int:i>/claim")  # atomic: WHERE clause makes double-claims impossible
@auth("volunteer")
def claim(i):
    t = iso(now())
    qty = (request.get_json(silent=True) or {}).get("qty")
    l = db().execute("SELECT * FROM listings WHERE id=? AND status='available' AND safe_until>?", (i, t)).fetchone()
    if l and isinstance(qty, int) and qty > l["quantity"]: return jsonify(error=f"Only {l['quantity']} meals left"), 400
    if l and isinstance(qty, int) and 0 < qty < l["quantity"]:  # split batch: parent stays available, a claimed child listing is created
        if db().execute("UPDATE listings SET quantity=quantity-? WHERE id=? AND status='available' AND quantity>? AND safe_until>?", (qty, i, qty, t)).rowcount:
            db().execute("INSERT INTO listings(donor_id,title,diet,quantity,address,lat,lng,created_at,safe_until,photo,available_from,status,claimed_by,claimed_at,code) VALUES(?,?,?,?,?,?,?,?,?,?,?,'claimed',?,?,?)",
                (l["donor_id"], l["title"], l["diet"], qty, l["address"], l["lat"], l["lng"], l["created_at"], l["safe_until"], l["photo"], l["available_from"], g.user["id"], t, f"{secrets.randbelow(10000):04d}"))
            db().commit(); broadcast(); return jsonify(ok=True)
        return jsonify(error="Someone else claimed this first"), 409
    return transition("UPDATE listings SET status='claimed',claimed_by=?,claimed_at=?,code=? WHERE id=? AND status='available' AND safe_until>?", (g.user["id"], t, f"{secrets.randbelow(10000):04d}", i, t), "Someone else claimed this first, or it expired")

@app.post("/api/listings/<int:i>/release")
@auth("volunteer")
def release(i):
    return transition("UPDATE listings SET status='available',claimed_by=NULL,claimed_at=NULL,code=NULL WHERE id=? AND claimed_by=? AND status='claimed' AND safe_until>?", (i, g.user["id"], iso(now())), "This claim can't be released")

@app.post("/api/listings/<int:i>/collect")  # donor confirms by typing the code the volunteer shows at pickup
@auth("donor")
def collect(i):
    code = str((request.get_json(force=True, silent=True) or {}).get("code", "")).strip()
    return transition("UPDATE listings SET status='collected',collected_at=? WHERE id=? AND status='claimed' AND donor_id=? AND code=?", (iso(now()), i, g.user["id"], code), "Wrong handover code. Ask the volunteer to show it again")

@app.get("/api/me/activity")
@auth()
def activity():
    col = "donor_id" if g.user["role"] == "donor" else "claimed_by"
    rows = db().execute(f"SELECT l.*, u.name donor_name, u.verified donor_verified, v.name volunteer_name, v.verified volunteer_verified, (SELECT stars FROM ratings WHERE listing_id=l.id AND rater_id=?) my_rating, (SELECT ROUND(AVG(stars),1) FROM ratings WHERE ratee_id=l.donor_id) donor_rating FROM listings l JOIN users u ON u.id=l.donor_id LEFT JOIN users v ON v.id=l.claimed_by WHERE l.{col}=? ORDER BY l.id DESC LIMIT 30", (g.user["id"], g.user["id"])).fetchall()
    out = [enrich(r) for r in rows]
    if g.user["role"] == "volunteer":  # only the claiming volunteer sees the handover code
        for o, r in zip(out, rows): o["code"] = r["code"] if r["status"] == "claimed" else None
    return jsonify(out)

@app.get("/api/stats")
def stats():
    s = dict(db().execute("""SELECT COALESCE(SUM(CASE WHEN status IN('claimed','collected') THEN quantity END),0) meals_saved,
      COALESCE(SUM(CASE WHEN status='available' THEN quantity END),0) meals_waiting,
      COALESCE(SUM(CASE WHEN status='expired' THEN quantity END),0) meals_wasted, COUNT(DISTINCT donor_id) donors FROM listings""").fetchone())
    s["co2_kg"] = round(s["meals_saved"] * 0.9)  # rough estimate: ~0.9 kg CO2e avoided per cooked meal not wasted
    s["rescue_rate"] = round(100 * s["meals_saved"] / max(1, s["meals_saved"] + s["meals_wasted"]))
    s["top_volunteers"] = [dict(r) for r in db().execute("SELECT u.name, SUM(l.quantity) meals FROM listings l JOIN users u ON u.id=l.claimed_by WHERE l.status IN('claimed','collected') GROUP BY u.id ORDER BY meals DESC LIMIT 5")]
    return jsonify(s)

def current_user():
    try: return signer.loads(request.headers.get("Authorization", "").replace("Bearer ", ""), max_age=7 * 86400)
    except BadSignature: return None

def open_requests():
    return db().execute("SELECT r.*, u.name org, u.verified org_verified FROM requests r JOIN users u ON u.id=r.requester_id WHERE r.status='open' AND r.needed_by>? ORDER BY r.needed_by", (iso(now()),)).fetchall()

@app.get("/api/requests")
def list_requests():
    supply = db().execute("SELECT quantity,lat,lng FROM listings WHERE status='available' AND safe_until>?", (iso(now()),)).fetchall()
    out = []
    for r in open_requests():
        row = dict(r)
        row["mins_left"] = max(0, round((datetime.fromisoformat(r["needed_by"]) - now()).total_seconds() / 60))
        row["supply_nearby"] = sum(s["quantity"] for s in supply if km(r["lat"], r["lng"], s["lat"], s["lng"]) <= 5)
        out.append(row)
    return jsonify(out)

@app.post("/api/requests")
@auth("volunteer")
def create_request():
    d = request.get_json(force=True, silent=True) or {}
    try: meals, hrs, lat, lng = int(d["meals"]), float(d["hours"]), float(d["lat"]), float(d["lng"])
    except (KeyError, ValueError, TypeError): return jsonify(error="Enter meals needed, a deadline and a location"), 400
    if not (1 <= meals <= 5000 and 0.5 <= hrs <= 24 and d.get("address", "").strip()): return jsonify(error="Check meals, deadline (max 24h) and address"), 400
    cur = db().execute("INSERT INTO requests(requester_id,meals,address,lat,lng,note,needed_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
        (g.user["id"], meals, d["address"].strip()[:200], lat, lng, (d.get("note") or "")[:200], iso(now() + timedelta(hours=hrs)), iso(now())))
    db().commit(); broadcast("req", {"meals": meals}); return jsonify(id=cur.lastrowid), 201

@app.post("/api/requests/<int:i>/close")
@auth("volunteer")
def close_request(i):
    return transition("UPDATE requests SET status='fulfilled' WHERE id=? AND requester_id=? AND status='open'", (i, g.user["id"]), "Request not found")

@app.get("/api/impact")
def impact():
    daily = {r["d"]: r["m"] for r in db().execute("SELECT date(claimed_at) d, SUM(quantity) m FROM listings WHERE status IN('claimed','collected') AND claimed_at>=? GROUP BY d", (iso(now() - timedelta(days=7)),))}
    days = [(now() - timedelta(days=k)).date().isoformat() for k in range(6, -1, -1)]
    out = {"daily": [{"day": d[5:], "meals": daily.get(d, 0)} for d in days]}
    u = current_user()
    if u:
        col = "donor_id" if u["role"] == "donor" else "claimed_by"
        p = db().execute(f"SELECT COALESCE(SUM(quantity),0) meals, COUNT(*) n, COALESCE(SUM(CASE WHEN (julianday(claimed_at)-julianday(created_at))*1440<10 THEN 1 END),0) fast FROM listings WHERE {col}=? AND status IN('claimed','collected')", (u["id"],)).fetchone()
        badges = [b for b, ok in [("First rescue", p["n"] >= 1), ("5 rescues", p["n"] >= 5), ("50 meals", p["meals"] >= 50), ("250 meals", p["meals"] >= 250), ("Claimed within 10 min", p["fast"] >= 1)] if ok]
        out["me"] = {"meals": p["meals"], "rescues": p["n"], "co2_kg": round(p["meals"] * 0.9), "badges": badges}
    return jsonify(out)

@app.post("/api/listings/<int:i>/rate")
@auth()
def rate(i):
    try: s = int((request.get_json(force=True, silent=True) or {}).get("stars", 0))
    except (ValueError, TypeError): s = 0
    l = db().execute("SELECT donor_id,claimed_by,status FROM listings WHERE id=?", (i,)).fetchone()
    if not l or l["status"] != "collected" or g.user["id"] not in (l["donor_id"], l["claimed_by"]) or not 1 <= s <= 5: return jsonify(error="You can rate after a completed handover"), 400
    try: db().execute("INSERT INTO ratings(listing_id,rater_id,ratee_id,stars) VALUES(?,?,?,?)", (i, g.user["id"], l["claimed_by"] if g.user["id"] == l["donor_id"] else l["donor_id"], s)); db().commit()
    except sqlite3.IntegrityError: return jsonify(error="You already rated this"), 409
    broadcast(); return jsonify(ok=True)

@app.get("/api/recurring")
@auth("donor")
def my_recurring(): return jsonify([dict(r) for r in db().execute("SELECT * FROM recurring WHERE donor_id=?", (g.user["id"],))])

@app.delete("/api/recurring/<int:i>")
@auth("donor")
def del_recurring(i):
    db().execute("DELETE FROM recurring WHERE id=? AND donor_id=?", (i, g.user["id"])); db().commit(); return jsonify(ok=True)

def fire_recurring(c):  # posts today's batch for repeating donors when their time arrives (2h grace)
    t, n = datetime.now(), 0
    for r in c.execute("SELECT * FROM recurring WHERE last_date IS NOT ?", (t.date().isoformat(),)).fetchall():
        mins = t.hour * 60 + t.minute - (int(r["at_time"][:2]) * 60 + int(r["at_time"][3:]))
        if (r["days"] == "daily" or (r["days"] == "weekdays") == (t.weekday() < 5)) and 0 <= mins <= 120:
            c.execute("INSERT INTO listings(donor_id,title,diet,quantity,address,lat,lng,created_at,safe_until) VALUES(?,?,?,?,?,?,?,?,?)", (r["donor_id"], r["title"], r["diet"], r["quantity"], r["address"], r["lat"], r["lng"], iso(now()), iso(now() + timedelta(hours=r["hours"]))))
            c.execute("UPDATE recurring SET last_date=? WHERE id=?", (t.date().isoformat(), r["id"])); n += 1
    return n

def admin_only(f):
    @auth()
    @wraps(f)
    def w(*a, **k):
        u = db().execute("SELECT is_admin FROM users WHERE id=?", (g.user["id"],)).fetchone()
        return f(*a, **k) if u and u["is_admin"] else (jsonify(error="Admins only"), 403)
    return w

@app.get("/api/admin/overview")
@admin_only
def admin_overview():
    q = lambda s: [dict(r) for r in db().execute(s)]
    return jsonify(volunteers=q("SELECT id,name,email,verified FROM users WHERE role='volunteer' ORDER BY verified, id DESC LIMIT 50"),
        listings=q("SELECT l.id,l.title,l.quantity,l.status,u.name donor FROM listings l JOIN users u ON u.id=l.donor_id ORDER BY l.id DESC LIMIT 20"),
        totals=dict(db().execute("SELECT (SELECT COUNT(*) FROM users) users,(SELECT COUNT(*) FROM listings) listings,(SELECT COUNT(*) FROM requests WHERE status='open') open_requests").fetchone()))

@app.post("/api/admin/users/<int:i>/verify")
@admin_only
def admin_verify(i):
    db().execute("UPDATE users SET verified=1-verified WHERE id=? AND role='volunteer'", (i,)); db().commit(); broadcast(); return jsonify(ok=True)

@app.post("/api/admin/listings/<int:i>/remove")
@admin_only
def admin_remove(i):
    return transition("UPDATE listings SET status='expired' WHERE id=? AND status IN('available','claimed')", (i,), "Listing already closed")

def expiry_worker():
    while True:
        time.sleep(30)
        with sqlite3.connect(DB_PATH, timeout=10) as c:
            c.row_factory = sqlite3.Row
            changed = c.execute("UPDATE listings SET status='expired' WHERE status IN('available','claimed') AND safe_until<=?", (iso(now()),)).rowcount + fire_recurring(c)
            if changed: broadcast()

@app.get("/")
def index(): return send_from_directory("static", "index.html")

if __name__ == "__main__":
    threading.Thread(target=expiry_worker, daemon=True).start()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), threaded=True)

const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { token: localStorage.getItem('token'), user: JSON.parse(localStorage.getItem('user') || 'null'), role: 'donor', diet: '', rows: [], pick: null, tab: 'nearby', here: { lat: 26.8467, lng: 80.9462 }, fetchedAt: 0 };

const map = L.map('map').setView([S.here.lat, S.here.lng], 12);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
const layer = L.layerGroup().addTo(map); let pinMarker, youMarker;

const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3000); };
async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(S.token && { Authorization: 'Bearer ' + S.token }) }, body: body && JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && S.token) logout(true);
  if (!r.ok) throw new Error(d.error || 'Something went wrong');
  return d;
}
const act = (btn, fn) => async () => { btn.disabled = true; try { await fn(); } catch (e) { toast(e.message); } btn.disabled = false; };

// ---- urgency colour + time helpers ----
const colour = (left, win) => { const f = left / win; return left < 30 || f < .15 ? 'var(--red)' : left < 90 || f < .4 ? 'var(--amber)' : 'var(--green)'; };
const hhmm = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
const liveLeft = (r) => Math.max(0, Math.round(r.mins_left - (Date.now() - S.fetchedAt) / 60000)); // ticks locally between fetches

function pinIcon(r, c) { return L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [4, 34], html: `<div class="pin" style="--c:${c}"><b>${r.quantity}</b></div>` }); }

function card(r, mode) {
  const left = mode === 'mine' ? r.mins_left : liveLeft(r), c = colour(left, r.window_mins), mine = S.user;
  const state = r.status && r.status !== 'available' ? `<span class="tag ${r.status === 'collected' ? 'ok' : r.status === 'expired' ? 'warn' : ''}">${r.status}</span>` : '';
  const match = r.score != null ? `<span class="score" title="Match score: urgency, distance and batch size">${r.score}% match</span>` : '';
  const buttons = [];
  if (mine?.role === 'volunteer' && mode === 'nearby') buttons.push(`<input class="qty" id="q${r.id}" type="number" min="1" max="${r.quantity}" placeholder="all ${r.quantity}" aria-label="Meals to take"><button class="primary" data-a="claim" data-id="${r.id}">${r.starts_in ? 'Pre-book' : 'Claim pickup'}</button>`);
  let extra = mode === 'mine' && r.status === 'collected' ? (r.my_rating ? `<p>You rated ★${r.my_rating}</p>` : `<div class="stars">Rate ${[1, 2, 3, 4, 5].map((n) => `<button data-a="rate" data-id="${r.id}" data-s="${n}">★</button>`).join('')}</div>`) : '';
  if (mode === 'mine' && r.status === 'claimed') {
    if (mine.role === 'donor') { extra = `<input class="code-in" id="c${r.id}" inputmode="numeric" maxlength="4" placeholder="Volunteer's 4-digit code">`; buttons.push(`<button class="primary" data-a="collect" data-id="${r.id}">Confirm handover</button>`); }
    else { extra = `<div class="otp">Show this code at pickup <b>${r.code}</b></div>`; buttons.push(`<a class="tag" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lng}">Directions</a>`, `<button class="ghost" data-a="release" data-id="${r.id}">Release</button>`); }
  }
  return `<div class="card" data-id="${r.id}" style="--c:${c}">
    ${r.photo ? `<img class="ph" src="${r.photo}" alt="">` : ''}<h3><span>${esc(r.title)} · ${r.quantity} meals</span>${match}</h3>
    <p>${esc(r.diet)} · from ${esc(r.donor_name)}${r.donor_verified ? ' ✔' : ''}${r.donor_rating ? ' · ★' + r.donor_rating : ''}${mine?.role === 'donor' && r.volunteer_name ? ` · taken by ${esc(r.volunteer_name)}${r.volunteer_verified ? ' ✔' : ''}` : ''}</p><p>${esc(r.address)}${r.distance_km != null ? ` · ${r.distance_km} km` : ''}</p>
    ${r.status && r.status !== 'available' ? '' : `<div class="clock"><i style="width:${Math.min(100, 100 * left / r.window_mins)}%"></i></div><span class="left">${left ? hhmm(left) + ' of safe time left' : 'Expired'}</span>`}
    <div class="tags">${state}${r.starts_in ? `<span class="tag">Ready in ${hhmm(r.starts_in)}</span>` : ''}${r.reachable === true ? `<span class="tag ok">Reach in ~${r.eta_mins} min</span>` : r.reachable === false ? `<span class="tag warn">~${r.eta_mins} min away, may not make it</span>` : ''}</div>
    ${extra}${buttons.length ? `<div class="row">${buttons.join('')}</div>` : ''}</div>`;
}

function draw() {
  layer.clearLayers();
  $('#listings').innerHTML = S.rows.length ? S.rows.map((r) => card(r, 'nearby')).join('')
    : '<div class="empty"><b>No food listed nearby right now.</b><br>Try a wider radius. New listings appear here instantly.</div>';
  S.rows.forEach((r) => L.marker([r.lat, r.lng], { icon: pinIcon(r, colour(liveLeft(r), r.window_mins)) }).addTo(layer)
    .bindPopup(`<b>${esc(r.title)}</b><br>${r.quantity} meals · ${hhmm(liveLeft(r))} left`).on('click', () => focusCard(r.id)));
}
function focusCard(id) { $$('.card').forEach((c) => c.classList.toggle('hl', c.dataset.id == id)); $(`.card[data-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }

async function loadListings(showSkel) {
  if (showSkel) $('#listings').innerHTML = '<div class="skel"></div>'.repeat(3);
  const q = new URLSearchParams({ lat: S.here.lat, lng: S.here.lng, radius: $('#radius').value, sort: $('#sort').value, diet: S.diet, when: S.when || '' });
  S.rows = await api('/listings?' + q); S.fetchedAt = Date.now(); draw();
}
async function loadStats() {
  const s = await api('/stats');
  $('#stats').innerHTML = [[s.meals_saved, 'meals rescued'], [s.meals_waiting, 'meals waiting'], [s.rescue_rate + '%', 'rescue rate'], ['~' + s.co2_kg + ' kg', 'CO₂e avoided (est.)']]
    .map(([n, l]) => `<div class="stat"><div class="num">${n}</div><small>${l}</small></div>`).join('');
  $('#board').innerHTML = s.top_volunteers.length ? '<h2 style="margin:16px 0 6px;font-size:18px">Top volunteers</h2>' + s.top_volunteers.map((v, i) => `<div class="rank"><span>${i + 1}. ${esc(v.name)}</span><b>${v.meals} meals</b></div>`).join('') : '';
}
async function loadMine() {
  if (!S.user) return;
  loadRecurring(); const rows = await api('/me/activity');
  $('#mine').innerHTML = rows.length ? rows.map((r) => card(r, 'mine')).join('') : `<div class="empty">${S.user.role === 'donor' ? 'Nothing posted yet. Use "Post food" to list your first batch.' : 'No claims yet. Pick a match from Nearby.'}</div>`;
}
const refresh = () => Promise.all([loadListings().catch((e) => toast(e.message)), loadStats(), loadMine().catch(() => {}), S.tab === 'requests' && loadRequests().catch(() => {}), S.tab === 'impact' && loadImpact().catch(() => {})]);

// ---- tabs / session ----
function setTab(t) {
  S.tab = t;
  $$('.tabpane').forEach((p) => p.classList.toggle('hidden', p.id !== 'tab-' + t));
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  if (t === 'mine') loadMine();
  if (t === 'requests') loadRequests().catch((e) => toast(e.message));
  if (t === 'impact') loadImpact().catch((e) => toast(e.message));
  if (t === 'admin') loadAdmin().catch((e) => toast(e.message));
}
function renderUser() {
  const u = S.user;
  $('#auth').classList.toggle('hidden', !!u); $('#tabs').classList.toggle('hidden', !u);
  $('#userbar').innerHTML = u ? `<span>${esc(u.name)} · ${u.role}</span>${u.role === 'volunteer' && window.Notification && Notification.permission === 'default' ? '<button class="ghost" id="alertBtn">Enable alerts</button>' : ''}<button class="ghost" id="logoutBtn">Log out</button>` : '';
  $('#logoutBtn')?.addEventListener('click', () => logout());
  if (u) { $('#tabs').innerHTML = `<button data-t="nearby">Nearby</button>${u.role === 'donor' ? '<button data-t="post">Post food</button>' : ''}<button data-t="mine">${u.role === 'donor' ? 'My listings' : 'My claims'}</button>`.replace('data-t="mine">', 'data-t="mine">') + '<button data-t="requests">Requests</button><button data-t="impact">Impact</button>' + (u.admin ? '<button data-t="admin">Admin</button>' : '');
    $$('#tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.t))); }
  setTab('nearby');
}
function logout() { localStorage.clear(); S.token = S.user = null; renderUser(); refresh(); }
function startSession(d) { S.token = d.token; S.user = d.user; localStorage.setItem('token', d.token); localStorage.setItem('user', JSON.stringify(d.user)); renderUser(); refresh(); }

$$('#roleSeg button').forEach((b) => (b.onclick = () => { S.role = b.dataset.role; $$('#roleSeg button').forEach((x) => x.classList.toggle('on', x === b)); }));
$('#loginBtn').onclick = (e) => act(e.target, async () => startSession(await api('/auth/login', 'POST', { email: $('#email').value, password: $('#password').value })))();
$('#registerBtn').onclick = (e) => act(e.target, async () => startSession(await api('/auth/register', 'POST', { name: $('#name').value, email: $('#email').value, password: $('#password').value, role: S.role })))();

// ---- filters ----
$$('#dietChips button').forEach((b) => (b.onclick = () => { S.diet = b.dataset.v; $$('#dietChips button').forEach((x) => x.classList.toggle('on', x === b)); loadListings(true); }));
$('#radius').oninput = (e) => ($('#radLbl').textContent = e.target.value); $('#radius').onchange = () => loadListings(); $('#sort').onchange = () => loadListings(true);

// delegated card actions + map focus
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]:not([data-x])');
  if (b) return act(b, async () => { await api(b.dataset.a === 'rclose' ? `/requests/${b.dataset.id}/close` : `/listings/${b.dataset.id}/${b.dataset.a}`, 'POST', b.dataset.a === 'collect' ? { code: $(`#c${b.dataset.id}`).value } : b.dataset.a === 'rate' ? { stars: +b.dataset.s } : b.dataset.a === 'claim' ? { qty: parseInt($(`#q${b.dataset.id}`)?.value) || undefined } : undefined); toast({ claim: 'Claimed. Head to the pickup point soon.', collect: 'Handover confirmed. Thank you!', release: 'Released back to nearby volunteers.', rclose: 'Request marked fulfilled.', rate: 'Thanks for rating.' }[b.dataset.a]); })();
  const c = e.target.closest('.card'); const r = c && S.rows.find((x) => x.id == c.dataset.id);
  if (r) { map.flyTo([r.lat, r.lng], 15); focusCard(r.id); }
});

// ---- posting: map pin, geocode search, quick durations ----
function setPin(latlng, label) {
  S.pick = latlng; pinMarker?.remove(); pinMarker = L.marker(latlng).addTo(map); $('#pinHint').textContent = `Pickup pin set${label ? ': ' + label : ''}.`;
}
map.on('click', (e) => { if ((S.user?.role === 'donor' && S.tab === 'post') || (S.user?.role === 'volunteer' && S.tab === 'requests')) setPin(e.latlng); });
$('#findBtn').onclick = (e) => act(e.target, async () => {
  const r = await (await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent((S.tab === 'requests' ? $('#rqAddress') : $('#address')).value))).json();
  if (!r[0]) throw new Error('Address not found. Tap the map instead.');
  const ll = L.latLng(+r[0].lat, +r[0].lon); setPin(ll, r[0].display_name.split(',').slice(0, 2).join(',')); map.flyTo(ll, 16);
})();
$$('#quick button').forEach((b) => (b.onclick = () => {
  const d = new Date(Date.now() + b.dataset.h * 3600e3 - new Date().getTimezoneOffset() * 60e3); $('#safeUntil').value = d.toISOString().slice(0, 16);
  $$('#quick button').forEach((x) => x.classList.toggle('on', x === b));
}));
$('#postBtn').onclick = (e) => act(e.target, async () => {
  if (!S.pick) throw new Error('Set the pickup pin first');
  const v = $('#safeUntil').value; if (!v) throw new Error('Choose how long the food stays safe');
  const res = await api('/listings', 'POST', { title: $('#title').value, diet: $('#diet').value, quantity: $('#quantity').value, address: $('#address').value,
    lat: S.pick.lat, lng: S.pick.lng, safe_until: new Date(v).toISOString(), safety_confirmed: $('#safe').checked,
    ready_from: $('#readyFrom').value ? new Date($('#readyFrom').value).toISOString() : '', repeat: $('#repeat').value, photo: S.photo || '' });
  toast(res.matched ? `Posted. It matches ${res.matched} open request${res.matched > 1 ? 's' : ''} nearby.` : 'Posted. Nearby volunteers are being notified.'); ['#title', '#quantity', '#address', '#safeUntil', '#readyFrom', '#photo'].forEach((s) => ($(s).value = '')); $('#safe').checked = false; S.photo = null; pinMarker?.remove(); S.pick = null; setTab('mine');
})();

// ---- realtime + clocks ----
const es = new EventSource('/api/stream');
es.onopen = () => $('#live').classList.add('on'); es.onerror = () => $('#live').classList.remove('on');
es.addEventListener('changed', refresh);
es.addEventListener('new', (e) => { const d = JSON.parse(e.data); if (S.user?.role === 'volunteer') { const m = `New food: ${d.title}, ${d.quantity} meals`; toast(m); if (window.Notification && Notification.permission === 'granted' && document.hidden) new Notification('Food Surplus Matcher', { body: m }); } refresh(); });
setInterval(draw, 30000); // re-colour bars as time passes, no network needed

navigator.geolocation?.getCurrentPosition((p) => {
  S.here = { lat: p.coords.latitude, lng: p.coords.longitude }; map.setView([S.here.lat, S.here.lng], 13);
  youMarker = L.circleMarker([S.here.lat, S.here.lng], { radius: 7, color: '#fff', weight: 2, fillColor: '#2a6df4', fillOpacity: 1 }).addTo(map).bindTooltip('You'); loadListings();
});
renderUser(); loadListings(true); loadStats();

// ---- presets, requests, impact, alerts ----
$('#preset').onchange = (e) => {
  const [h, diet] = e.target.value.split('|'); if (!h) return;
  $('#diet').value = diet; $('#safeUntil').value = new Date(Date.now() + h * 3600e3 - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  if (!$('#title').value) $('#title').value = e.target.selectedOptions[0].text.split(' · ')[0];
};
async function loadRequests() {
  $('#rqForm').classList.toggle('hidden', S.user?.role !== 'volunteer');
  S.reqs = await api('/requests');
  $('#requests').innerHTML = S.reqs.length ? S.reqs.map((r) => `<div class="card" style="--c:${colour(r.mins_left, 240)}">
    <h3><span>${r.meals} meals · ${esc(r.org)}${r.org_verified ? ' ✔' : ''}</span><span class="score">${hhmm(r.mins_left)} left</span></h3>
    <p>${esc(r.address)}</p>${r.note ? `<p>${esc(r.note)}</p>` : ''}
    <div class="tags"><span class="tag ${r.supply_nearby >= r.meals ? 'ok' : 'warn'}">${r.supply_nearby} meals listed within 5 km</span></div>
    ${S.user?.role === 'donor' ? `<div class="row"><button class="primary" data-donate="${r.id}">I can donate</button></div>` : ''}
    ${S.user?.id === r.requester_id ? `<div class="row"><button class="ghost" data-a="rclose" data-id="${r.id}">Mark fulfilled</button></div>` : ''}</div>`).join('')
    : '<div class="empty"><b>No open requests.</b><br>Shelters and volunteer groups can post what they need here.</div>';
}
$('#rqBtn').onclick = (e) => act(e.target, async () => {
  const p = S.pick || S.here;
  await api('/requests', 'POST', { meals: $('#rqMeals').value, hours: $('#rqHours').value, address: $('#rqAddress').value, note: $('#rqNote').value, lat: p.lat, lng: p.lng });
  ['#rqMeals', '#rqAddress', '#rqNote'].forEach((s) => ($(s).value = '')); pinMarker?.remove(); S.pick = null; toast('Request posted. Donors nearby will see it.'); loadRequests();
})();
$('#findReq').onclick = $('#findBtn').onclick;
document.addEventListener('click', (e) => {
  const d = e.target.closest('[data-donate]'); if (!d) return;
  const r = S.reqs.find((x) => x.id == d.dataset.donate); setTab('post'); $('#quantity').value = r.meals; map.flyTo([r.lat, r.lng], 14);
  toast('Add your food and pickup address. Nearby requests are matched automatically.');
});
async function loadImpact() {
  const d = await api('/impact'), max = Math.max(1, ...d.daily.map((x) => x.meals));
  $('#me').innerHTML = d.me ? `<div class="panel"><h2>Your impact</h2><div class="mecards"><div><b class="num">${d.me.meals}</b><small>meals rescued</small></div><div><b class="num">${d.me.rescues}</b><small>rescues</small></div><div><b class="num">~${d.me.co2_kg} kg</b><small>CO₂e avoided</small></div></div>
    <div class="chips">${d.me.badges.map((b) => `<span class="tag ok">${esc(b)}</span>`).join('') || '<span class="muted">Your first rescue unlocks a badge.</span>'}</div></div>` : '';
  $('#chart').innerHTML = `<h2 style="margin:16px 0 8px;font-size:18px">Meals rescued, last 7 days</h2><div class="bars">${d.daily.map((x) => `<div><b>${x.meals}</b><i style="height:${4 + 90 * x.meals / max}px"></i><small>${x.day}</small></div>`).join('')}</div>`;
}
es.addEventListener('req', (e) => { if (S.user?.role === 'donor') toast(`New request: ${JSON.parse(e.data).meals} meals needed nearby. See Requests.`); if (S.tab === 'requests') loadRequests(); });
document.addEventListener('click', (e) => { if (e.target.id === 'alertBtn') Notification.requestPermission().then(() => { e.target.remove(); toast('Alerts on. You will be pinged when food is listed.'); }); });

// ---- upcoming events, photos, repeating posts, admin ----
$$('#whenChips button').forEach((b) => (b.onclick = () => { S.when = b.dataset.w; $$('#whenChips button').forEach((x) => x.classList.toggle('on', x === b)); loadListings(true); }));
$('#photo').onchange = (e) => {
  const f = e.target.files[0]; if (!f) { S.photo = null; return; }
  const img = new Image(); img.onload = () => { const k = Math.min(1, 640 / Math.max(img.width, img.height)), c = document.createElement('canvas'); c.width = img.width * k; c.height = img.height * k; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); S.photo = c.toDataURL('image/jpeg', .7); URL.revokeObjectURL(img.src); };
  img.src = URL.createObjectURL(f);
};
async function loadRecurring() {
  if (S.user?.role !== 'donor') { $('#recur').innerHTML = ''; return; }
  const rec = await api('/recurring');
  $('#recur').innerHTML = rec.length ? '<h2 style="font-size:18px;margin:4px 0 8px">Repeating posts</h2>' + rec.map((r) => `<div class="card"><h3><span>${esc(r.title)} · ${r.quantity} meals</span></h3><p>${esc(r.days)} at ${r.at_time}, safe for ${r.hours}h</p><div class="row"><button class="ghost" data-x="rdel" data-id="${r.id}">Stop repeating</button></div></div>`).join('') : '';
}
async function loadAdmin() {
  const d = await api('/admin/overview');
  $('#tab-admin').innerHTML = `<div class="panel"><h2>Admin</h2><p class="muted">${d.totals.users} users · ${d.totals.listings} listings · ${d.totals.open_requests} open requests</p></div><h2 style="font-size:18px;margin:14px 0 6px">Verify NGOs and volunteers</h2>`
    + d.volunteers.map((v) => `<div class="rank"><span>${esc(v.name)} <small class="muted">${esc(v.email)}</small></span><button class="${v.verified ? 'ghost' : 'primary'}" data-x="verify" data-id="${v.id}">${v.verified ? 'Verified ✔ (undo)' : 'Verify'}</button></div>`).join('')
    + '<h2 style="font-size:18px;margin:14px 0 6px">Recent listings</h2>' + d.listings.map((l) => `<div class="rank"><span>${esc(l.title)} · ${l.quantity} · ${esc(l.status)} <small class="muted">${esc(l.donor)}</small></span>${['available', 'claimed'].includes(l.status) ? `<button class="ghost" data-x="remove" data-id="${l.id}">Remove</button>` : ''}</div>`).join('');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-x]'); if (!b) return;
  const id = b.dataset.id, m = { rdel: [`/recurring/${id}`, 'DELETE'], verify: [`/admin/users/${id}/verify`, 'POST'], remove: [`/admin/listings/${id}/remove`, 'POST'] }[b.dataset.x];
  act(b, async () => { await api(m[0], m[1]); toast('Done.'); loadRecurring(); if (b.dataset.x !== 'rdel') loadAdmin(); })();
});

// ---- Hindi / English (DOM text swap, so dynamic cards translate too) ----
const HI = { 'Nearby': 'आस-पास', 'Post food': 'खाना पोस्ट करें', 'My listings': 'मेरी लिस्टिंग', 'My claims': 'मेरे दावे', 'Requests': 'अनुरोध', 'Impact': 'प्रभाव', 'Admin': 'एडमिन',
  'Rescue food before it spoils': 'खाना खराब होने से पहले बचाएँ', 'I have food': 'मेरे पास खाना है', 'I can pick up': 'मैं ले जा सकता/सकती हूँ', 'Create account': 'खाता बनाएँ', 'Log in': 'लॉग इन', 'Log out': 'लॉग आउट', 'Enable alerts': 'अलर्ट चालू करें',
  'All': 'सभी', 'Veg': 'शाकाहारी', 'Non-veg': 'मांसाहारी', 'Packaged': 'पैकेज्ड', 'Available now': 'अभी उपलब्ध', 'Upcoming events': 'आने वाले आयोजन', 'Best match': 'सबसे उपयुक्त', 'Expiring soonest': 'जल्द खराब होने वाला', 'Nearest': 'सबसे नज़दीक',
  'Claim pickup': 'लेने का दावा करें', 'Pre-book': 'पहले से बुक करें', 'Confirm handover': 'हैंडओवर की पुष्टि करें', 'Release': 'छोड़ें', 'Directions': 'रास्ता', 'Mark fulfilled': 'पूरा हुआ', 'I can donate': 'मैं दान कर सकता/सकती हूँ', 'Stop repeating': 'दोहराना बंद करें', 'Rate': 'रेटिंग दें',
  'Post surplus food': 'बचा हुआ खाना पोस्ट करें', 'Post listing': 'लिस्टिंग पोस्ट करें', 'Find on map': 'मैप पर खोजें', 'Ask for food': 'खाना माँगें', 'Post request': 'अनुरोध भेजें', 'Your impact': 'आपका प्रभाव', 'Top volunteers': 'शीर्ष स्वयंसेवक', 'Repeating posts': 'दोहराई जाने वाली पोस्ट',
  'meals rescued': 'भोजन बचाए', 'meals waiting': 'भोजन प्रतीक्षा में', 'rescue rate': 'बचाव दर', 'rescues': 'बचाव', 'Meals rescued, last 7 days': 'पिछले 7 दिनों में बचाए गए भोजन', 'CO₂e avoided (est.)': 'CO₂ बचत (अनुमानित)',
  "Doesn't repeat": 'दोहराएँ नहीं', 'Repeat daily': 'रोज़ दोहराएँ', 'Repeat on weekdays': 'सोम–शुक्र दोहराएँ', 'Repeat on weekends': 'शनि–रवि दोहराएँ', 'Event or later pickup? Set when the food will be ready (optional).': 'आयोजन या बाद में पिकअप? बताएँ खाना कब तैयार होगा (वैकल्पिक)।',
  'Verify NGOs and volunteers': 'NGO और स्वयंसेवकों को सत्यापित करें', 'Recent listings': 'हाल की लिस्टिंग', 'Verify': 'सत्यापित करें', 'Remove': 'हटाएँ', 'Expired': 'समाप्त',
  'Name or organisation': 'नाम या संस्था', 'Email': 'ईमेल', 'Password (6+ characters)': 'पासवर्ड (6+ अक्षर)', 'What is it? e.g. Veg biryani': 'यह क्या है? जैसे वेज बिरयानी', 'Meals': 'भोजन की संख्या', 'Pickup address': 'पिकअप का पता', 'Meals needed': 'कितने भोजन चाहिए' };
const PAT = [[/^(.+) of safe time left$/, 'सुरक्षित समय बाकी: $1'], [/^Reach in ~(\d+) min$/, '~$1 मिनट में पहुँचें'], [/^(\d+)% match$/, '$1% उपयुक्त'], [/^(.*) · (\d+) meals$/, '$1 · $2 भोजन'], [/^(\d+) meals · (.*)$/, '$1 भोजन · $2'], [/^(.+) left$/, '$1 बाकी'], [/^(\d+) meals listed within 5 km$/, '5 किमी के अंदर $1 भोजन उपलब्ध'], [/^Ready in (.+)$/, 'तैयार होगा: $1 में']];
const LANG = { cur: localStorage.getItem('lang') || 'en', orig: new WeakMap() };
const trText = (s) => { const k = s.trim(); if (!k) return s; let h = HI[k]; if (!h) for (const [re, r] of PAT) if (re.test(k)) { h = k.replace(re, r); break; } return h ? s.replace(k, h) : s; };
function applyLang(root = document.body) {
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n;
  while ((n = tw.nextNode())) {
    if (n.parentNode.closest('script,style')) continue;
    if (LANG.cur === 'hi') { if (!LANG.orig.has(n)) { const t = trText(n.data); if (t !== n.data) { LANG.orig.set(n, n.data); n.data = t; } } }
    else if (LANG.orig.has(n)) { n.data = LANG.orig.get(n); LANG.orig.delete(n); }
  }
  (root.querySelectorAll ? root : document).querySelectorAll('[placeholder]').forEach((el) => { el.dataset.ph ??= el.placeholder; el.placeholder = LANG.cur === 'hi' ? (HI[el.dataset.ph] || el.dataset.ph) : el.dataset.ph; });
}
const watch = () => mo.observe(document.body, { childList: true, subtree: true });
const mo = new MutationObserver((ms) => { if (LANG.cur !== 'hi') return; mo.disconnect(); ms.forEach((m) => m.addedNodes.forEach((a) => applyLang(a.nodeType === 1 ? a : a.parentNode))); watch(); });
$('#langBtn').onclick = () => { LANG.cur = LANG.cur === 'hi' ? 'en' : 'hi'; localStorage.setItem('lang', LANG.cur); $('#langBtn').textContent = LANG.cur === 'hi' ? 'English' : 'हिन्दी'; document.documentElement.lang = LANG.cur; mo.disconnect(); applyLang(); watch(); };
if (LANG.cur === 'hi') { $('#langBtn').textContent = 'English'; applyLang(); }
watch();

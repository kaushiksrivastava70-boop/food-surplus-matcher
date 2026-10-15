# Food Surplus Matcher

Connects donors with surplus cooked food to nearby volunteers and NGOs before it spoils.

## Run
```bash
pip install -r requirements.txt
python app.py        # http://localhost:5000
```

## What's new
- **Smart matching**: each listing gets a 0-100 match score (urgency 40%, distance 35%, batch size 25%). Food a volunteer cannot reach before it expires is flagged and ranked down.
- **Full lifecycle**: available, claimed, collected or expired. Volunteers can release a claim; donor or volunteer confirms handover.
- **Atomic claiming**: one conditional SQL UPDATE, so two volunteers can never claim the same food.
- **Live updates** via Server-Sent Events (no extra dependencies), plus a background expiry worker.
- **Address search** (OpenStreetMap Nominatim) and quick "safe for 1/2/4/6h" buttons.
- **Impact stats**: meals rescued, rescue rate, estimated CO2e avoided, volunteer leaderboard.
- Signed tokens, hashed passwords, auth rate limiting, input validation (max 12h safe window).

## v3 additions
- **Requests tab**: shelters and NGOs post what they need (meals, deadline, location). Each request shows how many meals are listed within 5 km. Donors tap "I can donate", and a new listing is auto-matched against open requests within 10 km.
- **Handover code**: a volunteer who claims food gets a 4-digit code. The donor must type it to confirm pickup, so a handover can't be faked. The code is never in public API responses.
- **Food presets**: rice, dal, roti, sweets, bakery and packaged each set a safe window. Directions link for claimed pickups.
- **Impact tab**: personal meals, rescues, CO2e, badges, a 7-day chart and the leaderboard.
- **Browser alerts** for volunteers when new food is listed.

## v4 additions
- **Scheduled event surplus**: set "ready from" (up to 7 days ahead). It shows under "Upcoming events", and volunteers can pre-book it.
- **Repeating donors**: choose daily, weekdays or weekends when posting. A background job posts the batch automatically. Manage or stop it under My listings.
- **Ratings and verified NGOs**: after a completed handover, both sides rate 1-5 stars. Admin-verified volunteers and NGOs get a check mark.
- **Admin panel**: the first account registered (or the one matching the ADMIN_EMAIL environment variable) is admin. Verify NGOs, remove spam listings, see totals.
- **Photos**: resized in the browser to a small JPEG before upload.
- **Hindi / English toggle** in the header.
- **Split batches**: a volunteer can claim part of a listing (for example 10 of 40). The rest stays available.

## API
POST /api/auth/register, /api/auth/login · GET /api/listings?lat&lng&radius&diet&sort=match|urgency|distance · POST /api/listings (donor) · POST /api/listings/:id/claim | release | collect {code} · GET/POST /api/requests · POST /api/requests/:id/close · GET /api/impact · POST /api/listings/:id/rate · GET/DELETE /api/recurring · GET /api/admin/overview · POST /api/admin/users/:id/verify · POST /api/admin/listings/:id/remove · GET /api/me/activity · GET /api/stats · GET /api/stream (SSE)

## Next
Twilio/WhatsApp alerts, PostgreSQL + PostGIS, Docker + deploy (gunicorn with gevent for SSE).

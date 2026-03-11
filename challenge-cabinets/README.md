# Challenge Cabinets — Workshop Checklist System

A shared, real-time workshop checklist app for cabinet drafting and stone manufacturing. All data persists in a SQLite database and real emails fire via SMTP when checklist milestones are marked Done.

---

## Quick Start (Local)

### 1. Install Node.js
Download from https://nodejs.org — use version 18 or newer.

### 2. Install dependencies
```bash
cd challenge-cabinets
npm install
```

### 3. Configure email
```bash
cp .env.example .env
```
Open `.env` and fill in your SMTP details (see Email Setup below).

### 4. Run the server
```bash
npm start
```
Open http://localhost:3000 in your browser.

---

## Email Setup

The app sends real emails when checklist items tagged 📧 are marked Done.

### Option A — Gmail (easiest to test)
1. Enable 2-Factor Authentication on your Google account
2. Go to https://myaccount.google.com/apppasswords
3. Create an App Password (select "Mail")
4. In `.env`:
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-gmail@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx   ← the 16-char app password
```

### Option B — Resend (recommended for production — 100 free emails/day)
1. Sign up at https://resend.com
2. Get your API key
3. In `.env`:
```
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASS=re_your_api_key_here
```

### Option C — Your hosting provider's SMTP
Most web hosts (cPanel, Plesk) provide SMTP credentials. Use those.

---

## Deploying Online (so Matt, Arron & Reece can all access it)

### Option 1 — Railway (recommended, ~$5/month, easiest)
1. Create a free account at https://railway.app
2. Click "New Project" → "Deploy from GitHub"
3. Push this folder to a GitHub repo first, then connect it
4. Railway auto-detects Node.js and runs `npm start`
5. Add your environment variables in Railway's dashboard under "Variables"
6. You'll get a URL like `https://challenge-cabinets-production.up.railway.app`

### Option 2 — Render (free tier available)
1. Sign up at https://render.com
2. New → Web Service → connect your GitHub repo
3. Build Command: `npm install`
4. Start Command: `node server/index.js`
5. Add environment variables in the dashboard
6. Free tier spins down after inactivity (first load is slow) — paid tier is always-on

### Option 3 — VPS / DigitalOcean Droplet ($6/month)
Best for full control. Spin up an Ubuntu droplet, then:
```bash
# On the server:
git clone your-repo challenge-cabinets
cd challenge-cabinets
npm install
cp .env.example .env
nano .env   # fill in your SMTP details

# Install PM2 to keep it running
npm install -g pm2
pm2 start server/index.js --name "challenge-cabinets"
pm2 save
pm2 startup
```
Then point your domain's DNS to the droplet's IP and use nginx as a reverse proxy.

---

## Project Structure

```
challenge-cabinets/
├── server/
│   ├── index.js      ← Express server entry point
│   ├── routes.js     ← REST API (projects, notifications, triggers)
│   ├── db.js         ← SQLite setup & seed data
│   └── mailer.js     ← Nodemailer email sender + HTML template
├── public/
│   └── index.html    ← The full frontend app (served by Express)
├── data/
│   └── challenge.db  ← SQLite database (auto-created on first run)
├── .env.example      ← Environment variable template
├── .env              ← Your actual config (never commit this!)
└── package.json
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/projects | List projects (filter: ?type=cab&status=active) |
| POST | /api/projects | Create new project |
| PATCH | /api/projects/:id | Update project fields |
| DELETE | /api/projects/:id | Permanently delete project |
| POST | /api/projects/:id/archive | Archive a project |
| POST | /api/projects/:id/restore | Restore from archive |
| GET | /api/notifications | Get notification log |
| POST | /api/notifications/send | Send email + log it |
| GET | /api/triggers | Get trigger rules (filter: ?type=cab) |
| PATCH | /api/triggers/:id | Toggle a trigger on/off |
| GET | /api/health | Health check |

---

## Notes

- **Database**: SQLite file at `data/challenge.db` — back this up regularly
- **Checklist data**: Stored as JSON in the database, auto-saved 800ms after any change
- **Multiple users**: All users see the same data — no login system (add one if needed)
- **The standalone HTML**: `challenge-cabinets-checklist.html` still works as a standalone offline version (no persistence)

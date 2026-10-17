# Claudius

Claudius is an autonomous AI sales and marketing manager for the **rt3d-bbz** eBay store (https://www.ebay.com.au/str/rt3dbbz), built on Claude.

On every run, Claudius:

1. **Reviews the store.** It reads every listing's price, stock, impressions, views, sales and conversion, plus recent orders and active promotions.
2. **Answers buyer questions** in the store's voice. Refunds, damage, disputes and anything legal go to you instead.
3. **Optimises listings.** It rewrites titles that get impressions but no clicks, and checks competitor prices before changing its own.
4. **Runs promotions.** It sets up short markdown sales on slow stock and Promoted Listings (cost-per-sale) on items that already convert.
5. **Drafts social posts** (Instagram, Facebook, TikTok, Reddit) into `outbox/` for you to post.
6. **Learns.** It saves notes on what worked, and future runs read those notes.
7. **Reports.** It writes a report to `reports/`, and every action goes to an audit log.

It runs **fully autonomously**. Code-level guardrails, not just instructions in the prompt, stop it from doing anything expensive or risky.

## Guardrails

These are enforced in `src/guardrails.js`, and you tune them in `claudius.config.json`:

| Limit | Default |
|---|---|
| Price floor | Highest of $3.00, unit cost + 40% margin, or 30% below the original price |
| Max price move | 15% per day per SKU, 10 changes per run |
| Sales | Max 25% off, max 14 days, never below a floor |
| Promoted Listings ad rate | 2–6% |
| New listings | Max 3 per run |
| Buyer replies | Max 25 per run. Blocked if the reply mentions money, refunds, discounts, off-eBay contact or guarantees |
| Always escalated to you | Refunds, returns, damage, missing parcels, cases/disputes, legal, consumer-law questions |

**Kill switch:** create an empty file named `STOP` in this folder, or set `CLAUDIUS_PAUSED=1`. Claudius then only reviews and reports.

Add each product's real **unit cost** under `products` in `claudius.config.json`. The costs there now are placeholders, so update them. With a real cost, the floor guarantees your margin.

## Quick start (simulated store, no eBay keys needed)

```bash
cd claudius
npm install
cp .env.example .env        # add your ANTHROPIC_API_KEY
npm run run                 # one full run against a simulated copy of your store
npm run chat                # talk to Claudius, e.g. "plan a Christmas promo"
npm run status              # recent actions and escalations
npm test                    # guardrail and agent-loop tests (no API calls)
```

`EBAY_MODE=mock` (the default) uses a simulated store seeded with your real listings: YETI boots, Ooshies stands, propagation stations and so on. Delete `data/mock-store.json` to reset it.

## Files Claudius writes

| Path | What |
|---|---|
| `reports/*.md` | One report per run: Claudius's summary plus the audit log |
| `data/escalations.md` | Things that need you, such as disputes, restocks and ideas needing a go-ahead |
| `data/actions.jsonl` | Append-only log of every action, blocked attempt and dry run |
| `data/notes.md` | Claudius's long-term memory (you can edit it to give it standing instructions) |
| `outbox/*.md` | Social media posts ready to paste |

## Connecting your real eBay store

### 1. eBay developer account
1. Sign up at https://developer.ebay.com and create an application keyset under **My Account → Application Keys**. You get **Sandbox** and **Production** keysets: App ID (Client ID) and Cert ID (Client Secret).
2. Under **User Tokens**, add an eBay Redirect URL (RuName) for the keyset.

### 2. Getting a refresh token
1. On the **User Tokens** page, choose **Get a Token from eBay via Your Application**, select **OAuth**, and sign in with your seller account. Grant these scopes: `api_scope`, `sell.inventory`, `sell.marketing`, `sell.fulfillment`, `sell.analytics.readonly`.
2. Copy the **refresh token**, which lasts about 18 months, into `EBAY_REFRESH_TOKEN`. Claudius swaps it for short-lived access tokens automatically.

### 3. Fill in `.env`
```
EBAY_MODE=sandbox            # try sandbox first, then production
EBAY_CLIENT_ID=...
EBAY_CLIENT_SECRET=...
EBAY_REFRESH_TOKEN=...
EBAY_MARKETPLACE_ID=EBAY_AU
```
Creating new listings also needs your business policy IDs and inventory location, all visible in Seller Hub: `EBAY_FULFILLMENT_POLICY_ID`, `EBAY_PAYMENT_POLICY_ID`, `EBAY_RETURN_POLICY_ID`, `EBAY_LOCATION_KEY`.

### 4. Migrating existing listings
eBay's Inventory API only sees listings created through it, so listings you made on ebay.com.au need a one-off migration. Before migrating, make sure each listing has a Custom label (SKU) matching `claudius.config.json`, uses business policies, and is fixed price (auctions can't migrate). Then run:
```bash
node src/index.js migrate 123456789012 223456789012   # listing IDs from ebay.com.au/itm/<id>
```
Migration can't be undone, so try one listing first.

### 5. First live run
```bash
EBAY_MODE=production node src/index.js run --dry-run
```
A dry run reads your real store and logs every change it *would* make, without making it. Read the report, adjust the guardrails, then run for real.

## Running it on a schedule

```bash
npm run daemon               # a full run every CLAUDIUS_INTERVAL_HOURS (default 6)
```
Or use cron on any always-on machine (a home PC, a Raspberry Pi, or a $6/month VPS):
```
0 7,13,19 * * *  cd /path/to/claudius && /usr/bin/node src/index.js run >> claudius.log 2>&1
```
The `data/` folder is Claudius's memory, so run it somewhere with a persistent disk and back the folder up.

## How it's built

```
src/
├── index.js        CLI: run | chat | daemon | status | migrate
├── agent.js        Claude agent loop (Claude Opus 5.5, adaptive thinking, prompt caching)
├── prompt.js       Claudius's role, routine and principles
├── tools.js        13 tools + guardrail checks in front of every write
├── guardrails.js   Hard limits (pure functions, unit tested)
├── state.js        Baselines, daily counters, audit log, notes, escalations
└── ebay/
    ├── mock.js     Simulated store
    └── live.js     eBay REST (Inventory, Fulfillment, Marketing, Analytics, Browse) + Trading API (messages)
```

- **Model:** `claude-opus-5-5`, overridable with `CLAUDIUS_MODEL`. It runs with high effort and server-side refusal fallback (`fallbacks: "default"`).
- **Cost control:** the system prompt and tools are prompt-cached across the steps of a run, and token usage is printed in every report.
- **Status:** the mock store and guardrails are tested. The live eBay client follows eBay's documented APIs but has not run against a real account yet. Use sandbox mode and `--dry-run` first.

## Ideas for next steps
- Emailing the run report and urgent escalations (Gmail or SMTP)
- Posting social drafts automatically (Meta Graph API)
- Generating listing photos and lifestyle images from your product shots
- Tracking each experiment's before and after conversion automatically

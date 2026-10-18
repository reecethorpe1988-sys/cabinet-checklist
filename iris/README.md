# Iris

Iris is the Instagram manager for **rt3d-bbz**, and works alongside [Claudius](../claudius) (the eBay agent). Iris plans and writes posts about:

- **New products** and new eBay listings
- **eBay sales and price drops** that Claudius actually started
- **Facebook Marketplace items** (seconds, one-offs, local deals)
- **Making-of content** from photos you drop in `photos/`

Iris reads Claudius's catalog, so prices, stock and sales in a post always match eBay. It looks at each photo before using it, writes the caption, picks the best time slot, and asks you for photos it needs.

## How posting works

```
Iris plans ──► queue (draft) ──► you approve ──► publisher posts at its time slot
```

- **Approval mode (default):** nothing reaches Instagram until you run `approve`.
- **Auto mode:** set `"autoPublish": true` in `iris.config.json` and Iris's posts are approved automatically. Every guardrail still applies.
- The **publisher is plain code, not AI**. It only posts approved items. Right before posting, it re-checks that every price and discount in the caption is still current.

## Guardrails (enforced in code)

| Rule | Default |
|---|---|
| Any `$` amount in a caption | Must be a current eBay price, an active sale price, or a Marketplace price of a featured item |
| Any "% off" | Must match a sale Claudius is running |
| Posts per day | Max 2, at least 4 hours apart, at your posting slots (11:30am and 7:30pm Sydney time) |
| Banned phrases | "officially licensed", "official YETI", "bank transfer", "PayID", "cheapest" and others |
| Hashtags | Max 15 (Instagram allows 30) |
| Stock | Won't feature items out of stock on eBay, or Marketplace items not marked available |
| Kill switch | A file named `STOP` in this folder, or `IRIS_PAUSED=1`, stops all publishing |

## Quick start (simulated Instagram)

```bash
cd iris
npm install
cp .env.example .env              # add ANTHROPIC_API_KEY
cp marketplace.example.json marketplace.json   # then edit with your real Marketplace items
npm run plan                      # Iris plans and queues posts
npm run queue                     # see what's waiting
node src/index.js show P001       # full caption and photos
node src/index.js approve P001    # or: approve all
npm run publish                   # posts anything approved and due
npm test
```

Run Claudius at least once first (`cd ../claudius && npm run run`), so Iris has a catalog to read.

## Daily use

| Command | What it does |
|---|---|
| `npm run plan` | Iris plans the next few days of posts |
| `npm run queue` | Shows posts waiting for approval and scheduled posts |
| `node src/index.js show P003` | Shows the full caption and image links |
| `node src/index.js approve P003 P004` | Approves posts (`approve all` approves every draft) |
| `node src/index.js approve P003 --at 2026-10-20T19:30:00+11:00` | Approves a post and changes its time |
| `node src/index.js reject P005` | Drops a post |
| `npm run chat` | Ask for changes: "make P003 shorter", "plan 3 Christmas posts" |
| `npm run status` | Shows the queue counts and recent activity |
| `data/escalations.md` | Photo requests and questions from Iris |
| `outbox/marketplace-*.md` | Facebook Marketplace listing text, ready to paste |

**Photos:** drop product, lifestyle or making-of photos into `photos/` (JPEG, PNG or HEIC). Iris looks at them and uses the good ones, after hosting them publicly (see Cloudinary below).

**Facebook Marketplace:** list your items in `marketplace.json` (id, title, price, condition, photos, status). Meta has no API for posting personal Marketplace listings, so Iris writes the listing text for you to paste, and promotes the items on Instagram. Set an item's `status` to `"sold"` when it goes, so Iris stops posting it.

## Connecting your real Instagram

### 1. Make it a professional account
In the Instagram app, go to **Settings → Account type and tools → Switch to professional account**, then choose **Business** or **Creator**. It's free and keeps your followers.

### 2. Create a Meta app
1. Sign up at https://developers.facebook.com and create an app. Choose the use case for managing content on Instagram (the **Instagram API with Instagram Login**).
2. In the app dashboard, open **Instagram → API setup with Instagram login**. Add your Instagram account and grant `instagram_business_basic`, `instagram_business_content_publish` and `instagram_business_manage_insights`.
3. Click **Generate token**. This is a long-lived token that lasts 60 days. Iris refreshes it automatically every week while it runs, so you only do this once. If Iris stops running for more than 60 days, generate a new one.

Because the app is only used on your own account (which has a role on the app), it should work in development mode with Standard Access, so you shouldn't need Meta's app review.

### 3. Fill in `.env`
```
IG_MODE=live
IG_ACCESS_TOKEN=your long-lived token
```

### 4. Photo hosting (for photos from `photos/`)
Instagram only posts images that are on a public URL, and only JPEGs. eBay listing photos are already public. For your own photos, create a free account at https://cloudinary.com and copy the **API environment variable** from the dashboard into `.env`:
```
CLOUDINARY_URL=cloudinary://API_KEY:API_SECRET@CLOUD_NAME
```
Iris uploads your photos there and converts them to JPEG.

### 5. First real post
Run `npm run plan`, review with `queue` and `show`, then approve **one** post and run `npm run publish` after its time slot. Check it on Instagram before approving more.

## Running on a schedule

Plan once a day and publish every 15 minutes (cron):
```
0 6 * * *     cd /path/to/iris && node src/index.js plan >> iris.log 2>&1
*/15 * * * *  cd /path/to/iris && node src/index.js publish >> iris.log 2>&1
```
Or run `npm run daemon`, which does both. Approve posts whenever you like; they go out at their slot. A post you approve after its slot has passed moves to the next free slot.

## How it's built

```
src/
├── index.js          CLI
├── agent.js          Claude agent loop (Claude Opus 5.5, adaptive thinking; tool results can include photos)
├── prompt.js         Iris's role, content mix and writing rules
├── tools.js          8 tools with guardrails in front of the queue
├── guardrails.js     Price, discount, phrase, hashtag and schedule checks
├── publisher.js      Posts approved items at their time (no AI)
├── sources.js        Reads Claudius's catalog/sales, marketplace.json, photos/
├── photos.js         Lets Claude see photos; hosts them on Cloudinary
├── time.js           Posting slots in your time zone (handles daylight saving)
└── instagram/        mock.js (simulated) and live.js (Instagram Graph API)
```

**Status:** tested against the simulated account. The live Instagram code follows Meta's current docs (API v25.0) but hasn't posted to a real account yet. Step 5 is where any issues would show up.

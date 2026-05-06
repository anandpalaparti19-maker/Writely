# Writely — Deploy & Config Checklist

One-time setup steps required **after code is pushed** before the app works end-to-end in production.

---

## 1. Firestore Rules

File: `firestore.rules`

```bash
# From repo root
npm install -g firebase-tools      # once
firebase login                     # once
firebase use <your-project-id>     # e.g. firebase use writely-prod
firebase deploy --only firestore:rules
```

Verify in Firebase Console → Firestore Database → Rules tab that the timestamp updated.

---

## 2. Firestore Composite Indexes

File: `firestore.indexes.json`

```bash
firebase deploy --only firestore:indexes
```

This creates the 7 composite indexes used by the app:

| Collection | Fields | Used by |
|---|---|---|
| `assignments` | `status` (array) + `createdAt` desc | Paginated job feed (no-scope) |
| `assignments` | `status` + `pincode` + `createdAt` desc | Nearby-by-pincode feed |
| `assignments` | `status` + `city` + `createdAt` desc | City-wide feed |
| `messages` | `assignmentId` + `timestamp` asc | Chat message stream |
| `messages` | `receiverId` + `createdAt` desc | New-message notification listener |
| `reviews` | `revieweeId` + `createdAt` desc | Writer profile reviews |
| `transactions` | `receiverId` + `timestamp` desc | Wallet history |

**Index build takes 1–10 minutes.** Watch Firebase Console → Firestore → Indexes until all show **Enabled**.

---

## 3. Cashfree Webhook

1. Log in to **Cashfree Dashboard** → Developers → Webhooks.
2. **Add Endpoint**:
   - URL: `https://<your-render-domain>/api/payments/cashfree/webhook`
   - Events: `PAYMENT_SUCCESS_WEBHOOK`, `PAYMENT_FAILED_WEBHOOK`, `PAYMENT_USER_DROPPED_WEBHOOK`
3. Copy the **Secret Key** from Cashfree → Merchant → API Keys. It is the same key used for API auth; the backend uses it as the HMAC secret (`CASHFREE_SECRET_KEY`).
4. Trigger a **test payment** (₹1) from the Wallet page and confirm:
   - Cashfree dashboard → Webhooks → Delivery logs shows `200 OK`.
   - `wallets/<uid>.balance` increased in Firestore.
   - A notification doc appeared under `users/<uid>/notifications`.

### Local testing (optional)

Use `ngrok http 4000` and point the webhook URL to the ngrok HTTPS URL.

---

## 4. Backend Environment Variables (Render)

Render Dashboard → your service → Environment:

| Key | Example | Notes |
|---|---|---|
| `CASHFREE_APP_ID` | `TEST1234…` | from Cashfree API Keys |
| `CASHFREE_SECRET_KEY` | `cfsk_ma_…` | **also** used for webhook HMAC |
| `CASHFREE_ENV` | `TEST` or `PROD` | switches API base URL |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | `{...}` | full JSON, single line |
| `SENTRY_DSN` | `https://…ingest.sentry.io/…` | optional, enables error capture |
| `FRONTEND_URL` | `https://writely.netlify.app` | allowed CORS origin |
| `PORT` | `4000` | Render sets automatically |

After saving, **Manual Deploy → Deploy latest commit**.

---

## 5. Frontend Environment (Netlify)

Netlify → Site settings → Environment variables:

| Key | Example |
|---|---|
| `API_URL` | `https://<render-service>.onrender.com` |

Rebuild the site (`Deploys → Trigger deploy → Clear cache and deploy`).

---

## 6. Smoke Tests (do in this order)

1. **Register** a new seeker account with city + pincode (try "Detect location").
2. **Register** a writer in the same pincode.
3. **Post** an assignment (with pincode).
4. Writer **Browse Jobs → Nearby** tab: assignment must appear.
5. Writer places a bid.
6. Seeker accepts → Cashfree checkout opens → pay ₹1 test.
7. Check Firestore: `assignments/<id>.status == 'ACTIVE'`, `wallets/<seekerId>` debited (or escrow doc updated).
8. Writer **Submissions** → Download attachment works.
9. Writer submits solution.
10. Seeker marks complete → writer wallet credited.
11. Seeker clicks **Leave Review** → review doc created.
12. Both users see the review and notifications bell update.

---

## 7. Rollback

```bash
firebase firestore:indexes   # view current
# Rules rollback: redeploy previous firestore.rules from git
git checkout <prev-sha> firestore.rules && firebase deploy --only firestore:rules
```

Index deletion must be done manually in the Firebase Console.

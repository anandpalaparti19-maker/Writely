# Writely — End-to-End QA Checklist

Manual QA pass. Run **after every deploy** before announcing to users. Takes ~30 min with two browsers (one normal, one incognito).

Use **Cashfree TEST mode** (`CASHFREE_ENV=TEST`). Test UPI VPA: `success@gocash`. Test card: `4111 1111 1111 1111`, any CVV, any future expiry.

---

## Test accounts

| Browser | Role | Email | City / Pincode |
|---|---|---|---|
| Chrome | Seeker | `qa-seeker@example.com` | Bengaluru / 560001 |
| Chrome Incognito | Writer A (nearby) | `qa-writer-a@example.com` | Bengaluru / 560001 |
| Firefox | Writer B (same city) | `qa-writer-b@example.com` | Bengaluru / 560068 |
| Firefox Priv | Writer C (other city) | `qa-writer-c@example.com` | Mumbai / 400001 |

---

## 1. Auth & Profile

- [ ] Register seeker — **Detect location** fills city + pincode correctly.
- [ ] Register writer manually — city datalist works; pincode rejects `1234` (must be 6 digits).
- [ ] Firestore `users/<uid>` contains `city`, `cityNormalized`, `pincode`.
- [ ] Login: wrong password → friendly error (not raw Firebase code).
- [ ] **Forgot password** → reset email arrives → reset works → login with new password.
- [ ] Logout clears session (bell icon disappears).

## 2. Posting an Assignment

- [ ] Seeker dashboard → **Post Assignment** modal opens.
- [ ] City & pincode are **pre-filled** from profile.
- [ ] **Detect location** button overrides with current location.
- [ ] Upload a PDF attachment (verify Firebase Storage upload progress).
- [ ] Submit → assignment appears in Projects with status `POSTED`.
- [ ] Firestore doc has `pincode`, `city`, `cityNormalized`, `attachmentUrl`.

## 3. Location-Aware Job Feed (Writer)

- [ ] Writer A → **Browse Jobs → Nearby**: sees the assignment with "Same pincode" badge.
- [ ] Writer B → **Nearby**: empty. **City**: shows it with "Same city" badge.
- [ ] Writer C → **Nearby** & **City**: empty. **All**: shows it.
- [ ] Pagination: post 25+ jobs, scroll → cursor pagination loads more without duplicates.
- [ ] Writers **cannot** see full attachment URL until assigned (only masked preview).

## 4. Bidding

- [ ] Writer A places bid ₹500; Writer B bids ₹400.
- [ ] Seeker Projects page shows 2 bids sorted by amount.
- [ ] Rate limit: spam >20 bids in 10s → backend returns 429.
- [ ] `bids/<id>` doc has `writerId`, `assignmentId`, `amount`, `createdAt`.

## 5. Payment & Escrow

- [ ] Seeker accepts Writer B's bid → Cashfree drop-in opens.
- [ ] Complete ₹400 test payment via UPI `success@gocash`.
- [ ] Redirect succeeds → Projects shows status `ACTIVE`, `activeWriterId = WriterB`.
- [ ] Firestore: `paymentOrders/<id>.status == 'PAID'`, `assignments/<id>.status == 'ACTIVE'`.
- [ ] **Close browser before redirect** on a 2nd test payment → Cashfree webhook still applies order within 30s.
- [ ] Attempt to replay the same `orderId` via verify endpoint → idempotent, no double-credit.
- [ ] Writer A (losing bid) gets notification "Your bid was not selected".

## 6. Attachment Download (assigned writer only)

- [ ] Writer B → Submissions page shows new assignment with **Download** button.
- [ ] Click download → PDF saves locally.
- [ ] Writer A tries the download URL directly → backend returns 403.
- [ ] Log out and hit the signed URL → rejected (auth required).

## 7. Messaging

- [ ] Seeker opens Messages → chat with Writer B appears.
- [ ] Sends "Hello" → Writer B sees it in real-time (<2s).
- [ ] Writer B replies → bell notification on Seeker with unread count.
- [ ] Reload page → messages persist, marked read after open.
- [ ] Writer A (non-assigned) cannot open this chat thread.

## 8. Solution Submission & Review

- [ ] Writer B uploads solution PDF → status becomes `REVIEW`.
- [ ] Seeker downloads solution, clicks **Approve / Mark Complete**.
- [ ] `wallets/<WriterB>.balance` increases by net amount (after platform fee).
- [ ] `transactions` doc created with correct `receiverId = WriterB` and `type = 'payout'`.
- [ ] Platform fee tier applied correctly (check against `logic.js` fee table).
- [ ] Seeker clicks **Leave Review** → modal opens → submit 5★ + comment.
- [ ] `reviews/<id>` doc created; appears on Writer B's public profile.
- [ ] Writer B gets notification "New review received".

## 9. Wallet

- [ ] Seeker → Wallet → Add Funds ₹100 → Cashfree → success → balance +₹100.
- [ ] Transaction list shows top-up row with green +₹100.
- [ ] Writer B → Wallet → Withdraw ₹200 → backend processes → negative row appears.
- [ ] Withdrawal below minimum (e.g. ₹10) → validation error.

## 10. Subscriptions / Pricing

- [ ] Pricing page loads; role toggle switches seeker ↔ writer plans.
- [ ] Click **Upgrade** on Writer Elite → Cashfree → success.
- [ ] `users/<uid>.writerSubscription` updated by backend (not client).
- [ ] Attempting direct Firestore update of `subscription` field from client → rules deny.

## 11. Notifications

- [ ] Bell icon shows unread count on every page.
- [ ] Click bell → dropdown lists latest 20.
- [ ] Click notification → navigates to deep link (project / chat / review).
- [ ] Mark as read → unread count decrements.
- [ ] Firestore: only `read`/`readAt` fields editable by client (rules enforce).

## 12. Security spot-checks

- [ ] As Writer A, call `POST /api/assignments/<other-seeker-id>/release-funds` → 403.
- [ ] As any user, `PUT users/<anotherUid>` in Firestore console from client → rules deny.
- [ ] Webhook endpoint without signature → 400; with bad signature → 401.
- [ ] CORS: request from `evil.example.com` → blocked.
- [ ] Check browser console for Sentry init (if `SENTRY_DSN` set).

## 13. Responsive / Cross-browser

- [ ] iPhone SE (375px): all pages scroll, no horizontal overflow.
- [ ] iPad (768px): sidebar collapses correctly.
- [ ] Desktop 1440px: sidebar visible, pricing page centered.
- [ ] Safari iOS: Cashfree drop-in opens without blank screen.
- [ ] Firefox: geolocation prompt works.

---

## Regression bug log

Add failures here with repro steps; link to GitHub issue.

| Date | Area | Severity | Issue # | Notes |
|---|---|---|---|---|
|  |  |  |  |  |

# 🚀 Writely — Production Deploy & Config Checklist

This guide replaces all previous deployment docs. It includes critical production-hardening steps (Rules 01–50).

---

## 🛠️ Phase 1: Infrastructure (Render & Netlify)

### 1. Backend (API Gateway) — Render
Link your repository and ensure the service points to `gateway/api-gateway`. 

**Environment Variables Checklist:**
| Key | Example | Notes |
| :--- | :--- | :--- |
| `FIREBASE_SERVICE_ACCOUNT` | `{...}` | Full JSON from `serviceAccountKey.json`. |
| `GOOGLE_GENAI_API_KEY` | `AIza...` | **Rule 10**: Rotate before launch! |
| `CASHFREE_APP_ID` | `...` | Your Production Cashfree ID. |
| `CASHFREE_SECRET_KEY` | `...` | **Rule 42**: Required for webhook signatures. |
| `CASHFREE_ENV` | `PROD` | Switches from Sandbox to Production. |
| `MAINTENANCE_MODE` | `false` | **Rule 48**: Set to `true` to pause the app. |
| `SENTRY_DSN` | `...` | **Rule 49**: Highly recommended for error alerts. |

### 2. Frontend (Static) — Netlify
Netlify will automatically detect `netlify.toml`. 
**Verification**: Check that the `API_URL` in `shared/utils/logic.js` is correctly pointing to your Render domain.

---

## 🛡️ Phase 2: Security & Database (Firebase)

### 3. Deploy Firestore Rules (Rule 14 & 19)
The latest rules include the participant-only message lock and the **isNotSuspended** check for banned/deleted users.
```bash
firebase deploy --only firestore:rules
```

### 4. Deploy Firestore Indexes
Required for the Seeker/Writer feeds and the Admin Dashboard filters.
```bash
firebase deploy --only firestore:indexes
```

### 5. Enable Firebase App Check (Rule 32)
1. Go to Firebase Console → App Check.
2. Register your Web App with **reCAPTCHA Enterprise** or v3.
3. Enforce App Check on **Cloud Firestore** and **Storage**.
*This prevents bots and scrapers from accessing your data even if they have your API keys.*

---

## 💳 Phase 3: Financials (Cashfree)

### 6. Production Webhook Setup
1. Log in to **Cashfree Dashboard** (Production).
2. Go to Developers → Webhooks.
3. Add: `https://<your-render-domain>/api/payments/cashfree/webhook`.
4. Enable `PAYMENT_SUCCESS`, `PAYMENT_FAILED`, and `ORDER_PAID`.

---

## 📝 Phase 4: Final Verification

1. **Verify Legal Links**: Confirm that user registration flows link to [Terms of Service](file:///apps/legal/terms.html) (Rule 43).
2. **Test Ban Flow**: Use the [Admin Dashboard](file:///apps/admin-web/admin.html) to ban a test user and verify they are instantly blocked from reading their data in Firestore.
3. **Check Metadata**: Verify that a new assignment creation generates `updatedAt` and `createdBy` fields (Rule 05).

---

## 🚨 Emergency Rollback
*   **Rules**: `git checkout main firestore.rules && firebase deploy --only firestore:rules`
*   **Maintenance**: Toggle `MAINTENANCE_MODE=true` in Render to stop all traffic safely.

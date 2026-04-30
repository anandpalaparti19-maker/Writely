# 📱 Writely Screen Index — Enterprise SaaS Edition

This document maps all user-facing interfaces and dashboards across the reorganized enterprise directory structure.

## 1. Seeker Web Application (`/apps/seeker-web/`)
The primary interface for students and organizations to hire academic experts.

| Screen | File Path | Description |
| :--- | :--- | :--- |
| **Landing Page** | `index.html` | High-conversion entry point for all users. |
| **Identity Hub** | `auth.html` | Unified login/signup glassmorphic interface. |
| **Login** | `login.html` | Dedicated secure access portal. |
| **Registration** | `register.html` | Multi-role onboarding (Seeker/Writer). |
| **Dashboard** | `seeker.html` | Project management, job posting, and escrow. |

## 2. Writer Mobile Application (`/apps/writer-mobile/`)
The workspace for verified academic experts to manage assignments.

| Screen | File Path | Description |
| :--- | :--- | :--- |
| **Dashboard** | `writer.html` | Live job feed, bidding, and wallet tracking. |
| **Onboarding** | `writer_onboarding.html`| Expert verification and KYC flow. |

## 3. Admin & SaaS Management
Internal control panels for platform and tenant governance.

| Screen | File Path | Description |
| :--- | :--- | :--- |
| **Ops Admin** | `/apps/admin-web/admin.html` | Global moderation and transaction monitor. |
| **Tenant Admin**| `/apps/tenant-admin-web/tenant_admin.html` | SaaS Customer dashboard (Agencies/Universities). |

## 4. Technical Blueprinting (`/docs/`)
Architectural maps and system design documentation.

| Blueprint | File Path | Description |
| :--- | :--- | :--- |
| **Master Blueprint**| `writely_ultimate_blueprint.html`| High-fidelity dark-themed architecture map. |
| **SaaS Blueprint** | `writely_saas_architecture.html` | Multi-tenant governance visualization. |
| **v2.0 Blueprint**  | `writely_architecture_v2.html` | Legacy 7-tier architectural mapping. |

## 🚀 Production Integration Status (Session Update)

### 🤖 AI Support Chat (Writely Concierge)
*   **Model:** Upgraded to **Gemini 3 Flash Preview** (April 2026 Edition).
*   **Fixes:**
    *   Resolved `404 Not Found` by identifying available future models.
    *   Fixed `400 Bad Request` by enforcing strict `user`/`model` role-switching logic.
    *   Added local network IP detection in `logic.js` for seamless cross-device development.

### 🌐 Deployment Readiness
*   **Frontend (Netlify):** Configured via `netlify.toml` with root publishing and automated seeker redirects.
*   **Backend (Render/Docker):** Created `Dockerfile` and `render.yaml` for automated Express service deployment.
*   **Repository:** Initialized local Git with a secure `.gitignore` to protect `.env` and Firebase keys.

## 🛠️ Infrastructure & Shared Assets
| Asset | File Path | Description |
| :--- | :--- | :--- |
| **Deployment Config** | `netlify.toml` | Netlify build & routing rules. |
| **Backend Blueprint** | `render.yaml` | Render.com Infrastructure-as-Code. |
| **Containerization** | `gateway/api-gateway/Dockerfile` | Production Node.js image. |
| **Core Logic** | `shared/utils/logic.js` | API Bridge with production fallback. |
| **Design System** | `shared/utils/style.css` | Unified premium aesthetics. |

---

# 📜 Session Chat Log — GitHub Push & Deployment Prep

A chronological transcript of the working session that produced the deployment-ready state above.

## Phase 1 — Initial Git Setup

**Goal:** Initialize the local repository and connect it to GitHub.

```powershell
echo "# Writely" >> README.md
git init
git add README.md
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/ashokkumar-17/Writely.git
git push -u origin main
```

**Outcome:** Push failed. Terminal indicated the repository was not recognized — most likely because the GitHub repo didn't exist yet, or because it was private and required interactive authentication via the Git Credential Manager popup.

**Recommendation given:**
> "Please run `git push -u origin main` in your terminal manually. Running it yourself will allow you to sign in to GitHub (if prompted) and complete the upload."

**Pending payload at that moment:**
- Writely Marketplace complete source code
- Gemini 3 integration for the Concierge
- Production deployment configs (`netlify.toml`, `render.yaml`, `Dockerfile`)
- Secure `.gitignore` protecting secrets

---

## Phase 2 — Diagnosing the Push Failure (1:46 PM)

**User asked:** "can i get the github"

**Investigation result:** The repository `ashokkumar-17/Writely` did not exist on GitHub. The push was returning `Repository not found`, not an authentication error.

**Resolution steps issued:**
1. Open `https://github.com/new`
2. In **Repository name**, type exactly: `Writely`
3. Click the green **Create repository** button (leave it empty — do **not** initialize with README/license/.gitignore, since the local repo already has commits)
4. Re-run:
   ```powershell
   git push -u origin main
   ```

---

## Phase 3 — Documentation Snapshot (2:23 PM)

**User asked:** "make an screen.md file of our all previous chat"

**Action taken:** `docs/screen.md` was updated with:
- 🤖 **AI upgrade notes:** Switch to **Gemini 3 Flash Preview** (April 2026 edition) with role-ordering and 404/400 fixes.
- 🚀 **Deployment mapping:** New entries for `netlify.toml`, `render.yaml`, and `gateway/api-gateway/Dockerfile`.
- 🌐 **Connectivity fixes:** Local network IP detection added to `shared/utils/logic.js` for cross-device development.

**Backend status at session end:** Running locally on port `5001`, successfully communicating with Gemini 3.

---

## Phase 4 — Verification & Audit (Current Session)

### Git Repository State
| Check | Result |
| :--- | :--- |
| Branch | `main` |
| Commits | 2 (`first commit`, `Initial commit: Writely Production Marketplace`) |
| Remote | `https://github.com/ashokkumar-17/Writely.git` |
| `git ls-remote` | ❌ `Repository not found` — confirms the GitHub repo still does not exist |
| Working tree | Clean except `docs/screen.md` (this file) |
| Credential helper | `manager` (Git Credential Manager — will trigger browser sign-in on push) |

### Secrets Hygiene
| File | Tracked? | Status |
| :--- | :--- | :--- |
| `gateway/api-gateway/.env` | No | ✅ Ignored by `.gitignore:7` |
| `gateway/api-gateway/serviceAccountKey.json` | No | ✅ Ignored by `.gitignore:9` |
| `.env.example` | Yes | ✅ Safe (placeholders only) |

### Deployment Config Audit
| File | Verdict | Notes |
| :--- | :--- | :--- |
| `.gitignore` | ✅ Pass | Covers `node_modules`, `.env`, service keys, `*.pem`, build outputs |
| `Dockerfile` | ✅ Pass | Slim Node 20, prod-only deps, exposes 5001 |
| `render.yaml` | ✅ Pass | Defines `writely-api` (web) + `writely-seeker` (static); requires `writely-secrets` env group in Render dashboard |
| `netlify.toml` | ⚠️ Issue | `[[headers]]` blocks with `status = 403` for `/gateway/*`, `/services/*`, `/.env` are syntactically invalid — Netlify silently ignores `status` inside header blocks. To genuinely block these paths, use `[[redirects]]` with `force = true`. **Secrets are unaffected** (they aren't tracked), but raw backend source could be served as static files post-deploy. |

---

## 🧭 Next Steps to Go Live

1. **Create the empty GitHub repo** at `https://github.com/new` → name it exactly `Writely` (no README, no .gitignore, no license).
2. **Push:**
   ```powershell
   git push -u origin main
   ```
   The Git Credential Manager will open a browser window for GitHub sign-in on first push.
3. **(Optional) Fix `netlify.toml`** to use `[[redirects]]` for path blocking.
4. **Connect Netlify** to the GitHub repo → it will auto-detect `netlify.toml`.
5. **Connect Render** to the GitHub repo → it will auto-detect `render.yaml`. Create the `writely-secrets` env group with `GOOGLE_GENAI_API_KEY`, Firebase service account JSON, etc.

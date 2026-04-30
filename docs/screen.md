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

## 🛠️ Shared Assets (`/shared/utils/`)
*   **Design System**: `style.css` (Unified premium aesthetics)
*   **Core Logic**: `logic.js` (API Gateway bridge & simulator)

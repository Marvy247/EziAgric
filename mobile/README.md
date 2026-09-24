# 🌾 Amana Mobile

This folder contains the official React Native mobile client for **Amana**, a decentralized escrow protocol designed to secure agricultural trade across different regions.

Amana eliminates the "Trust Gap" between buyers and sellers using Soroban Smart Contracts on the Stellar network, ensuring fair trade even when parties are hundreds of miles apart.

## About Amana

**Amana** provides a programmable safety net for regional commodity trading:

- **Smart Escrow**: Secure funds holding using cNGN/stablecoins on the Stellar network
- **Dynamic Loss Sharing**: Negotiable risk-sharing ratios (e.g., 50/50, 70/30) for handling transit accidents
- **Proof-of-Delivery (PoD)**: Mandatory video-based verification involving buyer and driver
- **Automated Settlement**: Flat 1% platform fee deducted upon successful trade completion
- **Volatility Protection**: Stellar Path Payments allow users to pay in local currency (NGN) while locking value in cNGN

## Mobile Features

- Wallet-based authentication via Stellar Freighter
- Secure token storage on device
- Offline-aware state management
- Mediator dispute resolution

## Offline handling

Admin operations (stream clawback, lock, terminate) are guarded against
accidental submission when the mobile device is offline.

- **Detection** — built on `@react-native-community/netinfo`. The custom
  hook at `src/hooks/useNetworkStatus.ts` exposes a simple
  `{ isOffline: boolean }` derived from `isInternetReachable` and
  `isConnected`, so the admin screen reacts the moment connectivity is
  lost or restored.
- **Admin UX** — `src/screens/AdminStreamsOverviewScreen.tsx` renders an
  `OfflineBanner` (see `src/components/OfflineBanner.tsx`) at the top of
  the list and disables the **Clawback**, **Lock**, and **Terminate**
  buttons. Disabled buttons carry `accessibilityState={{ disabled: true }}`
  for screen-reader users and drop taps natively, so no submission is
  attempted while offline.
- **Why a hook wrapper** — the hook hides the full `useNetInfo` state,
  which keeps unit tests trivial: mock
  `src/hooks/useNetworkStatus.ts` with one function returning the
  desired `isOffline` value.
- **Caching** — for read-only screens the existing `offlineService`
  (`src/services/offline.service.ts`) already serves cached trades
  from SQLite while offline. Write paths (such as admin actions) are
  intentionally *not* queued and must wait until the device is back
  online.

### Tests

```bash
cd mobile
pnpm test
```

`AdminStreamsOverviewScreen.test.tsx` includes offline scenarios that
assert the banner is shown and that admin submit buttons are disabled
when `useNetworkStatus()` reports `isOffline: true`.

## Tech Stack

- **Framework**: React Native with Expo
- **Language**: TypeScript
- **Navigation**: React Navigation (stack-based)
- **State Management**: Zustand for lightweight store management
- **Wallet**: Stellar Freighter integration
- **Notifications**: Expo Push Notifications / Firebase Cloud Messaging
- **Secure Storage**: Expo Secure Store for token persistence
- **Code Quality**: ESLint, Prettier, TypeScript strict mode

## Getting Started

### Prerequisites

- Node.js 20+ / npm or yarn
- Expo CLI: `npm install -g expo-cli`
- iOS Simulator (on macOS) or Android Emulator

### Install dependencies

```bash
cd mobile
npm install
```

### Environment

Copy the example env file:

```bash
cp .env.example .env.local
```

Configure for your environment:

- `EXPO_PUBLIC_API_URL` – backend API endpoint (default: http://localhost:4000)
- `EXPO_PUBLIC_API_VERSION_PREFIX` – API version prefix (default: `/api/v1`). Leave as-is
  to use the versioned backend lane; set empty to fall back to legacy aliases (deprecated).
  Admin and health endpoints are never versioned.
- `EXPO_PUBLIC_STELLAR_NETWORK` – testnet or public network
- `EXPO_PUBLIC_PUSH_PROVIDER` – expo or firebase
- `EXPO_PUBLIC_CRASH_INGEST_URL` – self-host crash intake (`POST /crash-reports`); see
  [docs/crash-reporting.md](docs/crash-reporting.md)
- `EXPO_PUBLIC_SENTRY_DSN` – optional Sentry DSN (second crash transport)
- `EXPO_PUBLIC_CRASH_RELEASE` – release id attached to crash reports (CI sets this)

### Run in development

```bash
npm start
```

Then select:

- `i` for iOS Simulator
- `a` for Android Emulator
- `w` for web (requires `expo-web`)

### Build for production

```bash
npm run build
```

### Type check

```bash
npm run type-check
```

### Lint

```bash
npm run lint
```

## Project structure

- `src/api/` – API client and service methods, plus admin error mapping ([docs/admin-errors.md](docs/admin-errors.md))
- `src/components/` – Shared UI components (e.g. `AdminErrorBanner`, `CrashErrorBoundary`)
- `src/lib/` – Crash/ANR reporting and PII scrubbing ([docs/crash-reporting.md](docs/crash-reporting.md))
- `src/stores/` – Zustand state management
- `src/screens/` – Screen components
- `src/App.tsx` – Root app component
- `app.config.ts` – Expo configuration

## Crash & ANR reporting

Uncaught exceptions, unhandled promise rejections, render errors caught by
`CrashErrorBoundary`, and ANR-style main-thread stalls are scrubbed of PII
and shipped to the self-host intake (`POST /crash-reports`) with an optional
Sentry transport. A crash spike on a release blocks rollout promotion via
`scripts/check-crash-gate.mjs`. Full pipeline, runbook, and config:
[docs/crash-reporting.md](docs/crash-reporting.md).

## Admin error handling

Backend admin endpoints can return rich error payloads. The mobile app wraps
every Axios error in a typed `AdminApiError`, maps the backend `code` to a
user-friendly view (title / action), and renders it through a single
`AdminErrorBanner` component. 403s and network failures are handled with
the same component (sign-out / retry respectively). All four mobile admin
screens (`AdminStreamsOverview`, `AdminTradesBatch`, `AdminContract`,
`AdminFeatures`) use the same error pattern.

See [`docs/admin-errors.md`](docs/admin-errors.md) for the full code → action
table, the per-screen error-slot model, and how to add a new error code.

## Backend integration

This mobile client integrates with the Amana backend API described in the monorepo documentation.

## Notes

- The mobile app uses the same backend authentication and trade services as the web application.
- Payloads are optimized for low-bandwidth mobile environments.
- Secure token storage prevents credentials from being logged or exposed.

import cors from "cors";
import express from "express";
import helmet from "helmet";
import { errorHandler } from "./middleware/errorHandler";
import { correlationIdMiddleware } from "./middleware/correlationId.middleware";
import { tracingMiddleware } from "./middleware/tracing.middleware";
import loggerMiddleware, { appLogger } from "./middleware/logger";
import { requestIdMiddleware } from "./middleware/requestId";
import { requestLoggerMiddleware } from "./middleware/request.logger.middleware";
import { createHealthRouter } from "./routes/health.routes";
import { createHealthDetailRouter } from "./routes/health.detail.routes";
import { createAdminFeaturesRouter } from "./routes/admin.features.routes";
import { createAdminAuditRouter } from "./routes/admin.audit.routes";
import { createAdminContractRouter } from "./routes/admin.contract.routes";
import { createAdminAuthRouter } from "./routes/admin.auth.routes";
import { createAdminStreamsRouter } from "./routes/admin.streams.routes";
import { createAdminTradeBatchRouter } from "./routes/admin.trades.batch.routes";
import { createAdminPayoutsRouter } from "./routes/admin.payouts.routes";
import { webhooksRoutes } from "./routes/webhooks.routes";
import { inboundWebhooksRoutes } from "./routes/webhooks.inbound.routes";
import { captureRawBody } from "./middleware/webhookSignature.middleware";
import { createAdminDlqRouter } from "./routes/admin.dlq.routes";
import { adminFeatureGate } from "./middleware/adminFeatureGate.middleware";
import { env } from "./config/env";
import { csrfProtection } from "./middleware/csrf.middleware";
import { createOutboxRoutes } from "./routes/outbox.routes";
import { createJobHealthRoutes } from "./routes/job-health.routes";
import { createPublicApiRouter } from "./routes/publicApi.router";
import { createCrashRouter } from "./routes/crash.routes";
import {
  apiVersionMiddleware,
  API_VERSION,
} from "./middleware/apiVersion.middleware";

/** Parse the CORS_ORIGINS env var into a usable allowlist.
 *  Value should be a comma-separated list of allowed origins, e.g.:
 *    CORS_ORIGINS=https://app.amana.com,https://staging.amana.com
 *  Leave empty in development to allow all origins.
 */
function buildCorsOptions(): cors.CorsOptions {
  const raw = process.env.CORS_ORIGINS ?? env.CORS_ORIGINS ?? "";
  const allowlist = raw
    .split(",")
    .map((o: string) => o.trim())
    .filter(Boolean);

  if (allowlist.length === 0) {
    // No allowlist configured — permissive (development only)
    return { origin: true, credentials: true };
  }

  return {
    origin: (origin, callback) => {
      // Allow server-to-server calls (no Origin header)
      if (!origin) return callback(null, true);
      if (allowlist.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials: true,
  };
}

export function createApp(isShuttingDown?: () => boolean): express.Application {
  const app = express();

  if (env.TRUST_PROXY) {
    app.set("trust proxy", 1);
  }

  // Security headers
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          frameSrc: ["'none'"],
          objectSrc: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: true,
      crossOriginOpenerPolicy: { policy: "same-origin" },
      crossOriginResourcePolicy: { policy: "same-origin" },
      referrerPolicy: { policy: "no-referrer" },
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
      noSniff: true,
      frameguard: { action: "deny" },
      xssFilter: true,
    }),
  );

  // Environment-driven CORS
  app.use(cors(buildCorsOptions()));

  // Body size limits: 100 KB for JSON, 5 MB for URL-encoded (covers file references)
  // `verify` stashes the exact received bytes on the request: inbound webhook
  // signatures cover the raw payload, and re-serialising `req.body` would not
  // reproduce it byte for byte.
  app.use(express.json({ limit: "100kb", verify: captureRawBody }));
  app.use(express.urlencoded({ extended: true, limit: "5mb" }));

  // Correlation ID must be registered before the logger so every log line
  // produced by pino-http already carries the tracing IDs.
  app.use(correlationIdMiddleware);
  // OpenTelemetry tracing middleware - integrates with correlation IDs
  app.use(tracingMiddleware);
  app.use(loggerMiddleware);
  // Structured per-request logger: method, path, status, durationMs, correlationId, userId, userAgent, ip
  app.use(requestLoggerMiddleware);

  // Enhanced health check with deep introspection
  app.use("/health", createHealthRouter(isShuttingDown));
  app.use("/health", createHealthDetailRouter());

  // Resolve and signal the API version served by a request. Placed before the
  // public mounts so both the versioned and legacy lanes are tagged; admin and
  // health requests remain "unversioned" and receive no deprecation headers.
  app.use(apiVersionMiddleware);

  // The public API is served on TWO lanes sharing one router, so behaviour is
  // identical by construction:
  //  1. `/api/v1`  — the stable, versioned lane (current version).
  //  2. legacy aliases (`/auth`, `/trades`, ...) — deprecated backwards-
  //     compatibility lane for shipped mobile/web builds that are slow to update.
  const publicApi = createPublicApiRouter();
  app.use(`/api/${API_VERSION}`, publicApi);
  // v1 must be registered first so /api/v1/* never falls through to the root
  // legacy mount. The legacy lane is mounted at "/" to preserve every current
  // URL exactly.
  app.use("/", publicApi);

  // Feature flags (admin-managed) — gated by ADMIN_ROUTES_ENABLED
  app.use(adminFeatureGate, csrfProtection, createAdminFeaturesRouter());

  // Admin action audit history: GET /admin/audit
  app.use(adminFeatureGate, csrfProtection, createAdminAuditRouter());

  // Admin contract maintenance/governance: mediators, fee rate
  app.use(adminFeatureGate, csrfProtection, createAdminContractRouter());

  // Admin auth diagnostics: GET /api/admin/auth/claims
  app.use(adminFeatureGate, csrfProtection, createAdminAuthRouter());

  // Admin trade batch operations: POST /admin/trades/batch/status
  app.use(adminFeatureGate, csrfProtection, createAdminTradeBatchRouter());

  // Admin payout idempotency: POST /api/admin/payouts/reconcile, GET /api/admin/payouts/pending
  app.use(adminFeatureGate, csrfProtection, createAdminPayoutsRouter());

  // Admin stream management: POST /api/admin/streams/:id/clawback/preview, POST /api/admin/streams/:id/suspend, POST /api/admin/streams/:id/resume
  app.use("/api", adminFeatureGate, csrfProtection, createAdminStreamsRouter());

  // Inbound provider callbacks. Mounted before the CRUD router so `/inbound/*`
  // never falls through to it, and on its own path so the HMAC guard sits at
  // the router level and covers every provider route by construction.
  app.use("/webhooks/inbound", inboundWebhooksRoutes);
  // Webhooks: CRUD /webhooks
  app.use("/webhooks", webhooksRoutes);

  // Admin outbox consistency monitoring: GET /admin/outbox/health, GET /admin/outbox/gaps
  app.use(adminFeatureGate, csrfProtection, createOutboxRoutes());

  // Job heartbeat health dashboard: GET /health/jobs, GET /health/jobs/:jobType
  app.use("/health", createJobHealthRoutes());

  // Mobile crash / ANR intake (issue #263). Unversioned and mounted outside
  // the public API lanes — shipped mobile builds must not break when the
  // consumer API version changes.
  app.use("/crash-reports", createCrashRouter());

  // Admin dead-letter queue inspection/replay: GET /api/admin/dlq/:queue, POST /api/admin/dlq/:queue/:jobId/replay
  app.use(adminFeatureGate, csrfProtection, createAdminDlqRouter());

  // Error handler is registered last so it catches errors from all routes,
  // including any routes added to the app after createApp() returns.
  // We achieve this by re-registering it whenever a new route/middleware is added.
  const _originalUse = app.use.bind(app);
  const _originalGet = (app as any).get.bind(app);

  function reRegisterErrorHandler() {
    // Remove the existing error handler layer and re-add it at the end.
    // Express 5 exposes the router via app.router (lazy getter).
    const router = (app as any).router;
    if (!router) return;
    const stack: any[] = router.stack;
    // Find last occurrence of the error handler layer (scan from end)
    let errIdx = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].handle === errorHandler) {
        errIdx = i;
        break;
      }
    }
    if (errIdx !== -1) stack.splice(errIdx, 1);
    _originalUse(errorHandler);
  }

  (app as any).use = function (...args: any[]) {
    const result = _originalUse(...args);
    reRegisterErrorHandler();
    return result;
  };

  (app as any).get = function (...args: any[]) {
    const result = _originalGet(...args);
    reRegisterErrorHandler();
    return result;
  };

  // Initial registration
  app.use(errorHandler);

  return app;
}

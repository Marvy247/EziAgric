import { z } from 'zod';

// ---------------------------------------------------------------------------
// Fail-fast, typed environment validation at boot.
//
// The schema is loaded once and parsed strictly. On any invalid input the boot
// fails with an aggregated, actionable report listing ALL invalid variables
// (zod's safeParse collects every issue, not just the first), with any
// secret-shaped values redacted from diagnostic output.
// ---------------------------------------------------------------------------

/** Env keys whose values are secrets and must never appear in logs/errors. */
export const SECRET_ENV_KEYS: ReadonlySet<string> = new Set([
  'JWT_SECRET',
  'ADMIN_SECRET_KEY',
  'IPFS_URL_SIGNING_SECRET',
  'WEBHOOK_SECRET',
  'ALERT_WEBHOOK_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY',
  'AUDIT_SIGNING_PRIVATE_KEY_PEM',
  'AUDIT_SIGNING_PUBLIC_KEY_PEM',
  'PINATA_SECRET',
  'PINATA_JWT',
  'PINATA_API_KEY',
]);

/** Redact a raw env value if it corresponds to a secret key. */
export function redactEnvValue(key: string, value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return String(value ?? '');
  }
  if (SECRET_ENV_KEYS.has(key)) {
    return '***REDACTED***';
  }
  return String(value);
}

function normalizeEnvInput(raw: Record<string, string | undefined>): Record<string, string | undefined> {
  const normalized = { ...raw };

  if (!normalized.AMANA_ESCROW_CONTRACT_ID && normalized.CONTRACT_ID) {
    normalized.AMANA_ESCROW_CONTRACT_ID = normalized.CONTRACT_ID;
  }

  if (!normalized.STELLAR_RPC_URL && normalized.SOROBAN_RPC_URL) {
    normalized.STELLAR_RPC_URL = normalized.SOROBAN_RPC_URL;
  }

  if (normalized.STELLAR_NETWORK) {
    normalized.STELLAR_NETWORK = normalized.STELLAR_NETWORK.toLowerCase();
  }

  return normalized;
}

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'staging', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('86400'),
  JWT_ISSUER: z.string().default('amana'),
  JWT_AUDIENCE: z.string().default('amana-api'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  CORS_ORIGINS: z.string().default(''),
  DATABASE_URL: z.string(),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  API_PUBLIC_URL: z.string().url().optional(),

  // Stellar / Soroban
  STELLAR_NETWORK: z
    .string()
    .default('testnet')
    .transform((value: string) => (value.toLowerCase() === 'mainnet' ? 'mainnet' : 'testnet')),
  STELLAR_NETWORK_PASSPHRASE: z.string().optional(),
  STELLAR_RPC_URL: z.string().optional(),
  SOROBAN_RPC_URL: z.string().optional(),
  /** @deprecated Use AMANA_ESCROW_CONTRACT_ID */
  CONTRACT_ID: z.string().min(1).optional(),
  AMANA_ESCROW_CONTRACT_ID: z.string().min(1),
  USDC_CONTRACT_ID: z.string().min(1),

  // Access control
  ADMIN_STELLAR_PUBKEYS: z.string().default(''),

  // Pinata / IPFS
  PINATA_API_KEY: z.string().optional(),
  PINATA_SECRET: z.string().optional(),
  PINATA_JWT: z.string().optional(),
  IPFS_GATEWAY_URL: z.string().default('https://gateway.pinata.cloud/ipfs'),
  IPFS_GATEWAY_URLS: z.string().optional(),
  IPFS_GATEWAY_ALLOWLIST: z.string().default(''),
  IPFS_UPLOAD_TIMEOUT_MS: z.coerce.number().default(10000),
  IPFS_STREAM_TIMEOUT_MS: z.coerce.number().default(5000),
  IPFS_PINATA_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().default(3),
  IPFS_PINATA_CIRCUIT_COOLDOWN_MS: z.coerce.number().default(30000),
  IPFS_GATEWAY_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().default(3),
  IPFS_GATEWAY_CIRCUIT_COOLDOWN_MS: z.coerce.number().default(30000),
  // Used by a signature-aware private gateway when issuing evidence downloads.
  // In development it falls back to JWT_SECRET so URLs are still testable.
  IPFS_URL_SIGNING_SECRET: z.string().min(32).optional(),
  IPFS_URL_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(300),

  // Evidence / manifest retention
  EVIDENCE_MAX_BYTES: z.coerce.number().default(52428800),
  EVIDENCE_METADATA_RETENTION_DAYS: z.coerce.number().default(90),
  EVIDENCE_SCAN_REQUIRED: z
    .string()
    .default('false')
    .transform((value: string) => value.toLowerCase() === 'true'),
  MANIFEST_PII_RETENTION_DAYS: z.coerce.number().default(30),

  // Soroban event listener
  EVENT_POLL_INTERVAL_MS: z.coerce.number().default(10000),
  BACKOFF_INITIAL_MS: z.coerce.number().default(1000),
  BACKOFF_MAX_MS: z.coerce.number().default(30000),
  PROCESSED_LEDGERS_CACHE_SIZE: z.coerce.number().default(10000),
  EVENT_OUTBOX_MAX_ATTEMPTS: z.coerce.number().default(5),

  // Distributed tracing
  JAEGER_ENDPOINT: z.string().optional(),
  ZIPKIN_ENDPOINT: z.string().optional(),
  PROMETHEUS_PORT: z.coerce.number().optional(),
  OTEL_SERVICE_NAME: z.string().optional(),
  OTEL_EXPORTER_JAEGER_AGENT_HOST: z.string().optional(),
  OTEL_EXPORTER_JAEGER_AGENT_PORT: z.coerce.number().optional(),
  // Tail-based trace sampling (#231)
  TRACE_BASELINE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  TRACE_SLOW_THRESHOLD_MS: z.coerce.number().int().positive().default(2000),
  TRACE_ROUTE_OVERRIDES: z.string().default("{}"),

  // Audit signing
  AUDIT_SIGNING_KEY_ID: z.string().min(1).optional(),
  AUDIT_SIGNING_PRIVATE_KEY_PEM: z.string().min(1).optional(),
  AUDIT_SIGNING_PUBLIC_KEY_PEM: z.string().min(1).optional(),

  // Webhooks
  WEBHOOK_URL: z.string().url().optional(),
  WEBHOOK_SECRET: z.string().optional(),
  // Ops alert webhook configuration
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  ALERT_WEBHOOK_SECRET: z.string().optional(),
  ALERT_COOLDOWN_MS: z.coerce.number().default(300_000),
  // Mobile crash intake spike detection (issue #263)
  CRASH_SPIKE_THRESHOLD: z.coerce.number().int().positive().default(10),
  CRASH_SPIKE_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  CRASH_INTAKE_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),
  // Admin Soroban tx failure alert tuning
  ADMIN_TX_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  ADMIN_TX_FAILURE_WINDOW_MS: z.coerce.number().int().positive().default(300_000),
  // Inbound webhook signature verification.
  // JSON object of provider -> secret, e.g. {"stellar-anchor":"s3cr3t"}. A
  // provider may hold comma-separated secrets so old and new overlap during a
  // rotation; see backend/docs/webhook-secret-rotation.md.
  INBOUND_WEBHOOK_SECRETS: z.string().optional(),
  // Replay window, in seconds, for the signed inbound webhook timestamp.
  INBOUND_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  WEBHOOK_RETRY_BASE_MS: z.coerce.number().int().positive().default(1000),
  WEBHOOK_RETRY_MAX_MS: z.coerce.number().int().positive().default(30000),
  ADMIN_STATS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  // Rate limiting configuration
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value: 'true' | 'false') => value === 'true'),
  RATE_LIMIT_AUTH_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_AUTH_REFRESH_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  RATE_LIMIT_AUTH_REFRESH_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_USER_WINDOW_MS: z.coerce.number().int().positive().default(60 * 1000),
  RATE_LIMIT_USER_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_DISPUTE_WINDOW_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),
  RATE_LIMIT_DISPUTE_MAX: z.coerce.number().int().positive().default(5),
  // Admin operation quotas (high-volume/expensive operations e.g. treasury clawback, batch updates)
  ADMIN_QUOTA_CLAWBACK_WINDOW_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),
  ADMIN_QUOTA_CLAWBACK_MAX: z.coerce.number().int().positive().default(10),
  ADMIN_QUOTA_TRADE_BATCH_WINDOW_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),
  ADMIN_QUOTA_TRADE_BATCH_MAX: z.coerce.number().int().positive().default(20),
  // Retry/backoff for admin Soroban transaction submission (transient RPC failures)
  SOROBAN_SUBMIT_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  SOROBAN_SUBMIT_BACKOFF_MS: z.string().default('1000,2000,4000,8000'),
  // Hard wall-clock timeout (ms) for admin routes that build Soroban transactions via RPC
  ADMIN_ROUTE_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

  // Feature flag to enable/disable admin routes at startup (defaults to disabled)
  ADMIN_ROUTES_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value: 'true' | 'false') => value === 'true'),

  // Required when admin routes are mounted (server-side Stellar signing key for admin ops)
  ADMIN_SECRET_KEY: z.string().min(1),

  // Path payment quote cache
  QUOTE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  QUOTE_MAX_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10_000).default(500),

  // Daily reconciliation thresholds (BPS deviation)
  RECONCILIATION_WARNING_THRESHOLD_BPS: z.coerce.number().int().min(0).default(100),
  RECONCILIATION_CRITICAL_THRESHOLD_BPS: z.coerce.number().int().min(0).default(1000),
  RECONCILIATION_CRON_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value: 'true' | 'false') => value === 'true'),

  // Buffered Stellar fee estimation (congestion resilience) — see feeEstimator.service.ts
  STELLAR_FEE_PERCENTILE: z
    .enum(['p10', 'p20', 'p30', 'p40', 'p50', 'p60', 'p70', 'p80', 'p90', 'p95', 'p99'])
    .default('p90'),
  STELLAR_FEE_SAFETY_MULTIPLIER: z.coerce.number().positive().default(1.5),
  STELLAR_FEE_CONGESTION_BOOST: z.coerce.number().min(1).default(2),
  STELLAR_FEE_CONGESTION_CAPACITY: z.coerce.number().min(0).max(1).default(0.75),
  STELLAR_FEE_CONGESTION_FEE_RATIO: z.coerce.number().min(1).default(4),
  STELLAR_FEE_MIN_STROOPS: z.coerce.number().int().positive().default(100),
  STELLAR_FEE_MAX_STROOPS: z.coerce.number().int().positive().default(1_000_000),
  STELLAR_FEE_BUMP_FACTOR: z.coerce.number().gt(1).default(1.5),
  STELLAR_FEE_MAX_RETRIES: z.coerce.number().int().min(0).default(3),

  // Admin session device binding (issue #198) — see lib/deviceContext.ts,
  // services/adminSession.service.ts. Off by default so plain admin bearers
  // keep working until a deployment opts in.
  ADMIN_SESSION_BINDING_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value: 'true' | 'false') => value === 'true'),
  // When binding is enabled, also reject admin bearers that carry no device
  // binding at all (instead of allowing them through the transition window).
  ADMIN_SESSION_BINDING_ENFORCE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value: 'true' | 'false') => value === 'true'),
  // TTL (seconds) for a device-bound admin token minted by /api/admin/auth/step-up.
  ADMIN_BOUND_JWT_EXPIRES_IN: z.coerce.number().int().positive().default(900),
  ADMIN_IP_V4_PREFIX_BITS: z.coerce.number().int().min(0).max(32).default(24),
  ADMIN_IP_V6_PREFIX_BITS: z.coerce.number().int().min(0).max(128).default(48),

  // PII log-leak scanner (#233)
  PII_SCANNER_CRON_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value: 'true' | 'false') => value === 'true'),
  PII_SCANNER_SAMPLE_SIZE: z.coerce.number().int().positive().default(2000),
});

export type Env = z.infer<typeof envSchema>;

/**
 * A single configuration problem discovered at boot. The `value` field is
 * always redacted (secrets never appear in diagnostics).
 */
export interface EnvIssue {
  /** Env var name (uppercase). */
  key: string;
  /** Human-readable problem. */
  message: string;
  /** Redacted value — secrets never appear, e.g. `***REDACTED***` or `(empty)`. */
  value: string;
}

/**
 * Raised at boot when the environment is invalid. Carries an aggregated,
 * ordered report of every problem so operators see the whole picture rather
 * than the first failure.
 */
export class EnvironmentValidationError extends Error {
  constructor(
    public readonly issues: EnvIssue[],
    public readonly envName: string,
  ) {
    super(
      `Environment validation failed for NODE_ENV="${envName}" with ${issues.length} issue(s):\n` +
        issues
          .map((i) => `  - ${i.key}: ${i.message} (present value: ${i.value})`)
          .join('\n'),
    );
    this.name = 'EnvironmentValidationError';
  }
}

function describeValue(key: string, value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return '(empty)';
  }
  return redactEnvValue(key, value);
}

/**
 * Env-specific requirements beyond the shared schema. Returns additional
 * issues for the given (already normalized) input and parsed NODE_ENV.
 */
export function getEnvSpecificIssues(
  normalized: Record<string, string | undefined>,
): EnvIssue[] {
  const nodeEnv = (normalized.NODE_ENV ?? 'development').toLowerCase();
  const issues: EnvIssue[] = [];

  if (nodeEnv === 'production') {
    // Production must export telemetry to a real backend, not default to
    // localhost. Without this the pod silently drops traces on startup.
    const hasTraceBackend = Boolean(
      normalized.JAEGER_ENDPOINT ||
        normalized.ZIPKIN_ENDPOINT ||
        normalized.OTEL_EXPORTER_JAEGER_AGENT_HOST ||
        normalized.OTEL_EXPORTER_OTLP_ENDPOINT,
    );
    if (!hasTraceBackend) {
      issues.push({
        key: 'JAEGER_ENDPOINT',
        message:
          'NODE_ENV=production requires a tracing backend (set JAEGER_ENDPOINT, ZIPKIN_ENDPOINT, or OTEL exporter) to prevent silent observability loss',
        value: '(empty)',
      });
    }
  }

  return issues;
}

/** Parse and validate input, returning all issues (schema + env-specific). */
export function collectEnvIssues(
  input: Record<string, string | undefined>,
): EnvIssue[] {
  const normalized = normalizeEnvInput(input);
  const issues: EnvIssue[] = [];

  const parsed = envSchema.safeParse(normalized);
  if (!parsed.success) {
    for (const err of parsed.error.errors) {
      const key = String(err.path[0] ?? '');
      issues.push({
        key,
        message: err.message,
        value: describeValue(key, normalized[key]),
      });
    }
  }

  issues.push(...getEnvSpecificIssues(normalized));
  return issues;
}

/** Validate input and throw an aggregated EnvironmentValidationError on failure. */
export function assertValidEnv(input: Record<string, string | undefined>): void {
  const issues = collectEnvIssues(input);
  if (issues.length > 0) {
    const nodeEnv = (normalizeEnvInput(input).NODE_ENV ?? 'development').toLowerCase();
    throw new EnvironmentValidationError(issues, nodeEnv);
  }
}

function buildProcessEnv(): Record<string, string | undefined> {
  const processEnv = normalizeEnvInput({ ...process.env });

  if (processEnv.NODE_ENV === 'test') {
    processEnv.JWT_SECRET ||= 'test-jwt-secret-value-with-minimum-length-32';
    processEnv.DATABASE_URL ||= 'postgresql://localhost:5432/test';
    processEnv.AMANA_ESCROW_CONTRACT_ID ||= 'test-escrow-contract';
    processEnv.USDC_CONTRACT_ID ||= 'test-usdc-contract';
    processEnv.PINATA_API_KEY ||= 'test-pinata-api-key';
    processEnv.PINATA_SECRET ||= 'test-pinata-secret';
    processEnv.ADMIN_SECRET_KEY ||= 'test-admin-secret-key-value';
  }

  return processEnv;
}

export function parseEnvConfig(input: Record<string, string | undefined>) {
  return envSchema.safeParse(normalizeEnvInput(input));
}

/** The parsed, validated environment singleton used across the application. */
export function buildEnv(): Env {
  const raw = buildProcessEnv();
  assertValidEnv(raw);
  return envSchema.parse(raw);
}

/**
 * Render the aggregated validation report as a multi-line, redacted string
 * suitable for the boot log / stderr.
 */
export function formatEnvReport(issues: EnvIssue[]): string {
  const lines = issues.map(
    (i) => `  - ${i.key}: ${i.message} (present value: ${i.value})`,
  );
  return lines.join('\n');
}

/**
 * Build and validate the application environment singleton at module load.
 *
 * On invalid config this prints a clean, redacted, aggregated report to stderr
 * and exits with a non-zero code — so a partially-configured process never
 * reaches `listen()` and never fails lazily on first use.
 */
function loadEnvSingleton(): Env {
  try {
    const raw = buildProcessEnv();
    assertValidEnv(raw);
    return envSchema.parse(raw);
  } catch (err) {
    if (err instanceof EnvironmentValidationError) {
      // NODE_ENV is required before pino; log directly to stderr.
      console.error(
        `\n[FATAL] Environment validation failed for NODE_ENV="${err.envName}" with ${err.issues.length} issue(s):\n` +
          formatEnvReport(err.issues) +
          '\n\nFix the variables above and restart. Secrets are redacted.\n',
      );
      process.exit(1);
    }
    throw err;
  }
}

export const env = loadEnvSingleton();

/**
 * Prefer runtime process.env overrides so tests can mutate env without reload.
 */
export function runtimeEnvValue<K extends keyof Env>(key: K): Env[K] {
  const runtime = process.env[key as string];
  if (runtime !== undefined) {
    const parsed = envSchema.shape[key].safeParse(runtime);
    if (parsed.success) {
      return parsed.data as Env[K];
    }
  }
  return env[key];
}

/**
 * Produce a sanitized "effective config" fingerprint for the boot log.
 *
 * Non-secret values are shown literally; secret-shaped values are redacted to a
 * fixed `***REDACTED***` marker so the boot log confirms which secrets are
 * present without ever exposing them. Only keys present in the schema are
 * emitted.
 */
export function formatConfigFingerprint(
  input: Record<string, string | undefined>,
): Record<string, string> {
  const normalized = normalizeEnvInput(input);
  const fingerprint: Record<string, string> = {};
  const schemaKeys = new Set(Object.keys(envSchema.shape));

  for (const key of schemaKeys) {
    const raw = normalized[key];
    if (raw === undefined || raw === '') {
      fingerprint[key] = '(empty)';
      continue;
    }
    if (SECRET_ENV_KEYS.has(key)) {
      fingerprint[key] = redactEnvValue(key, raw);
      continue;
    }
    fingerprint[key] = raw;
  }
  return fingerprint;
}

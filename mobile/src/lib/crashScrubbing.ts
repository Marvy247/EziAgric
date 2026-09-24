/**
 * PII scrubbing for outbound crash/ANR payloads (issue #263).
 *
 * Mirrors the semantics of backend/src/lib/logRedaction.ts and the privacy
 * rules in docs/METRICS.md so a crash report can never carry PII that the
 * log pipeline would have redacted:
 *
 *  1. Field-name denylist — keys that look like they hold PII are fully
 *     replaced regardless of value.
 *  2. Pattern pass — email / phone / wallet / IP shaped substrings inside
 *     free-text (error messages, stacks) are scrubbed. Deliberately
 *     conservative: never redacts arbitrary digit runs, which would destroy
 *     trade/ledger ids in stack traces.
 *
 * Both `error.message` AND `error.stack` are scrubbed — a stack's first
 * line embeds the original message.
 *
 * Enforcement: `__tests__/crashReporter.test.ts` asserts PII is absent from
 * the *serialized* outbound payload, not just from the scrub function.
 */

export const REDACTED = '[REDACTED]';

const PII_FIELD_DENYLIST = new Set(
  [
    'email',
    'emailaddress',
    'phone',
    'phonenumber',
    'mobile',
    'mobilenumber',
    'msisdn',
    'ssn',
    'nationalid',
    'idnumber',
    'driveridnumber',
    'passportnumber',
    'dateofbirth',
    'dob',
    'homeaddress',
    'streetaddress',
    'postaladdress',
    'drivername',
    'buyername',
    'sellername',
    'customername',
    'contactname',
    'fullname',
    'firstname',
    'lastname',
    'password',
    'passwordhash',
    'pin',
    'otp',
    'cvv',
    'cardnumber',
    'creditcardnumber',
    'secretkey',
    'privatekey',
    'walletsecret',
    'seedphrase',
    'mnemonic',
    'sessiontoken',
    'authorization',
    'authtoken',
    'accesstoken',
    'refreshtoken',
    'apikey',
    'cookie',
    'wallet',
  ].map(normalizeFieldName),
);

function normalizeFieldName(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, '');
}

function isDenylistedField(key: string): boolean {
  return PII_FIELD_DENYLIST.has(normalizeFieldName(key));
}

export const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
export const PHONE_PATTERN =
  /(?:\+\d{6,15})|(?:\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b)|(?:\b\(\d{2,4}\)[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b)/g;
export const WALLET_PATTERN = /\b0x[a-fA-F0-9]{40}\b|\b[46][a-zA-Z0-9]{48,56}\b/g;
export const IP_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

function scrubString(value: string): string {
  return value
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]')
    .replace(PHONE_PATTERN, '[REDACTED_PHONE]')
    .replace(WALLET_PATTERN, '[REDACTED_WALLET]')
    .replace(IP_PATTERN, '[REDACTED_IP]');
}

const MAX_DEPTH = 8;

export function scrubCrashValue<T>(value: T, seen: WeakSet<object> = new WeakSet(), depth = 0): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return scrubString(value) as unknown as T;
  }

  if (typeof value !== 'object' || depth >= MAX_DEPTH) {
    return value;
  }

  if (value instanceof Date) {
    return value;
  }

  if (value instanceof Error) {
    const scrubbed = new Error(scrubString(value.message));
    scrubbed.name = value.name;
    scrubbed.stack = value.stack ? scrubString(value.stack) : value.stack;
    return scrubbed as unknown as T;
  }

  if (seen.has(value as object)) {
    return '[CIRCULAR]' as unknown as T;
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => scrubCrashValue(item, seen, depth + 1)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (isDenylistedField(key)) {
      result[key] = val === null || val === undefined ? val : REDACTED;
      continue;
    }
    result[key] = scrubCrashValue(val, seen, depth + 1);
  }
  return result as T;
}

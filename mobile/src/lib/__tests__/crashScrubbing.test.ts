import { scrubCrashValue, REDACTED } from '../crashScrubbing';

describe('scrubCrashValue', () => {
  it('redacts denylisted fields regardless of value', () => {
    const result = scrubCrashValue({
      email: 'buyer@example.com',
      password: 'hunter2',
      privateKey: 'SABC',
      sessionToken: 'tok',
      wallet: 'GCW4GQJ2XQ...long',
      ok: 'trade_123',
    });
    expect(result.email).toBe(REDACTED);
    expect(result.password).toBe(REDACTED);
    expect(result.privateKey).toBe(REDACTED);
    expect(result.sessionToken).toBe(REDACTED);
    expect(result.wallet).toBe(REDACTED);
    expect(result.ok).toBe('trade_123');
  });

  it('scrubs email/phone/wallet/ip patterns in free text', () => {
    expect(scrubCrashValue('login failed for alice@farm.io')).toContain('[REDACTED_EMAIL]');
    expect(scrubCrashValue('call +234 801 234 5678 now')).toContain('[REDACTED_PHONE]');
    expect(scrubCrashValue('addr 0x0123456789abcdef0123456789abcdef01234567')).toContain(
      '[REDACTED_WALLET]',
    );
    expect(scrubCrashValue('from 192.168.10.44')).toContain('[REDACTED_IP]');
  });

  it('does not redact trade/ledger id digit runs', () => {
    const id = 'trade_4294967297_seq_1234567';
    expect(scrubCrashValue(id)).toBe(id);
  });

  it('scrubs both message and stack of Error instances', () => {
    const err = new Error('boom alice@farm.io');
    err.stack = `Error: boom alice@farm.io\n    at run (file:///app/index.js:1:1)`;
    const result = scrubCrashValue(err);
    expect(result.message).not.toContain('alice@farm.io');
    expect(result.stack).not.toContain('alice@farm.io');
  });

  it('handles nested objects and circular references', () => {
    const nested: Record<string, unknown> = { outer: { email: 'a@b.co' } };
    expect((nested.outer as Record<string, string>).email).toBeDefined();
    const scrubbed = scrubCrashValue(nested) as { outer: { email: string } };
    expect(scrubbed.outer.email).toBe(REDACTED);

    const circular: Record<string, unknown> = { name: 'x' };
    circular.self = circular;
    expect(() => scrubCrashValue(circular)).not.toThrow();
  });
});

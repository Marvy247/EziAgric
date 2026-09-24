import { serializeCrashPayload, reportCrash } from '../crashReporter';

describe('crashReporter payload', () => {
  it('produces a serialized payload with no PII (inspection test)', () => {
    const body = serializeCrashPayload({
      kind: 'crash',
      message: 'auth failed for alice@farm.io phone +234 801 234 5678',
      stack: `Error: auth failed for alice@farm.io\n    at verify (auth.ts:10:5)`,
      route: 'WalletConnect',
      meta: {
        password: 'hunter2',
        wallet: 'GCW4GQJ2XQabcdefghijklmnopqrstuvwxyz0123456789ABCD',
        note: 'contact bob@farm.io',
      },
    });

    expect(body).not.toMatch(/alice@farm\.io/);
    expect(body).not.toMatch(/bob@farm\.io/);
    expect(body).not.toContain('+234 801 234 5678');
    expect(body).not.toContain('hunter2');
    expect(body).not.toMatch(/GCW4GQJ2XQabc/);
    expect(body).toContain('[REDACTED');
    expect(body).toContain('"kind":"crash"');
    expect(body).toContain('"fatal":true');
  });

  it('keeps non-PII diagnostics intact', () => {
    const body = serializeCrashPayload({
      kind: 'anr',
      message: 'Main thread stalled for 5200ms (ANR watchdog)',
      route: 'TradeList',
    });
    expect(body).toContain('ANR watchdog');
    expect(body).toContain('TradeList');
    expect(body).toContain('"kind":"anr"');
  });

  it('reportCrash never throws for malformed input', () => {
    expect(() => {
      reportCrash({ kind: 'crash', message: '' });
      reportCrash({
        kind: 'handled',
        message: 'x',
        meta: (() => {
          const circular: Record<string, unknown> = {};
          circular.self = circular;
          return circular;
        })(),
      });
    }).not.toThrow();
  });
});

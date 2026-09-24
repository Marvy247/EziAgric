import express from "express";
import request from "supertest";
import {
  createCrashRouter,
  recordCrashForSpikeDetection,
  resetCrashSpikeStateForTests,
} from "../routes/crash.routes";

const mockWarn = jest.fn();
const mockInfo = jest.fn();
const mockDebug = jest.fn();
const mockError = jest.fn();
const mockDispatch = jest.fn();

jest.mock("../middleware/logger", () => ({
  __esModule: true,
  default: (_req: unknown, _res: unknown, next: () => void) => next(),
  appLogger: {
    info: (...args: unknown[]) => mockInfo(...args),
    warn: (...args: unknown[]) => mockWarn(...args),
    error: (...args: unknown[]) => mockError(...args),
    debug: (...args: unknown[]) => mockDebug(...args),
    child: () => ({
      info: (...args: unknown[]) => mockInfo(...args),
      warn: (...args: unknown[]) => mockWarn(...args),
      error: (...args: unknown[]) => mockError(...args),
      debug: (...args: unknown[]) => mockDebug(...args),
    }),
  },
}));

jest.mock("../services/alert.service", () => ({
  alertService: {
    dispatch: (...args: unknown[]) => mockDispatch(...args),
    isConfigured: () => true,
    resetCooldown: jest.fn(),
  },
}));

function buildApp(): express.Application {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.use("/crash-reports", createCrashRouter());
  return app;
}

const VALID_BODY = {
  kind: "crash",
  release: "0.1.0 (42)",
  platform: "ios/android",
  appVersion: "0.1.0",
  message: "auth failed for alice@farm.io",
  stack: "Error: auth failed for alice@farm.io\n    at verify (auth.ts:10:5)",
  route: "WalletConnect",
  fatal: true,
  timestamp: "2026-09-24T00:00:00.000Z",
  meta: {
    password: "hunter2",
    wallet: "GCW4GQJ2XQabcdefghijklmnopqrstuvwxyz0123456789ABCD",
  },
};

describe("POST /crash-reports", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetCrashSpikeStateForTests();
  });

  it("accepts a valid crash report", async () => {
    const res = await request(buildApp()).post("/crash-reports").send(VALID_BODY);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
  });

  it("logs only the PII-scrubbed payload (inspection test)", async () => {
    await request(buildApp()).post("/crash-reports").send(VALID_BODY);

    expect(mockWarn).toHaveBeenCalled();
    const record = mockWarn.mock.calls[0][0] as { crashReport: Record<string, unknown> };
    const serialized = JSON.stringify(record);
    expect(serialized).not.toMatch(/alice@farm\.io/);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toMatch(/GCW4GQJ2XQabc/);
    expect(serialized).toContain("[REDACTED");
  });

  it("rejects malformed payloads", async () => {
    const res = await request(buildApp()).post("/crash-reports").send({ kind: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_crash_report");
  });

  it("dispatches mobile_crash_spike when the threshold is crossed", async () => {
    const now = Date.now();
    for (let i = 0; i < 9; i++) {
      recordCrashForSpikeDetection("0.1.0", now - 1000, 900_000, 10);
    }
    const spiked = recordCrashForSpikeDetection("0.1.0", now, 900_000, 10);
    expect(spiked).toBe(true);
  });
});

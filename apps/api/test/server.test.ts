import type { FastifyInstance } from "fastify";
import { expect, test, vi } from "vitest";

test("importing the server module does not start a listener", async () => {
  const server = await import("../src/server.js");
  expect(server.start).toBeTypeOf("function");
});

test("start closes the app after a listen failure", async () => {
  const server = await import("../src/server.js");
  const close = vi.fn(async () => undefined);
  const app = { listen: vi.fn(async () => { throw new Error("private listen details"); }), close } as unknown as FastifyInstance;
  await expect(server.start({
    loadConfig: () => ({ apiHost: "127.0.0.1", apiPort: 8787, databasePath: ":memory:", adminPassword: "secret", cookieSecure: false, webOrigin: "http://localhost:5173" }),
    buildApp: async () => app,
  })).rejects.toThrow("private listen details");
  expect(close).toHaveBeenCalledOnce();
});

test("run sets a nonzero exit code and logs a sanitized startup failure", async () => {
  const server = await import("../src/server.js");
  const processTarget = { exitCode: 0, once: vi.fn(), removeListener: vi.fn() };
  const log = vi.fn();
  await expect(server.run({
    loadConfig: () => { throw new Error("ADMIN_PASSWORD=secret"); },
    buildApp: async () => { throw new Error("unreachable"); },
  }, processTarget, log)).rejects.toThrow("ADMIN_PASSWORD=secret");
  expect(processTarget.exitCode).toBe(1);
  expect(log).toHaveBeenCalledWith("Unable to start API server");
  expect(log).not.toHaveBeenCalledWith(expect.stringContaining("secret"));
});

test("closes once, removes listeners, and logs sanitized shutdown failures", async () => {
  const server = await import("../src/server.js");
  const close = vi.fn(async () => { throw new Error("private shutdown details"); });
  const listeners = new Map<string, () => void>();
  const target = {
    once: vi.fn((signal: string, listener: () => void) => listeners.set(signal, listener)),
    removeListener: vi.fn((signal: string) => listeners.delete(signal)),
  };
  const log = vi.fn();
  const remove = server.installShutdownHandlers({ close } as unknown as FastifyInstance, target, log);
  const signal = listeners.get("SIGINT");
  signal?.();
  signal?.();
  await Promise.resolve();
  expect(close).toHaveBeenCalledOnce();
  expect(target.removeListener).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledWith("Unable to stop API server");
  expect(log).not.toHaveBeenCalledWith(expect.stringContaining("private"));
  remove();
  expect(target.removeListener).toHaveBeenCalledTimes(2);
});

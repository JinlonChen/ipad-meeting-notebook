import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { loadConfig } from "../src/config.js";

const PASSWORD = "correct horse battery staple";

describe("loadConfig", () => {
  test("loads the repository .env when starting the API development server", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.dev).toBe("tsx watch --env-file=../../.env src/server.ts");
  });

  test("uses documented defaults and parses the exact cookie boolean values", () => {
    expect(loadConfig({ ADMIN_PASSWORD: PASSWORD })).toEqual({
      apiPort: 8787,
      apiHost: "127.0.0.1",
      databasePath: "./data/meeting-notebook.sqlite",
      adminPassword: PASSWORD,
      cookieSecure: false,
      webOrigin: "http://localhost:5173",
    });
    expect(loadConfig({ ADMIN_PASSWORD: PASSWORD, COOKIE_SECURE: "true" }).cookieSecure).toBe(true);
    expect(loadConfig({ ADMIN_PASSWORD: PASSWORD, COOKIE_SECURE: "false" }).cookieSecure).toBe(false);
  });

  test("rejects invalid port, password, URL, and non-exact cookie booleans without revealing the password", () => {
    const secret = "this password must never appear in validation output";
    for (const env of [
      { ADMIN_PASSWORD: PASSWORD, API_PORT: "0" },
      { ADMIN_PASSWORD: "short" },
      { ADMIN_PASSWORD: PASSWORD, WEB_ORIGIN: "not a URL" },
      { ADMIN_PASSWORD: PASSWORD, COOKIE_SECURE: "TRUE" },
      { ADMIN_PASSWORD: secret, API_PORT: "nope" },
    ]) {
      let caught: unknown;
      try {
        loadConfig(env);
      } catch (error) {
        caught = error;
      }
      expect(String(caught)).toMatch(/API_PORT|ADMIN_PASSWORD|WEB_ORIGIN|COOKIE_SECURE/);
      expect(String(caught)).not.toContain(secret);
    }
  });
});

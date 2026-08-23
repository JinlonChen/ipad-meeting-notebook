import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scanner = resolve("test/scan-web-dist.mjs");

function scan(path) {
  return spawnSync(process.execPath, [scanner, path], { encoding: "utf8" });
}

function jwtForRole(role) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role })}.test-signature`;
}

test("scanner fails closed when the artifact directory is missing", () => {
  const result = scan(resolve("test/does-not-exist"));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /artifact directory.*(?:missing|unreadable)/i);
});

test("scanner rejects every private configuration marker without echoing its value", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "meeting-dist-private-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "assets"));
  const privateValue = [
    "SERVICE_ROLE=private-value",
    "SERVICE-ROLE=private-value",
    "sb_secret_0123456789abcdef",
    "ADMIN_PASSWORD=private-value",
    "DB_PASSWORD=private-value",
    "AI_KEY=private-value",
    "API_KEY=private-value",
    "API_SECRET=private-value",
  ].join("\\n");
  await writeFile(join(directory, "assets", "index.js"), privateValue);

  const result = scan(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /assets[/\\]index\.js/);
  assert.doesNotMatch(result.stderr, /private-value/);
});

test("scanner rejects a legacy Supabase service-role JWT without echoing the token", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "meeting-dist-service-jwt-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const token = jwtForRole("service_role");
  await writeFile(join(directory, "index.js"), `const configuredKey = "${token}";`);

  const result = scan(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /index\.js: privileged Supabase JWT/i);
  assert.doesNotMatch(result.stderr, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("scanner scans unknown regular text extensions instead of skipping them", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "meeting-dist-unknown-text-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "runtime.config"), "DB_PASSWORD=private-value");

  const result = scan(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runtime\.config: database password marker/i);
});

test("scanner accepts public anon and malformed JWT candidates", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "meeting-dist-public-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "index.html"), '<main data-sdk-check="sb_secret_">meeting notebook</main>');
  await writeFile(
    join(directory, "manifest.webmanifest"),
    JSON.stringify({ publicKey: jwtForRole("anon"), malformed: "bm90LWpzb24.bm90LWpzb24.signature" }),
  );

  const result = scan(directory);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /scanned 2 files/i);
});

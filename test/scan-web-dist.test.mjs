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

test("scanner accepts a clean artifact containing the public Supabase anon JWT", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "meeting-dist-public-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "index.html"), '<main data-sdk-check="sb_secret_">meeting notebook</main>');
  await writeFile(
    join(directory, "manifest.webmanifest"),
    JSON.stringify({ publicKey: "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.signature" }),
  );

  const result = scan(directory);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /scanned 2 files/i);
});

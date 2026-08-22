import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(resolve(root, relativePath), "utf8");
}

test("CI checks every production and database boundary on Node 22", async () => {
  const workflow = await read(".github/workflows/ci.yml");

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:\s*\n\s*branches:\s*\[main\]/);
  assert.match(workflow, /node-version:\s*["']?22["']?/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run typecheck/);
  assert.match(workflow, /npm test(?:\s|$)/m);
  assert.match(workflow, /node --test test\/supabase-schema\.test\.mjs/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /playwright install --with-deps chromium/);
  assert.match(workflow, /npm run test:e2e/);
});

test("Pages deployment is main-only, least-privileged, and uploads the web dist", async () => {
  const workflow = await read(".github/workflows/deploy-pages.yml");

  assert.match(workflow, /push:\s*\n\s*branches:\s*\[main\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /pages:\s*write/);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /actions\/configure-pages@v\d+/);
  assert.match(workflow, /actions\/upload-pages-artifact@v\d+/);
  assert.match(workflow, /path:\s*apps\/web\/dist/);
  assert.match(workflow, /actions\/deploy-pages@v\d+/);
});

test("Pages build receives only public Supabase web configuration and its repository base path", async () => {
  const workflow = await read(".github/workflows/deploy-pages.yml");
  const secretReferences = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]);

  assert.deepEqual([...new Set(secretReferences)].sort(), ["VITE_SUPABASE_ANON_KEY", "VITE_SUPABASE_URL"]);
  assert.match(workflow, /VITE_SUPABASE_URL:\s*\$\{\{\s*secrets\.VITE_SUPABASE_URL\s*\}\}/);
  assert.match(workflow, /VITE_SUPABASE_ANON_KEY:\s*\$\{\{\s*secrets\.VITE_SUPABASE_ANON_KEY\s*\}\}/);
  assert.match(workflow, /VITE_BASE_PATH:\s*\/\$\{\{\s*github\.event\.repository\.name\s*\}\}\//);
});

test("checked-in deployment files contain no private or real project configuration", async () => {
  const sources = await Promise.all([
    read(".github/workflows/ci.yml"),
    read(".github/workflows/deploy-pages.yml"),
    read(".env.example"),
    read("README.md"),
    read("package.json"),
  ]);
  const combined = sources.join("\n");

  assert.doesNotMatch(combined, /SERVICE_ROLE/i);
  assert.doesNotMatch(combined, /ADMIN_PASSWORD/);
  assert.doesNotMatch(combined, /(?:AI_KEY|API_KEY|API_SECRET)/i);
  assert.doesNotMatch(combined, /https:\/\/[a-z0-9]{20}\.supabase\.co/i);
  assert.doesNotMatch(combined, /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
});

test("environment example exposes only placeholder public browser variables", async () => {
  const environment = await read(".env.example");
  const names = environment
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split("=", 1)[0]);

  assert.deepEqual(names, ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_BASE_PATH"]);
  assert.match(environment, /VITE_SUPABASE_URL=https:\/\/YOUR_PROJECT_REF\.supabase\.co/);
  assert.match(environment, /VITE_SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_KEY/);
  assert.match(environment, /VITE_BASE_PATH=\//);
});

test("operator guide covers local setup, safe provisioning, Pages, and iPad offline acceptance", async () => {
  const readme = await read("README.md");

  for (const required of [
    "npm ci",
    "npm run dev -w @meeting/web",
    "supabase/migrations/202608220001_meeting_catalog.sql",
    "npx supabase test db",
    "VITE_SUPABASE_URL",
    "VITE_SUPABASE_ANON_KEY",
    "GitHub Actions",
    "添加到主屏幕",
    "关闭 Wi-Fi",
    "48 小时",
  ]) {
    assert.match(readme, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(readme, /创建并确认.*邮箱.*用户/s);
  assert.match(readme, /关闭.*注册/s);
  assert.match(readme, /原始录音.*云端.*iPad.*48 小时/s);
  assert.match(readme, /PWA.*关闭.*下次启动.*清理/s);
  assert.match(readme, /会议笔记.*完整转写.*AI 总结.*永久保存/s);
  assert.match(readme, /当前阶段.*不(?:包含|实现).*录音.*转写.*AI.*手写/s);
});

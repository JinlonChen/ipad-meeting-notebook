import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(resolve(root, relativePath), "utf8");
}

function jobSource(workflow, jobName, nextJobName) {
  const start = workflow.indexOf(`  ${jobName}:\n`);
  assert.notEqual(start, -1, `missing ${jobName} job`);
  const end = nextJobName ? workflow.indexOf(`  ${nextJobName}:\n`, start + 1) : workflow.length;
  assert.notEqual(end, -1, `missing ${nextJobName} job boundary`);
  return workflow.slice(start, end);
}

test("CI checks every production and database boundary on Node 22", async () => {
  const workflow = await read(".github/workflows/ci.yml");

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:\s*\n\s*branches:\s*\[main\]/);
  assert.match(workflow, /node-version:\s*["']?22["']?/);
  assert.match(workflow, /actions\/setup-python@v5/);
  assert.match(workflow, /python-version:\s*["']?3\.12["']?/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /pip install -r services\/transcription-relay\/requirements-dev\.txt/);
  assert.match(workflow, /PYTHONPATH=services\/transcription-relay pytest -q services\/transcription-relay\/tests/);
  assert.match(workflow, /npm run typecheck/);
  assert.match(workflow, /npm test(?:\s|$)/m);
  assert.match(workflow, /node --test test\/supabase-schema\.test\.mjs/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /npm run scan:web-dist/);
  assert.match(workflow, /playwright install --with-deps chromium/);
  assert.match(workflow, /npm run test:e2e/);
});

test("Pages deployment is main-only, least-privileged, and gated by a complete verify job", async () => {
  const workflow = await read(".github/workflows/deploy-pages.yml");
  const workflowHeader = workflow.slice(0, workflow.indexOf("jobs:\n"));
  const verify = jobSource(workflow, "verify", "deploy");
  const deploy = jobSource(workflow, "deploy");

  assert.match(workflow, /push:\s*\n\s*branches:\s*\[main\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflowHeader, /contents:\s*read/);
  assert.doesNotMatch(workflowHeader, /pages:\s*write/);
  assert.doesNotMatch(workflowHeader, /id-token:\s*write/);
  assert.match(deploy, /permissions:[\s\S]*contents:\s*read/);
  assert.match(deploy, /permissions:[\s\S]*pages:\s*write/);
  assert.match(deploy, /permissions:[\s\S]*id-token:\s*write/);
  for (const command of [
    "npm ci",
    "pip install -r services/transcription-relay/requirements-dev.txt",
    "PYTHONPATH=services/transcription-relay pytest -q services/transcription-relay/tests",
    "npm run typecheck",
    "npm test",
    "node --test test/supabase-schema.test.mjs",
    "npm run build",
    "npm run scan:web-dist",
    "npx playwright install --with-deps chromium",
    "npm run test:e2e",
  ]) {
    assert.match(verify, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(deploy, /needs:\s*verify/);
  assert.match(deploy, /actions\/configure-pages@v\d+/);
  assert.match(deploy, /actions\/upload-pages-artifact@v\d+/);
  assert.match(deploy, /path:\s*apps\/web\/dist/);
  assert.match(deploy, /actions\/deploy-pages@v\d+/);

  const build = deploy.indexOf("npm run build -w @meeting/web");
  const scan = deploy.indexOf("npm run scan:web-dist");
  const upload = deploy.indexOf("actions/upload-pages-artifact@");
  assert.ok(build !== -1 && scan > build && upload > scan, "configured build must be scanned before upload");
});

test("Pages build receives only public browser configuration and its repository base path", async () => {
  const workflow = await read(".github/workflows/deploy-pages.yml");
  const dotReferences = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]);
  const bracketReferences = [...workflow.matchAll(/secrets\[([^\]]+)\]/g)].map((match) => {
    const literal = match[1].trim().match(/^['"]([A-Z0-9_]+)['"]$/);
    return literal?.[1] ?? "UNSAFE_DYNAMIC_SECRET_REFERENCE";
  });
  const secretReferences = [...dotReferences, ...bracketReferences];

  assert.deepEqual([...new Set(secretReferences)].sort(), ["VITE_SUPABASE_ANON_KEY", "VITE_SUPABASE_URL"]);
  assert.match(workflow, /VITE_SUPABASE_URL:\s*\$\{\{\s*secrets\.VITE_SUPABASE_URL\s*\}\}/);
  assert.match(workflow, /VITE_SUPABASE_ANON_KEY:\s*\$\{\{\s*secrets\.VITE_SUPABASE_ANON_KEY\s*\}\}/);
  assert.match(workflow, /VITE_TRANSCRIPTION_RELAY_URL:\s*\$\{\{\s*vars\.VITE_TRANSCRIPTION_RELAY_URL\s*\}\}/);
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

  assert.deepEqual(names, ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_TRANSCRIPTION_RELAY_URL", "VITE_BASE_PATH"]);
  assert.match(environment, /VITE_SUPABASE_URL=https:\/\/YOUR_PROJECT_REF\.supabase\.co/);
  assert.match(environment, /VITE_SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_KEY/);
  assert.match(environment, /VITE_TRANSCRIPTION_RELAY_URL=https:\/\/YOUR_RELAY_HOST/);
  assert.match(environment, /VITE_BASE_PATH=\//);
});

test("operator guide covers local setup, safe provisioning, Pages, and iPad offline acceptance", async () => {
  const readme = await read("README.md");

  for (const required of [
    "npm ci",
    "npm run dev -w @meeting/web",
    "supabase/migrations/202608220001_meeting_catalog.sql",
    "supabase/migrations/202608230002_meeting_notes.sql",
    "supabase/migrations/202608240001_meeting_audio.sql",
    "supabase/migrations/202608240002_audio_cleanup.sql",
    "npx supabase functions deploy cleanup-expired-audio",
    "npx supabase test db",
    "VITE_SUPABASE_URL",
    "VITE_SUPABASE_ANON_KEY",
    "VITE_TRANSCRIPTION_RELAY_URL",
    "services/transcription-relay/requirements-dev.txt",
    "render.yaml",
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
  assert.match(readme, /当前版本.*实时转写.*AI 总结.*可恢复的会议录音/s);
  assert.match(readme, /实时转写.*阿里.*官方.*SDK/s);
  assert.match(readme, /手写.*说话人区分.*尚未实现/s);
});

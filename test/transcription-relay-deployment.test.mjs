import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


test("Render blueprint deploys the pinned Python relay without checked-in secrets", async () => {
  const [render, dockerfile, requirements] = await Promise.all([
    readFile("render.yaml", "utf8"),
    readFile("services/transcription-relay/Dockerfile", "utf8"),
    readFile("services/transcription-relay/requirements.txt", "utf8"),
  ]);

  assert.match(render, /runtime:\s*docker/);
  assert.match(render, /dockerfilePath:\s*\.\/services\/transcription-relay\/Dockerfile/);
  assert.match(render, /healthCheckPath:\s*\/health/);
  for (const name of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "ALLOWED_ORIGINS"]) {
    assert.match(render, new RegExp(`key: ${name}\\s+sync: false`));
  }
  assert.doesNotMatch(render, /value:\s*\S/);
  assert.match(dockerfile, /USER\s+relay/);
  assert.match(dockerfile, /create_production_app.*--factory/);
  assert.match(requirements, /^dashscope==1\.27\.1$/m);
  assert.match(requirements, /^fastapi==/m);
  assert.match(requirements, /^uvicorn\[standard\]==/m);
});

import { readdir, readFile, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

const artifactDirectory = resolve(process.argv[2] ?? "apps/web/dist");
const textExtensions = new Set([".css", ".html", ".js", ".json", ".map", ".mjs", ".txt", ".webmanifest"]);
const forbiddenMarkers = [
  ["service role marker", /service[_-]role/i],
  ["Supabase private key marker", /sb_secret_[a-z0-9_-]{16,}/i],
  ["administrator password marker", /admin[_-]password/i],
  ["database password marker", /db[_-]password/i],
  ["AI key marker", /ai[_-]key/i],
  ["API key marker", /api[_-]key/i],
  ["API secret marker", /api[_-]secret/i],
];

async function collectTextFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTextFiles(path));
    } else if (entry.isFile() && textExtensions.has(extname(entry.name).toLowerCase())) {
      files.push(path);
    } else if (entry.isSymbolicLink()) {
      throw new Error(`symbolic link is not allowed: ${relative(artifactDirectory, path)}`);
    }
  }

  return files;
}

try {
  const artifact = await stat(artifactDirectory);
  if (!artifact.isDirectory()) throw new Error("path is not a directory");

  const files = await collectTextFiles(artifactDirectory);
  if (files.length === 0) throw new Error("no scannable web files found");

  const findings = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const [label, pattern] of forbiddenMarkers) {
      if (pattern.test(source)) findings.push(`${relative(artifactDirectory, file)}: ${label}`);
    }
  }

  if (findings.length > 0) {
    console.error(`Private configuration markers found in web artifact:\n${findings.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`Scanned ${files.length} files; no private configuration markers found.`);
  }
} catch (error) {
  const reason = error instanceof Error ? error.message : "unknown error";
  console.error(`Artifact directory missing or unreadable: ${reason}`);
  process.exitCode = 1;
}

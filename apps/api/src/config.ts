import { z } from "zod";

const ConfigSchema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  API_HOST: z.string().trim().min(1).default("127.0.0.1"),
  DATABASE_PATH: z.string().trim().min(1).default("./data/meeting-notebook.sqlite"),
  ADMIN_PASSWORD: z.string().min(12).max(256),
  COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
  WEB_ORIGIN: z.url().default("http://localhost:5173"),
});

export class ConfigValidationError extends Error {
  constructor(fields: string[]) {
    super(`Invalid configuration: ${fields.join(", ")}`);
    this.name = "ConfigValidationError";
  }
}

export type Config = {
  apiPort: number;
  apiHost: string;
  databasePath: string;
  adminPassword: string;
  cookieSecure: boolean;
  webOrigin: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigValidationError([...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))]);
  }

  return {
    apiPort: parsed.data.API_PORT,
    apiHost: parsed.data.API_HOST,
    databasePath: parsed.data.DATABASE_PATH,
    adminPassword: parsed.data.ADMIN_PASSWORD,
    cookieSecure: parsed.data.COOKIE_SECURE === "true",
    webOrigin: parsed.data.WEB_ORIGIN,
  };
}

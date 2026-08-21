import { createHash, randomBytes as secureRandomBytes } from "node:crypto";

import { LoginInputSchema, type SessionUser } from "@meeting/contracts";
import argon2 from "argon2";
import type Database from "better-sqlite3";

import { canonicalizeTimestamp } from "../db/database.js";

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1_000;

type SessionRow = {
  expires_at: string;
};

export class InvalidCredentialsError extends Error {
  constructor() {
    super("Invalid credentials");
    this.name = "InvalidCredentialsError";
  }
}

export class AuthRequiredError extends Error {
  constructor() {
    super("Authentication required");
    this.name = "AuthRequiredError";
  }
}

export class LoginVerificationCapacityError extends Error {
  constructor() {
    super("Login verification capacity exceeded");
    this.name = "LoginVerificationCapacityError";
  }
}

export class Argon2VerificationGate {
  private active = 0;
  private maximumObserved = 0;

  constructor(private readonly limit = 2) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Argon2 verification limit must be a positive integer");
  }

  get peak(): number {
    return this.maximumObserved;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) throw new LoginVerificationCapacityError();
    this.active += 1;
    this.maximumObserved = Math.max(this.maximumObserved, this.active);
    try {
      return await operation();
    } finally {
      this.active -= 1;
    }
  }
}

class InvalidAdminPasswordHashError extends Error {
  constructor() {
    super("Invalid Argon2id admin password hash");
    this.name = "InvalidAdminPasswordHashError";
  }
}

export type AuthServiceOptions = {
  db: Database.Database;
  adminPassword: string;
  now?: () => Date;
  tokenBytes?: () => Buffer;
  verificationGate?: Argon2VerificationGate;
};

type AuthServiceDependencies = Omit<AuthServiceOptions, "adminPassword">;
const defaultVerificationGate = new Argon2VerificationGate();

export class AuthService {
  private constructor(
    private readonly db: Database.Database,
    private readonly passwordHash: string,
    private readonly now: () => Date,
    private readonly tokenBytes: () => Buffer,
    private readonly verificationGate: Argon2VerificationGate,
  ) {}

  static async create(options: AuthServiceOptions): Promise<AuthService> {
    const passwordHash = await configuredPasswordHash(options.adminPassword);
    const dependencies: AuthServiceDependencies = options;
    return new AuthService(
      dependencies.db,
      passwordHash,
      dependencies.now ?? (() => new Date()),
      dependencies.tokenBytes ?? (() => secureRandomBytes(32)),
      dependencies.verificationGate ?? defaultVerificationGate,
    );
  }

  async login(password: string): Promise<{ token: string; expiresAt: string }> {
    LoginInputSchema.shape.password.parse(password);
    let passwordMatches: boolean;
    try {
      passwordMatches = await this.verificationGate.run(() => argon2.verify(this.passwordHash, password));
    } catch (error) {
      if (error instanceof LoginVerificationCapacityError) throw error;
      throw new InvalidCredentialsError();
    }
    if (!passwordMatches) throw new InvalidCredentialsError();

    const now = canonicalizeTimestamp(this.now().toISOString());
    const expiresAt = canonicalizeTimestamp(new Date(new Date(now).getTime() + SESSION_DURATION_MS).toISOString());
    const token = this.tokenBytes().toString("base64url");
    const tokenHash = hashToken(token);

    this.db.transaction(() => {
      this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
      this.db.prepare(`
        INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
        VALUES (?, 'owner', ?, ?)
      `).run(tokenHash, now, expiresAt);
    })();
    return { token, expiresAt };
  }

  async authenticate(rawToken: string | undefined): Promise<SessionUser> {
    if (!rawToken) throw new AuthRequiredError();
    const now = canonicalizeTimestamp(this.now().toISOString());
    const tokenHash = hashToken(rawToken);
    const row = this.db.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").get(tokenHash) as SessionRow | undefined;
    if (!row) throw new AuthRequiredError();
    if (row.expires_at <= now) {
      this.db.prepare("DELETE FROM sessions WHERE token_hash = ? AND expires_at <= ?").run(tokenHash, now);
      throw new AuthRequiredError();
    }
    return { id: "owner", sessionExpiresAt: row.expires_at };
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (rawToken) this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(rawToken));
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function configuredPasswordHash(value: string): Promise<string> {
  if (value.startsWith("$argon2id$")) {
    if (await isArgon2idHash(value)) return value;
    throw new InvalidAdminPasswordHashError();
  }
  return argon2.hash(value, { type: argon2.argon2id });
}

async function isArgon2idHash(value: string): Promise<boolean> {
  if (!value.startsWith("$argon2id$")) return false;
  try {
    await argon2.verify(value, "");
    return true;
  } catch {
    return false;
  }
}

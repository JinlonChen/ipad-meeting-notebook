import { LoginInputSchema, SessionUserSchema } from "@meeting/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../supabase/types.js";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class AuthApiError extends Error {
  constructor(public readonly status: number, public readonly code: "AUTH_REQUIRED" | "REQUEST_FAILED") {
    super(code);
    this.name = "AuthApiError";
  }
}

export class AuthNetworkError extends Error {
  constructor() {
    super("NETWORK_UNAVAILABLE");
    this.name = "AuthNetworkError";
  }
}

type SessionIdentity = { id: string; sessionExpiresAt: string };
export type AuthSessionChange =
  | { event: "initial"; userId: string | null }
  | { event: "session"; userId: string }
  | { event: "signed_out" | "invalid"; userId: null };
type SupabaseAuthClient = Pick<SupabaseClient<Database>, "auth">;
type ErrorShape = { status?: unknown; code?: unknown; name?: unknown };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const authRequiredCodes = new Set([
  "bad_jwt",
  "invalid_credentials",
  "invalid_jwt",
  "no_authorization",
  "refresh_token_already_used",
  "refresh_token_not_found",
  "session_not_found",
  "session_expired",
  "user_not_found",
]);
const authRequiredNames = new Set(["AuthInvalidCredentialsError", "AuthSessionMissingError"]);

function errorShape(error: unknown): ErrorShape {
  return typeof error === "object" && error !== null ? error : {};
}

function requiredProperty(value: unknown, property: string): unknown {
  if (typeof value !== "object" || value === null || !(property in value)) {
    throw new AuthApiError(500, "REQUEST_FAILED");
  }
  return (value as Record<string, unknown>)[property];
}

function safeSessionChange(event: unknown, value: unknown): AuthSessionChange {
  if (event === "INITIAL_SESSION" && value === null) return { event: "initial", userId: null };
  if (event === "SIGNED_OUT" || value === null) return { event: "signed_out", userId: null };
  if (typeof value !== "object" || !value) return { event: "invalid", userId: null };
  const user = "user" in value ? value.user : undefined;
  if (typeof user !== "object" || !user || !("id" in user) || typeof user.id !== "string" || !uuidPattern.test(user.id)) {
    return { event: "invalid", userId: null };
  }
  return { event: event === "INITIAL_SESSION" ? "initial" : "session", userId: user.id.toLowerCase() };
}

function supabaseFailure(error: unknown): AuthApiError | AuthNetworkError {
  const { status, code, name } = errorShape(error);
  if (error instanceof TypeError || status === 0 || name === "AuthRetryableFetchError") {
    return new AuthNetworkError();
  }
  if (status === 401 || status === 403 || (typeof code === "string" && authRequiredCodes.has(code)) || (typeof name === "string" && authRequiredNames.has(name))) {
    return new AuthApiError(401, "AUTH_REQUIRED");
  }
  const safeStatus = typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  return new AuthApiError(safeStatus, "REQUEST_FAILED");
}

async function supabaseResult<T extends { error: unknown }>(request: () => Promise<T>): Promise<T> {
  try {
    const result = await request();
    if (result.error) throw supabaseFailure(result.error);
    return result;
  } catch (error) {
    if (error instanceof AuthApiError || error instanceof AuthNetworkError) throw error;
    throw supabaseFailure(error);
  }
}

function safeError(response: Response): AuthApiError {
  return new AuthApiError(response.status, response.status === 401 ? "AUTH_REQUIRED" : "REQUEST_FAILED");
}

async function noContent(request: Promise<Response>): Promise<void> {
  const response = await transport(request);
  if (!response.ok) throw safeError(response);
}

async function transport(request: Promise<Response>): Promise<Response> {
  try {
    return await request;
  } catch {
    throw new AuthNetworkError();
  }
}

async function session(request: Promise<Response>): Promise<SessionIdentity> {
  const response = await transport(request);
  if (!response.ok) throw safeError(response);
  try {
    return SessionUserSchema.parse(await response.json());
  } catch {
    throw new AuthApiError(response.status, "REQUEST_FAILED");
  }
}

export type AuthApi = {
  me(): Promise<SessionIdentity>;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  onSessionChange(listener: (change: AuthSessionChange) => void): () => void;
};

export function supabaseAuthApi(client: SupabaseAuthClient): AuthApi {
  return {
    onSessionChange(listener) {
      const { data } = client.auth.onAuthStateChange((event, currentSession) => {
        listener(safeSessionChange(event, currentSession));
      });
      return () => data.subscription.unsubscribe();
    },
    async me() {
      const userResult = await supabaseResult(() => client.auth.getUser());
      const user = requiredProperty(userResult.data, "user");
      if (!user) throw new AuthApiError(401, "AUTH_REQUIRED");
      const id = requiredProperty(user, "id");
      if (typeof id !== "string" || !uuidPattern.test(id)) throw new AuthApiError(500, "REQUEST_FAILED");

      const sessionResult = await supabaseResult(() => client.auth.getSession());
      const currentSession = requiredProperty(sessionResult.data, "session");
      if (!currentSession) throw new AuthApiError(401, "AUTH_REQUIRED");
      const sessionUser = requiredProperty(currentSession, "user");
      const sessionUserId = requiredProperty(sessionUser, "id");
      if (typeof sessionUserId !== "string" || !uuidPattern.test(sessionUserId)) {
        throw new AuthApiError(500, "REQUEST_FAILED");
      }
      const normalizedId = id.toLowerCase();
      if (sessionUserId.toLowerCase() !== normalizedId) {
        throw new AuthApiError(401, "AUTH_REQUIRED");
      }
      const expiresAt = requiredProperty(currentSession, "expires_at");
      if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
        throw new AuthApiError(500, "REQUEST_FAILED");
      }
      const expiryMilliseconds = expiresAt * 1_000;
      if (!Number.isSafeInteger(expiryMilliseconds)) throw new AuthApiError(500, "REQUEST_FAILED");
      if (expiryMilliseconds <= Date.now()) throw new AuthApiError(401, "AUTH_REQUIRED");
      try {
        return { id: normalizedId, sessionExpiresAt: new Date(expiryMilliseconds).toISOString() };
      } catch {
        throw new AuthApiError(500, "REQUEST_FAILED");
      }
    },
    async login(email, password) {
      await supabaseResult(() => client.auth.signInWithPassword({ email, password }));
    },
    async logout() {
      await supabaseResult(() => client.auth.signOut());
    },
  };
}

export function legacyHttpAuthApi(fetcher: Fetcher = fetch): AuthApi {
  return {
    onSessionChange: () => () => undefined,
    me: () => session(fetcher("/api/auth/me", { credentials: "include" })),
    login(_email, password) {
      return noContent(fetcher("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(LoginInputSchema.parse({ password })),
      }));
    },
    logout() {
      return noContent(fetcher("/api/auth/logout", { method: "POST", credentials: "include" }));
    },
  };
}

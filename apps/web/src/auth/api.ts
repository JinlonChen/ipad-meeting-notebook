import { LoginInputSchema, SessionUserSchema, type SessionUser } from "@meeting/contracts";

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

async function session(request: Promise<Response>): Promise<SessionUser> {
  const response = await transport(request);
  if (!response.ok) throw safeError(response);
  try {
    return SessionUserSchema.parse(await response.json());
  } catch {
    throw new AuthApiError(response.status, "REQUEST_FAILED");
  }
}

export type AuthApi = {
  me(): Promise<SessionUser>;
  login(password: string): Promise<void>;
  logout(): Promise<void>;
};

export function authApi(fetcher: Fetcher = fetch): AuthApi {
  return {
    me: () => session(fetcher("/api/auth/me", { credentials: "include" })),
    login(password) {
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

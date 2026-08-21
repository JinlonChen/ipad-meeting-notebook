import { LoginInputSchema, SessionUserSchema, type SessionUser } from "@meeting/contracts";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class AuthApiError extends Error {
  constructor(public readonly status: number, public readonly code: "AUTH_REQUIRED" | "REQUEST_FAILED") {
    super(code);
    this.name = "AuthApiError";
  }
}

function safeError(response: Response): AuthApiError {
  return new AuthApiError(response.status, response.status === 401 ? "AUTH_REQUIRED" : "REQUEST_FAILED");
}

async function noContent(request: Promise<Response>): Promise<void> {
  const response = await request;
  if (!response.ok) throw safeError(response);
}

export type AuthApi = {
  me(): Promise<SessionUser>;
  login(password: string): Promise<void>;
  logout(): Promise<void>;
};

export function authApi(fetcher: Fetcher = fetch): AuthApi {
  return {
    async me() {
      const response = await fetcher("/api/auth/me", { credentials: "include" });
      if (!response.ok) throw safeError(response);
      return SessionUserSchema.parse(await response.json());
    },
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { AuthApiError, AuthNetworkError, type AuthApi } from "../auth/api.js";
import { LoginPage } from "../auth/LoginPage.js";
import type { DeviceAccess } from "../meetings/local-db.js";
import { MeetingListPage } from "../meetings/MeetingListPage.js";
import { MeetingWorkspacePage } from "../meetings/MeetingWorkspacePage.js";
import { MeetingCatalogRepository } from "../meetings/repository.js";
import { CatalogSync, type MeetingCatalogApi, type SyncResult } from "../meetings/sync.js";
import { normalizeBasePath } from "./base-path.js";

const defaultNow = () => new Date().toISOString();
const noopSynchronizer: CatalogSynchronizer = {
  refresh: async () => ({ state: "idle" }),
  pauseForUserChange: () => undefined,
  resumeAfterLogin: () => undefined,
};

type Props = {
  repository?: MeetingCatalogRepository;
  auth?: AuthApi;
  catalog?: MeetingCatalogApi;
  synchronizer?: CatalogSynchronizer;
  now?: () => string;
  configurationError?: boolean;
  startupError?: boolean;
  onStartupRetry?: () => void;
};
export type CatalogSynchronizer = {
  refresh(): Promise<SyncResult>;
  scheduleRefresh?(): Promise<SyncResult>;
  pauseForUserChange(): void;
  resumeAfterLogin(): void;
};
type Gate = "loading" | "catalog" | "login" | "offline-lock" | "logging-out" | "logout-error" | "error";

function isUnauthorized(error: unknown): boolean {
  return error instanceof AuthApiError ? error.status === 401 : typeof error === "object" && error !== null && "status" in error && error.status === 401;
}

export function App({ repository, auth, catalog, synchronizer, now, configurationError = false, startupError = false, onStartupRetry }: Props) {
  const resolvedSynchronizer = useMemo(() => {
    if (synchronizer) return synchronizer;
    if (repository && catalog) return new CatalogSync(repository, catalog);
    return noopSynchronizer;
  }, [catalog, repository, synchronizer]);
  if (startupError) {
    return <StartupErrorPanel onRetry={onStartupRetry ?? (() => window.location.reload())} />;
  }
  if (configurationError || !repository || !auth) {
    return <ConfigurationPanel />;
  }
  return <SessionApp repository={repository} auth={auth} synchronizer={resolvedSynchronizer} now={now ?? defaultNow} />;
}

function ConfigurationPanel() {
  return <main className="login-page"><section className="login-panel" aria-labelledby="configuration-title"><h1 id="configuration-title">需要配置云端服务</h1><p>请先配置 Supabase 后再启动会议本。</p></section></main>;
}

function StartupErrorPanel({ onRetry }: { onRetry: () => void }) {
  return <main className="login-page"><section className="login-panel" aria-labelledby="startup-error-title"><h1 id="startup-error-title">无法启动会议本</h1><p>本地服务初始化未完成，请重试。</p><button className="primary-button" onClick={onRetry}>重试</button></section></main>;
}

type SessionProps = {
  repository: MeetingCatalogRepository;
  auth: AuthApi;
  synchronizer: CatalogSynchronizer;
  now: () => string;
};

function SessionApp({ repository, auth, synchronizer, now }: SessionProps) {
  const [online, setOnline] = useState(() => typeof navigator === "undefined" ? true : navigator.onLine);
  const [gate, setGate] = useState<Gate>("loading");
  const [deviceExpiresAt, setDeviceExpiresAt] = useState<string | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const explicitLogout = useRef(false);
  const activeUserId = useRef<string | null>(null);
  const observedInitialUserId = useRef<string | null | undefined>(undefined);
  const acceptInitialSession = useRef(true);
  const authTransition = useRef<{ kind: "login" | "logout"; token: symbol } | null>(null);
  const nextGeneration = useCallback(() => ++generation.current, []);
  const owns = useCallback((value: number) => mounted.current && generation.current === value, []);

  const clearAuthorization = useCallback(async (currentGeneration: number, expectedAccess?: DeviceAccess): Promise<boolean> => {
    try {
      const expected = expectedAccess ?? await repository.validDeviceAccess(now());
      if (!owns(currentGeneration)) return false;
      if (expected) await repository.clearDeviceAccess(expected);
    } catch {
      if (owns(currentGeneration)) setGate("error");
      return false;
    }
    if (!owns(currentGeneration)) return false;
    setDeviceExpiresAt(null);
    return true;
  }, [now, owns, repository]);

  const lockInitialMismatch = useCallback((markerUserId: string, initialUserId: string | null) => {
    const currentGeneration = nextGeneration();
    setDeviceExpiresAt(null);
    setGate("loading");
    void (async () => {
      try {
        const access = await repository.validDeviceAccess(now());
        if (!owns(currentGeneration)) return;
        if (!access || access.userId !== markerUserId || access.userId === initialUserId) {
          setGate("offline-lock");
          return;
        }
        if (await clearAuthorization(currentGeneration, access)) setGate("offline-lock");
      } catch {
        if (owns(currentGeneration)) setGate("error");
      }
    })();
  }, [clearAuthorization, nextGeneration, now, owns, repository]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  const authorize = useCallback(async (allowOfflineAccess = true) => {
    if (explicitLogout.current) return;
    const currentGeneration = nextGeneration();
    synchronizer.pauseForUserChange();
    try {
      const session = await auth.me();
      if (!owns(currentGeneration) || explicitLogout.current) return;
      acceptInitialSession.current = false;
      if (activeUserId.current !== session.id) {
        await repository.activateUser(session.id);
        activeUserId.current = session.id;
      }
      if (!owns(currentGeneration) || explicitLogout.current) return;
      const access = await repository.authorizeDevice(session.id, session.sessionExpiresAt, now());
      if (!owns(currentGeneration) || explicitLogout.current) {
        await repository.clearDeviceAccess(access);
        return;
      }
      setDeviceExpiresAt(access.expiresAt);
      setOnline(true);
      synchronizer.resumeAfterLogin();
      setGate("catalog");
    } catch (error) {
      if (!owns(currentGeneration) || explicitLogout.current) return;
      if (isUnauthorized(error)) {
        if (await clearAuthorization(currentGeneration)) setGate("login");
        return;
      }
      if (error instanceof AuthNetworkError) {
        setOnline(false);
        if (!allowOfflineAccess) {
          if (await clearAuthorization(currentGeneration)) setGate("offline-lock");
          return;
        }
        const access = await repository.validDeviceAccess(now());
        if (!owns(currentGeneration)) return;
        const observed = observedInitialUserId.current;
        if (acceptInitialSession.current && observed !== undefined && access && observed !== access.userId) {
          if (await clearAuthorization(currentGeneration, access)) setGate("offline-lock");
          return;
        }
        if (access) {
          try {
            if (activeUserId.current !== access.userId) {
              await repository.activateUser(access.userId);
              activeUserId.current = access.userId;
            }
          } catch {
            if (owns(currentGeneration)) setGate("error");
            return;
          }
        }
        if (!owns(currentGeneration)) return;
        if (acceptInitialSession.current && observedInitialUserId.current !== undefined && access && observedInitialUserId.current !== access.userId) {
          if (await clearAuthorization(currentGeneration, access)) setGate("offline-lock");
          return;
        }
        setDeviceExpiresAt(access?.expiresAt ?? null);
        setGate(access ? "catalog" : "offline-lock");
        return;
      }
      setGate("error");
    }
  }, [auth, clearAuthorization, nextGeneration, now, owns, repository, synchronizer]);

  useEffect(() => { void authorize(); }, [authorize]);
  useEffect(() => auth.onSessionChange((change) => {
    if (!mounted.current) return;
    if (change.event === "initial") {
      if (!acceptInitialSession.current) return;
      observedInitialUserId.current = change.userId;
      if (activeUserId.current !== null && activeUserId.current !== change.userId) {
        synchronizer.pauseForUserChange();
        lockInitialMismatch(activeUserId.current, change.userId);
      }
      return;
    }
    const transition = authTransition.current;
    if (explicitLogout.current || transition?.kind === "logout") return;
    if (change.event === "token_refreshed" && activeUserId.current === change.userId) {
      const currentGeneration = nextGeneration();
      void repository.refreshDeviceAccess(change.userId, change.sessionExpiresAt).then((access) => {
        if (access && owns(currentGeneration) && activeUserId.current === change.userId) {
          setDeviceExpiresAt(access.expiresAt);
        }
      }).catch(() => {
        if (owns(currentGeneration) && activeUserId.current === change.userId) {
          setDeviceExpiresAt(null);
          setGate("error");
        }
      });
      return;
    }
    if (!transition && change.event === "session" && activeUserId.current === change.userId) return;
    synchronizer.pauseForUserChange();
    if (change.event === "session" || change.event === "token_refreshed") {
      nextGeneration();
      setGate("loading");
      queueMicrotask(() => {
        if (mounted.current && !explicitLogout.current) void authorize(false);
      });
      return;
    }
    const currentGeneration = nextGeneration();
    activeUserId.current = null;
    setGate("loading");
    void clearAuthorization(currentGeneration).then((cleared) => {
      if (cleared) setGate(change.event === "signed_out" ? "login" : "error");
    });
  }), [auth, authorize, clearAuthorization, lockInitialMismatch, nextGeneration, owns, repository, synchronizer]);
  useEffect(() => {
    const becameOnline = () => {
      if (!explicitLogout.current) void authorize();
    };
    const becameOffline = () => setOnline(false);
    window.addEventListener("online", becameOnline);
    window.addEventListener("offline", becameOffline);
    return () => { window.removeEventListener("online", becameOnline); window.removeEventListener("offline", becameOffline); };
  }, [authorize]);

  useEffect(() => {
    if (gate !== "catalog" || online || !deviceExpiresAt) return;
    let timeout: number | undefined;
    const lockIfExpired = () => {
      if (!mounted.current || new Date(now()).getTime() < new Date(deviceExpiresAt).getTime()) return false;
      nextGeneration();
      setDeviceExpiresAt(null);
      setGate("offline-lock");
      return true;
    };
    const scheduleExpiryCheck = () => {
      const remaining = new Date(deviceExpiresAt).getTime() - new Date(now()).getTime();
      timeout = window.setTimeout(() => {
        if (!lockIfExpired()) scheduleExpiryCheck();
      }, Math.max(0, Math.min(remaining, 2_147_000_000)));
    };
    scheduleExpiryCheck();
    document.addEventListener("visibilitychange", lockIfExpired);
    return () => {
      if (timeout !== undefined) window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", lockIfExpired);
    };
  }, [deviceExpiresAt, gate, nextGeneration, now, online]);

  const login = useCallback(async (email: string, password: string) => {
    const transition = { kind: "login" as const, token: Symbol("login") };
    explicitLogout.current = false;
    acceptInitialSession.current = false;
    authTransition.current = transition;
    const currentGeneration = nextGeneration();
    synchronizer.pauseForUserChange();
    try {
      await auth.login(email, password);
      if (!owns(currentGeneration)) return;
      let session: Awaited<ReturnType<AuthApi["me"]>>;
      try {
        session = await auth.me();
      } catch (error) {
        if (isUnauthorized(error)) {
          if (await clearAuthorization(currentGeneration)) setGate("login");
          return;
        }
        throw error;
      }
      if (!owns(currentGeneration)) return;
      if (activeUserId.current !== session.id) {
        await repository.activateUser(session.id);
        activeUserId.current = session.id;
      }
      if (!owns(currentGeneration)) return;
      const access = await repository.authorizeDevice(session.id, session.sessionExpiresAt, now());
      if (!owns(currentGeneration)) {
        await repository.clearDeviceAccess(access);
        return;
      }
      setDeviceExpiresAt(access.expiresAt);
      explicitLogout.current = false;
      synchronizer.resumeAfterLogin();
      setGate("catalog");
    } finally {
      if (authTransition.current?.token === transition.token) authTransition.current = null;
    }
  }, [auth, clearAuthorization, nextGeneration, now, owns, repository, synchronizer]);
  const guardSync = useCallback(async (request: () => Promise<SyncResult>) => {
    const currentGeneration = generation.current;
    const result = await request();
    if (result.state === "paused_auth" && owns(currentGeneration)) {
      if (await clearAuthorization(currentGeneration)) setGate("login");
    }
    return result;
  }, [clearAuthorization, owns]);
  const guardedRefresh = useCallback(() => guardSync(() => synchronizer.refresh()), [guardSync, synchronizer]);
  const guardedScheduledRefresh = useCallback(
    () => guardSync(() => synchronizer.scheduleRefresh?.() ?? synchronizer.refresh()),
    [guardSync, synchronizer],
  );
  const logout = useCallback(async () => {
    const transition = { kind: "logout" as const, token: Symbol("logout") };
    authTransition.current = transition;
    explicitLogout.current = true;
    synchronizer.pauseForUserChange();
    const currentGeneration = nextGeneration();
    if (mounted.current) setGate("logging-out");
    const remoteLogout = auth.logout().catch(() => undefined);
    try {
      try {
        await repository.clearDeviceAccess();
      } catch {
        await remoteLogout;
        if (owns(currentGeneration)) setGate("logout-error");
        return;
      }
      if (owns(currentGeneration)) setDeviceExpiresAt(null);
      await remoteLogout;
      if (owns(currentGeneration)) setGate("login");
    } finally {
      if (authTransition.current?.token === transition.token) authTransition.current = null;
    }
  }, [auth, nextGeneration, owns, repository, synchronizer]);

  if (gate === "loading") return <main className="gate-loading" role="status">正在验证访问权限...</main>;
  if (gate === "logging-out") return <main className="gate-loading" role="status">正在退出...</main>;
  if (gate === "logout-error") return <main className="login-page"><section className="login-panel"><h1>无法安全退出</h1><p>本地访问权限尚未清除。</p><button className="primary-button" onClick={() => void logout()}>重试退出</button></section></main>;
  if (gate === "login" || gate === "offline-lock") return <LoginPage onLogin={login} offline={gate === "offline-lock"} />;
  if (gate === "error") return <main className="login-page"><section className="login-panel"><h1>无法验证访问权限</h1><button className="primary-button" onClick={() => void authorize()}>重试</button></section></main>;
  return <BrowserRouter basename={normalizeBasePath(import.meta.env.BASE_URL)}><Routes><Route path="/meetings/:id" element={<MeetingWorkspacePage repository={repository} refresh={guardedRefresh} scheduleRefresh={guardedScheduledRefresh} now={now} online={online} />} /><Route path="*" element={<MeetingListPage repository={repository} refresh={guardedRefresh} scheduleRefresh={guardedScheduledRefresh} now={now} online={online} onLogout={() => void logout()} />} /></Routes></BrowserRouter>;
}

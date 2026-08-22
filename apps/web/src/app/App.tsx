import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { AuthApiError, AuthNetworkError, type AuthApi } from "../auth/api.js";
import { LoginPage } from "../auth/LoginPage.js";
import { MeetingListPage, WorkspacePlaceholder } from "../meetings/MeetingListPage.js";
import { MeetingCatalogRepository } from "../meetings/repository.js";
import { CatalogSync, type MeetingCatalogApi, type SyncResult } from "../meetings/sync.js";

const defaultNow = () => new Date().toISOString();
const noopSynchronizer: CatalogSynchronizer = {
  refresh: async () => ({ state: "idle" }),
  resumeAfterLogin: () => undefined,
};

type Props = {
  repository?: MeetingCatalogRepository;
  auth?: AuthApi;
  catalog?: MeetingCatalogApi;
  synchronizer?: CatalogSynchronizer;
  now?: () => string;
  configurationError?: boolean;
};
export type CatalogSynchronizer = {
  refresh(): Promise<SyncResult>;
  scheduleRefresh?(): Promise<SyncResult>;
  resumeAfterLogin(): void;
};
type Gate = "loading" | "catalog" | "login" | "offline-lock" | "logging-out" | "error";

function isUnauthorized(error: unknown): boolean {
  return error instanceof AuthApiError ? error.status === 401 : typeof error === "object" && error !== null && "status" in error && error.status === 401;
}

export function App({ repository, auth, catalog, synchronizer, now, configurationError = false }: Props) {
  const resolvedSynchronizer = useMemo(() => {
    if (synchronizer) return synchronizer;
    if (repository && catalog) return new CatalogSync(repository, catalog);
    return noopSynchronizer;
  }, [catalog, repository, synchronizer]);
  if (configurationError || !repository || !auth) {
    return <ConfigurationPanel />;
  }
  return <SessionApp repository={repository} auth={auth} synchronizer={resolvedSynchronizer} now={now ?? defaultNow} />;
}

function ConfigurationPanel() {
  return <main className="login-page"><section className="login-panel" aria-labelledby="configuration-title"><h1 id="configuration-title">需要配置云端服务</h1><p>请先配置 Supabase 后再启动会议本。</p></section></main>;
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
  const mounted = useRef(true);
  const generation = useRef(0);
  const explicitLogout = useRef(false);
  const nextGeneration = useCallback(() => ++generation.current, []);
  const owns = useCallback((value: number) => mounted.current && generation.current === value, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  const authorize = useCallback(async () => {
    if (explicitLogout.current) return;
    const currentGeneration = nextGeneration();
    try {
      const session = await auth.me();
      if (!owns(currentGeneration) || explicitLogout.current) return;
      const access = await repository.authorizeDevice(session.sessionExpiresAt, now());
      if (!owns(currentGeneration) || explicitLogout.current) {
        await repository.clearDeviceAccess(access);
        return;
      }
      setOnline(true);
      setGate("catalog");
    } catch (error) {
      if (!owns(currentGeneration) || explicitLogout.current) return;
      if (isUnauthorized(error)) { setGate("login"); return; }
      if (error instanceof AuthNetworkError) {
        setOnline(false);
        const hasAccess = await repository.hasDeviceAccess(now());
        if (!owns(currentGeneration)) return;
        setGate(hasAccess ? "catalog" : "offline-lock");
        return;
      }
      setGate("error");
    }
  }, [auth, nextGeneration, now, owns, repository]);

  useEffect(() => { void authorize(); }, [authorize]);
  useEffect(() => {
    const becameOnline = () => {
      setOnline(true);
      if (!explicitLogout.current) void authorize();
    };
    const becameOffline = () => setOnline(false);
    window.addEventListener("online", becameOnline);
    window.addEventListener("offline", becameOffline);
    return () => { window.removeEventListener("online", becameOnline); window.removeEventListener("offline", becameOffline); };
  }, [authorize]);

  const login = useCallback(async (email: string, password: string) => {
    const currentGeneration = nextGeneration();
    await auth.login(email, password);
    if (!owns(currentGeneration)) return;
    const session = await auth.me();
    if (!owns(currentGeneration)) return;
    const access = await repository.authorizeDevice(session.sessionExpiresAt, now());
    if (!owns(currentGeneration)) {
      await repository.clearDeviceAccess(access);
      return;
    }
    explicitLogout.current = false;
    synchronizer.resumeAfterLogin();
    setGate("catalog");
  }, [auth, nextGeneration, now, owns, repository, synchronizer]);
  const guardSync = useCallback(async (request: () => Promise<SyncResult>) => {
    const currentGeneration = generation.current;
    const result = await request();
    if (result.state === "paused_auth" && owns(currentGeneration)) {
      await repository.clearDeviceAccess();
      if (owns(currentGeneration)) setGate("login");
    }
    return result;
  }, [owns, repository]);
  const guardedRefresh = useCallback(() => guardSync(() => synchronizer.refresh()), [guardSync, synchronizer]);
  const guardedScheduledRefresh = useCallback(
    () => guardSync(() => synchronizer.scheduleRefresh?.() ?? synchronizer.refresh()),
    [guardSync, synchronizer],
  );
  const logout = useCallback(async () => {
    explicitLogout.current = true;
    const currentGeneration = nextGeneration();
    if (mounted.current) setGate("logging-out");
    await Promise.allSettled([auth.logout(), repository.clearDeviceAccess()]);
    if (owns(currentGeneration)) setGate("login");
  }, [auth, nextGeneration, owns, repository]);

  if (gate === "loading") return <main className="gate-loading" role="status">正在验证访问权限...</main>;
  if (gate === "logging-out") return <main className="gate-loading" role="status">正在退出...</main>;
  if (gate === "login" || gate === "offline-lock") return <LoginPage onLogin={login} offline={gate === "offline-lock"} />;
  if (gate === "error") return <main className="login-page"><section className="login-panel"><h1>无法验证访问权限</h1><button className="primary-button" onClick={() => void authorize()}>重试</button></section></main>;
  return <BrowserRouter><Routes><Route path="/meetings/:id" element={<WorkspacePlaceholder />} /><Route path="*" element={<MeetingListPage repository={repository} refresh={guardedRefresh} scheduleRefresh={guardedScheduledRefresh} now={now} online={online} onLogout={() => void logout()} />} /></Routes></BrowserRouter>;
}

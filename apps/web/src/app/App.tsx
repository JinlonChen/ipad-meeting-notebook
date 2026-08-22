import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { authApi, AuthApiError, AuthNetworkError, type AuthApi } from "../auth/api.js";
import { LoginPage } from "../auth/LoginPage.js";
import { MeetingCatalogHttpApi } from "../meetings/api.js";
import { MeetingListPage, WorkspacePlaceholder } from "../meetings/MeetingListPage.js";
import { MeetingCatalogRepository } from "../meetings/repository.js";
import { CatalogSync, type SyncResult } from "../meetings/sync.js";

const defaultRepository = new MeetingCatalogRepository();
const defaultAuth = authApi();
const defaultNow = () => new Date().toISOString();

type Props = {
  repository?: MeetingCatalogRepository;
  auth?: AuthApi;
  synchronizer?: CatalogSynchronizer;
  now?: () => string;
};
export type CatalogSynchronizer = {
  refresh(): Promise<SyncResult>;
  resumeAfterLogin(): void;
};
type Gate = "loading" | "catalog" | "login" | "offline-lock" | "logging-out" | "error";

function isUnauthorized(error: unknown): boolean {
  return error instanceof AuthApiError ? error.status === 401 : typeof error === "object" && error !== null && "status" in error && error.status === 401;
}

export function App({ repository = defaultRepository, auth = defaultAuth, synchronizer: injectedSynchronizer, now = defaultNow }: Props) {
  const localSynchronizer = useMemo(() => new CatalogSync(repository, new MeetingCatalogHttpApi()), [repository]);
  const synchronizer = injectedSynchronizer ?? localSynchronizer;
  const syncRefresh = useCallback(() => synchronizer.refresh(), [synchronizer]);
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

  const login = useCallback(async (password: string) => {
    const currentGeneration = nextGeneration();
    await auth.login(password);
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
  const guardedRefresh = useCallback(async () => {
    const currentGeneration = generation.current;
    const result = await syncRefresh();
    if (result.state === "paused_auth" && owns(currentGeneration)) {
      await repository.clearDeviceAccess();
      if (owns(currentGeneration)) setGate("login");
    }
    return result;
  }, [owns, repository, syncRefresh]);
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
  return <BrowserRouter><Routes><Route path="/meetings/:id" element={<WorkspacePlaceholder />} /><Route path="*" element={<MeetingListPage repository={repository} refresh={guardedRefresh} now={now} online={online} onLogout={() => void logout()} />} /></Routes></BrowserRouter>;
}

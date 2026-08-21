import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { authApi, AuthApiError, type AuthApi } from "../auth/api.js";
import { LoginPage } from "../auth/LoginPage.js";
import { MeetingCatalogHttpApi } from "../meetings/api.js";
import { MeetingListPage, WorkspacePlaceholder } from "../meetings/MeetingListPage.js";
import { MeetingCatalogRepository } from "../meetings/repository.js";
import { CatalogSync, type SyncResult } from "../meetings/sync.js";

const defaultRepository = new MeetingCatalogRepository();
const defaultSync = new CatalogSync(defaultRepository, new MeetingCatalogHttpApi());

type Props = {
  repository?: MeetingCatalogRepository;
  auth?: AuthApi;
  refresh?: () => Promise<SyncResult>;
  now?: () => string;
};
type Gate = "loading" | "catalog" | "login" | "offline-lock";

function isUnauthorized(error: unknown): boolean {
  return error instanceof AuthApiError ? error.status === 401 : typeof error === "object" && error !== null && "status" in error && error.status === 401;
}

export function App({ repository = defaultRepository, auth = authApi(), refresh, now = () => new Date().toISOString() }: Props) {
  const syncRefresh = useMemo(() => refresh ?? (() => defaultSync.refresh()), [refresh]);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" ? true : navigator.onLine);
  const [gate, setGate] = useState<Gate>("loading");

  const authorize = useCallback(async () => {
    try {
      const session = await auth.me();
      await repository.authorizeDevice(session.sessionExpiresAt, now());
      setGate("catalog");
    } catch (error) {
      if (isUnauthorized(error)) { setGate("login"); return; }
      setOnline(false);
      setGate(await repository.hasDeviceAccess(now()) ? "catalog" : "offline-lock");
    }
  }, [auth, now, repository]);

  useEffect(() => { void authorize(); }, [authorize]);
  useEffect(() => {
    const becameOnline = () => { setOnline(true); void authorize(); };
    const becameOffline = () => setOnline(false);
    window.addEventListener("online", becameOnline);
    window.addEventListener("offline", becameOffline);
    return () => { window.removeEventListener("online", becameOnline); window.removeEventListener("offline", becameOffline); };
  }, [authorize]);

  const login = useCallback(async (password: string) => {
    await auth.login(password);
    const session = await auth.me();
    await repository.authorizeDevice(session.sessionExpiresAt, now());
    defaultSync.resumeAfterLogin();
    setGate("catalog");
  }, [auth, now, repository]);
  const guardedRefresh = useCallback(async () => {
    const result = await syncRefresh();
    if (result.state === "paused_auth") {
      await repository.clearDeviceAccess();
      setGate("login");
    }
    return result;
  }, [repository, syncRefresh]);
  const logout = useCallback(async () => {
    try { await auth.logout(); } catch { /* User intent takes precedence while offline. */ }
    await repository.clearDeviceAccess();
    setGate("login");
  }, [auth, repository]);

  if (gate === "loading") return <main className="gate-loading" role="status">正在验证访问权限...</main>;
  if (gate === "login" || gate === "offline-lock") return <LoginPage onLogin={login} offline={gate === "offline-lock"} />;
  return <BrowserRouter><Routes><Route path="/meetings/:id" element={<WorkspacePlaceholder />} /><Route path="*" element={<MeetingListPage repository={repository} refresh={guardedRefresh} now={now} online={online} onLogout={() => void logout()} />} /></Routes></BrowserRouter>;
}

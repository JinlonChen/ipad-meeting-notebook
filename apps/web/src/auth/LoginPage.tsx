import { type FormEvent, useRef, useState } from "react";

type Props = { onLogin: (email: string, password: string) => Promise<void>; offline?: boolean };

export function LoginPage({ onLogin, offline = false }: Props) {
  const password = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = password.current;
    if (!input) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const passwordValue = String(form.get("password") ?? "");
    setSubmitting(true); setError("");
    try { await onLogin(email, passwordValue); }
    catch { setError("登录未完成，请检查网络或密码后重试。"); }
    finally { input.value = ""; setSubmitting(false); }
  }

  return <main className="login-page"><section className="login-panel" aria-labelledby="login-title"><h1 id="login-title">{offline ? "离线解锁需要登录" : "登录会议本"}</h1><form onSubmit={(event) => void submit(event)}><label>邮箱<input name="email" type="email" autoComplete="email" required /></label><label>密码<input ref={password} name="password" type="password" autoComplete="current-password" required /></label>{error && <p className="field-error" role="alert">{error}</p>}<button className="primary-button" type="submit" disabled={submitting}>{submitting ? "登录中" : "登录"}</button></form></section></main>;
}

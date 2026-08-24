import { ChevronLeft } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { AiProviderConfiguration } from "./api.js";

type AiSettingsPort = { configure(input: AiProviderConfiguration): Promise<void> };

export function AiSettingsPage({ api }: { api: AiSettingsPort }) {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input: AiProviderConfiguration = {
      baseUrl: String(data.get("baseUrl") ?? "").trim(),
      asrModel: String(data.get("asrModel") ?? "").trim(),
      chatModel: String(data.get("chatModel") ?? "").trim(),
      apiKey: String(data.get("apiKey") ?? "").trim(),
    };
    setSaving(true); setMessage("");
    try {
      await api.configure(input);
      event.currentTarget.reset();
      setMessage("AI 配置已保存");
    } catch { setMessage("保存失败，请检查接口地址、模型和密钥"); }
    finally { setSaving(false); }
  };
  return <main className="workspace-shell ai-settings-page"><header className="workspace-topbar"><button className="icon-button" aria-label="返回会议" title="返回会议" onClick={() => navigate("/meetings")}><ChevronLeft size={18} /></button><h1>AI 设置</h1></header>
    <form className="ai-settings-form" onSubmit={(event) => void submit(event)}><label>兼容接口地址<input name="baseUrl" type="url" inputMode="url" placeholder="https://api.example.com/v1" required /></label><label>语音转写模型<input name="asrModel" placeholder="whisper-1" required /></label><label>总结模型<input name="chatModel" placeholder="gpt-4.1-mini" required /></label><label>API 密钥<input name="apiKey" type="password" autoComplete="off" required /></label><button className="primary-button" disabled={saving} type="submit">{saving ? "正在保存" : "保存 AI 配置"}</button><p role={message ? "status" : undefined}>{message}</p></form>
  </main>;
}

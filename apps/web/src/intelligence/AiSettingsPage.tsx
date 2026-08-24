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
      transcriptionBaseUrl: String(data.get("transcriptionBaseUrl") ?? "").trim(),
      transcriptionModel: String(data.get("transcriptionModel") ?? "").trim(),
      transcriptionApiKey: String(data.get("transcriptionApiKey") ?? "").trim(),
      summaryBaseUrl: String(data.get("summaryBaseUrl") ?? "").trim(),
      summaryModel: String(data.get("summaryModel") ?? "").trim(),
      summaryApiKey: String(data.get("summaryApiKey") ?? "").trim(),
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
    <form className="ai-settings-form" onSubmit={(event) => void submit(event)}>
      <fieldset><legend>语音转写</legend><label>转写接口地址<input name="transcriptionBaseUrl" type="url" inputMode="url" placeholder="https://dashscope.aliyuncs.com/api/v1" required /></label><label>转写模型<input name="transcriptionModel" placeholder="qwen3-asr-flash-filetrans" required /></label><label>转写 API Key<input name="transcriptionApiKey" type="password" autoComplete="off" required /></label></fieldset>
      <fieldset><legend>会议总结</legend><label>总结接口地址<input name="summaryBaseUrl" type="url" inputMode="url" placeholder="https://api.deepseek.com/v1" required /></label><label>总结模型<input name="summaryModel" placeholder="deepseek-chat" required /></label><label>总结 API Key<input name="summaryApiKey" type="password" autoComplete="off" required /></label></fieldset>
      <button className="primary-button" disabled={saving} type="submit">{saving ? "正在保存" : "保存 AI 配置"}</button><p role={message ? "status" : undefined}>{message}</p>
    </form>
  </main>;
}

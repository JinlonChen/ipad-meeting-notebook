import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";

import { AiSettingsPage } from "../../src/intelligence/AiSettingsPage.js";

describe("AiSettingsPage", () => {
  test("saves independent transcription and summary provider settings", async () => {
    const user = userEvent.setup();
    const configure = vi.fn().mockResolvedValue(undefined);
    render(<MemoryRouter><AiSettingsPage api={{ configure }} /></MemoryRouter>);

    expect(screen.getByLabelText("转写接口地址")).toHaveValue("wss://dashscope.aliyuncs.com/api-ws/v1/realtime");
    expect(screen.getByLabelText("转写模型")).toHaveValue("qwen3-asr-flash-realtime");
    await user.type(screen.getByLabelText("转写 API Key"), "asr-key");
    await user.type(screen.getByLabelText("总结接口地址"), "https://summary.example.com/v1");
    await user.type(screen.getByLabelText("总结模型"), "qwen3.6-plus");
    await user.type(screen.getByLabelText("总结 API Key"), "summary-key");
    await user.click(screen.getByRole("button", { name: "保存 AI 配置" }));

    expect(configure).toHaveBeenCalledWith({
      transcriptionBaseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
      transcriptionModel: "qwen3-asr-flash-realtime",
      transcriptionApiKey: "asr-key",
      summaryBaseUrl: "https://summary.example.com/v1",
      summaryModel: "qwen3.6-plus",
      summaryApiKey: "summary-key",
    });
    expect(await screen.findByRole("status")).toHaveTextContent("AI 配置已保存");
  });
});

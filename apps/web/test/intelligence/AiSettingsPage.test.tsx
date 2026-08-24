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

    await user.type(screen.getByLabelText("转写接口地址"), "https://asr.example.com/v1");
    await user.type(screen.getByLabelText("转写模型"), "qwen3-asr-flash-filetrans");
    await user.type(screen.getByLabelText("转写 API Key"), "asr-key");
    await user.type(screen.getByLabelText("总结接口地址"), "https://summary.example.com/v1");
    await user.type(screen.getByLabelText("总结模型"), "qwen3.6-plus");
    await user.type(screen.getByLabelText("总结 API Key"), "summary-key");
    await user.click(screen.getByRole("button", { name: "保存 AI 配置" }));

    expect(configure).toHaveBeenCalledWith({
      transcriptionBaseUrl: "https://asr.example.com/v1",
      transcriptionModel: "qwen3-asr-flash-filetrans",
      transcriptionApiKey: "asr-key",
      summaryBaseUrl: "https://summary.example.com/v1",
      summaryModel: "qwen3.6-plus",
      summaryApiKey: "summary-key",
    });
  });
});

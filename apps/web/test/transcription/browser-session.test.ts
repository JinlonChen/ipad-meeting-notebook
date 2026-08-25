import { describe, expect, test, vi } from "vitest";

import { BrowserRealtimeTranscriptionSession, type RealtimeTranscriptionUpdate } from "../../src/transcription/browser-session.js";

class FakeSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  readonly send = vi.fn();
  readonly close = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code: 1000 }));
  });

  open() {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  message(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

function audioHarness() {
  let process: ((event: AudioProcessingEvent) => unknown) | null = null;
  const processor = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    get onaudioprocess() { return process; },
    set onaudioprocess(listener) { process = listener; },
  } as unknown as ScriptProcessorNode;
  const source = { connect: vi.fn(), disconnect: vi.fn() } as unknown as MediaStreamAudioSourceNode;
  const context = {
    sampleRate: 48_000,
    state: "suspended",
    destination: {},
    createMediaStreamSource: vi.fn(() => source),
    createScriptProcessor: vi.fn(() => processor),
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as AudioContext;
  return { context, processor, source, emit(samples: Float32Array) {
    process?.({ inputBuffer: { getChannelData: () => samples } } as unknown as AudioProcessingEvent);
  } };
}

describe("BrowserRealtimeTranscriptionSession", () => {
  test("connects through the authenticated relay and streams PCM16 audio", async () => {
    const socket = new FakeSocket();
    const audio = audioHarness();
    const updates: RealtimeTranscriptionUpdate[] = [];
    let socketUrl = "";
    const session = new BrowserRealtimeTranscriptionSession({
      relayUrl: "https://relay.example.com",
      meetingId: "00000000-0000-4000-8000-000000000001",
      accessToken: async () => "header.payload.signature",
      createSocket: (url) => { socketUrl = url; return socket as unknown as WebSocket; },
      createAudioContext: () => audio.context,
      onUpdate: (update) => updates.push(update),
    });

    await session.start({} as MediaStream);
    expect(audio.context.resume).toHaveBeenCalledOnce();
    expect(socketUrl).toBe("wss://relay.example.com/v1/realtime-transcription?meetingId=00000000-0000-4000-8000-000000000001");
    expect(updates).toContainEqual({ type: "status", status: "connecting" });
    expect(socket.send).not.toHaveBeenCalled();

    socket.open();
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "authenticate", accessToken: "header.payload.signature" }));
    socket.message({ type: "ready" });
    audio.emit(new Float32Array([1, 1, 1, -1, -1, -1]));

    expect(updates).toContainEqual({ type: "status", status: "streaming" });
    expect(socket.send).toHaveBeenCalledWith(expect.any(Uint8Array));
    const sent = socket.send.mock.calls.at(-1)?.[0] as Uint8Array;
    expect(Array.from(sent)).toEqual([255, 127, 0, 128]);
  });

  test("forwards partial and persisted final relay messages", async () => {
    const socket = new FakeSocket();
    const updates: RealtimeTranscriptionUpdate[] = [];
    const session = new BrowserRealtimeTranscriptionSession({
      relayUrl: "https://relay.example.com",
      meetingId: "00000000-0000-4000-8000-000000000001",
      accessToken: async () => "token",
      createSocket: () => socket as unknown as WebSocket,
      createAudioContext: () => audioHarness().context,
      onUpdate: (update) => updates.push(update),
    });
    await session.start({} as MediaStream);
    socket.message({ type: "partial", text: "正在讨论" });
    socket.message({ type: "final", segment: { id: "segment-1", text: "形成结论" } });

    expect(updates).toContainEqual({ type: "partial", text: "正在讨论" });
    expect(updates).toContainEqual({ type: "final", segment: { id: "segment-1", text: "形成结论" } });
  });

  test("pauses on network loss and releases audio resources on stop", async () => {
    const socket = new FakeSocket();
    const audio = audioHarness();
    const updates: RealtimeTranscriptionUpdate[] = [];
    let offline: () => void = () => undefined;
    const unsubscribe = vi.fn();
    const session = new BrowserRealtimeTranscriptionSession({
      relayUrl: "https://relay.example.com",
      meetingId: "00000000-0000-4000-8000-000000000001",
      accessToken: async () => "token",
      createSocket: () => socket as unknown as WebSocket,
      createAudioContext: () => audio.context,
      onUpdate: (update) => updates.push(update),
      network: {
        online: () => true,
        subscribe: (_online, nextOffline) => { offline = nextOffline; return unsubscribe; },
      },
    });
    await session.start({} as MediaStream);

    offline();
    expect(updates).toContainEqual({ type: "status", status: "paused" });

    await session.stop();
    expect(audio.source.disconnect).toHaveBeenCalledOnce();
    expect(audio.processor.disconnect).toHaveBeenCalledOnce();
    expect(audio.context.close).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(updates.at(-1)).toEqual({ type: "status", status: "idle" });
  });
});

import { downsampleToPcm16 } from "./pcm.js";

export type RealtimeTranscriptionStatus = "idle" | "connecting" | "streaming" | "paused" | "failed";

export type RealtimeTranscriptionSnapshot = {
  status: RealtimeTranscriptionStatus;
  partial: string;
  revision: number;
};

export type RealtimeTranscriptionUpdate =
  | { type: "status"; status: RealtimeTranscriptionStatus }
  | { type: "partial"; text: string }
  | { type: "final"; segment: Record<string, unknown> }
  | { type: "error"; message: string };

export type RealtimeTranscriptionSession = {
  start(stream: MediaStream): Promise<void>;
  stop(): Promise<void>;
};

type NetworkPort = {
  online(): boolean;
  subscribe(online: () => void, offline: () => void): () => void;
};

type Dependencies = {
  supabaseUrl: string;
  meetingId: string;
  accessToken(): Promise<string | null>;
  createSocket?(url: string): WebSocket;
  createAudioContext?(): AudioContext;
  network?: NetworkPort;
  onUpdate(update: RealtimeTranscriptionUpdate): void;
};

const defaultNetwork: NetworkPort = {
  online: () => typeof navigator === "undefined" || navigator.onLine,
  subscribe: (online, offline) => {
    if (typeof window === "undefined") return () => undefined;
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  },
};

function relayUrl(supabaseUrl: string, meetingId: string, accessToken: string): string {
  const url = new URL("/functions/v1/realtime-transcription", supabaseUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.searchParams.set("meetingId", meetingId);
  url.searchParams.set("access_token", accessToken);
  return url.toString();
}

function messageRecord(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export class BrowserRealtimeTranscriptionSession implements RealtimeTranscriptionSession {
  private readonly network: NetworkPort;
  private socket: WebSocket | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private unsubscribeNetwork: (() => void) | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private providerReady = false;
  private stopped = true;

  constructor(private readonly dependencies: Dependencies) {
    this.network = dependencies.network ?? defaultNetwork;
  }

  async start(stream: MediaStream): Promise<void> {
    if (!this.stopped) throw new Error("TRANSCRIPTION_ALREADY_ACTIVE");
    this.stopped = false;
    this.createAudioGraph(stream);
    this.unsubscribeNetwork = this.network.subscribe(
      () => { this.reconnectAttempts = 0; void this.connect().catch(() => undefined); },
      () => {
        this.emitStatus("paused");
        this.socket?.close(1000, "offline");
      },
    );
    await this.connect();
  }

  private createAudioGraph(stream: MediaStream): void {
    const context = this.dependencies.createAudioContext?.() ?? new AudioContext({ latencyHint: "interactive" });
    if (context.state === "suspended") void context.resume().catch(() => undefined);
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4_096, 1, 1);
    processor.onaudioprocess = (event) => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN || !this.providerReady) return;
      const pcm = downsampleToPcm16(event.inputBuffer.getChannelData(0), context.sampleRate);
      if (pcm.byteLength > 0) socket.send(pcm);
    };
    source.connect(processor);
    processor.connect(context.destination);
    this.context = context;
    this.source = source;
    this.processor = processor;
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.socket || !this.network.online()) {
      if (!this.stopped && !this.network.online()) this.emitStatus("paused");
      return;
    }
    this.emitStatus("connecting");
    this.providerReady = false;
    const token = await this.dependencies.accessToken();
    if (!token) {
      this.emitStatus("failed");
      throw new Error("AUTH_REQUIRED");
    }
    if (this.stopped) return;
    const socket = (this.dependencies.createSocket ?? ((url: string) => new WebSocket(url)))(relayUrl(this.dependencies.supabaseUrl, this.dependencies.meetingId, token));
    this.socket = socket;
    socket.addEventListener("message", (event) => this.handleMessage(event.data));
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.providerReady = false;
      if (this.stopped) return;
      this.emitStatus("paused");
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      if (!this.stopped) this.emitStatus("failed");
    });
  }

  private handleMessage(data: unknown): void {
    const message = messageRecord(data);
    if (!message || typeof message.type !== "string") return;
    if (message.type === "ready") {
      this.reconnectAttempts = 0;
      this.providerReady = true;
      this.emitStatus("streaming");
    } else if (message.type === "partial" && typeof message.text === "string") {
      this.dependencies.onUpdate({ type: "partial", text: message.text });
    } else if (message.type === "final" && message.segment && typeof message.segment === "object" && !Array.isArray(message.segment)) {
      this.dependencies.onUpdate({ type: "final", segment: message.segment as Record<string, unknown> });
    } else if (message.type === "error") {
      const errorMessage = typeof message.message === "string" ? message.message : "ASR_ERROR";
      this.dependencies.onUpdate({ type: "error", message: errorMessage });
      this.emitStatus("failed");
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.network.online() || this.reconnectTimer !== null || this.reconnectAttempts >= 5) return;
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempts, 8_000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => {
        this.emitStatus("failed");
        this.scheduleReconnect();
      });
    }, delay);
  }

  private emitStatus(status: RealtimeTranscriptionStatus): void {
    this.dependencies.onUpdate({ type: "status", status });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.unsubscribeNetwork?.();
    this.unsubscribeNetwork = null;
    const socket = this.socket;
    this.socket = null;
    this.providerReady = false;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "recording-stopped");
    if (this.processor) this.processor.onaudioprocess = null;
    this.source?.disconnect();
    this.processor?.disconnect();
    const context = this.context;
    this.source = null;
    this.processor = null;
    this.context = null;
    await context?.close();
    this.emitStatus("idle");
  }
}

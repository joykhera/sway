import { MUSIC_WS_PATH, type ClientMessage, type ServerMessage } from '../shared/protocol.ts';
import type { MusicTransport, TransportHandlers } from './types.ts';

export type WebSocketLike = {
  binaryType: string;
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
};

const OPEN = 1;

export function defaultMusicUrl(loc: { protocol: string; host: string }): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${MUSIC_WS_PATH}`;
}

export class WebSocketTransport implements MusicTransport {
  private ws: WebSocketLike | undefined;

  constructor(
    private readonly url: string,
    private readonly createSocket: (url: string) => WebSocketLike = (u) => new WebSocket(u) as unknown as WebSocketLike,
  ) {}

  connect(h: TransportHandlers): void {
    const ws = this.createSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => h.onOpen();
    ws.onmessage = ({ data }) => {
      if (typeof data === 'string') {
        const msg = parseServerMessage(data);
        if (msg) h.onMessage(msg);
      } else if (data instanceof ArrayBuffer) {
        h.onAudio(data);
      }
    };
    // onerror is always followed by onclose; one signal is enough.
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws === ws) h.onClose();
    };
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    const ws = this.ws;
    this.ws = undefined;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    ws.close();
  }
}

export function parseServerMessage(raw: string): ServerMessage | undefined {
  try {
    const msg = JSON.parse(raw) as { type?: unknown };
    return msg && (msg.type === 'status' || msg.type === 'ready' || msg.type === 'error')
      ? (msg as ServerMessage)
      : undefined;
  } catch {
    return undefined;
  }
}

import type { ClientMessage, ServerMessage } from '../shared/protocol.ts';

export type TransportHandlers = {
  onOpen(): void;
  onMessage(msg: ServerMessage): void;
  onAudio(bytes: ArrayBuffer): void;
  onClose(): void;
};

// One instance = one socket. Reconnecting means creating a new instance.
export interface MusicTransport {
  connect(handlers: TransportHandlers): void;
  send(msg: ClientMessage): void; // dropped if the socket is not open
  close(): void; // idempotent; does not call onClose
}

export type TransportFactory = () => MusicTransport;

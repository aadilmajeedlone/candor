import type { SttProviderId } from '@shared/types';

export interface SttConfig {
  language: string;
  model: string;
  endpointingMs: number;
  diarize: boolean;
  /** Override the provider endpoint (tests). */
  baseUrl?: string;
}

export interface SttTranscript {
  text: string;
  /** The provider will not revise this text. */
  isFinal: boolean;
  /** The provider believes the speaker finished (endpoint). May carry empty text. */
  speechFinal: boolean;
  confidence?: number;
  /** Diarization label when available (0-based). */
  speaker?: number;
}

export type SttState = 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error';

export interface SttEvents {
  onTranscript(t: SttTranscript): void;
  onState(state: SttState, message?: string, fatal?: boolean): void;
  /** Something the user should know that is not a connection change (for example: recognition is falling behind). */
  onNotice?(level: 'info' | 'warn', message: string): void;
}

export interface SttStream {
  /** 16 kHz mono PCM16 little-endian. */
  sendAudio(pcm: Uint8Array): void;
  /** Ask the provider to flush pending audio into a final result now. */
  finalize(): void;
  close(): Promise<void>;
  readonly state: SttState;
}

export interface SttProvider {
  readonly id: SttProviderId;
  readonly label: string;
  /** Cloud services need an API key; the on-device engine does not. */
  readonly needsKey: boolean;
  open(cfg: SttConfig, apiKey: string, events: SttEvents): SttStream;
}

export class SttAuthError extends Error {
  constructor(provider: string) {
    super(`${provider} rejected the API key.`);
    this.name = 'SttAuthError';
  }
}

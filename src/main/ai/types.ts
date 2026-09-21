import type { ProviderMeta } from '@core/live/types';
import type { ModelConfig, ProviderConfig } from '@shared/types';

export interface HttpInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** Transport abstraction: Electron's Chromium network stack in the app, Node's fetch in tests. */
export interface HttpClient {
  fetch(url: string, init: HttpInit): Promise<Response>;
  /** Open (and keep warm) a connection to the origin before it is needed. */
  preconnect?(url: string): void;
}

export interface ChatRequest {
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  topP?: number | null;
  /** Ask for a JSON object. */
  json?: boolean;
  /** JSON Schema of that object, for providers that can enforce one natively. */
  schema?: Record<string, unknown>;
  /** Favour latency over deliberation (e.g. minimal reasoning effort). */
  fast?: boolean;
  /** Keep hidden reasoning small so the output budget goes to the reply (structured replies, where a cut-off reply is useless). */
  minimalReasoning?: boolean;
  signal?: AbortSignal;
}

export type StreamChunk = { type: 'text'; text: string } | { type: 'done'; finishReason: 'stop' | 'length' | 'other'; meta?: ProviderMeta };

export interface ResolvedModel {
  provider: ProviderConfig;
  model: ModelConfig;
  apiKey: string | null;
}

export interface CompleteResult {
  text: string;
  finishReason: 'stop' | 'length' | 'other';
  meta?: ProviderMeta;
}

/** A model list, optionally with a note for the user (for example: "a built-in list is shown"). */
export type ListedModels = string[] | { models: string[]; note?: string };

export interface ProviderAdapter {
  stream(r: ResolvedModel, req: ChatRequest, http: HttpClient): AsyncGenerator<StreamChunk>;
  complete(r: ResolvedModel, req: ChatRequest, http: HttpClient): Promise<CompleteResult>;
  listModels(provider: ProviderConfig, apiKey: string | null, http: HttpClient, signal?: AbortSignal): Promise<ListedModels>;
}

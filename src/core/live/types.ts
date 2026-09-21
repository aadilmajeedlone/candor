import type { AiTask, AnswerRecord, Speaker } from '@shared/types';

export interface LlmGenerateRequest {
  task: Extract<AiTask, 'live' | 'prep' | 'classify' | 'mock'>;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  signal: AbortSignal;
  /** Called for every text delta. Not called when streaming is disabled or falls back to a full response. */
  onToken?: (text: string) => void;
  /** Visible status messages (fallback used, retrying…). Never swallowed. */
  onNotice?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Ask the provider for a JSON object (used for structured analysis). */
  json?: boolean;
  /** JSON Schema of that object. A provider that can enforce a schema does; the rest rely on `json` and the prompt. */
  schema?: Record<string, unknown>;
  /** The reply is data, not deliberation: keep hidden reasoning small so the output budget goes to the reply itself. */
  minimalReasoning?: boolean;
}

/** What the provider said about a reply. Never contains the reply's content. */
export interface ProviderMeta {
  /** The provider's id for this reply, when it gives one. */
  responseId?: string;
  /** The provider's own words for why the reply ended ("STOP", "MAX_TOKENS", "length"...). */
  rawFinishReason?: string;
  /** False when a stream ended without the provider saying it had finished (a dropped or cut connection). */
  completed: boolean;
  usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number };
  /** How structured output was asked for, after adapting to what the model accepts. */
  structured?: 'schema' | 'json' | 'none';
  /** Whether hidden reasoning was limited for this request. */
  reasoning?: 'default' | 'limited';
  /** Request parameters the model refused; the adapter dropped them (and remembers not to send them again). */
  adapted?: string[];
}

export interface LlmReplyMeta extends ProviderMeta {
  streamed: boolean;
  /** Milliseconds from sending the request to having the whole reply. */
  ms: number;
  /** The output limit that was actually sent. */
  maxTokens: number;
}

export interface LlmGenerateResult {
  text: string;
  /** Normalised: 'stop' | 'length' | 'other'. */
  finishReason: 'stop' | 'length' | 'other';
  model: string;
  provider: string;
  usedFallback: boolean;
  meta?: LlmReplyMeta;
}

/** What the live engine needs from the AI layer. The main process provides the real implementation. */
export interface LlmGateway {
  generate(req: LlmGenerateRequest): Promise<LlmGenerateResult>;
  /** Establish connections / prime prefix caches before the first question. Best effort, never throws. */
  warm?(task: 'live', staticPrefix: string): Promise<void>;
}

export interface EnginePersistence {
  saveAnswer(record: Omit<AnswerRecord, 'id' | 'createdAt'>): string | null;
  saveTranscript(seg: { speaker: Speaker; text: string; ts: number }): void;
  updateFeedback(answerId: string, tags: string[]): void;
}

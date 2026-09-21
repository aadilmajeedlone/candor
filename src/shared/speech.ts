import type { SttProviderId } from './types';

/** Types for speech recognition that runs on this PC. Shared by the main process and the settings screen. */

export type LocalModelId = 'x-asr-160' | 'zipformer-en-70m';
export type LocalModelTier = 'accurate' | 'light';
/** "auto" picks by this PC's cores and memory; the other two force a model. */
export type LocalModelPreference = 'auto' | LocalModelTier;

export type LocalSttFailure = 'model_missing' | 'model_incomplete' | 'runtime_missing' | 'model_load_failed' | 'worker_crashed';
export type LocalSttState = 'idle' | 'loading' | 'ready' | 'failed';

export interface LocalSttStatus {
  state: LocalSttState;
  /** The model in use (ready/loading) or the one that would be used (idle/failed). */
  modelId: LocalModelId;
  modelLabel: string;
  tier: LocalModelTier;
  modelSize: string;
  /** How long the last model load took. */
  loadMs: number | null;
  rssMb: number | null;
  code: LocalSttFailure | null;
  message: string | null;
  openStreams: number;
  /** Audio waiting to be recognised, in milliseconds (0 when keeping up with the microphone). */
  lagMs: number;
}

/** Result of "Test speech recognition" for any provider. */
export interface SttTestResult {
  ok: boolean;
  error?: string;
  /** Cloud: time to connect. On this PC: time until the first words of the built-in sample appeared. */
  latencyMs?: number;
  /** A sentence describing what was measured, shown under the button. */
  detail?: string;
}

/** How each speech provider is named in the interface. */
export const STT_LABELS: Record<SttProviderId, string> = { local: 'On this PC', deepgram: 'Deepgram', assemblyai: 'AssemblyAI' };

export function sttLabel(provider: string): string {
  return STT_LABELS[provider as SttProviderId] ?? provider;
}

/** The provider as the subject of a sentence. */
export function sttName(provider: string): string {
  return provider === 'local' ? 'The on-device speech engine' : sttLabel(provider);
}

/** What each on-device model is, in words (also the source of the labels in the main process). */
export const LOCAL_MODEL_INFO: Record<LocalModelId, { tier: LocalModelTier; label: string; description: string }> = {
  'x-asr-160': {
    tier: 'accurate',
    label: 'Accurate — X-ASR streaming (English + Chinese)',
    description: 'Most accurate on names, technical terms and accents; writes capitals and punctuation itself. Uses about half of one CPU core and ~300 MB of memory while listening.',
  },
  'zipformer-en-70m': {
    tier: 'light',
    label: 'Light — Zipformer streaming (English)',
    description: 'A quarter of the CPU load of the accurate model, so it keeps up on slower or busier PCs; less reliable on names, jargon and accents.',
  },
};

/** Failures that mean the on-device engine cannot be used until something changes (as opposed to a passing hiccup). */
const UNUSABLE: LocalSttFailure[] = ['model_missing', 'model_incomplete', 'runtime_missing'];

export function localSpeechUsable(status: LocalSttStatus | null | undefined): boolean {
  return !status?.code || !UNUSABLE.includes(status.code);
}

import type { LocalModelPreference } from './speech';
import type { AiTask, AnswerMode, SttProviderId, TaskRouting } from './types';

export type ThemeSetting = 'dark' | 'light' | 'system';
export type VadSensitivity = 'low' | 'medium' | 'high';
export type SpeculationLevel = 'off' | 'balanced' | 'aggressive';
export type InterviewerSource = 'system' | 'mic';

export const HOTKEY_ACTIONS = [
  'toggleListening',
  'generate',
  'shorter',
  'expand',
  'star',
  'regenerate',
  'copy',
  'cycleMode',
] as const;
export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number];

export const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  toggleListening: 'Pause / resume listening',
  generate: 'Answer current question',
  shorter: 'Shorter answer',
  expand: 'Expand answer',
  star: 'Convert to STAR',
  regenerate: 'Regenerate',
  copy: 'Copy answer',
  cycleMode: 'Cycle answer mode',
};

export interface AppSettings {
  theme: ThemeSetting;
  fontScale: number;
  highContrast: boolean;
  reducedMotion: 'system' | 'on' | 'off';
  defaultMode: AnswerMode;
  vadSensitivity: VadSensitivity;
  audio: {
    micDeviceId: string | null;
    interviewerSource: InterviewerSource;
    transcribeMyVoice: boolean;
    noiseSuppression: boolean;
    echoCancellation: boolean;
    autoGainControl: boolean;
  };
  stt: {
    provider: SttProviderId;
    fallbackProvider: SttProviderId | 'none';
    /** Which on-device model to use when the provider is "local". */
    localModel: LocalModelPreference;
    language: string;
    model: string;
    endpointingMs: number;
    diarize: boolean;
  };
  live: {
    speculation: SpeculationLevel;
    prewarm: boolean;
    autoAnswer: boolean;
    keepOnTop: boolean;
    /** After an answer is shown, require a stronger question signal for this long (ms) so the candidate's own reply is not treated as a question. */
    answerHoldMs: number;
    showDebugPanel: boolean;
    consentAcceptedAt: number | null;
  };
  hotkeys: Record<HotkeyAction, string>;
  privacy: {
    storeTranscripts: boolean;
    storeAnswers: boolean;
  };
  notifications: {
    /** In-app messages (toasts). */
    toasts: boolean;
    /** OS notification when background work finishes while the window is not focused. */
    desktop: boolean;
  };
  routing: TaskRouting;
  customInstructions: string;
  onboarding: { completed: boolean; step: number };
}

export const AI_TASKS: AiTask[] = ['live', 'prep', 'classify', 'mock'];

export const AI_TASK_LABELS: Record<AiTask, { label: string; hint: string }> = {
  live: { label: 'Live answers', hint: 'Fastest suitable model. Time-to-first-token matters most.' },
  prep: { label: 'Preparation', hint: 'Higher-quality model for résumé/JD analysis and prep material.' },
  classify: { label: 'Classification', hint: 'Lightweight model for tagging and ambiguous-utterance checks.' },
  mock: { label: 'Mock interview', hint: 'Interviewer questions and answer evaluation.' },
};

const emptyRoute = { primary: null, fallback: null };

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  fontScale: 1,
  highContrast: false,
  reducedMotion: 'system',
  defaultMode: 'standard',
  vadSensitivity: 'medium',
  audio: {
    micDeviceId: null,
    interviewerSource: 'system',
    transcribeMyVoice: false,
    noiseSuppression: true,
    echoCancellation: false,
    autoGainControl: true,
  },
  stt: {
    provider: 'local', // free, private, no account: the default; cloud services are opt-in
    fallbackProvider: 'none',
    localModel: 'auto',
    language: 'en',
    model: 'nova-3',
    endpointingMs: 300,
    diarize: false,
  },
  live: {
    speculation: 'balanced',
    prewarm: true,
    autoAnswer: true,
    keepOnTop: false,
    answerHoldMs: 6000,
    showDebugPanel: false,
    consentAcceptedAt: null,
  },
  hotkeys: {
    toggleListening: 'CommandOrControl+Shift+Space',
    generate: 'CommandOrControl+Shift+A',
    shorter: 'CommandOrControl+Shift+S',
    expand: 'CommandOrControl+Shift+E',
    star: 'CommandOrControl+Shift+T',
    regenerate: 'CommandOrControl+Shift+R',
    copy: 'CommandOrControl+Shift+C',
    cycleMode: 'CommandOrControl+Shift+M',
  },
  privacy: {
    storeTranscripts: true,
    storeAnswers: true,
  },
  notifications: {
    toasts: true,
    desktop: true,
  },
  routing: {
    live: { ...emptyRoute },
    prep: { ...emptyRoute },
    classify: { ...emptyRoute },
    mock: { ...emptyRoute },
  },
  customInstructions: '',
  onboarding: { completed: false, step: 0 },
};

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** Deep-merge `patch` into `base` without mutating either. Arrays and null are replaced, not merged. */
export function mergeSettings<T extends object>(base: T, patch: DeepPartial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    const current = out[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      out[key] = mergeSettings(current, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

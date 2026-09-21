import type {
  AnswerMode,
  FeedbackTag,
  GroundingReport,
  Id,
  Speaker,
  SttProviderId,
  TurnLatency,
} from './types';

/** What the live engine is doing right now. Drives the status pill and the bottom bar. */
export type LiveStatus =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'analyzing'
  | 'retrieving'
  | 'generating'
  | 'complete'
  | 'paused'
  | 'error';

export const LIVE_STATUS_LABEL: Record<LiveStatus, string> = {
  idle: 'Idle',
  listening: 'Listening…',
  transcribing: 'Transcribing…',
  analyzing: 'Analyzing…',
  retrieving: 'Retrieving context…',
  generating: 'Generating…',
  complete: 'Complete',
  paused: 'Paused',
  error: 'Needs attention',
};

export type QuestionKind =
  | 'behavioral'
  | 'situational'
  | 'technical'
  | 'leadership'
  | 'hr'
  | 'role-specific'
  | 'closing'
  | 'follow-up'
  | 'other';

export interface DetectedQuestion {
  text: string;
  kind: QuestionKind;
  confidence: number;
  isFollowUp: boolean;
  /** True while the interviewer may still be speaking (answer is a draft and can be restarted). */
  speculative: boolean;
}

export interface RetrievalSummary {
  factIds: Id[];
  storyIds: Id[];
  /** Top hybrid relevance (0..1). */
  confidence: number;
  /** Short labels for the "Context" chips, e.g. "Amazon — Ops Manager". */
  labels: string[];
  usedResume: boolean;
  usedJd: boolean;
  usedStory: boolean;
  tokensApprox: number;
}

export interface SttStatus {
  source: 'system' | 'mic';
  provider: SttProviderId;
  state: 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error';
  message?: string;
}

export type LiveNoticeLevel = 'info' | 'warn' | 'error';

export type LiveEvent =
  | { type: 'status'; status: LiveStatus; detail?: string }
  | {
      type: 'transcript';
      segmentId: string;
      speaker: Speaker;
      /** Provider diarization label such as "Speaker 2" (hint only; single-microphone mode). */
      label?: string;
      text: string;
      isFinal: boolean;
      ts: number;
    }
  | { type: 'question'; requestId: string; question: DetectedQuestion }
  | {
      type: 'answer-start';
      requestId: string;
      mode: AnswerMode;
      source: 'llm' | 'cache';
      model: string | null;
      speculative: boolean;
      retrieval: RetrievalSummary;
    }
  | { type: 'answer-token'; requestId: string; text: string }
  | { type: 'answer-replace'; requestId: string; text: string }
  | {
      type: 'answer-done';
      requestId: string;
      answerId: Id | null;
      text: string;
      finishReason: string;
      latency: TurnLatency;
      grounding: GroundingReport;
    }
  | { type: 'answer-cancelled'; requestId: string; reason: string }
  | { type: 'answer-confirmed'; requestId: string; answerId: Id | null }
  | { type: 'notice'; level: LiveNoticeLevel; message: string; code?: string }
  | { type: 'stt'; status: SttStatus }
  | { type: 'mode'; mode: AnswerMode }
  | { type: 'listening'; listening: boolean; paused: boolean }
  | { type: 'feedback'; answerId: Id; tags: FeedbackTag[] }
  | { type: 'followups'; requestId: string; questions: string[] };

/** Generic streaming events for non-live generation (prep, transforms, mock). */
export type GenEvent =
  | { requestId: string; type: 'token'; text: string }
  | { requestId: string; type: 'done'; text: string; model: string | null; ttftMs: number | null; totalMs: number }
  | { requestId: string; type: 'error'; code: string; message: string }
  | { requestId: string; type: 'notice'; message: string };

export interface PrepProgress {
  interviewId: Id;
  step: string;
  done: number;
  total: number;
  error?: string;
}

export interface BenchProgress {
  runId: string;
  done: number;
  total: number;
  lastTtftMs: number | null;
  lastTotalMs: number | null;
}

/** All main → renderer push channels. */
export interface PushChannels {
  'live.event': LiveEvent;
  'gen.event': GenEvent;
  'prep.progress': PrepProgress;
  'bench.progress': BenchProgress;
  'hotkey': { action: string };
  'app.notice': { level: LiveNoticeLevel; message: string };
  'audio.command': { command: 'start' | 'stop'; sources: ('mic' | 'system')[] };
}

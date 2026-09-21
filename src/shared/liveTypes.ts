import type { DetectedQuestion, LiveStatus } from './events';
import type { AnswerMode } from './types';

/** Snapshot of the live engine, used to restore the Live screen after a reload. */
export interface EngineSnapshotDTO {
  status: LiveStatus;
  running: boolean;
  paused: boolean;
  mode: AnswerMode;
  question: DetectedQuestion | null;
  requestId: string | null;
  answer: string;
  done: boolean;
  sessionId: string | null;
}

import { create } from 'zustand';
import type { DetectedQuestion, LiveEvent, LiveStatus, RetrievalSummary, SttStatus } from '@shared/events';
import type { AnswerMode, GroundingReport, TurnLatency } from '@shared/types';
import { call } from '@/services/api';

export interface Segment {
  id: string;
  speaker: 'interviewer' | 'candidate' | 'unknown';
  label?: string;
  text: string;
  isFinal: boolean;
}

export interface TurnRecord {
  requestId: string;
  question: string;
  answer: string;
  latency: TurnLatency | null;
}

export interface LiveNotice {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  code?: string;
}

interface LiveState {
  running: boolean;
  paused: boolean;
  status: LiveStatus;
  statusDetail: string | undefined;
  sessionId: string | null;
  interviewId: string | null;
  startedAt: number | null;
  mode: AnswerMode;
  segments: Segment[];
  question: DetectedQuestion | null;
  requestId: string | null;
  answer: string;
  answerDone: boolean;
  answerSource: 'llm' | 'cache' | null;
  speculative: boolean;
  model: string | null;
  retrieval: RetrievalSummary | null;
  latency: TurnLatency | null;
  grounding: GroundingReport | null;
  answerId: string | null;
  feedback: string[];
  followups: string[];
  turns: TurnRecord[];
  notices: LiveNotice[];
  stt: Partial<Record<'mic' | 'system', SttStatus>>;
  levels: { mic: number; system: number };
  /** Which audio sources are being captured for this session. */
  sources: ('mic' | 'system')[];
  begin: (sessionId: string, interviewId: string | null, mode: AnswerMode) => void;
  setSources: (sources: ('mic' | 'system')[]) => void;
  apply: (e: LiveEvent) => void;
  setLevel: (source: 'mic' | 'system', rms: number) => void;
  dismissNotice: (id: number) => void;
  reset: () => void;
}

const initial = {
  running: false,
  paused: false,
  status: 'idle' as LiveStatus,
  statusDetail: undefined,
  sessionId: null,
  interviewId: null,
  startedAt: null,
  segments: [] as Segment[],
  question: null,
  requestId: null,
  answer: '',
  answerDone: false,
  answerSource: null,
  speculative: false,
  model: null,
  retrieval: null,
  latency: null,
  grounding: null,
  answerId: null,
  feedback: [] as string[],
  followups: [] as string[],
  turns: [] as TurnRecord[],
  notices: [] as LiveNotice[],
  stt: {},
  levels: { mic: 0, system: 0 },
  sources: [] as ('mic' | 'system')[],
};

// Tokens arrive far faster than the screen refreshes. Coalesce them into one state update per frame, but paint the
// very first token immediately: it is the moment the candidate can start speaking.
let pending = '';
let pendingRequest: string | null = null;
let raf = 0;
let noticeId = 0;
let firstTokenAt: { requestId: string; at: number } | null = null;

export const useLive = create<LiveState>((set, get) => {
  const flush = () => {
    raf = 0;
    if (!pending) return;
    const text = pending;
    const req = pendingRequest;
    pending = '';
    set((s) => (s.requestId === req ? { answer: s.answer + text } : {}));
  };

  return {
    ...initial,
    mode: 'standard',

    begin(sessionId, interviewId, mode) {
      pending = '';
      set({ ...initial, running: true, status: 'listening', sessionId, interviewId, mode, startedAt: Date.now() });
    },

    reset() {
      pending = '';
      set({ ...initial });
    },

    setSources(sources) {
      set({ sources });
    },

    setLevel(source, rms) {
      set((s) => ({ levels: { ...s.levels, [source]: rms } }));
    },

    dismissNotice(id) {
      set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
    },

    apply(e) {
      const receivedAt = performance.now();
      switch (e.type) {
        case 'status':
          set({ status: e.status, statusDetail: e.detail });
          break;
        case 'listening':
          set({ running: e.listening, paused: e.paused });
          break;
        case 'mode':
          set({ mode: e.mode });
          break;
        case 'transcript': {
          set((s) => {
            const idx = s.segments.findIndex((x) => x.id === e.segmentId);
            const seg: Segment = { id: e.segmentId, speaker: e.speaker, label: e.label, text: e.text, isFinal: e.isFinal };
            const segments = idx >= 0 ? s.segments.map((x, i) => (i === idx ? seg : x)) : [...s.segments, seg];
            return { segments: segments.slice(-60) };
          });
          break;
        }
        case 'question': {
          // A new request replaces whatever answer was on screen; the previous one is archived.
          set((s) => {
            const archive = s.requestId && s.answer && s.answerDone && s.question ? [...s.turns, { requestId: s.requestId, question: s.question.text, answer: s.answer, latency: s.latency }].slice(-12) : s.turns;
            pending = '';
            return {
              turns: archive,
              question: e.question,
              requestId: e.requestId || null,
              answer: '',
              answerDone: false,
              answerSource: null,
              speculative: e.question.speculative,
              latency: null,
              grounding: null,
              answerId: null,
              feedback: [],
              followups: [],
              retrieval: null,
            };
          });
          break;
        }
        case 'answer-start':
          set((s) => (s.requestId === e.requestId ? { answerSource: e.source, speculative: e.speculative, retrieval: e.retrieval, model: e.model } : {}));
          break;
        case 'answer-token': {
          const s = get();
          if (s.requestId !== e.requestId) return; // stale request: never let it overwrite the active answer
          if (s.answer === '' && !pending) {
            firstTokenAt = { requestId: e.requestId, at: receivedAt };
            set({ answer: e.text });
            // Paint latency: from this event to the frame that shows the first word.
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                if (firstTokenAt?.requestId === e.requestId) {
                  void call('live.reportUi', { requestId: e.requestId, firstPaintMs: Math.round((performance.now() - firstTokenAt.at) * 10) / 10 }).catch(() => undefined);
                  set((st) => (st.requestId === e.requestId ? { latency: { ...(st.latency ?? {}), uiFirstPaintMs: Math.round((performance.now() - (firstTokenAt?.at ?? receivedAt)) * 10) / 10 } } : {}));
                }
              }),
            );
            break;
          }
          pending += e.text;
          pendingRequest = e.requestId;
          if (!raf) raf = requestAnimationFrame(flush);
          break;
        }
        case 'answer-replace':
          if (get().requestId === e.requestId) {
            pending = '';
            set({ answer: e.text });
          }
          break;
        case 'answer-done':
          if (get().requestId === e.requestId) {
            pending = '';
            set((s) => ({ answer: e.text, answerDone: true, latency: { ...e.latency, uiFirstPaintMs: s.latency?.uiFirstPaintMs }, grounding: e.grounding, answerId: e.answerId, model: e.latency.model ?? s.model }));
          }
          break;
        case 'answer-confirmed':
          if (get().requestId === e.requestId) set((s) => ({ speculative: false, answerId: e.answerId ?? s.answerId }));
          break;
        case 'answer-cancelled':
          if (get().requestId === e.requestId) {
            pending = '';
            set({ answer: '', answerDone: false });
          }
          break;
        case 'followups':
          if (get().requestId === e.requestId) set({ followups: e.questions });
          break;
        case 'feedback':
          set({ feedback: e.tags });
          break;
        case 'stt':
          set((s) => ({ stt: { ...s.stt, [e.status.source]: e.status } }));
          break;
        case 'notice': {
          const id = ++noticeId;
          set((s) => ({ notices: [...s.notices.slice(-3), { id, level: e.level, message: e.message, code: e.code }] }));
          // Informational messages are transient; warnings and errors stay until dismissed or resolved.
          if (e.level === 'info') setTimeout(() => get().dismissNotice(id), 4500);
          break;
        }
      }
    },
  };
});

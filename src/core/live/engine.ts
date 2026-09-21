import { AiError, isAiError } from '@shared/errors';
import type { DetectedQuestion, LiveEvent, LiveStatus, QuestionKind } from '@shared/events';
import { ANSWER_MODES, longerMode, nextMode, shorterMode } from '@shared/modes';
import type { SpeculationLevel } from '@shared/settings';
import type { AnswerMode, FeedbackTag, GroundingReport, Speaker, TurnLatency } from '@shared/types';
import { defang, isAbortError, uid, wordCount } from '@shared/util';
import { FOLLOWUP_PREDICT_SYSTEM, TRANSFORM_INSTRUCTIONS } from '@prompts/index';
import { detectQuestion, materiallyChanged, sameQuestion, type QuestionSignal } from '../question/detector';
import { AnswerCache } from './cache';
import {
  buildAnswerPrompt,
  retrieveForQuestion,
  staticPrefix,
  trimToSentence,
  type InterviewContext,
  type PriorExchange,
  type RetrievedContext,
} from './context';
import { checkGrounding } from './grounding';
import { LatencyLog, TurnTimeline, systemClock, type Clock } from './latency';
import type { EnginePersistence, LlmGateway, LlmGenerateResult } from './types';

export interface EngineSettings {
  mode: AnswerMode;
  speculation: SpeculationLevel;
  autoAnswer: boolean;
  answerHoldMs: number;
  storeAnswers: boolean;
  storeTranscripts: boolean;
  prewarm: boolean;
}

export interface EngineDeps {
  llm: LlmGateway;
  getContext: () => InterviewContext;
  settings: () => EngineSettings;
  emit: (e: LiveEvent) => void;
  persistence?: EnginePersistence;
  cache?: AnswerCache;
  clock?: Clock;
  /** Ask the STT provider to finalize pending audio now (called when the local VAD detects end of speech). */
  requestFinalize?: () => void;
  log?: (msg: string) => void;
}

type EvalReason = 'stable' | 'final' | 'endpoint' | 'vad-end' | 'manual';

const SPEC = {
  balanced: { startConfidence: 0.75, stableMs: 450, longStableMs: 900, maxRestarts: 3 },
  aggressive: { startConfidence: 0.6, stableMs: 260, longStableMs: 550, maxRestarts: 4 },
} as const;

/** Interviewer speech within this window after an endpoint is treated as a continuation of the same turn. */
const MERGE_WINDOW_MS = 1500;
/** Speculative answers are auto-confirmed if the transcript stays unchanged and silent for this long. */
const AUTO_CONFIRM_MS = 1400;
/** Drop stale statements when nothing question-like has happened for this long. */
const STALE_TURN_MS = 14_000;
const MAX_TURN_WORDS = 140;

interface Turn {
  id: number;
  finalText: string;
  partial: string;
  lastChangeAt: number;
  lastEndpointAt: number;
  speaking: boolean;
  restarts: number;
  timeline: TurnTimeline;
  segmentId: string;
}

interface Generation {
  requestId: string;
  question: string;
  kind: QuestionKind;
  isFollowUp: boolean;
  mode: AnswerMode;
  speculative: boolean;
  /** Started before the interviewer's endpoint (stays true after confirmation; used for latency reporting). */
  startedSpeculative: boolean;
  abort: AbortController;
  text: string;
  done: boolean;
  cancelled: boolean;
  committed: boolean;
  finishReason: string;
  retrieved: RetrievedContext;
  cacheHit: boolean;
  model: string | null;
  answerId: string | null;
  turn: Turn;
  kindOfRun: 'answer' | 'transform';
}

interface HistoryEntry extends PriorExchange {
  factIds: string[];
  storyId: string | null;
  at: number;
}

export interface EngineSnapshot {
  status: LiveStatus;
  running: boolean;
  paused: boolean;
  mode: AnswerMode;
  question: DetectedQuestion | null;
  requestId: string | null;
  answer: string;
  done: boolean;
}

export class LiveEngine {
  private readonly clock: Clock;
  private readonly cache: AnswerCache;
  private readonly latencyLog = new LatencyLog();
  private running = false;
  private paused = false;
  private status: LiveStatus = 'idle';
  private mode: AnswerMode;
  private turn: Turn;
  private turnCounter = 0;
  private gen: Generation | null = null;
  private lastSignal: QuestionSignal | null = null;
  private history: HistoryEntry[] = [];
  private lastQuestion: string | null = null;
  private lastAnswerAt: number | null = null;
  private holdUntil = 0;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  private candidateSpeech: string[] = [];
  private feedbackCounts = new Map<FeedbackTag, number>();
  private recentStarts: { key: string; at: number; mode: AnswerMode }[] = [];
  private lastQuestionDetected: DetectedQuestion | null = null;

  constructor(private readonly deps: EngineDeps) {
    this.clock = deps.clock ?? systemClock;
    this.cache = deps.cache ?? new AnswerCache();
    this.mode = deps.settings().mode;
    this.turn = this.newTurn();
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.setStatus('listening');
    this.deps.emit({ type: 'listening', listening: true, paused: false });
    if (this.deps.settings().prewarm && this.deps.llm.warm) {
      this.deps.llm.warm('live', staticPrefix(this.deps.getContext())).catch(() => undefined);
    }
  }

  stop(): void {
    if (!this.running) return;
    this.clearTimers();
    // A finished-but-unconfirmed speculative answer is the best available record of the last question.
    if (this.gen && this.gen.done && !this.gen.committed && !this.gen.cancelled) this.confirm(this.gen);
    this.cancelGeneration('session ended');
    this.running = false;
    this.paused = false;
    this.setStatus('idle');
    this.deps.emit({ type: 'listening', listening: false, paused: false });
  }

  dispose(): void {
    this.stop();
  }

  setPaused(paused: boolean): void {
    if (!this.running || this.paused === paused) return;
    this.paused = paused;
    this.clearTimers();
    if (paused) {
      // Discard drafts that were never confirmed; keep a confirmed answer that is still streaming.
      if (this.gen && this.gen.speculative && !this.gen.committed) this.cancelGeneration('paused');
      this.setStatus('paused');
    } else {
      this.turn = this.newTurn();
      this.setStatus('listening');
    }
    this.deps.emit({ type: 'listening', listening: true, paused });
  }

  get isRunning(): boolean {
    return this.running;
  }
  get isPaused(): boolean {
    return this.paused;
  }
  get latency(): LatencyLog {
    return this.latencyLog;
  }
  get answerCache(): AnswerCache {
    return this.cache;
  }

  snapshot(): EngineSnapshot {
    return {
      status: this.status,
      running: this.running,
      paused: this.paused,
      mode: this.mode,
      question: this.lastQuestionDetected,
      requestId: this.gen?.requestId ?? null,
      answer: this.gen?.text ?? '',
      done: this.gen?.done ?? false,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Inputs: audio events and transcripts                              */
  /* ---------------------------------------------------------------- */

  onVad(source: 'interviewer' | 'candidate' | 'unknown', ev: { type: 'speech_start' | 'speech_end'; at: number }): void {
    if (!this.running || this.paused || source === 'candidate') return;
    if (ev.type === 'speech_start') {
      this.maybeBeginNewTurn(ev.at);
      this.turn.speaking = true;
      this.turn.timeline.mark('speechStart', ev.at);
      this.cancelConfirmTimer();
      if (this.status === 'listening' || this.status === 'complete') this.setStatus('transcribing');
    } else {
      this.turn.speaking = false;
      this.turn.timeline.mark('speechEnd', ev.at, true);
      this.deps.requestFinalize?.();
      // Local end-of-speech: evaluate right away, without waiting for the provider's own endpointing.
      this.evaluate('vad-end');
      this.armAutoConfirm();
    }
  }

  onTranscript(t: { source: Speaker; text: string; isFinal: boolean; speechFinal?: boolean; at?: number; label?: string }): void {
    if (!this.running || this.paused) return;
    const text = t.text.trim();
    if (!text) return;
    const at = t.at ?? this.clock();

    if (t.source === 'candidate') {
      this.deps.emit({ type: 'transcript', segmentId: `cand_${this.candSeg}`, speaker: 'candidate', text, isFinal: t.isFinal, ts: Date.now() });
      if (t.isFinal) {
        this.candSeg++;
        this.candidateSpeech.push(text);
        if (this.candidateSpeech.length > 12) this.candidateSpeech.shift();
        this.persistTranscript('candidate', text, at);
      }
      return;
    }

    this.maybeBeginNewTurn(at);
    const turn = this.turn;
    turn.timeline.mark('speechStart', at); // fallback when no VAD event was seen (first write wins)
    turn.timeline.mark('firstPartial', at);
    if (t.isFinal) {
      turn.finalText = joinText(turn.finalText, text);
      turn.partial = '';
      turn.timeline.mark('finalTranscript', at, true);
      this.persistTranscript(t.source, text, at);
    } else {
      turn.partial = text;
    }
    turn.lastChangeAt = at;
    this.trimTurn(turn);
    this.cancelConfirmTimer();

    this.deps.emit({ type: 'transcript', segmentId: turn.segmentId, speaker: t.source, label: t.label, text, isFinal: t.isFinal, ts: Date.now() });
    if (t.isFinal) turn.segmentId = `seg_${turn.id}_${++this.segCounter}`;
    if (this.status === 'listening' || this.status === 'complete') this.setStatus('transcribing');

    if (t.speechFinal) {
      turn.lastEndpointAt = at;
      this.evaluate('endpoint');
      return;
    }
    if (t.isFinal) this.evaluate('final');
    this.scheduleStable();
  }

  /** The provider reported an endpoint without new text (e.g. Deepgram UtteranceEnd, or speech_final with an empty transcript). */
  onEndpoint(at?: number): void {
    if (!this.running || this.paused) return;
    this.turn.lastEndpointAt = at ?? this.clock();
    this.evaluate('endpoint');
  }

  private segCounter = 0;
  private candSeg = 1;

  /** Typed or pasted question (also the path used by the benchmark). */
  submitQuestion(text: string, opts: { mode?: AnswerMode; bypassCache?: boolean } = {}): string | null {
    const q = text.trim();
    if (!q || !this.running) return null;
    this.clearTimers();
    this.beginTurn();
    this.turn.finalText = q;
    this.turn.lastEndpointAt = this.clock();
    this.deps.emit({ type: 'transcript', segmentId: `typed_${Date.now()}`, speaker: 'interviewer', text: q, isFinal: true, ts: Date.now() });
    this.persistTranscript('interviewer', q, this.clock());
    const t0 = this.clock();
    const signal = detectQuestion(q, this.detectorCtx());
    const detectionMs = this.clock() - t0;
    const questionText = signal.isQuestion ? signal.text : q;
    return this.begin({
      question: questionText,
      kind: signal.isQuestion ? signal.kind : 'other',
      isFollowUp: signal.isFollowUp,
      confidence: signal.isQuestion ? signal.confidence : 1,
      speculative: false,
      detectionMs,
      mode: opts.mode,
      bypassCache: opts.bypassCache,
    });
  }

  /** "Answer now": use whatever the interviewer has said so far. */
  answerCurrent(): void {
    if (!this.running) return;
    const text = joinText(this.turn.finalText, this.turn.partial).trim();
    const source = text || this.history[this.history.length - 1]?.question || '';
    if (!source) {
      this.deps.emit({ type: 'notice', level: 'info', message: 'Nothing to answer yet — no question has been heard.' });
      return;
    }
    if (!text) {
      this.regenerate();
      return;
    }
    this.clearTimers();
    const t0 = this.clock();
    const signal = detectQuestion(text, this.detectorCtx());
    const detectionMs = this.clock() - t0;
    const tail = text.split(/\s+/).slice(-45).join(' ');
    this.begin({
      question: signal.isQuestion ? signal.text : tail,
      kind: signal.isQuestion ? signal.kind : 'other',
      isFollowUp: signal.isFollowUp,
      confidence: signal.isQuestion ? signal.confidence : 0.5,
      speculative: false,
      detectionMs,
      bypassCache: true,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Controls                                                          */
  /* ---------------------------------------------------------------- */

  setMode(mode: AnswerMode, opts: { regenerate?: boolean } = {}): void {
    if (mode === this.mode && !opts.regenerate) return;
    this.mode = mode;
    this.deps.emit({ type: 'mode', mode });
    if ((opts.regenerate ?? true) && this.running && this.currentQuestion()) this.regenerate({ mode });
  }

  cycleMode(): void {
    this.setMode(nextMode(this.mode));
  }

  currentMode(): AnswerMode {
    return this.mode;
  }

  shorter(): void {
    this.setMode(shorterMode(this.mode));
  }

  expand(): void {
    this.setMode(longerMode(this.mode));
  }

  regenerate(opts: { mode?: AnswerMode } = {}): void {
    const q = this.currentQuestion();
    if (!q) {
      this.deps.emit({ type: 'notice', level: 'info', message: 'Nothing to regenerate yet.' });
      return;
    }
    this.clearTimers();
    this.freshTurnForRerun();
    this.begin({ question: q.text, kind: q.kind, isFollowUp: q.isFollowUp, confidence: q.confidence, speculative: false, detectionMs: 0, mode: opts.mode, bypassCache: true });
  }

  /** Rewrite the current answer (more conversational, or with extra experience the candidate supplies). */
  transform(kind: 'conversational' | 'add-detail', addition?: string): void {
    const g = this.gen;
    if (!g || !g.text.trim()) {
      this.deps.emit({ type: 'notice', level: 'info', message: 'There is no answer to rewrite yet.' });
      return;
    }
    const instruction = kind === 'conversational' ? TRANSFORM_INSTRUCTIONS.conversational : `Rewrite the answer so it includes the extra experience in <user_addition>, weaving it in naturally. Treat <user_addition> as true, first-hand experience. Keep everything else grounded in the facts.`;
    this.freshTurnForRerun();
    this.begin({
      question: g.question,
      kind: g.kind,
      isFollowUp: g.isFollowUp,
      confidence: 1,
      speculative: false,
      detectionMs: 0,
      bypassCache: true,
      transform: { instruction, currentAnswer: g.text, addition },
      reuseRetrievalOf: g,
    });
  }

  /** Predict follow-up questions the interviewer might ask next. Best effort; failures are reported, not thrown. */
  async predictFollowups(): Promise<void> {
    const g = this.gen;
    if (!g || !g.done || !g.text.trim()) return;
    const requestId = g.requestId;
    const ac = new AbortController();
    try {
      const res = await this.deps.llm.generate({
        task: 'classify',
        system: FOLLOWUP_PREDICT_SYSTEM,
        user: `<role>\n${this.deps.getContext().roleBlock}\n</role>\n<question>${defang(g.question)}</question>\n<answer>${defang(g.text)}</answer>`,
        maxTokens: 120,
        temperature: 0.6,
        signal: ac.signal,
      });
      if (this.gen?.requestId !== requestId) return;
      const questions = res.text
        .split('\n')
        .map((l) => l.replace(/^[-•*\d.)\s]+/, '').trim())
        .filter((l) => l.length > 5)
        .slice(0, 3);
      this.deps.emit({ type: 'followups', requestId, questions });
    } catch (err) {
      this.reportError(err);
    }
  }

  setFeedback(answerId: string | null, tags: FeedbackTag[]): void {
    for (const t of tags) this.feedbackCounts.set(t, (this.feedbackCounts.get(t) ?? 0) + 1);
    if (answerId) {
      this.deps.persistence?.updateFeedback(answerId, tags);
      this.deps.emit({ type: 'feedback', answerId, tags });
    }
    if (tags.includes('incorrect') && this.gen) this.cache.evict(this.gen.question);
  }

  /* ---------------------------------------------------------------- */
  /* Decision logic                                                    */
  /* ---------------------------------------------------------------- */

  private evaluate(reason: EvalReason): void {
    if (!this.running || this.paused) return;
    const turn = this.turn;
    const text = joinText(turn.finalText, turn.partial).trim();
    if (!text) return;
    const now = this.clock();

    const t0 = this.clock();
    const signal = detectQuestion(text, this.detectorCtx());
    const detectionMs = this.clock() - t0;
    this.lastSignal = signal;
    this.deps.log?.(`eval(${reason}) q=${signal.isQuestion} conf=${signal.confidence} complete=${signal.complete} "${signal.text || text}"`);

    if (!signal.isQuestion) {
      if (this.status === 'analyzing') this.setStatus(turn.speaking ? 'transcribing' : 'listening');
      return;
    }

    const confirmed = reason === 'endpoint' || reason === 'manual';
    const settings = this.deps.settings();

    if (!settings.autoAnswer && !confirmed) return;
    if (!settings.autoAnswer && confirmed) {
      // Auto-answer is off: surface the detected question and wait for the user to ask for an answer.
      this.showDetectedOnly(signal);
      return;
    }

    if (now < this.holdUntil && signal.confidence < 0.85) return; // probably the candidate talking

    if (!confirmed) {
      if (settings.speculation === 'off') return;
      const spec = SPEC[settings.speculation];
      const stableFor = now - turn.lastChangeAt;
      const ready =
        signal.confidence >= spec.startConfidence &&
        (signal.complete ||
          (stableFor >= spec.longStableMs && signal.words >= 8 && signal.confidence >= 0.8) ||
          (reason === 'vad-end' && signal.words >= 6));
      if (!ready) {
        if (this.status !== 'transcribing') this.setStatus('analyzing');
        return;
      }
    }

    const gen = this.gen;
    if (gen && !gen.cancelled && gen.turn === turn && gen.kindOfRun === 'answer') {
      if (sameQuestion(gen.question, signal.text) || !materiallyChanged(gen.question, signal.text)) {
        if (confirmed && !gen.committed) this.confirm(gen);
        return;
      }
      const maxRestarts = settings.speculation === 'aggressive' ? SPEC.aggressive.maxRestarts : SPEC.balanced.maxRestarts;
      if (!confirmed && turn.restarts >= maxRestarts) return;
      turn.restarts++;
      this.cancelGeneration('the question changed');
    }

    // De-duplicate identical requests fired in quick succession.
    if (this.isDuplicateStart(signal.text)) return;

    this.begin({
      question: signal.text,
      kind: signal.kind,
      isFollowUp: signal.isFollowUp,
      confidence: signal.confidence,
      speculative: !confirmed,
      detectionMs,
    });
  }

  private showDetectedOnly(signal: QuestionSignal): void {
    const q: DetectedQuestion = { text: signal.text, kind: signal.kind, confidence: signal.confidence, isFollowUp: signal.isFollowUp, speculative: false };
    if (this.lastQuestionDetected?.text === q.text) return;
    this.lastQuestionDetected = q;
    this.deps.emit({ type: 'question', requestId: '', question: q });
    this.setStatus('listening', 'Question detected — press the answer shortcut to generate.');
  }

  private isDuplicateStart(question: string): boolean {
    const now = this.clock();
    this.recentStarts = this.recentStarts.filter((s) => now - s.at < 4000);
    return this.recentStarts.some((s) => sameQuestion(s.key, question) && s.mode === this.mode);
  }

  private scheduleStable(): void {
    if (this.stableTimer) clearTimeout(this.stableTimer);
    const level = this.deps.settings().speculation;
    if (level === 'off') return;
    const ms = SPEC[level].stableMs;
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.evaluate('stable');
    }, ms);
  }

  private armAutoConfirm(): void {
    this.cancelConfirmTimer();
    const gen = this.gen;
    if (!gen || !gen.speculative || gen.committed || gen.cancelled) return;
    const snapshot = joinText(this.turn.finalText, this.turn.partial);
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = null;
      const g = this.gen;
      if (!g || g !== gen || g.cancelled || g.committed || this.turn.speaking) return;
      if (joinText(this.turn.finalText, this.turn.partial) !== snapshot) return;
      this.confirm(g);
    }, AUTO_CONFIRM_MS);
  }

  private cancelConfirmTimer(): void {
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
  }

  private clearTimers(): void {
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = null;
    this.cancelConfirmTimer();
  }

  /* ---------------------------------------------------------------- */
  /* Generation                                                        */
  /* ---------------------------------------------------------------- */

  private begin(p: {
    question: string;
    kind: QuestionKind;
    isFollowUp: boolean;
    confidence: number;
    speculative: boolean;
    detectionMs: number;
    mode?: AnswerMode;
    bypassCache?: boolean;
    transform?: { instruction: string; currentAnswer: string; addition?: string };
    reuseRetrievalOf?: Generation;
  }): string {
    // Supersede whatever is running: only the newest request may update the UI.
    if (this.gen && !this.gen.done) this.cancelGeneration('superseded');
    if (p.mode) this.mode = p.mode;
    const baseMode = this.mode;
    const auto = !p.mode && p.isFollowUp && !p.transform && baseMode !== 'bullets' && baseMode !== 'star';
    const mode: AnswerMode = auto ? 'followup' : baseMode;
    if (auto) this.deps.emit({ type: 'notice', level: 'info', message: 'Follow-up detected — using a short conversational reply.' });

    const turn = this.turn;
    const now = this.clock();
    turn.timeline.resetGeneration();
    turn.timeline.mark('questionDetected', now, true);
    turn.timeline.setDetection(p.detectionMs);

    const requestId = uid('req');
    const detected: DetectedQuestion = { text: p.question, kind: p.kind, confidence: p.confidence, isFollowUp: p.isFollowUp, speculative: p.speculative };
    this.lastQuestionDetected = detected;
    this.recentStarts.push({ key: p.question, at: now, mode: baseMode });

    const gen: Generation = {
      requestId,
      question: p.question,
      kind: p.kind,
      isFollowUp: p.isFollowUp,
      mode,
      speculative: p.speculative,
      startedSpeculative: p.speculative,
      abort: new AbortController(),
      text: '',
      done: false,
      cancelled: false,
      committed: false,
      finishReason: '',
      retrieved: emptyRetrieval(),
      cacheHit: false,
      model: null,
      answerId: null,
      turn,
      kindOfRun: p.transform ? 'transform' : 'answer',
    };
    this.gen = gen;
    this.deps.emit({ type: 'question', requestId, question: detected });

    // ---- retrieval (synchronous, local) ----
    this.setStatus('retrieving');
    turn.timeline.mark('retrievalStart', undefined, true);
    const ctx = this.deps.getContext();
    const prev = this.history[this.history.length - 1];
    gen.retrieved = p.reuseRetrievalOf
      ? p.reuseRetrievalOf.retrieved
      : retrieveForQuestion(ctx, p.question, {
          mode,
          kind: p.kind,
          carryFactIds: p.isFollowUp ? prev?.factIds : undefined,
          carryStoryId: p.isFollowUp ? prev?.storyId : null,
        });
    turn.timeline.mark('retrievalEnd', undefined, true);

    // ---- semantic cache ----
    if (!p.bypassCache && !p.isFollowUp && !p.transform) {
      const hit = this.cache.lookup(p.question, mode, ctx.version, ctx.interviewId ? [`prepared:${ctx.interviewId}`] : []);
      if (hit) {
        gen.cacheHit = true;
        gen.text = hit.entry.answer;
        gen.model = hit.entry.source === 'prepared' ? 'prepared answer' : 'cache';
        turn.timeline.mark('llmSend', undefined, true);
        turn.timeline.mark('firstToken', undefined, true);
        this.deps.emit({ type: 'answer-start', requestId, mode, source: 'cache', model: gen.model, speculative: p.speculative, retrieval: gen.retrieved.summary });
        this.deps.emit({ type: 'answer-replace', requestId, text: gen.text });
        this.complete(gen, { text: gen.text, finishReason: 'stop', model: gen.model, provider: 'cache', usedFallback: false });
        return requestId;
      }
    }

    // ---- prompt + stream ----
    const prompt = p.transform
      ? this.buildTransformPrompt(ctx, gen, p.transform)
      : buildAnswerPrompt({
          ctx,
          question: p.question,
          kind: p.kind,
          mode,
          isFollowUp: p.isFollowUp,
          retrieved: gen.retrieved,
          previous: this.priorExchanges(),
          adjustments: this.adjustments(),
        });

    this.deps.emit({ type: 'answer-start', requestId, mode, source: 'llm', model: null, speculative: p.speculative, retrieval: gen.retrieved.summary });
    turn.timeline.mark('llmSend', undefined, true);
    this.deps.llm
      .generate({
        task: 'live',
        system: prompt.system,
        user: prompt.user,
        maxTokens: ANSWER_MODES[mode].maxTokens,
        signal: gen.abort.signal,
        onToken: (t) => this.onToken(gen, t),
        onNotice: (level, message) => {
          if (this.gen === gen && !gen.cancelled) this.deps.emit({ type: 'notice', level, message });
        },
      })
      .then((res) => this.onGenerated(gen, res))
      .catch((err: unknown) => this.onGenerateError(gen, err));
    return requestId;
  }

  private buildTransformPrompt(ctx: InterviewContext, gen: Generation, t: { instruction: string; currentAnswer: string; addition?: string }): { system: string; user: string } {
    const base = buildAnswerPrompt({ ctx, question: gen.question, kind: gen.kind, mode: gen.mode, isFollowUp: false, retrieved: gen.retrieved, previous: [] });
    const extra = [`<current_answer>\n${defang(t.currentAnswer)}\n</current_answer>`];
    if (t.addition?.trim()) extra.push(`<user_addition>\n${defang(t.addition.trim())}\n</user_addition>`);
    extra.push(`<instruction>${t.instruction}</instruction>`);
    return { system: base.system, user: `${base.user}\n\n${extra.join('\n')}` };
  }

  private onToken(gen: Generation, text: string): void {
    if (this.gen !== gen || gen.cancelled || !text) return;
    if (gen.text === '') {
      gen.turn.timeline.mark('firstToken', undefined, true);
      this.setStatus('generating');
    }
    gen.text += text;
    this.deps.emit({ type: 'answer-token', requestId: gen.requestId, text });
  }

  private onGenerated(gen: Generation, res: LlmGenerateResult): void {
    if (this.gen !== gen || gen.cancelled) return;
    if (gen.text === '' && res.text) {
      // Non-streaming fallback: the whole answer arrives at once.
      gen.turn.timeline.mark('firstToken', undefined, true);
      gen.text = res.text;
      this.deps.emit({ type: 'answer-replace', requestId: gen.requestId, text: res.text });
    }
    this.complete(gen, res);
  }

  private complete(gen: Generation, res: LlmGenerateResult): void {
    let text = gen.text;
    if (res.finishReason === 'length') {
      const trimmed = trimToSentence(text);
      if (trimmed !== text) {
        text = trimmed;
        gen.text = trimmed;
        this.deps.emit({ type: 'answer-replace', requestId: gen.requestId, text: trimmed });
      }
    }
    gen.done = true;
    gen.model = res.model;
    gen.finishReason = res.finishReason;
    gen.turn.timeline.mark('complete', undefined, true);
    if (res.usedFallback) this.deps.emit({ type: 'notice', level: 'warn', message: `Primary model failed; this answer came from the fallback (${res.model}).` });

    const ctx = this.deps.getContext();
    const grounding = checkGrounding({
      answer: text,
      question: gen.question,
      corpus: ctx.corpus,
      usedFactIds: gen.retrieved.summary.factIds,
      usedStoryIds: gen.retrieved.summary.storyIds,
      retrievalConfidence: gen.retrieved.confidence,
    });
    const latency: TurnLatency = gen.turn.timeline.latency({
      speculative: gen.startedSpeculative,
      cacheHit: gen.cacheHit,
      restarts: gen.turn.restarts,
      provider: res.provider,
      model: res.model,
    });
    if (gen.cacheHit) latency.ttftMs = latency.ttftMs ?? 0;

    if (!gen.speculative) this.commit(gen, latency, grounding);
    else this.pendingCommit = { gen, latency, grounding };
    this.deps.emit({ type: 'answer-done', requestId: gen.requestId, answerId: gen.answerId, text, finishReason: res.finishReason, latency, grounding });
    this.setStatus('complete');
  }

  private pendingCommit: { gen: Generation; latency: TurnLatency; grounding: GroundingReport } | null = null;

  /** A speculative answer is now known to be for the final question. */
  private confirm(gen: Generation): void {
    if (gen.committed || gen.cancelled) return;
    gen.speculative = false;
    if (gen.done && this.pendingCommit?.gen === gen) {
      const { latency, grounding } = this.pendingCommit;
      this.pendingCommit = null;
      this.commit(gen, latency, grounding);
    }
    this.deps.emit({ type: 'answer-confirmed', requestId: gen.requestId, answerId: gen.answerId });
  }

  private commit(gen: Generation, latency: TurnLatency, grounding: GroundingReport): void {
    if (gen.committed) return;
    gen.committed = true;
    const ctx = this.deps.getContext();
    const now = this.clock();
    this.latencyLog.add(latency);
    if (gen.kindOfRun === 'answer') {
      this.lastQuestion = gen.question;
      this.history.push({
        question: gen.question,
        answer: this.candidateAnswerOrSuggestion(gen.text),
        factIds: gen.retrieved.summary.factIds,
        storyId: gen.retrieved.summary.storyIds[0] ?? null,
        at: now,
      });
      if (this.history.length > 8) this.history.shift();
      this.candidateSpeech = [];
    }
    this.lastAnswerAt = now;
    this.holdUntil = now + this.deps.settings().answerHoldMs;
    gen.turn.lastEndpointAt = gen.turn.lastEndpointAt || now;

    if (gen.kindOfRun === 'answer' && !gen.isFollowUp && !gen.cacheHit && grounding.status !== 'unverified-details' && gen.finishReason !== 'other' && gen.text.trim()) {
      this.cache.put({ question: gen.question, mode: gen.mode, ctxVersion: ctx.version, answer: gen.text, source: 'live' });
    }
    if (this.deps.settings().storeAnswers) {
      const id = this.deps.persistence?.saveAnswer({
        sessionId: null,
        interviewId: ctx.interviewId,
        questionText: gen.question,
        questionKind: gen.kind,
        answerText: gen.text,
        mode: gen.mode,
        source: gen.cacheHit ? 'cache' : 'live',
        model: gen.model ?? undefined,
        latency,
        grounding,
        feedback: [],
        edited: false,
      });
      if (id) gen.answerId = id;
    }
  }

  private onGenerateError(gen: Generation, err: unknown): void {
    if (this.gen !== gen || gen.cancelled) return;
    if (isAbortError(err) || (isAiError(err) && err.code === 'aborted')) return;
    this.reportError(err);
  }

  private reportError(err: unknown): void {
    const ai = isAiError(err) ? err : new AiError('unknown', err instanceof Error ? err.message : 'Unexpected error');
    this.deps.emit({ type: 'notice', level: 'error', message: ai.message, code: ai.code });
    this.setStatus('error', ai.message);
  }

  private cancelGeneration(reason: string): void {
    const g = this.gen;
    if (!g || g.cancelled) return;
    if (g.done && g.committed) return;
    g.cancelled = true;
    g.abort.abort();
    if (this.pendingCommit?.gen === g) this.pendingCommit = null;
    this.deps.emit({ type: 'answer-cancelled', requestId: g.requestId, reason });
  }

  /* ---------------------------------------------------------------- */
  /* Turn / history helpers                                            */
  /* ---------------------------------------------------------------- */

  private newTurn(): Turn {
    const id = ++this.turnCounter;
    return {
      id,
      finalText: '',
      partial: '',
      lastChangeAt: this.clock(),
      lastEndpointAt: 0,
      speaking: false,
      restarts: 0,
      timeline: new TurnTimeline(this.clock),
      segmentId: `seg_${id}_${++this.segCounter}`,
    };
  }

  /** Re-runs (regenerate, transform) get their own timeline so latency is measured from the click, not the original speech. */
  private freshTurnForRerun(): void {
    const keep = this.gen;
    this.turn = this.newTurn();
    this.turn.lastEndpointAt = this.clock();
    this.gen = keep;
  }

  private beginTurn(): void {
    if (this.gen && !this.gen.done) this.cancelGeneration('new turn');
    this.turn = this.newTurn();
    this.gen = this.gen && this.gen.done ? this.gen : null;
  }

  private maybeBeginNewTurn(at: number): void {
    const t = this.turn;
    const answered = this.gen && (this.gen.committed || this.gen.done);
    if (answered && t.lastEndpointAt > 0 && at - t.lastEndpointAt > MERGE_WINDOW_MS) {
      this.turn = this.newTurn();
      this.gen = null;
      this.pendingCommit = null;
      return;
    }
    if (!answered && (t.finalText || t.partial) && at - t.lastChangeAt > STALE_TURN_MS) {
      this.turn = this.newTurn();
    }
  }

  private trimTurn(turn: Turn): void {
    const words = turn.finalText.split(/\s+/);
    if (words.length > MAX_TURN_WORDS) turn.finalText = words.slice(-MAX_TURN_WORDS).join(' ');
  }

  private detectorCtx() {
    return {
      speaker: 'interviewer' as const,
      previousQuestion: this.lastQuestion,
      msSincePreviousAnswer: this.lastAnswerAt === null ? null : this.clock() - this.lastAnswerAt,
    };
  }

  private currentQuestion(): DetectedQuestion | null {
    return this.lastQuestionDetected;
  }

  private priorExchanges(): PriorExchange[] {
    return this.history.map((h) => ({ question: h.question, answer: h.answer }));
  }

  /** Prefer what the candidate actually said (if their voice is transcribed) over the suggested text. */
  private candidateAnswerOrSuggestion(suggestion: string): string {
    const said = this.candidateSpeech.join(' ').trim();
    return wordCount(said) >= 12 ? said : suggestion;
  }

  /** In-session feedback loop: earlier feedback steers later answers. Nothing leaves the device except these prompt lines. */
  private adjustments(): string[] {
    const out: string[] = [];
    const n = (t: FeedbackTag) => this.feedbackCounts.get(t) ?? 0;
    if (n('too-long') > 0) out.push('The candidate found earlier answers too long: keep this one tighter.');
    if (n('too-generic') > 0) out.push('The candidate found earlier answers too generic: use concrete details from the facts.');
    if (n('needs-detail') > 0) out.push('The candidate wanted more detail in earlier answers: include specifics from the facts.');
    if (n('incorrect') > 0) out.push('An earlier answer was marked incorrect: stay strictly within the facts.');
    return out;
  }

  private persistTranscript(speaker: Speaker, text: string, at: number): void {
    if (!this.deps.settings().storeTranscripts) return;
    this.deps.persistence?.saveTranscript({ speaker, text, ts: Date.now() - Math.max(0, this.clock() - at) });
  }

  private setStatus(status: LiveStatus, detail?: string): void {
    if (this.status === status && !detail) return;
    this.status = status;
    this.deps.emit({ type: 'status', status, detail });
  }
}

function joinText(a: string, b: string): string {
  return a && b ? `${a} ${b}` : a || b;
}

function emptyRetrieval(): RetrievedContext {
  return {
    facts: [],
    story: null,
    roleLines: [],
    confidence: 0,
    summary: { factIds: [], storyIds: [], confidence: 0, labels: [], usedResume: false, usedJd: false, usedStory: false, tokensApprox: 0 },
  };
}

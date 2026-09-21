import { LiveEngine, type EngineSettings } from '@core/live/engine';
import { AnswerCache } from '@core/live/cache';
import type { InterviewContext } from '@core/live/context';
import type { LlmGateway } from '@core/live/types';
import type { LiveEvent } from '@shared/events';
import { sttName } from '@shared/speech';
import type { LiveDebug, LiveStartResult } from '@shared/ipc';
import type { EngineSnapshotDTO } from '@shared/liveTypes';
import type { AppSettings } from '@shared/settings';
import type { AnswerMode, FeedbackTag, SessionRecord, Speaker, SttProviderId } from '@shared/types';
import type { Repos } from '../db/repos';
import type { ScopedLogger } from '../logging';
import type { SecretStore } from '../security/secrets';
import { AudioSource } from '../stt/audioSource';
import type { SttRegistry } from '../stt/registry';
import { ResilientStt } from '../stt/resilient';
import type { SttConfig } from '../stt/types';
import { loadContext } from './context';

export interface LiveDeps {
  repos: Repos;
  gateway: LlmGateway;
  secrets: SecretStore;
  /** Every speech provider (on-device and cloud) and whether each can be opened now. */
  stt: SttRegistry;
  emit: (e: LiveEvent) => void;
  clock: () => number;
  log: ScopedLogger;
  writeClipboard: (text: string) => Promise<void>;
  /** Endpoint overrides (development / tests). */
  sttUrls?: Partial<Record<SttProviderId, string>>;
}

interface ActiveSource {
  source: AudioSource;
  stt: ResilientStt;
  /** The provider currently in use (it changes if the fallback takes over). */
  provider: () => SttProviderId;
}

/** Which speech providers a session uses: the configured one, or (if that cannot be opened) the configured fallback. */
interface SttChoice {
  primary: { id: SttProviderId; key: string };
  fallback: { id: SttProviderId; key: string } | null;
  /** Said to the user when the choice differs from what settings say. */
  notice: string | null;
}

/**
 * Owns one live session: builds the interview context once, wires streaming STT → VAD → engine, persists
 * results, and exposes the controls the UI and global hotkeys call.
 */
export class LiveService {
  private engine: LiveEngine | null = null;
  private sessionId: string | null = null;
  private active = new Map<'mic' | 'system', ActiveSource>();
  private ctx: InterviewContext | null = null;
  private seq = 0;
  private startedAt = 0;
  /** Survives across sessions for the life of the app so repeated questions are instant. */
  private readonly cache = new AnswerCache();
  private uiPaints: number[] = [];

  constructor(private readonly d: LiveDeps) {}

  clearCache(): void {
    this.cache.clear();
  }

  get running(): boolean {
    return !!this.engine?.isRunning;
  }
  get paused(): boolean {
    return !!this.engine?.isPaused;
  }

  private settings(): AppSettings {
    return this.d.repos.getSettings();
  }

  private engineSettings(): EngineSettings {
    const s = this.settings();
    return {
      mode: s.defaultMode,
      speculation: s.live.speculation,
      autoAnswer: s.live.autoAnswer,
      answerHoldMs: s.live.answerHoldMs,
      storeAnswers: s.privacy.storeAnswers,
      storeTranscripts: s.privacy.storeTranscripts,
      prewarm: s.live.prewarm,
    };
  }

  async start(req: { interviewId: string | null; audio: boolean }): Promise<LiveStartResult> {
    if (this.running) await this.stop();
    const settings = this.settings();
    const wantsAudio = req.audio;
    if (wantsAudio && !settings.live.consentAcceptedAt) {
      throw new Error('Please review and accept the audio & privacy notice before listening.');
    }

    const { ctx, material } = loadContext(this.d.repos, req.interviewId);
    this.ctx = ctx;
    // Prepared answers become instant cache hits for this interview.
    if (req.interviewId) {
      for (const a of this.d.repos.listAnswers({ interviewId: req.interviewId, source: 'prepared' })) {
        this.cache.put({ question: a.questionText, mode: a.mode, ctxVersion: `prepared:${req.interviewId}`, answer: a.answerText, source: 'prepared' });
      }
    }

    const session = this.d.repos.createSession({ kind: 'live', interview: material.interview });
    this.sessionId = session.id;
    this.seq = 0;
    this.startedAt = this.d.clock();

    const engine = new LiveEngine({
      llm: this.d.gateway,
      getContext: () => this.ctx ?? ctx,
      settings: () => this.engineSettings(),
      emit: (e) => this.d.emit(e),
      cache: this.cache,
      clock: this.d.clock,
      requestFinalize: () => undefined,
      log: (m) => this.d.log.debug(m),
      persistence: {
        saveAnswer: (r) => this.d.repos.saveAnswer({ ...r, sessionId: this.sessionId }).id,
        saveTranscript: (seg) => {
          if (this.sessionId) this.d.repos.addTranscript(this.sessionId, ++this.seq, seg.speaker, seg.text, seg.ts);
        },
        updateFeedback: (id, tags) => this.d.repos.updateAnswerFeedback(id, tags as FeedbackTag[]),
      },
    });
    this.engine = engine;

    const notices: string[] = [];
    const sources: ('mic' | 'system')[] = [];
    let sttConfigured = false;
    if (wantsAudio) {
      const plan = this.planSources(settings);
      const choice = this.chooseStt(settings);
      if ('error' in choice) {
        notices.push(`${choice.error} Speech recognition is off; you can still type questions.`);
      } else {
        if (choice.notice) notices.push(choice.notice);
        sttConfigured = true;
        for (const p of plan) {
          this.openSource(engine, p.name, p.role, settings, choice);
          sources.push(p.name);
        }
      }
    }

    engine.start();
    return { sessionId: session.id, sources, sttConfigured, notices };
  }

  /**
   * Pick the speech providers for this session. Nothing is ever chosen that the user has not set up: the on-device
   * engine needs its model, a cloud service needs its key. If the configured provider cannot be opened but the
   * configured fallback can, the fallback is used and the user is told.
   */
  private chooseStt(s: AppSettings): SttChoice | { error: string } {
    const reg = this.d.stt;
    const primaryId = s.stt.provider;
    const fbId = s.stt.fallbackProvider !== 'none' && s.stt.fallbackProvider !== primaryId ? s.stt.fallbackProvider : null;
    const primary = reg.access(primaryId, this.d.secrets);
    const fb = fbId ? reg.access(fbId, this.d.secrets) : null;
    if (primary.ok) return { primary: { id: primaryId, key: primary.key }, fallback: fbId && fb?.ok ? { id: fbId, key: fb.key } : null, notice: null };
    if (fbId && fb?.ok) {
      return { primary: { id: fbId, key: fb.key }, fallback: null, notice: `${sttName(primaryId)} is unavailable: ${primary.message} Using ${sttName(fbId)} instead.` };
    }
    return { error: primary.message };
  }

  /** Decide which captured sources feed STT, and who is speaking on each. */
  private planSources(s: AppSettings): { name: 'mic' | 'system'; role: Speaker }[] {
    const out: { name: 'mic' | 'system'; role: Speaker }[] = [];
    if (s.audio.interviewerSource === 'system') {
      out.push({ name: 'system', role: 'interviewer' });
      // The microphone is the candidate; it is transcribed only if the user opts in (own-voice context + history).
      if (s.audio.transcribeMyVoice) out.push({ name: 'mic', role: 'candidate' });
    } else {
      // One microphone hears everyone: speaker identity is unknown and is reported as such.
      out.push({ name: 'mic', role: 'unknown' });
    }
    return out;
  }

  private openSource(engine: LiveEngine, name: 'mic' | 'system', role: Speaker, s: AppSettings, choice: SttChoice): void {
    const provider = choice.primary.id;
    // Diarization only helps when one microphone hears everyone; with separate sources the source already says who spoke.
    const diarize = s.stt.diarize && role === 'unknown';
    const cfgFor = (p: SttProviderId): SttConfig => ({ language: s.stt.language, model: p === 'deepgram' ? s.stt.model : '', endpointingMs: s.stt.endpointingMs, diarize, baseUrl: this.d.sttUrls?.[p] });
    const fallback = choice.fallback;

    let activeProvider: SttProviderId = provider;
    const stt = new ResilientStt({
      primary: { provider: this.d.stt.provider(provider), key: choice.primary.key, cfg: cfgFor(provider) },
      fallback: fallback ? { provider: this.d.stt.provider(fallback.id), key: fallback.key, cfg: cfgFor(fallback.id) } : null,
      onSwitch: (from, to, reason) => {
        activeProvider = to;
        this.d.emit({ type: 'notice', level: 'warn', message: `${sttName(from)} failed (${reason}). Switched to ${sttName(to)}.` });
      },
      events: {
        onNotice: (level, message) => this.d.emit({ type: 'notice', level, message }),
        onTranscript: (t) => {
          if (!t.text) {
            if (t.speechFinal) engine.onEndpoint();
            return;
          }
          const speaker: Speaker = role;
          engine.onTranscript({ source: speaker, text: t.text, isFinal: t.isFinal, speechFinal: t.speechFinal, at: this.d.clock(), label: diarize && t.speaker !== undefined ? `Speaker ${t.speaker + 1}` : undefined });
        },
        onState: (state, message, fatal) => {
          this.d.emit({ type: 'stt', status: { source: name, provider: activeProvider, state, message } });
          if (state === 'error' && fatal) this.d.emit({ type: 'notice', level: 'error', message: message ?? 'Speech recognition failed.', code: 'stt' });
        },
      },
    });
    const source = new AudioSource({
      name,
      role,
      sensitivity: s.vadSensitivity,
      clock: this.d.clock,
      stt,
      finalizeOnSpeechEnd: role !== 'candidate',
      onVad: (r, ev) => engine.onVad(r === 'unknown' ? 'unknown' : r === 'candidate' ? 'candidate' : 'interviewer', ev),
    });
    this.active.set(name, { source, stt, provider: () => activeProvider });
  }

  /** Audio from the renderer. Dropped (never sent anywhere) while paused or stopped. */
  audio(name: 'mic' | 'system', bytes: Uint8Array): void {
    if (!this.engine?.isRunning || this.engine.isPaused) return;
    this.active.get(name)?.source.push(bytes);
  }

  async stop(): Promise<SessionRecord | null> {
    const engine = this.engine;
    const id = this.sessionId;
    if (!engine || !id) return null;
    engine.stop();
    const summary = engine.latency.summary();
    const streams = [...this.active.values()].map((a) => a.stt);
    this.active.clear();
    this.engine = null;
    this.sessionId = null;
    this.ctx = null;
    await Promise.all(streams.map((s) => s.close().catch(() => undefined)));
    this.d.repos.endSession(id, {
      turns: summary.turns,
      cacheHits: summary.cacheHits,
      ttftMedianMs: summary.ttft.median ?? undefined,
      ttftP95Ms: summary.ttft.p95 ?? undefined,
      totalMedianMs: summary.total.median ?? undefined,
    });
    return this.d.repos.getSession(id);
  }

  /* ----------------------------- controls ----------------------------- */

  private e(): LiveEngine {
    if (!this.engine) throw new Error('No live session is running.');
    return this.engine;
  }
  setPaused(paused: boolean): void {
    this.e().setPaused(paused);
  }
  togglePaused(): void {
    const e = this.e();
    e.setPaused(!e.isPaused);
  }
  question(text: string, mode?: AnswerMode): void {
    this.e().submitQuestion(text, { mode });
  }
  answerNow(): void {
    this.e().answerCurrent();
  }
  regenerate(): void {
    this.e().regenerate();
  }
  setMode(mode: AnswerMode): void {
    this.e().setMode(mode);
  }
  cycleMode(): void {
    this.e().cycleMode();
  }
  shorter(): void {
    this.e().shorter();
  }
  expand(): void {
    this.e().expand();
  }
  transform(kind: 'conversational' | 'add-detail', addition?: string): void {
    this.e().transform(kind, addition);
  }
  followups(): void {
    void this.e().predictFollowups();
  }
  feedback(answerId: string | null, tags: FeedbackTag[]): void {
    this.e().setFeedback(answerId, tags);
  }

  async copy(): Promise<{ copied: boolean }> {
    const text = this.engine?.snapshot().answer ?? '';
    if (!text.trim()) return { copied: false };
    await this.d.writeClipboard(text);
    return { copied: true };
  }

  snapshot(): EngineSnapshotDTO | null {
    if (!this.engine) return null;
    return { ...this.engine.snapshot(), sessionId: this.sessionId };
  }

  reportUi(firstPaintMs: number): void {
    this.uiPaints.push(firstPaintMs);
    if (this.uiPaints.length > 100) this.uiPaints.shift();
  }

  debug(): LiveDebug | null {
    if (!this.engine) return null;
    const s = this.engine.latency.summary();
    return {
      summary: { turns: s.turns, cacheHits: s.cacheHits, ttft: s.ttft, total: s.total, perceived: s.perceived, retrieval: s.retrieval },
      recent: this.engine.latency.all().slice(-12),
      cacheSize: this.cache.size,
      audio: [...this.active.entries()].map(([name, a]) => ({ name, seconds: Math.round(a.source.seconds * 10) / 10 })),
      sttStates: [...this.active.entries()].map(([source, a]) => ({ source, provider: a.provider(), state: a.stt.state })),
    };
  }
}

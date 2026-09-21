import type { PushChannels } from './events';
import type { AppSettings, DeepPartial } from './settings';
import type {
  ActiveProviders,
  AiTask,
  AnswerMode,
  AnswerRecord,
  AppInfo,
  BankQuestion,
  CloudSttProviderId,
  ConnectionTestResult,
  Dashboard,
  DocumentSource,
  FeedbackTag,
  GoogleAuthConfig,
  GoogleAuthStatus,
  Interview,
  InterviewInput,
  Level,
  MockEvaluation,
  MockMetrics,
  ModelConfig,
  ModelListResult,
  ModelProbeResult,
  PrepSection,
  PrepSectionKey,
  ProviderKind,
  ProviderView,
  QuestionCategory,
  ResumeRecord,
  ResumeSummary,
  SessionDetail,
  SessionKind,
  SessionRecord,
  SttKeyView,
  SttProviderId,
  Story,
  StoryInput,
  TurnLatency,
  UserProfile,
} from './types';
import type { HotkeyAction } from './settings';
import type { EngineSnapshotDTO } from './liveTypes';
import type { LatencySummary } from './latencySummary';
import type { LocalSttStatus, SttTestResult } from './speech';

export type { Level, MockEvaluation, MockMetrics };

export interface ExtractedDocumentDTO {
  name: string;
  source: DocumentSource;
  text: string;
  pages?: number;
  warnings: string[];
}

export interface MockTurnRecord {
  index: number;
  question: string;
  answer: string;
  durationMs: number | null;
  metrics: MockMetrics;
  evaluation: MockEvaluation | null;
  evaluationError?: string;
}

export interface MockSummary {
  sessionId: string;
  turns: MockTurnRecord[];
  tally: Record<'relevance' | 'completeness' | 'structure' | 'conciseness', Record<Level, number>>;
  avgWords: number | null;
}

export interface BenchRun {
  scenario: string;
  ttftMs: number | null;
  totalMs: number | null;
  words: number;
  ok: boolean;
  error?: string;
  cacheHit: boolean;
}

export interface BenchResult {
  id: string;
  createdAt: number;
  provider: string;
  model: string;
  mode: AnswerMode;
  runs: BenchRun[];
  ttft: LatencySummary;
  total: LatencySummary;
  failures: number;
  notes: string[];
}

export interface LiveDebug {
  summary: {
    turns: number;
    cacheHits: number;
    ttft: LatencySummary;
    total: LatencySummary;
    perceived: LatencySummary;
    retrieval: LatencySummary;
  };
  recent: TurnLatency[];
  cacheSize: number;
  audio: { name: 'mic' | 'system'; seconds: number }[];
  sttStates: { source: 'mic' | 'system'; provider: SttProviderId; state: string }[];
}

export interface LiveStartResult {
  sessionId: string;
  sources: ('mic' | 'system')[];
  sttConfigured: boolean;
  notices: string[];
}

export interface StorageInfo {
  dbPath: string;
  dbBytes: number;
  logPath: string;
  counts: { interviews: number; liveSessions: number; mockSessions: number; stories: number; answers: number };
}

/** Request/response contract for every invoke channel. */
export interface Rpc {
  'app.info': { req: void; res: AppInfo };
  /** Which AI models and which speech engine are answering right now, and where they run. */
  'app.activeProviders': { req: void; res: ActiveProviders };
  'app.dashboard': { req: void; res: Dashboard };
  'app.openExternal': { req: { url: string }; res: void };
  'app.openSystemSettings': { req: { page: 'microphone' | 'sound' }; res: void };
  'app.setKeepOnTop': { req: { value: boolean }; res: void };
  'app.showNotification': { req: { title: string; body: string }; res: void };

  'settings.get': { req: void; res: AppSettings };
  'settings.update': { req: DeepPartial<AppSettings>; res: AppSettings };
  'profile.get': { req: void; res: UserProfile };
  'profile.update': { req: Partial<Omit<UserProfile, 'updatedAt'>>; res: UserProfile };
  'hotkeys.status': { req: void; res: Record<HotkeyAction, { registered: boolean; accelerator: string }> };

  'providers.list': { req: void; res: ProviderView[] };
  'providers.save': { req: { id?: string; name: string; kind: ProviderKind; baseUrl: string; enabled: boolean; apiKey?: string; google?: GoogleAuthConfig }; res: ProviderView };
  'providers.delete': { req: { id: string }; res: void };
  'providers.clearKey': { req: { id: string }; res: ProviderView };
  'providers.listModels': { req: { id: string }; res: ModelListResult };
  'providers.checkAuth': { req: { id: string }; res: GoogleAuthStatus };
  'models.list': { req: void; res: ModelConfig[] };
  'models.save': { req: Omit<ModelConfig, 'id'> & { id?: string }; res: ModelConfig };
  'models.delete': { req: { id: string }; res: void };
  'models.test': { req: { id: string }; res: ConnectionTestResult };
  'models.probe': { req: { providerId: string; candidates: string[] }; res: ModelProbeResult };
  'models.quickSetup': { req: { providerId: string; fastModel: string; qualityModel: string }; res: { live: ModelConfig; prep: ModelConfig } };
  'stt.keys': { req: void; res: SttKeyView[] };
  'stt.setKey': { req: { provider: CloudSttProviderId; apiKey: string }; res: SttKeyView };
  'stt.clearKey': { req: { provider: CloudSttProviderId }; res: SttKeyView };
  'stt.test': { req: { provider: SttProviderId }; res: SttTestResult };
  /** State of the on-device speech engine (idle, loading, ready, or why it failed). */
  'stt.localStatus': { req: void; res: LocalSttStatus };
  /** Load the on-device model now, so the first listening session starts instantly. Returns the resulting status. */
  'stt.warmup': { req: void; res: LocalSttStatus };

  'documents.pick': { req: { purpose: 'resume' | 'jd' }; res: ExtractedDocumentDTO | null };
  'documents.extract': { req: { name: string; data: ArrayBuffer }; res: ExtractedDocumentDTO };
  'resumes.list': { req: void; res: ResumeSummary[] };
  'resumes.get': { req: { id: string }; res: ResumeRecord };
  'resumes.create': { req: { name: string; source: DocumentSource; text: string; useAi: boolean }; res: ResumeRecord };
  'resumes.reparse': { req: { id: string; useAi: boolean }; res: ResumeRecord };
  'resumes.delete': { req: { id: string }; res: void };

  'interviews.list': { req: void; res: Interview[] };
  'interviews.get': { req: { id: string }; res: Interview };
  'interviews.create': { req: InterviewInput; res: Interview };
  'interviews.update': { req: { id: string; patch: Partial<Pick<Interview, 'jobTitle' | 'company' | 'interviewType' | 'jobDescription' | 'companyNotes' | 'interviewerInfo' | 'resumeId' | 'notes'>> }; res: Interview };
  'interviews.delete': { req: { id: string }; res: void };
  'interviews.analyze': { req: { id: string; useAi: boolean }; res: Interview };
  'prep.get': { req: { interviewId: string }; res: Partial<Record<PrepSectionKey, PrepSection<unknown>>> };
  'prep.generate': { req: { interviewId: string; section: PrepSectionKey | 'all' }; res: void };
  'prep.answer': { req: { interviewId: string | null; question: string; mode: AnswerMode; save: boolean }; res: { requestId: string } };
  'prep.answers': { req: { interviewId: string }; res: AnswerRecord[] };
  'gen.cancel': { req: { requestId: string }; res: void };

  'stories.list': { req: void; res: Story[] };
  'stories.save': { req: StoryInput & { id?: string }; res: Story };
  'stories.delete': { req: { id: string }; res: void };
  'stories.assist': { req: { notes: string }; res: StoryInput };

  'questions.list': { req: { search?: string; category?: QuestionCategory; favorite?: boolean }; res: BankQuestion[] };
  'questions.add': { req: { text: string; category: QuestionCategory }; res: BankQuestion[] };
  'questions.favorite': { req: { id: string }; res: BankQuestion | null };
  'questions.delete': { req: { id: string }; res: void };
  'questions.practiced': { req: { id: string }; res: void };

  'sessions.list': { req: { kind?: SessionKind; search?: string }; res: SessionRecord[] };
  'sessions.get': { req: { id: string }; res: SessionDetail };
  'sessions.notes': { req: { id: string; notes: string }; res: void };
  'sessions.delete': { req: { id: string }; res: void };
  'answers.edit': { req: { id: string; text: string }; res: void };
  'answers.feedback': { req: { id: string; tags: FeedbackTag[] }; res: void };

  'live.start': { req: { interviewId: string | null; /** Listen with speech recognition. The main process decides which sources from its own settings. */ audio: boolean }; res: LiveStartResult };
  'live.stop': { req: void; res: SessionRecord | null };
  'live.pause': { req: { paused: boolean }; res: void };
  'live.question': { req: { text: string; mode?: AnswerMode }; res: void };
  'live.answerNow': { req: void; res: void };
  'live.regenerate': { req: void; res: void };
  'live.mode': { req: { mode: AnswerMode }; res: void };
  'live.cycleMode': { req: void; res: void };
  'live.shorter': { req: void; res: void };
  'live.expand': { req: void; res: void };
  'live.transform': { req: { kind: 'conversational' | 'add-detail'; addition?: string }; res: void };
  'live.followups': { req: void; res: void };
  'live.feedback': { req: { answerId: string | null; tags: FeedbackTag[] }; res: void };
  'live.copy': { req: void; res: { copied: boolean } };
  'live.snapshot': { req: void; res: EngineSnapshotDTO | null };
  'live.reportUi': { req: { requestId: string; firstPaintMs: number }; res: void };
  'live.debug': { req: void; res: LiveDebug | null };
  'audio.arm': { req: { system: boolean }; res: void };

  'mock.start': { req: { interviewId: string | null; questionCount: number; kind: 'mock' | 'practice'; firstQuestion?: string }; res: { sessionId: string; question: string } };
  'mock.listen': { req: { sessionId: string; on: boolean }; res: { sources: ('mic')[] } };
  'mock.answer': { req: { sessionId: string; answer: string; durationMs: number | null }; res: { turn: MockTurnRecord; next: string | null } };
  'mock.finish': { req: { sessionId: string }; res: MockSummary };
  'mock.summary': { req: { sessionId: string }; res: MockSummary | null };

  'bench.run': { req: { runs: number; mode: AnswerMode }; res: BenchResult };
  'bench.history': { req: void; res: BenchResult[] };
  'perf.get': { req: void; res: { startupMs: number; uptimeS: number; memoryMB: number } };

  'data.export': { req: void; res: { path: string } | null };
  'data.purge': { req: { scope: 'history' | 'all' }; res: void };
  'data.storage': { req: void; res: StorageInfo };
}

export type RpcChannel = keyof Rpc;
export type RpcReq<K extends RpcChannel> = Rpc[K]['req'];
export type RpcRes<K extends RpcChannel> = Rpc[K]['res'];

export type MockEvent = { type: 'transcript'; text: string; isFinal: boolean } | { type: 'status'; state: string; message?: string };

export interface AllPush extends PushChannels {
  'mock.event': MockEvent;
}

/** The API exposed to the renderer by the preload script. */
export interface DesktopApi {
  invoke<K extends RpcChannel>(channel: K, ...args: RpcReq<K> extends void ? [] : [RpcReq<K>]): Promise<RpcRes<K>>;
  on<K extends keyof AllPush>(channel: K, cb: (payload: AllPush[K]) => void): () => void;
  /** Stream captured audio (PCM16, 16 kHz, mono) to the main process. */
  sendAudio(source: 'mic' | 'system', pcm: ArrayBuffer): void;
}

export const AI_TASK_LIST: AiTask[] = ['live', 'prep', 'classify', 'mock'];

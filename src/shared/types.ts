import type { EndpointScope } from './net';
/**
 * Domain model shared by the main process, the pure-logic core and the renderer.
 * Keep this file free of runtime dependencies: it is imported by every layer.
 */

export type Id = string;

/* ------------------------------------------------------------------ */
/* Interviews                                                          */
/* ------------------------------------------------------------------ */

export const INTERVIEW_TYPES = [
  { value: 'general', label: 'General' },
  { value: 'hr', label: 'HR' },
  { value: 'behavioral', label: 'Behavioral' },
  { value: 'technical', label: 'Technical' },
  { value: 'managerial', label: 'Managerial' },
  { value: 'case-study', label: 'Case study' },
  { value: 'coding', label: 'Coding' },
  { value: 'customer-service', label: 'Customer service' },
  { value: 'sales', label: 'Sales' },
  { value: 'analytics', label: 'Analytics' },
  { value: 'operations', label: 'Operations' },
  { value: 'leadership', label: 'Leadership' },
] as const;

export type InterviewType = (typeof INTERVIEW_TYPES)[number]['value'];

export type QuestionCategory =
  | 'behavioral'
  | 'hr'
  | 'technical'
  | 'situational'
  | 'role-specific'
  | 'leadership'
  | 'follow-up'
  | 'management'
  | 'analytics'
  | 'operations'
  | 'customer-service'
  | 'sales'
  | 'product'
  | 'finance'
  | 'marketing'
  | 'software'
  | 'data'
  | 'case-study';

export const QUESTION_CATEGORY_LABELS: Record<QuestionCategory, string> = {
  behavioral: 'Behavioral',
  hr: 'HR',
  technical: 'Technical',
  situational: 'Situational',
  'role-specific': 'Role-specific',
  leadership: 'Leadership',
  'follow-up': 'Follow-up',
  management: 'Management',
  analytics: 'Analytics',
  operations: 'Operations',
  'customer-service': 'Customer service',
  sales: 'Sales',
  product: 'Product',
  finance: 'Finance',
  marketing: 'Marketing',
  software: 'Software',
  data: 'Data',
  'case-study': 'Case study',
};

/** Categories shown in the question bank filter (the spec's list). */
export const BANK_CATEGORIES: QuestionCategory[] = [
  'behavioral',
  'hr',
  'technical',
  'leadership',
  'management',
  'analytics',
  'operations',
  'customer-service',
  'sales',
  'product',
  'finance',
  'marketing',
  'software',
  'data',
  'case-study',
];

export interface Interview {
  id: Id;
  title: string;
  jobTitle: string;
  company: string;
  interviewType: InterviewType;
  jobDescription: string;
  companyNotes: string;
  interviewerInfo: string;
  resumeId: Id | null;
  jdAnalysis: JdAnalysis | null;
  match: MatchAnalysis | null;
  status: 'draft' | 'ready';
  notes: string;
  createdAt: number;
  updatedAt: number;
}

export interface InterviewInput {
  jobTitle: string;
  company: string;
  interviewType: InterviewType;
  jobDescription: string;
  companyNotes?: string;
  interviewerInfo?: string;
  resumeId: Id | null;
}

/* ------------------------------------------------------------------ */
/* Resume                                                              */
/* ------------------------------------------------------------------ */

export type FactKind =
  | 'summary'
  | 'achievement'
  | 'responsibility'
  | 'skill'
  | 'tool'
  | 'education'
  | 'certification'
  | 'project'
  | 'leadership'
  | 'metric'
  | 'industry'
  | 'note';

/** One atomic, source-grounded statement about the candidate. The unit of retrieval. */
export interface Fact {
  id: Id;
  kind: FactKind;
  text: string;
  /** Where the fact came from. Only 'resume', 'story' and 'user' facts may be claimed as experience. */
  source: 'resume' | 'story' | 'user';
  /** Human label, e.g. "Amazon — Operations Manager". */
  label?: string;
  /** Verbatim excerpt of the source document that supports this fact. */
  evidence: string;
  tags: string[];
}

export interface ResumeRole {
  title: string;
  company: string;
  location?: string;
  start?: string;
  end?: string;
  current?: boolean;
  responsibilities: string[];
  achievements: string[];
  metrics: string[];
  tools: string[];
  leadership: string[];
}

export interface ResumeEducation {
  institution: string;
  degree?: string;
  field?: string;
  year?: string;
}

export interface ResumeProject {
  name: string;
  description?: string;
  technologies: string[];
}

export interface ResumeProfile {
  name?: string;
  headline?: string;
  summary?: string;
  currentRole?: string;
  yearsExperience?: number;
  roles: ResumeRole[];
  skills: string[];
  tools: string[];
  technologies: string[];
  education: ResumeEducation[];
  certifications: string[];
  projects: ResumeProject[];
  metrics: string[];
  leadership: string[];
  industries: string[];
  facts: Fact[];
}

export type DocumentSource = 'pdf' | 'docx' | 'txt' | 'paste';

export interface ResumeRecord {
  id: Id;
  name: string;
  source: DocumentSource;
  rawText: string;
  profile: ResumeProfile;
  parseMethod: 'llm' | 'heuristic';
  warnings: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ResumeSummary {
  id: Id;
  name: string;
  source: DocumentSource;
  parseMethod: 'llm' | 'heuristic';
  factCount: number;
  headline?: string;
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* Job description + match                                             */
/* ------------------------------------------------------------------ */

export interface JdAnalysis {
  jobTitle: string | null;
  company: string | null;
  responsibilities: string[];
  requiredSkills: string[];
  preferredSkills: string[];
  yearsExperience: string | null;
  tools: string[];
  technologies: string[];
  behavioralRequirements: string[];
  leadershipRequirements: string[];
  domainKnowledge: string[];
  keywords: string[];
  kpis: string[];
  competencies: string[];
  method: 'llm' | 'heuristic';
}

export interface MatchEvidence {
  factId: Id;
  text: string;
}

export interface MatchItem {
  requirement: string;
  category: 'skill' | 'tool' | 'responsibility' | 'experience' | 'competency' | 'other';
  strength: 'strong' | 'partial' | 'missing';
  score: number;
  evidence: MatchEvidence[];
  note?: string;
}

export interface TransferableItem {
  requirement: string;
  fromFactIds: Id[];
  explanation: string;
}

export interface MatchAnalysis {
  strong: MatchItem[];
  partial: MatchItem[];
  missing: MatchItem[];
  transferable: TransferableItem[];
  likelyQuestions: string[];
  prepAreas: string[];
  method: 'local' | 'local+llm';
  generatedAt: number;
}

/* ------------------------------------------------------------------ */
/* Preparation material                                                */
/* ------------------------------------------------------------------ */

export type PrepSectionKey = 'about' | 'company' | 'role' | 'questions';

export interface AboutMePrep {
  /** Set when part of this section was not written by the model (its reply could not be completed); shown above the section. */
  note?: string;
  /** Numbers or names in the generated text that are not in the résumé; shown as a warning. */
  unverified?: string[];
  tellMeAboutYourself: string;
  professionalSummary: string;
  careerJourney: string;
  currentRole: string;
  strengths: string[];
  relevantExperience: string[];
}

export interface CompanyPrep {
  /** Set when this section is an offline draft made after the model's reply could not be used. */
  note?: string;
  summary: string;
  fromYourNotes: string[];
  toResearch: string[];
  questionsToAsk: string[];
}

export interface RolePrep {
  /** Set when this section is an offline draft made after the model's reply could not be used. */
  note?: string;
  responsibilities: string[];
  skillsRequired: string[];
  likelyAreas: string[];
  terminology: { term: string; meaning: string }[];
}

export interface PreparedQuestion {
  id: Id;
  category: QuestionCategory;
  text: string;
  why?: string;
}

export interface QuestionsPrep {
  /** Set when this section is an offline draft made after the model's reply could not be used. */
  note?: string;
  questions: PreparedQuestion[];
}

export interface PrepSection<T> {
  interviewId: Id;
  key: PrepSectionKey;
  data: T;
  model: string | null;
  generatedAt: number;
}

/* ------------------------------------------------------------------ */
/* Profile, stories, question bank                                     */
/* ------------------------------------------------------------------ */

export type AnswerStyle = 'conversational' | 'polished' | 'direct';

export interface UserProfile {
  name: string;
  summary: string;
  skills: string[];
  experience: string;
  education: string;
  preferredStyle: AnswerStyle;
  preferredMode: AnswerMode;
  targetRoles: string[];
  interviewPreferences: string;
  /** Extra facts the user explicitly supplies. These may be claimed as experience. */
  extraFacts: string[];
  updatedAt: number;
}

export interface Story {
  id: Id;
  title: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  skills: string[];
  roles: string[];
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export type StoryInput = Omit<Story, 'id' | 'createdAt' | 'updatedAt'>;

export interface BankQuestion {
  id: Id;
  text: string;
  category: QuestionCategory;
  tags: string[];
  source: 'seed' | 'user' | 'generated';
  favorite: boolean;
  practiceCount: number;
  lastPracticedAt: number | null;
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* Answers, sessions, transcripts                                      */
/* ------------------------------------------------------------------ */

export type AnswerMode = 'concise' | 'standard' | 'detailed' | 'bullets' | 'star' | 'technical' | 'followup';

export type FeedbackTag = 'useful' | 'not-useful' | 'too-long' | 'too-generic' | 'incorrect' | 'needs-detail';

export type SessionKind = 'live' | 'mock' | 'practice';

export type Speaker = 'interviewer' | 'candidate' | 'unknown';

export interface TurnLatency {
  /** Speech start → first partial transcript (STT). */
  firstPartialMs?: number;
  /** Speech end → final transcript delivered (STT). */
  sttFinalMs?: number;
  /** Transcript update → question detector decision. */
  detectionMs?: number;
  retrievalMs?: number;
  /** LLM request sent → first token received. */
  ttftMs?: number;
  /** Question detected → answer complete. */
  totalMs?: number;
  /** Interviewer speech end → first token. Negative when speculation started before the speaker finished. */
  perceivedMs?: number;
  /** First token received in the renderer → next painted frame. */
  uiFirstPaintMs?: number;
  speculative?: boolean;
  cacheHit?: boolean;
  restarts?: number;
  provider?: string;
  model?: string;
}

export interface GroundingReport {
  /** 'grounded' = every checked detail appears in the supplied facts. */
  status: 'grounded' | 'unverified-details' | 'no-context';
  /** Numbers / names in the answer that are not present in the candidate's facts or the question. */
  unverified: string[];
  /** 0..1: top retrieval relevance for the question. */
  retrievalConfidence: number;
  usedFactIds: Id[];
  usedStoryIds: Id[];
}

export type Level = 'strong' | 'adequate' | 'weak';

export interface MockMetrics {
  words: number;
  seconds: number | null;
  wordsPerMinute: number | null;
  fillers: number;
  fillerList: string[];
  hasNumbers: boolean;
  star: { situation: boolean; task: boolean; action: boolean; result: boolean };
  /** Share of the question's content words that the answer touches (0..1). */
  questionCoverage: number;
}

export interface MockEvaluation {
  relevance: { level: Level; note: string };
  completeness: { level: Level; note: string };
  structure: { level: Level; note: string };
  conciseness: { level: Level; note: string };
  covered: string[];
  missing: string[];
  improvements: string[];
  improvedAnswer: string;
}

/** Stored with a mock/practice answer. */
export interface MockRecord {
  durationMs: number | null;
  metrics: MockMetrics;
  evaluation: MockEvaluation | null;
  evaluationError?: string;
}

export interface AnswerRecord {
  id: Id;
  sessionId: Id | null;
  interviewId: Id | null;
  questionText: string;
  questionKind?: string;
  answerText: string;
  mode: AnswerMode;
  source: 'live' | 'cache' | 'prepared' | 'mock' | 'practice';
  model?: string;
  latency?: TurnLatency;
  grounding?: GroundingReport;
  feedback: FeedbackTag[];
  edited: boolean;
  /** Present on mock/practice answers. */
  mock?: MockRecord;
  createdAt: number;
}

export interface SessionStats {
  turns: number;
  ttftMedianMs?: number;
  ttftP95Ms?: number;
  totalMedianMs?: number;
  cacheHits: number;
}

export interface SessionRecord {
  id: Id;
  kind: SessionKind;
  interviewId: Id | null;
  title: string;
  company: string;
  jobTitle: string;
  interviewType: InterviewType | null;
  startedAt: number;
  endedAt: number | null;
  notes: string;
  stats: SessionStats | null;
}

export interface TranscriptRecord {
  id: Id;
  sessionId: Id;
  seq: number;
  speaker: Speaker;
  text: string;
  ts: number;
}

export interface SessionDetail extends SessionRecord {
  answers: AnswerRecord[];
  transcript: TranscriptRecord[];
  prepSnapshot: string | null;
}

/* ------------------------------------------------------------------ */
/* Providers & models                                                  */
/* ------------------------------------------------------------------ */

export type ProviderKind = 'openai-compatible' | 'anthropic' | 'google';

/** How a Google (Gemini) provider signs in: an API key, or Application Default Credentials (`gcloud auth application-default login`). */
export type GoogleAuthMode = 'apiKey' | 'adc';
/** Vertex AI accepts plain gcloud ADC; the Gemini Developer API endpoint needs an OAuth client (see docs/GOOGLE-ADC.md). */
export type GoogleBackend = 'vertex' | 'gemini-api';

export interface GoogleAuthConfig {
  mode: GoogleAuthMode;
  backend: GoogleBackend;
  /** Google Cloud project used for billing and quota (and as the Vertex AI project). Empty = ADC's quota project, GOOGLE_CLOUD_PROJECT, or the gcloud default. */
  project: string;
  /** Vertex AI location such as "global" or "us-central1". Ignored for the Gemini API backend. */
  location: string;
}

export interface ProviderConfig {
  id: Id;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  enabled: boolean;
  createdAt: number;
  /** Only for kind "google". Absent on providers created before ADC support, which use an API key. */
  google?: GoogleAuthConfig;
}

/** Provider as shown in the UI: never includes the key itself. */
export interface ProviderView extends ProviderConfig {
  keySource: 'stored' | 'env' | 'none';
  keyHint: string | null;
  /** Local endpoints (Ollama, LM Studio) do not need a key. */
  keyOptional: boolean;
  /** Where the server is: this PC, your own network, or the internet. */
  scope: EndpointScope;
}

/** One model as it is currently wired in, for showing "what is answering my questions". */
export interface ActiveModelInfo {
  provider: string;
  model: string;
  scope: EndpointScope;
  kind: ProviderKind;
}

export interface ActiveRoute {
  primary: ActiveModelInfo | null;
  /** Used only if the primary fails, and only because you configured it. */
  fallback: ActiveModelInfo | null;
  /** Why nothing can answer yet (no model, key missing…), in plain words. */
  problem: string | null;
}

/** Which providers are doing the work right now — the interface shows this so nothing happens out of sight. */
export interface ActiveProviders {
  live: ActiveRoute;
  prep: ActiveRoute;
  speech: { provider: SttProviderId; label: string; scope: EndpointScope; detail: string };
}

export interface ModelConfig {
  id: Id;
  name: string;
  providerId: Id;
  model: string;
  temperature: number;
  maxTokens: number;
  topP: number | null;
  timeoutMs: number;
  streaming: boolean;
}

export type AiTask = 'live' | 'prep' | 'classify' | 'mock';

export interface TaskRoute {
  primary: Id | null;
  fallback: Id | null;
}

export type TaskRouting = Record<AiTask, TaskRoute>;

export type SttProviderId = 'deepgram' | 'assemblyai' | 'local';
/** The speech services that need an API key (everything except the on-device engine). */
export type CloudSttProviderId = Exclude<SttProviderId, 'local'>;

export interface SttKeyView {
  provider: CloudSttProviderId;
  keySource: 'stored' | 'env' | 'none';
  keyHint: string | null;
}

export interface ModelListResult {
  ok: boolean;
  models: string[];
  error?: string;
  /** Something worth knowing even though the call succeeded (for example: a built-in list was used). */
  note?: string;
}

export type GoogleAuthProblemCode = 'adc_missing' | 'adc_expired' | 'adc_rejected' | 'adc_network' | 'no_project' | 'refused_host' | 'other';

/** Result of "Check sign-in". Describes the credentials that were found; never contains a token, key or secret. */
export interface GoogleAuthStatus {
  ok: boolean;
  mode: GoogleAuthMode;
  /** Which kind of Application Default Credentials Google's library found. */
  credential?: 'user' | 'service-account' | 'external-account' | 'impersonated' | 'compute' | 'other';
  /** The project requests will be billed to, and where it came from. */
  project?: string;
  projectSource?: 'provider' | 'environment' | 'adc' | 'gcloud';
  problem?: { code: GoogleAuthProblemCode; title: string; detail: string; steps: string[] };
  latencyMs?: number;
  checkedAt: number;
}

/** Outcome of trying candidate models until one answers. */
export interface ModelProbeResult {
  /** The first model that answered, or null if none did. */
  working: string | null;
  tried: { model: string; ok: boolean; message?: string }[];
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs?: number;
  error?: { code: AiErrorCode; message: string };
  model?: string;
}

export type AiErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'timeout'
  | 'model_not_found'
  | 'context_overflow'
  | 'malformed'
  | 'server'
  | 'bad_request'
  | 'not_configured'
  | 'aborted'
  | 'unknown';

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  isPackaged: boolean;
  userDataPath: string;
  dbPath: string;
  dbSizeBytes: number;
  startupMs: number;
  envKeys: string[];
  safeStorageAvailable: boolean;
}

export interface Dashboard {
  interviews: number;
  liveSessions: number;
  mockSessions: number;
  stories: number;
  answers: number;
  ttftMedianMs: number | null;
  recentInterviews: Interview[];
  recentSessions: SessionRecord[];
}

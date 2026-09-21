import type {
  AnswerRecord,
  BankQuestion,
  FeedbackTag,
  Interview,
  InterviewInput,
  JdAnalysis,
  MatchAnalysis,
  ModelConfig,
  PrepSection,
  PrepSectionKey,
  GoogleAuthConfig,
  ProviderConfig,
  QuestionCategory,
  ResumeRecord,
  ResumeSummary,
  SessionDetail,
  SessionKind,
  SessionRecord,
  SessionStats,
  Story,
  StoryInput,
  TranscriptRecord,
  UserProfile,
} from '@shared/types';
import { DEFAULT_SETTINGS, mergeSettings, type AppSettings, type DeepPartial } from '@shared/settings';
import { safeJsonParse, uid } from '@shared/util';
import type { Db } from './database';

type Row = Record<string, unknown>;

/** Stored Google sign-in options; anything malformed is treated as "an API-key provider" rather than trusted. */
function parseGoogleOptions(raw: unknown): GoogleAuthConfig | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const j = JSON.parse(raw) as Partial<GoogleAuthConfig>;
    const mode = j.mode === 'adc' ? 'adc' : 'apiKey';
    const backend = j.backend === 'vertex' ? 'vertex' : 'gemini-api';
    return { mode, backend, project: typeof j.project === 'string' ? j.project : '', location: typeof j.location === 'string' ? j.location : '' };
  } catch {
    return undefined;
  }
}
const s = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean' ? String(v) : '');
const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const nn = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const j = <T>(v: unknown, fallback: T): T => safeJsonParse<T>(typeof v === 'string' ? v : null, fallback);

/** All persistence lives here. Handlers never write SQL. */
export class Repos {
  constructor(readonly db: Db) {}

  /* ---------------- settings ---------------- */

  getSettings(): AppSettings {
    const rows = this.db.all<{ key: string; value: string }>('SELECT key, value FROM settings');
    let out: AppSettings = structuredClone(DEFAULT_SETTINGS);
    for (const r of rows) {
      if (r.key === 'app') out = mergeSettings(out, safeJsonParse<DeepPartial<AppSettings>>(r.value, {}));
    }
    return out;
  }

  /** One-time markers ("this migration already ran"). Stored beside the settings but never part of them. */
  hasFlag(name: string): boolean {
    return !!this.db.get<Row>('SELECT key FROM settings WHERE key = ?', `flag.${name}`);
  }

  setFlag(name: string): void {
    this.db.run("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, '1', ?)", `flag.${name}`, Date.now());
  }

  updateSettings(patch: DeepPartial<AppSettings>): AppSettings {
    const next = mergeSettings(this.getSettings(), patch);
    this.db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES ('app', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      JSON.stringify(next),
      Date.now(),
    );
    return next;
  }

  /* ---------------- profile ---------------- */

  getProfile(): UserProfile {
    const r = this.db.get<Row>("SELECT * FROM users WHERE id = 'local'");
    if (!r) {
      return {
        name: '',
        summary: '',
        skills: [],
        experience: '',
        education: '',
        preferredStyle: 'conversational',
        preferredMode: 'standard',
        targetRoles: [],
        interviewPreferences: '',
        extraFacts: [],
        updatedAt: 0,
      };
    }
    return {
      name: s(r.name),
      summary: s(r.summary),
      skills: j<string[]>(r.skills, []),
      experience: s(r.experience),
      education: s(r.education),
      preferredStyle: s(r.preferred_style) as UserProfile['preferredStyle'],
      preferredMode: s(r.preferred_mode) as UserProfile['preferredMode'],
      targetRoles: j<string[]>(r.target_roles, []),
      interviewPreferences: s(r.interview_preferences),
      extraFacts: j<string[]>(r.extra_facts, []),
      updatedAt: n(r.updated_at),
    };
  }

  updateProfile(patch: Partial<UserProfile>): UserProfile {
    const p = { ...this.getProfile(), ...patch, updatedAt: Date.now() };
    this.db.run(
      `INSERT INTO users (id, name, summary, skills, experience, education, preferred_style, preferred_mode, target_roles, interview_preferences, extra_facts, updated_at)
       VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, summary=excluded.summary, skills=excluded.skills, experience=excluded.experience,
         education=excluded.education, preferred_style=excluded.preferred_style, preferred_mode=excluded.preferred_mode,
         target_roles=excluded.target_roles, interview_preferences=excluded.interview_preferences, extra_facts=excluded.extra_facts, updated_at=excluded.updated_at`,
      p.name,
      p.summary,
      JSON.stringify(p.skills),
      p.experience,
      p.education,
      p.preferredStyle,
      p.preferredMode,
      JSON.stringify(p.targetRoles),
      p.interviewPreferences,
      JSON.stringify(p.extraFacts),
      p.updatedAt,
    );
    return p;
  }

  /* ---------------- providers & models ---------------- */

  listProviders(): ProviderConfig[] {
    return this.db.all<Row>('SELECT * FROM providers ORDER BY created_at').map(this.toProvider);
  }

  getProvider(id: string): ProviderConfig | null {
    const r = this.db.get<Row>('SELECT * FROM providers WHERE id = ?', id);
    return r ? this.toProvider(r) : null;
  }

  private toProvider = (r: Row): ProviderConfig => {
    const p: ProviderConfig = {
      id: s(r.id),
      name: s(r.name),
      kind: s(r.kind) as ProviderConfig['kind'],
      baseUrl: s(r.base_url),
      enabled: n(r.enabled) === 1,
      createdAt: n(r.created_at),
    };
    const google = parseGoogleOptions(r.options_json);
    if (p.kind === 'google' && google) p.google = google;
    return p;
  };

  saveProvider(p: Omit<ProviderConfig, 'id' | 'createdAt'> & { id?: string }): ProviderConfig {
    const id = p.id ?? uid('prv');
    const existing = this.getProvider(id);
    this.db.run(
      `INSERT INTO providers (id, name, kind, base_url, enabled, created_at, options_json) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, base_url=excluded.base_url, enabled=excluded.enabled, options_json=excluded.options_json`,
      id,
      p.name,
      p.kind,
      p.baseUrl,
      p.enabled ? 1 : 0,
      existing?.createdAt ?? Date.now(),
      p.kind === 'google' && p.google ? JSON.stringify(p.google) : null,
    );
    return this.getProvider(id)!;
  }

  deleteProvider(id: string): void {
    this.db.run('DELETE FROM providers WHERE id = ?', id);
  }

  listModels(): ModelConfig[] {
    return this.db.all<Row>('SELECT * FROM model_configs ORDER BY rowid').map(this.toModel);
  }

  getModel(id: string): ModelConfig | null {
    const r = this.db.get<Row>('SELECT * FROM model_configs WHERE id = ?', id);
    return r ? this.toModel(r) : null;
  }

  private toModel = (r: Row): ModelConfig => ({
    id: s(r.id),
    name: s(r.name),
    providerId: s(r.provider_id),
    model: s(r.model),
    temperature: n(r.temperature),
    maxTokens: n(r.max_tokens),
    topP: nn(r.top_p),
    timeoutMs: n(r.timeout_ms),
    streaming: n(r.streaming) === 1,
  });

  saveModel(m: Omit<ModelConfig, 'id'> & { id?: string }): ModelConfig {
    const id = m.id ?? uid('mdl');
    this.db.run(
      `INSERT INTO model_configs (id, name, provider_id, model, temperature, max_tokens, top_p, timeout_ms, streaming)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, provider_id=excluded.provider_id, model=excluded.model, temperature=excluded.temperature,
         max_tokens=excluded.max_tokens, top_p=excluded.top_p, timeout_ms=excluded.timeout_ms, streaming=excluded.streaming`,
      id,
      m.name,
      m.providerId,
      m.model,
      m.temperature,
      m.maxTokens,
      m.topP,
      m.timeoutMs,
      m.streaming ? 1 : 0,
    );
    return this.getModel(id)!;
  }

  deleteModel(id: string): void {
    this.db.run('DELETE FROM model_configs WHERE id = ?', id);
    // Clear routes that pointed at it.
    const settings = this.getSettings();
    const patch: DeepPartial<AppSettings> = { routing: {} };
    let changed = false;
    for (const [task, route] of Object.entries(settings.routing)) {
      const r: { primary?: string | null; fallback?: string | null } = {};
      if (route.primary === id) {
        r.primary = null;
        changed = true;
      }
      if (route.fallback === id) {
        r.fallback = null;
        changed = true;
      }
      if (Object.keys(r).length) (patch.routing as Record<string, unknown>)[task] = r;
    }
    if (changed) this.updateSettings(patch);
  }

  /* ---------------- resumes ---------------- */

  private toResume = (r: Row): ResumeRecord => ({
    id: s(r.id),
    name: s(r.name),
    source: s(r.source) as ResumeRecord['source'],
    rawText: s(r.raw_text),
    profile: j(r.profile_json, { roles: [], skills: [], tools: [], technologies: [], education: [], certifications: [], projects: [], metrics: [], leadership: [], industries: [], facts: [] }),
    parseMethod: s(r.parse_method) as ResumeRecord['parseMethod'],
    warnings: j<string[]>(r.warnings, []),
    createdAt: n(r.created_at),
    updatedAt: n(r.updated_at),
  });

  listResumes(): ResumeSummary[] {
    return this.db
      .all<Row>('SELECT * FROM resumes ORDER BY created_at DESC')
      .map(this.toResume)
      .map((r) => ({ id: r.id, name: r.name, source: r.source, parseMethod: r.parseMethod, factCount: r.profile.facts.length, headline: r.profile.headline ?? r.profile.currentRole, createdAt: r.createdAt }));
  }

  getResume(id: string): ResumeRecord | null {
    const r = this.db.get<Row>('SELECT * FROM resumes WHERE id = ?', id);
    return r ? this.toResume(r) : null;
  }

  saveResume(rec: Omit<ResumeRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): ResumeRecord {
    const id = rec.id ?? uid('res');
    const now = Date.now();
    const existing = rec.id ? this.getResume(rec.id) : null;
    this.db.run(
      `INSERT INTO resumes (id, name, source, raw_text, profile_json, parse_method, warnings, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, source=excluded.source, raw_text=excluded.raw_text, profile_json=excluded.profile_json,
         parse_method=excluded.parse_method, warnings=excluded.warnings, updated_at=excluded.updated_at`,
      id,
      rec.name,
      rec.source,
      rec.rawText,
      JSON.stringify(rec.profile),
      rec.parseMethod,
      JSON.stringify(rec.warnings),
      existing?.createdAt ?? now,
      now,
    );
    return this.getResume(id)!;
  }

  deleteResume(id: string): void {
    this.db.run('DELETE FROM resumes WHERE id = ?', id);
  }

  /* ---------------- interviews ---------------- */

  private toInterview = (r: Row): Interview => {
    const jd = this.db.get<Row>('SELECT * FROM job_descriptions WHERE interview_id = ?', s(r.id));
    return {
      id: s(r.id),
      title: s(r.title),
      jobTitle: s(r.job_title),
      company: s(r.company),
      interviewType: s(r.interview_type) as Interview['interviewType'],
      jobDescription: jd ? s(jd.raw_text) : '',
      companyNotes: s(r.company_notes),
      interviewerInfo: s(r.interviewer_info),
      resumeId: r.resume_id ? s(r.resume_id) : null,
      jdAnalysis: jd ? j<JdAnalysis | null>(jd.analysis_json, null) : null,
      match: j<MatchAnalysis | null>(r.match_json, null),
      status: s(r.status) as Interview['status'],
      notes: s(r.notes),
      createdAt: n(r.created_at),
      updatedAt: n(r.updated_at),
    };
  };

  listInterviews(): Interview[] {
    return this.db.all<Row>('SELECT * FROM interviews ORDER BY updated_at DESC').map(this.toInterview);
  }

  getInterview(id: string): Interview | null {
    const r = this.db.get<Row>('SELECT * FROM interviews WHERE id = ?', id);
    return r ? this.toInterview(r) : null;
  }

  createInterview(input: InterviewInput): Interview {
    const id = uid('int');
    const now = Date.now();
    const title = [input.jobTitle, input.company && `@ ${input.company}`].filter(Boolean).join(' ') || 'Untitled interview';
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO interviews (id, title, job_title, company, interview_type, company_notes, interviewer_info, resume_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
        id,
        title,
        input.jobTitle,
        input.company,
        input.interviewType,
        input.companyNotes ?? '',
        input.interviewerInfo ?? '',
        input.resumeId,
        now,
        now,
      );
      this.db.run('INSERT INTO job_descriptions (id, interview_id, raw_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', uid('jd'), id, input.jobDescription, now, now);
    });
    return this.getInterview(id)!;
  }

  updateInterview(id: string, patch: Partial<Omit<Interview, 'id' | 'createdAt' | 'updatedAt'>>): Interview {
    const cur = this.getInterview(id);
    if (!cur) throw new Error('Interview not found.');
    const next = { ...cur, ...patch };
    const title = [next.jobTitle, next.company && `@ ${next.company}`].filter(Boolean).join(' ') || 'Untitled interview';
    const now = Date.now();
    this.db.tx(() => {
      this.db.run(
        `UPDATE interviews SET title=?, job_title=?, company=?, interview_type=?, company_notes=?, interviewer_info=?, resume_id=?, match_json=?, status=?, notes=?, updated_at=? WHERE id=?`,
        title,
        next.jobTitle,
        next.company,
        next.interviewType,
        next.companyNotes,
        next.interviewerInfo,
        next.resumeId,
        next.match ? JSON.stringify(next.match) : null,
        next.status,
        next.notes,
        now,
        id,
      );
      this.db.run('UPDATE job_descriptions SET raw_text=?, analysis_json=?, updated_at=? WHERE interview_id=?', next.jobDescription, next.jdAnalysis ? JSON.stringify(next.jdAnalysis) : null, now, id);
    });
    return this.getInterview(id)!;
  }

  deleteInterview(id: string): void {
    this.db.run('DELETE FROM interviews WHERE id = ?', id);
  }

  getPrep(interviewId: string): Partial<Record<PrepSectionKey, PrepSection<unknown>>> {
    const out: Partial<Record<PrepSectionKey, PrepSection<unknown>>> = {};
    for (const r of this.db.all<Row>('SELECT * FROM prep_sections WHERE interview_id = ?', interviewId)) {
      const key = s(r.key) as PrepSectionKey;
      out[key] = { interviewId, key, data: j(r.data_json, {}), model: r.model ? s(r.model) : null, generatedAt: n(r.generated_at) };
    }
    return out;
  }

  savePrep(interviewId: string, key: PrepSectionKey, data: unknown, model: string | null): void {
    this.db.run(
      `INSERT INTO prep_sections (interview_id, key, data_json, model, generated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(interview_id, key) DO UPDATE SET data_json=excluded.data_json, model=excluded.model, generated_at=excluded.generated_at`,
      interviewId,
      key,
      JSON.stringify(data),
      model,
      Date.now(),
    );
    this.db.run('UPDATE interviews SET updated_at = ? WHERE id = ?', Date.now(), interviewId);
  }

  /* ---------------- stories ---------------- */

  private toStory = (r: Row): Story => ({
    id: s(r.id),
    title: s(r.title),
    situation: s(r.situation),
    task: s(r.task),
    action: s(r.action),
    result: s(r.result),
    skills: j<string[]>(r.skills, []),
    roles: j<string[]>(r.roles, []),
    tags: j<string[]>(r.tags, []),
    createdAt: n(r.created_at),
    updatedAt: n(r.updated_at),
  });

  listStories(): Story[] {
    return this.db.all<Row>('SELECT * FROM stories ORDER BY updated_at DESC').map(this.toStory);
  }

  saveStory(input: StoryInput & { id?: string }): Story {
    const id = input.id ?? uid('sty');
    const now = Date.now();
    const existing = input.id ? this.db.get<Row>('SELECT created_at FROM stories WHERE id = ?', id) : undefined;
    this.db.run(
      `INSERT INTO stories (id, title, situation, task, action, result, skills, roles, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, situation=excluded.situation, task=excluded.task, action=excluded.action, result=excluded.result,
         skills=excluded.skills, roles=excluded.roles, tags=excluded.tags, updated_at=excluded.updated_at`,
      id,
      input.title,
      input.situation,
      input.task,
      input.action,
      input.result,
      JSON.stringify(input.skills),
      JSON.stringify(input.roles),
      JSON.stringify(input.tags),
      existing ? n(existing.created_at) : now,
      now,
    );
    return this.toStory(this.db.get<Row>('SELECT * FROM stories WHERE id = ?', id)!);
  }

  deleteStory(id: string): void {
    this.db.run('DELETE FROM stories WHERE id = ?', id);
  }

  /* ---------------- question bank ---------------- */

  private toQuestion = (r: Row): BankQuestion => ({
    id: s(r.id),
    text: s(r.text),
    category: s(r.category) as QuestionCategory,
    tags: j<string[]>(r.tags, []),
    source: s(r.source) as BankQuestion['source'],
    favorite: n(r.favorite) === 1,
    practiceCount: n(r.practice_count),
    lastPracticedAt: nn(r.last_practiced_at),
    createdAt: n(r.created_at),
  });

  countQuestions(): number {
    return n(this.db.get<Row>('SELECT COUNT(*) AS c FROM questions')?.c);
  }

  listQuestions(f: { search?: string; category?: QuestionCategory; favorite?: boolean; limit?: number } = {}): BankQuestion[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.category) {
      where.push('category = ?');
      params.push(f.category);
    }
    if (f.favorite) where.push('favorite = 1');
    if (f.search?.trim()) {
      where.push('(text LIKE ? OR tags LIKE ?)');
      const like = `%${f.search.trim().replace(/[%_]/g, '')}%`;
      params.push(like, like);
    }
    const sql = `SELECT * FROM questions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY favorite DESC, created_at, text LIMIT ?`;
    return this.db.all<Row>(sql, ...params, f.limit ?? 500).map(this.toQuestion);
  }

  addQuestions(items: { text: string; category: QuestionCategory; tags?: string[]; source: BankQuestion['source'] }[]): number {
    let added = 0;
    this.db.tx(() => {
      for (const q of items) {
        if (this.db.get('SELECT 1 AS x FROM questions WHERE text = ? AND category = ?', q.text, q.category)) continue;
        this.db.run('INSERT INTO questions (id, text, category, tags, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', uid('q'), q.text, q.category, JSON.stringify(q.tags ?? []), q.source, Date.now());
        added++;
      }
    });
    return added;
  }

  toggleFavorite(id: string): BankQuestion | null {
    this.db.run('UPDATE questions SET favorite = 1 - favorite WHERE id = ?', id);
    const r = this.db.get<Row>('SELECT * FROM questions WHERE id = ?', id);
    return r ? this.toQuestion(r) : null;
  }

  markPracticed(id: string): void {
    this.db.run('UPDATE questions SET practice_count = practice_count + 1, last_practiced_at = ? WHERE id = ?', Date.now(), id);
  }

  deleteQuestion(id: string): void {
    this.db.run("DELETE FROM questions WHERE id = ? AND source != 'seed'", id);
  }

  /* ---------------- sessions, answers, transcripts ---------------- */

  private toSession = (r: Row): SessionRecord => ({
    id: s(r.id),
    kind: s(r.kind) as SessionKind,
    interviewId: r.interview_id ? s(r.interview_id) : null,
    title: s(r.title),
    company: s(r.company),
    jobTitle: s(r.job_title),
    interviewType: r.interview_type ? (s(r.interview_type) as SessionRecord['interviewType']) : null,
    startedAt: n(r.started_at),
    endedAt: nn(r.ended_at),
    notes: s(r.notes),
    stats: j<SessionStats | null>(r.stats_json, null),
  });

  createSession(input: { kind: SessionKind; interview: Interview | null; title?: string }): SessionRecord {
    const id = uid('ses');
    const i = input.interview;
    this.db.run(
      'INSERT INTO sessions (id, kind, interview_id, title, company, job_title, interview_type, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      input.kind,
      i?.id ?? null,
      input.title ?? i?.title ?? (input.kind === 'live' ? 'Live session' : 'Practice session'),
      i?.company ?? '',
      i?.jobTitle ?? '',
      i?.interviewType ?? null,
      Date.now(),
    );
    return this.getSession(id)!;
  }

  getSession(id: string): SessionRecord | null {
    const r = this.db.get<Row>('SELECT * FROM sessions WHERE id = ?', id);
    return r ? this.toSession(r) : null;
  }

  endSession(id: string, stats: SessionStats | null, prepSnapshot?: string | null): void {
    this.db.run('UPDATE sessions SET ended_at = ?, stats_json = ?, prep_snapshot = COALESCE(?, prep_snapshot) WHERE id = ?', Date.now(), stats ? JSON.stringify(stats) : null, prepSnapshot ?? null, id);
    this.reindexSession(id);
  }

  updateSessionNotes(id: string, notes: string): void {
    this.db.run('UPDATE sessions SET notes = ? WHERE id = ?', notes, id);
    this.reindexSession(id);
  }

  listSessions(f: { kind?: SessionKind; search?: string; limit?: number } = {}): SessionRecord[] {
    const params: unknown[] = [];
    const where: string[] = [];
    if (f.kind) {
      where.push('kind = ?');
      params.push(f.kind);
    }
    if (f.search?.trim()) {
      const q = ftsQuery(f.search);
      if (q) {
        where.push('id IN (SELECT session_id FROM search_index WHERE search_index MATCH ?)');
        params.push(q);
      }
    }
    const sql = `SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC LIMIT ?`;
    return this.db.all<Row>(sql, ...params, f.limit ?? 200).map(this.toSession);
  }

  getSessionDetail(id: string): SessionDetail | null {
    const ses = this.getSession(id);
    if (!ses) return null;
    const prep = this.db.get<Row>('SELECT prep_snapshot FROM sessions WHERE id = ?', id);
    return { ...ses, answers: this.listAnswers({ sessionId: id }), transcript: this.listTranscript(id), prepSnapshot: prep?.prep_snapshot ? s(prep.prep_snapshot) : null };
  }

  deleteSession(id: string): void {
    this.db.tx(() => {
      this.db.run('DELETE FROM search_index WHERE session_id = ?', id);
      this.db.run('DELETE FROM sessions WHERE id = ?', id);
    });
  }

  private toAnswer = (r: Row): AnswerRecord => ({
    id: s(r.id),
    sessionId: r.session_id ? s(r.session_id) : null,
    interviewId: r.interview_id ? s(r.interview_id) : null,
    questionText: s(r.question_text),
    questionKind: r.question_kind ? s(r.question_kind) : undefined,
    answerText: s(r.answer_text),
    mode: s(r.mode) as AnswerRecord['mode'],
    source: s(r.source) as AnswerRecord['source'],
    model: r.model ? s(r.model) : undefined,
    latency: j(r.latency_json, undefined),
    grounding: j(r.grounding_json, undefined),
    feedback: j<FeedbackTag[]>(r.feedback, []),
    edited: n(r.edited) === 1,
    mock: j(r.mock_json, undefined),
    createdAt: n(r.created_at),
  });

  saveAnswer(a: Omit<AnswerRecord, 'id' | 'createdAt'> & { id?: string }): AnswerRecord {
    const id = a.id ?? uid('ans');
    this.db.run(
      `INSERT INTO answers (id, session_id, interview_id, question_text, question_kind, answer_text, mode, source, model, latency_json, grounding_json, feedback, edited, mock_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET answer_text=excluded.answer_text, edited=excluded.edited, feedback=excluded.feedback, mock_json=excluded.mock_json`,
      id,
      a.sessionId,
      a.interviewId,
      a.questionText,
      a.questionKind ?? null,
      a.answerText,
      a.mode,
      a.source,
      a.model ?? null,
      a.latency ? JSON.stringify(a.latency) : null,
      a.grounding ? JSON.stringify(a.grounding) : null,
      JSON.stringify(a.feedback),
      a.edited ? 1 : 0,
      a.mock ? JSON.stringify(a.mock) : null,
      Date.now(),
    );
    return this.toAnswer(this.db.get<Row>('SELECT * FROM answers WHERE id = ?', id)!);
  }

  listAnswers(f: { sessionId?: string; interviewId?: string; source?: AnswerRecord['source'] }): AnswerRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.sessionId) {
      where.push('session_id = ?');
      params.push(f.sessionId);
    }
    if (f.interviewId) {
      where.push('interview_id = ?');
      params.push(f.interviewId);
    }
    if (f.source) {
      where.push('source = ?');
      params.push(f.source);
    }
    return this.db.all<Row>(`SELECT * FROM answers ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at`, ...params).map(this.toAnswer);
  }

  updateAnswerFeedback(id: string, tags: FeedbackTag[]): void {
    const cur = this.db.get<Row>('SELECT feedback FROM answers WHERE id = ?', id);
    const merged = [...new Set([...j<FeedbackTag[]>(cur?.feedback, []), ...tags])];
    this.db.run('UPDATE answers SET feedback = ? WHERE id = ?', JSON.stringify(merged), id);
  }

  setAnswerFeedback(id: string, tags: FeedbackTag[]): void {
    this.db.run('UPDATE answers SET feedback = ? WHERE id = ?', JSON.stringify(tags), id);
  }

  editAnswer(id: string, text: string): void {
    this.db.run('UPDATE answers SET answer_text = ?, edited = 1 WHERE id = ?', text, id);
  }

  deleteAnswer(id: string): void {
    this.db.run('DELETE FROM answers WHERE id = ?', id);
  }

  addTranscript(sessionId: string, seq: number, speaker: string, text: string, ts: number): void {
    this.db.run('INSERT INTO transcripts (id, session_id, seq, speaker, text, ts) VALUES (?, ?, ?, ?, ?, ?)', uid('tr'), sessionId, seq, speaker, text, ts);
  }

  listTranscript(sessionId: string): TranscriptRecord[] {
    return this.db.all<Row>('SELECT * FROM transcripts WHERE session_id = ? ORDER BY seq', sessionId).map((r) => ({
      id: s(r.id),
      sessionId: s(r.session_id),
      seq: n(r.seq),
      speaker: s(r.speaker) as TranscriptRecord['speaker'],
      text: s(r.text),
      ts: n(r.ts),
    }));
  }

  /** Rebuild the full-text entry for one session. */
  reindexSession(id: string): void {
    const ses = this.getSession(id);
    this.db.run('DELETE FROM search_index WHERE session_id = ?', id);
    if (!ses) return;
    const answers = this.listAnswers({ sessionId: id });
    const transcript = this.listTranscript(id);
    const body = [ses.notes, ...answers.flatMap((a) => [a.questionText, a.answerText]), ...transcript.map((t) => t.text)].join('\n');
    this.db.run('INSERT INTO search_index (session_id, title, body) VALUES (?, ?, ?)', id, `${ses.title} ${ses.company} ${ses.jobTitle}`, body);
  }

  /* ---------------- misc ---------------- */

  saveBenchRun(provider: string | null, model: string | null, result: unknown): string {
    const id = uid('bench');
    this.db.run('INSERT INTO bench_runs (id, created_at, provider, model, result_json) VALUES (?, ?, ?, ?, ?)', id, Date.now(), provider, model, JSON.stringify(result));
    return id;
  }

  listBenchRuns(limit = 10): { id: string; createdAt: number; provider: string | null; model: string | null; result: unknown }[] {
    return this.db
      .all<Row>('SELECT * FROM bench_runs ORDER BY created_at DESC LIMIT ?', limit)
      .map((r) => ({ id: s(r.id), createdAt: n(r.created_at), provider: r.provider ? s(r.provider) : null, model: r.model ? s(r.model) : null, result: j(r.result_json, null) }));
  }

  counts(): { interviews: number; liveSessions: number; mockSessions: number; stories: number; answers: number } {
    const c = (sql: string) => n(this.db.get<Row>(sql)?.c);
    return {
      interviews: c('SELECT COUNT(*) AS c FROM interviews'),
      liveSessions: c("SELECT COUNT(*) AS c FROM sessions WHERE kind = 'live'"),
      mockSessions: c("SELECT COUNT(*) AS c FROM sessions WHERE kind IN ('mock','practice')"),
      stories: c('SELECT COUNT(*) AS c FROM stories'),
      answers: c('SELECT COUNT(*) AS c FROM answers'),
    };
  }

  /** Every table's rows except secrets, for the user-facing data export. */
  exportAll(): Record<string, unknown[]> {
    const tables = ['users', 'settings', 'providers', 'model_configs', 'resumes', 'interviews', 'job_descriptions', 'prep_sections', 'stories', 'questions', 'sessions', 'answers', 'transcripts', 'bench_runs'];
    const out: Record<string, unknown[]> = {};
    for (const t of tables) out[t] = this.db.all(`SELECT * FROM ${t}`);
    return out;
  }

  /** Delete all user data (keeps the schema). */
  purgeAll(): void {
    this.db.tx(() => {
      for (const t of ['transcripts', 'answers', 'sessions', 'prep_sections', 'job_descriptions', 'interviews', 'resumes', 'stories', 'questions', 'model_configs', 'providers', 'secrets', 'users', 'settings', 'bench_runs', 'search_index']) {
        this.db.run(`DELETE FROM ${t}`);
      }
    });
  }
}

/** Turn free text into a safe FTS5 query (prefix-matched, AND-combined). */
export function ftsQuery(input: string): string | null {
  const terms = input
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.slice(0, 8);
  if (!terms || terms.length === 0) return null;
  return terms.map((t) => `"${t}"*`).join(' AND ');
}

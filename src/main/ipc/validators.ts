import { z } from 'zod';
import type { RpcChannel } from '@shared/ipc';
import { LOCATION_PATTERN, PROJECT_ID_PATTERN } from '@shared/google';
import { HOTKEY_ACTIONS } from '@shared/settings';

/**
 * Every invoke channel has a schema. This is the trust boundary between the renderer and the main process:
 * strings are length-capped, enums are closed, and unknown keys are rejected.
 */
const id = z.string().min(1).max(80);
const text = (max: number) => z.string().max(max);
const mode = z.enum(['concise', 'standard', 'detailed', 'bullets', 'star', 'technical', 'followup']);
const category = z.enum(['behavioral', 'hr', 'technical', 'situational', 'role-specific', 'leadership', 'follow-up', 'management', 'analytics', 'operations', 'customer-service', 'sales', 'product', 'finance', 'marketing', 'software', 'data', 'case-study']);
const interviewType = z.enum(['general', 'hr', 'behavioral', 'technical', 'managerial', 'case-study', 'coding', 'customer-service', 'sales', 'analytics', 'operations', 'leadership']);
const feedbackTag = z.enum(['useful', 'not-useful', 'too-long', 'too-generic', 'incorrect', 'needs-detail']);
const sttProvider = z.enum(['deepgram', 'assemblyai', 'local']);
const cloudSttProvider = z.enum(['deepgram', 'assemblyai']);
const accelerator = z.string().min(1).max(60).regex(/^[A-Za-z0-9+_ ]+$/, 'Invalid shortcut');
const strList = (n: number, len = 200) => z.array(z.string().max(len)).max(n);
const taskRoute = z.object({ primary: z.string().max(80).nullable(), fallback: z.string().max(80).nullable() }).partial().strict();

const settingsPatch = z
  .object({
    theme: z.enum(['dark', 'light', 'system']),
    fontScale: z.number().min(0.8).max(1.6),
    highContrast: z.boolean(),
    reducedMotion: z.enum(['system', 'on', 'off']),
    defaultMode: mode,
    vadSensitivity: z.enum(['low', 'medium', 'high']),
    audio: z.object({ micDeviceId: z.string().max(300).nullable(), interviewerSource: z.enum(['system', 'mic']), transcribeMyVoice: z.boolean(), noiseSuppression: z.boolean(), echoCancellation: z.boolean(), autoGainControl: z.boolean() }).partial().strict(),
    stt: z.object({ provider: sttProvider, fallbackProvider: z.enum(['deepgram', 'assemblyai', 'local', 'none']), localModel: z.enum(['auto', 'accurate', 'light']), language: z.string().min(2).max(12), model: z.string().max(60), endpointingMs: z.number().int().min(50).max(3000), diarize: z.boolean() }).partial().strict(),
    live: z.object({ speculation: z.enum(['off', 'balanced', 'aggressive']), prewarm: z.boolean(), autoAnswer: z.boolean(), keepOnTop: z.boolean(), answerHoldMs: z.number().int().min(0).max(30_000), showDebugPanel: z.boolean(), consentAcceptedAt: z.number().nullable() }).partial().strict(),
    hotkeys: z.object(Object.fromEntries(HOTKEY_ACTIONS.map((a) => [a, accelerator])) as Record<(typeof HOTKEY_ACTIONS)[number], typeof accelerator>).partial().strict(),
    privacy: z.object({ storeTranscripts: z.boolean(), storeAnswers: z.boolean() }).partial().strict(),
    notifications: z.object({ toasts: z.boolean(), desktop: z.boolean() }).partial().strict(),
    routing: z.object({ live: taskRoute, prep: taskRoute, classify: taskRoute, mock: taskRoute }).partial().strict(),
    customInstructions: text(1200),
    onboarding: z.object({ completed: z.boolean(), step: z.number().int().min(0).max(20) }).partial().strict(),
  })
  .partial()
  .strict();

const profilePatch = z
  .object({
    name: text(120),
    summary: text(2000),
    skills: strList(60, 80),
    experience: text(4000),
    education: text(1000),
    preferredStyle: z.enum(['conversational', 'polished', 'direct']),
    preferredMode: mode,
    targetRoles: strList(20, 100),
    interviewPreferences: text(1500),
    extraFacts: strList(40, 400),
  })
  .partial()
  .strict();

const storyInput = z.object({
  id: id.optional(),
  title: z.string().min(1).max(160),
  situation: text(3000),
  task: text(3000),
  action: text(4000),
  result: text(3000),
  skills: strList(20, 60),
  roles: strList(20, 80),
  tags: strList(20, 40),
});

const googleAuth = z
  .object({
    mode: z.enum(['apiKey', 'adc']),
    backend: z.enum(['vertex', 'gemini-api']),
    project: z.string().max(80).regex(PROJECT_ID_PATTERN, 'That does not look like a Google Cloud project ID.'),
    location: z.string().max(40).regex(LOCATION_PATTERN, 'That does not look like a Google Cloud location (for example: global or us-central1).'),
  })
  .strict();

const providerSave = z.object({
  id: id.optional(),
  name: z.string().min(1).max(80),
  kind: z.enum(['openai-compatible', 'anthropic', 'google']),
  baseUrl: z.string().min(8).max(300),
  enabled: z.boolean(),
  apiKey: z.string().max(4096).optional(),
  google: googleAuth.optional(),
});

const modelSave = z.object({
  id: id.optional(),
  name: z.string().min(1).max(80),
  providerId: id,
  model: z.string().min(1).max(160),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(16).max(16000),
  topP: z.number().min(0).max(1).nullable(),
  timeoutMs: z.number().int().min(1000).max(180_000),
  streaming: z.boolean(),
});

const none = z.void().or(z.undefined());

export const validators: Record<RpcChannel, z.ZodType> = {
  'app.info': none,
  'app.activeProviders': none,
  'app.dashboard': none,
  'app.openExternal': z.object({ url: z.string().max(500) }).strict(),
  'app.openSystemSettings': z.object({ page: z.enum(['microphone', 'sound']) }).strict(),
  'app.setKeepOnTop': z.object({ value: z.boolean() }).strict(),
  'app.showNotification': z.object({ title: text(100), body: text(300) }).strict(),

  'settings.get': none,
  'settings.update': settingsPatch,
  'profile.get': none,
  'profile.update': profilePatch,
  'hotkeys.status': none,

  'providers.list': none,
  'providers.save': providerSave,
  'providers.delete': z.object({ id }).strict(),
  'providers.clearKey': z.object({ id }).strict(),
  'providers.listModels': z.object({ id }).strict(),
  'providers.checkAuth': z.object({ id }).strict(),
  'models.list': none,
  'models.save': modelSave,
  'models.delete': z.object({ id }).strict(),
  'models.test': z.object({ id }).strict(),
  'models.probe': z.object({ providerId: id, candidates: z.array(z.string().min(1).max(160)).min(1).max(8) }).strict(),
  'models.quickSetup': z.object({ providerId: id, fastModel: z.string().min(1).max(160), qualityModel: z.string().min(1).max(160) }).strict(),
  'stt.keys': none,
  'stt.setKey': z.object({ provider: cloudSttProvider, apiKey: z.string().min(1).max(4096) }).strict(),
  'stt.clearKey': z.object({ provider: cloudSttProvider }).strict(),
  'stt.test': z.object({ provider: sttProvider }).strict(),
  'stt.localStatus': none,
  'stt.warmup': none,

  'documents.pick': z.object({ purpose: z.enum(['resume', 'jd']) }).strict(),
  'documents.extract': z.object({ name: z.string().min(1).max(255), data: z.instanceof(ArrayBuffer).or(z.instanceof(Uint8Array)) }).strict(),
  'resumes.list': none,
  'resumes.get': z.object({ id }).strict(),
  'resumes.create': z.object({ name: z.string().min(1).max(255), source: z.enum(['pdf', 'docx', 'txt', 'paste']), text: z.string().min(20).max(150_000), useAi: z.boolean() }).strict(),
  'resumes.reparse': z.object({ id, useAi: z.boolean() }).strict(),
  'resumes.delete': z.object({ id }).strict(),

  'interviews.list': none,
  'interviews.get': z.object({ id }).strict(),
  'interviews.create': z.object({ jobTitle: text(160), company: text(160), interviewType, jobDescription: text(60_000), companyNotes: text(8000).optional(), interviewerInfo: text(2000).optional(), resumeId: id.nullable() }).strict(),
  'interviews.update': z.object({ id, patch: z.object({ jobTitle: text(160), company: text(160), interviewType, jobDescription: text(60_000), companyNotes: text(8000), interviewerInfo: text(2000), resumeId: id.nullable(), notes: text(8000) }).partial().strict() }).strict(),
  'interviews.delete': z.object({ id }).strict(),
  'interviews.analyze': z.object({ id, useAi: z.boolean() }).strict(),
  'prep.get': z.object({ interviewId: id }).strict(),
  'prep.generate': z.object({ interviewId: id, section: z.enum(['about', 'company', 'role', 'questions', 'all']) }).strict(),
  'prep.answer': z.object({ interviewId: id.nullable(), question: z.string().min(3).max(1500), mode, save: z.boolean() }).strict(),
  'prep.answers': z.object({ interviewId: id }).strict(),
  'gen.cancel': z.object({ requestId: id }).strict(),

  'stories.list': none,
  'stories.save': storyInput,
  'stories.delete': z.object({ id }).strict(),
  'stories.assist': z.object({ notes: z.string().min(10).max(6000) }).strict(),

  'questions.list': z.object({ search: text(200).optional(), category: category.optional(), favorite: z.boolean().optional() }).strict(),
  'questions.add': z.object({ text: z.string().min(5).max(500), category }).strict(),
  'questions.favorite': z.object({ id }).strict(),
  'questions.delete': z.object({ id }).strict(),
  'questions.practiced': z.object({ id }).strict(),

  'sessions.list': z.object({ kind: z.enum(['live', 'mock', 'practice']).optional(), search: text(200).optional() }).strict(),
  'sessions.get': z.object({ id }).strict(),
  'sessions.notes': z.object({ id, notes: text(20_000) }).strict(),
  'sessions.delete': z.object({ id }).strict(),
  'answers.edit': z.object({ id, text: z.string().min(1).max(8000) }).strict(),
  'answers.feedback': z.object({ id, tags: z.array(feedbackTag).max(6) }).strict(),

  'live.start': z.object({ interviewId: id.nullable(), audio: z.boolean() }).strict(),
  'live.stop': none,
  'live.pause': z.object({ paused: z.boolean() }).strict(),
  'live.question': z.object({ text: z.string().min(2).max(2000), mode: mode.optional() }).strict(),
  'live.answerNow': none,
  'live.regenerate': none,
  'live.mode': z.object({ mode }).strict(),
  'live.cycleMode': none,
  'live.shorter': none,
  'live.expand': none,
  'live.transform': z.object({ kind: z.enum(['conversational', 'add-detail']), addition: text(2000).optional() }).strict(),
  'live.followups': none,
  'live.feedback': z.object({ answerId: id.nullable(), tags: z.array(feedbackTag).max(6) }).strict(),
  'live.copy': none,
  'live.snapshot': none,
  'live.reportUi': z.object({ requestId: id, firstPaintMs: z.number().min(0).max(60_000) }).strict(),
  'live.debug': none,
  'audio.arm': z.object({ system: z.boolean() }).strict(),

  'mock.start': z.object({ interviewId: id.nullable(), questionCount: z.number().int().min(1).max(15), kind: z.enum(['mock', 'practice']), firstQuestion: text(600).optional() }).strict(),
  'mock.listen': z.object({ sessionId: id, on: z.boolean() }).strict(),
  'mock.answer': z.object({ sessionId: id, answer: text(8000), durationMs: z.number().min(0).max(3_600_000).nullable() }).strict(),
  'mock.finish': z.object({ sessionId: id }).strict(),
  'mock.summary': z.object({ sessionId: id }).strict(),

  'bench.run': z.object({ runs: z.number().int().min(1).max(30), mode }).strict(),
  'bench.history': none,
  'perf.get': none,

  'data.export': none,
  'data.purge': z.object({ scope: z.enum(['history', 'all']) }).strict(),
  'data.storage': none,
};

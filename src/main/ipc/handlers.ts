import { statSync } from 'node:fs';
import { AiError, isAiError } from '@shared/errors';
import type { Rpc, RpcChannel, RpcReq, RpcRes } from '@shared/ipc';
import { googleBaseUrl, isGoogleApiHost, usesAdc } from '@shared/google';
import { keyMismatch } from '@shared/keys';
import { endpointScope } from '@shared/net';
import { sttLabel, type SttTestResult } from '@shared/speech';
import type { ActiveModelInfo, ActiveRoute, CloudSttProviderId, Dashboard, GoogleAuthConfig, ProviderView, SttKeyView } from '@shared/types';
import { defang, median, uid } from '@shared/util';
import { isAllowedExternalUrl } from '../security/links';
import { STORY_ASSIST_SYSTEM } from '@prompts/index';
import { generateJson } from '../ai/structured';
import { isLocalUrl } from '../ai/gateway';
import { normalizeBase } from '../ai/providers/openai';
import { DocumentError, extractDocument } from '../documents/extract';
import { envGroupFor } from '../security/secrets';
import { runLocalSelfTest } from '../stt/local/selftest';
import { CLOUD_STT_PROVIDERS, resolveSttKey, sttKeyName } from '../stt/registry';
import { StoryDraftSchema } from '../services/schemas';
import type { Services } from '../services';

export type Handlers = { [K in RpcChannel]: (req: RpcReq<K>) => Promise<RpcRes<K>> | RpcRes<K> };

const ENV_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'DEEPGRAM_API_KEY', 'ASSEMBLYAI_API_KEY', 'STT_API_KEY'];

/** Providers must not send API keys in clear text across the internet: http is only allowed for local/private hosts. */
export function validateBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('The base URL is not a valid URL.');
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalUrl(u.toString()))) {
    throw new Error('Use an https:// URL. Plain http:// is only allowed for servers on this PC or your own network (for example Ollama, LM Studio, or a friend\'s machine over your LAN or Tailscale). For a server on the internet, put it behind https (a Cloudflare Tunnel or ngrok address works).');
  }
  if (u.username || u.password) throw new Error('Do not put credentials in the URL; use the API key field.');
  return u.toString().replace(/\/+$/, '');
}

/** Turn a document-parsing failure into a short user-facing error. */
function docError(err: unknown): Error {
  if (err instanceof DocumentError) return new Error(err.message);
  return err instanceof Error ? err : new Error('The file could not be read.');
}

export function createHandlers(s: Services): Handlers {
  const { repos, secrets, gateway, platform } = s;
  const signal = () => new AbortController().signal;

  const providerView = (id: string): ProviderView => {
    const p = repos.getProvider(id);
    if (!p) throw new Error('Provider not found.');
    const name = `provider.${p.id}`;
    const src = secrets.source(name, envGroupFor(p.kind, p.baseUrl));
    return { ...p, keySource: src, keyHint: src === 'stored' ? secrets.hint(name) : src === 'env' ? 'from environment' : null, keyOptional: isLocalUrl(p.baseUrl) || usesAdc(p), scope: endpointScope(p.baseUrl) };
  };
  const sttView = (provider: CloudSttProviderId): SttKeyView => {
    const src = secrets.source(sttKeyName(provider), provider);
    return { provider, keySource: src, keyHint: src === 'stored' ? secrets.hint(sttKeyName(provider)) : src === 'env' ? 'from environment' : null };
  };

  const requireInterview = (id: string) => {
    const i = repos.getInterview(id);
    if (!i) throw new Error('Interview not found.');
    return i;
  };

  const h: Handlers = {
    /* ------------------------------ app ------------------------------ */
    'app.info': () => {
      const p = platform.info();
      return {
        ...p,
        dbPath: s.db.path,
        dbSizeBytes: safeSize(s.db.path),
        envKeys: ENV_KEYS.filter((k) => !!s.opts.env[k]?.trim()),
        safeStorageAvailable: secrets.available,
      };
    },
    'app.activeProviders': () => {
      const info = (m: { provider: { name: string; kind: ProviderView['kind']; baseUrl: string }; model: { model: string } } | null): ActiveModelInfo | null =>
        m && { provider: m.provider.name, model: m.model.model, scope: endpointScope(m.provider.baseUrl), kind: m.provider.kind };
      const route = (task: 'live' | 'prep'): ActiveRoute => {
        try {
          const r = s.gateway.route(task);
          return { primary: info(r.primary), fallback: info(r.fallback), problem: r.primary ? null : 'No model is set up yet. Add a provider and choose a model in Settings → AI Providers.' };
        } catch (e) {
          return { primary: null, fallback: null, problem: e instanceof Error ? e.message : 'The model could not be resolved.' };
        }
      };
      const st = repos.getSettings().stt;
      const local = st.provider === 'local';
      const status = s.stt.local.status();
      return {
        live: route('live'),
        prep: route('prep'),
        speech: {
          provider: st.provider,
          label: sttLabel(st.provider),
          scope: local ? 'this-pc' : 'internet',
          detail: local ? status.modelLabel : 'Audio is streamed to this service while listening.',
        },
      };
    },
    'app.dashboard': (): Dashboard => {
      const c = repos.counts();
      const sessions = repos.listSessions({ limit: 50 });
      const ttfts = sessions.map((x) => x.stats?.ttftMedianMs).filter((v): v is number => typeof v === 'number');
      return {
        ...c,
        ttftMedianMs: median(ttfts),
        recentInterviews: repos.listInterviews().slice(0, 5),
        recentSessions: sessions.slice(0, 5),
      };
    },
    'app.openExternal': async ({ url }) => {
      if (!isAllowedExternalUrl(url)) throw new Error('That link is not on the list of allowed sites.');
      await platform.openExternal(url);
    },
    'app.openSystemSettings': ({ page }) => platform.openSystemSettings(page),
    'app.setKeepOnTop': ({ value }) => {
      repos.updateSettings({ live: { keepOnTop: value } });
      platform.setKeepOnTop(value);
    },
    'app.showNotification': ({ title, body }) => {
      if (repos.getSettings().notifications.desktop) platform.notify(title, body);
    },

    /* --------------------------- settings/profile --------------------------- */
    'settings.get': () => repos.getSettings(),
    'settings.update': (patch) => {
      const next = repos.updateSettings(patch);
      if (patch.hotkeys) platform.reregisterHotkeys();
      if (patch.live && 'keepOnTop' in patch.live && typeof patch.live.keepOnTop === 'boolean') platform.setKeepOnTop(patch.live.keepOnTop);
      return next;
    },
    'profile.get': () => repos.getProfile(),
    'profile.update': (patch) => repos.updateProfile(patch),
    'hotkeys.status': () => platform.hotkeyStatus(),

    /* --------------------------- providers/models --------------------------- */
    'providers.list': () => repos.listProviders().map((p) => providerView(p.id)),
    'providers.save': (req) => {
      // Only Google providers have a sign-in mode. "API key" is stored as no options at all (the pre-ADC behaviour).
      const google: GoogleAuthConfig | undefined = req.kind === 'google' && req.google?.mode === 'adc' ? req.google : undefined;
      const baseUrl = validateBaseUrl(req.baseUrl.trim() || (google ? googleBaseUrl(google) : ''));
      // A key pasted for the wrong service would be sent to that service. Catch the obvious mix-ups before saving anything.
      const mismatch = keyMismatch(req.kind, baseUrl, req.apiKey);
      if (mismatch) throw new Error(mismatch);
      // A Google access token is a bearer credential: it may only ever be sent to Google's own API hosts.
      if (google && !isGoogleApiHost(baseUrl)) throw new Error('Google sign-in can only be used with Google API addresses (…googleapis.com).');
      const saved = repos.saveProvider({ id: req.id, name: req.name.trim(), kind: req.kind, baseUrl, enabled: req.enabled, google });
      if (req.apiKey?.trim()) secrets.set(`provider.${saved.id}`, req.apiKey);
      gateway.resetGoogleAuth(); // a changed project or mode must not keep using cached credentials
      return providerView(saved.id);
    },
    'providers.delete': ({ id }) => {
      secrets.delete(`provider.${id}`);
      repos.deleteProvider(id);
    },
    'providers.clearKey': ({ id }) => {
      secrets.delete(`provider.${id}`);
      return providerView(id);
    },
    'providers.listModels': ({ id }) => gateway.listModels(id),
    'providers.checkAuth': ({ id }) => gateway.checkGoogleAuth(id),
    'models.list': () => repos.listModels(),
    'models.save': (req) => {
      if (!repos.getProvider(req.providerId)) throw new Error('Choose a provider first.');
      return repos.saveModel(req);
    },
    'models.delete': ({ id }) => repos.deleteModel(id),
    'models.test': ({ id }) => {
      const m = repos.getModel(id);
      if (!m) throw new Error('Model not found.');
      return gateway.testModel(m);
    },
    'models.probe': ({ providerId, candidates }) => gateway.probeModels(providerId, candidates),
    'models.quickSetup': ({ providerId, fastModel, qualityModel }) => {
      if (!repos.getProvider(providerId)) throw new Error('Provider not found.');
      // Running Quick setup again with the same models updates them instead of adding duplicates.
      const existing = (name: string) => repos.listModels().find((m) => m.providerId === providerId && m.name === name)?.id;
      const liveName = `Fast · ${fastModel}`;
      const prepName = `Quality · ${qualityModel}`;
      // A model on this PC or your own network runs on your hardware: measured on a 2019 laptop CPU, a 1.5-billion-parameter
      // model needs ~20 s to read a cold prompt and streams ~4 tokens/s, so a full answer takes a minute. It is given the time
      // (a stalled stream is still caught by the 15 s stall watchdog) instead of a cloud service's short deadline.
      const onOwnHardware = isLocalUrl(repos.getProvider(providerId)!.baseUrl);
      const live = repos.saveModel({ id: existing(liveName), name: liveName, providerId, model: fastModel, temperature: 0.4, maxTokens: 700, topP: null, timeoutMs: onOwnHardware ? 180_000 : 20_000, streaming: true });
      const prep = repos.saveModel({ id: existing(prepName), name: prepName, providerId, model: qualityModel, temperature: 0.3, maxTokens: 2800, topP: null, timeoutMs: onOwnHardware ? 600_000 : 90_000, streaming: true });
      const differ = live.id !== prep.id;
      repos.updateSettings({
        routing: {
          live: { primary: live.id, fallback: differ ? prep.id : null },
          prep: { primary: prep.id, fallback: differ ? live.id : null },
          classify: { primary: live.id, fallback: null },
          mock: { primary: prep.id, fallback: differ ? live.id : null },
        },
      });
      return { live, prep };
    },
    'stt.keys': () => CLOUD_STT_PROVIDERS.map(sttView),
    'stt.localStatus': () => s.stt.local.status(),
    'stt.warmup': async () => {
      await s.stt.local.ensureReady().catch(() => undefined); // a failure is part of the status returned below
      return s.stt.local.status();
    },
    'stt.setKey': ({ provider, apiKey }) => {
      secrets.set(sttKeyName(provider), apiKey);
      return sttView(provider);
    },
    'stt.clearKey': ({ provider }) => {
      secrets.delete(sttKeyName(provider));
      return sttView(provider);
    },
    'stt.test': async ({ provider }) => {
      const cfg = repos.getSettings().stt;
      if (provider === 'local') return runLocalSelfTest(s.stt.local, { samplePath: s.speechSample(), endpointingMs: cfg.endpointingMs });
      const key = resolveSttKey(secrets, provider);
      if (!key) return { ok: false, error: 'No API key is set for this provider.' };
      const t0 = performance.now();
      return new Promise<SttTestResult>((resolve) => {
        let settled = false;
        const finish = (r: SttTestResult) => {
          if (settled) return;
          settled = true;
          void stream.close().catch(() => undefined);
          resolve(r);
        };
        const stream = s.stt.provider(provider).open(
          { language: cfg.language, model: cfg.model, endpointingMs: cfg.endpointingMs, diarize: false, baseUrl: s.opts.sttUrls?.[provider] },
          key,
          {
            onTranscript: () => undefined,
            onState: (state, message) => {
              if (state === 'connected') finish({ ok: true, latencyMs: Math.round(performance.now() - t0) });
              else if (state === 'error') finish({ ok: false, error: message ?? 'Connection failed.' });
            },
          },
        );
        setTimeout(() => finish({ ok: false, error: 'The connection timed out.' }), 9000);
      });
    },

    /* ------------------------- documents / résumés ------------------------- */
    'documents.pick': async ({ purpose }) => {
      const file = await platform.pickFile(purpose);
      if (!file) return null;
      try {
        return await extractDocument(file.name, file.data);
      } catch (e) {
        throw docError(e);
      }
    },
    'documents.extract': async ({ name, data }) => {
      try {
        return await extractDocument(name, data instanceof Uint8Array ? data : new Uint8Array(data));
      } catch (e) {
        throw docError(e);
      }
    },
    'resumes.list': () => repos.listResumes(),
    'resumes.get': ({ id }) => {
      const r = repos.getResume(id);
      if (!r) throw new Error('Résumé not found.');
      return r;
    },
    'resumes.create': ({ name, source, text, useAi }) => s.analysis.createResume(name, source, text, { useAi, signal: signal() }),
    'resumes.reparse': ({ id, useAi }) => s.analysis.reparseResume(id, { useAi, signal: signal() }),
    'resumes.delete': ({ id }) => repos.deleteResume(id),

    /* ----------------------------- interviews ----------------------------- */
    'interviews.list': () => repos.listInterviews(),
    'interviews.get': ({ id }) => requireInterview(id),
    'interviews.create': (input) => repos.createInterview(input),
    'interviews.update': ({ id, patch }) => repos.updateInterview(id, patch),
    'interviews.delete': ({ id }) => repos.deleteInterview(id),
    'interviews.analyze': ({ id, useAi }) => s.analysis.analyzeInterview(requireInterview(id), { useAi, signal: signal() }),
    'prep.get': ({ interviewId }) => repos.getPrep(interviewId),
    'prep.generate': ({ interviewId, section }) => s.prep.generate(interviewId, section),
    'prep.answer': (req) => s.prep.answer(req),
    'prep.answers': ({ interviewId }) => repos.listAnswers({ interviewId, source: 'prepared' }),
    'gen.cancel': ({ requestId }) => s.prep.cancel(requestId),

    /* --------------------------- stories / questions --------------------------- */
    'stories.list': () => repos.listStories(),
    'stories.save': (req) => repos.saveStory(req),
    'stories.delete': ({ id }) => repos.deleteStory(id),
    'stories.assist': async ({ notes }) => {
      if (!s.aiAvailable('prep')) throw new AiError('not_configured', 'Set up an AI model to turn notes into a STAR story.', { retryable: false });
      const { value } = await generateJson(gateway, { task: 'prep', system: STORY_ASSIST_SYSTEM, user: `<notes>\n${defang(notes)}\n</notes>`, schema: StoryDraftSchema, maxTokens: 1200, signal: signal() });
      return { ...value, roles: [] };
    },
    'questions.list': (f) => repos.listQuestions(f),
    'questions.add': ({ text, category }) => {
      repos.addQuestions([{ text: text.trim(), category, source: 'user' }]);
      return repos.listQuestions({ search: text.trim().slice(0, 40), category });
    },
    'questions.favorite': ({ id }) => repos.toggleFavorite(id),
    'questions.delete': ({ id }) => repos.deleteQuestion(id),
    'questions.practiced': ({ id }) => repos.markPracticed(id),

    /* ----------------------------- history ----------------------------- */
    'sessions.list': (f) => repos.listSessions(f),
    'sessions.get': ({ id }) => {
      const d = repos.getSessionDetail(id);
      if (!d) throw new Error('Session not found.');
      return d;
    },
    'sessions.notes': ({ id, notes }) => repos.updateSessionNotes(id, notes),
    'sessions.delete': ({ id }) => repos.deleteSession(id),
    'answers.edit': ({ id, text }) => repos.editAnswer(id, text),
    'answers.feedback': ({ id, tags }) => repos.setAnswerFeedback(id, tags),

    /* ------------------------------- live ------------------------------- */
    'live.start': (req) => {
      s.mock.listen('', false).catch(() => undefined);
      return s.live.start(req);
    },
    'live.stop': () => s.live.stop(),
    'live.pause': ({ paused }) => s.live.setPaused(paused),
    'live.question': ({ text, mode }) => s.live.question(text, mode),
    'live.answerNow': () => s.live.answerNow(),
    'live.regenerate': () => s.live.regenerate(),
    'live.mode': ({ mode }) => s.live.setMode(mode),
    'live.cycleMode': () => s.live.cycleMode(),
    'live.shorter': () => s.live.shorter(),
    'live.expand': () => s.live.expand(),
    'live.transform': ({ kind, addition }) => s.live.transform(kind, addition),
    'live.followups': () => s.live.followups(),
    'live.feedback': ({ answerId, tags }) => s.live.feedback(answerId, tags),
    'live.copy': () => s.live.copy(),
    'live.snapshot': () => s.live.snapshot(),
    'live.reportUi': ({ firstPaintMs }) => s.live.reportUi(firstPaintMs),
    'live.debug': () => s.live.debug(),
    'audio.arm': ({ system }) => platform.setSystemAudioArmed(system),

    /* ------------------------------- mock ------------------------------- */
    'mock.start': (req) => s.mock.start(req, signal()),
    'mock.listen': async ({ sessionId, on }) => ({ sources: await s.mock.listen(sessionId, on) }),
    'mock.answer': (req) => s.mock.answer(req, signal()),
    'mock.finish': ({ sessionId }) => s.mock.finish(sessionId),
    'mock.summary': ({ sessionId }) => s.mock.summary(sessionId),

    /* ----------------------------- bench / perf ----------------------------- */
    'bench.run': ({ runs, mode }) => s.bench.run({ runs, mode, signal: signal() }),
    'bench.history': () => repos.listBenchRuns(10).map((b) => b.result as Rpc['bench.history']['res'][number]),
    'perf.get': () => ({ startupMs: platform.info().startupMs, uptimeS: Math.round(process.uptime()), memoryMB: platform.memoryMB() }),

    /* -------------------------------- data -------------------------------- */
    'data.export': async () => {
      const payload = { app: 'Candor', exportedAt: new Date().toISOString(), note: 'API keys are never included in exports.', data: repos.exportAll() };
      const path = await platform.saveFile(`candor-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2));
      return path ? { path } : null;
    },
    'data.purge': async ({ scope }) => {
      await s.live.stop().catch(() => undefined);
      if (scope === 'all') {
        repos.purgeAll();
        s.secrets.clearAll();
        s.live.clearCache();
      } else {
        for (const ses of repos.listSessions({ limit: 100_000 })) repos.deleteSession(ses.id);
        s.live.clearCache();
      }
    },
    'data.storage': () => ({ dbPath: s.db.path, dbBytes: safeSize(s.db.path) + safeSize(`${s.db.path}-wal`), logPath: platform.info().logPath, counts: repos.counts() }),
  };
  void uid;
  void normalizeBase;
  void isAiError;
  return h;
}

function safeSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

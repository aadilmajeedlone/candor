import { existsSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import type { AllPush } from '@shared/ipc';
import type { AppInfo, SttProviderId } from '@shared/types';
import type { HotkeyAction } from '@shared/settings';
import { AiGateway } from '../ai/gateway';
import type { CredentialSource } from '../ai/googleAuth';
import type { HttpClient } from '../ai/types';
import { Db } from '../db/database';
import { Repos } from '../db/repos';
import { migrateSettings } from '../db/settingsMigrations';
import { SEED_QUESTIONS } from '../db/seedQuestions';
import { log } from '../logging';
import { SecretStore, type Cipher } from '../security/secrets';
import { LocalSttHost, type WorkerPort } from '../stt/local/host';
import { modelSearchRoots, type Hardware, type LocalModelId, type LocalModelSpec } from '../stt/local/models';
import { spawnSpeechWorker } from '../stt/local/spawn';
import { createSttRegistry, type SttRegistry } from '../stt/registry';
import { AnalysisService } from './analysis';
import { BenchService } from './bench';
import { LiveService } from './live';
import { MockService } from './mock';
import { PrepService } from './prep';

export type PushEmit = <K extends keyof AllPush>(channel: K, payload: AllPush[K]) => void;

/** Everything that needs Electron, behind an interface so the handlers can be tested in plain Node. */
export interface PlatformBridge {
  pickFile(purpose: 'resume' | 'jd'): Promise<{ name: string; data: Uint8Array } | null>;
  openExternal(url: string): Promise<void>;
  openSystemSettings(page: 'microphone' | 'sound'): Promise<void>;
  setKeepOnTop(value: boolean): void;
  notify(title: string, body: string): void;
  saveFile(defaultName: string, contents: string): Promise<string | null>;
  writeClipboard(text: string): Promise<void>;
  info(): Pick<AppInfo, 'name' | 'version' | 'electron' | 'chrome' | 'node' | 'platform' | 'isPackaged' | 'userDataPath' | 'startupMs'> & { logPath: string };
  hotkeyStatus(): Record<HotkeyAction, { registered: boolean; accelerator: string }>;
  reregisterHotkeys(): void;
  setSystemAudioArmed(armed: boolean): void;
  memoryMB(): number;
}

/** Speech recognition on this PC. The defaults are right for the app; tests replace the worker and the model folders. */
export interface LocalSpeechOptions {
  createWorker?: () => WorkerPort;
  /** Folders that may contain the model folders (see `modelSearchRoots`). */
  modelRoots?: () => string[];
  hardware?: Hardware;
  numThreads?: number;
  idleUnloadMs?: number;
  loadTimeoutMs?: number;
  /** Model catalogue (tests use tiny files instead of hundreds of megabytes). */
  specs?: Record<LocalModelId, LocalModelSpec>;
}

export interface ServicesOptions {
  dbPath: string;
  cipher: Cipher;
  env: NodeJS.ProcessEnv;
  http: HttpClient;
  platform: PlatformBridge;
  emit: PushEmit;
  clock?: () => number;
  sttUrls?: Partial<Record<SttProviderId, string>>;
  /** Override where Google sign-in (ADC) comes from. Tests only. */
  googleCredentials?: CredentialSource;
  localSpeech?: LocalSpeechOptions;
}

export interface Services {
  db: Db;
  repos: Repos;
  secrets: SecretStore;
  gateway: AiGateway;
  /** Speech providers: the on-device engine and the optional cloud services. */
  stt: SttRegistry;
  /** The built-in sample clip used by "Test speech recognition", or null when it is not installed. */
  speechSample(): string | null;
  analysis: AnalysisService;
  prep: PrepService;
  live: LiveService;
  mock: MockService;
  bench: BenchService;
  platform: PlatformBridge;
  emit: PushEmit;
  opts: ServicesOptions;
  /** True when a live-answers (or preparation) model is configured. */
  aiAvailable(task?: 'live' | 'prep' | 'mock'): boolean;
  dispose(): Promise<void>;
}

export function createServices(opts: ServicesOptions): Services {
  const db = new Db(opts.dbPath);
  const repos = new Repos(db);
  const secrets = new SecretStore(db, opts.cipher, opts.env);
  migrateSettings(repos, secrets);
  const gateway = new AiGateway({ repos, secrets, http: opts.http, log: log('ai'), googleCredentials: opts.googleCredentials, notify: (level, message) => opts.emit('app.notice', { level, message }) });
  const clock = opts.clock ?? (() => performance.now());
  const emit = opts.emit;

  const speech = opts.localSpeech ?? {};
  const modelRoots = speech.modelRoots ?? (() => modelSearchRoots({ override: opts.env.CANDOR_STT_MODELS_DIR }));
  const stt = createSttRegistry(
    new LocalSttHost({
      createWorker: speech.createWorker ?? spawnSpeechWorker,
      roots: modelRoots,
      hardware: speech.hardware ?? { cores: cpus().length, totalMemGB: totalmem() / 2 ** 30 },
      preference: () => repos.getSettings().stt.localModel,
      endpointingMs: () => repos.getSettings().stt.endpointingMs,
      log: log('speech'),
      numThreads: speech.numThreads,
      idleUnloadMs: speech.idleUnloadMs,
      loadTimeoutMs: speech.loadTimeoutMs,
      specs: speech.specs,
    }),
  );
  const speechSample = (): string | null => modelRoots().map((r) => join(r, 'selftest.wav')).find((p) => existsSync(p)) ?? null;

  if (repos.countQuestions() === 0) {
    repos.addQuestions(Object.entries(SEED_QUESTIONS).flatMap(([category, qs]) => qs.map((text) => ({ text, category: category as keyof typeof SEED_QUESTIONS, source: 'seed' as const }))));
  }

  const aiAvailable = (task: 'live' | 'prep' | 'mock' = 'prep'): boolean => {
    try {
      return gateway.route(task).primary !== null;
    } catch {
      return false;
    }
  };

  const analysis = new AnalysisService({ repos, gateway, log: log('analysis') }, () => aiAvailable('prep'));
  const prep = new PrepService({
    repos,
    gateway,
    log: log('prep'),
    aiAvailable: () => aiAvailable('prep'),
    emitProgress: (p) => emit('prep.progress', p),
    emitGen: (e) => emit('gen.event', e),
    emitNotice: (level, message) => emit('app.notice', { level, message }),
  });
  const live = new LiveService({ repos, gateway, secrets, stt, emit: (e) => emit('live.event', e), clock, log: log('live'), writeClipboard: (t) => opts.platform.writeClipboard(t), sttUrls: opts.sttUrls });
  const mock = new MockService({ repos, gateway, secrets, stt, log: log('mock'), emit: (e) => emit('mock.event', e), aiAvailable: () => aiAvailable('mock'), sttUrls: opts.sttUrls });
  const bench = new BenchService({
    repos,
    gateway,
    emit: (done, total, ttft, total2, runId) => emit('bench.progress', { runId, done, total, lastTtftMs: ttft, lastTotalMs: total2 }),
    providerLabel: () => {
      try {
        const r = gateway.route('live').primary;
        return { provider: r?.provider.name ?? 'unconfigured', model: r?.model.model ?? '' };
      } catch {
        return { provider: 'unconfigured', model: '' };
      }
    },
  });

  return {
    db,
    repos,
    secrets,
    gateway,
    stt,
    speechSample,
    analysis,
    prep,
    live,
    mock,
    bench,
    platform: opts.platform,
    emit,
    opts,
    aiAvailable,
    async dispose() {
      prep.cancelAll();
      await live.stop().catch(() => undefined);
      await mock.listen('', false).catch(() => undefined);
      await stt.local.dispose().catch(() => undefined);
      db.close();
    },
  };
}

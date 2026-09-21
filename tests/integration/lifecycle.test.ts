import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeApp } from '../helpers/appHarness';
import { fakeSherpa, inProcessWorker, pcmFrame, tinyModelRoot, tinySpecs, type InProcessWorker } from '../helpers/fakeSherpa';

/**
 * Start-up, shutdown and persistence of the whole main process (the real services and IPC handlers, a real SQLite file):
 * settings and providers survive a restart, nothing heavy is loaded until it is needed, and closing the app while it is
 * listening releases the speech engine instead of leaving it running.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dataDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'candor-life-'));
  dirs.push(d);
  return d;
};
const speech = (workers: InProcessWorker[]) => {
  const root = tinyModelRoot();
  dirs.push(root);
  return { createWorker: () => (workers[workers.push(inProcessWorker(() => fakeSherpa({ chunkSamples: 640 }))) - 1]), modelRoots: () => [root], specs: tinySpecs, idleUnloadMs: 0 };
};
const until = async (fn: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('start-up', () => {
  it('opens quickly and loads nothing heavy: no speech engine until something needs it', async () => {
    const workers: InProcessWorker[] = [];
    const t0 = performance.now();
    const app = makeApp({ localSpeech: speech(workers) });
    const services = performance.now() - t0;
    try {
      expect(workers).toHaveLength(0); // no worker thread, no model
      expect((await app.call('stt.localStatus')).state).toBe('idle');
      expect((await app.call('app.info')).version).toBe('test');
      expect(services).toBeLessThan(3000); // database, migrations, seed questions
      expect((await app.call('settings.get')).stt.provider).toBe('local');
    } finally {
      await app.close();
    }
  });
});

describe('persistence across a restart', () => {
  it('settings, providers, models and routing come back; keys stay encrypted; the speech engine is idle again', async () => {
    const dir = dataDir();
    const first = makeApp({ dir, localSpeech: speech([]) });
    const provider = await first.call('providers.save', { name: "Friend's GPU", kind: 'openai-compatible', baseUrl: 'http://192.168.1.50:8000/v1', enabled: true, apiKey: 'friend-token-abcdef123456' });
    const model = await first.call('models.save', { name: 'Friend · qwen', providerId: provider.id, model: 'qwen2.5-32b-instruct', temperature: 0.3, maxTokens: 300, topP: null, timeoutMs: 30_000, streaming: true });
    await first.call('settings.update', { stt: { provider: 'local', localModel: 'light', endpointingMs: 450 }, defaultMode: 'concise', theme: 'light', routing: { live: { primary: model.id, fallback: null } } });
    await first.close({ keepData: true });

    const second = makeApp({ dir, localSpeech: speech([]) });
    try {
      const s = await second.call('settings.get');
      expect(s).toMatchObject({ theme: 'light', defaultMode: 'concise', stt: { provider: 'local', localModel: 'light', endpointingMs: 450 } });
      expect(s.routing.live.primary).toBe(model.id);
      const providers = await second.call('providers.list');
      expect(providers).toHaveLength(1);
      expect(providers[0]).toMatchObject({ name: "Friend's GPU", scope: 'private-network', keySource: 'stored', keyHint: '…3456' });
      expect(JSON.stringify(providers)).not.toContain('friend-token');
      expect((await second.call('app.activeProviders')).live.primary).toMatchObject({ provider: "Friend's GPU", model: 'qwen2.5-32b-instruct' });
      expect((await second.call('stt.localStatus')).state).toBe('idle');
      // the seeded question bank was not duplicated by the second start
      expect((await second.call('questions.list', {})).length).toBeGreaterThan(120);
      expect((await second.call('questions.list', {})).length).toBeLessThan(400);
    } finally {
      await second.close();
    }
  });
});

describe('upgrading an installation that predates on-device speech', () => {
  /** Simulate the old build: the complete settings object was saved with the cloud default, and no migration had run. */
  const asOldInstall = async (dir: string, stt: Record<string, unknown>) => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(dir, 'candor.db'));
    const row = db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string } | undefined;
    const app = { ...(row ? (JSON.parse(row.value) as Record<string, unknown>) : {}), stt };
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('app', ?, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(app));
    db.prepare("DELETE FROM settings WHERE key LIKE 'flag.%'").run();
    db.close();
  };
  const oldStt = { provider: 'deepgram', fallbackProvider: 'none', language: 'en', model: 'nova-3', endpointingMs: 300, diarize: false };

  it('an old cloud default that never had a key becomes the free on-device engine, once', async () => {
    const dir = dataDir();
    await makeApp({ dir, localSpeech: speech([]) }).close({ keepData: true }); // creates the database
    await asOldInstall(dir, oldStt);
    const upgraded = makeApp({ dir, localSpeech: speech([]) });
    expect((await upgraded.call('settings.get')).stt.provider).toBe('local');
    await upgraded.call('settings.update', { stt: { provider: 'assemblyai' } }); // the owner later chooses a cloud engine on purpose
    await upgraded.close({ keepData: true });
    const again = makeApp({ dir, localSpeech: speech([]) });
    try {
      expect((await again.call('settings.get')).stt.provider).toBe('assemblyai'); // the migration does not run twice
    } finally {
      await again.close();
    }
  });

  it('a cloud speech provider that has a key is a deliberate choice and is kept', async () => {
    const dir = dataDir();
    const first = makeApp({ dir, localSpeech: speech([]) });
    await first.call('stt.setKey', { provider: 'deepgram', apiKey: 'dg-owner-key-123456' });
    await first.close({ keepData: true });
    await asOldInstall(dir, oldStt);
    const upgraded = makeApp({ dir, localSpeech: speech([]) });
    try {
      expect((await upgraded.call('settings.get')).stt.provider).toBe('deepgram');
      expect((await upgraded.call('stt.keys')).find((k) => k.provider === 'deepgram')?.keySource).toBe('stored');
    } finally {
      await upgraded.close();
    }
  });

  it('a fresh installation just gets the on-device default', async () => {
    const app = makeApp({ localSpeech: speech([]) });
    try {
      expect((await app.call('settings.get')).stt.provider).toBe('local');
    } finally {
      await app.close();
    }
  });
});

describe('shutdown', () => {
  it('closing the app while it is listening releases the speech engine promptly and cleanly', async () => {
    const workers: InProcessWorker[] = [];
    const app = makeApp({ localSpeech: speech(workers) });
    await app.call('settings.update', { live: { consentAcceptedAt: Date.now() }, audio: { interviewerSource: 'mic' }, stt: { localModel: 'light' } });
    const start = await app.call('live.start', { interviewId: null, audio: true });
    expect(start.sttConfigured).toBe(true);
    await until(() => workers.length === 1 && workers[0].received.some((m) => m.t === 'open'));
    for (let i = 0; i < 10; i++) app.services.live.audio('mic', pcmFrame('speech'));
    const t0 = performance.now();
    await app.close(); // as the window closes: live session stopped, streams closed, engine released, database closed
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(workers[0].terminated).toBe(true);
  });

  it('stopping a session leaves the loaded model ready for the next one, and closing the app then frees it', async () => {
    const workers: InProcessWorker[] = [];
    const app = makeApp({ localSpeech: speech(workers) });
    await app.call('settings.update', { live: { consentAcceptedAt: Date.now() }, audio: { interviewerSource: 'mic' } });
    await app.call('live.start', { interviewId: null, audio: true });
    await until(() => workers.length === 1 && workers[0].received.some((m) => m.t === 'open'));
    await app.call('live.stop');
    expect((await app.call('stt.localStatus')).state).toBe('ready'); // kept for the next question session
    await app.call('live.start', { interviewId: null, audio: true });
    await until(() => workers[0].received.filter((m) => m.t === 'open').length === 2);
    expect(workers).toHaveLength(1); // the same engine, not a reload
    await app.call('live.stop');
    await app.close();
    expect(workers[0].terminated).toBe(true);
  });
});

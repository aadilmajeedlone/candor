import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { chromium, expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SHOTS } from './helpers';

/**
 * Launches the *packaged* executable (the exact artifact users get: hardened fuses, asar integrity, custom
 * protocol, production CSP) and drives its window over the Chromium DevTools protocol.
 *
 * Build it first with `npm run dist:dir`. Point CANDOR_EXE at another location (e.g. an installed copy) to test that.
 */
const EXE = process.env.CANDOR_EXE ?? resolve('release', 'win-unpacked', 'Candor.exe');
const PORT = 9333;

test.describe('packaged app', () => {
  test.skip(!existsSync(EXE), `no packaged build at ${EXE} — run "npm run dist:dir" first`);

  test('the executable is hardened with Electron fuses', async () => {
    const wire = await getCurrentFuseWire(EXE);
    expect(wire[FuseV1Options.RunAsNode], 'RunAsNode').toBe(FuseState.DISABLE);
    expect(wire[FuseV1Options.EnableNodeOptionsEnvironmentVariable], 'NODE_OPTIONS').toBe(FuseState.DISABLE);
    expect(wire[FuseV1Options.EnableNodeCliInspectArguments], '--inspect').toBe(FuseState.DISABLE);
    expect(wire[FuseV1Options.OnlyLoadAppFromAsar], 'only load from asar').toBe(FuseState.ENABLE);
    expect(wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], 'asar integrity').toBe(FuseState.ENABLE);
    expect(wire[FuseV1Options.GrantFileProtocolExtraPrivileges], 'file:// privileges').toBe(FuseState.DISABLE);
  });

  test('starts, is hardened, and works with an empty profile', async () => {
    mkdirSync(SHOTS, { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), 'candor-pkg-'));
    const t0 = Date.now();
    const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
      // No Google credentials anywhere (a path that does not exist), so the sign-in check below is deterministic.
      env: { ...process.env, CANDOR_USER_DATA: dir, CANDOR_LOG_LEVEL: 'warn', GOOGLE_APPLICATION_CREDENTIALS: join(dir, 'no-such-adc.json'), METADATA_SERVER_DETECTION: 'none' },
      stdio: 'ignore',
      windowsHide: false,
    });
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    try {
      // Wait for the DevTools endpoint: this is the time until Chromium is up and serving.
      let up = false;
      for (let i = 0; i < 200 && !up; i++) {
        up = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.ok, () => false);
        if (!up) await new Promise((r) => setTimeout(r, 100));
      }
      expect(up, 'the packaged app never opened its debugging endpoint (did it crash on start?)').toBe(true);

      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
      const page = browser.contexts()[0].pages()[0];
      await page.waitForSelector('#root *', { timeout: 20_000 });
      const interactiveMs = Date.now() - t0;

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      // The renderer is untrusted-by-default: no Node, only the typed bridge.
      const probe = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        hasApi: typeof (window as unknown as { api?: unknown }).api,
        node: [typeof (window as unknown as { require?: unknown }).require, typeof (window as unknown as { process?: unknown }).process],
      }));
      expect(probe.url.startsWith('candor://app/')).toBe(true);
      expect(probe.hasApi).toBe('object');
      expect(probe.node).toEqual(['undefined', 'undefined']);

      const info = await page.evaluate(() => (window as unknown as { api: { invoke: (c: string) => Promise<Record<string, unknown>> } }).api.invoke('app.info'));
      expect(info.isPackaged).toBe(true);
      expect(String(info.userDataPath)).toBe(dir); // the override is honoured; nothing touches the real profile
      const settings = await page.evaluate(() => (window as unknown as { api: { invoke: (c: string) => Promise<{ theme: string }> } }).api.invoke('settings.get'));
      expect(settings.theme).toBe('dark'); // SQLite (node:sqlite) works inside the packaged app

      // Production CSP: the page cannot reach the network directly.
      const blocked = await page.evaluate(() => fetch('https://example.com/').then(() => 'reached', () => 'blocked'));
      expect(blocked).toBe('blocked');

      // Google sign-in (ADC) works inside the packaged app: Google's auth library is bundled, and with no credentials
      // the app explains exactly what to do instead of failing obscurely.
      interface Api {
        api: { invoke: (channel: string, payload?: unknown) => Promise<{ id?: string; google?: { mode: string }; problem?: { code: string; steps: string[] } }> };
      }
      const google = await page.evaluate(async () => {
        const { api } = window as unknown as Api;
        const saved = await api.invoke('providers.save', { name: 'Google (ADC)', kind: 'google', baseUrl: 'https://aiplatform.googleapis.com', enabled: true, google: { mode: 'adc', backend: 'vertex', project: 'my-test-project', location: 'global' } });
        const status = await api.invoke('providers.checkAuth', { id: saved.id });
        return { mode: saved.google?.mode, code: status.problem?.code, steps: status.problem?.steps.join(' ') };
      });
      expect(google.mode).toBe('adc');
      expect(google.code).toBe('adc_missing');
      expect(google.steps).toContain('gcloud auth application-default login');

      // Let the first screen settle, then read the numbers the app itself reports (memory = every Electron process).
      await page.waitForTimeout(1500);
      const perf = await page.evaluate(() => (window as unknown as { api: { invoke: (c: string) => Promise<{ startupMs: number; memoryMB: number }> } }).api.invoke('perf.get'));
      await page.screenshot({ path: join(SHOTS, '90-packaged-first-run.png') });
      console.log(`PACKAGED: interactive ${interactiveMs} ms after process start (includes Chromium boot); main-process window-ready ${perf.startupMs} ms; memory ${perf.memoryMB} MB across all processes; version ${String(info.version)}, electron ${String(info.electron)}`);
      expect(errors).toEqual([]);
      await browser.close();
    } finally {
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('speech recognition runs on this PC inside the packaged app (worker thread + native library + bundled model)', async () => {
    const resources = join(dirname(EXE), 'resources');
    // What the installer ships: the models beside the archive, and the worker + native library unpacked from it.
    expect(existsSync(join(resources, 'models', 'stt', 'x-asr-160', 'encoder.int8.onnx')), 'accurate model bundled').toBe(true);
    expect(existsSync(join(resources, 'models', 'stt', 'zipformer-en-70m', 'tokens.txt')), 'light model bundled').toBe(true);
    expect(existsSync(join(resources, 'models', 'stt', 'selftest.wav')), 'self-test sample bundled').toBe(true);
    expect(existsSync(join(resources, 'app.asar.unpacked', 'out', 'main', 'sttWorker.js')), 'worker script unpacked').toBe(true);
    expect(existsSync(join(resources, 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-win-x64', 'sherpa-onnx.node')), 'native add-on unpacked').toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'candor-pkg-speech-'));
    const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { env: { ...process.env, CANDOR_USER_DATA: dir, CANDOR_LOG_LEVEL: 'warn' }, stdio: 'ignore', windowsHide: false });
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    try {
      let up = false;
      for (let i = 0; i < 200 && !up; i++) {
        up = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.ok, () => false);
        if (!up) await new Promise((r) => setTimeout(r, 100));
      }
      expect(up).toBe(true);
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
      const page = browser.contexts()[0].pages()[0];
      await page.waitForSelector('#root *', { timeout: 20_000 });

      interface SpeechApi {
        api: { invoke: (channel: string, payload?: unknown) => Promise<Record<string, unknown>> };
      }
      // Nothing is loaded until it is needed.
      const before = await page.evaluate(() => (window as unknown as SpeechApi).api.invoke('stt.localStatus'));
      expect(before.state).toBe('idle');
      // Loading the model in the worker thread: the first use.
      const loaded = await page.evaluate(() => (window as unknown as SpeechApi).api.invoke('stt.warmup'));
      expect(loaded.state, String(loaded.message)).toBe('ready');
      // The built-in test: the sample goes through the same path live audio takes.
      const test = await page.evaluate(() => (window as unknown as SpeechApi).api.invoke('stt.test', { provider: 'local' }));
      expect(test.ok, String(test.error)).toBe(true);
      expect(String(test.detail)).toContain('Heard: “After early nightfall the yellow lamps');
      const perf = await page.evaluate(() => (window as unknown as SpeechApi).api.invoke('perf.get'));
      console.log(`PACKAGED SPEECH: ${String(loaded.modelLabel)} loaded in ${String(loaded.loadMs)} ms; first words ${String(test.latencyMs)} ms into the sample; ${String(perf.memoryMB)} MB across all processes. ${String(test.detail)}`);
      await browser.close();
    } finally {
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Launched {
  app: ElectronApplication;
  page: Page;
  dir: string;
  errors: string[];
  close(): Promise<void>;
}

export const SHOTS = resolve('test-results', 'screens');

/** Start the built app with an isolated user-data folder. Renderer console errors are collected. */
export async function launch(env: Record<string, string> = {}, width = 1440, height = 900, extraArgs: string[] = []): Promise<Launched> {
  mkdirSync(SHOTS, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'candor-e2e-'));
  const app = await electron.launch({ args: [resolve('.'), ...extraArgs], env: { ...process.env, CANDOR_USER_DATA: dir, CANDOR_LOG_LEVEL: 'warn', ...env } });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await app.evaluate(({ BrowserWindow }, size) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) {
      w.setSize(size.width, size.height);
      w.center();
    }
  }, { width, height });
  await page.waitForLoadState('domcontentloaded');
  return {
    app,
    page,
    dir,
    errors,
    async close() {
      await app.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function shot(page: Page, name: string): Promise<string> {
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path });
  return path;
}

/** Call a main-process channel from the page exactly as the UI does. */
export function invoke<T = unknown>(page: Page, channel: string, payload?: unknown): Promise<T> {
  return page.evaluate(([c, p]) => (window as unknown as { api: { invoke: (c: string, p?: unknown) => Promise<unknown> } }).api.invoke(c, p), [channel, payload] as const) as Promise<T>;
}

/**
 * Resize the real window so the page is genuinely laid out at width x height CSS pixels (Electron's
 * enableDeviceEmulation only changes the capture area, not the layout). Asserts it took effect.
 */
export async function setViewport(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setMinimumSize(320, 320);
    w.setContentSize(s.width, s.height);
  }, { width, height });
  const deadline = Date.now() + 5000;
  let dims: number[] = [];
  while (Date.now() < deadline) {
    dims = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
    if (dims[0] === width && dims[1] === height) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`viewport did not become ${width}x${height} (got ${dims.join('x')})`);
}

export async function restoreViewport(app: ElectronApplication, page: Page): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setMinimumSize(1100, 680);
    w.setContentSize(1440, 900);
  });
  await page.waitForTimeout(200);
}

import { expect, test } from '@playwright/test';
import { launch, shot } from './helpers';

test('app boots, is hardened, and shows onboarding on first run', async () => {
  const l = await launch();
  try {
    const { page, app } = l;
    await expect(page.getByRole('dialog', { name: 'Setup guide' })).toBeVisible();
    await expect(page.getByText('Let’s get you set up.')).toBeVisible();
    await shot(page, '01-onboarding');

    // Security posture of the real window.
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      const p = (wc as unknown as { getLastWebPreferences(): { contextIsolation: boolean; nodeIntegration: boolean; sandbox: boolean; webSecurity: boolean } }).getLastWebPreferences();
      return { contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, sandbox: p.sandbox, webSecurity: p.webSecurity, url: wc.getURL() };
    });
    expect(prefs).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true });
    expect(prefs.url).toBe('candor://app/index.html');

    // The renderer has no Node / Electron access and only the typed bridge.
    const globals = await page.evaluate(() => ({ require: typeof (window as unknown as { require?: unknown }).require, process: typeof (window as unknown as { process?: unknown }).process, api: Object.keys((window as unknown as { api: object }).api).sort() }));
    expect(globals.require).toBe('undefined');
    expect(globals.process).toBe('undefined');
    expect(globals.api).toEqual(['invoke', 'on', 'sendAudio']);

    // CSP is enforced: inline script and remote fetches are blocked.
    const csp = await page.evaluate(async () => {
      const res = await fetch(location.href);
      const header = res.headers.get('content-security-policy');
      let remote = 'allowed';
      try {
        await fetch('https://example.com/');
      } catch {
        remote = 'blocked';
      }
      return { header, remote };
    });
    expect(csp.header).toContain("default-src 'self'");
    expect(csp.remote).toBe('blocked');

    // The typed bridge works and validation rejects garbage.
    const info = await page.evaluate(() => (window as unknown as { api: { invoke: (c: string) => Promise<{ name: string; safeStorageAvailable: boolean; isPackaged: boolean }> } }).api.invoke('app.info'));
    expect(info.name).toBeTruthy();
    expect(info.safeStorageAvailable).toBe(true);
    const bad = await page.evaluate(() => (window as unknown as { api: { invoke: (c: string, p: unknown) => Promise<unknown> } }).api.invoke('settings.update', { theme: 'neon' }).then(() => 'accepted', (e: Error) => e.message));
    expect(bad).toMatch(/Invalid request/);
    // Any other console error is a real bug. The only ones allowed are the CSP reports this test provoked on purpose.
    await page.waitForTimeout(300);
    const unexpected = l.errors.filter((e) => !e.includes('https://example.com/'));
    expect(unexpected, unexpected.join('\n')).toEqual([]);
  } finally {
    await l.close();
  }
});

test('skipping setup reveals the dashboard and every screen renders without errors', async () => {
  const l = await launch();
  try {
    const { page } = l;
    await page.getByRole('button', { name: 'Skip setup' }).click();
    await expect(page.getByRole('heading', { level: 1 }).first()).toContainText(/Good|Still up/);
    await shot(page, '02-dashboard');

    for (const [label, heading] of [
      ['Interviews', /Every interview, prepared/],
      ['Preparation', /Create an interview first/],
      ['Live Interview', /Ready when you are/],
      ['Mock Interview', /Rehearse out loud/],
      ['Question Bank', /Practise the questions/],
      ['Story Bank', /Your best examples/],
      ['History', /Every session, searchable/],
      ['Settings', /General/],
    ] as const) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await expect(page.getByText(heading).first()).toBeVisible();
      await shot(page, `03-${label.toLowerCase().replace(/\s+/g, '-')}`);
    }
    expect(l.errors, l.errors.join('\n')).toEqual([]);
  } finally {
    await l.close();
  }
});

import { chromium, expect, test, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { JD_TEXT, RESUME_TEXT } from '../fixtures/documents';
import { respond } from '../helpers/llmScript';
import { MockLlmServer } from '../helpers/mockLlmServer';
import { invoke, launch, shot } from './helpers';

/**
 * “About me” in the real app, through the real UI, when the model misbehaves. The failure that started this: a reply
 * cut off mid-string surfaced as “The model returned an unusable reply twice (unterminated JSON object)”. Here the same
 * kinds of trouble are served by a mock model over real HTTP, and what the person sees is checked.
 */

const ABOUT = {
  tellMeAboutYourself: 'I am an operations manager with seven years in logistics customer support, and for the last three years I have run a 40-person operation at Northwind Logistics.',
  professionalSummary: 'Operations manager with seven years of experience leading customer support teams in logistics.',
  careerJourney: 'I began as a support agent at Contoso BPO, became a team lead, and now run operations at Northwind Logistics.',
  currentRole: 'At Northwind Logistics I manage 14 support agents and three team leads.',
  strengths: ['Process redesign', 'People leadership', 'Data fluency', 'Coaching'],
  relevantExperience: ['Ran a 40-person operation', 'Cut handling time by 22 percent', 'Built Power BI reporting for leadership'],
};
const ABOUT_JSON = JSON.stringify(ABOUT);

/**
 * Run against the development bundle by default. `ABOUT_E2E_MODE=packaged` runs the very same scenarios against the
 * packaged executable (hardened fuses, asar, production CSP) — the artifact people install — over the DevTools protocol.
 */
const PACKAGED = process.env.ABOUT_E2E_MODE === 'packaged';
const EXE = process.env.CANDOR_EXE ?? resolve('release', 'win-unpacked', 'Candor.exe');
const PORT = 9337;

interface Started {
  page: Page;
  dir: string;
  errors: string[];
  close(): Promise<void>;
}

async function startApp(env: Record<string, string>): Promise<Started> {
  if (!PACKAGED) return launch(env, 1440, 900);
  const dir = mkdtempSync(join(tmpdir(), 'candor-about-pkg-'));
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { env: { ...process.env, CANDOR_USER_DATA: dir, CANDOR_LOG_LEVEL: 'warn', ...env }, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.ok, () => false);
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  expect(up, 'the packaged app never opened its debugging endpoint').toBe(true);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = browser.contexts()[0]?.pages()[0];
  await page.waitForSelector('#root *', { timeout: 20_000 });
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return {
    page,
    dir,
    errors,
    async close() {
      await browser.close().catch(() => undefined);
      child.kill();
      await new Promise((r) => setTimeout(r, 500));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let llm: MockLlmServer;
let l: Started;
let page: Page;

/** Answer About prompts with `about`; everything else with the shared script. */
const withAbout = (about: (body: Record<string, unknown> | null) => string) => (body: Record<string, unknown> | null): string => {
  const system = ((body?.messages as { role: string; content: string }[] | undefined) ?? []).find((m) => m.role === 'system')?.content ?? '';
  return /interview preparation material/.test(system) || /Tell me about yourself/.test(system) ? about(body) : respond(body);
};

const openAbout = async () => {
  await page.getByRole('tab', { name: 'About me' }).click();
};
const logFile = () => join(l.dir, 'logs', 'candor.log');
const debugFile = () => join(l.dir, 'logs', 'ai-debug.jsonl');

test.describe.serial(`“About me” through the real UI (${PACKAGED ? 'packaged app' : 'development build'})`, () => {
  test.skip(PACKAGED && !existsSync(EXE), `no packaged build at ${EXE}`);
  test.beforeAll(async () => {
    llm = await new MockLlmServer().start();
    l = await startApp({ CANDOR_LOG_LEVEL: 'info', CANDOR_DEBUG_AI: '1' });
    page = l.page;
    await page.getByRole('button', { name: 'Skip setup' }).click();
    // Set the app up through the same channels the Settings screen uses.
    const provider = await invoke<{ id: string }>(page, 'providers.save', { name: 'Mock OpenAI', kind: 'openai-compatible', baseUrl: llm.openaiUrl, enabled: true, apiKey: 'sk-e2e-secret-key-1234567890' });
    await invoke(page, 'models.quickSetup', { providerId: provider.id, fastModel: 'gpt-4o-mini', qualityModel: 'gpt-4.1' });
    const resume = await invoke<{ id: string }>(page, 'resumes.create', { name: 'cv.txt', source: 'txt', text: RESUME_TEXT, useAi: false });
    await invoke(page, 'interviews.create', { jobTitle: 'Operations Manager', company: 'Contoso', interviewType: 'operations', jobDescription: JD_TEXT, resumeId: resume.id });
    await page.getByRole('button', { name: 'Preparation', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 }).first()).toContainText('Operations Manager');
  });
  test.afterAll(async () => {
    await l?.close();
    await llm?.stop();
  });
  test.beforeEach(() => llm.reset());

  test('a reply wrapped in a code fence and chatty text is shown, with no error and no extra request', async () => {
    llm.openai.dynamic = withAbout(() => 'Sure! Here is your material:\n```json\n' + ABOUT_JSON + '\n```\nGood luck with the interview!');
    await openAbout();
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
    await expect(page.getByText(ABOUT.tellMeAboutYourself)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Process redesign')).toBeVisible();
    await expect(page.getByText(/Could not generate/)).toHaveCount(0);
    await expect(page.getByText(/Generated by gpt-4\.1/)).toBeVisible();
    expect(llm.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    await shot(page, '20-about-fenced');
  });

  test('a reply that was cut off is asked again in a shorter form, the person is told, and the section still fills in', async () => {
    llm.openai.script = [{ text: ABOUT_JSON.slice(0, 160), finishReason: 'length' }, { text: ABOUT_JSON }];
    await page.getByRole('button', { name: /Regenerate/ }).click();
    await expect(page.locator('.toasts')).toContainText(/cut off/, { timeout: 20_000 });
    await expect(page.getByText(ABOUT.professionalSummary)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Could not generate/)).toHaveCount(0);
    const posts = llm.requests.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(2);
    const budget = (i: number) => (posts[i]?.body as { max_tokens: number }).max_tokens;
    expect(budget(1)).toBeGreaterThan(budget(0)); // the second request is not the first one again
    await shot(page, '21-about-after-cutoff');
  });

  test('when no usable reply can be had, the page shows an offline draft with a clear note — and Regenerate brings the AI text back', async () => {
    llm.openai.dynamic = withAbout(() => 'I am sorry, I cannot help with that.');
    await page.getByRole('button', { name: /Regenerate/ }).click();
    // the note sits in the page itself (the same words also appear once as a message in the corner)
    const note = page.locator('.notice').filter({ hasText: /offline draft built from your résumé/ });
    await expect(note).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.toasts')).toContainText(/offline draft/);
    await expect(page.getByText(/Offline draft \(no AI\)/)).toBeVisible();
    await expect(page.getByText(/Could not generate/)).toHaveCount(0);
    await expect(page.getByText(/Northwind Logistics/).first()).toBeVisible(); // real résumé facts, not invented ones
    await shot(page, '22-about-offline-draft');

    llm.reset();
    llm.openai.dynamic = withAbout(() => ABOUT_JSON);
    await page.getByRole('button', { name: /Regenerate/ }).click();
    await expect(page.getByText(ABOUT.tellMeAboutYourself)).toBeVisible({ timeout: 20_000 });
    await expect(note).toHaveCount(0);
    await expect(page.getByText(/Generated by gpt-4\.1/)).toBeVisible();
  });

  test('a provider problem is shown as an error with a working “Try again” — it is not disguised as a draft', async () => {
    llm.openai.dynamic = withAbout(() => ABOUT_JSON);
    llm.openai.requireKey = 'sk-a-different-key-000000';
    await page.getByRole('button', { name: /Regenerate/ }).click();
    const failure = page.getByRole('alert').filter({ hasText: /Could not generate/ });
    await expect(failure).toBeVisible({ timeout: 20_000 });
    await expect(failure).toContainText(/API key/i);
    await expect(failure).not.toContainText(/unterminated|JSON/i);
    await shot(page, '23-about-provider-error');

    llm.openai.requireKey = undefined;
    await failure.getByRole('button', { name: /Try again/ }).click();
    await expect(page.getByText(ABOUT.careerJourney)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Could not generate/)).toHaveCount(0);
  });

  test('the window stays responsive while the model is slow', async () => {
    llm.openai.dynamic = withAbout(() => ABOUT_JSON);
    llm.openai.firstTokenDelayMs = 3500;
    await page.getByRole('button', { name: /Regenerate/ }).click();
    await expect(page.locator('.progress')).toBeVisible();

    // frames keep being painted, and a click is answered promptly, while the request is in flight
    const frames = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let n = 0;
          const t0 = performance.now();
          const tick = () => {
            n++;
            if (performance.now() - t0 < 1000) requestAnimationFrame(tick);
            else resolve(n);
          };
          requestAnimationFrame(tick);
        }),
    );
    expect(frames).toBeGreaterThan(20);
    const t0 = Date.now();
    await page.getByRole('tab', { name: 'Role' }).click();
    await expect(page.getByRole('tab', { name: 'Role' })).toHaveAttribute('aria-selected', 'true');
    expect(Date.now() - t0).toBeLessThan(1500);
    await openAbout();
    await expect(page.getByText(ABOUT.tellMeAboutYourself)).toBeVisible({ timeout: 25_000 });
  });

  test('what the app wrote to its own files: enough to diagnose, and never a key, a prompt or the reply in the normal log', async () => {
    const log = readFileSync(logFile(), 'utf8');
    expect(log).toMatch(/model reply .*"provider":"openai-compatible".*"model":"gpt-4\.1".*"finish":"stop"/);
    expect(log).toMatch(/structured reply accepted/);
    expect(log).toMatch(/structured reply not usable .*"outcome":"truncated"/);
    expect(log).toMatch(/model request failed .*"code":"auth","status":401/);
    expect(log).not.toContain('sk-e2e-secret');
    expect(log).not.toContain('sk-a-different-key');
    expect(log).not.toContain(ABOUT.tellMeAboutYourself);
    expect(log).not.toContain('operations manager with seven years'); // no reply content

    // CANDOR_DEBUG_AI=1 was set for this run: raw replies are captured locally, credentials never
    expect(existsSync(debugFile())).toBe(true);
    const raw = readFileSync(debugFile(), 'utf8');
    for (const line of raw.trim().split('\n')) JSON.parse(line); // every line is valid JSON
    expect(raw).toContain('operations manager with seven years');
    expect(raw).not.toContain('sk-e2e-secret');
    expect(raw).not.toContain('sk-a-different-key');
    // prompts are only captured with CANDOR_DEBUG_AI=full: neither their text nor the résumé inside them is here (their sizes are)
    expect(raw).not.toContain('You write interview preparation material');
    expect(raw).not.toContain('candidate_facts');
    expect(raw).not.toContain('RIYA SHARMA');
    expect(raw).toMatch(/"promptChars":\{"system":\d+,"user":\d+\}/);
    expect(log).toMatch(/AI debug capture is ON/);
  });

  test('no console errors were raised in the window', () => {
    expect(l.errors).toEqual([]);
  });
});

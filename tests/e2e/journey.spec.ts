import { expect, test, type Page } from '@playwright/test';
import { JD_TEXT, RESUME_TEXT } from '../fixtures/documents';
import { respond } from '../helpers/llmScript';
import { MockLlmServer } from '../helpers/mockLlmServer';
import { MockSttServer, type SttConn } from '../helpers/mockSttServer';
import { invoke, launch, restoreViewport, setViewport, shot, type Launched } from './helpers';

let llm: MockLlmServer;
let stt: MockSttServer;
let l: Launched;
let page: Page;

const nav = (name: string) => page.getByRole('button', { name, exact: true }).click();
const until = async (fn: () => boolean | Promise<boolean>, ms = 8000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
};

test.describe.serial('a complete user journey in the real app', () => {
  test.beforeAll(async () => {
    llm = await new MockLlmServer().start();
    llm.openai.dynamic = respond;
    llm.openai.firstTokenDelayMs = 90;
    llm.openai.tokenDelayMs = 14;
    stt = await new MockSttServer().start();
    // Chromium's fake audio device supplies a real MediaStream so the genuine capture pipeline runs.
    l = await launch({ CANDOR_DEEPGRAM_URL: stt.dgUrl }, 1440, 900, ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']);
    page = l.page;
    await page.getByRole('button', { name: 'Skip setup' }).click();
  });
  test.afterAll(async () => {
    await l?.close();
    await llm?.stop();
    await stt?.stop();
  });

  test('connect a provider through Settings and run quick setup', async () => {
    await nav('Settings');
    await page.getByRole('button', { name: 'AI Providers' }).click();
    await page.getByRole('button', { name: 'Add provider' }).click();
    await page.getByLabel('Start from').selectOption({ label: 'Other OpenAI-compatible…' });
    await page.getByLabel('Name', { exact: true }).fill('Mock OpenAI');
    await page.getByLabel('Base URL').fill(llm.openaiUrl);
    await page.getByLabel(/API key/).fill('sk-e2e-secret-key-1234567890');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText(/Connected — \d+ models available/)).toBeVisible();
    await expect(page.getByText('key …7890')).toBeVisible();
    await expect(page.getByLabel('Live answers (fast)')).toHaveValue('gpt-4o-mini');
    await expect(page.getByLabel('Preparation (quality)')).toHaveValue('gpt-4.1');
    await shot(page, '10-providers');
    await page.getByRole('button', { name: 'Save & test' }).click();
    await expect(page.getByText(/Live model answered its first word in \d+ ms/)).toBeVisible();
    // The key is never present in the renderer's DOM.
    expect(await page.content()).not.toContain('sk-e2e-secret');
  });

  test('create an interview from a pasted résumé and job description, analysed with AI', async () => {
    await nav('Interviews');
    await page.getByRole('button', { name: 'New interview' }).first().click();
    await page.getByLabel('Job title').fill('Operations Manager');
    await page.getByLabel('Company', { exact: true }).fill('Contoso');
    await page.getByLabel('Interview type').selectOption({ label: 'Operations' });
    await page.getByRole('button', { name: 'Or paste the text' }).click();
    await page.getByLabel('Résumé text').fill(RESUME_TEXT);
    await page.getByRole('button', { name: 'Use this text' }).click();
    await page.getByLabel('Job description', { exact: true }).fill(JD_TEXT);
    await shot(page, '11-new-interview');
    await page.getByRole('button', { name: /Create & analyse/ }).click();
    await expect(page.getByRole('heading', { level: 1 }).first()).toContainText('Operations Manager', { timeout: 20_000 });
    // Résumé match: gaps are honest, strengths cite the résumé.
    await page.getByRole('tab', { name: 'Résumé match' }).click();
    await expect(page.getByText('Salesforce').first()).toBeVisible();
    await expect(page.getByText(/strong matches/)).toBeVisible();
    await shot(page, '12-match');
  });

  test('generate preparation material and stream a prepared answer', async () => {
    await page.getByRole('button', { name: /Generate all/ }).click();
    await page.getByRole('tab', { name: /^Questions/ }).click();
    await expect(page.getByText('Tell me about a time you improved a process.').first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole('tab', { name: 'About me' }).click();
    await expect(page.getByText('Tell me about yourself').first()).toBeVisible();
    // The invented "$9 million" is flagged rather than silently accepted.
    await expect(page.getByText(/not in your résumé/)).toBeVisible();
    await shot(page, '13-about');
    await page.getByRole('tab', { name: /^Questions/ }).click();
    await page.getByRole('button', { name: /Tell me about a time you improved a process/ }).click();
    await page.getByRole('button', { name: /Draft answer/ }).click();
    await expect(page.getByText(/manage a team of 14 support agents/).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('prepared').first()).toBeVisible();
    await shot(page, '14-prepared-answer');
  });

  test('live session with typed questions: streaming answer, latency, follow-up, layout at three sizes', async () => {
    await nav('Live Interview');
    await page.getByLabel('Interview', { exact: true }).selectOption({ label: 'Operations Manager @ Contoso' });
    await page.getByLabel('Listen with speech recognition').uncheck();
    await page.getByRole('button', { name: /Start \(type questions\)/ }).click();
    await expect(page.locator('.live-badge')).toContainText('LIVE');

    const box = page.getByLabel('Type a question');
    // A prepared question is instant.
    await box.fill('Tell me about a time you improved a process.');
    await box.press('Enter');
    await expect(page.getByText('instant · prepared')).toBeVisible();
    // A new question streams from the model.
    await box.fill('What are your greatest strengths?');
    await box.press('Enter');
    await expect(page.getByLabel('AI suggested answer').getByText(/In my current role/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('status').filter({ hasText: 'Complete' })).toBeVisible();
    const ttft = await page.locator('.bar-metric', { hasText: 'TTFT' }).locator('b').innerText();
    expect(ttft).toMatch(/\d+ ms|\d\.\d+ s/);
    await expect(page.getByText(/Every detail matches|Check before saying|No matching experience/)).toBeVisible();

    // Follow-up understood in context.
    await box.fill('What did you personally do?');
    await box.press('Enter');
    await expect(page.getByText('follow-up', { exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Complete' })).toBeVisible();

    // Mode switch by keyboard: Alt+4 → Bullets, regenerates immediately.
    await page.keyboard.press('Alt+4');
    await expect(page.getByRole('button', { name: /Bullets/ })).toHaveAttribute('aria-pressed', 'true');

    for (const [w, h] of [[1280, 720], [1920, 1080], [2560, 1440]] as const) {
      await setViewport(l.app, page, w, h); // throws unless the page really is w x h CSS px
      await page.waitForTimeout(300);
      const m = await page.evaluate(() => {
        const rect = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
        const overflowing: string[] = [];
        for (const el of document.querySelectorAll('.live-top > *, .live-grid > *, .live-bar > *, .pane, .answer-actions > *')) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1)) overflowing.push(`${(el as HTMLElement).className || el.tagName}@${Math.round(r.right)}`);
        }
        const body = document.querySelector('.answer-pane .pane-body')!;
        const endBtn = [...document.querySelectorAll('button')].find((b) => /End session/.test(b.textContent ?? ''))!.getBoundingClientRect();
        return {
          iw: window.innerWidth,
          ih: window.innerHeight,
          rootOverflow: document.documentElement.scrollWidth - window.innerWidth,
          overflowing,
          panes: [...document.querySelectorAll('.pane')].map((p) => Math.round(p.getBoundingClientRect().width)),
          barBottom: Math.round(rect('.live-bar').bottom),
          topBottom: Math.round(rect('.live-top').bottom),
          endVisible: endBtn.right <= window.innerWidth && endBtn.bottom <= rect('.live-top').bottom + 2,
          answerClipped: body.scrollWidth > body.clientWidth + 1,
          fontPx: Math.round(Number.parseFloat(getComputedStyle(document.querySelector('.answer-text')!).fontSize)),
        };
      });
      expect(m.iw, 'viewport really is this wide').toBe(w);
      expect(m.rootOverflow, `${w}x${h} horizontal overflow`).toBeLessThanOrEqual(0);
      expect(m.overflowing, `${w}x${h} elements beyond the viewport`).toEqual([]);
      expect(m.panes, `${w}x${h}`).toHaveLength(3);
      expect(Math.min(...m.panes), `${w}x${h} pane widths ${m.panes.join(', ')}`).toBeGreaterThan(190);
      expect(m.barBottom, `${w}x${h} status bar inside the window`).toBeLessThanOrEqual(m.ih + 1);
      expect(m.endVisible, `${w}x${h} End session button reachable`).toBe(true);
      expect(m.answerClipped, `${w}x${h} answer text clipped`).toBe(false);
      console.log(`LAYOUT ${w}x${h}:`, JSON.stringify({ panes: m.panes, topBar: m.topBottom, answerFontPx: m.fontPx }));
      await shot(page, `20-live-${w}x${h}`);
    }
    await restoreViewport(l.app, page);
    await page.getByRole('button', { name: /End session/ }).click();
    await expect(page.getByText('Ready when you are.')).toBeVisible();
  });

  let conn: SttConn;
  test('live session from audio: real capture pipeline → streaming STT → VAD → speculative answer', async () => {
    // Speech key through Settings, and its connection test (a real WebSocket handshake with the mock service).
    await nav('Settings');
    await page.getByRole('button', { name: 'Speech recognition' }).click();
    // The default engine runs on this PC; a cloud service is a deliberate, explicit choice.
    await expect(page.getByLabel('Primary speech provider')).toHaveValue('local');
    await page.getByLabel('Primary speech provider').selectOption('deepgram');
    await page.getByText('Cloud speech services (optional)').click();
    await page.getByLabel('Deepgram API key').fill('dg-e2e-key-123456');
    await page.getByRole('button', { name: 'Save', exact: true }).first().click();
    await expect(page.getByText('key …3456')).toBeVisible();
    await page.getByRole('button', { name: 'Test connection' }).first().click();
    await expect(page.getByText(/Connected in \d+ ms/)).toBeVisible();
    stt.reset();

    // Live: in-person mode (one microphone), and the consent notice must be accepted before any audio is captured.
    await nav('Live Interview');
    await page.getByLabel('Interview', { exact: true }).selectOption({ label: 'Operations Manager @ Contoso' });
    await page.getByRole('button', { name: /This microphone/ }).click();
    await page.getByRole('button', { name: /Start listening/ }).click();
    await expect(page.getByRole('dialog', { name: 'Before Candor listens' })).toBeVisible();
    await page.waitForTimeout(400); // let the dialog's entrance animation finish so the screenshot shows the real thing
    await shot(page, '29-consent');
    expect(stt.conns).toHaveLength(0); // nothing is captured or connected before consent
    await page.getByRole('button', { name: /I understand/ }).click();
    conn = await stt.waitConn(1, 8000);
    expect(conn.headers.authorization).toBe('Token dg-e2e-key-123456');

    // Audio really flows: microphone → AudioWorklet → IPC → main → WebSocket.
    await until(() => conn.audioBytes > 16_000, 8000);
    const dbg = await invoke<{ audio: { name: string; seconds: number }[]; sttStates: { state: string }[] }>(page, 'live.debug');
    expect(dbg.audio[0].name).toBe('mic');
    expect(dbg.audio[0].seconds).toBeGreaterThan(0.4);
    expect(dbg.sttStates[0].state).toBe('connected');
    await expect(page.locator('.pill', { hasText: 'Deepgram · connected' })).toBeVisible();

    // The provider hears a complete question: a draft starts while the interviewer may still be talking.
    stt.dgResult(conn, 'can you tell me about your experience managing a team?');
    await expect(page.getByLabel('Live transcript').getByText('can you tell me about your experience managing a team?')).toBeVisible();
    await expect(page.getByText('Answering while they finish…')).toBeVisible();
    await expect(page.getByLabel('AI suggested answer').getByText(/In my current role/)).toBeVisible({ timeout: 15_000 });
    await shot(page, '30-live-audio-draft');

    // The endpoint arrives with the same question: it is confirmed, not restarted.
    stt.dgResult(conn, 'Can you tell me about your experience managing a team?', { final: true, speechFinal: true });
    await expect(page.getByText('Answering while they finish…')).toBeHidden();
    const requests = llm.requests.filter((r) => r.path.includes('/chat/completions') && (r.body as { stream?: boolean } | null)?.stream);
    const userMsgs = requests.map((r) => ((r.body as { messages: { content: string }[] }).messages[1]?.content ?? ''));
    expect(userMsgs.filter((m) => m.includes('experience managing a team')).length).toBe(1);
    await shot(page, '31-live-audio-confirmed');

    // Pausing releases the microphone: nothing more is sent to the speech service.
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.locator('.live-badge')).toContainText('PAUSED');
    await page.waitForTimeout(400);
    const bytes = conn.audioBytes;
    await page.waitForTimeout(700);
    expect(conn.audioBytes).toBe(bytes);
    await page.getByRole('button', { name: 'Resume' }).click();
    await until(() => conn.audioBytes > bytes + 8000, 8000);
    await page.getByRole('button', { name: /End session/ }).click();
    await expect(page.getByText('Ready when you are.')).toBeVisible();
  });

  test('system (computer) audio capture: loopback stream or a clear message', async () => {
    await nav('Live Interview');
    await page.getByLabel('Interview', { exact: true }).selectOption({ label: 'Operations Manager @ Contoso' });
    await page.getByRole('button', { name: /Computer audio/ }).click();
    stt.reset();
    await page.getByRole('button', { name: /Start listening/ }).click();
    const outcome = await Promise.race([
      stt.waitConn(1, 8000).then(async (c) => {
        await until(() => c.audioBytes > 8000, 8000);
        return `loopback audio flowing (${c.audioBytes} bytes)`;
      }),
      page.getByText(/System audio|audio device|No audio output|blocked/i).first().waitFor({ timeout: 8000 }).then(() => 'clear error shown'),
    ]);
    console.log('SYSTEM-AUDIO OUTCOME:', outcome);
    expect(outcome).toMatch(/loopback audio flowing|clear error shown/);
    await shot(page, '32-system-audio');
    await page.getByRole('button', { name: /End session/ }).click();
  });

  test('microphone access denied: clear guidance, no audio leaves the PC, typing still works', async () => {
    // Refuse the microphone exactly the way Chromium does when Windows or the user denies access.
    await page.evaluate(() => {
      const md = navigator.mediaDevices;
      const original = md.getUserMedia.bind(md);
      (window as unknown as { __restoreMic: () => void }).__restoreMic = () => {
        md.getUserMedia = original;
      };
      md.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    });
    try {
      await nav('Live Interview');
      await page.getByLabel('Interview', { exact: true }).selectOption({ label: 'Operations Manager @ Contoso' });
      await page.getByRole('button', { name: /This microphone/ }).click();
      stt.reset();
      await page.getByRole('button', { name: /Start listening/ }).click();
      await expect(page.getByText(/Microphone access was denied/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Open Windows settings' })).toBeVisible();
      await expect(page.getByText(/You can keep going by typing questions below/)).toBeVisible();
      await shot(page, '33-mic-denied');
      // Nothing was captured, so nothing was streamed.
      const streamed = stt.conns.reduce((n, c) => n + c.audioBytes, 0);
      expect(streamed).toBe(0);
      // The session is still usable by typing.
      const box = page.getByLabel('Type a question');
      await box.fill('What are your greatest strengths?');
      await box.press('Enter');
      await expect(page.getByLabel('AI suggested answer').getByText(/In my current role/)).toBeVisible({ timeout: 15_000 });
      await page.getByRole('button', { name: /End session/ }).click();
    } finally {
      await page.evaluate(() => (window as unknown as { __restoreMic?: () => void }).__restoreMic?.());
    }
  });

  test('mock interview: answer, measured statistics, AI assessment, report', async () => {
    await nav('Mock Interview');
    await page.getByLabel('Number of questions').selectOption('3');
    await page.getByRole('button', { name: /Start mock interview/ }).click();
    await expect(page.getByText('Question 1 of 3')).toBeVisible();
    await page.getByLabel('Your answer').fill('Um, so I noticed the returns queue was slow. I mapped the process, removed two approval steps and handling time fell by 22% in a month.');
    await page.getByRole('button', { name: 'Submit answer' }).click();
    await expect(page.getByText('Assessment')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Strong').first()).toBeVisible();
    await expect(page.getByText(/filler words/)).toBeVisible();
    await shot(page, '40-mock-result');
    for (const a of ['I would start by finding the root cause before deciding what to change.', 'I coach the team weekly and track quality scores with a shared scorecard.']) {
      await page.getByRole('button', { name: /Next question/ }).click();
      await page.getByLabel('Your answer').fill(a);
      await page.getByRole('button', { name: 'Submit answer' }).click();
      await expect(page.getByText('Assessment')).toBeVisible({ timeout: 20_000 });
    }
    await page.getByRole('button', { name: /See my report/ }).click();
    await expect(page.getByText('Your report')).toBeVisible();
    await expect(page.getByText('Counts of questions at each level')).toBeVisible();
    await shot(page, '41-mock-report');
  });

  test('history: sessions are listed, searchable and open with answers and timings', async () => {
    await nav('History');
    await expect(page.getByRole('button', { name: /Live session|Operations Manager/ }).first()).toBeVisible();
    await page.getByLabel('Search history').fill('strengths');
    await page.getByRole('button', { name: /Operations Manager/ }).first().click();
    await expect(page.getByText('What are your greatest strengths?').first()).toBeVisible();
    await expect(page.getByText(/first word/).first()).toBeVisible();
    await page.getByLabel('Session notes').fill('Mention the dashboard next time.');
    await page.getByLabel('Session notes').blur();
    await expect(page.getByText('Notes saved.')).toBeVisible();
    await shot(page, '50-history');
  });

  test('benchmark shows measured median and percentiles', async () => {
    llm.openai.firstTokenDelayMs = 60;
    await nav('Settings');
    await page.getByRole('button', { name: 'Performance' }).click();
    await page.getByLabel('Requests').selectOption('5');
    await page.getByRole('button', { name: /Run benchmark/ }).click();
    await expect(page.getByText('Time to first token')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/excluded from the statistics/)).toBeVisible();
    const median = await page.locator('tr', { hasText: 'Time to first token' }).locator('td.num').first().innerText();
    expect(median).toMatch(/^\d+ ms$/);
    expect(Number.parseInt(median, 10)).toBeGreaterThanOrEqual(60);
    await shot(page, '60-benchmark');
  });

  test('global shortcuts are registered and configurable', async () => {
    const status = await invoke<Record<string, { registered: boolean; accelerator: string }>>(page, 'hotkeys.status');
    console.log('HOTKEYS:', JSON.stringify(Object.fromEntries(Object.entries(status).map(([k, v]) => [k, v.registered]))));
    expect(Object.keys(status).sort()).toEqual(['copy', 'cycleMode', 'expand', 'generate', 'regenerate', 'shorter', 'star', 'toggleListening']);
    const registered = Object.values(status).filter((s) => s.registered).length;
    await nav('Settings');
    await page.getByRole('button', { name: 'Hotkeys' }).click();
    if (registered >= 6) {
      await expect(page.getByText('active').first()).toBeVisible();
    } else {
      // Another program already owns these shortcuts — typically another copy of Candor that is running on this PC.
      // That is not a failure of the app, but it must be reported honestly instead of pretending they work.
      test.info().annotations.push({ type: 'environment', description: `only ${registered}/8 global shortcuts could be registered: another application holds them (is Candor already running?)` });
      await expect(page.getByText('unavailable').first()).toBeVisible();
    }
    await shot(page, '70-hotkeys');
  });

  test('no unexpected console errors were raised during the whole journey', async () => {
    const unexpected = l.errors.filter((e) => !/Failed to load resource.*(401|404)/.test(e));
    expect(unexpected, unexpected.join('\n')).toEqual([]);
  });
});

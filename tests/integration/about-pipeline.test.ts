import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JD_TEXT, RESUME_TEXT } from '../fixtures/documents';
import { makeApp, type App } from '../helpers/appHarness';
import { respond } from '../helpers/llmScript';
import { MockLlmServer } from '../helpers/mockLlmServer';

/**
 * The “About me” section end to end: Preparation → prompt → model request → response → JSON extraction → validation →
 * saved section. A first version of this file reproduced a real failure: “The model returned an unusable reply twice
 * (unterminated JSON object)”. The user's setup was Google, a Quality model (2800-token ceiling) as the preparation
 * primary, and a Fast model with a 700-token ceiling as the fallback. The primary answered with a server error, so
 * “About me” ran on the fallback row, where a 700-token ceiling silently replaced the request's own 1800-token budget
 * — and a Gemini 3 model spends part of any output budget on hidden thinking. The reply was cut off mid-string.
 */

let srv: MockLlmServer;
let app: App;
beforeAll(async () => {
  srv = await new MockLlmServer().start();
});
afterAll(async () => {
  await srv.stop();
});
beforeEach(() => srv.reset());

/** What the prompt asks for (a 90–150 word spoken answer plus five more fields) comes to roughly 900 tokens. */
const ABOUT = {
  tellMeAboutYourself:
    'I am an operations manager with seven years in logistics customer support. I started as a support agent, became a team lead at Contoso BPO, and for the last three years I have run a 40-person operation at Northwind Logistics. My focus has been the returns workflow: I redesigned it, cut average handling time by 22 percent, and built the Power BI reporting our leadership now uses every week. I enjoy turning messy processes into simple ones, and I am drawn to this role because it is about scaling exactly that kind of operation across a larger network.',
  professionalSummary:
    'Operations manager with seven years of experience leading customer support and fulfilment teams in logistics. Known for process redesign, data-driven management and steady coaching of team leads. Comfortable with SQL and Power BI.',
  careerJourney:
    'I began as a customer support agent at Contoso BPO, where I learned the daily rhythm of a high-volume contact centre. Within two years I was leading a small team and owning its quality metrics. I then moved to Northwind Logistics as an operations manager. There I took on returns, dispatch coordination and reporting for a 40-person operation. Each step widened the scope of what I was accountable for while keeping me close to the front line.',
  currentRole:
    'At Northwind Logistics I manage a team of 14 support agents and three team leads. I own the returns workflow, the weekly performance review and the reporting that goes to senior leadership. Most of my time goes on coaching, capacity planning and removing blockers for the team.',
  strengths: [
    'Process redesign: rebuilt the returns workflow and cut average handling time by 22 percent',
    'People leadership: manage 14 agents and three team leads across shifts',
    'Data fluency: SQL and Power BI dashboards used in weekly leadership reviews',
    'Coaching: regular one-to-ones and quality reviews that raise the whole team',
    'Ownership: accountable end to end for returns quality and turnaround',
    'Calm under pressure: stable service levels through seasonal peaks',
  ],
  relevantExperience: [
    'Ran a 40-person logistics support operation at Northwind Logistics',
    'Redesigned the returns workflow, cutting average handling time by 22 percent',
    'Built weekly Power BI reporting for senior leadership',
    'Led a team of 14 agents and three team leads',
    'Started in frontline support at Contoso BPO before moving into team leadership',
    'Worked with SQL to investigate and fix recurring service issues',
  ],
};
const ABOUT_JSON = JSON.stringify(ABOUT);

const overloaded = { error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded. Please try again later.' } };

/** The mock receives Google's request format; the shared script reads the OpenAI one, so translate. */
const googleReply = (body: Record<string, unknown> | null): string => {
  const text = (v: unknown) => (v as { parts?: { text?: string }[] } | undefined)?.parts?.[0]?.text ?? '';
  const contents = body?.contents as unknown[] | undefined;
  const system = text(body?.systemInstruction);
  // A real model asked to "repair" a broken About reply writes the whole object out again.
  if (system.includes('write interview preparation material') || system.startsWith('You repair JSON')) return ABOUT_JSON;
  return respond({ messages: [{ role: 'system', content: system }, { role: 'user', content: text(contents?.[0]) }] });
};

interface Setup {
  fastCeiling?: number;
  qualityCeiling?: number;
  fastModel?: string;
  qualityModel?: string;
}

/** The exact rows and routing found in the user's own database (names and numbers only; no secrets). */
async function userSetup(o: Setup = {}) {
  const a = makeApp();
  const provider = await a.call('providers.save', { name: 'Google', kind: 'google', baseUrl: srv.googleUrl, enabled: true, apiKey: 'AIza-test-key-123456' });
  const fast = await a.call('models.save', { name: `Fast · ${o.fastModel ?? 'gemini-3.5-flash'}`, providerId: provider.id, model: o.fastModel ?? 'gemini-3.5-flash', temperature: 0.4, maxTokens: o.fastCeiling ?? 700, topP: null, timeoutMs: 20_000, streaming: true });
  const quality = await a.call('models.save', { name: `Quality · ${o.qualityModel ?? 'gemini-3.8-flash'}`, providerId: provider.id, model: o.qualityModel ?? 'gemini-3.8-flash', temperature: 0.3, maxTokens: o.qualityCeiling ?? 2800, topP: null, timeoutMs: 90_000, streaming: true });
  await a.call('settings.update', {
    routing: {
      live: { primary: fast.id, fallback: quality.id },
      prep: { primary: quality.id, fallback: fast.id },
      classify: { primary: fast.id, fallback: null },
      mock: { primary: quality.id, fallback: fast.id },
    },
  });
  const resume = await a.call('resumes.create', { name: 'cv.txt', source: 'txt', text: RESUME_TEXT, useAi: false });
  const interview = await a.call('interviews.create', { jobTitle: 'Operations Manager', company: 'Contoso', interviewType: 'operations', jobDescription: JD_TEXT, resumeId: resume.id });
  return { app: a, interviewId: interview.id, fast, quality };
}

const generateRequests = () =>
  srv.requests
    .filter((r) => r.method === 'POST')
    .map((r) => {
      const gc = (r.body?.generationConfig ?? {}) as Record<string, unknown>;
      return { model: /\/models\/([^:/?]+):/.exec(r.path)?.[1] ?? '?', maxOutputTokens: gc.maxOutputTokens, thinkingConfig: gc.thinkingConfig, responseMimeType: gc.responseMimeType, hasSchema: !!(gc.responseSchema ?? gc.responseJsonSchema) };
    });

interface AboutData {
  note?: string;
  tellMeAboutYourself: string;
  professionalSummary: string;
  careerJourney: string;
  currentRole: string;
  strengths: string[];
  relevantExperience: string[];
}

const gemini = (script?: { text?: string; finishReason?: 'stop' | 'length' }[]) => {
  srv.google.listModels = ['gemini-3.8-flash', 'gemini-3.5-flash'];
  srv.google.honorMaxTokens = true;
  srv.google.thinkingTokens = 500;
  srv.google.dynamic = googleReply;
  if (script) srv.google.script = script;
};

async function generateAbout(a: App, interviewId: string) {
  const before = a.events('prep.progress').length;
  await a.call('prep.generate', { interviewId, section: 'about' });
  const errors = a.events('prep.progress').slice(before).filter((p) => p.error).map((p) => p.error);
  const prep = await a.call('prep.get', { interviewId });
  return { errors, section: prep.about, about: prep.about?.data as AboutData | undefined };
}
const complete = (a: AboutData | undefined) => !!a && a.tellMeAboutYourself.length > 40 && a.professionalSummary !== '' && a.careerJourney !== '' && a.currentRole !== '' && a.strengths.length > 0 && a.relevantExperience.length > 0;

describe('“About me” with the setup found on the user’s PC', () => {
  it('REPRODUCTION (was: “unusable reply twice (unterminated JSON object)”): primary answers 503, the fallback row has a 700-token ceiling, Gemini spends tokens on thinking', async () => {
    gemini();
    srv.google.perModel = { 'gemini-3.8-flash': { status: 503, body: overloaded } };
    const s = await userSetup();
    app = s.app;
    try {
      const { errors, section, about } = await generateAbout(app, s.interviewId);
      console.log('REPRO requests:', JSON.stringify(generateRequests()));
      console.log('REPRO errors:', JSON.stringify(errors));
      expect(errors).toEqual([]);
      expect(complete(about)).toBe(true);
      expect(about?.tellMeAboutYourself).toContain('operations manager');
      expect(about?.note).toBeUndefined(); // written by the model, in full: no offline draft, no note
      expect(section?.model).toBe('gemini-3.5-flash');
      // what went out: the app's own 1800-token budget (not the row's 700), reasoning limited, a native schema, JSON mode
      const reqs = generateRequests();
      const onFallback = reqs.filter((r) => r.model === 'gemini-3.5-flash');
      expect(onFallback).toHaveLength(1);
      expect(onFallback[0]).toMatchObject({ maxOutputTokens: 1800, thinkingConfig: { thinkingLevel: 'low' }, responseMimeType: 'application/json', hasSchema: true });
      expect(reqs.length).toBeLessThanOrEqual(4); // it was 8
    } finally {
      await app.close();
    }
  });

  it('even if the model’s reasoning cannot be limited at all, the request keeps room for the whole reply', async () => {
    gemini();
    srv.google.rejectThinking = ['level', 'budget'];
    const s = await userSetup({ fastCeiling: 700, qualityModel: 'gemini-3.5-flash' });
    app = s.app;
    try {
      // both rows are the same small model; 500 hidden tokens come out of the 1800 the request asks for
      const { errors, about } = await generateAbout(app, s.interviewId);
      expect(errors).toEqual([]);
      expect(complete(about)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('a reply wrapped in a fence and chat is used directly: one request, no notice, no note', async () => {
    gemini();
    srv.google.dynamic = () => 'Sure! Here is your material:\n```json\n' + ABOUT_JSON + '\n```\nGood luck with the interview!';
    const s = await userSetup({ qualityCeiling: 2800 });
    app = s.app;
    try {
      const { errors, about } = await generateAbout(app, s.interviewId);
      expect(errors).toEqual([]);
      expect(complete(about)).toBe(true);
      expect(about?.note).toBeUndefined();
      expect(generateRequests()).toHaveLength(1);
      expect(app.events('app.notice')).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('a reply cut off mid-field gets a shorter, different request — and the person is told', async () => {
    gemini([{ text: ABOUT_JSON.slice(0, 900), finishReason: 'length' }, { text: ABOUT_JSON }]);
    srv.google.dynamic = undefined;
    const s = await userSetup();
    app = s.app;
    try {
      const { errors, about, section } = await generateAbout(app, s.interviewId);
      expect(errors).toEqual([]);
      expect(complete(about)).toBe(true);
      expect(section?.model).not.toBeNull();
      const reqs = srv.requests.filter((r) => r.method === 'POST');
      expect(reqs).toHaveLength(2);
      const cfg = (i: number) => (reqs[i]?.body?.generationConfig ?? {}) as { maxOutputTokens?: number };
      expect(cfg(1).maxOutputTokens).toBeGreaterThan(cfg(0).maxOutputTokens as number); // not the same request again
      const system = (i: number) => JSON.stringify(reqs[i]?.body?.systemInstruction);
      expect(system(1)).toContain('Keep the whole reply under 300 words'); // the compact About prompt
      expect(system(0)).not.toContain('Keep the whole reply under 300 words');
      expect(app.events('app.notice').some((n) => /cut off/.test(n.message))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('when both replies are cut off, the model is asked for the main text alone; the rest comes from the résumé, and the page says so', async () => {
    const plain = 'I am an operations manager with seven years in logistics, currently running a large support operation and focused on simplifying processes and coaching my team leads to deliver consistent service.';
    // both replies stop inside the very first field, so nothing was written in full
    gemini([{ text: ABOUT_JSON.slice(0, 300), finishReason: 'length' }, { text: ABOUT_JSON.slice(0, 350), finishReason: 'length' }, { text: plain }]);
    srv.google.dynamic = undefined;
    const s = await userSetup();
    app = s.app;
    try {
      const { errors, about, section } = await generateAbout(app, s.interviewId);
      expect(errors).toEqual([]);
      expect(about?.tellMeAboutYourself).toBe(plain);
      expect(about?.note).toMatch(/some fields here were drafted from your résumé instead of written by the AI/);
      expect(complete(about)).toBe(true); // every other field was drafted from the résumé
      expect(about?.currentRole).toMatch(/Northwind Logistics/);
      expect(section?.model).not.toBeNull();
      expect(srv.requests.filter((r) => r.method === 'POST')).toHaveLength(3);
    } finally {
      await app.close();
    }
  });

  it('when the cut-off replies already wrote the main text in full, that text is kept and no third request is made', async () => {
    // both replies stop after the first field (about 560 characters) has been written completely
    gemini([{ text: ABOUT_JSON.slice(0, 700), finishReason: 'length' }, { text: ABOUT_JSON.slice(0, 800), finishReason: 'length' }]);
    const s = await userSetup();
    app = s.app;
    try {
      const { errors, about } = await generateAbout(app, s.interviewId);
      expect(errors).toEqual([]);
      expect(about?.tellMeAboutYourself).toBe(ABOUT.tellMeAboutYourself); // the model's own words, exactly
      expect(about?.note).toMatch(/some fields here were drafted from your résumé/);
      expect(complete(about)).toBe(true);
      expect(srv.requests.filter((r) => r.method === 'POST')).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it('when nothing usable can be had, an honest offline draft is saved — with a note, not an error', async () => {
    gemini([{ text: 'I am sorry, I cannot help with that.' }, { text: '' }, { text: 'no' }]);
    srv.google.dynamic = undefined;
    const s = await userSetup();
    app = s.app;
    try {
      const { errors, about, section } = await generateAbout(app, s.interviewId);
      expect(errors).toEqual([]);
      expect(section?.model).toBeNull(); // "Offline draft (no AI)"
      expect(about?.note).toMatch(/offline draft built from your résumé/);
      expect(complete(about)).toBe(true);
      // only what the résumé says: the company and roles are real, nothing about employers that are not in it
      const all = JSON.stringify(about);
      expect(all).toMatch(/Northwind Logistics/);
      expect(all).not.toMatch(/Globex|Kubernetes|PMP|300%/);
      expect(app.events('app.notice').some((n) => /offline draft/.test(n.message))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('a provider problem (a rejected key) is still an error the person sees — it is not hidden behind an offline draft', async () => {
    gemini();
    srv.google.requireKey = 'AIza-a-different-key-0000';
    const s = await userSetup();
    app = s.app;
    try {
      const { errors, about } = await generateAbout(app, s.interviewId);
      expect(errors).toHaveLength(1);
      expect(errors.join(' ')).toMatch(/key|sign in|credential/i);
      expect(about).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('“Generate all” with a failing primary: four sections, one short failed attempt each, no retry storm', async () => {
    gemini();
    srv.google.perModel = { 'gemini-3.8-flash': { status: 503, body: overloaded } };
    srv.google.retryAfter = '0';
    const s = await userSetup();
    app = s.app;
    try {
      await app.call('prep.generate', { interviewId: s.interviewId, section: 'all' });
      expect(app.events('prep.progress').filter((p) => p.error)).toEqual([]);
      const prep = await app.call('prep.get', { interviewId: s.interviewId });
      expect(Object.keys(prep).sort()).toEqual(['about', 'company', 'questions', 'role']);
      const toPrimary = generateRequests().filter((r) => r.model === 'gemini-3.8-flash').length;
      expect(toPrimary).toBeLessThanOrEqual(6); // it used to be 12 for the first pass alone, and 24 with the repair calls
    } finally {
      await app.close();
    }
  });

  it('other sections fall back to their offline drafts the same way when the model cannot give usable data', async () => {
    gemini();
    srv.google.dynamic = (body) => {
      const system = JSON.stringify(body?.systemInstruction);
      return system.includes('prepare a candidate for an interview at a company') ? 'not json at all' : googleReply(body);
    };
    const s = await userSetup({ qualityCeiling: 2800 });
    app = s.app;
    try {
      await app.call('prep.generate', { interviewId: s.interviewId, section: 'all' });
      expect(app.events('prep.progress').filter((p) => p.error)).toEqual([]);
      const prep = await app.call('prep.get', { interviewId: s.interviewId });
      const company = prep.company?.data as { note?: string; summary: string };
      expect(company.note).toMatch(/offline draft/);
      expect(prep.company?.model).toBeNull();
      expect(company.summary).toMatch(/No company notes were provided/); // the offline company draft, built only from what the person entered
    } finally {
      await app.close();
    }
  });

  it('40 runs with randomly broken replies: About always ends up on the page, and no request is ever sent twice', async () => {
    let seed = 20260921;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const shapes: ((json: string) => string)[] = [
      (j) => j,
      (j) => '```json\n' + j + '\n```',
      (j) => 'Here is the JSON:\n' + j + '\nHope that helps! {smile}',
      (j) => j.slice(0, Math.floor(rnd() * j.length)), // cut anywhere
      (j) => j.slice(0, -1), // missing only the final brace
      (j) => j.replace('"strengths"', "'strengths'").replace(/",\s*"/g, '", "').replace(/\]\}$/, '],}'), // punctuation slips
      () => '',
      () => 'I cannot help with that.',
      (j) => j + j, // two objects in a row
    ];
    gemini();
    srv.google.dynamic = (body) => {
      const system = JSON.stringify(body?.systemInstruction);
      if (system.includes('Plain text only')) return 'I am an operations manager with seven years of experience in logistics and I enjoy simplifying processes.';
      return (shapes[Math.floor(rnd() * shapes.length)])(ABOUT_JSON);
    };
    const s = await userSetup({ qualityCeiling: 2800 });
    app = s.app;
    try {
      for (let run = 0; run < 40; run++) {
        srv.requests.length = 0;
        const { errors, about } = await generateAbout(app, s.interviewId);
        const sent = srv.requests.filter((r) => r.method === 'POST').map((r) => `${r.path}\n${JSON.stringify(r.body)}`);
        expect({ run, errors, complete: complete(about) }).toEqual({ run, errors: [], complete: true });
        // The point of the whole design: the same request is never sent twice. (An empty reply also tries the fallback
        // model, so a run may use up to two requests per question asked; here that is at most three questions.)
        expect(new Set(sent).size).toBe(sent.length);
        expect(sent.length).toBeLessThanOrEqual(6);
      }
    } finally {
      await app.close();
    }
  });
});

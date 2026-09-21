import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { respond } from '../helpers/llmScript';
import { MockLlmServer } from '../helpers/mockLlmServer';
import { invoke, launch, shot, type Launched } from './helpers';

/**
 * Speech recognition on this PC, end to end in the real app: a recorded question is played into Chromium's fake
 * microphone, travels through the real capture pipeline (AudioWorklet → IPC), is recognised by the real worker thread
 * and the real model, and the transcript, the question detection and a streamed answer appear in the interface.
 * Only the language model is a local stand-in. No key, no account, no network.
 */

const CLIP = resolve('tests/fixtures/speech/q01.wav'); // "Tell me about a time when you had to lead a team through a difficult project."
const haveModels = existsSync(resolve('resources/models/stt/x-asr-160/encoder.int8.onnx')) && existsSync(resolve('resources/models/stt/zipformer-en-70m/encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx'));

test.skip(!haveModels, 'The speech models are not installed (run "npm run models").');

let llm: MockLlmServer;
let l: Launched;

test.describe.serial('speech on this PC, in the real app', () => {
  test.beforeAll(async () => {
    llm = await new MockLlmServer().start();
    llm.openai.dynamic = respond;
    llm.openai.firstTokenDelayMs = 60;
    llm.openai.tokenDelayMs = 10;
    // The fake microphone plays the recorded question once ("%noloop"), starting when capture starts.
    l = await launch({}, 1440, 900, ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${CLIP}%noloop`]);
    await l.page.getByRole('button', { name: 'Skip setup' }).click();
  });
  test.afterAll(async () => {
    await l?.close();
    await llm?.stop();
  });

  test('is the default: Settings shows the engine, and the built-in test transcribes a real recording', async () => {
    const { page } = l;
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Speech recognition' }).click();
    await expect(page.getByLabel('Primary speech provider')).toHaveValue('local');
    await expect(page.getByText('Free · private · works offline')).toBeVisible();
    await expect(page.getByLabel('Primary speech provider').locator('option:checked')).toHaveText(/On this PC — free & private/);
    await shot(page, '60-speech-settings');

    await page.getByRole('button', { name: 'Test speech recognition' }).click();
    // The first use loads the model (about 15 s on a 2019 laptop CPU), then plays the sample in real time.
    await expect(page.getByText(/Heard: “After early nightfall the yellow lamps/)).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(/First words appeared \d+ ms after the audio began/)).toBeVisible();
    await expect(page.getByText('Ready', { exact: false }).first()).toBeVisible();
    await shot(page, '61-speech-test-passed');
    const status = await invoke<{ state: string; loadMs: number; rssMb: number; modelId: string }>(page, 'stt.localStatus');
    expect(status.state).toBe('ready');
    console.log(`SPEECH ENGINE: model ${status.modelId}, loaded in ${status.loadMs} ms, ${status.rssMb} MB resident`);
  });

  test('a recorded question flows: microphone → capture → on-device recognition → transcript → answer', async () => {
    const { page } = l;
    // Any OpenAI-compatible model will do; this one is a local stand-in.
    await page.getByRole('button', { name: 'AI Providers' }).click();
    await page.getByRole('button', { name: 'Add provider' }).click();
    await page.getByLabel('Start from').selectOption({ label: 'Other OpenAI-compatible…' });
    await page.getByLabel('Name', { exact: true }).fill('Mock OpenAI');
    await page.getByLabel('Base URL').fill(llm.openaiUrl);
    await page.getByLabel(/API key/).fill('sk-e2e-secret-key-1234567890');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText(/Connected — \d+ models available/)).toBeVisible();
    await page.getByRole('button', { name: 'Save & test' }).click();
    await expect(page.getByText(/Live model answered its first word in \d+ ms/)).toBeVisible();

    await page.getByRole('button', { name: 'Live Interview', exact: true }).click();
    await page.getByRole('button', { name: /This microphone/ }).click();
    await expect(page.getByText(/Speech recognition on this PC/)).toBeVisible();
    await page.getByRole('button', { name: /Start listening/ }).click();
    await page.getByRole('button', { name: /I understand/ }).click();

    // No key was asked for: the status pill names the engine that is doing the work.
    await expect(page.locator('.pill', { hasText: 'On this PC · connected' })).toBeVisible({ timeout: 60_000 });
    const t0 = Date.now();
    // Words appear in the live transcript while the recording is still playing…
    const transcript = page.getByLabel('Live transcript');
    await expect(transcript.getByText(/Tell me about a time/)).toBeVisible({ timeout: 30_000 });
    const firstWordsMs = Date.now() - t0;
    // …the question is understood and a streamed answer follows.
    await expect(page.getByLabel('AI suggested answer').getByText(/In my current role/)).toBeVisible({ timeout: 30_000 });
    await expect(transcript.getByText(/lead a team through a difficult project/)).toBeVisible();
    console.log(`SPEECH E2E: first words on screen ${firstWordsMs} ms after the microphone opened; answer streamed`);
    await shot(page, '62-live-on-device-speech');

    const dbg = await invoke<{ sttStates: { provider: string; state: string }[] }>(page, 'live.debug');
    expect(dbg.sttStates[0]?.provider).toBe('local');
    // The audio never went anywhere: the only network peer this run has talked to is the local stand-in model.
    expect(llm.requests.every((r) => r.path.includes('/v1') || r.path.includes('/models') || r.path.includes('/chat'))).toBe(true);
    expect(l.errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
    await page.getByRole('button', { name: /End session/ }).click();
    await expect(page.getByText('Ready when you are.')).toBeVisible();
  });
});

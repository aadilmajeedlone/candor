import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { invoke, launch, shot, type Launched } from './helpers';

/**
 * Google sign-in (Application Default Credentials) in the real app, with NO Google credentials on the machine: this is
 * what a user sees before they have run `gcloud auth application-default login`. Google's real auth library runs inside
 * Electron's main process; nothing here contacts Google.
 */

const NO_ADC = {
  GOOGLE_APPLICATION_CREDENTIALS: join(tmpdir(), 'candor-e2e-no-such-adc.json'), // points nowhere: a deterministic "not signed in"
  METADATA_SERVER_DETECTION: 'none', // do not probe for a cloud VM
};

let l: Launched;
test.afterEach(async () => {
  await l?.close();
});

test('adding a Google sign-in provider needs no API key and explains what to do next', async () => {
  l = await launch(NO_ADC);
  const { page } = l;
  await page.getByRole('button', { name: 'Skip setup' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'AI Providers' }).click();
  await page.getByRole('button', { name: 'Add provider' }).click();

  await page.getByLabel('Start from').selectOption({ label: 'Google Gemini — sign in with gcloud, no API key (Vertex AI: needs billing)' });
  const dialog = page.getByRole('dialog', { name: 'Add a provider' });
  await expect(dialog.getByLabel('How do you sign in to Google?')).toHaveValue('adc');
  await expect(dialog.getByLabel('Base URL')).toHaveValue('https://aiplatform.googleapis.com');
  await expect(dialog.getByLabel('Base URL')).toHaveJSProperty('readOnly', true); // set automatically: tokens only go to Google
  // The Windows steps are right there, with the project typed by the user filled in.
  await expect(dialog.getByText('winget install -e --id Google.CloudSDK')).toBeVisible();
  await expect(dialog.getByText('gcloud auth application-default login', { exact: true })).toBeVisible();
  await dialog.getByLabel('Project ID').fill('my-test-project');
  await expect(dialog.getByText('gcloud auth application-default set-quota-project my-test-project')).toBeVisible();
  await expect(dialog.getByText('gcloud services enable aiplatform.googleapis.com --project my-test-project')).toBeVisible();
  // Regions change the address; the key field is optional.
  await dialog.getByLabel('Region').fill('europe-west4');
  await expect(dialog.getByLabel('Base URL')).toHaveValue('https://europe-west4-aiplatform.googleapis.com');
  await expect(dialog.getByText('optional — only used if no Google sign-in is found')).toBeVisible();
  await shot(page, '95-google-signin-form');

  await dialog.getByRole('button', { name: 'Save', exact: true }).click(); // no key needed
  await expect(page.getByText('Google sign-in · my-test-project')).toBeVisible();

  // Nothing is signed in on this PC: Settings says so, in plain language, with the fix.
  await expect(page.getByText('Google sign-in (ADC) was not found on this PC.').first()).toBeVisible();
  await expect(page.getByText('winget install -e --id Google.CloudSDK').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check sign-in' })).toBeVisible();
  await shot(page, '96-google-signin-missing');

  // The Live Model Test reports the same thing instead of a cryptic failure.
  await page.getByRole('button', { name: 'Check sign-in' }).click();
  await expect(page.getByText('Google sign-in (ADC) was not found on this PC.').first()).toBeVisible();
  expect(l.errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});

test('a key for the wrong service is stopped in the form, before anything is sent', async () => {
  l = await launch(NO_ADC);
  const { page } = l;
  await page.getByRole('button', { name: 'Skip setup' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'AI Providers' }).click();
  await page.getByRole('button', { name: 'Add provider' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a provider' });
  await page.getByLabel('Start from').selectOption({ label: 'OpenAI (paid — prepaid credit)' });
  await dialog.getByLabel(/API key/).fill('AQ.Zx9Kq6abcdefghijklmnopqrstuvwxyz0123456789');
  await expect(dialog.getByText(/looks like a Google key, but this provider is OpenAI/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await shot(page, '97-key-mismatch');
});

test('the setup guide starts with no service pre-selected, and Google sign-in is offered', async () => {
  l = await launch(NO_ADC);
  const { page } = l;
  await page.getByLabel('Your name').fill('Test User');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Skip', exact: true }).click(); // résumé
  await expect(page.getByRole('heading', { name: 'Connect an AI provider' })).toBeVisible();
  const service = page.getByLabel('Service');
  await expect(service).toHaveValue(''); // nothing pre-selected: a pre-selected OpenAI once received a Google key
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();

  await service.selectOption({ label: 'Google Gemini — sign in with gcloud, no API key (Vertex AI: needs billing)' });
  await expect(page.getByLabel('Google Cloud project ID')).toBeVisible();
  await expect(page.getByLabel('API key', { exact: true })).toHaveCount(0); // no key asked for
  await page.getByLabel('Google Cloud project ID').fill('my-test-project');
  await page.getByRole('button', { name: 'Check sign-in & connect' }).click();
  await expect(page.getByText('Google sign-in (ADC) was not found on this PC.').first()).toBeVisible();
  await expect(page.getByText('gcloud auth application-default login').first()).toBeVisible();
  await shot(page, '98-onboarding-google-signin');
});

test('reopening the setup guide at the Models step never shows a blank page', async () => {
  l = await launch(NO_ADC);
  const { page } = l;
  // The guide remembers its step. This is "closed Candor on step 4, updated it, opened it again" with nothing in memory.
  await invoke(page, 'settings.update', { onboarding: { step: 3 } });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Connect an AI provider' })).toBeVisible(); // no provider yet: back one step

  // With a saved provider, the Models step is rebuilt from it, prefilled, and a missing sign-in is explained.
  await invoke(page, 'providers.save', { name: 'Google (Gemini)', kind: 'google', baseUrl: 'https://aiplatform.googleapis.com', enabled: true, google: { mode: 'adc', backend: 'vertex', project: 'my-test-project', location: 'global' } });
  await invoke(page, 'settings.update', { onboarding: { step: 3 } });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Choose your models' })).toBeVisible();
  await expect(page.getByLabel('Live answers (fast)')).toHaveValue('gemini-2.5-flash');
  await expect(page.getByLabel('Preparation & evaluation (quality)')).toHaveValue('gemini-2.5-pro');
  await page.getByRole('button', { name: 'Save & test' }).click();
  await expect(page.getByText(/Google sign-in \(ADC\) was not found on this PC/).first()).toBeVisible();
  await shot(page, '99-onboarding-resume-models');
});

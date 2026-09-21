import type { ProviderKind } from '@shared/types';
import { call } from '@/services/api';

/** Failures that mean "this model is not usable on this account" rather than "something is broken". */
const RECOVERABLE = new Set(['rate_limit', 'model_not_found']);

export interface SetupOutcome {
  fast: string;
  quality: string;
  latencyMs: number;
  /** What Candor changed on the user's behalf, to be shown so nothing happens silently. */
  notes: string[];
}

const short = (message: string): string => (message.split(/(?<=[.!?])\s/)[0] ?? message).slice(0, 140);

/**
 * Save the chosen models and prove they answer. When Google says a model has no quota on this account (or does not
 * exist for it), the other suitable models are tried instead of leaving the user with a failed test.
 * Other providers behave exactly as before: save, test the live model, report.
 */
export async function saveAndTestModels(a: { kind: ProviderKind; providerId: string; fast: string; quality: string; fastAlternatives?: string[]; qualityAlternatives?: string[] }): Promise<SetupOutcome> {
  let { fast, quality } = a;
  const notes: string[] = [];
  const save = () => call('models.quickSetup', { providerId: a.providerId, fastModel: fast, qualityModel: quality });
  let saved = await save();
  let live = await call('models.test', { id: saved.live.id });

  if (a.kind === 'google' && !live.ok && live.error && RECOVERABLE.has(live.error.code)) {
    const candidates = (a.fastAlternatives ?? []).filter((m) => m !== fast);
    if (candidates.length > 0) {
      const probe = await call('models.probe', { providerId: a.providerId, candidates });
      if (probe.working) {
        notes.push(`“${fast}” cannot be used with this account (${short(live.error.message)}) so Candor is using “${probe.working}” for live answers.`);
        fast = probe.working;
        saved = await save();
        live = await call('models.test', { id: saved.live.id });
      }
    }
  }
  if (!live.ok) throw new Error(`Saved, but the live model test failed: ${live.error?.message ?? 'no answer'}`);

  // Check the preparation model too, so a model without quota is found now and not halfway through "Generate all".
  if (a.kind === 'google' && quality !== fast) {
    const prep = await call('models.test', { id: saved.prep.id });
    if (!prep.ok && prep.error && RECOVERABLE.has(prep.error.code)) {
      const candidates = (a.qualityAlternatives ?? []).filter((m) => m !== quality && m !== fast);
      const probe = candidates.length > 0 ? await call('models.probe', { providerId: a.providerId, candidates }) : null;
      const replacement = probe?.working ?? fast;
      notes.push(`“${quality}” cannot be used with this account (${short(prep.error.message)}) so preparation uses “${replacement}”.`);
      quality = replacement;
      await save();
    }
  }
  return { fast, quality, latencyMs: live.latencyMs ?? 0, notes };
}

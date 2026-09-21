import type { SttProviderId } from '@shared/types';
import type { SecretStore } from '../security/secrets';
import { assemblyai } from './assemblyai';
import { deepgram } from './deepgram';
import type { LocalSttHost } from './local/host';
import { createLocalProvider } from './local/provider';
import type { SttProvider } from './types';

export type CloudSttProviderId = Exclude<SttProviderId, 'local'>;

export const CLOUD_STT_PROVIDERS: readonly CloudSttProviderId[] = ['deepgram', 'assemblyai'];

export function sttKeyName(p: CloudSttProviderId): string {
  return `stt.${p}`;
}

export function resolveSttKey(secrets: SecretStore, p: CloudSttProviderId): string | null {
  return secrets.get(sttKeyName(p), p);
}

export type SttAccess = { ok: true; key: string } | { ok: false; message: string };

/** Every speech provider Candor can use, and whether one can be opened right now. */
export interface SttRegistry {
  provider(id: SttProviderId): SttProvider;
  /** Can this provider be opened now (key present / model installed)? If not, why, in plain words. */
  access(id: SttProviderId, secrets: SecretStore): SttAccess;
  readonly local: LocalSttHost;
}

export function createSttRegistry(local: LocalSttHost): SttRegistry {
  const providers: Record<SttProviderId, SttProvider> = { deepgram, assemblyai, local: createLocalProvider(local) };
  return {
    local,
    provider: (id) => providers[id],
    access: (id, secrets) => {
      if (id === 'local') {
        const found = local.check();
        return found.ok ? { ok: true, key: '' } : { ok: false, message: found.error.message };
      }
      const key = resolveSttKey(secrets, id);
      return key ? { ok: true, key } : { ok: false, message: `No ${providers[id].label} API key is set. Add a key in Settings → Speech, or switch to the free on-device speech engine.` };
    },
  };
}

import { CLOUD_STT_PROVIDERS, sttKeyName } from '../stt/registry';
import type { SecretStore } from '../security/secrets';
import type { Repos } from './repos';

/**
 * Settings are saved as one complete object, so an installation made before speech recognition moved on-device still
 * has the old default (a cloud provider) written into it, even though its owner never chose it. Left alone, an upgrade
 * would keep asking for a cloud key for a service that was never set up.
 *
 * Runs once per installation: if the selected speech provider is a cloud service that has no key (so it cannot work),
 * switch to the free on-device engine. A cloud provider that has a key is a deliberate choice and is left alone.
 * Nothing here ever moves anyone *to* a cloud service.
 */
export function migrateSettings(repos: Repos, secrets: SecretStore): void {
  if (!repos.hasFlag('speech-default-local')) {
    const stt = repos.getSettings().stt;
    if (stt.provider !== 'local') {
      const provider = stt.provider;
      const hasKey = (CLOUD_STT_PROVIDERS as readonly string[]).includes(provider) && secrets.source(sttKeyName(provider), provider) !== 'none';
      if (!hasKey) repos.updateSettings({ stt: { provider: 'local' } });
    }
    repos.setFlag('speech-default-local');
  }
}

import { STT_LABELS } from '@shared/speech';
import type { SttProvider } from '../types';
import type { LocalSttHost } from './host';

/** The on-device speech provider: audio never leaves this PC, and there is no key, account or cost. */
export function createLocalProvider(host: LocalSttHost): SttProvider {
  return {
    id: 'local',
    label: STT_LABELS.local,
    needsKey: false,
    open: (cfg, _key, events) => host.open(cfg, events),
  };
}

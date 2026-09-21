import { globalShortcut } from 'electron';
import { HOTKEY_ACTIONS, type HotkeyAction } from '@shared/settings';
import { log } from '../logging';
import type { Services } from '../services';

const l = log('hotkeys');

/** Global shortcuts: they work while another app (a meeting window) has focus, where the OS allows. */
export class Hotkeys {
  private status = new Map<HotkeyAction, { registered: boolean; accelerator: string }>();

  constructor(
    private readonly services: () => Services,
    private readonly notifyRenderer: (action: HotkeyAction) => void,
  ) {}

  register(): void {
    globalShortcut.unregisterAll();
    this.status.clear();
    const map = this.services().repos.getSettings().hotkeys;
    const seen = new Set<string>();
    for (const action of HOTKEY_ACTIONS) {
      const accelerator = map[action];
      let ok = false;
      if (accelerator && !seen.has(accelerator.toLowerCase())) {
        seen.add(accelerator.toLowerCase());
        try {
          ok = globalShortcut.register(accelerator, () => this.run(action));
        } catch (err) {
          l.warn('invalid accelerator', { action, message: err instanceof Error ? err.message.slice(0, 80) : '' });
        }
      }
      if (!ok) l.warn('shortcut not registered (in use or invalid)', { action, accelerator });
      this.status.set(action, { registered: ok, accelerator: accelerator ?? '' });
    }
  }

  get(): Record<HotkeyAction, { registered: boolean; accelerator: string }> {
    return Object.fromEntries(HOTKEY_ACTIONS.map((a) => [a, this.status.get(a) ?? { registered: false, accelerator: '' }])) as Record<HotkeyAction, { registered: boolean; accelerator: string }>;
  }

  dispose(): void {
    globalShortcut.unregisterAll();
  }

  private run(action: HotkeyAction): void {
    const live = this.services().live;
    try {
      if (!live.running) {
        this.notifyRenderer(action);
        return;
      }
      switch (action) {
        case 'toggleListening':
          live.togglePaused();
          break;
        case 'generate':
          live.answerNow();
          break;
        case 'shorter':
          live.shorter();
          break;
        case 'expand':
          live.expand();
          break;
        case 'star':
          live.setMode('star');
          break;
        case 'regenerate':
          live.regenerate();
          break;
        case 'copy':
          live.copy().catch((err: unknown) => l.warn('copy failed', { message: err instanceof Error ? err.message.slice(0, 100) : '' }));
          break;
        case 'cycleMode':
          live.cycleMode();
          break;
      }
      this.notifyRenderer(action);
    } catch (err) {
      l.warn('hotkey action failed', { action, message: err instanceof Error ? err.message.slice(0, 100) : '' });
    }
  }
}

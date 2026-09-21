import { create } from 'zustand';
import type { AppSettings, DeepPartial } from '@shared/settings';
import type { UserProfile } from '@shared/types';
import { call, errorMessage } from '@/services/api';

export type Route = 'dashboard' | 'interviews' | 'preparation' | 'live' | 'mock' | 'questions' | 'stories' | 'history' | 'settings';

export interface NavParams {
  interviewId?: string | null;
  settingsTab?: string;
  practiceQuestion?: string;
  sessionId?: string;
  openNew?: boolean;
}

export interface Toast {
  id: number;
  kind: 'info' | 'ok' | 'bad';
  message: string;
}

interface AppState {
  ready: boolean;
  route: Route;
  params: NavParams;
  settings: AppSettings | null;
  profile: UserProfile | null;
  toasts: Toast[];
  online: boolean;
  navCollapsed: boolean;
  liveRunning: boolean;
  /** Last interview the user worked with; used as the default for Live / Mock / Preparation. */
  activeInterviewId: string | null;

  init: () => Promise<void>;
  navigate: (route: Route, params?: NavParams) => void;
  updateSettings: (patch: DeepPartial<AppSettings>) => Promise<AppSettings | null>;
  updateProfile: (patch: Partial<Omit<UserProfile, 'updatedAt'>>) => Promise<void>;
  toast: (message: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
  setOnline: (v: boolean) => void;
  setLiveRunning: (v: boolean) => void;
  setActiveInterview: (id: string | null) => void;
  toggleNav: () => void;
}

let toastId = 0;

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  route: 'dashboard',
  params: {},
  settings: null,
  profile: null,
  toasts: [],
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  navCollapsed: false,
  liveRunning: false,
  activeInterviewId: null,

  async init() {
    try {
      const [settings, profile] = await Promise.all([call('settings.get'), call('profile.get')]);
      const last = localStorageGet('candor.activeInterview');
      set({ settings, profile, ready: true, activeInterviewId: last });
    } catch (err) {
      set({ ready: true });
      get().toast(errorMessage(err), 'bad');
    }
  },

  navigate(route, params = {}) {
    set({ route, params });
  },

  async updateSettings(patch) {
    try {
      const settings = await call('settings.update', patch);
      set({ settings });
      return settings;
    } catch (err) {
      get().toast(errorMessage(err), 'bad');
      return null;
    }
  },

  async updateProfile(patch) {
    try {
      const profile = await call('profile.update', patch);
      set({ profile });
    } catch (err) {
      get().toast(errorMessage(err), 'bad');
    }
  },

  toast(message, kind = 'info') {
    const id = ++toastId;
    if (kind === 'info' && get().settings?.notifications.toasts === false) return;
    if (get().toasts.some((t) => t.message === message && t.kind === kind)) return; // already showing
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, message }] }));
    setTimeout(() => get().dismissToast(id), kind === 'bad' ? 7000 : 3800);
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  setOnline: (online) => set({ online }),
  setLiveRunning: (liveRunning) => set({ liveRunning }),
  setActiveInterview(id) {
    localStorageSet('candor.activeInterview', id);
    set({ activeInterviewId: id });
  },
  toggleNav: () => set((s) => ({ navCollapsed: !s.navCollapsed })),
}));

function localStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function localStorageSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage can be unavailable; the app works without it */
  }
}

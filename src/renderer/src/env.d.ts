/// <reference types="vite/client" />
import type { DesktopApi } from '@shared/ipc';

declare global {
  interface Window {
    api: DesktopApi;
  }
}

declare module '*.js?url' {
  const url: string;
  export default url;
}

export {};

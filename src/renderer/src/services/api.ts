import type { AllPush, RpcChannel, RpcReq, RpcRes } from '@shared/ipc';

/** Typed access to the main process. All app data and every network call lives behind these channels. */
export function call<K extends RpcChannel>(channel: K, ...args: RpcReq<K> extends void ? [] : [RpcReq<K>]): Promise<RpcRes<K>> {
  return window.api.invoke(channel, ...args);
}

export function subscribe<K extends keyof AllPush>(channel: K, cb: (payload: AllPush[K]) => void): () => void {
  return window.api.on(channel, cb);
}

export function sendAudio(source: 'mic' | 'system', pcm: ArrayBuffer): void {
  window.api.sendAudio(source, pcm);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === 'string' ? err : 'Something went wrong.';
}

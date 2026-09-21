import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AllPush, Rpc, RpcChannel, RpcReq, RpcRes } from '../../src/shared/ipc';
import { dispatch } from '../../src/main/ipc/dispatch';
import { createHandlers } from '../../src/main/ipc/handlers';
import type { CredentialSource } from '../../src/main/ai/googleAuth';
import { createServices, type LocalSpeechOptions, type PlatformBridge, type PushEmit } from '../../src/main/services';
import { fakeCipher, nodeHttp } from './gatewayHarness';

export interface Pushed {
  channel: keyof AllPush;
  payload: unknown;
}

/** The whole main process (services + IPC dispatch) minus Electron, backed by a temp database. */
export function makeApp(opts: { env?: NodeJS.ProcessEnv; sttUrls?: { deepgram?: string; assemblyai?: string }; googleCredentials?: CredentialSource; localSpeech?: LocalSpeechOptions; /** Reuse an existing data folder (to test that data survives a restart). */ dir?: string } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'candor-test-'));
  const pushed: Pushed[] = [];
  const clipboard: string[] = [];
  const files: { name: string; contents: string }[] = [];
  const emit: PushEmit = (channel, payload) => {
    pushed.push({ channel, payload });
  };
  const platform: PlatformBridge = {
    pickFile: () => Promise.resolve(null),
    openExternal: () => Promise.resolve(),
    openSystemSettings: () => Promise.resolve(),
    setKeepOnTop: () => undefined,
    notify: () => undefined,
    saveFile: (name, contents) => {
      files.push({ name, contents });
      return Promise.resolve(join(dir, name));
    },
    writeClipboard: (t) => {
      clipboard.push(t);
      return Promise.resolve();
    },
    info: () => ({ name: 'Candor', version: 'test', electron: 'x', chrome: 'x', node: process.version, platform: process.platform, isPackaged: false, userDataPath: dir, startupMs: 1, logPath: join(dir, 'logs') }),
    hotkeyStatus: () => ({}) as never,
    reregisterHotkeys: () => undefined,
    setSystemAudioArmed: () => undefined,
    memoryMB: () => 1,
  };
  const services = createServices({ dbPath: join(dir, 'candor.db'), cipher: fakeCipher, env: opts.env ?? {}, http: nodeHttp, platform, emit, sttUrls: opts.sttUrls, googleCredentials: opts.googleCredentials, localSpeech: opts.localSpeech });
  const handlers = createHandlers(services);
  const call = <K extends RpcChannel>(channel: K, ...args: RpcReq<K> extends void ? [] : [RpcReq<K>]): Promise<RpcRes<K>> => dispatch(handlers, channel, args[0]) as Promise<RpcRes<K>>;
  const events = <K extends keyof AllPush>(channel: K): AllPush[K][] => pushed.filter((p) => p.channel === channel).map((p) => p.payload as AllPush[K]);
  return {
    dir,
    services,
    call,
    pushed,
    events,
    clipboard,
    files,
    /** Shut down. Pass `{ keepData: true }` to leave the data folder for a restart test. */
    async close(o: { keepData?: boolean } = {}) {
      await services.dispose();
      if (!o.keepData) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type App = ReturnType<typeof makeApp>;
export type RpcMap = Rpc;

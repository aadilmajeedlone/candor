import workletUrl from './pcm-worklet.js?url';
import { call } from '@/services/api';

export interface CaptureOptions {
  deviceId?: string | null;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
}

export interface CaptureHandle {
  source: 'mic' | 'system';
  stop(): Promise<void>;
  /** Audio pipeline latency reported by the browser (context base latency + one 40 ms frame). */
  pipelineMs: number;
  label: string;
}

export class CaptureError extends Error {
  constructor(
    message: string,
    readonly kind: 'denied' | 'no-device' | 'busy' | 'unsupported' | 'other',
  ) {
    super(message);
  }
}

function explain(err: unknown, source: 'mic' | 'system'): CaptureError {
  const name = (err as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new CaptureError(source === 'mic' ? 'Microphone access was denied. Allow it in Windows Settings → Privacy & security → Microphone (including “Let desktop apps access your microphone”).' : 'System audio capture was blocked.', 'denied');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return new CaptureError(source === 'mic' ? 'No microphone was found (or the selected one is unplugged).' : 'No audio output was found to capture.', 'no-device');
  if (name === 'NotReadableError' || name === 'AbortError') return new CaptureError('The audio device is busy or unavailable. Close other apps using it and try again.', 'busy');
  return new CaptureError(err instanceof Error ? err.message : 'Audio capture failed.', 'other');
}

export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput');
  } catch {
    return [];
  }
}

async function open(source: 'mic' | 'system', o: CaptureOptions): Promise<MediaStream> {
  if (source === 'mic') {
    return navigator.mediaDevices.getUserMedia({
      audio: { deviceId: o.deviceId ? { exact: o.deviceId } : undefined, channelCount: 1, noiseSuppression: o.noiseSuppression, echoCancellation: o.echoCancellation, autoGainControl: o.autoGainControl },
    });
  }
  // System audio: the main process grants WASAPI loopback only while armed by this explicit user action.
  await call('audio.arm', { system: true });
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1, width: 1, height: 1 }, audio: true });
    stream.getVideoTracks().forEach((t) => {
      t.stop();
      stream.removeTrack(t);
    });
    if (stream.getAudioTracks().length === 0) throw new CaptureError('No system audio track was provided. On Windows, make sure an audio output device is active.', 'unsupported');
    return stream;
  } finally {
    await call('audio.arm', { system: false }).catch(() => undefined);
  }
}

/**
 * Capture audio, resample to 16 kHz mono in the browser's audio engine, and deliver 40 ms PCM16 frames.
 * Nothing is captured until this is called, and stop() releases the device.
 */
export async function startCapture(source: 'mic' | 'system', o: CaptureOptions, onChunk: (pcm: ArrayBuffer) => void, onLevel?: (rms: number) => void): Promise<CaptureHandle> {
  let stream: MediaStream;
  try {
    stream = await open(source, o);
  } catch (err) {
    throw err instanceof CaptureError ? err : explain(err, source);
  }
  const ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
  try {
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, 'pcm-processor', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
    node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      onChunk(e.data.pcm);
      onLevel?.(e.data.rms);
    };
    ctx.createMediaStreamSource(stream).connect(node);
    if (ctx.state === 'suspended') await ctx.resume();
    const track = stream.getAudioTracks()[0];
    return {
      source,
      label: track?.label ?? source,
      pipelineMs: Math.round(((ctx.baseLatency || 0) + 0.04) * 1000),
      async stop() {
        node.port.onmessage = null;
        node.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        await ctx.close().catch(() => undefined);
      },
    };
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close().catch(() => undefined);
    throw explain(err, source);
  }
}

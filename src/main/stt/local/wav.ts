export interface Pcm16Audio {
  /** Little-endian PCM16 samples, no header. */
  bytes: Uint8Array;
  sampleRate: number;
  channels: number;
  seconds: number;
}

/** Read a PCM16 WAV file. Only what the speech pipeline uses is supported; anything else is a clear error. */
export function parseWavPcm16(file: Uint8Array): Pcm16Audio {
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const tag = (o: number): string => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (file.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file.');
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let offset = 12;
  while (offset + 8 <= file.byteLength) {
    const id = tag(offset);
    const size = v.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') fmt = { format: v.getUint16(body, true), channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    if (id === 'data') {
      if (!fmt) throw new Error('WAV data before its format.');
      if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('Only 16-bit PCM WAV is supported.');
      const end = Math.min(file.byteLength, body + size);
      const bytes = file.subarray(body, body + ((end - body) & ~1));
      return { bytes, sampleRate: fmt.rate, channels: fmt.channels, seconds: bytes.byteLength / 2 / fmt.channels / fmt.rate };
    }
    offset = body + size + (size & 1);
  }
  throw new Error('WAV has no audio data.');
}

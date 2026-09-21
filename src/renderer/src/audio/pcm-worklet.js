// Runs on the audio rendering thread. Collects 128-sample render quanta into 40 ms frames (640 samples at 16 kHz),
// converts to 16-bit PCM and posts them (with an RMS level) to the page. Plain JavaScript: worklets are not bundled.
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = 640;
    this.buf = new Float32Array(this.frame * 2);
    this.len = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.len++] = ch[i];
      if (this.len === this.frame) {
        const out = new Int16Array(this.frame);
        let sum = 0;
        for (let j = 0; j < this.frame; j++) {
          const s = Math.max(-1, Math.min(1, this.buf[j]));
          out[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
          sum += s * s;
        }
        this.port.postMessage({ pcm: out.buffer, rms: Math.sqrt(sum / this.frame) }, [out.buffer]);
        this.len = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-processor', PcmProcessor);

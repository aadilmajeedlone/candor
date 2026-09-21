import { AiError } from '@shared/errors';
import type { LlmGateway, LlmGenerateRequest, LlmGenerateResult } from '@core/live/types';

/** Scriptable LLM for engine tests. Streams word by word on the (fake) timer so tests control time. */
export class FakeLlm implements LlmGateway {
  calls: LlmGenerateRequest[] = [];
  firstTokenDelay = 120;
  tokenDelay = 25;
  answer = 'In my current role I managed a team of 14 support agents. We cut average handling time by 22% by redesigning the returns workflow.';
  /** Keep emitting tokens even after abort, to prove the engine ignores stale output. */
  ignoreAbort = false;
  failWith: AiError | null = null;
  finishReason: LlmGenerateResult['finishReason'] = 'stop';
  warmed = 0;

  warm(): Promise<void> {
    this.warmed++;
    return Promise.resolve();
  }

  generate(req: LlmGenerateRequest): Promise<LlmGenerateResult> {
    this.calls.push(req);
    const toks = this.answer.match(/\S+\s*/g) ?? [];
    return new Promise((resolve, reject) => {
      if (this.failWith) {
        const err = this.failWith;
        setTimeout(() => reject(err), 10);
        return;
      }
      let i = 0;
      const step = (): void => {
        if (req.signal.aborted && !this.ignoreAbort) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        if (i < toks.length) {
          req.onToken?.(toks[i++] ?? '');
          setTimeout(step, this.tokenDelay);
        } else {
          resolve({ text: toks.join(''), finishReason: this.finishReason, model: 'fake-fast', provider: 'fake', usedFallback: false });
        }
      };
      setTimeout(step, this.firstTokenDelay);
    });
  }
}

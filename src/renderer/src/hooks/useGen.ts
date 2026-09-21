import { useCallback, useEffect, useRef, useState } from 'react';
import type { GenEvent } from '@shared/events';
import { call, errorMessage, subscribe } from '@/services/api';

export interface GenState {
  text: string;
  streaming: boolean;
  error: string | null;
  model: string | null;
  ttftMs: number | null;
  notice: string | null;
}

/**
 * Follow one streamed generation started through an RPC that returns `{ requestId }`. Events that arrive before
 * the request id is known are buffered, so the first tokens are never lost.
 */
export function useGen() {
  const [state, setState] = useState<GenState>({ text: '', streaming: false, error: null, model: null, ttftMs: null, notice: null });
  const target = useRef<string | null>(null);
  const buffer = useRef<GenEvent[]>([]);
  const waiting = useRef(false);

  const apply = useCallback((e: GenEvent) => {
    if (e.type === 'token') setState((s) => ({ ...s, text: s.text + e.text }));
    else if (e.type === 'done') setState((s) => ({ ...s, text: e.text, streaming: false, model: e.model, ttftMs: e.ttftMs }));
    else if (e.type === 'error') setState((s) => ({ ...s, streaming: false, error: e.code === 'aborted' ? null : e.message }));
    else if (e.type === 'notice') setState((s) => ({ ...s, notice: e.message }));
  }, []);

  useEffect(
    () =>
      subscribe('gen.event', (e) => {
        if (waiting.current) buffer.current.push(e);
        else if (e.requestId === target.current) apply(e);
      }),
    [apply],
  );

  const start = useCallback(
    async (begin: () => Promise<{ requestId: string }>) => {
      setState({ text: '', streaming: true, error: null, model: null, ttftMs: null, notice: null });
      target.current = null;
      buffer.current = [];
      waiting.current = true;
      try {
        const { requestId } = await begin();
        target.current = requestId;
        waiting.current = false;
        for (const e of buffer.current) if (e.requestId === requestId) apply(e);
        buffer.current = [];
      } catch (err) {
        waiting.current = false;
        setState((s) => ({ ...s, streaming: false, error: errorMessage(err) }));
      }
    },
    [apply],
  );

  const cancel = useCallback(() => {
    if (target.current) void call('gen.cancel', { requestId: target.current }).catch(() => undefined);
  }, []);

  const reset = useCallback((text = '') => {
    target.current = null;
    setState({ text, streaming: false, error: null, model: null, ttftMs: null, notice: null });
  }, []);

  return { ...state, start, cancel, reset };
}

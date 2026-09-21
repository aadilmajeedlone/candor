import { errorMessage } from '@/services/api';
import { useApp } from '@/store/app';

/**
 * Wrap an async UI handler so that a failure becomes a visible message instead of an unhandled promise rejection.
 * Handlers that already catch their own errors are unaffected.
 */
export function guarded<A extends unknown[]>(fn: (...args: A) => unknown): (...args: A) => void {
  return (...args: A): void => {
    let result: unknown;
    try {
      result = fn(...args);
    } catch (err) {
      useApp.getState().toast(errorMessage(err), 'bad');
      return;
    }
    if (result instanceof Promise) {
      result.catch((err: unknown) => useApp.getState().toast(errorMessage(err), 'bad'));
    }
  };
}

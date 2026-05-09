// Global window typing for the preload bridge.

import type { SigmaPreloadApi } from '../../electron/preload';

declare global {
  interface Window {
    sigma: SigmaPreloadApi;
  }
}

export {};

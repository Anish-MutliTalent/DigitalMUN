/**
 * @mun/desktop renderer — API wrapper
 *
 * Thin typed access to the preload bridge (`window.mun`). The Zustand store
 * subscribes to the push channels here; components call the invoke methods.
 */

import type { MunApi } from '@shared/ipc';

export const api: MunApi = window.mun;

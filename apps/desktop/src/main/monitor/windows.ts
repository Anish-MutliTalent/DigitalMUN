/**
 * @mun/desktop — Windows monitoring via Win32 (koffi FFI)
 *
 * Captures ONLY integrity-relevant metadata:
 *  - Foreground window handle + its title (GetForegroundWindow / GetWindowTextW)
 *  - The foreground process name (GetWindowThreadProcessId + QueryFullProcessImageNameW)
 *  - System-wide idle time (GetLastInputInfo + GetTickCount64)
 *
 * koffi is imported at the top level (it ships prebuilt binaries for Windows,
 * macOS, and Linux, so the import succeeds everywhere). The Win32 libraries
 * (user32/kernel32) are only loaded inside initWin32(), which is only called
 * from the constructor — and the constructor is only instantiated on Windows
 * (see platform.ts). No screenshots, document contents, keystrokes, clipboard,
 * audio, or video are ever read.
 */

import koffi, { type IKoffiCType } from 'koffi';
import { basename } from 'node:path';
import type { ForegroundSample, Monitor } from './platform.js';

interface Win32 {
  GetForegroundWindow: () => unknown;
  GetWindowTextW: (hwnd: unknown, buf: unknown, count: number) => number;
  GetWindowThreadProcessId: (hwnd: unknown, pidPtr: unknown) => number;
  OpenProcess: (access: number, inherit: number, pid: number) => unknown;
  QueryFullProcessImageNameW: (hProc: unknown, flags: number, buf: unknown, sizePtr: unknown) => number;
  CloseHandle: (h: unknown) => number;
  GetLastInputInfo: (liiPtr: unknown) => number;
  GetTickCount64: () => bigint;
}

let _win32: Win32 | null = null;
let _liiType: IKoffiCType | null = null;
let _loadError: string | null = null;

function initWin32(): { w: Win32; liiType: IKoffiCType } {
  if (_win32 && _liiType) return { w: _win32, liiType: _liiType };
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  _liiType = koffi.struct('LASTINPUTINFO', { cbSize: 'uint32_t', dwTime: 'uint32_t' });
  _win32 = {
    GetForegroundWindow: user32.func('void *GetForegroundWindow()') as () => unknown,
    GetWindowTextW: user32.func(
      'int __stdcall GetWindowTextW(void *hWnd, uint16_t *lpString, int nMaxCount)',
    ) as (hwnd: unknown, buf: unknown, count: number) => number,
    GetWindowThreadProcessId: user32.func(
      'uint32_t __stdcall GetWindowThreadProcessId(void *hWnd, uint32_t *lpdwProcessId)',
    ) as (hwnd: unknown, pidPtr: unknown) => number,
    OpenProcess: kernel32.func(
      'void *OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)',
    ) as (access: number, inherit: number, pid: number) => unknown,
    QueryFullProcessImageNameW: kernel32.func(
      'int QueryFullProcessImageNameW(void *hProcess, uint32_t dwFlags, uint16_t *lpExeName, uint32_t *lpdwSize)',
    ) as (hProc: unknown, flags: number, buf: unknown, sizePtr: unknown) => number,
    CloseHandle: kernel32.func('int CloseHandle(void *hObject)') as (h: unknown) => number,
    GetLastInputInfo: user32.func(
      'int __stdcall GetLastInputInfo(LASTINPUTINFO *pli)',
    ) as (liiPtr: unknown) => number,
    GetTickCount64: kernel32.func('uint64_t GetTickCount64()') as () => bigint,
  };
  return { w: _win32, liiType: _liiType };
}

function isNullPtr(p: unknown): boolean {
  return p === null || p === undefined || p === 0 || p === 0n;
}

function readWString(buf: unknown, len: number): string {
  if (len <= 0) return '';
  const bytes = koffi.decode(buf, 'uint8_t', len * 2) as number[];
  return Buffer.from(bytes).toString('utf16le');
}

export class WindowsMonitor implements Monitor {
  private w!: Win32;
  private liiType!: IKoffiCType;
  private titleBuf: unknown;
  private pidBuf: unknown;
  private nameBuf: unknown;
  private sizeBuf: unknown;
  private liiBuf: unknown;

  constructor() {
    try {
      const { w, liiType } = initWin32();
      this.w = w;
      this.liiType = liiType;
      this.titleBuf = koffi.alloc('uint16_t', 512);
      this.pidBuf = koffi.alloc('uint32_t', 1);
      this.nameBuf = koffi.alloc('uint16_t', 260);
      this.sizeBuf = koffi.alloc('uint32_t', 1);
      this.liiBuf = koffi.alloc(liiType, 1);
    } catch (err) {
      _loadError = (err as Error).message;
      throw err;
    }
  }

  supportsTitle(): boolean {
    return true;
  }

  status(): string {
    return _loadError ? `Windows monitor error: ${_loadError}` : 'Windows monitoring active';
  }

  sample(): ForegroundSample | null {
    if (!this.w) return null;
    try {
      const hwnd = this.w.GetForegroundWindow();
      if (isNullPtr(hwnd)) {
        return { appName: null, title: null, idleMs: this.idleMs() };
      }

      let title: string | null = null;
      try {
        const len = this.w.GetWindowTextW(hwnd, this.titleBuf, 512);
        title = readWString(this.titleBuf, len) || null;
      } catch {
        title = null;
      }

      let appName: string | null = null;
      try {
        this.w.GetWindowThreadProcessId(hwnd, this.pidBuf);
        const pidArr = koffi.decode(this.pidBuf, 'uint32_t', 1) as number[];
        const pid = pidArr[0];
        if (pid) {
          const hProc = this.w.OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, 0, pid);
          if (!isNullPtr(hProc)) {
            koffi.encode(this.sizeBuf, 'uint32_t', 260);
            const ok = this.w.QueryFullProcessImageNameW(hProc, 0, this.nameBuf, this.sizeBuf);
            if (ok) {
              const sizeArr = koffi.decode(this.sizeBuf, 'uint32_t', 1) as number[];
              const path = readWString(this.nameBuf, sizeArr[0]);
              appName = basename(path).toLowerCase() || null;
            }
            this.w.CloseHandle(hProc);
          }
        }
      } catch {
        /* leave appName null */
      }

      return { appName, title, idleMs: this.idleMs() };
    } catch {
      return null;
    }
  }

  private idleMs(): number {
    try {
      koffi.encode(this.liiBuf, this.liiType, { cbSize: 8, dwTime: 0 });
      this.w.GetLastInputInfo(this.liiBuf);
      const lii = koffi.decode(this.liiBuf, this.liiType, 1) as Array<{
        cbSize: number;
        dwTime: number;
      }>;
      const lastInput = lii[0]?.dwTime ?? 0;
      const now = Number(this.w.GetTickCount64());
      let diff = now - lastInput;
      if (diff < 0) diff += 0x100000000;
      return Math.max(0, diff);
    } catch {
      return 0;
    }
  }

  dispose(): void {
    // koffi library handles stay for process lifetime; nothing to free explicitly.
  }
}

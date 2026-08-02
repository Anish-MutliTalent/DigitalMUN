// Verifies the Win32 foreground/idle FFI (koffi) works outside Electron.
// Run: node scripts/verify-koffi.mjs
import { createRequire } from 'node:module';
import { basename } from 'node:path';

const require = createRequire(import.meta.url);
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const LASTINPUTINFO = koffi.struct('LASTINPUTINFO', { cbSize: 'uint32_t', dwTime: 'uint32_t' });

const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hWnd, uint16_t *lpString, int nMaxCount)');
const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hWnd, uint32_t *lpdwProcessId)');
const OpenProcess = kernel32.func('void *OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)');
const QueryFullProcessImageNameW = kernel32.func('int QueryFullProcessImageNameW(void *hProcess, uint32_t dwFlags, uint16_t *lpExeName, uint32_t *lpdwSize)');
const CloseHandle = kernel32.func('int CloseHandle(void *hObject)');
const GetLastInputInfo = user32.func('int __stdcall GetLastInputInfo(LASTINPUTINFO *pli)');
const GetTickCount64 = kernel32.func('uint64_t GetTickCount64()');

function isNull(p) { return p === null || p === undefined || p === 0 || p === 0n; }
function readW(buf, len) {
  if (len <= 0) return '';
  const bytes = koffi.decode(buf, 'uint8_t', len * 2);
  return Buffer.from(bytes).toString('utf16le');
}

const titleBuf = koffi.alloc('uint16_t', 512);
const pidBuf = koffi.alloc('uint32_t', 1);
const nameBuf = koffi.alloc('uint16_t', 260);
const sizeBuf = koffi.alloc('uint32_t', 1);
const liiType = LASTINPUTINFO;
const liiBuf = koffi.alloc(liiType, 1);

function sample() {
  const hwnd = GetForegroundWindow();
  if (isNull(hwnd)) return { app: null, title: null, idle: 0 };
  const len = GetWindowTextW(hwnd, titleBuf, 512);
  const title = readW(titleBuf, len) || null;
  let app = null;
  GetWindowThreadProcessId(hwnd, pidBuf);
  const pid = koffi.decode(pidBuf, 'uint32_t', 1)[0];
  if (pid) {
    const hProc = OpenProcess(0x1000, 0, pid);
    if (!isNull(hProc)) {
      koffi.encode(sizeBuf, 'uint32_t', 260);
      const ok = QueryFullProcessImageNameW(hProc, 0, nameBuf, sizeBuf);
      if (ok) {
        const size = koffi.decode(sizeBuf, 'uint32_t', 1)[0];
        app = basename(readW(nameBuf, size)).toLowerCase() || null;
      }
      CloseHandle(hProc);
    }
  }
  koffi.encode(liiBuf, liiType, { cbSize: 8, dwTime: 0 });
  GetLastInputInfo(liiBuf);
  const lii = koffi.decode(liiBuf, liiType, 1)[0];
  const now = Number(GetTickCount64());
  let idle = now - lii.dwTime;
  if (idle < 0) idle += 0x100000000;
  return { app, title, idle: Math.max(0, idle) };
}

console.log('koffi Win32 verification — sampling foreground for 5 seconds. Switch windows to see changes.');
for (let i = 0; i < 5; i++) {
  const s = sample();
  console.log(`[${i + 1}] app=${s.app} | title=${s.title ?? ''} | idle=${s.idle}ms`);
  await new Promise((r) => setTimeout(r, 1000));
}
console.log('koffi verification complete.');

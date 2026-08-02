/**
 * @mun/desktop — IPC registration
 *
 * Wires every MunApi method to the MunBackend and forwards realtime +
 * state pushes to the renderer window. Created with the BrowserWindow so it can
 * target the correct webContents.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { MunBackend } from './backend.js';
import { IPC } from '@shared/ipc';

export function createBackend(window: BrowserWindow): MunBackend {
  const webContents = window.webContents;

  const backend = new MunBackend(
    {
      sendToRenderer: (env) => {
        if (!webContents.isDestroyed()) webContents.send(IPC.EVENT, env);
      },
      onConnection: (info) => {
        if (!webContents.isDestroyed()) webContents.send(IPC.CONNECTION, info);
      },
      onMonitoring: (state) => {
        if (!webContents.isDestroyed()) webContents.send(IPC.MONITORING, state);
      },
    },
    process.platform === 'darwin' ? 'macos' : 'windows',
  );

  ipcMain.handle(IPC.LOGIN, (_e, username: string, password: string) => backend.login(username, password));
  ipcMain.handle(IPC.JOIN, (_e, committeeId: string, country: string) =>
    backend.join(committeeId, country),
  );
  ipcMain.handle(IPC.GET_JOIN_OPTIONS, () => backend.getJoinOptions());
  ipcMain.handle(IPC.LOGOUT, () => backend.logout());
  ipcMain.handle(IPC.REFRESH, () => backend.refreshSession());
  ipcMain.handle(IPC.GET_STATE, () => backend.getState());
  ipcMain.handle(IPC.CLEAR_STATE, () => backend.clearState());
  ipcMain.handle(IPC.CAST_VOTE, (_e, voteId: string, choice: 'for' | 'against') =>
    backend.castVote(voteId, choice),
  );
  ipcMain.handle(IPC.REQUEST_RELOGIN, (_e, reason: string) => backend.requestRelogin(reason));
  ipcMain.handle(IPC.CANCEL_RELOGIN, (_e, requestId: string) => backend.cancelRelogin(requestId));
  ipcMain.handle(IPC.SET_SERVER_URL, (_e, url: string) => backend.setServerUrl(url));
  ipcMain.handle(IPC.GET_SERVER_URL, () => backend.getServerUrl());
  ipcMain.handle(IPC.GET_SERVER_PUBLIC_KEY, () => backend.getServerPublicKey());
  ipcMain.handle(IPC.GET_CONNECTION, () => backend.getConnection());
  ipcMain.handle(IPC.GET_MONITORING, () => backend.getMonitoring());
  ipcMain.handle(IPC.GET_PLATFORM, () => (process.platform === 'darwin' ? 'macos' : 'windows'));
  ipcMain.handle(
    IPC.API_REQUEST,
    (_e, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) =>
      backend.apiRequest(method, path, body),
  );
  ipcMain.handle(IPC.SUBMIT_LINK, (_e, cid: string, type, title, url) =>
    backend.submitLinkSubmission(cid, type, title, url),
  );
  ipcMain.handle(IPC.SUBMIT_FILE, (_e, cid: string, type, title, filePath: string) =>
    backend.submitFileSubmission(cid, type, title, filePath),
  );
  ipcMain.handle(IPC.PICK_FILE, () => backend.pickFile());
  ipcMain.handle(IPC.LIST_SUBMISSIONS, (_e, cid: string) => backend.listSubmissions(cid));
  ipcMain.handle(IPC.MARK_SUBMISSION_REVIEWED, (_e, cid: string, id: string) =>
    backend.markSubmissionReviewed(cid, id),
  );
  ipcMain.handle(IPC.DELETE_SUBMISSION, (_e, cid: string, id: string) =>
    backend.deleteSubmission(cid, id),
  );
  ipcMain.handle(IPC.OPEN_SUBMISSION_FILE, (_e, cid: string, id: string, fileName: string) =>
    backend.openSubmissionFile(cid, id, fileName),
  );
  ipcMain.handle(IPC.OPEN_SUBMISSION_LINK, (_e, url: string) => backend.openSubmissionLink(url));

  return backend;
}

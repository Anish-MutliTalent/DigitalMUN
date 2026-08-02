/**
 * @mun/desktop — preload bridge
 *
 * Exposes a minimal, typed `window.mun` API to the renderer via contextBridge.
 * The renderer has no Node access — only these explicitly exposed methods.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type MunApi } from '@shared/ipc';

const api: MunApi = {
  login: (username, password) => ipcRenderer.invoke(IPC.LOGIN, username, password),
  join: (committeeId, country) => ipcRenderer.invoke(IPC.JOIN, committeeId, country),
  getJoinOptions: () => ipcRenderer.invoke(IPC.GET_JOIN_OPTIONS),
  logout: () => ipcRenderer.invoke(IPC.LOGOUT),
  refreshSession: () => ipcRenderer.invoke(IPC.REFRESH),
  getState: () => ipcRenderer.invoke(IPC.GET_STATE),
  clearState: () => ipcRenderer.invoke(IPC.CLEAR_STATE),
  castVote: (voteId, choice) => ipcRenderer.invoke(IPC.CAST_VOTE, voteId, choice),
  requestRelogin: (reason) => ipcRenderer.invoke(IPC.REQUEST_RELOGIN, reason),
  cancelRelogin: (requestId) => ipcRenderer.invoke(IPC.CANCEL_RELOGIN, requestId),
  setServerUrl: (url) => ipcRenderer.invoke(IPC.SET_SERVER_URL, url),
  getServerUrl: () => ipcRenderer.invoke(IPC.GET_SERVER_URL),
  getServerPublicKey: () => ipcRenderer.invoke(IPC.GET_SERVER_PUBLIC_KEY),
  getConnection: () => ipcRenderer.invoke(IPC.GET_CONNECTION),
  getMonitoring: () => ipcRenderer.invoke(IPC.GET_MONITORING),
  getPlatform: () => ipcRenderer.invoke(IPC.GET_PLATFORM),
  apiRequest: (method, path, body) => ipcRenderer.invoke(IPC.API_REQUEST, method, path, body),
  submitLinkSubmission: (cid, type, title, url) =>
    ipcRenderer.invoke(IPC.SUBMIT_LINK, cid, type, title, url),
  submitFileSubmission: (cid, type, title, filePath) =>
    ipcRenderer.invoke(IPC.SUBMIT_FILE, cid, type, title, filePath),
  pickFile: () => ipcRenderer.invoke(IPC.PICK_FILE),
  listSubmissions: (cid) => ipcRenderer.invoke(IPC.LIST_SUBMISSIONS, cid),
  markSubmissionReviewed: (cid, id) => ipcRenderer.invoke(IPC.MARK_SUBMISSION_REVIEWED, cid, id),
  deleteSubmission: (cid, id) => ipcRenderer.invoke(IPC.DELETE_SUBMISSION, cid, id),
  openSubmissionFile: (cid, id, fileName) =>
    ipcRenderer.invoke(IPC.OPEN_SUBMISSION_FILE, cid, id, fileName),
  openSubmissionLink: (url) => ipcRenderer.invoke(IPC.OPEN_SUBMISSION_LINK, url),
  onEvent: (listener) => {
    const handler = (_e: unknown, env: Parameters<typeof listener>[0]) => listener(env);
    ipcRenderer.on(IPC.EVENT, handler);
    return () => ipcRenderer.removeListener(IPC.EVENT, handler);
  },
  onConnection: (listener) => {
    const handler = (_e: unknown, info: Parameters<typeof listener>[0]) => listener(info);
    ipcRenderer.on(IPC.CONNECTION, handler);
    return () => ipcRenderer.removeListener(IPC.CONNECTION, handler);
  },
  onMonitoring: (listener) => {
    const handler = (_e: unknown, state: Parameters<typeof listener>[0]) => listener(state);
    ipcRenderer.on(IPC.MONITORING, handler);
    return () => ipcRenderer.removeListener(IPC.MONITORING, handler);
  },
};

contextBridge.exposeInMainWorld('mun', api);

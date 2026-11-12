const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("glass", {
  token: refresh => ipcRenderer.invoke("token", !!refresh),
  account: () => ipcRenderer.invoke("account"),
  signIn: () => ipcRenderer.invoke("sign-in"),
  signOut: () => ipcRenderer.invoke("sign-out"),
  lyrics: query => ipcRenderer.invoke("lyrics-external", query),
  musixmatchStatus: () => ipcRenderer.invoke("musixmatch-status"),
  setMusixmatchKey: key => ipcRenderer.invoke("musixmatch-key", key),
  lastfmStatus: () => ipcRenderer.invoke("lastfm-status"),
  setLastfmKey: key => ipcRenderer.invoke("lastfm-key", key),
  lastfmLogAdd: entries => ipcRenderer.invoke("lastfm-log-add", entries),
  lastfmLogForget: ids => ipcRenderer.invoke("lastfm-log-forget", ids),
  lastfmLogClear: () => ipcRenderer.invoke("lastfm-log-clear"),
  lastfmMatch: query => ipcRenderer.invoke("lastfm-match", query),
  onLastfmProgress: cb => ipcRenderer.on("lastfm-progress", (_e, p) => cb(p)),
  window: action => ipcRenderer.send("window", action),
  mprisState: state => ipcRenderer.send("mpris-state", state),
  onMpris: cb => ipcRenderer.on("mpris", (_e, msg) => cb(msg)),
});

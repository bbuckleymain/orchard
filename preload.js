const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("glass", {
  token: refresh => ipcRenderer.invoke("token", !!refresh),
  account: () => ipcRenderer.invoke("account"),
  signIn: () => ipcRenderer.invoke("sign-in"),
  signOut: () => ipcRenderer.invoke("sign-out"),
  lyrics: query => ipcRenderer.invoke("lyrics-external", query),
  musixmatchStatus: () => ipcRenderer.invoke("musixmatch-status"),
  setMusixmatchKey: key => ipcRenderer.invoke("musixmatch-key", key),
  window: action => ipcRenderer.send("window", action),
  mprisState: state => ipcRenderer.send("mpris-state", state),
  onMpris: cb => ipcRenderer.on("mpris", (_e, msg) => cb(msg)),
});

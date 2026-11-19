// What RobinCode.exe adds to its pages (window.robincodeShell): the Windows
// folder dialog, opened by the exe on its own window (the server's way, a
// hidden PowerShell, put the dialog where nobody could see it), and the
// updates of an installed copy (update.cjs).
const { contextBridge, ipcRenderer } = require("electron");

// the window is acrylic glass (main.cjs): the page's colours let it through
// (styles.css, html.glass). A browser tab has no glass and keeps them solid.
window.addEventListener("DOMContentLoaded", () => document.documentElement.classList.add("glass"));

contextBridge.exposeInMainWorld("robincodeShell", {
  // resolves to the chosen folder, or null when robin closed the dialog
  pickFolder: (start) => ipcRenderer.invoke("robincode:pick-folder", typeof start === "string" ? start : ""),
  // null in the repository; else { version, ready, shell, checking, downloading, checkedAt, error }
  updateState: () => ipcRenderer.invoke("robincode:update-state"),
  checkUpdate: () => ipcRenderer.invoke("robincode:update-check"),
  onUpdate: (fn) => {
    const listener = (_e, s) => fn(s);
    ipcRenderer.on("robincode:update", listener);
    return () => ipcRenderer.removeListener("robincode:update", listener);
  },
  relaunch: () => ipcRenderer.invoke("robincode:relaunch"),
});

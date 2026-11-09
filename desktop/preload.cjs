// What RobinCode.exe adds to its pages (window.robincodeShell): the Windows
// folder dialog, opened by the exe on its own window. The server's way
// (a hidden PowerShell) put the dialog where nobody could see it.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("robincodeShell", {
  // resolves to the chosen folder, or null when robin closed the dialog
  pickFolder: (start) => ipcRenderer.invoke("robincode:pick-folder", typeof start === "string" ? start : ""),
});

const { app, BrowserWindow } = require("electron");

const shellUrl = process.argv.at(-1);

if (!shellUrl?.startsWith("http://127.0.0.1:"))
  throw new Error("Electron host needs the local shell-lab URL.");

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 880,
    minHeight: 640,
    title: "Whiteboard Review · Electron shell",
    backgroundColor: "#17181b",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadURL(shellUrl);
});

app.on("window-all-closed", () => app.quit());

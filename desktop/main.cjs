const { app, BrowserWindow, Menu, shell } = require("electron");
const net = require("node:net");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let mainWindow;
let fastifyApp;

function getAssetRoot() {
  return path.join(__dirname, "app");
}

function getFreePort(preferredPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => {
      const fallback = net.createServer();
      fallback.unref();
      fallback.on("error", reject);
      fallback.listen(0, "127.0.0.1", () => {
        const address = fallback.address();
        fallback.close(() => resolve(address.port));
      });
    });
    server.listen(preferredPort, "127.0.0.1", () => {
      server.close(() => resolve(preferredPort));
    });
  });
}

async function startBackend() {
  const assetRoot = getAssetRoot();
  const port = await getFreePort(Number(process.env.PORT ?? 8787));

  process.env.PORT = String(port);
  process.env.HOST = "127.0.0.1";
  process.env.CLIENT_DIST_DIR = path.join(assetRoot, "client", "dist");
  process.env.FLOW_SOCKET_DATA_DIR = app.getPath("userData");

  const serverEntry = path.join(assetRoot, "server", "dist", "index.js");
  const serverModule = await import(pathToFileURL(serverEntry).href);
  fastifyApp = await serverModule.startServer(port, "127.0.0.1");

  return `http://127.0.0.1:${port}`;
}

function createWindow(baseUrl) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: "Flow Socket",
    backgroundColor: "#10151f",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(baseUrl);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const baseUrl = await startBackend();
  createWindow(baseUrl);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(baseUrl);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  if (fastifyApp) {
    await fastifyApp.close().catch(() => {});
  }
});

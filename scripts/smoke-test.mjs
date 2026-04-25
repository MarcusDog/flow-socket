import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let BASE_URL = process.env.BASE_URL;
const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let serverProcess;
let tempDataDir;

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      await requestJson("/api/system/status");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error("Server did not become ready in time.");
}

async function startTempServerIfNeeded() {
  if (BASE_URL) {
    return;
  }

  const port = 18000 + Math.floor(Math.random() * 1000);
  BASE_URL = `http://127.0.0.1:${port}`;
  tempDataDir = await mkdtemp(path.join(tmpdir(), "flow-socket-smoke-"));
  serverProcess = spawn("pnpm", ["--dir", "server", "start"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      FLOW_SOCKET_DATA_DIR: tempDataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess.stdout.on("data", () => {});
  serverProcess.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  await waitForServer();
}

async function stopTempServer() {
  if (serverProcess) {
    serverProcess.kill();
    await new Promise((resolve) => serverProcess.once("exit", resolve));
  }
  if (tempDataDir) {
    await rm(tempDataDir, { recursive: true, force: true });
  }
}

async function requestJson(path, init = {}, token) {
  const hasBody = typeof init.body !== "undefined";
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${response.status} ${data.error ?? response.statusText}`);
  }
  return data;
}

async function register(label) {
  return requestJson("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      username: `smoke_${label}_${runId}`,
      password: "password123",
      displayName: `Smoke ${label}`,
      deviceName: `Smoke ${label} Device`,
    }),
  });
}

function openSocket(token) {
  const wsUrl = new URL(BASE_URL);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.pathname = "/ws";
  wsUrl.searchParams.set("token", token);

  const ws = new WebSocket(wsUrl);
  const events = [];
  ws.on("message", (raw) => events.push(JSON.parse(raw.toString())));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket auth timeout")), 5000);
    ws.on("message", (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === "auth:ready") {
        clearTimeout(timeout);
        resolve({ ws, events });
      }
    });
    ws.on("error", reject);
  });
}

function waitFor(events, predicate, label) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      const found = events.find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${label}`));
      }
    }, 50);
  });
}

await startTempServerIfNeeded();

let alphaSocket;
let betaSocket;

try {
  const alpha = await register("alpha");
  const beta = await register("beta");
  alphaSocket = await openSocket(alpha.token);
  betaSocket = await openSocket(beta.token);

  const { room } = await requestJson(
    "/api/rooms",
    {
      method: "POST",
      body: JSON.stringify({ name: `Smoke Room ${runId}` }),
    },
    alpha.token,
  );

  await requestJson(
    "/api/rooms/join",
    {
      method: "POST",
      body: JSON.stringify({ inviteCode: room.inviteCode }),
    },
    beta.token,
  );

  const joinSystem = await waitFor(
    alphaSocket.events,
    (event) => event.type === "message:system" && /加入了房间/.test(event.payload?.content ?? ""),
    "join system message",
  );

  alphaSocket.ws.send(
    JSON.stringify({
      type: "message:text",
      payload: { roomId: room.id, content: "smoke hello" },
    }),
  );
  const textEvent = await waitFor(
    betaSocket.events,
    (event) => event.type === "message:text" && event.payload?.content === "smoke hello",
    "text message",
  );

  const flagResult = await requestJson(
    `/api/messages/${textEvent.payload.id}/flags`,
    {
      method: "PATCH",
      body: JSON.stringify({ pinned: true, favorited: true }),
    },
    beta.token,
  );

  alphaSocket.ws.send(
    JSON.stringify({
      type: "file:offer",
      payload: {
        clientTransferKey: `smoke-transfer-${runId}`,
        roomId: room.id,
        receiverUserId: beta.user.id,
        receiverDeviceId: "offline-device",
        fileName: "smoke.pdf",
        mimeType: "application/pdf",
        sizeBytes: 512,
      },
    }),
  );
  const queued = await waitFor(alphaSocket.events, (event) => event.type === "file:queued", "queued file");

  await requestJson(`/api/pending-transfers/${queued.payload.pendingTransfer.id}`, { method: "DELETE" }, alpha.token);
  await waitFor(betaSocket.events, (event) => event.type === "pending-transfer:deleted", "pending delete");

  await requestJson(`/api/rooms/${room.id}/leave`, { method: "POST" }, beta.token);
  const leaveSystem = await waitFor(
    alphaSocket.events,
    (event) => event.type === "message:system" && /离开了房间/.test(event.payload?.content ?? ""),
    "leave system message",
  );

  const status = await requestJson("/api/system/status");
  console.log(
    JSON.stringify(
      {
        baseUrl: BASE_URL,
        room: room.name,
        joinSystem: joinSystem.payload.content,
        textMessage: textEvent.payload.content,
        pinned: flagResult.message.pinned,
        favorited: flagResult.message.favorited,
        deletedPendingId: queued.payload.pendingTransfer.id,
        leaveSystem: leaveSystem.payload.content,
        maxFileSizeBytes: status.limits.maxFileSizeBytes,
      },
      null,
      2,
    ),
  );
} finally {
  alphaSocket?.ws.close();
  betaSocket?.ws.close();
  await stopTempServer();
}

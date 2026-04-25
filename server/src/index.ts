import "./env.js";

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { WebSocket, type RawData } from "ws";

import { hashPassword, signToken, verifyPassword, verifyToken } from "./auth.js";
import {
  addUserToRoom,
  createDevice,
  createMessage,
  createPendingTransfer,
  createRoom,
  createTransferLog,
  createUser,
  deleteRoom,
  deletePendingTransfer,
  ensureRoomMembership,
  getAppSetting,
  getDeviceById,
  getDiscoveryHint,
  getMessageById,
  getMessages,
  getPendingTransferById,
  getPendingTransfers,
  getRoomById,
  getRoomDetails,
  getRoomMemberCount,
  getRoomByInviteCode,
  getRoomMembers,
  getUserById,
  getUserCredentials,
  getUserDevices,
  getUserRooms,
  removeUserFromRoom,
  renameDevice,
  setMessageFlags,
  setAppSetting,
  touchDevice,
  updateTransferStatus,
} from "./db.js";
import type { JwtPayload, MessageType, WsEnvelope } from "./types.js";

const app = Fastify({ logger: true });
const PORT = Number(process.env.PORT ?? 8787);
const MAX_MESSAGE_LENGTH = Number(process.env.MAX_MESSAGE_LENGTH ?? 4000);
const MAX_FILE_SIZE_BYTES = Number(process.env.MAX_FILE_SIZE_BYTES ?? 1024 * 1024 * 1024);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(process.env.CLIENT_DIST_DIR ?? path.resolve(MODULE_DIR, "../../client/dist"));
const connectedSockets = new Map<string, WebSocket>();
const roomPresence = new Map<string, Set<string>>();

await app.register(cors, {
  origin: true,
  credentials: false,
});

await app.register(websocket);

if (existsSync(CLIENT_DIST)) {
  await app.register(fastifyStatic, {
    root: CLIENT_DIST,
    prefix: "/",
  });
}

interface AuthenticatedRequest extends FastifyRequest {
  auth: JwtPayload;
}

function parseBearerToken(request: FastifyRequest) {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length);
}

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  try {
    const token = parseBearerToken(request);
    if (!token) {
      reply.code(401).send({ error: "Missing bearer token." });
      return;
    }

    const auth = verifyToken(token);
    const device = getDeviceById(auth.deviceId);
    if (!device || device.userId !== auth.userId) {
      reply.code(401).send({ error: "Invalid device token." });
      return;
    }

    touchDevice(auth.deviceId);
    (request as AuthenticatedRequest).auth = auth;
  } catch {
    reply.code(401).send({ error: "Invalid or expired token." });
  }
}

function wsSend(ws: WebSocket, message: WsEnvelope) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function wsError(ws: WebSocket, code: string, message: string) {
  wsSend(ws, {
    type: "app:error",
    payload: { code, message },
  });
}

function getSocket(deviceId?: string | null) {
  if (!deviceId) {
    return null;
  }
  return connectedSockets.get(deviceId) ?? null;
}

function getRoomPresencePayload(roomId: string) {
  const memberDeviceIds = roomPresence.get(roomId) ?? new Set<string>();
  const members = getRoomMembers(roomId).map((member) => {
    const devices = [...memberDeviceIds]
      .map((deviceId) => getDeviceById(deviceId))
      .filter((device): device is NonNullable<typeof device> => Boolean(device))
      .filter((device) => device.userId === member.userId)
      .map((device) => ({
        id: device.id,
        name: device.name,
        lastSeenAt: device.lastSeenAt,
        online: connectedSockets.has(device.id),
      }));

    return {
      ...member,
      devices,
      online: devices.some((device) => device.online),
    };
  });

  return {
    roomId,
    members,
  };
}

function getMessageEventType(type: MessageType) {
  if (type === "system") {
    return "message:system";
  }
  return type === "link" ? "message:link" : "message:text";
}

function broadcastToRoom(roomId: string, message: WsEnvelope, excludeDeviceId?: string) {
  for (const memberDeviceId of roomPresence.get(roomId) ?? []) {
    if (excludeDeviceId && memberDeviceId === excludeDeviceId) {
      continue;
    }
    const socket = getSocket(memberDeviceId);
    if (socket) {
      wsSend(socket, message);
    }
  }
}

function sendToUserDevices(userId: string, message: WsEnvelope) {
  for (const device of getUserDevices(userId)) {
    const socket = getSocket(device.id);
    if (socket) {
      wsSend(socket, message);
    }
  }
}

function broadcastRoomMessage(
  roomId: string,
  payload: ReturnType<typeof createMessage> | NonNullable<ReturnType<typeof getMessageById>>,
  excludeDeviceId?: string,
) {
  broadcastToRoom(roomId, { type: getMessageEventType(payload.type), payload }, excludeDeviceId);
}

function createAndBroadcastSystemMessage(input: {
  roomId: string;
  senderUserId: string;
  senderDeviceId: string;
  content: string;
  excludeDeviceId?: string;
}) {
  const message = createMessage({
    roomId: input.roomId,
    senderUserId: input.senderUserId,
    senderDeviceId: input.senderDeviceId,
    type: "system",
    content: input.content,
  });
  broadcastRoomMessage(input.roomId, message, input.excludeDeviceId);
}

function broadcastRoomPresence(roomId: string) {
  const payload = getRoomPresencePayload(roomId);
  const memberDeviceIds = roomPresence.get(roomId) ?? new Set<string>();

  for (const deviceId of memberDeviceIds) {
    const socket = getSocket(deviceId);
    if (socket) {
      wsSend(socket, { type: "presence:update", payload });
    }
  }
}

function syncDevicePresence(deviceId: string, active: boolean) {
  for (const [roomId, devices] of roomPresence.entries()) {
    if (active) {
      const room = getRoomById(roomId);
      if (!room) {
        continue;
      }
    }

    const device = getDeviceById(deviceId);
    if (!device) {
      continue;
    }

    const isMember = ensureRoomMembership(roomId, device.userId);
    if (isMember) {
      devices.add(deviceId);
      broadcastRoomPresence(roomId);
    } else if (devices.delete(deviceId)) {
      broadcastRoomPresence(roomId);
    }
  }
}

function buildAuthResponse(auth: JwtPayload) {
  const user = getUserById(auth.userId)!;
  const device = getDeviceById(auth.deviceId)!;
  return {
    user,
    device,
    rooms: getUserRooms(auth.userId),
    devices: getUserDevices(auth.userId),
    discoveryHint: getDiscoveryHint("", PORT),
    serverEndpoint: getAppSetting("server_endpoint"),
  };
}

app.get("/api/health", async () => ({ ok: true }));

app.post("/api/auth/register", async (request, reply) => {
  const body = request.body as {
    username?: string;
    password?: string;
    displayName?: string;
    deviceName?: string;
  };

  const username = body.username?.trim().toLowerCase();
  const password = body.password?.trim();
  const deviceName = body.deviceName?.trim() || "Unnamed device";

  if (!username || !password) {
    reply.code(400).send({ error: "Username and password are required." });
    return;
  }

  const displayName = body.displayName?.trim() || username;

  if (getUserCredentials(username)) {
    reply.code(409).send({ error: "Username already exists." });
    return;
  }

  const passwordHash = await hashPassword(password);
  const user = createUser({ username, displayName, passwordHash });
  const device = createDevice({
    userId: user.id,
    name: deviceName,
    userAgent: request.headers["user-agent"],
  });
  const token = signToken({ userId: user.id, deviceId: device.id, username: user.username });

  reply.send({
    token,
    ...buildAuthResponse({ userId: user.id, deviceId: device.id, username: user.username }),
  });
});

app.post("/api/auth/login", async (request, reply) => {
  const body = request.body as {
    username?: string;
    password?: string;
    deviceName?: string;
  };

  const username = body.username?.trim().toLowerCase();
  const password = body.password?.trim();
  const deviceName = body.deviceName?.trim() || "Unnamed device";

  if (!username || !password) {
    reply.code(400).send({ error: "Username and password are required." });
    return;
  }

  const credentials = getUserCredentials(username);
  if (!credentials || !(await verifyPassword(password, credentials.passwordHash))) {
    reply.code(401).send({ error: "Invalid username or password." });
    return;
  }

  const device = createDevice({
    userId: credentials.id,
    name: deviceName,
    userAgent: request.headers["user-agent"],
  });
  const token = signToken({
    userId: credentials.id,
    deviceId: device.id,
    username: credentials.username,
  });

  reply.send({
    token,
    ...buildAuthResponse({
      userId: credentials.id,
      deviceId: device.id,
      username: credentials.username,
    }),
  });
});

app.post("/api/auth/logout", { preHandler: requireAuth }, async () => ({ ok: true }));

app.get("/api/me", { preHandler: requireAuth }, async (request) => {
  return buildAuthResponse((request as AuthenticatedRequest).auth);
});

app.get("/api/rooms", { preHandler: requireAuth }, async (request) => {
  return {
    rooms: getUserRooms((request as AuthenticatedRequest).auth.userId),
  };
});

app.get("/api/devices", { preHandler: requireAuth }, async (request) => {
  return {
    devices: getUserDevices((request as AuthenticatedRequest).auth.userId),
  };
});

app.patch("/api/devices/:deviceId", { preHandler: requireAuth }, async (request, reply) => {
  const { auth } = request as AuthenticatedRequest;
  const { deviceId } = request.params as { deviceId: string };
  const body = request.body as { name?: string };
  const name = body.name?.trim();

  if (!name) {
    reply.code(400).send({ error: "Device name is required." });
    return;
  }

  const device = renameDevice(deviceId, auth.userId, name);
  if (!device) {
    reply.code(404).send({ error: "Device not found." });
    return;
  }

  reply.send({ device });
});

app.post("/api/rooms", { preHandler: requireAuth }, async (request, reply) => {
  const { auth } = request as AuthenticatedRequest;
  const body = request.body as { name?: string };
  const name = body.name?.trim();

  if (!name) {
    reply.code(400).send({ error: "Room name is required." });
    return;
  }

  const room = createRoom({ name, createdByUserId: auth.userId });
  roomPresence.set(room.id, roomPresence.get(room.id) ?? new Set<string>());
  roomPresence.get(room.id)!.add(auth.deviceId);
  createAndBroadcastSystemMessage({
    roomId: room.id,
    senderUserId: auth.userId,
    senderDeviceId: auth.deviceId,
    content: `${getUserById(auth.userId)?.displayName ?? auth.username} 创建了房间。`,
  });
  broadcastRoomPresence(room.id);

  const socket = getSocket(auth.deviceId);
  if (socket) {
    wsSend(socket, { type: "room:joined", payload: room });
  }

  reply.send({ room });
});

app.post("/api/rooms/join", { preHandler: requireAuth }, async (request, reply) => {
  const { auth } = request as AuthenticatedRequest;
  const body = request.body as { inviteCode?: string };
  const inviteCode = body.inviteCode?.trim();

  if (!inviteCode) {
    reply.code(400).send({ error: "Invite code is required." });
    return;
  }

  const room = getRoomByInviteCode(inviteCode);
  if (!room) {
    reply.code(404).send({ error: "Room not found." });
    return;
  }

  addUserToRoom(room.id, auth.userId);
  roomPresence.set(room.id, roomPresence.get(room.id) ?? new Set<string>());
  roomPresence.get(room.id)!.add(auth.deviceId);
  createAndBroadcastSystemMessage({
    roomId: room.id,
    senderUserId: auth.userId,
    senderDeviceId: auth.deviceId,
    content: `${getUserById(auth.userId)?.displayName ?? auth.username} 加入了房间。`,
  });
  broadcastRoomPresence(room.id);

  const socket = getSocket(auth.deviceId);
  if (socket) {
    wsSend(socket, { type: "room:joined", payload: room });
  }

  reply.send({ room });
});

app.get("/api/rooms/:roomId/messages", { preHandler: requireAuth }, async (request, reply) => {
  const { auth } = request as AuthenticatedRequest;
  const { roomId } = request.params as { roomId: string };

  if (!ensureRoomMembership(roomId, auth.userId)) {
    reply.code(403).send({ error: "You are not a member of this room." });
    return;
  }

  reply.send({ messages: getMessages(roomId, auth.userId) });
});

app.get("/api/rooms/:roomId", { preHandler: requireAuth }, async (request, reply) => {
  const { auth } = request as AuthenticatedRequest;
  const { roomId } = request.params as { roomId: string };

  if (!ensureRoomMembership(roomId, auth.userId)) {
    reply.code(403).send({ error: "You are not a member of this room." });
    return;
  }

  const room = getRoomDetails(roomId);
  if (!room) {
    reply.code(404).send({ error: "Room not found." });
    return;
  }

  reply.send({
    room,
    members: getRoomMembers(roomId),
    pendingTransfers: getPendingTransfers(roomId),
  });
});

app.post("/api/rooms/:roomId/leave", { preHandler: requireAuth }, async (request, reply) => {
  const { auth } = request as AuthenticatedRequest;
  const { roomId } = request.params as { roomId: string };

  if (!ensureRoomMembership(roomId, auth.userId)) {
    reply.code(403).send({ error: "You are not a member of this room." });
    return;
  }

  removeUserFromRoom(roomId, auth.userId);

  for (const device of getUserDevices(auth.userId)) {
    roomPresence.get(roomId)?.delete(device.id);
    const socket = getSocket(device.id);
    if (socket) {
      wsSend(socket, { type: "room:removed", payload: { roomId } });
    }
  }

  const remainingCount = getRoomMemberCount(roomId);
  if (remainingCount === 0) {
    roomPresence.delete(roomId);
    deleteRoom(roomId);
    reply.send({ ok: true, roomDeleted: true });
    return;
  }

  createAndBroadcastSystemMessage({
    roomId,
    senderUserId: auth.userId,
    senderDeviceId: auth.deviceId,
    content: `${getUserById(auth.userId)?.displayName ?? auth.username} 离开了房间。`,
  });
  broadcastRoomPresence(roomId);
  reply.send({ ok: true, roomDeleted: false });
});

app.get(
  "/api/rooms/:roomId/pending-transfers",
  { preHandler: requireAuth },
  async (request, reply) => {
    const { auth } = request as AuthenticatedRequest;
    const { roomId } = request.params as { roomId: string };

    if (!ensureRoomMembership(roomId, auth.userId)) {
      reply.code(403).send({ error: "You are not a member of this room." });
      return;
    }

    reply.send({ pendingTransfers: getPendingTransfers(roomId) });
  },
);

app.delete("/api/pending-transfers/:pendingTransferId", { preHandler: requireAuth }, async (request, reply) => {
  const { auth } = request as AuthenticatedRequest;
  const { pendingTransferId } = request.params as { pendingTransferId: string };
  const pending = getPendingTransferById(pendingTransferId);

  if (!pending || !ensureRoomMembership(pending.roomId, auth.userId)) {
    reply.code(404).send({ error: "Pending transfer not found." });
    return;
  }

  if (pending.senderUserId !== auth.userId && pending.receiverUserId !== auth.userId) {
    reply.code(403).send({ error: "You cannot delete this pending transfer." });
    return;
  }

  deletePendingTransfer(pendingTransferId);
  broadcastToRoom(pending.roomId, {
    type: "pending-transfer:deleted",
    payload: { pendingTransferId, roomId: pending.roomId },
  });
  createAndBroadcastSystemMessage({
    roomId: pending.roomId,
    senderUserId: auth.userId,
    senderDeviceId: auth.deviceId,
    content: `${getUserById(auth.userId)?.displayName ?? auth.username} 删除了挂起传输 ${pending.fileName}。`,
  });
  reply.send({ ok: true });
});

app.patch("/api/messages/:messageId/flags", { preHandler: requireAuth }, async (request, reply) => {
  const { auth } = request as AuthenticatedRequest;
  const { messageId } = request.params as { messageId: string };
  const body = request.body as { pinned?: boolean; favorited?: boolean };
  const message = getMessageById(messageId, auth.userId);

  if (!message || !ensureRoomMembership(message.roomId, auth.userId)) {
    reply.code(404).send({ error: "Message not found." });
    return;
  }

  const updated = setMessageFlags({
    messageId,
    userId: auth.userId,
    pinned: body.pinned,
    favorited: body.favorited,
  });

  if (!updated) {
    reply.code(500).send({ error: "Failed to update flags." });
    return;
  }

  sendToUserDevices(auth.userId, {
    type: "message:flags",
    payload: updated,
  });

  reply.send({ message: updated });
});

app.get("/api/system/discovery-hint", async (request) => {
  const protocol = request.protocol;
  const hostHeader = request.headers.host ? `${protocol}://${request.headers.host}` : "";
  return getDiscoveryHint(hostHeader, PORT);
});

app.get("/api/system/status", async (request) => {
  const protocol = request.protocol;
  const hostHeader = request.headers.host ? `${protocol}://${request.headers.host}` : "";
  return {
    ok: true,
    name: "Flow Socket",
    version: "0.1.0",
    port: PORT,
    limits: {
      maxMessageLength: MAX_MESSAGE_LENGTH,
      maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
    },
    discovery: getDiscoveryHint(hostHeader, PORT),
    time: new Date().toISOString(),
  };
});

app.patch("/api/settings/server-endpoint", { preHandler: requireAuth }, async (request) => {
  const body = request.body as { serverEndpoint?: string };
  const serverEndpoint = body.serverEndpoint?.trim() ?? "";
  setAppSetting("server_endpoint", serverEndpoint);
  return { serverEndpoint };
});

app.get(
  "/ws",
  { websocket: true },
  async (connection: WebSocket, request) => {
    const targetUrl = new URL(request.url, `http://${request.headers.host}`);
    const token = targetUrl.searchParams.get("token");

    if (!token) {
      connection.close(4001, "Missing token");
      return;
    }

    let auth: JwtPayload;
    try {
      auth = verifyToken(token);
    } catch {
      connection.close(4002, "Invalid token");
      return;
    }

    const user = getUserById(auth.userId);
    const device = getDeviceById(auth.deviceId);
    if (!user || !device || device.userId !== user.id) {
      connection.close(4003, "Unknown user or device");
      return;
    }

    connectedSockets.set(device.id, connection);
    touchDevice(device.id);

    for (const room of getUserRooms(user.id)) {
      roomPresence.set(room.id, roomPresence.get(room.id) ?? new Set<string>());
      roomPresence.get(room.id)!.add(device.id);
      broadcastRoomPresence(room.id);
    }

    wsSend(connection, {
      type: "auth:ready",
      payload: buildAuthResponse(auth),
    });

    connection.on("message", (buffer: RawData) => {
      try {
        const envelope = JSON.parse(buffer.toString()) as WsEnvelope<Record<string, unknown>>;
        touchDevice(device.id);

        if (envelope.type === "message:text" || envelope.type === "message:link") {
          const roomId = String(envelope.payload?.roomId ?? "");
          const content = String(envelope.payload?.content ?? "").trim();

          if (!roomId || !content || !ensureRoomMembership(roomId, user.id)) {
            return;
          }

          if (content.length > MAX_MESSAGE_LENGTH) {
            wsError(connection, "MESSAGE_TOO_LONG", `消息最多 ${MAX_MESSAGE_LENGTH} 个字符。`);
            return;
          }

          const message = createMessage({
            roomId,
            senderUserId: user.id,
            senderDeviceId: device.id,
            type: envelope.type === "message:text" ? "text" : "link",
            content,
          });
          broadcastRoomMessage(roomId, message);

          return;
        }

        if (envelope.type === "file:offer") {
          const payload = envelope.payload ?? {};
          const clientTransferKey = String(payload.clientTransferKey ?? "");
          const roomId = String(payload.roomId ?? "");
          const receiverUserId = String(payload.receiverUserId ?? "");
          const receiverDeviceId = payload.receiverDeviceId ? String(payload.receiverDeviceId) : null;
          const fileName = String(payload.fileName ?? "");
          const mimeType = String(payload.mimeType ?? "application/octet-stream");
          const sizeBytes = Number(payload.sizeBytes ?? 0);

          if (
            !clientTransferKey ||
            !roomId ||
            !receiverUserId ||
            !fileName ||
            !sizeBytes ||
            !ensureRoomMembership(roomId, user.id) ||
            !ensureRoomMembership(roomId, receiverUserId)
          ) {
            return;
          }

          if (sizeBytes > MAX_FILE_SIZE_BYTES) {
            wsSend(connection, {
              type: "file:failed",
              payload: {
                transferId: clientTransferKey,
                clientTransferKey,
                errorCode: "file_too_large",
                maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
              },
            });
            return;
          }

          const receiverSocket = getSocket(receiverDeviceId);
          if (!receiverSocket) {
            const pending = createPendingTransfer({
              roomId,
              senderUserId: user.id,
              senderDeviceId: device.id,
              receiverUserId,
              fileName,
              mimeType,
              sizeBytes,
            });
            const transferId = createTransferLog({
              roomId,
              senderUserId: user.id,
              senderDeviceId: device.id,
              receiverUserId,
              receiverDeviceId,
              fileName,
              mimeType,
              sizeBytes,
              status: "pending",
            });

            wsSend(connection, {
              type: "file:queued",
              payload: { pendingTransfer: pending, transferId, clientTransferKey },
            });
            return;
          }

          const transferId = createTransferLog({
            roomId,
            senderUserId: user.id,
            senderDeviceId: device.id,
            receiverUserId,
            receiverDeviceId,
            fileName,
            mimeType,
            sizeBytes,
            status: "negotiating",
          });

          wsSend(receiverSocket, {
            type: "file:offer",
            payload: {
              transferId,
              roomId,
              senderUserId: user.id,
              senderDeviceId: device.id,
              senderDisplayName: user.displayName,
              receiverUserId,
              receiverDeviceId,
              clientTransferKey,
              fileName,
              mimeType,
              sizeBytes,
            },
          });
          return;
        }

        if (envelope.type === "transfer:requeue") {
          const payload = envelope.payload ?? {};
          const clientTransferKey = String(payload.clientTransferKey ?? "");
          const pendingTransferId = String(payload.pendingTransferId ?? "");
          const receiverDeviceId = String(payload.receiverDeviceId ?? "");
          const pending = getPendingTransferById(pendingTransferId);
          const receiverSocket = getSocket(receiverDeviceId);

          if (!clientTransferKey || !pending || pending.senderUserId !== user.id || !receiverSocket) {
            return;
          }

          const transferId = createTransferLog({
            roomId: pending.roomId,
            senderUserId: pending.senderUserId,
            senderDeviceId: pending.senderDeviceId,
            receiverUserId: pending.receiverUserId,
            receiverDeviceId,
            fileName: pending.fileName,
            mimeType: pending.mimeType,
            sizeBytes: pending.sizeBytes,
            status: "negotiating",
          });

          deletePendingTransfer(pendingTransferId);
          broadcastToRoom(pending.roomId, {
            type: "pending-transfer:deleted",
            payload: { pendingTransferId, roomId: pending.roomId },
          });
          wsSend(receiverSocket, {
            type: "file:offer",
            payload: {
              transferId,
              roomId: pending.roomId,
              senderUserId: pending.senderUserId,
              senderDeviceId: pending.senderDeviceId,
              receiverUserId: pending.receiverUserId,
              receiverDeviceId,
              clientTransferKey,
              fileName: pending.fileName,
              mimeType: pending.mimeType,
              sizeBytes: pending.sizeBytes,
              requeued: true,
            },
          });

          wsSend(connection, {
            type: "transfer:requeue",
            payload: { pendingTransferId, transferId, clientTransferKey },
          });
          return;
        }

        if (envelope.type === "file:accept" || envelope.type === "file:reject") {
          const payload = envelope.payload ?? {};
          const transferId = String(payload.transferId ?? "");
          const senderDeviceId = String(payload.senderDeviceId ?? "");
          const senderSocket = getSocket(senderDeviceId);

          if (!transferId || !senderSocket) {
            return;
          }

          updateTransferStatus({
            id: transferId,
            status: envelope.type === "file:accept" ? "negotiating" : "rejected",
            errorCode: envelope.type === "file:reject" ? "receiver_rejected" : undefined,
          });

          wsSend(senderSocket, {
            type: envelope.type,
            payload: { ...payload, receiverDeviceId: device.id },
          });
          return;
        }

        if (envelope.type === "file:signal" || envelope.type === "file:progress") {
          const payload = envelope.payload ?? {};
          const targetDeviceId = String(payload.targetDeviceId ?? "");
          const targetSocket = getSocket(targetDeviceId);

          if (targetSocket) {
            wsSend(targetSocket, { type: envelope.type, payload: { ...payload, sourceDeviceId: device.id } });
          }
          return;
        }

        if (envelope.type === "file:complete" || envelope.type === "file:failed") {
          const payload = envelope.payload ?? {};
          const transferId = String(payload.transferId ?? "");
          const targetDeviceId = String(payload.targetDeviceId ?? "");
          const targetSocket = getSocket(targetDeviceId);

          updateTransferStatus({
            id: transferId,
            status: envelope.type === "file:complete" ? "completed" : "failed",
            errorCode:
              envelope.type === "file:failed" ? String(payload.errorCode ?? "transfer_failed") : undefined,
          });

          if (targetSocket) {
            wsSend(targetSocket, { type: envelope.type, payload: { ...payload, sourceDeviceId: device.id } });
          }
        }
      } catch (error) {
        app.log.error(error, "Failed to process websocket message");
      }
    });

    connection.on("close", () => {
      connectedSockets.delete(device.id);
      syncDevicePresence(device.id, false);
    });
  },
);

if (existsSync(CLIENT_DIST)) {
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      reply.code(404).send({ error: "Not found." });
      return;
    }
    return reply.sendFile("index.html");
  });
}

export async function startServer(port = PORT, host = process.env.HOST ?? "0.0.0.0") {
  await app.listen({ port, host });
  return app;
}

export { app };

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  await startServer();
}

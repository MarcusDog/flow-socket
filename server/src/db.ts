import { mkdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { nanoid } from "nanoid";

import type { MessageType, TransferStatus } from "./types.js";

const DATA_DIR = path.resolve(process.env.FLOW_SOCKET_DATA_DIR ?? process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "app.sqlite");

mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    user_agent TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    invite_code TEXT NOT NULL UNIQUE,
    created_by_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (room_id, user_id),
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    sender_user_id TEXT NOT NULL,
    sender_device_id TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_device_id) REFERENCES devices(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS file_transfers (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    sender_user_id TEXT NOT NULL,
    sender_device_id TEXT NOT NULL,
    receiver_user_id TEXT NOT NULL,
    receiver_device_id TEXT,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    error_code TEXT,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS pending_transfers (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    sender_user_id TEXT NOT NULL,
    sender_device_id TEXT NOT NULL,
    receiver_user_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS message_flags (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    favorited INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

function now() {
  return new Date().toISOString();
}

function row<T>(statement: string, ...params: unknown[]) {
  return db.prepare(statement).get(...(params as [])) as T | undefined;
}

function all<T>(statement: string, ...params: unknown[]) {
  return db.prepare(statement).all(...(params as [])) as T[];
}

export function createUser(input: {
  username: string;
  displayName: string;
  passwordHash: string;
}) {
  const id = nanoid();
  const createdAt = now();
  db.prepare(
    `
      INSERT INTO users (id, username, display_name, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
  ).run(id, input.username, input.displayName, input.passwordHash, createdAt);

  return getUserById(id)!;
}

export function getUserById(id: string) {
  return row<{
    id: string;
    username: string;
    displayName: string;
    createdAt: string;
  }>(
    `
      SELECT id, username, display_name AS displayName, created_at AS createdAt
      FROM users
      WHERE id = ?
    `,
    id,
  );
}

export function getUserCredentials(username: string) {
  return row<{
    id: string;
    username: string;
    displayName: string;
    passwordHash: string;
  }>(
    `
      SELECT id, username, display_name AS displayName, password_hash AS passwordHash
      FROM users
      WHERE username = ?
    `,
    username,
  );
}

export function createDevice(input: {
  userId: string;
  name: string;
  userAgent?: string;
}) {
  const id = nanoid();
  const timestamp = now();
  db.prepare(
    `
      INSERT INTO devices (id, user_id, name, last_seen_at, created_at, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
  ).run(id, input.userId, input.name, timestamp, timestamp, input.userAgent ?? null);

  return getDeviceById(id)!;
}

export function getDeviceById(id: string) {
  return row<{
    id: string;
    userId: string;
    name: string;
    lastSeenAt: string;
    createdAt: string;
  }>(
    `
      SELECT id, user_id AS userId, name, last_seen_at AS lastSeenAt, created_at AS createdAt
      FROM devices
      WHERE id = ?
    `,
    id,
  );
}

export function getUserDevices(userId: string) {
  return all<{
    id: string;
    userId: string;
    name: string;
    lastSeenAt: string;
    createdAt: string;
  }>(
    `
      SELECT id, user_id AS userId, name, last_seen_at AS lastSeenAt, created_at AS createdAt
      FROM devices
      WHERE user_id = ?
      ORDER BY created_at DESC
    `,
    userId,
  );
}

export function renameDevice(deviceId: string, userId: string, name: string) {
  db.prepare(
    `
      UPDATE devices
      SET name = ?, last_seen_at = ?
      WHERE id = ? AND user_id = ?
    `,
  ).run(name, now(), deviceId, userId);

  return getDeviceById(deviceId);
}

export function touchDevice(deviceId: string) {
  db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now(), deviceId);
}

export function createRoom(input: { name: string; createdByUserId: string }) {
  const id = nanoid();
  const inviteCode = nanoid(10);
  const createdAt = now();

  db.prepare(
    `
      INSERT INTO rooms (id, name, invite_code, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
  ).run(id, input.name, inviteCode, input.createdByUserId, createdAt);

  db.prepare(
    `
      INSERT INTO room_members (room_id, user_id, joined_at)
      VALUES (?, ?, ?)
    `,
  ).run(id, input.createdByUserId, createdAt);
  return getRoomById(id)!;
}

export function getRoomMemberCount(roomId: string) {
  return (
    row<{ count: number }>(
      `
        SELECT COUNT(*) AS count
        FROM room_members
        WHERE room_id = ?
      `,
      roomId,
    )?.count ?? 0
  );
}

export function getRoomById(roomId: string) {
  return row<{
    id: string;
    name: string;
    inviteCode: string;
    createdByUserId: string;
    createdAt: string;
  }>(
    `
      SELECT id, name, invite_code AS inviteCode, created_by_user_id AS createdByUserId, created_at AS createdAt
      FROM rooms
      WHERE id = ?
    `,
    roomId,
  );
}

export function getRoomDetails(roomId: string) {
  return row<{
    id: string;
    name: string;
    inviteCode: string;
    createdByUserId: string;
    createdByDisplayName: string;
    createdAt: string;
    memberCount: number;
  }>(
    `
      SELECT
        rooms.id,
        rooms.name,
        rooms.invite_code AS inviteCode,
        rooms.created_by_user_id AS createdByUserId,
        users.display_name AS createdByDisplayName,
        rooms.created_at AS createdAt,
        COUNT(room_members.user_id) AS memberCount
      FROM rooms
      INNER JOIN users ON users.id = rooms.created_by_user_id
      INNER JOIN room_members ON room_members.room_id = rooms.id
      WHERE rooms.id = ?
      GROUP BY rooms.id
    `,
    roomId,
  );
}

export function getRoomByInviteCode(inviteCode: string) {
  return row<{
    id: string;
    name: string;
    inviteCode: string;
    createdByUserId: string;
    createdAt: string;
  }>(
    `
      SELECT id, name, invite_code AS inviteCode, created_by_user_id AS createdByUserId, created_at AS createdAt
      FROM rooms
      WHERE invite_code = ?
    `,
    inviteCode,
  );
}

export function addUserToRoom(roomId: string, userId: string) {
  db.prepare(
    `
      INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at)
      VALUES (?, ?, ?)
    `,
  ).run(roomId, userId, now());
}

export function removeUserFromRoom(roomId: string, userId: string) {
  db.prepare(
    `
      DELETE FROM room_members
      WHERE room_id = ? AND user_id = ?
    `,
  ).run(roomId, userId);
}

export function deleteRoom(roomId: string) {
  db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
}

export function getUserRooms(userId: string) {
  return all<{
    id: string;
    name: string;
    inviteCode: string;
    createdAt: string;
  }>(
    `
      SELECT rooms.id, rooms.name, rooms.invite_code AS inviteCode, rooms.created_at AS createdAt
      FROM rooms
      INNER JOIN room_members ON room_members.room_id = rooms.id
      WHERE room_members.user_id = ?
      ORDER BY rooms.created_at DESC
    `,
    userId,
  );
}

export function getRoomMembers(roomId: string) {
  return all<{
    userId: string;
    username: string;
    displayName: string;
    joinedAt: string;
  }>(
    `
      SELECT
        room_members.user_id AS userId,
        users.username,
        users.display_name AS displayName,
        room_members.joined_at AS joinedAt
      FROM room_members
      INNER JOIN users ON users.id = room_members.user_id
      WHERE room_members.room_id = ?
      ORDER BY room_members.joined_at ASC
    `,
    roomId,
  );
}

export function ensureRoomMembership(roomId: string, userId: string) {
  const member = row<{ userId: string }>(
    "SELECT user_id AS userId FROM room_members WHERE room_id = ? AND user_id = ?",
    roomId,
    userId,
  );
  return Boolean(member);
}

export function createMessage(input: {
  roomId: string;
  senderUserId: string;
  senderDeviceId: string;
  type: MessageType;
  content: string;
}) {
  const id = nanoid();
  const createdAt = now();
  db.prepare(
    `
      INSERT INTO messages (id, room_id, sender_user_id, sender_device_id, type, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    id,
    input.roomId,
    input.senderUserId,
    input.senderDeviceId,
    input.type,
    input.content,
    createdAt,
  );

  const message = row<{
    id: string;
    roomId: string;
    senderUserId: string;
    senderDeviceId: string;
    senderDisplayName: string;
    type: MessageType;
    content: string;
    createdAt: string;
    pinned: number;
    favorited: number;
  }>(
    `
      SELECT
        messages.id,
        messages.room_id AS roomId,
        messages.sender_user_id AS senderUserId,
        messages.sender_device_id AS senderDeviceId,
        users.display_name AS senderDisplayName,
        messages.type,
        messages.content,
        messages.created_at AS createdAt,
        0 AS pinned,
        0 AS favorited
      FROM messages
      INNER JOIN users ON users.id = messages.sender_user_id
      WHERE messages.id = ?
    `,
    id,
  )!;

  return {
    ...message,
    pinned: Boolean(message.pinned),
    favorited: Boolean(message.favorited),
  };
}

export function getMessages(roomId: string, viewerUserId: string, limit = 100) {
  return all<{
    id: string;
    roomId: string;
    senderUserId: string;
    senderDeviceId: string;
    senderDisplayName: string;
    type: MessageType;
    content: string;
    createdAt: string;
    pinned: number;
    favorited: number;
  }>(
    `
      SELECT
        messages.id,
        messages.room_id AS roomId,
        messages.sender_user_id AS senderUserId,
        messages.sender_device_id AS senderDeviceId,
        users.display_name AS senderDisplayName,
        messages.type,
        messages.content,
        messages.created_at AS createdAt,
        COALESCE(message_flags.pinned, 0) AS pinned,
        COALESCE(message_flags.favorited, 0) AS favorited
      FROM messages
      INNER JOIN users ON users.id = messages.sender_user_id
      LEFT JOIN message_flags
        ON message_flags.message_id = messages.id
       AND message_flags.user_id = ?
      WHERE messages.room_id = ?
      ORDER BY messages.created_at DESC
      LIMIT ?
    `,
    viewerUserId,
    roomId,
    limit,
  )
    .reverse()
    .map((message) => ({
      ...message,
      pinned: Boolean(message.pinned),
      favorited: Boolean(message.favorited),
    }));
}

export function getMessageById(messageId: string, viewerUserId: string) {
  const message = row<{
    id: string;
    roomId: string;
    senderUserId: string;
    senderDeviceId: string;
    senderDisplayName: string;
    type: MessageType;
    content: string;
    createdAt: string;
    pinned: number;
    favorited: number;
  }>(
    `
      SELECT
        messages.id,
        messages.room_id AS roomId,
        messages.sender_user_id AS senderUserId,
        messages.sender_device_id AS senderDeviceId,
        users.display_name AS senderDisplayName,
        messages.type,
        messages.content,
        messages.created_at AS createdAt,
        COALESCE(message_flags.pinned, 0) AS pinned,
        COALESCE(message_flags.favorited, 0) AS favorited
      FROM messages
      INNER JOIN users ON users.id = messages.sender_user_id
      LEFT JOIN message_flags
        ON message_flags.message_id = messages.id
       AND message_flags.user_id = ?
      WHERE messages.id = ?
    `,
    viewerUserId,
    messageId,
  );

  return message
    ? {
        ...message,
        pinned: Boolean(message.pinned),
        favorited: Boolean(message.favorited),
      }
    : undefined;
}

export function setMessageFlags(input: {
  messageId: string;
  userId: string;
  pinned?: boolean;
  favorited?: boolean;
}) {
  const current =
    row<{ pinned: number; favorited: number }>(
      `
        SELECT pinned, favorited
        FROM message_flags
        WHERE message_id = ? AND user_id = ?
      `,
      input.messageId,
      input.userId,
    ) ?? { pinned: 0, favorited: 0 };

  const nextPinned = input.pinned ?? Boolean(current.pinned);
  const nextFavorited = input.favorited ?? Boolean(current.favorited);

  db.prepare(
    `
      INSERT INTO message_flags (message_id, user_id, pinned, favorited, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(message_id, user_id) DO UPDATE
      SET pinned = excluded.pinned,
          favorited = excluded.favorited,
          updated_at = excluded.updated_at
    `,
  ).run(input.messageId, input.userId, Number(nextPinned), Number(nextFavorited), now());

  return getMessageById(input.messageId, input.userId);
}

export function createTransferLog(input: {
  roomId: string;
  senderUserId: string;
  senderDeviceId: string;
  receiverUserId: string;
  receiverDeviceId?: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: TransferStatus;
}) {
  const id = nanoid();
  db.prepare(
    `
      INSERT INTO file_transfers (
        id, room_id, sender_user_id, sender_device_id, receiver_user_id, receiver_device_id,
        file_name, mime_type, size_bytes, status, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    id,
    input.roomId,
    input.senderUserId,
    input.senderDeviceId,
    input.receiverUserId,
    input.receiverDeviceId ?? null,
    input.fileName,
    input.mimeType,
    input.sizeBytes,
    input.status,
    now(),
  );
  return id;
}

export function updateTransferStatus(input: {
  id: string;
  status: TransferStatus;
  errorCode?: string;
}) {
  db.prepare(
    `
      UPDATE file_transfers
      SET status = ?, completed_at = ?, error_code = ?
      WHERE id = ?
    `,
  ).run(
    input.status,
    input.status === "completed" || input.status === "failed" || input.status === "rejected"
      ? now()
      : null,
    input.errorCode ?? null,
    input.id,
  );
}

export function createPendingTransfer(input: {
  roomId: string;
  senderUserId: string;
  senderDeviceId: string;
  receiverUserId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}) {
  const id = nanoid();
  db.prepare(
    `
      INSERT INTO pending_transfers (
        id, room_id, sender_user_id, sender_device_id, receiver_user_id,
        file_name, mime_type, size_bytes, created_at, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    id,
    input.roomId,
    input.senderUserId,
    input.senderDeviceId,
    input.receiverUserId,
    input.fileName,
    input.mimeType,
    input.sizeBytes,
    now(),
    "pending",
  );
  return getPendingTransferById(id)!;
}

export function getPendingTransferById(id: string) {
  return row<{
    id: string;
    roomId: string;
    senderUserId: string;
    senderDeviceId: string;
    receiverUserId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    createdAt: string;
    status: string;
  }>(
    `
      SELECT
        id,
        room_id AS roomId,
        sender_user_id AS senderUserId,
        sender_device_id AS senderDeviceId,
        receiver_user_id AS receiverUserId,
        file_name AS fileName,
        mime_type AS mimeType,
        size_bytes AS sizeBytes,
        created_at AS createdAt,
        status
      FROM pending_transfers
      WHERE id = ?
    `,
    id,
  );
}

export function getPendingTransfers(roomId: string) {
  return all<{
    id: string;
    roomId: string;
    senderUserId: string;
    senderDeviceId: string;
    receiverUserId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    createdAt: string;
    status: string;
  }>(
    `
      SELECT
        id,
        room_id AS roomId,
        sender_user_id AS senderUserId,
        sender_device_id AS senderDeviceId,
        receiver_user_id AS receiverUserId,
        file_name AS fileName,
        mime_type AS mimeType,
        size_bytes AS sizeBytes,
        created_at AS createdAt,
        status
      FROM pending_transfers
      WHERE room_id = ?
      ORDER BY created_at DESC
    `,
    roomId,
  );
}

export function deletePendingTransfer(id: string) {
  db.prepare("DELETE FROM pending_transfers WHERE id = ?").run(id);
}

export function getAppSetting(key: string) {
  return row<{ value: string }>("SELECT value FROM app_settings WHERE key = ?", key)?.value ?? null;
}

export function setAppSetting(key: string, value: string) {
  db.prepare(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
  ).run(key, value, now());
}

export function getDiscoveryHint(host: string, port: number) {
  const results = new Set<string>();
  const interfaces = networkInterfaces();

  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        results.add(`http://${address.address}:${port}`);
      }
    }
  }

  if (host) {
    results.add(host);
  }

  const configuredEndpoint = getAppSetting("server_endpoint");
  return {
    configuredEndpoint,
    suggestedBaseUrls: [...results],
  };
}

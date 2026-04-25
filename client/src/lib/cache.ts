import type { Message, PendingTransfer } from "../types";

const DB_NAME = "socket-flow-cache";
const DB_VERSION = 1;
const ROOM_STORE = "roomCache";

interface RoomCacheRecord {
  roomId: string;
  messages: Message[];
  pendingTransfers: PendingTransfer[];
  updatedAt: number;
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ROOM_STORE)) {
        db.createObjectStore(ROOM_STORE, { keyPath: "roomId" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readRoomCache(roomId: string) {
  const db = await openDatabase();
  return new Promise<RoomCacheRecord | null>((resolve, reject) => {
    const tx = db.transaction(ROOM_STORE, "readonly");
    const store = tx.objectStore(ROOM_STORE);
    const request = store.get(roomId);

    request.onsuccess = () => resolve((request.result as RoomCacheRecord | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function writeRoomCache(
  roomId: string,
  value: Pick<RoomCacheRecord, "messages" | "pendingTransfers">,
) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ROOM_STORE, "readwrite");
    tx.objectStore(ROOM_STORE).put({
      roomId,
      messages: value.messages,
      pendingTransfers: value.pendingTransfers,
      updatedAt: Date.now(),
    } satisfies RoomCacheRecord);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}


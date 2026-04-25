export type MessageType = "text" | "link" | "system";

export type TransferStatus =
  | "pending"
  | "negotiating"
  | "transferring"
  | "completed"
  | "failed"
  | "rejected"
  | "expired";

export interface JwtPayload {
  userId: string;
  deviceId: string;
  username: string;
}

export interface AuthedUser {
  id: string;
  username: string;
  displayName: string;
}

export interface DeviceRecord {
  id: string;
  userId: string;
  name: string;
  lastSeenAt: string;
  createdAt: string;
}

export interface WsEnvelope<T = unknown> {
  type: string;
  payload?: T;
}

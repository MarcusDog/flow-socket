export type MessageType = "text" | "link" | "system";

export interface User {
  id: string;
  username: string;
  displayName: string;
  createdAt?: string;
}

export interface Device {
  id: string;
  userId: string;
  name: string;
  lastSeenAt: string;
  createdAt: string;
}

export interface Room {
  id: string;
  name: string;
  inviteCode: string;
  createdAt: string;
}

export interface RoomDetails extends Room {
  createdByUserId: string;
  createdByDisplayName: string;
  memberCount: number;
}

export interface Message {
  id: string;
  roomId: string;
  senderUserId: string;
  senderDeviceId: string;
  senderDisplayName: string;
  type: MessageType;
  content: string;
  createdAt: string;
  pinned: boolean;
  favorited: boolean;
}

export interface PendingTransfer {
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
}

export interface PresenceDevice {
  id: string;
  name: string;
  lastSeenAt: string;
  online: boolean;
}

export interface RoomMember {
  userId: string;
  username: string;
  displayName: string;
  joinedAt: string;
  online: boolean;
  devices: PresenceDevice[];
}

export interface PresencePayload {
  roomId: string;
  members: RoomMember[];
}

export interface DiscoveryHint {
  configuredEndpoint: string | null;
  suggestedBaseUrls: string[];
}

export interface SessionBootstrap {
  token: string;
  user: User;
  device: Device;
  rooms: Room[];
  devices: Device[];
  discoveryHint: DiscoveryHint;
  serverEndpoint: string | null;
}

export interface SessionState extends Omit<SessionBootstrap, "token"> {
  token: string;
}

export interface IncomingOffer {
  transferId: string;
  roomId: string;
  senderUserId: string;
  senderDeviceId: string;
  senderDisplayName?: string;
  receiverUserId: string;
  receiverDeviceId?: string | null;
  clientTransferKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  requeued?: boolean;
}

export interface TransferEntry {
  id: string;
  roomId: string;
  kind: "send" | "receive";
  fileName: string;
  sizeBytes: number;
  peerLabel: string;
  stage:
    | "awaiting-accept"
    | "queued"
    | "connecting"
    | "transferring"
    | "completed"
    | "failed"
    | "rejected";
  progress: number;
  createdAt: string;
  clientTransferKey?: string;
  pendingTransferId?: string;
  downloadUrl?: string;
  mimeType?: string;
  message?: string;
}

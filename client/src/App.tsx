import { startTransition, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import QRCode from "qrcode";

import "./App.css";
import { readRoomCache, writeRoomCache } from "./lib/cache";
import type {
  Device,
  DiscoveryHint,
  IncomingOffer,
  Message,
  PendingTransfer,
  PresencePayload,
  Room,
  RoomDetails,
  SessionBootstrap,
  SessionState,
  TransferEntry,
} from "./types";

const STORAGE_TOKEN_KEY = "socket-flow.token";
const STORAGE_ENDPOINT_KEY = "socket-flow.endpoint";
const STORAGE_ROOM_KEY = "socket-flow.room";
const FALLBACK_ENDPOINT = window.location.origin;
const DEFAULT_ENDPOINT = normalizeEndpoint(FALLBACK_ENDPOINT);
const MAX_FILE_BYTES = 1024 * 1024 * 1024;

interface Notice {
  id: string;
  tone: "info" | "success" | "error";
  text: string;
}

interface SocketEventEnvelope {
  type: string;
  payload?: unknown;
}

interface SignalPayload {
  transferId: string;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

interface WebRtcRuntime {
  pc: RTCPeerConnection;
  role: "sender" | "receiver";
  transferId: string;
  roomId: string;
  peerDeviceId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  receivedBytes: number;
  chunks: BlobPart[];
}

function normalizeEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return FALLBACK_ENDPOINT;
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    return new URL(withProtocol).origin;
  } catch {
    return FALLBACK_ENDPOINT;
  }
}

function buildWsUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  return url.toString();
}

function guessMessageType(text: string) {
  return /^https?:\/\//i.test(text.trim()) ? "message:link" : "message:text";
}

function formatBytes(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> {
  const hasBody = typeof init.body !== "undefined";
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(String(data.error ?? "Request failed."));
  }
  return data as T;
}

function makeClientTransferKey() {
  return crypto.randomUUID();
}

export default function App() {
  const [serverBaseUrl, setServerBaseUrl] = useState(
    normalizeEndpoint(localStorage.getItem(STORAGE_ENDPOINT_KEY) ?? DEFAULT_ENDPOINT),
  );
  const [serverDraft, setServerDraft] = useState(serverBaseUrl);
  const [session, setSession] = useState<SessionState | null>(null);
  const [bootstrapState, setBootstrapState] = useState<"booting" | "ready" | "offline">("booting");
  const [connectionState, setConnectionState] = useState<"disconnected" | "connecting" | "connected">(
    "disconnected",
  );
  const [discoveryHint, setDiscoveryHint] = useState<DiscoveryHint>({
    configuredEndpoint: null,
    suggestedBaseUrls: [DEFAULT_ENDPOINT],
  });
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authForm, setAuthForm] = useState({
    username: "",
    password: "",
    displayName: "",
    deviceName: typeof navigator !== "undefined" ? navigator.userAgent.split(" ")[0] : "Device",
  });
  const [selectedRoomId, setSelectedRoomId] = useState<string>("");
  const [roomDetailsById, setRoomDetailsById] = useState<Record<string, RoomDetails>>({});
  const [messageDraft, setMessageDraft] = useState("");
  const [createRoomName, setCreateRoomName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [messageQuery, setMessageQuery] = useState("");
  const [messagesByRoom, setMessagesByRoom] = useState<Record<string, Message[]>>({});
  const [pendingByRoom, setPendingByRoom] = useState<Record<string, PendingTransfer[]>>({});
  const [presenceByRoom, setPresenceByRoom] = useState<Record<string, PresencePayload>>({});
  const [incomingOffers, setIncomingOffers] = useState<IncomingOffer[]>([]);
  const [transfers, setTransfers] = useState<TransferEntry[]>([]);
  const [statusLine, setStatusLine] = useState<string>("正在寻找可用服务…");
  const [errorLine, setErrorLine] = useState<string>("");
  const [recipientUserId, setRecipientUserId] = useState("");
  const [recipientDeviceId, setRecipientDeviceId] = useState("");
  const [requeueDeviceSelections, setRequeueDeviceSelections] = useState<Record<string, string>>({});
  const [deviceRenameDraft, setDeviceRenameDraft] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);
  const [inviteQrDataUrl, setInviteQrDataUrl] = useState("");
  const [messageFilter, setMessageFilter] = useState<"all" | "pinned" | "favorites">("all");

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const activeEndpointRef = useRef(serverBaseUrl);
  const outgoingFilesRef = useRef(new Map<string, File>());
  const peersRef = useRef(new Map<string, WebRtcRuntime>());
  const sessionRef = useRef<SessionState | null>(null);
  const socketMessageHandlerRef = useRef<(type: string, payload?: unknown) => void>(() => {});
  const inviteCodeFromUrlRef = useRef(new URLSearchParams(window.location.search).get("invite")?.trim() ?? "");

  const rooms = session?.rooms ?? [];
  const selectedRoom = selectedRoomId
    ? roomDetailsById[selectedRoomId] ?? rooms.find((room) => room.id === selectedRoomId) ?? null
    : null;
  const activeMessagesRaw = selectedRoomId ? messagesByRoom[selectedRoomId] ?? [] : [];
  const activeMessages = messageQuery.trim()
    ? activeMessagesRaw.filter((message) =>
        `${message.senderDisplayName} ${message.content}`.toLowerCase().includes(messageQuery.trim().toLowerCase()),
      )
    : activeMessagesRaw;
  const visibleMessages = activeMessages.filter((message) => {
    if (messageFilter === "pinned") {
      return message.pinned;
    }
    if (messageFilter === "favorites") {
      return message.favorited;
    }
    return true;
  });
  const activePendingTransfers = selectedRoomId ? pendingByRoom[selectedRoomId] ?? [] : [];
  const roomPresence = selectedRoomId ? presenceByRoom[selectedRoomId] : undefined;
  const roomMembers = roomPresence?.members ?? [];
  const selectableMembers = roomMembers.filter((member) => member.userId !== session?.user.id);
  const activeRecipientUserId = recipientUserId || selectableMembers[0]?.userId || "";
  const selectedMember =
    selectableMembers.find((member) => member.userId === activeRecipientUserId) ?? selectableMembers[0] ?? null;
  const activeRecipientDeviceId =
    recipientDeviceId || selectedMember?.devices.find((device) => device.online)?.id || "";
  const pinnedMessages = activeMessagesRaw.filter((message) => message.pinned);
  const favoriteMessages = activeMessagesRaw.filter((message) => message.favorited);
  const inviteLink = selectedRoom
    ? `${window.location.origin}${window.location.pathname}?invite=${selectedRoom.inviteCode}`
    : "";

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    activeEndpointRef.current = serverBaseUrl;
  }, [serverBaseUrl]);

  useEffect(() => {
    if (!selectedRoomId) {
      return;
    }
    localStorage.setItem(STORAGE_ROOM_KEY, selectedRoomId);
  }, [selectedRoomId]);

  useEffect(() => {
    if (!inviteLink) {
      return;
    }

    let cancelled = false;
    void QRCode.toDataURL(inviteLink, {
      margin: 1,
      width: 220,
      color: {
        dark: "#08111f",
        light: "#f7fbff",
      },
    }).then((dataUrl: string) => {
      if (!cancelled) {
        setInviteQrDataUrl(dataUrl);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [inviteLink]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      setBootstrapState("booting");
      setErrorLine("");
      setStatusLine(`正在连接 ${serverBaseUrl}`);

      try {
        const hint = await requestJson<DiscoveryHint>(serverBaseUrl, "/api/system/discovery-hint");
        if (cancelled) {
          return;
        }
        setDiscoveryHint(hint);
      } catch {
        if (!cancelled) {
          setBootstrapState("offline");
          setStatusLine("未找到服务器。你可能不在同一局域网，或者主机尚未启动。");
        }
        return;
      }

      const token = localStorage.getItem(STORAGE_TOKEN_KEY);
      if (!token) {
        if (!cancelled) {
          setBootstrapState("ready");
          setStatusLine("服务器可用。登录后即可开始同步。");
        }
        return;
      }

      try {
        const bootstrapData = await requestJson<Omit<SessionBootstrap, "token">>(
          serverBaseUrl,
          "/api/me",
          {},
          token,
        );

        if (cancelled) {
          return;
        }

        const nextSession = { token, ...bootstrapData };
        setSession(nextSession);
        setDiscoveryHint(bootstrapData.discoveryHint);
        setBootstrapState("ready");
        setStatusLine(`已连接 ${serverBaseUrl}`);

        const rememberedRoomId = localStorage.getItem(STORAGE_ROOM_KEY);
        const nextRoom =
          bootstrapData.rooms.find((room) => room.id === rememberedRoomId) ?? bootstrapData.rooms[0] ?? null;

        if (nextRoom) {
          startTransition(() => setSelectedRoomId((current) => current || nextRoom.id));
        }

        if (inviteCodeFromUrlRef.current && !cancelled) {
          setJoinCode(inviteCodeFromUrlRef.current);
          pushNotice("info", "检测到邀请参数，登录后可以直接加入该房间。");
        }
      } catch {
        localStorage.removeItem(STORAGE_TOKEN_KEY);
        if (!cancelled) {
          setSession(null);
          setBootstrapState("ready");
          setStatusLine("服务器可用，请重新登录。");
        }
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [serverBaseUrl]);

  function pushNotice(tone: Notice["tone"], text: string) {
    const id = crypto.randomUUID();
    setNotices((current) => [{ id, tone, text }, ...current].slice(0, 4));
    window.setTimeout(() => {
      setNotices((current) => current.filter((notice) => notice.id !== id));
    }, 3200);
  }

  async function copyText(value: string, successText: string) {
    try {
      await navigator.clipboard.writeText(value);
      pushNotice("success", successText);
    } catch {
      pushNotice("error", "复制失败，请检查浏览器权限。");
    }
  }

  useEffect(() => {
    if (!session?.token) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      return;
    }

    let disposed = false;
    const connect = () => {
      if (disposed) {
        return;
      }

      setConnectionState("connecting");
      const socket = new WebSocket(`${buildWsUrl(activeEndpointRef.current)}?token=${session.token}`);
      wsRef.current = socket;

      socket.onopen = () => {
        setConnectionState("connected");
        setStatusLine(`实时连接已建立：${activeEndpointRef.current}`);
      };

      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as SocketEventEnvelope;
        socketMessageHandlerRef.current(message.type, message.payload);
      };

      socket.onclose = () => {
        if (disposed) {
          return;
        }

        setConnectionState("disconnected");
        setStatusLine("实时连接断开，正在尝试重连…");
        reconnectTimerRef.current = window.setTimeout(connect, 2500);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [session?.token]);

  useEffect(() => {
    if (!selectedRoomId || !session?.token) {
      return;
    }

    let cancelled = false;
    void readRoomCache(selectedRoomId).then((cache) => {
      if (!cancelled && cache) {
        setMessagesByRoom((current) => ({ ...current, [selectedRoomId]: cache.messages }));
        setPendingByRoom((current) => ({ ...current, [selectedRoomId]: cache.pendingTransfers }));
      }
    });

    void Promise.all([
      requestJson<{
        room: RoomDetails;
        members: Array<{
          userId: string;
          username: string;
          displayName: string;
          joinedAt: string;
        }>;
        pendingTransfers: PendingTransfer[];
      }>(serverBaseUrl, `/api/rooms/${selectedRoomId}`, {}, session.token),
      requestJson<{ messages: Message[] }>(
        serverBaseUrl,
        `/api/rooms/${selectedRoomId}/messages`,
        {},
        session.token,
      ),
      requestJson<{ pendingTransfers: PendingTransfer[] }>(
        serverBaseUrl,
        `/api/rooms/${selectedRoomId}/pending-transfers`,
        {},
        session.token,
      ),
    ])
      .then(([roomData, messagesData, pendingData]) => {
        if (cancelled) {
          return;
        }

        setRoomDetailsById((current) => ({ ...current, [selectedRoomId]: roomData.room }));
        setMessagesByRoom((current) => ({ ...current, [selectedRoomId]: messagesData.messages }));
        setPendingByRoom((current) => ({
          ...current,
          [selectedRoomId]: pendingData.pendingTransfers,
        }));
        setPresenceByRoom((current) => ({
          ...current,
          [selectedRoomId]:
            current[selectedRoomId] ??
            {
              roomId: selectedRoomId,
              members: roomData.members.map((member) => ({
                ...member,
                online: false,
                devices: [],
              })),
            },
        }));
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setErrorLine(error.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedRoomId, serverBaseUrl, session?.token]);

  useEffect(() => {
    if (!selectedRoomId) {
      return;
    }

    void writeRoomCache(selectedRoomId, {
      messages: messagesByRoom[selectedRoomId] ?? [],
      pendingTransfers: pendingByRoom[selectedRoomId] ?? [],
    });
  }, [messagesByRoom, pendingByRoom, selectedRoomId]);

  function handleSocketMessage(type: string, payload?: unknown) {
    if (type === "auth:ready") {
      const nextSession = payload as Omit<SessionState, "token">;
      setSession((current) => (current ? { ...current, ...nextSession } : current));
      setDeviceRenameDraft(nextSession.device.name);
      return;
    }

    if (type === "room:joined") {
      const room = payload as Room;
      setSession((current) => {
        if (!current || current.rooms.some((item) => item.id === room.id)) {
          return current;
        }
        return { ...current, rooms: [room, ...current.rooms] };
      });
      setRoomDetailsById((current) => ({
        ...current,
        [room.id]: current[room.id] ?? {
          ...room,
          createdByUserId: "",
          createdByDisplayName: "",
          memberCount: 0,
        },
      }));
      pushNotice("success", `已进入房间：${room.name}`);
      startTransition(() => setSelectedRoomId(room.id));
      return;
    }

    if (type === "room:removed") {
      const removedRoomId = (payload as { roomId: string }).roomId;
      setSession((current) =>
        current
          ? { ...current, rooms: current.rooms.filter((room) => room.id !== removedRoomId) }
          : current,
      );
      setMessagesByRoom((current) => {
        const next = { ...current };
        delete next[removedRoomId];
        return next;
      });
      setPendingByRoom((current) => {
        const next = { ...current };
        delete next[removedRoomId];
        return next;
      });
      setPresenceByRoom((current) => {
        const next = { ...current };
        delete next[removedRoomId];
        return next;
      });
      setRoomDetailsById((current) => {
        const next = { ...current };
        delete next[removedRoomId];
        return next;
      });
      if (selectedRoomId === removedRoomId) {
        startTransition(() => setSelectedRoomId(sessionRef.current?.rooms.find((room) => room.id !== removedRoomId)?.id ?? ""));
      }
      pushNotice("info", "你已离开该房间。");
      return;
    }

    if (type === "presence:update") {
      const update = payload as PresencePayload;
      setPresenceByRoom((current) => ({ ...current, [update.roomId]: update }));
      return;
    }

    if (type === "message:text" || type === "message:link") {
      const incoming = payload as Message;
      setMessagesByRoom((current) => ({
        ...current,
        [incoming.roomId]: [...(current[incoming.roomId] ?? []), incoming],
      }));
      if (incoming.roomId !== selectedRoomId && incoming.senderUserId !== sessionRef.current?.user.id) {
        pushNotice("info", `${incoming.senderDisplayName} 在其他房间发来新消息。`);
      }
      return;
    }

    if (type === "app:error") {
      const errorPayload = payload as { message?: string; code?: string };
      const message = errorPayload.message ?? errorPayload.code ?? "服务器拒绝了该操作。";
      setErrorLine(message);
      pushNotice("error", message);
      return;
    }

    if (type === "message:system") {
      const incoming = payload as Message;
      setMessagesByRoom((current) => ({
        ...current,
        [incoming.roomId]: [...(current[incoming.roomId] ?? []), incoming],
      }));
      return;
    }

    if (type === "message:flags") {
      const updated = payload as Message;
      setMessagesByRoom((current) => ({
        ...current,
        [updated.roomId]: (current[updated.roomId] ?? []).map((message) =>
          message.id === updated.id ? { ...message, pinned: updated.pinned, favorited: updated.favorited } : message,
        ),
      }));
      return;
    }

    if (type === "file:offer") {
      const offer = payload as IncomingOffer;
      setIncomingOffers((current) => [offer, ...current]);
      setTransfers((current) => [
        {
          id: offer.transferId,
          roomId: offer.roomId,
          kind: "receive",
          fileName: offer.fileName,
          sizeBytes: offer.sizeBytes,
          mimeType: offer.mimeType,
          peerLabel: offer.senderDisplayName ?? "未知设备",
          stage: "awaiting-accept",
          progress: 0,
          createdAt: new Date().toISOString(),
          clientTransferKey: offer.clientTransferKey,
        },
        ...current.filter((entry) => entry.id !== offer.transferId),
      ]);
      pushNotice("info", `收到文件请求：${offer.fileName}`);
      return;
    }

    if (type === "file:queued") {
      const queuedPayload = payload as {
        pendingTransfer: PendingTransfer;
        transferId: string;
        clientTransferKey: string;
      };
      const pendingTransfer = queuedPayload.pendingTransfer;
      setPendingByRoom((current) => ({
        ...current,
        [pendingTransfer.roomId]: [pendingTransfer, ...(current[pendingTransfer.roomId] ?? [])],
      }));
      setTransfers((current) =>
        current.map((entry) =>
          entry.clientTransferKey === queuedPayload.clientTransferKey
            ? {
                ...entry,
                id: queuedPayload.transferId,
                pendingTransferId: pendingTransfer.id,
                stage: "queued",
                message: "接收方不在线，已创建挂起记录。",
              }
            : entry,
        ),
      );
      pushNotice("info", `文件已挂起：${pendingTransfer.fileName}`);
      return;
    }

    if (type === "transfer:requeue") {
      const requeuePayload = payload as { clientTransferKey: string; transferId: string };
      setTransfers((current) =>
        current.map((entry) =>
          entry.clientTransferKey === requeuePayload.clientTransferKey
            ? { ...entry, id: requeuePayload.transferId, stage: "awaiting-accept" }
            : entry,
        ),
      );
      return;
    }

    if (type === "pending-transfer:deleted") {
      const deletedPayload = payload as { pendingTransferId: string; roomId: string };
      setPendingByRoom((current) => ({
        ...current,
        [deletedPayload.roomId]: (current[deletedPayload.roomId] ?? []).filter(
          (item) => item.id !== deletedPayload.pendingTransferId,
        ),
      }));
      return;
    }

    if (type === "file:accept") {
      void startOutgoingTransfer(
        payload as {
          transferId: string;
          senderDeviceId: string;
          receiverDeviceId: string;
          clientTransferKey: string;
        },
      );
      return;
    }

    if (type === "file:reject") {
      const rejectPayload = payload as { transferId: string };
      setTransfers((current) =>
        current.map((entry) =>
          entry.id === rejectPayload.transferId
            ? { ...entry, stage: "rejected", message: "接收方拒绝了该文件。" }
            : entry,
        ),
      );
      return;
    }

    if (type === "file:signal") {
      void handleSignal(payload as SignalPayload);
      return;
    }

    if (type === "file:progress") {
      const progressPayload = payload as { transferId: string; progress?: number };
      setTransfers((current) =>
        current.map((entry) =>
          entry.id === progressPayload.transferId
            ? {
                ...entry,
                stage: "transferring",
                progress: Math.min(100, Number(progressPayload.progress ?? 0)),
              }
            : entry,
        ),
      );
      return;
    }

    if (type === "file:complete") {
      const completePayload = payload as { transferId: string };
      setTransfers((current) =>
        current.map((entry) =>
          entry.id === completePayload.transferId
            ? { ...entry, stage: "completed", progress: 100, message: "传输完成。" }
            : entry,
        ),
      );
      pushNotice("success", "文件传输完成。");
      return;
    }

    if (type === "file:failed") {
      const failedPayload = payload as { transferId: string; errorCode?: string };
      setTransfers((current) =>
        current.map((entry) =>
          entry.id === failedPayload.transferId
            ? {
                ...entry,
                stage: "failed",
                message: String(failedPayload.errorCode ?? "传输失败"),
              }
            : entry,
        ),
      );
      closePeer(failedPayload.transferId);
      pushNotice("error", `文件传输失败：${String(failedPayload.errorCode ?? "unknown")}`);
    }
  }

  socketMessageHandlerRef.current = handleSocketMessage;

  function sendSocket(type: string, payload: Record<string, unknown>) {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("实时连接尚未建立。");
    }

    socket.send(JSON.stringify({ type, payload }));
  }

  async function startOutgoingTransfer(payload: {
    transferId: string;
    senderDeviceId: string;
    receiverDeviceId: string;
    clientTransferKey: string;
  }) {
    const file = outgoingFilesRef.current.get(payload.clientTransferKey);
    if (!file) {
      setErrorLine("无法找到待发送的文件，请重新选择文件后再试。");
      return;
    }

    const pc = new RTCPeerConnection({ iceServers: [] });
    const channel = pc.createDataChannel("socket-flow-file", { ordered: true });

    const runtime: WebRtcRuntime = {
      pc,
      role: "sender",
      transferId: payload.transferId,
      roomId: selectedRoomId,
      peerDeviceId: payload.receiverDeviceId,
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      receivedBytes: 0,
      chunks: [],
    };

    peersRef.current.set(payload.transferId, runtime);
    setTransfers((current) =>
      current.map((entry) =>
        entry.clientTransferKey === payload.clientTransferKey
          ? { ...entry, id: payload.transferId, stage: "connecting", message: "正在建立直连…" }
          : entry,
      ),
    );

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSocket("file:signal", {
          transferId: payload.transferId,
          targetDeviceId: payload.receiverDeviceId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    channel.onopen = () => {
      void sendFileData(payload.transferId, file, payload.receiverDeviceId, channel);
    };

    channel.onclose = () => {
      closePeer(payload.transferId);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSocket("file:signal", {
      transferId: payload.transferId,
      targetDeviceId: payload.receiverDeviceId,
      description: pc.localDescription,
    });
  }

  async function sendFileData(
    transferId: string,
    file: File,
    targetDeviceId: string,
    channel: RTCDataChannel,
  ) {
    const chunkSize = 64 * 1024;
    let offset = 0;
    channel.bufferedAmountLowThreshold = 256 * 1024;

    while (offset < file.size) {
      if (channel.readyState !== "open") {
        return;
      }

      if (channel.bufferedAmount > 1024 * 1024) {
        await new Promise<void>((resolve) => {
          channel.onbufferedamountlow = () => resolve();
        });
      }

      const chunk = await file.slice(offset, offset + chunkSize).arrayBuffer();
      channel.send(chunk);
      offset += chunk.byteLength;
      const progress = Math.round((offset / file.size) * 100);

      setTransfers((current) =>
        current.map((entry) =>
          entry.id === transferId ? { ...entry, stage: "transferring", progress } : entry,
        ),
      );

      sendSocket("file:progress", {
        transferId,
        targetDeviceId,
        progress,
      });
    }

    sendSocket("file:complete", { transferId, targetDeviceId });
    setTransfers((current) =>
      current.map((entry) =>
        entry.id === transferId ? { ...entry, stage: "completed", progress: 100 } : entry,
      ),
    );
    closePeer(transferId);
  }

  async function handleSignal(payload: SignalPayload) {
    const transferId = String(payload.transferId);
    const runtime = peersRef.current.get(transferId);

    if (!runtime) {
      return;
    }

    if (payload.description) {
      await runtime.pc.setRemoteDescription(payload.description);

      if (runtime.role === "receiver" && payload.description.type === "offer") {
        const answer = await runtime.pc.createAnswer();
        await runtime.pc.setLocalDescription(answer);
        sendSocket("file:signal", {
          transferId,
          targetDeviceId: runtime.peerDeviceId,
          description: runtime.pc.localDescription,
        });
      }
    }

    if (payload.candidate) {
      await runtime.pc.addIceCandidate(payload.candidate);
    }
  }

  function closePeer(transferId: string) {
    const runtime = peersRef.current.get(transferId);
    if (!runtime) {
      return;
    }
    runtime.pc.close();
    peersRef.current.delete(transferId);
  }

  async function acceptOffer(offer: IncomingOffer) {
    const pc = new RTCPeerConnection({ iceServers: [] });
    const runtime: WebRtcRuntime = {
      pc,
      role: "receiver",
      transferId: offer.transferId,
      roomId: offer.roomId,
      peerDeviceId: offer.senderDeviceId,
      fileName: offer.fileName,
      mimeType: offer.mimeType,
      sizeBytes: offer.sizeBytes,
      receivedBytes: 0,
      chunks: [],
    };

    peersRef.current.set(offer.transferId, runtime);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSocket("file:signal", {
          transferId: offer.transferId,
          targetDeviceId: offer.senderDeviceId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      channel.binaryType = "arraybuffer";

      channel.onmessage = (messageEvent) => {
        const chunk = messageEvent.data as ArrayBuffer;
        runtime.chunks.push(chunk);
        runtime.receivedBytes += chunk.byteLength;
        const progress = Math.round((runtime.receivedBytes / runtime.sizeBytes) * 100);
        setTransfers((current) =>
          current.map((entry) =>
            entry.id === offer.transferId ? { ...entry, stage: "transferring", progress } : entry,
          ),
        );
      };

      channel.onclose = () => {
        const blob = new Blob(runtime.chunks, { type: runtime.mimeType });
        const url = URL.createObjectURL(blob);
        setTransfers((current) =>
          current.map((entry) =>
            entry.id === offer.transferId
              ? {
                  ...entry,
                  stage: "completed",
                  progress: 100,
                  downloadUrl: url,
                  message: "文件已接收，可直接保存。",
                }
              : entry,
          ),
        );
        closePeer(offer.transferId);
      };
    };

    setIncomingOffers((current) => current.filter((item) => item.transferId !== offer.transferId));
    setTransfers((current) =>
      current.map((entry) =>
        entry.id === offer.transferId ? { ...entry, stage: "connecting", message: "正在建立接收通道…" } : entry,
      ),
    );

    sendSocket("file:accept", {
      transferId: offer.transferId,
      senderDeviceId: offer.senderDeviceId,
      clientTransferKey: offer.clientTransferKey,
    });
  }

  function rejectOffer(offer: IncomingOffer) {
    setIncomingOffers((current) => current.filter((item) => item.transferId !== offer.transferId));
    setTransfers((current) =>
      current.map((entry) =>
        entry.id === offer.transferId ? { ...entry, stage: "rejected", message: "你拒绝了该文件。" } : entry,
      ),
    );
    sendSocket("file:reject", {
      transferId: offer.transferId,
      senderDeviceId: offer.senderDeviceId,
      clientTransferKey: offer.clientTransferKey,
    });
  }

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorLine("");

    try {
      const result = await requestJson<SessionBootstrap>(
        serverBaseUrl,
        authMode === "login" ? "/api/auth/login" : "/api/auth/register",
        {
          method: "POST",
          body: JSON.stringify(authForm),
        },
      );

      localStorage.setItem(STORAGE_TOKEN_KEY, result.token);
      const nextSession = { ...result };
      setSession(nextSession);
      setDeviceRenameDraft(result.device.name);
      setDiscoveryHint(result.discoveryHint);
      setStatusLine("登录成功，实时连接准备中…");
      const rememberedRoomId = localStorage.getItem(STORAGE_ROOM_KEY);
      const nextRoom = result.rooms.find((room) => room.id === rememberedRoomId) ?? result.rooms[0] ?? null;
      if (nextRoom) {
        startTransition(() => setSelectedRoomId(nextRoom.id));
      }
      pushNotice("success", authMode === "login" ? "登录成功。" : "账号已创建。");
      if (inviteCodeFromUrlRef.current) {
        setJoinCode(inviteCodeFromUrlRef.current);
      }
    } catch (error) {
      setErrorLine((error as Error).message);
      pushNotice("error", (error as Error).message);
    }
  }

  function logout() {
    localStorage.removeItem(STORAGE_TOKEN_KEY);
    setSession(null);
    setSelectedRoomId("");
    setIncomingOffers([]);
    setTransfers([]);
    setDeviceRenameDraft("");
    wsRef.current?.close();
    setStatusLine("已退出登录。");
    pushNotice("info", "已退出登录。");
  }

  async function createRoomSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session?.token || !createRoomName.trim()) {
      return;
    }

    try {
      const response = await requestJson<{ room: Room }>(
        serverBaseUrl,
        "/api/rooms",
        {
          method: "POST",
          body: JSON.stringify({ name: createRoomName }),
        },
        session.token,
      );
      setSession((current) =>
        current ? { ...current, rooms: [response.room, ...current.rooms] } : current,
      );
      setCreateRoomName("");
      pushNotice("success", `房间“${response.room.name}”已创建。`);
      startTransition(() => setSelectedRoomId(response.room.id));
    } catch (error) {
      setErrorLine((error as Error).message);
      pushNotice("error", (error as Error).message);
    }
  }

  async function joinRoomSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session?.token || !joinCode.trim()) {
      return;
    }

    try {
      const response = await requestJson<{ room: Room }>(
        serverBaseUrl,
        "/api/rooms/join",
        {
          method: "POST",
          body: JSON.stringify({ inviteCode: joinCode }),
        },
        session.token,
      );
      setSession((current) => {
        if (!current || current.rooms.some((room) => room.id === response.room.id)) {
          return current;
        }
        return { ...current, rooms: [response.room, ...current.rooms] };
      });
      setJoinCode("");
      if (inviteCodeFromUrlRef.current) {
        inviteCodeFromUrlRef.current = "";
        const url = new URL(window.location.href);
        url.searchParams.delete("invite");
        window.history.replaceState({}, "", url);
      }
      pushNotice("success", `已加入房间“${response.room.name}”。`);
      startTransition(() => setSelectedRoomId(response.room.id));
    } catch (error) {
      setErrorLine((error as Error).message);
      pushNotice("error", (error as Error).message);
    }
  }

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedRoomId || !messageDraft.trim()) {
      return;
    }

    try {
      sendSocket(guessMessageType(messageDraft), {
        roomId: selectedRoomId,
        content: messageDraft,
      });
      setMessageDraft("");
    } catch (error) {
      setErrorLine((error as Error).message);
      pushNotice("error", (error as Error).message);
    }
  }

  function beginNewTransfer(file: File) {
    if (!selectedRoomId || !selectedMember) {
      setErrorLine("请先选择房间和接收对象。");
      return;
    }

    if (file.size > MAX_FILE_BYTES) {
      const message = `文件超过 ${formatBytes(MAX_FILE_BYTES)}，首版不建议传输超大文件。`;
      setErrorLine(message);
      pushNotice("error", message);
      return;
    }

    const clientTransferKey = makeClientTransferKey();
    outgoingFilesRef.current.set(clientTransferKey, file);

    setTransfers((current) => [
      {
        id: clientTransferKey,
        roomId: selectedRoomId,
        kind: "send",
        fileName: file.name,
        sizeBytes: file.size,
        mimeType: file.type,
        peerLabel: selectedMember.displayName,
        stage: "awaiting-accept",
        progress: 0,
        createdAt: new Date().toISOString(),
        clientTransferKey,
      },
      ...current,
    ]);

    sendSocket("file:offer", {
      clientTransferKey,
      roomId: selectedRoomId,
      receiverUserId: activeRecipientUserId,
      receiverDeviceId: activeRecipientDeviceId || null,
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
    });
  }

  function handleTransferFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      beginNewTransfer(file);
    } catch (error) {
      setErrorLine((error as Error).message);
      pushNotice("error", (error as Error).message);
    } finally {
      event.target.value = "";
    }
  }

  function handleRequeueSelection(pendingTransfer: PendingTransfer, file: File) {
    const targetDeviceId = requeueDeviceSelections[pendingTransfer.id];
    if (!targetDeviceId) {
      setErrorLine("请选择一个在线设备后再重发。");
      return;
    }

    const clientTransferKey = makeClientTransferKey();
    outgoingFilesRef.current.set(clientTransferKey, file);

    setTransfers((current) => [
      {
        id: clientTransferKey,
        roomId: pendingTransfer.roomId,
        kind: "send",
        fileName: file.name,
        sizeBytes: file.size,
        mimeType: file.type,
        peerLabel: "重发任务",
        stage: "awaiting-accept",
        progress: 0,
        createdAt: new Date().toISOString(),
        clientTransferKey,
        pendingTransferId: pendingTransfer.id,
      },
      ...current,
    ]);

    sendSocket("transfer:requeue", {
      pendingTransferId: pendingTransfer.id,
      receiverDeviceId: targetDeviceId,
      clientTransferKey,
    });
  }

  async function saveEndpoint() {
    const nextEndpoint = normalizeEndpoint(serverDraft);
    localStorage.setItem(STORAGE_ENDPOINT_KEY, nextEndpoint);

    if (session?.token) {
      try {
        await requestJson<{ serverEndpoint: string }>(
          serverBaseUrl,
          "/api/settings/server-endpoint",
          {
            method: "PATCH",
            body: JSON.stringify({ serverEndpoint: nextEndpoint }),
          },
          session.token,
        );
      } catch (error) {
        setErrorLine((error as Error).message);
        pushNotice("error", (error as Error).message);
      }
    }

    setServerBaseUrl(nextEndpoint);
    setServerDraft(nextEndpoint);
    pushNotice("success", "服务器入口已保存。");
  }

  async function renameCurrentDevice() {
    if (!session?.token || !deviceRenameDraft.trim()) {
      return;
    }

    try {
      const response = await requestJson<{ device: Device }>(
        serverBaseUrl,
        `/api/devices/${session.device.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ name: deviceRenameDraft.trim() }),
        },
        session.token,
      );

      setSession((current) =>
        current
          ? {
              ...current,
              device: response.device,
              devices: current.devices.map((device) =>
                device.id === response.device.id ? response.device : device,
              ),
            }
          : current,
      );
      pushNotice("success", "当前设备名称已更新。");
    } catch (error) {
      setErrorLine((error as Error).message);
      pushNotice("error", (error as Error).message);
    }
  }

  async function leaveCurrentRoom() {
    if (!session?.token || !selectedRoomId) {
      return;
    }

    try {
      await requestJson<{ ok: boolean }>(
        serverBaseUrl,
        `/api/rooms/${selectedRoomId}/leave`,
        { method: "POST" },
        session.token,
      );
    } catch (error) {
      setErrorLine((error as Error).message);
      pushNotice("error", (error as Error).message);
    }
  }

  async function deletePendingTransferAction(pendingTransferId: string) {
    if (!session?.token) {
      return;
    }

    try {
      await requestJson<{ ok: boolean }>(
        serverBaseUrl,
        `/api/pending-transfers/${pendingTransferId}`,
        { method: "DELETE", headers: {} },
        session.token,
      );
      pushNotice("success", "挂起传输已删除。");
    } catch (error) {
      setErrorLine((error as Error).message);
      pushNotice("error", (error as Error).message);
    }
  }

  async function updateMessageFlags(messageId: string, updates: { pinned?: boolean; favorited?: boolean }) {
    if (!session?.token) {
      return;
    }

    try {
      await requestJson<{ message: Message }>(
        serverBaseUrl,
        `/api/messages/${messageId}/flags`,
        {
          method: "PATCH",
          body: JSON.stringify(updates),
        },
        session.token,
      );
    } catch (error) {
      setErrorLine((error as Error).message);
      pushNotice("error", (error as Error).message);
    }
  }

  return (
    <div className="app-shell">
      <div className="notice-stack" aria-live="polite">
        {notices.map((notice) => (
          <div key={notice.id} className={`notice-card ${notice.tone}`}>
            {notice.text}
          </div>
        ))}
      </div>

      <aside className="sidebar">
        <div className="brand-card">
          <p className="eyebrow">LAN-first Socket Hub</p>
          <h1>Flow Socket</h1>
          <p className="subtle">
            固定一台主机常开，其余设备通过浏览器进入。文本实时同步，文件点对点直传。
          </p>
        </div>

        <div className="status-card">
          <div className="status-row">
            <span>API</span>
            <strong>{bootstrapState === "offline" ? "不可达" : "可达"}</strong>
          </div>
          <div className="status-row">
            <span>WebSocket</span>
            <strong>{connectionState}</strong>
          </div>
          <p className="status-line">{statusLine}</p>
          {errorLine ? <p className="error-line">{errorLine}</p> : null}
        </div>

        <div className="card">
          <div className="card-header">
            <h2>服务器入口</h2>
            <button className="ghost-button" type="button" onClick={() => setServerDraft(DEFAULT_ENDPOINT)}>
              当前页
            </button>
          </div>
          <input
            className="text-input"
            value={serverDraft}
            onChange={(event) => setServerDraft(event.target.value)}
            placeholder="http://192.168.1.23:8787"
          />
          <button className="primary-button" type="button" onClick={() => void saveEndpoint()}>
            保存并重连
          </button>

          <div className="discovery-list">
            {(discoveryHint.suggestedBaseUrls ?? []).map((hint) => (
              <button
                key={hint}
                className="hint-button"
                type="button"
                onClick={() => {
                  setServerDraft(hint);
                  setServerBaseUrl(hint);
                  localStorage.setItem(STORAGE_ENDPOINT_KEY, hint);
                }}
              >
                {hint}
              </button>
            ))}
          </div>
        </div>

        {!session ? (
          <form className="card auth-card" onSubmit={handleAuthSubmit}>
            <div className="card-header">
              <h2>{authMode === "login" ? "登录" : "注册"}</h2>
              <button
                className="ghost-button"
                type="button"
                onClick={() => setAuthMode((current) => (current === "login" ? "register" : "login"))}
              >
                {authMode === "login" ? "切到注册" : "切到登录"}
              </button>
            </div>

            <input
              className="text-input"
              value={authForm.username}
              onChange={(event) => setAuthForm((current) => ({ ...current, username: event.target.value }))}
              placeholder="用户名"
              required
            />
            <input
              className="text-input"
              type="password"
              value={authForm.password}
              onChange={(event) => setAuthForm((current) => ({ ...current, password: event.target.value }))}
              placeholder="密码"
              required
            />
            {authMode === "register" ? (
              <input
                className="text-input"
                value={authForm.displayName}
                onChange={(event) => setAuthForm((current) => ({ ...current, displayName: event.target.value }))}
                placeholder="显示名称"
              />
            ) : null}
            <input
              className="text-input"
              value={authForm.deviceName}
              onChange={(event) => setAuthForm((current) => ({ ...current, deviceName: event.target.value }))}
              placeholder="设备名称"
              required
            />
            <button className="primary-button" type="submit">
              {authMode === "login" ? "进入工作台" : "创建账号"}
            </button>
          </form>
        ) : (
          <div className="card user-card">
            <div>
              <p className="eyebrow">登录身份</p>
              <h2>{session.user.displayName}</h2>
              <p className="subtle">
                @{session.user.username} · 当前设备 {session.device.name}
              </p>
            </div>
            <button className="ghost-button" type="button" onClick={logout}>
              退出
            </button>
          </div>
        )}

        {session ? (
          <>
            <div className="card">
              <div className="card-header">
                <h2>我的设备</h2>
                <span>{session.devices.length}</span>
              </div>
              <div className="member-list">
                {session.devices.map((device) => (
                  <div key={device.id} className="member-card">
                    <div className="member-title">
                      <strong>{device.name}</strong>
                      <span className={device.id === session.device.id ? "device-tag active" : "device-tag"}>
                        {device.id === session.device.id ? "当前" : "历史"}
                      </span>
                    </div>
                    <p className="subtle">最近在线 {formatTime(device.lastSeenAt)}</p>
                  </div>
                ))}
              </div>
              <div className="stack-row">
                <input
                  className="text-input"
                  value={deviceRenameDraft}
                  onChange={(event) => setDeviceRenameDraft(event.target.value)}
                  placeholder="修改当前设备名称"
                />
                <button className="primary-button" type="button" onClick={() => void renameCurrentDevice()}>
                  保存当前设备名
                </button>
              </div>
            </div>

            <form className="card" onSubmit={createRoomSubmit}>
              <div className="card-header">
                <h2>新建房间</h2>
              </div>
              <input
                className="text-input"
                value={createRoomName}
                onChange={(event) => setCreateRoomName(event.target.value)}
                placeholder="例如：跨端资料箱"
              />
              <button className="primary-button" type="submit">
                创建
              </button>
            </form>

            <form className="card" onSubmit={joinRoomSubmit}>
              <div className="card-header">
                <h2>加入房间</h2>
              </div>
              <input
                className="text-input"
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value)}
                placeholder="输入邀请码"
              />
              <button className="primary-button" type="submit">
                加入
              </button>
            </form>
          </>
        ) : null}
      </aside>

      <main className="workspace">
        <section className="panel rooms-panel">
          <div className="panel-header">
            <h2>房间</h2>
            <span>{rooms.length}</span>
          </div>
          <div className="room-list">
            {rooms.map((room) => (
              <button
                key={room.id}
                className={`room-tile${room.id === selectedRoomId ? " active" : ""}`}
                type="button"
                onClick={() => startTransition(() => setSelectedRoomId(room.id))}
              >
                <div>
                  <strong>{room.name}</strong>
                  <p>邀请码 {room.inviteCode}</p>
                </div>
                <span>{(presenceByRoom[room.id]?.members ?? []).filter((item) => item.online).length}</span>
              </button>
            ))}
            {!rooms.length ? <p className="empty-text">先登录，然后创建或加入一个房间。</p> : null}
          </div>
        </section>

        <section className="panel chat-panel">
          {selectedRoom ? (
            <>
              <div className="panel-header sticky">
                <div>
                  <p className="eyebrow">当前房间</p>
                  <h2>{selectedRoom.name}</h2>
                  {"createdByDisplayName" in selectedRoom && selectedRoom.createdByDisplayName ? (
                    <p className="subtle">创建者 {selectedRoom.createdByDisplayName}</p>
                  ) : null}
                </div>
                <div className="room-meta">
                  <span>邀请码 {selectedRoom.inviteCode}</span>
                  <span>{roomMembers.length} 位成员</span>
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => void copyText(selectedRoom.inviteCode, "邀请码已复制。")}
                  >
                    复制邀请码
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => void copyText(inviteLink, "邀请链接已复制。")}
                  >
                    复制邀请链接
                  </button>
                  <button className="ghost-button danger" type="button" onClick={() => void leaveCurrentRoom()}>
                    离开房间
                  </button>
                </div>
              </div>

              <div className="toolbar-row">
                <input
                  className="text-input"
                  value={messageQuery}
                  onChange={(event) => setMessageQuery(event.target.value)}
                  placeholder="搜索当前房间消息"
                />
                <div className="toolbar-actions">
                  <button
                    className={`ghost-button filter-chip${messageFilter === "all" ? " active" : ""}`}
                    type="button"
                    onClick={() => setMessageFilter("all")}
                  >
                    全部
                  </button>
                  <button
                    className={`ghost-button filter-chip${messageFilter === "pinned" ? " active" : ""}`}
                    type="button"
                    onClick={() => setMessageFilter("pinned")}
                  >
                    置顶
                  </button>
                  <button
                    className={`ghost-button filter-chip${messageFilter === "favorites" ? " active" : ""}`}
                    type="button"
                    onClick={() => setMessageFilter("favorites")}
                  >
                    收藏
                  </button>
                  <span className="subtle">共 {activeMessagesRaw.length} 条</span>
                </div>
              </div>

              <div className="message-stream">
                {visibleMessages.map((message) => (
                  <article
                    key={message.id}
                    className={`message-card${message.senderUserId === session?.user.id ? " self" : ""}${
                      message.type === "system" ? " system" : ""
                    }`}
                  >
                    <div className="message-topline">
                      <strong>{message.type === "system" ? "系统消息" : message.senderDisplayName}</strong>
                      <span>{formatTime(message.createdAt)}</span>
                    </div>
                    {message.type === "link" ? (
                      <a href={message.content} target="_blank" rel="noreferrer">
                        {message.content}
                      </a>
                    ) : (
                      <p>{message.content}</p>
                    )}
                    {message.type !== "system" ? (
                      <div className="message-actions">
                        <button
                          className={`ghost-button mini${message.pinned ? " active" : ""}`}
                          type="button"
                          onClick={() => void updateMessageFlags(message.id, { pinned: !message.pinned })}
                        >
                          {message.pinned ? "取消置顶" : "置顶"}
                        </button>
                        <button
                          className={`ghost-button mini${message.favorited ? " active" : ""}`}
                          type="button"
                          onClick={() => void updateMessageFlags(message.id, { favorited: !message.favorited })}
                        >
                          {message.favorited ? "取消收藏" : "收藏"}
                        </button>
                      </div>
                    ) : null}
                  </article>
                ))}
                {!visibleMessages.length ? (
                  <div className="empty-state">
                    <h3>这里还没有消息</h3>
                    <p>发一段文字或链接，所有在线成员会通过 WebSocket 实时收到。</p>
                  </div>
                ) : null}
              </div>

              <form className="composer" onSubmit={submitMessage}>
                <textarea
                  value={messageDraft}
                  onChange={(event) => setMessageDraft(event.target.value)}
                  placeholder="输入文本，或者粘贴 http/https 链接…"
                  rows={3}
                />
                <button className="primary-button" type="submit">
                  发送
                </button>
              </form>
            </>
          ) : (
            <div className="empty-state large">
              <h2>等待选择房间</h2>
              <p>左侧创建或加入一个房间后，就可以开始跨设备同步和传文件。</p>
            </div>
          )}
        </section>

        <section className="panel details-panel">
          <div className="panel-header">
            <h2>成员与传输</h2>
          </div>

          {selectedRoom ? (
            <>
              <div className="card compact">
                <p className="eyebrow">房间资料</p>
                <div className="info-grid">
                  <div>
                    <span className="info-label">名称</span>
                    <strong>{selectedRoom.name}</strong>
                  </div>
                  <div>
                    <span className="info-label">邀请码</span>
                    <strong>{selectedRoom.inviteCode}</strong>
                  </div>
                  <div>
                    <span className="info-label">邀请链接</span>
                    <strong className="truncate">{inviteLink}</strong>
                  </div>
                  <div>
                    <span className="info-label">创建时间</span>
                    <strong>{formatTime(selectedRoom.createdAt)}</strong>
                  </div>
                </div>
                {inviteQrDataUrl ? (
                  <div className="qr-block">
                    <img src={inviteQrDataUrl} alt="邀请二维码" />
                    <p className="subtle">同一局域网内扫码后，浏览器会自动填入邀请码。</p>
                  </div>
                ) : null}
              </div>

              <div className="card compact">
                <div className="card-header">
                  <h2>消息标记</h2>
                </div>
                <div className="marker-grid">
                  <div className="marker-column">
                    <p className="eyebrow">置顶消息</p>
                    <div className="mini-list">
                      {pinnedMessages.slice(-5).reverse().map((message) => (
                        <button
                          key={message.id}
                          className="mini-message"
                          type="button"
                          onClick={() => void updateMessageFlags(message.id, { pinned: false })}
                        >
                          <strong>{message.senderDisplayName}</strong>
                          <span>{message.content}</span>
                        </button>
                      ))}
                      {!pinnedMessages.length ? <p className="empty-text">还没有置顶消息。</p> : null}
                    </div>
                  </div>
                  <div className="marker-column">
                    <p className="eyebrow">我的收藏</p>
                    <div className="mini-list">
                      {favoriteMessages.slice(-5).reverse().map((message) => (
                        <button
                          key={message.id}
                          className="mini-message"
                          type="button"
                          onClick={() => void updateMessageFlags(message.id, { favorited: false })}
                        >
                          <strong>{message.senderDisplayName}</strong>
                          <span>{message.content}</span>
                        </button>
                      ))}
                      {!favoriteMessages.length ? <p className="empty-text">还没有收藏消息。</p> : null}
                    </div>
                  </div>
                </div>
              </div>

              <div className="card compact">
                <p className="eyebrow">在线设备</p>
                <div className="member-list">
                  {roomMembers.map((member) => (
                    <div key={member.userId} className="member-card">
                      <div className="member-title">
                        <strong>{member.displayName}</strong>
                        <span className={member.online ? "dot online" : "dot"} />
                      </div>
                      <div className="device-list">
                        {member.devices.length ? (
                          member.devices.map((device) => (
                            <span key={device.id} className={`device-pill${device.online ? " online" : ""}`}>
                              {device.name}
                            </span>
                          ))
                        ) : (
                          <span className="device-pill">暂无在线设备</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="card compact">
                <p className="eyebrow">文件直传</p>
                <select
                  className="text-input"
                  value={activeRecipientUserId}
                  onChange={(event) => {
                    const nextUserId = event.target.value;
                    const member = selectableMembers.find((item) => item.userId === nextUserId) ?? null;
                    setRecipientUserId(nextUserId);
                    setRecipientDeviceId(member?.devices.find((device) => device.online)?.id ?? "");
                  }}
                >
                  {selectableMembers.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.displayName}
                    </option>
                  ))}
                </select>

                <select
                  className="text-input"
                  value={activeRecipientDeviceId}
                  onChange={(event) => setRecipientDeviceId(event.target.value)}
                >
                  <option value="">对方离线时仅创建挂起记录</option>
                  {(selectedMember?.devices ?? [])
                    .filter((device) => device.online)
                    .map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.name}
                      </option>
                    ))}
                </select>

                <label className="upload-button">
                  <input type="file" onChange={handleTransferFileChange} />
                  选择文件并发送
                </label>
                <p className="subtle">首版按 1GB 内稳定设计，超大文件按 best-effort 处理。</p>
              </div>

              <div className="card compact">
                <div className="card-header">
                  <h2>等待你接收</h2>
                </div>
                <div className="offer-list">
                  {incomingOffers
                    .filter((offer) => offer.roomId === selectedRoomId)
                    .map((offer) => (
                      <article key={offer.transferId} className="transfer-card">
                        <div>
                          <strong>{offer.fileName}</strong>
                          <p>
                            {offer.senderDisplayName ?? "未知"} · {formatBytes(offer.sizeBytes)}
                          </p>
                        </div>
                        <div className="action-row">
                          <button className="ghost-button" type="button" onClick={() => rejectOffer(offer)}>
                            拒绝
                          </button>
                          <button className="primary-button" type="button" onClick={() => void acceptOffer(offer)}>
                            接收
                          </button>
                        </div>
                      </article>
                    ))}
                  {!incomingOffers.filter((offer) => offer.roomId === selectedRoomId).length ? (
                    <p className="empty-text">当前没有待接收的文件。</p>
                  ) : null}
                </div>
              </div>

              <div className="card compact">
                <div className="card-header">
                  <h2>挂起传输</h2>
                </div>
                <div className="offer-list">
                  {activePendingTransfers.map((pending) => {
                    const receiver = roomMembers.find((member) => member.userId === pending.receiverUserId) ?? null;
                    const availableDevices = receiver?.devices.filter((device) => device.online) ?? [];

                    return (
                      <article key={pending.id} className="transfer-card">
                        <div>
                          <strong>{pending.fileName}</strong>
                          <p>
                            待给 {receiver?.displayName ?? pending.receiverUserId} · {formatBytes(pending.sizeBytes)}
                          </p>
                        </div>

                        {pending.senderUserId === session?.user.id ? (
                          <div className="stack-row">
                            <select
                              className="text-input"
                              value={requeueDeviceSelections[pending.id] ?? ""}
                              onChange={(event) =>
                                setRequeueDeviceSelections((current) => ({
                                  ...current,
                                  [pending.id]: event.target.value,
                                }))
                              }
                            >
                              <option value="">选择在线设备重发</option>
                              {availableDevices.map((device) => (
                                <option key={device.id} value={device.id}>
                                  {device.name}
                                </option>
                              ))}
                            </select>
                            <label className="upload-button small">
                              <input
                                type="file"
                                onChange={(event) => {
                                  const file = event.target.files?.[0];
                                  if (file) {
                                    handleRequeueSelection(pending, file);
                                  }
                                  event.target.value = "";
                                }}
                              />
                              选文件重发
                            </label>
                            <button
                              className="ghost-button danger"
                              type="button"
                              onClick={() => void deletePendingTransferAction(pending.id)}
                            >
                              删除挂起
                            </button>
                          </div>
                        ) : (
                          <div className="stack-row">
                            <p className="subtle">发送方会在你上线后重新发起。</p>
                            <button
                              className="ghost-button danger"
                              type="button"
                              onClick={() => void deletePendingTransferAction(pending.id)}
                            >
                              删除挂起
                            </button>
                          </div>
                        )}
                      </article>
                    );
                  })}
                  {!activePendingTransfers.length ? <p className="empty-text">没有挂起任务。</p> : null}
                </div>
              </div>

              <div className="card compact">
                <div className="card-header">
                  <h2>最近传输</h2>
                </div>
                <div className="offer-list">
                  {transfers
                    .filter((entry) => entry.roomId === selectedRoomId)
                    .map((entry) => (
                      <article key={`${entry.id}-${entry.createdAt}`} className="transfer-card">
                        <div>
                          <strong>{entry.fileName}</strong>
                          <p>
                            {entry.kind === "send" ? "发给" : "来自"} {entry.peerLabel} · {formatBytes(entry.sizeBytes)}
                          </p>
                          <div className="progress-bar">
                            <span style={{ width: `${entry.progress}%` }} />
                          </div>
                          <p className="subtle">
                            {entry.stage}
                            {entry.message ? ` · ${entry.message}` : ""}
                          </p>
                        </div>
                        {entry.downloadUrl ? (
                          <a className="primary-button small-link" href={entry.downloadUrl} download={entry.fileName}>
                            保存
                          </a>
                        ) : null}
                      </article>
                    ))}
                  {!transfers.filter((entry) => entry.roomId === selectedRoomId).length ? (
                    <p className="empty-text">传输记录会出现在这里。</p>
                  ) : null}
                </div>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <h3>还没有选中房间</h3>
              <p>选中房间后，这里会显示成员状态、待接收文件和挂起记录。</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

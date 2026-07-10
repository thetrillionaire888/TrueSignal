// Telegram MTProto client wrapper using teleproto (GramJS fork).
// Handles: session persistence, interactive auth state machine, channel
// resolution, history iteration, and message serialization.
import { TelegramClient, Api, errors } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { computeCheck } from "teleproto/Password";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { checkControlSignal } from "./ingestion-state";

const API_ID = Number(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH ?? "";

if (!API_ID || !API_HASH) {
  throw new Error(
    "Missing TELEGRAM_API_ID / TELEGRAM_API_HASH. Set them in mini-services/telegram-collector/.env (see https://my.telegram.org → API development tools)"
  );
}

const SESSION_FILE = resolve(import.meta.dir, "session.str");

export type AuthState =
  | "disconnected"
  | "connected"
  | "code_sent"
  | "authenticated"
  | "awaiting_2fa"
  | "error";

export type SessionInfo = {
  state: AuthState;
  me: { id: string; firstName: string; lastName: string; username: string; phone: string } | null;
  sessionSaved: boolean;
  error: string | null;
};

let client: TelegramClient | null = null;
let authState: AuthState = "disconnected";
let authError: string | null = null;
let me: SessionInfo["me"] = null;
let phoneCodeHash: string | null = null;
let pendingPhone: string | null = null;

function loadSession(): StringSession {
  try {
    if (existsSync(SESSION_FILE)) {
      const saved = readFileSync(SESSION_FILE, "utf-8").trim();
      if (saved) return new StringSession(saved);
    }
  } catch (e) {
    console.warn("Failed to load session:", e);
  }
  return new StringSession("");
}

function saveSession() {
  if (!client) return;
  try {
    const str = (client.session as StringSession).save();
    mkdirSync(resolve(import.meta.dir), { recursive: true });
    writeFileSync(SESSION_FILE, str);
    console.log("✓ Session saved to", SESSION_FILE);
  } catch (e) {
    console.warn("Failed to save session:", e);
  }
}

async function getClient(): Promise<TelegramClient> {
  if (client) return client;
  const session = loadSession();
  client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
    useWSS: true,
  });
  return client;
}

export async function connect(): Promise<SessionInfo> {
  try {
    const c = await getClient();
    if (!c.connected) {
      await c.connect();
    }
    // Check if already authenticated (session restored)
    if (sessionSaved()) {
      try {
        await fetchMe(c);
        authState = "authenticated";
        authError = null;
      } catch {
        // session invalid → need fresh login
        authState = "connected";
        authError = null;
      }
    } else {
      authState = "connected";
      authError = null;
    }
  } catch (e) {
    authState = "error";
    authError = e instanceof Error ? e.message : String(e);
  }
  return getSessionInfo();
}

export async function fetchMe(c: TelegramClient) {
  const user = await c.getMe();
  // @ts-expect-error - Api.User shape
  me = {
    id: user.id?.toString?.() ?? String(user.id),
    firstName: user.firstName ?? "",
    lastName: user.lastName ?? "",
    username: user.username ?? "",
    phone: user.phone ?? "",
  };
}

export function sessionSaved(): boolean {
  return existsSync(SESSION_FILE) && readFileSync(SESSION_FILE, "utf-8").trim().length > 0;
}

export function getSessionInfo(): SessionInfo {
  return {
    state: authState,
    me,
    sessionSaved: sessionSaved(),
    error: authError,
  };
}

export async function requestCode(phone: string): Promise<SessionInfo> {
  try {
    const c = await getClient();
    if (!c.connected) await c.connect();
    // Normalize: strip spaces, dashes, parens; keep leading +
    const normalized = phone.replace(/[\s\-()]/g, "");
    pendingPhone = normalized;
    const result = await c.sendCode(
      { apiId: API_ID, apiHash: API_HASH },
      normalized
    );
    phoneCodeHash = result.phoneCodeHash;
    authState = "code_sent";
    authError = null;
  } catch (e) {
    authState = "error";
    authError = e instanceof Error ? e.message : String(e);
  }
  return getSessionInfo();
}

export async function submitCode(code: string): Promise<SessionInfo> {
  try {
    if (!pendingPhone) throw new Error("No pending phone number. Request a code first.");
    if (!phoneCodeHash) throw new Error("No code hash. Request a code first.");
    const c = await getClient();
    try {
      await c.invoke(
        new Api.auth.SignIn({
          phoneNumber: pendingPhone,
          phoneCode: code,
          phoneCodeHash,
        })
      );
      await fetchMe(c);
      saveSession();
      authState = "authenticated";
      authError = null;
    } catch (e: unknown) {
      if (e instanceof errors.SessionPasswordNeededError) {
        authState = "awaiting_2fa";
        authError = null;
      } else {
        throw e;
      }
    }
  } catch (e) {
    authState = "error";
    authError = e instanceof Error ? e.message : String(e);
  }
  return getSessionInfo();
}

export async function submit2fa(password: string): Promise<SessionInfo> {
  try {
    const c = await getClient();
    const pwdInfo = await c.invoke(new Api.account.GetPassword());
    const passwordCheck = await computeCheck(
      pwdInfo as Api.account.Password,
      password
    );
    await c.invoke(new Api.auth.CheckPassword({ password: passwordCheck }));
    await fetchMe(c);
    saveSession();
    authState = "authenticated";
    authError = null;
  } catch (e) {
    authState = "error";
    authError = e instanceof Error ? e.message : String(e);
  }
  return getSessionInfo();
}

export async function logout(): Promise<SessionInfo> {
  try {
    if (client) {
      try {
        await client.invoke(new Api.auth.LogOut());
      } catch {
        /* noop */
      }
      try {
        await client.disconnect();
      } catch {
        /* noop */
      }
    }
  } finally {
    client = null;
    authState = "disconnected";
    authError = null;
    me = null;
    phoneCodeHash = null;
    pendingPhone = null;
    try {
      if (existsSync(SESSION_FILE)) {
        writeFileSync(SESSION_FILE, "");
      }
    } catch {
      /* noop */
    }
  }
  return getSessionInfo();
}

// ── Channel resolution ───────────────────────────────────────────────────────

export type ResolvedChannel = {
  id: string;
  accessHash: string;
  title: string;
  username: string | null;
  type: "channel" | "group" | "supergroup" | "chat";
  participantCount: number;
  verified: boolean;
  megagroup: boolean;
  about: string | null;
};

export async function resolveChannel(query: string): Promise<ResolvedChannel | null> {
  const c = await getClient();
  const q = query.trim();
  let entity: Api.TypeInputPeer | null = null;
  let resolved: ResolvedChannel | null = null;

  // ── Strategy 1: Numeric Peer ID ──────────────────────────────────────────
  // Telegram channel IDs can be provided as:
  //   • raw channel id:  2166348331
  //   • marked peer id:  -1002166348331  (with -100 prefix)
  // We normalize to the raw channel id and try InputPeerChannel with
  // accessHash=0 (works for public channels; private ones require a prior
  // resolution to obtain the access hash).
  const numericMatch = q.match(/^-?100?(\d{6,})$/i) ?? q.match(/^(\d{6,})$/);
  if (numericMatch) {
    const channelIdStr = numericMatch[1];
    const channelId = BigInt(channelIdStr);
    try {
      // Try fetching the full channel info via channels.GetChannels with
      // access_hash=0. For public channels this returns the full Channel
      // object (including the real access_hash we need for GetHistory).
      const result = (await c.invoke(
        new Api.channels.GetChannels({
          id: [
            new Api.InputChannel({
              channelId,
              accessHash: BigInt(0),
            }),
          ],
        })
      )) as Api.messages.TypeMessages;
      const chats = (result as unknown as { chats: Api.TypeChat[] }).chats;
      if (chats && chats.length > 0) {
        const chat = chats[0];
        resolved = chatToChannel(chat);
        const inputPeer = inputPeerFromChat(chat);
        if (inputPeer) {
          entity = inputPeer;
        } else {
          // Build InputPeerChannel manually with the access_hash we just learned
          const ch = chat as unknown as {
            id: { toString(): string };
            accessHash?: { toString(): string };
          };
          if (ch.accessHash != null) {
            entity = new Api.InputPeerChannel({
              channelId: BigInt(ch.id.toString()),
              accessHash: BigInt(ch.accessHash.toString()),
            });
          }
        }
      }
    } catch (e) {
      console.warn(
        `[resolveChannel] peer-id resolution failed for ${q}:`,
        e instanceof Error ? e.message : String(e)
      );
      // fall through to other strategies
    }
  }

  // ── Strategy 2: @username ────────────────────────────────────────────────
  if (!entity && q.startsWith("@")) {
    try {
      const r = (await c.invoke(
        new Api.contacts.ResolveUsername({ username: q.slice(1) })
      )) as Api.contacts.ResolvedPeer;
      entity = r.peer;
      resolved = peerToChannel(r.peer, r.chats);
    } catch {
      /* fall through to search */
    }
  }
  if (!entity) {
    // Global search by title
    try {
      const r = (await c.invoke(
        new Api.messages.SearchGlobal({
          q,
          filter: new Api.InputPeerEmpty(),
          minDate: 0,
          maxDate: 0,
          offsetRate: 0,
          offsetPeer: new Api.InputPeerEmpty(),
          offsetId: 0,
          limit: 10,
        })
      )) as Api.messages.Messages;
      const chats = (r as unknown as { chats: Api.TypeChat[] }).chats;
      for (const chat of chats) {
        const title = (chat as unknown as { title?: string }).title;
        if (title && title.toLowerCase().includes(q.toLowerCase())) {
          resolved = chatToChannel(chat);
          const inputPeer = inputPeerFromChat(chat);
          if (inputPeer) entity = inputPeer;
          break;
        }
      }
      // If no exact match, take the first chat result
      if (!resolved && chats.length > 0) {
        resolved = chatToChannel(chats[0]);
        const inputPeer = inputPeerFromChat(chats[0]);
        if (inputPeer) entity = inputPeer;
      }
    } catch (e) {
      throw new Error(`Channel search failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!entity || !resolved) return null;

  // ── Enrich with full channel info (participant count, about/description) ─
  // The basic resolution methods (GetChannels, ResolveUsername, SearchGlobal)
  // return a Channel object WITHOUT participantsCount or about. We need
  // GetFullChannel to get the real member count and channel description.
  try {
    const inputChannel = entityToInputChannel(entity);
    if (inputChannel) {
      const full = (await c.invoke(
        new Api.channels.GetFullChannel({ channel: inputChannel })
      )) as Api.messages.TypeChatFull;
      const fullChat = (full as unknown as {
        fullChat?: { participantsCount?: number; about?: string };
      }).fullChat;
      if (fullChat) {
        resolved.participantCount = fullChat.participantsCount ?? resolved.participantCount;
        resolved.about = fullChat.about || null;
      }
    }
  } catch (e) {
    // Non-fatal — keep the basic resolution, just without the full count
    console.warn(
      `[resolveChannel] GetFullChannel failed (non-fatal):`,
      e instanceof Error ? e.message : String(e)
    );
  }

  // Attach the input peer for later use
  resolvedChannels.set(resolved.id, entity);
  return resolved;
}

// Convert an InputPeer to an InputChannel (needed for GetFullChannel)
function entityToInputChannel(peer: Api.TypeInputPeer): Api.InputChannel | null {
  if (peer instanceof Api.InputPeerChannel) {
    return new Api.InputChannel({
      channelId: peer.channelId,
      accessHash: peer.accessHash,
    });
  }
  if (peer instanceof Api.InputPeerUser) {
    return null;
  }
  return null;
}

const resolvedChannels = new Map<string, Api.TypeInputPeer>();

function peerToChannel(peer: Api.TypePeer, chats: Api.TypeChat[]): ResolvedChannel | null {
  let chatId: string | null = null;
  if (peer instanceof Api.PeerChannel) chatId = peer.channelId.toString();
  else if (peer instanceof Api.PeerChat) chatId = peer.chatId.toString();
  if (!chatId) return null;
  const chat = chats.find((c) => c.id?.toString() === chatId);
  if (!chat) return null;
  return chatToChannel(chat);
}

function chatToChannel(chat: Api.TypeChat): ResolvedChannel {
  const c = chat as unknown as {
    id: { toString(): string };
    title: string;
    username?: string;
    participantsCount?: number;
    verified?: boolean;
    megagroup?: boolean;
    className: string;
    accessHash?: { toString(): string };
  };
  const className = c.className;
  let type: ResolvedChannel["type"] = "channel";
  if (c.megagroup) type = "supergroup";
  else if (className === "Chat") type = "group";
  else if (className === "Channel") type = c.megagroup ? "supergroup" : "channel";
  return {
    id: c.id.toString(),
    accessHash: c.accessHash?.toString?.() ?? "",
    title: c.title,
    username: c.username ?? null,
    type,
    participantCount: c.participantsCount ?? 0,
    verified: Boolean(c.verified),
    megagroup: Boolean(c.megagroup),
    about: null,
  };
}

function inputPeerFromChat(chat: Api.TypeChat): Api.TypeInputPeer | null {
  const c = chat as unknown as {
    id: { toString(): string };
    accessHash?: { toString(): string };
    className: string;
    megagroup?: boolean;
  };
  if (c.className === "Chat") {
    return new Api.InputPeerChat({ chatId: BigInt(c.id.toString()) });
  }
  // Channel
  const accessHash = c.accessHash;
  if (accessHash != null) {
    return new Api.InputPeerChannel({
      channelId: BigInt(c.id.toString()),
      accessHash: BigInt(accessHash.toString()),
    });
  }
  return null;
}

// ── History iteration + serialization ────────────────────────────────────────

export type SerializedMessage = {
  id: number;
  date: string;
  message: string | null;
  raw: string;
  senderId: string | null;
  senderName: string | null;
  replyToMsgId: number | null;
  hasMedia: boolean;
  mediaType: string | null;
  media: unknown;
  views: number;
  forwards: number;
  reactions: number;
  reactionsList: Array<{ emoticon: string; count: number }>;
  editDate: string | null;
  post: boolean;
  groupedId: string | null;
};

export async function* iterHistory(
  channelId: string,
  limit: number, // 0 = unlimited (fetch all available history)
  onProgress?: (fetched: number) => void,
  resumeOffsetId?: number // resume from this offsetId (exclusive)
): AsyncGenerator<SerializedMessage, void, unknown> {
  const c = await getClient();
  const peer = resolvedChannels.get(channelId);
  if (!peer) throw new Error("Channel not resolved. Call resolveChannel first.");

  let fetched = 0;
  let offsetId = resumeOffsetId ?? 0;
  const unlimited = limit === 0;

  while (unlimited || fetched < limit) {
    // Check pause/stop control signal between batches
    const shouldStop = await checkControlSignal();
    if (shouldStop) break;

    const batchSize = unlimited ? 100 : Math.min(100, limit - fetched);
    const result = (await c.invoke(
      new Api.messages.GetHistory({
        peer,
        offsetId,
        offsetDate: 0,
        addOffset: 0,
        limit: batchSize,
        maxId: 0,
        minId: 0,
        hash: BigInt(0),
      })
    )) as Api.messages.Messages;

    const messages = (result as unknown as { messages: Api.TypeMessage[] }).messages;
    if (!messages || messages.length === 0) break;

    // Cache senders for name resolution
    const users = (result as unknown as { users: Api.TypeUser[] }).users;
    const userMap = new Map<string, string>();
    for (const u of users) {
      const uu = u as unknown as {
        id: { toString(): string };
        firstName?: string;
        lastName?: string;
        title?: string;
      };
      const name = [uu.firstName, uu.lastName].filter(Boolean).join(" ") || uu.title || "Unknown";
      userMap.set(uu.id.toString(), name);
    }

    for (const msg of messages) {
      fetched++;
      onProgress?.(fetched);
      yield serializeMessage(msg, userMap);
      offsetId = (msg as unknown as { id: number }).id;
    }

    if (messages.length < batchSize) break; // no more history
    // delay between batches to avoid Telegram flood waits
    await new Promise((r) => setTimeout(r, 500));
  }
}

function serializeMessage(
  msg: Api.TypeMessage,
  userMap: Map<string, string>
): SerializedMessage {
  const m = msg as unknown as {
    id: number;
    date: { toISOString(): string } | number;
    message: string | null;
    fromId?: { userId?: { toString(): string } } | null;
    peerId?: { channelId?: { toString(): string }; chatId?: { toString(): string }; userId?: { toString(): string } };
    replyTo?: { replyToMsgId?: number } | null;
    media?: Api.TypeMessageMedia | null;
    views?: number;
    forwards?: number;
    reactions?: { results?: Array<{ reaction: { emoticon?: string }; count: number }> } | null;
    editDate?: { toISOString(): string } | number | null;
    post?: boolean;
    groupedId?: { toString(): string } | null;
    className: string;
  };

  const senderId = m.fromId?.userId?.toString?.() ?? m.peerId?.userId?.toString?.() ?? null;
  const senderName = senderId ? userMap.get(senderId) ?? null : (m.post ? "Channel" : null);

  let mediaType: string | null = null;
  let mediaObj: unknown = null;
  if (m.media) {
    const mc = (m.media as unknown as { className: string }).className;
    mediaType = mc?.replace("MessageMedia", "").toLowerCase() ?? "media";
    mediaObj = m.media;
  }

  const reactionsList = (m.reactions?.results ?? []).map((r) => ({
    emoticon: r.reaction?.emoticon ?? "♥",
    count: r.count,
  }));
  const reactions = reactionsList.reduce((a, b) => a + b.count, 0);

  const dateStr = typeof m.date === "number"
    ? new Date(m.date * 1000).toISOString()
    : m.date?.toISOString?.() ?? new Date().toISOString();
  const editDateStr = m.editDate
    ? typeof m.editDate === "number"
      ? new Date(m.editDate * 1000).toISOString()
      : m.editDate?.toISOString?.() ?? null
    : null;

  const serialized: SerializedMessage = {
    id: m.id,
    date: dateStr,
    message: m.message ?? null,
    raw: m.message ?? "",
    senderId,
    senderName,
    replyToMsgId: m.replyTo?.replyToMsgId ?? null,
    hasMedia: Boolean(m.media),
    mediaType,
    media: mediaObj,
    views: m.views ?? 0,
    forwards: m.forwards ?? 0,
    reactions,
    reactionsList,
    editDate: editDateStr,
    post: Boolean(m.post),
    groupedId: m.groupedId?.toString?.() ?? null,
  };

  // Include the full serialized object in `raw` for JSON storage
  serialized.raw = JSON.stringify(serialized);
  return serialized;
}

/**
 * Client WebSocket message handling.
 *
 * Extracted from SessionDO to reduce file size. All functions receive
 * a HandlerDeps object built by the DO.
 */

import { generateId, hashToken } from "../auth/crypto";
import { DEFAULT_MODEL, isValidModel } from "../utils/models";
import type {
  ClientInfo,
  ClientMessage,
  ServerMessage,
  SandboxEvent,
  SessionState,
  ParticipantPresence,
  SandboxStatus,
} from "../types";
import type { HandlerDeps } from "./handler-context";
import {
  getGitHubAvatarUrl,
  createParticipantRecord,
  writeUserMessageEvent,
  validateReasoningEffort,
} from "./handler-context";
import { processMessageQueue, spawnSandbox } from "./sandbox-handler";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Handle a parsed WebSocket message from a client connection.
 */
export async function handleClientMessage(
  deps: HandlerDeps,
  ws: WebSocket,
  message: string
): Promise<void> {
  try {
    const data = JSON.parse(message) as ClientMessage;

    switch (data.type) {
      case "ping":
        deps.safeSend(ws, { type: "pong", timestamp: Date.now() });
        break;

      case "subscribe":
        await handleSubscribe(deps, ws, data);
        break;

      case "prompt":
        await handlePromptMessage(deps, ws, data);
        break;

      case "stop": {
        const { stopExecution } = await import("./sandbox-handler");
        await stopExecution(deps);
        break;
      }

      case "typing":
        await handleTyping(deps);
        break;

      case "fetch_history":
        handleFetchHistory(deps, ws, data);
        break;

      case "presence":
        await updatePresence(deps, ws, data);
        break;
    }
  } catch (e) {
    deps.log.error("Error processing client message", {
      error: e instanceof Error ? e : String(e),
    });
    deps.safeSend(ws, {
      type: "error",
      code: "INVALID_MESSAGE",
      message: "Failed to process message",
    });
  }
}

// ---------------------------------------------------------------------------
// Internal handlers
// ---------------------------------------------------------------------------

/**
 * Handle client subscription with token validation.
 */
async function handleSubscribe(
  deps: HandlerDeps,
  ws: WebSocket,
  data: { token: string; clientId: string }
): Promise<void> {
  const { repository, wsManager, log, safeSend } = deps;

  if (!data.token) {
    log.warn("ws.connect", {
      event: "ws.connect",
      ws_type: "client",
      outcome: "auth_failed",
      reject_reason: "no_token",
    });
    ws.close(4001, "Authentication required");
    return;
  }

  const tokenHash = await hashToken(data.token);
  const participant = repository.getParticipantByWsTokenHash(tokenHash);

  if (!participant) {
    log.warn("ws.connect", {
      event: "ws.connect",
      ws_type: "client",
      outcome: "auth_failed",
      reject_reason: "invalid_token",
    });
    ws.close(4001, "Invalid authentication token");
    return;
  }

  log.info("ws.connect", {
    event: "ws.connect",
    ws_type: "client",
    outcome: "success",
    participant_id: participant.id,
    user_id: participant.user_id,
    client_id: data.clientId,
  });

  const clientInfo: ClientInfo = {
    participantId: participant.id,
    userId: participant.user_id,
    name: participant.github_name || participant.github_login || participant.user_id,
    avatar: getGitHubAvatarUrl(participant.github_login),
    status: "active",
    lastSeen: Date.now(),
    clientId: data.clientId,
    ws,
  };

  wsManager.setClient(ws, clientInfo);

  const parsed = wsManager.classify(ws);
  if (parsed.kind === "client" && parsed.wsId) {
    wsManager.persistClientMapping(parsed.wsId, participant.id, data.clientId);
    log.debug("Stored ws_client_mapping", {
      ws_id: parsed.wsId,
      participant_id: participant.id,
    });
  }

  // Send session state
  const state = getSessionState(deps);
  safeSend(ws, {
    type: "subscribed",
    sessionId: state.id,
    state,
    participantId: participant.id,
    participant: {
      participantId: participant.id,
      name: participant.github_name || participant.github_login || participant.user_id,
      avatar: getGitHubAvatarUrl(participant.github_login),
    },
  } as ServerMessage);

  const sandbox = repository.getSandbox();
  if (sandbox?.last_spawn_error) {
    safeSend(ws, { type: "sandbox_error", error: sandbox.last_spawn_error });
  }

  // Send historical events
  const replay = sendHistoricalEvents(deps, ws);

  safeSend(ws, {
    type: "replay_complete",
    hasMore: replay.hasMore,
    cursor: replay.oldestItem
      ? { timestamp: replay.oldestItem.created_at, id: replay.oldestItem.id }
      : null,
  } as ServerMessage);

  sendPresence(deps, ws);
  broadcastPresence(deps);
}

/**
 * Handle prompt message from client.
 */
async function handlePromptMessage(
  deps: HandlerDeps,
  ws: WebSocket,
  data: {
    content: string;
    model?: string;
    reasoningEffort?: string;
    attachments?: Array<{ type: string; name: string; url?: string; content?: string }>;
  }
): Promise<void> {
  const { repository, log, safeSend } = deps;

  const client = getClientInfo(deps, ws);
  if (!client) {
    safeSend(ws, {
      type: "error",
      code: "NOT_SUBSCRIBED",
      message: "Must subscribe first",
    });
    return;
  }

  const messageId = generateId();
  const now = Date.now();

  let participant = repository.getParticipantByUserId(client.userId);
  if (!participant) {
    participant = createParticipantRecord(deps, client.userId, client.name);
  }

  // Validate per-message model override
  let messageModel: string | null = null;
  if (data.model) {
    if (isValidModel(data.model)) {
      messageModel = data.model;
    } else {
      log.warn("Invalid message model, ignoring override", { model: data.model });
    }
  }

  // Validate per-message reasoning effort
  const effectiveModelForEffort = messageModel || repository.getSession()?.model || DEFAULT_MODEL;
  const messageReasoningEffort = validateReasoningEffort(
    log,
    effectiveModelForEffort,
    data.reasoningEffort
  );

  repository.createMessage({
    id: messageId,
    authorId: participant.id,
    content: data.content,
    source: "web",
    model: messageModel,
    reasoningEffort: messageReasoningEffort,
    attachments: data.attachments ? JSON.stringify(data.attachments) : null,
    status: "pending",
    createdAt: now,
  });

  writeUserMessageEvent(deps, participant, data.content, messageId, now);

  const position = repository.getPendingOrProcessingCount();

  log.info("prompt.enqueue", {
    event: "prompt.enqueue",
    message_id: messageId,
    source: "web",
    author_id: participant.id,
    user_id: client.userId,
    model: messageModel,
    reasoning_effort: messageReasoningEffort,
    content_length: data.content.length,
    has_attachments: !!data.attachments?.length,
    attachments_count: data.attachments?.length ?? 0,
    queue_position: position,
  });

  safeSend(ws, {
    type: "prompt_queued",
    messageId,
    position,
  } as ServerMessage);

  await processMessageQueue(deps);
}

/**
 * Handle typing indicator (warm sandbox).
 */
async function handleTyping(deps: HandlerDeps): Promise<void> {
  if (!deps.wsManager.getSandboxSocket()) {
    if (!deps.lifecycleManager.isSpawning()) {
      deps.broadcast({ type: "sandbox_warming" } as ServerMessage);
      await spawnSandbox(deps);
    }
  }
}

/**
 * Handle fetch_history request from client for paginated history loading.
 */
function handleFetchHistory(
  deps: HandlerDeps,
  ws: WebSocket,
  data: { cursor?: { timestamp: number; id: string }; limit?: number }
): void {
  const { repository, safeSend } = deps;

  const client = getClientInfo(deps, ws);
  if (!client) {
    safeSend(ws, {
      type: "error",
      code: "NOT_SUBSCRIBED",
      message: "Must subscribe first",
    });
    return;
  }

  if (
    !data.cursor ||
    typeof data.cursor.timestamp !== "number" ||
    typeof data.cursor.id !== "string"
  ) {
    safeSend(ws, {
      type: "error",
      code: "INVALID_CURSOR",
      message: "Invalid cursor",
    });
    return;
  }

  // Rate limit: reject if < 200ms since last fetch
  const now = Date.now();
  if (client.lastFetchHistoryAt && now - client.lastFetchHistoryAt < 200) {
    safeSend(ws, {
      type: "error",
      code: "RATE_LIMITED",
      message: "Too many requests",
    });
    return;
  }
  client.lastFetchHistoryAt = now;

  const rawLimit = typeof data.limit === "number" ? data.limit : 200;
  const limit = Math.max(1, Math.min(rawLimit, 500));
  const page = repository.getEventsHistoryPage(data.cursor.timestamp, data.cursor.id, limit);

  const items: SandboxEvent[] = [];
  for (const event of page.events) {
    try {
      items.push(JSON.parse(event.data));
    } catch {
      // Skip malformed events
    }
  }

  const oldestEvent = page.events.length > 0 ? page.events[0] : null;

  safeSend(ws, {
    type: "history_page",
    items,
    hasMore: page.hasMore,
    cursor: oldestEvent ? { timestamp: oldestEvent.created_at, id: oldestEvent.id } : null,
  } as ServerMessage);
}

/**
 * Update client presence.
 */
async function updatePresence(
  deps: HandlerDeps,
  ws: WebSocket,
  data: { status: "active" | "idle"; cursor?: { line: number; file: string } }
): Promise<void> {
  const client = getClientInfo(deps, ws);
  if (client) {
    client.status = data.status;
    client.lastSeen = Date.now();
    broadcastPresence(deps);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers (also used by internal-routes via re-export)
// ---------------------------------------------------------------------------

/**
 * Get current session state for sending to clients.
 */
export function getSessionState(deps: HandlerDeps): SessionState {
  const session = deps.repository.getSession();
  const sandbox = deps.repository.getSandbox();
  const messageCount = deps.repository.getMessageCount();
  const isProcessing = deps.repository.getProcessingMessage() !== null;

  return {
    id: session?.id ?? deps.ctx.id.toString(),
    title: session?.title ?? null,
    repoOwner: session?.repo_owner ?? "",
    repoName: session?.repo_name ?? "",
    branchName: session?.branch_name ?? null,
    status: session?.status ?? "created",
    sandboxStatus: (sandbox?.status ?? "pending") as SandboxStatus,
    messageCount,
    createdAt: session?.created_at ?? Date.now(),
    model: session?.model ?? DEFAULT_MODEL,
    reasoningEffort: session?.reasoning_effort ?? undefined,
    isProcessing,
  };
}

/**
 * Get client info for a WebSocket, reconstructing from storage if needed after hibernation.
 */
export function getClientInfo(deps: HandlerDeps, ws: WebSocket): ClientInfo | null {
  const { wsManager, log } = deps;

  // 1. In-memory cache
  const cached = wsManager.getClient(ws);
  if (cached) return cached;

  // 2. DB recovery
  const mapping = wsManager.recoverClientMapping(ws);
  if (!mapping) {
    log.warn("No client mapping found after hibernation, closing WebSocket");
    wsManager.close(ws, 4002, "Session expired, please reconnect");
    return null;
  }

  // 3. Build ClientInfo
  log.info("Recovered client info from DB", { user_id: mapping.user_id });
  const clientInfo: ClientInfo = {
    participantId: mapping.participant_id,
    userId: mapping.user_id,
    name: mapping.github_name || mapping.github_login || mapping.user_id,
    avatar: getGitHubAvatarUrl(mapping.github_login),
    status: "active",
    lastSeen: Date.now(),
    clientId: mapping.client_id || `client-${Date.now()}`,
    ws,
  };

  // 4. Re-cache
  wsManager.setClient(ws, clientInfo);
  return clientInfo;
}

// ---------------------------------------------------------------------------
// Presence helpers
// ---------------------------------------------------------------------------

/** Send presence info to a specific client. */
export function sendPresence(deps: HandlerDeps, ws: WebSocket): void {
  const participants = getPresenceList(deps);
  deps.safeSend(ws, { type: "presence_sync", participants });
}

/** Broadcast presence to all clients. */
export function broadcastPresence(deps: HandlerDeps): void {
  const participants = getPresenceList(deps);
  deps.broadcast({ type: "presence_update", participants });
}

/** Get list of present participants. */
function getPresenceList(deps: HandlerDeps): ParticipantPresence[] {
  return Array.from(deps.wsManager.getAuthenticatedClients()).map((c) => ({
    participantId: c.participantId,
    userId: c.userId,
    name: c.name,
    avatar: c.avatar,
    status: c.status,
    lastSeen: c.lastSeen,
  }));
}

/**
 * Send historical events to a newly connected client.
 */
function sendHistoricalEvents(
  deps: HandlerDeps,
  ws: WebSocket
): { hasMore: boolean; oldestItem: { created_at: number; id: string } | null } {
  const REPLAY_LIMIT = 500;
  const events = deps.repository.getEventsForReplay(REPLAY_LIMIT);
  const hasMore = events.length >= REPLAY_LIMIT;

  for (const event of events) {
    try {
      const eventData = JSON.parse(event.data);
      deps.safeSend(ws, { type: "sandbox_event", event: eventData });
    } catch {
      // Skip malformed events
    }
  }

  const oldestItem =
    events.length > 0 ? { created_at: events[0].created_at, id: events[0].id } : null;

  return { hasMore, oldestItem };
}

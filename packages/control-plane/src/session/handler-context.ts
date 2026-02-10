/**
 * HandlerDeps — shared dependency object threaded through extracted handler modules.
 *
 * Built by SessionDO from its lazy accessors and passed to handler functions in
 * internal-routes.ts, client-handler.ts, and sandbox-handler.ts.
 */

import type { Logger } from "../logger";
import type { SessionRepository } from "./repository";
import type { SessionWebSocketManager } from "./websocket-manager";
import type { SandboxLifecycleManager } from "../sandbox/lifecycle/manager";
import type { SourceControlProvider } from "../source-control";
import type { Env, ServerMessage, SandboxEvent } from "../types";
import type { ParticipantRow } from "./types";
import { generateId } from "../auth/crypto";
import { isValidReasoningEffort } from "../utils/models";

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into extracted handler modules.
 * Built once per call-site by SessionDO and passed to handler functions.
 */
export interface HandlerDeps {
  readonly env: Env;
  readonly ctx: DurableObjectState;
  readonly repository: SessionRepository;
  readonly log: Logger;
  readonly wsManager: SessionWebSocketManager;
  readonly lifecycleManager: SandboxLifecycleManager;
  readonly sourceControlProvider: SourceControlProvider;

  /** Mutable map for tracking pending push operations by normalized branch name. */
  readonly pendingPushResolvers: Map<string, { resolve: () => void; reject: (err: Error) => void }>;

  /** Broadcast a ServerMessage to all authenticated client WebSockets. */
  broadcast(message: ServerMessage): void;
  /** Safe-send a message over a single WebSocket. Returns true on success. */
  safeSend(ws: WebSocket, message: string | object): boolean;
}

// ---------------------------------------------------------------------------
// Shared utility functions used by multiple handler modules
// ---------------------------------------------------------------------------

/** Build GitHub avatar URL from login. */
export function getGitHubAvatarUrl(githubLogin: string | null | undefined): string | undefined {
  return githubLogin ? `https://github.com/${githubLogin}.png` : undefined;
}

/**
 * Create a participant with the "member" role and return the full row.
 * Used by client-handler (handlePromptMessage) and internal-routes
 * (handleInit, handleEnqueuePrompt, handleAddParticipant).
 */
export function createParticipantRecord(
  deps: HandlerDeps,
  userId: string,
  name: string
): ParticipantRow {
  const id = generateId();
  const now = Date.now();

  deps.repository.createParticipant({
    id,
    userId,
    githubName: name,
    role: "member",
    joinedAt: now,
  });

  return {
    id,
    user_id: userId,
    github_user_id: null,
    github_login: null,
    github_email: null,
    github_name: name,
    role: "member",
    github_access_token_encrypted: null,
    github_refresh_token_encrypted: null,
    github_token_expires_at: null,
    ws_auth_token: null,
    ws_token_created_at: null,
    joined_at: now,
  };
}

/**
 * Write a user_message event to the events table and broadcast to connected clients.
 * Used by both WebSocket prompt handler and HTTP prompt endpoint for unified timeline replay.
 */
export function writeUserMessageEvent(
  deps: HandlerDeps,
  participant: ParticipantRow,
  content: string,
  messageId: string,
  now: number
): void {
  const userMessageEvent: SandboxEvent = {
    type: "user_message",
    content,
    messageId,
    timestamp: now / 1000, // Convert to seconds to match other events
    author: {
      participantId: participant.id,
      name: participant.github_name || participant.github_login || participant.user_id,
      avatar: getGitHubAvatarUrl(participant.github_login),
    },
  };

  deps.repository.createEvent({
    id: generateId(),
    type: "user_message",
    data: JSON.stringify(userMessageEvent),
    messageId,
    createdAt: now,
  });

  deps.broadcast({ type: "sandbox_event", event: userMessageEvent });
}

/**
 * Validate reasoning effort against a model's allowed values.
 * Returns the validated effort string or null if invalid/absent.
 */
export function validateReasoningEffort(
  log: Logger,
  model: string,
  effort: string | undefined
): string | null {
  if (!effort) return null;
  if (isValidReasoningEffort(model, effort)) return effort;
  log.warn("Invalid reasoning effort for model, ignoring", {
    model,
    reasoning_effort: effort,
  });
  return null;
}

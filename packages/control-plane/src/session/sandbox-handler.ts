/**
 * Sandbox message handling and message queue processing.
 *
 * Extracted from SessionDO to reduce file size. All functions receive
 * a HandlerDeps object built by the DO.
 */

import { generateId } from "../auth/crypto";
import { getValidModelOrDefault, getDefaultReasoningEffort } from "../utils/models";
import type { SandboxEvent, ServerMessage } from "../types";
import type { SandboxCommand } from "./types";
import type { HandlerDeps } from "./handler-context";
import type { GitPushSpec } from "../source-control";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Handle a raw WebSocket message from the sandbox connection.
 */
export async function handleSandboxMessage(
  deps: HandlerDeps,
  _ws: WebSocket,
  message: string
): Promise<void> {
  try {
    const event = JSON.parse(message) as SandboxEvent;
    await processSandboxEvent(deps, event);
  } catch (e) {
    deps.log.error("Error processing sandbox message", {
      error: e instanceof Error ? e : String(e),
    });
  }
}

/**
 * Process a sandbox event (from WebSocket or HTTP endpoint).
 */
export async function processSandboxEvent(deps: HandlerDeps, event: SandboxEvent): Promise<void> {
  const { repository, log, broadcast } = deps;

  // Heartbeats and token streams are high-frequency — keep at debug to avoid noise
  // execution_complete is covered by the prompt.complete wide event below
  if (event.type === "heartbeat" || event.type === "token") {
    log.debug("Sandbox event", { event_type: event.type });
  } else if (event.type !== "execution_complete") {
    log.info("Sandbox event", { event_type: event.type });
  }

  const now = Date.now();

  // Heartbeats update the sandbox table (for health monitoring) but are not
  // stored as events — they are high-frequency noise that drowns out real
  // content in replay and pagination queries.
  if (event.type === "heartbeat") {
    repository.updateSandboxHeartbeat(now);
    return;
  }

  const eventId = generateId();

  // Get messageId from the event first (sandbox sends correct messageId with every event)
  // Only fall back to DB lookup if event doesn't include messageId (legacy fallback)
  // This prevents race conditions where events from message A arrive after message B starts processing
  const eventMessageId = "messageId" in event ? event.messageId : null;
  const processingMessage = repository.getProcessingMessage();
  const messageId = eventMessageId ?? processingMessage?.id ?? null;

  // Store event
  repository.createEvent({
    id: eventId,
    type: event.type,
    data: JSON.stringify(event),
    messageId,
    createdAt: now,
  });

  // Handle specific event types
  if (event.type === "execution_complete") {
    const completionMessageId = messageId;

    // Only update message status if it's still processing (not already stopped)
    const isStillProcessing =
      completionMessageId != null && processingMessage?.id === completionMessageId;

    if (isStillProcessing) {
      const status = event.success ? "completed" : "failed";
      repository.updateMessageCompletion(completionMessageId, status, now);

      const timestamps = repository.getMessageTimestamps(completionMessageId);
      const totalDurationMs = timestamps ? now - timestamps.created_at : undefined;
      const processingDurationMs =
        timestamps?.started_at != null ? now - timestamps.started_at : undefined;
      const queueDurationMs =
        timestamps?.started_at != null ? timestamps.started_at - timestamps.created_at : undefined;

      log.info("prompt.complete", {
        event: "prompt.complete",
        message_id: completionMessageId,
        outcome: event.success ? "success" : "failure",
        message_status: status,
        total_duration_ms: totalDurationMs,
        processing_duration_ms: processingDurationMs,
        queue_duration_ms: queueDurationMs,
      });

      broadcast({ type: "sandbox_event", event });
      broadcast({
        type: "processing_status",
        isProcessing: repository.getProcessingMessage() !== null,
      });
      deps.ctx.waitUntil(notifySlackBot(deps, completionMessageId, event.success));
    } else {
      log.info("prompt.complete", {
        event: "prompt.complete",
        message_id: completionMessageId,
        outcome: "already_stopped",
      });
    }

    // Always run these regardless of stop (snapshot, activity, queue drain)
    deps.ctx.waitUntil(deps.lifecycleManager.triggerSnapshot("execution_complete"));
    deps.lifecycleManager.updateLastActivity(now);
    await deps.lifecycleManager.scheduleInactivityCheck();
    await processMessageQueue(deps);
    return; // execution_complete handling is done; skip the generic broadcast below
  }

  if (event.type === "git_sync") {
    repository.updateSandboxGitSyncStatus(event.status);

    if (event.sha) {
      repository.updateSessionCurrentSha(event.sha);
    }
  }

  // Handle push completion events
  if (event.type === "push_complete" || event.type === "push_error") {
    handlePushEvent(deps, event);
  }

  // Broadcast to clients (all non-execution_complete events)
  broadcast({ type: "sandbox_event", event });
}

/**
 * Process the message queue — dispatch the next pending message to the sandbox.
 */
export async function processMessageQueue(deps: HandlerDeps): Promise<void> {
  const { repository, wsManager, log, broadcast, safeSend, lifecycleManager } = deps;

  // Check if already processing
  if (repository.getProcessingMessage()) {
    log.debug("processMessageQueue: already processing, returning");
    return;
  }

  // Get next pending message
  const message = repository.getNextPendingMessage();
  if (!message) {
    return;
  }
  const now = Date.now();

  // Check if sandbox is connected (with hibernation recovery)
  const sandboxWs = wsManager.getSandboxSocket();
  if (!sandboxWs) {
    log.info("prompt.dispatch", {
      event: "prompt.dispatch",
      message_id: message.id,
      outcome: "deferred",
      reason: "no_sandbox",
    });
    broadcast({ type: "sandbox_spawning" } as ServerMessage);
    await spawnSandbox(deps);
    return;
  }

  // Mark as processing
  repository.updateMessageToProcessing(message.id, now);

  // Broadcast processing status change
  broadcast({ type: "processing_status", isProcessing: true });

  // Reset activity timer — user is actively using the sandbox
  lifecycleManager.updateLastActivity(now);

  // Get author info
  const author = repository.getParticipantById(message.author_id);

  // Get session for default model
  const session = repository.getSession();

  // Send to sandbox with model (per-message override or session default)
  const resolvedModel = getValidModelOrDefault(message.model || session?.model);

  // Resolve reasoning effort: per-message > session default > model default
  const resolvedEffort =
    message.reasoning_effort ??
    session?.reasoning_effort ??
    getDefaultReasoningEffort(resolvedModel);

  const command: SandboxCommand = {
    type: "prompt",
    messageId: message.id,
    content: message.content,
    model: resolvedModel,
    reasoningEffort: resolvedEffort,
    author: {
      userId: author?.user_id ?? "unknown",
      githubName: author?.github_name ?? null,
      githubEmail: author?.github_email ?? null,
    },
    attachments: message.attachments ? JSON.parse(message.attachments) : undefined,
  };

  const sent = safeSend(sandboxWs, command);

  log.info("prompt.dispatch", {
    event: "prompt.dispatch",
    message_id: message.id,
    outcome: sent ? "sent" : "send_failed",
    model: resolvedModel,
    reasoning_effort: resolvedEffort,
    author_id: message.author_id,
    user_id: author?.user_id ?? "unknown",
    source: message.source,
    has_sandbox_ws: true,
    sandbox_ready_state: sandboxWs.readyState,
    queue_wait_ms: now - message.created_at,
    has_attachments: !!message.attachments,
  });
}

/**
 * Stop current execution.
 * Marks the processing message as failed, broadcasts synthetic execution_complete
 * so all clients flush buffered tokens, and forwards stop to the sandbox.
 */
export async function stopExecution(deps: HandlerDeps): Promise<void> {
  const { repository, wsManager, log, broadcast } = deps;
  const now = Date.now();
  const processingMessage = repository.getProcessingMessage();

  if (processingMessage) {
    repository.updateMessageCompletion(processingMessage.id, "failed", now);
    log.info("prompt.stopped", {
      event: "prompt.stopped",
      message_id: processingMessage.id,
    });

    // Broadcast synthetic execution_complete so ALL clients flush buffered tokens.
    broadcast({
      type: "sandbox_event",
      event: {
        type: "execution_complete",
        messageId: processingMessage.id,
        success: false,
        sandboxId: "",
        timestamp: now / 1000,
      },
    });

    // Notify slack-bot now because the bridge's late execution_complete will hit
    // the "already_stopped" branch in processSandboxEvent() which skips notification.
    deps.ctx.waitUntil(notifySlackBot(deps, processingMessage.id, false));
  }

  // Immediate client feedback
  broadcast({ type: "processing_status", isProcessing: false });

  // Forward stop to sandbox
  const sandboxWs = wsManager.getSandboxSocket();
  if (sandboxWs) {
    wsManager.send(sandboxWs, { type: "stop" });
  }
}

/**
 * Spawn a sandbox via the lifecycle manager.
 */
export async function spawnSandbox(deps: HandlerDeps): Promise<void> {
  await deps.lifecycleManager.spawnSandbox();
}

/**
 * Warm sandbox proactively (e.g., when user starts typing).
 */
export async function warmSandbox(deps: HandlerDeps): Promise<void> {
  await deps.lifecycleManager.warmSandbox();
}

/**
 * Push a branch to remote via the sandbox.
 * Sends push command to sandbox and waits for completion or error.
 */
export async function pushBranchToRemote(
  deps: HandlerDeps,
  branchName: string,
  pushSpec: GitPushSpec
): Promise<{ success: true } | { success: false; error: string }> {
  const { wsManager, log, safeSend, pendingPushResolvers } = deps;
  const sandboxWs = wsManager.getSandboxSocket();

  if (!sandboxWs) {
    log.info("No sandbox connected, assuming branch was pushed manually");
    return { success: true };
  }

  const normalizedBranch = normalizeBranchName(branchName);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const pushPromise = new Promise<void>((resolve, reject) => {
    pendingPushResolvers.set(normalizedBranch, { resolve, reject });

    // Timeout after 180 seconds (3 minutes)
    timeoutId = setTimeout(() => {
      if (pendingPushResolvers.has(normalizedBranch)) {
        pendingPushResolvers.delete(normalizedBranch);
        reject(new Error("Push operation timed out after 180 seconds"));
      }
    }, 180000);
  });

  log.info("Sending push command", { branch_name: branchName });
  safeSend(sandboxWs, { type: "push", pushSpec });

  try {
    await pushPromise;
    log.info("Push completed successfully", { branch_name: branchName });
    return { success: true };
  } catch (pushError) {
    log.error("Push failed", {
      branch_name: branchName,
      error: pushError instanceof Error ? pushError : String(pushError),
    });
    return { success: false, error: `Failed to push branch: ${pushError}` };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Normalize branch name for comparison to handle case and whitespace differences. */
function normalizeBranchName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Handle push completion or error events from sandbox.
 * Resolves or rejects the pending push promise for the branch.
 */
function handlePushEvent(deps: HandlerDeps, event: SandboxEvent): void {
  const branchName = (event as { branchName?: string }).branchName;
  if (!branchName) return;

  const normalizedBranch = normalizeBranchName(branchName);
  const resolver = deps.pendingPushResolvers.get(normalizedBranch);
  if (!resolver) return;

  if (event.type === "push_complete") {
    deps.log.info("Push completed, resolving promise", {
      branch_name: branchName,
      pending_resolvers: Array.from(deps.pendingPushResolvers.keys()),
    });
    resolver.resolve();
  } else if (event.type === "push_error") {
    const error = (event as { error?: string }).error || "Push failed";
    deps.log.warn("Push failed for branch", { branch_name: branchName, error });
    resolver.reject(new Error(error));
  }

  deps.pendingPushResolvers.delete(normalizedBranch);
}

/**
 * Generate HMAC signature for callback payload.
 */
async function signCallback(data: object, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureData = encoder.encode(JSON.stringify(data));
  const sig = await crypto.subtle.sign("HMAC", key, signatureData);
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Notify slack-bot of completion with retry.
 * Uses service binding for reliable internal communication.
 */
async function notifySlackBot(
  deps: HandlerDeps,
  messageId: string,
  success: boolean
): Promise<void> {
  const { repository, log, env, ctx } = deps;

  const message = repository.getMessageCallbackContext(messageId);
  if (!message?.callback_context) {
    log.debug("No callback context for message, skipping notification", {
      message_id: messageId,
    });
    return;
  }
  if (!env.SLACK_BOT || !env.INTERNAL_CALLBACK_SECRET) {
    log.debug("SLACK_BOT or INTERNAL_CALLBACK_SECRET not configured, skipping notification");
    return;
  }

  const session = repository.getSession();
  const sessionId = session?.session_name || session?.id || ctx.id.toString();

  const context = JSON.parse(message.callback_context);
  const timestamp = Date.now();

  const payloadData = {
    sessionId,
    messageId,
    success,
    timestamp,
    context,
  };

  const signature = await signCallback(payloadData, env.INTERNAL_CALLBACK_SECRET);
  const payload = { ...payloadData, signature };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await env.SLACK_BOT.fetch("https://internal/callbacks/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        log.info("Slack callback succeeded", { message_id: messageId });
        return;
      }

      const responseText = await response.text();
      log.error("Slack callback failed", {
        message_id: messageId,
        status: response.status,
        response_text: responseText,
      });
    } catch (e) {
      log.error("Slack callback attempt failed", {
        message_id: messageId,
        attempt: attempt + 1,
        error: e instanceof Error ? e : String(e),
      });
    }

    if (attempt < 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  log.error("Failed to notify slack-bot after retries", { message_id: messageId });
}

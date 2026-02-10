/**
 * Internal HTTP route handlers for the Session Durable Object.
 *
 * Extracted from SessionDO to reduce file size. Each handler function receives
 * a HandlerDeps object and the raw Request/URL.
 */

import { generateId, hashToken, decryptToken, encryptToken } from "../auth/crypto";
import { refreshAccessToken } from "../auth/github";
import { DEFAULT_MODEL, isValidModel, getValidModelOrDefault } from "../utils/models";
import { generateBranchName } from "@open-inspect/shared";
import { SourceControlProviderError, type SourceControlAuthContext } from "../source-control";
import { resolveHeadBranchForPr } from "../source-control/branch-resolution";
import type { SandboxEvent, ParticipantRole, MessageSource } from "../types";
import type { SessionRow, ParticipantRow, ArtifactRow } from "./types";
import type { HandlerDeps } from "./handler-context";
import {
  createParticipantRecord,
  writeUserMessageEvent,
  validateReasoningEffort,
} from "./handler-context";
import {
  processSandboxEvent,
  processMessageQueue,
  stopExecution,
  warmSandbox,
  pushBranchToRemote,
} from "./sandbox-handler";
import type { ManualPullRequestArtifactMetadata } from "@open-inspect/shared";

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

/**
 * Route definition for internal API endpoints.
 */
export interface InternalRoute {
  method: string;
  path: string;
  handler: (deps: HandlerDeps, request: Request, url: URL) => Promise<Response> | Response;
}

/**
 * Valid event types for filtering.
 */
const VALID_EVENT_TYPES = [
  "tool_call",
  "tool_result",
  "token",
  "error",
  "git_sync",
  "execution_complete",
  "heartbeat",
  "push_complete",
  "push_error",
  "user_message",
] as const;

/**
 * Valid message statuses for filtering.
 */
const VALID_MESSAGE_STATUSES = ["pending", "processing", "completed", "failed"] as const;

/**
 * Static route table. Handlers receive deps at call time, not capture time.
 */
export const INTERNAL_ROUTES: InternalRoute[] = [
  { method: "POST", path: "/internal/init", handler: handleInit },
  { method: "GET", path: "/internal/state", handler: handleGetState },
  { method: "POST", path: "/internal/prompt", handler: handleEnqueuePrompt },
  { method: "POST", path: "/internal/stop", handler: handleStop },
  { method: "POST", path: "/internal/sandbox-event", handler: handleSandboxEvent },
  { method: "GET", path: "/internal/participants", handler: handleListParticipants },
  { method: "POST", path: "/internal/participants", handler: handleAddParticipant },
  { method: "GET", path: "/internal/events", handler: handleListEvents },
  { method: "GET", path: "/internal/artifacts", handler: handleListArtifacts },
  { method: "GET", path: "/internal/messages", handler: handleListMessages },
  { method: "POST", path: "/internal/create-pr", handler: handleCreatePR },
  { method: "POST", path: "/internal/ws-token", handler: handleGenerateWsToken },
  { method: "POST", path: "/internal/archive", handler: handleArchive },
  { method: "POST", path: "/internal/unarchive", handler: handleUnarchive },
  {
    method: "POST",
    path: "/internal/verify-sandbox-token",
    handler: handleVerifySandboxToken,
  },
];

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleInit(deps: HandlerDeps, request: Request, _url: URL): Promise<Response> {
  const { repository, env, log, ctx } = deps;

  const body = (await request.json()) as {
    sessionName: string;
    repoOwner: string;
    repoName: string;
    repoId?: number;
    title?: string;
    model?: string;
    reasoningEffort?: string;
    userId: string;
    githubLogin?: string;
    githubName?: string;
    githubEmail?: string;
    githubToken?: string | null;
    githubTokenEncrypted?: string | null;
  };

  const sessionId = ctx.id.toString();
  const sessionName = body.sessionName;
  const now = Date.now();

  // Encrypt the GitHub token if provided in plain text
  let encryptedToken = body.githubTokenEncrypted ?? null;
  if (body.githubToken && env.TOKEN_ENCRYPTION_KEY) {
    try {
      encryptedToken = await encryptToken(body.githubToken, env.TOKEN_ENCRYPTION_KEY);
      log.debug("Encrypted GitHub token for storage");
    } catch (err) {
      log.error("Failed to encrypt GitHub token", {
        error: err instanceof Error ? err : String(err),
      });
    }
  }

  // Validate and normalize model name
  const model = getValidModelOrDefault(body.model);
  if (body.model && !isValidModel(body.model)) {
    log.warn("Invalid model name, using default", {
      requested_model: body.model,
      default_model: DEFAULT_MODEL,
    });
  }

  const reasoningEffort = validateReasoningEffort(log, model, body.reasoningEffort);

  repository.upsertSession({
    id: sessionId,
    sessionName,
    title: body.title ?? null,
    repoOwner: body.repoOwner,
    repoName: body.repoName,
    repoId: body.repoId ?? null,
    model,
    reasoningEffort,
    status: "created",
    createdAt: now,
    updatedAt: now,
  });

  const sandboxId = generateId();
  repository.createSandbox({
    id: sandboxId,
    status: "pending",
    gitSyncStatus: "pending",
    createdAt: 0,
  });

  const participantId = generateId();
  repository.createParticipant({
    id: participantId,
    userId: body.userId,
    githubLogin: body.githubLogin ?? null,
    githubName: body.githubName ?? null,
    githubEmail: body.githubEmail ?? null,
    githubAccessTokenEncrypted: encryptedToken,
    role: "owner",
    joinedAt: now,
  });

  log.info("Triggering sandbox spawn for new session");
  ctx.waitUntil(warmSandbox(deps));

  return Response.json({ sessionId, status: "created" });
}

function handleGetState(deps: HandlerDeps, _request: Request, _url: URL): Response {
  const { repository } = deps;
  const session = repository.getSession();
  if (!session) {
    return new Response("Session not found", { status: 404 });
  }

  const sandbox = repository.getSandbox();

  return Response.json({
    id: session.id,
    title: session.title,
    repoOwner: session.repo_owner,
    repoName: session.repo_name,
    repoDefaultBranch: session.repo_default_branch,
    branchName: session.branch_name,
    baseSha: session.base_sha,
    currentSha: session.current_sha,
    opencodeSessionId: session.opencode_session_id,
    status: session.status,
    model: session.model,
    reasoningEffort: session.reasoning_effort ?? undefined,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    sandbox: sandbox
      ? {
          id: sandbox.id,
          modalSandboxId: sandbox.modal_sandbox_id,
          status: sandbox.status,
          gitSyncStatus: sandbox.git_sync_status,
          lastHeartbeat: sandbox.last_heartbeat,
        }
      : null,
  });
}

async function handleEnqueuePrompt(
  deps: HandlerDeps,
  request: Request,
  _url: URL
): Promise<Response> {
  const { repository, log } = deps;

  try {
    const body = (await request.json()) as {
      content: string;
      authorId: string;
      source: string;
      model?: string;
      reasoningEffort?: string;
      attachments?: Array<{ type: string; name: string; url?: string }>;
      callbackContext?: {
        channel: string;
        threadTs: string;
        repoFullName: string;
        model: string;
      };
    };

    let participant = repository.getParticipantByUserId(body.authorId);
    if (!participant) {
      participant = createParticipantRecord(deps, body.authorId, body.authorId);
    }

    const messageId = generateId();
    const now = Date.now();

    // Validate per-message model override
    let messageModel: string | null = null;
    if (body.model) {
      if (isValidModel(body.model)) {
        messageModel = body.model;
      } else {
        log.warn("Invalid message model in enqueue, ignoring", { model: body.model });
      }
    }

    const effectiveModelForEffort = messageModel || repository.getSession()?.model || DEFAULT_MODEL;
    const messageReasoningEffort = validateReasoningEffort(
      log,
      effectiveModelForEffort,
      body.reasoningEffort
    );

    repository.createMessage({
      id: messageId,
      authorId: participant.id,
      content: body.content,
      source: body.source as MessageSource,
      model: messageModel,
      reasoningEffort: messageReasoningEffort,
      attachments: body.attachments ? JSON.stringify(body.attachments) : null,
      callbackContext: body.callbackContext ? JSON.stringify(body.callbackContext) : null,
      status: "pending",
      createdAt: now,
    });

    writeUserMessageEvent(deps, participant, body.content, messageId, now);

    const queuePosition = repository.getPendingOrProcessingCount();

    log.info("prompt.enqueue", {
      event: "prompt.enqueue",
      message_id: messageId,
      source: body.source,
      author_id: participant.id,
      user_id: body.authorId,
      model: messageModel,
      reasoning_effort: messageReasoningEffort,
      content_length: body.content.length,
      has_attachments: !!body.attachments?.length,
      attachments_count: body.attachments?.length ?? 0,
      has_callback_context: !!body.callbackContext,
      queue_position: queuePosition,
    });

    await processMessageQueue(deps);

    return Response.json({ messageId, status: "queued" });
  } catch (error) {
    log.error("handleEnqueuePrompt error", {
      error: error instanceof Error ? error : String(error),
    });
    throw error;
  }
}

async function handleStop(deps: HandlerDeps, _request: Request, _url: URL): Promise<Response> {
  await stopExecution(deps);
  return Response.json({ status: "stopping" });
}

async function handleSandboxEvent(
  deps: HandlerDeps,
  request: Request,
  _url: URL
): Promise<Response> {
  const event = (await request.json()) as SandboxEvent;
  await processSandboxEvent(deps, event);
  return Response.json({ status: "ok" });
}

function handleListParticipants(deps: HandlerDeps, _request: Request, _url: URL): Response {
  const participants = deps.repository.listParticipants();

  return Response.json({
    participants: participants.map((p) => ({
      id: p.id,
      userId: p.user_id,
      githubLogin: p.github_login,
      githubName: p.github_name,
      role: p.role,
      joinedAt: p.joined_at,
    })),
  });
}

async function handleAddParticipant(
  deps: HandlerDeps,
  request: Request,
  _url: URL
): Promise<Response> {
  const body = (await request.json()) as {
    userId: string;
    githubLogin?: string;
    githubName?: string;
    githubEmail?: string;
    role?: string;
  };

  const id = generateId();
  const now = Date.now();

  deps.repository.createParticipant({
    id,
    userId: body.userId,
    githubLogin: body.githubLogin ?? null,
    githubName: body.githubName ?? null,
    githubEmail: body.githubEmail ?? null,
    role: (body.role ?? "member") as ParticipantRole,
    joinedAt: now,
  });

  return Response.json({ id, status: "added" });
}

function handleListEvents(deps: HandlerDeps, _request: Request, url: URL): Response {
  const cursor = url.searchParams.get("cursor");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200);
  const type = url.searchParams.get("type");
  const messageId = url.searchParams.get("message_id");

  if (type && !VALID_EVENT_TYPES.includes(type as (typeof VALID_EVENT_TYPES)[number])) {
    return Response.json({ error: `Invalid event type: ${type}` }, { status: 400 });
  }

  const events = deps.repository.listEvents({ cursor, limit, type, messageId });
  const hasMore = events.length > limit;

  if (hasMore) events.pop();

  return Response.json({
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      data: JSON.parse(e.data),
      messageId: e.message_id,
      createdAt: e.created_at,
    })),
    cursor: events.length > 0 ? events[events.length - 1].created_at.toString() : undefined,
    hasMore,
  });
}

function handleListArtifacts(deps: HandlerDeps, _request: Request, _url: URL): Response {
  const artifacts = deps.repository.listArtifacts();

  return Response.json({
    artifacts: artifacts.map((a) => ({
      id: a.id,
      type: a.type,
      url: a.url,
      metadata: parseArtifactMetadata(deps, a),
      createdAt: a.created_at,
    })),
  });
}

function handleListMessages(deps: HandlerDeps, _request: Request, url: URL): Response {
  const cursor = url.searchParams.get("cursor");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 100);
  const status = url.searchParams.get("status");

  if (
    status &&
    !VALID_MESSAGE_STATUSES.includes(status as (typeof VALID_MESSAGE_STATUSES)[number])
  ) {
    return Response.json({ error: `Invalid message status: ${status}` }, { status: 400 });
  }

  const messages = deps.repository.listMessages({ cursor, limit, status });
  const hasMore = messages.length > limit;

  if (hasMore) messages.pop();

  return Response.json({
    messages: messages.map((m) => ({
      id: m.id,
      authorId: m.author_id,
      content: m.content,
      source: m.source,
      status: m.status,
      createdAt: m.created_at,
      startedAt: m.started_at,
      completedAt: m.completed_at,
    })),
    cursor: messages.length > 0 ? messages[messages.length - 1].created_at.toString() : undefined,
    hasMore,
  });
}

async function handleCreatePR(deps: HandlerDeps, request: Request, _url: URL): Promise<Response> {
  const { repository, env, log, broadcast, sourceControlProvider } = deps;

  const body = (await request.json()) as {
    title: string;
    body: string;
    baseBranch?: string;
    headBranch?: string;
  };

  const session = repository.getSession();
  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  const promptingParticipantResult = await getPromptingParticipantForPR(deps);
  if (!promptingParticipantResult.participant) {
    return Response.json(
      { error: promptingParticipantResult.error },
      { status: promptingParticipantResult.status }
    );
  }

  const promptingParticipant = promptingParticipantResult.participant;
  log.info("Creating PR", { user_id: promptingParticipant.user_id });

  try {
    const sessionId = session.session_name || session.id;
    const generatedHeadBranch = generateBranchName(sessionId);

    const initialArtifacts = repository.listArtifacts();
    const existingPrArtifact = initialArtifacts.find((artifact) => artifact.type === "pr");
    if (existingPrArtifact) {
      return Response.json(
        { error: "A pull request has already been created for this session." },
        { status: 409 }
      );
    }

    // Generate push auth via provider app credentials
    let pushAuth;
    try {
      pushAuth = await sourceControlProvider.generatePushAuth();
      log.info("Generated fresh push auth token");
    } catch (err) {
      log.error("Failed to generate push auth", {
        error: err instanceof Error ? err : String(err),
      });
      const errorMessage =
        err instanceof SourceControlProviderError
          ? err.message
          : "Failed to generate push authentication";
      return Response.json({ error: errorMessage }, { status: 500 });
    }

    // Resolve repository metadata with app auth
    const appAuth: SourceControlAuthContext = {
      authType: "app",
      token: pushAuth.token,
    };
    const repoInfo = await sourceControlProvider.getRepository(appAuth, {
      owner: session.repo_owner,
      name: session.repo_name,
    });
    const baseBranch = body.baseBranch || repoInfo.defaultBranch;
    const branchResolution = resolveHeadBranchForPr({
      requestedHeadBranch: body.headBranch,
      sessionBranchName: session.branch_name,
      generatedBranchName: generatedHeadBranch,
      baseBranch,
    });
    const headBranch = branchResolution.headBranch;
    log.info("Resolved PR head branch", {
      requested_head_branch: body.headBranch ?? null,
      session_branch_name: session.branch_name,
      generated_head_branch: generatedHeadBranch,
      resolved_head_branch: headBranch,
      resolution_source: branchResolution.source,
      base_branch: baseBranch,
    });
    const pushSpec = sourceControlProvider.buildGitPushSpec({
      owner: session.repo_owner,
      name: session.repo_name,
      sourceRef: "HEAD",
      targetBranch: headBranch,
      auth: pushAuth,
      force: true,
    });

    // Push branch to remote via sandbox
    const pushResult = await pushBranchToRemote(deps, headBranch, pushSpec);

    if (!pushResult.success) {
      return Response.json({ error: pushResult.error }, { status: 500 });
    }

    repository.updateSessionBranch(session.id, headBranch);

    // Re-check artifacts after async work
    const latestArtifacts = repository.listArtifacts();
    const latestPrArtifact = latestArtifacts.find((artifact) => artifact.type === "pr");
    if (latestPrArtifact) {
      return Response.json(
        { error: "A pull request has already been created for this session." },
        { status: 409 }
      );
    }

    const authResolution = await resolvePromptingUserAuthForPR(deps, promptingParticipant);
    if ("error" in authResolution) {
      return buildManualPrFallbackResponse(
        deps,
        session,
        headBranch,
        baseBranch,
        latestArtifacts,
        authResolution.error
      );
    }

    if (!authResolution.auth) {
      return buildManualPrFallbackResponse(deps, session, headBranch, baseBranch, latestArtifacts);
    }

    // Append session link footer
    const webAppUrl = env.WEB_APP_URL || env.WORKER_URL || "";
    const sessionUrl = `${webAppUrl}/session/${sessionId}`;
    const fullBody = body.body + `\n\n---\n*Created with [Open-Inspect](${sessionUrl})*`;

    const prResult = await sourceControlProvider.createPullRequest(authResolution.auth, {
      repository: repoInfo,
      title: body.title,
      body: fullBody,
      sourceBranch: headBranch,
      targetBranch: baseBranch,
    });

    // Store PR artifact
    const artifactId = generateId();
    const now = Date.now();
    repository.createArtifact({
      id: artifactId,
      type: "pr",
      url: prResult.webUrl,
      metadata: JSON.stringify({
        number: prResult.id,
        state: prResult.state,
        head: headBranch,
        base: baseBranch,
      }),
      createdAt: now,
    });

    broadcast({
      type: "artifact_created",
      artifact: {
        id: artifactId,
        type: "pr",
        url: prResult.webUrl,
        prNumber: prResult.id,
      },
    });

    return Response.json({
      prNumber: prResult.id,
      prUrl: prResult.webUrl,
      state: prResult.state,
    });
  } catch (error) {
    log.error("PR creation failed", {
      error: error instanceof Error ? error : String(error),
    });

    if (error instanceof SourceControlProviderError) {
      return Response.json({ error: error.message }, { status: error.httpStatus || 500 });
    }

    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to create PR" },
      { status: 500 }
    );
  }
}

async function handleGenerateWsToken(
  deps: HandlerDeps,
  request: Request,
  _url: URL
): Promise<Response> {
  const { repository, log } = deps;

  const body = (await request.json()) as {
    userId: string;
    githubUserId?: string;
    githubLogin?: string;
    githubName?: string;
    githubEmail?: string;
    githubTokenEncrypted?: string | null;
    githubRefreshTokenEncrypted?: string | null;
    githubTokenExpiresAt?: number | null;
  };

  if (!body.userId) {
    return Response.json({ error: "userId is required" }, { status: 400 });
  }

  const now = Date.now();

  let participant = repository.getParticipantByUserId(body.userId);

  if (participant) {
    const clientExpiresAt = body.githubTokenExpiresAt ?? null;
    const dbExpiresAt = participant.github_token_expires_at;
    const clientSentAnyToken =
      body.githubTokenEncrypted != null || body.githubRefreshTokenEncrypted != null;

    const shouldUpdateTokens =
      clientSentAnyToken &&
      (dbExpiresAt == null || (clientExpiresAt != null && clientExpiresAt >= dbExpiresAt));

    const shouldUpdateRefreshToken =
      body.githubRefreshTokenEncrypted != null &&
      (participant.github_refresh_token_encrypted == null || shouldUpdateTokens);

    repository.updateParticipantCoalesce(participant.id, {
      githubUserId: body.githubUserId ?? null,
      githubLogin: body.githubLogin ?? null,
      githubName: body.githubName ?? null,
      githubEmail: body.githubEmail ?? null,
      githubAccessTokenEncrypted: shouldUpdateTokens ? (body.githubTokenEncrypted ?? null) : null,
      githubRefreshTokenEncrypted: shouldUpdateRefreshToken
        ? (body.githubRefreshTokenEncrypted ?? null)
        : null,
      githubTokenExpiresAt: shouldUpdateTokens ? clientExpiresAt : null,
    });
  } else {
    const id = generateId();
    repository.createParticipant({
      id,
      userId: body.userId,
      githubUserId: body.githubUserId ?? null,
      githubLogin: body.githubLogin ?? null,
      githubName: body.githubName ?? null,
      githubEmail: body.githubEmail ?? null,
      githubAccessTokenEncrypted: body.githubTokenEncrypted ?? null,
      githubRefreshTokenEncrypted: body.githubRefreshTokenEncrypted ?? null,
      githubTokenExpiresAt: body.githubTokenExpiresAt ?? null,
      role: "member",
      joinedAt: now,
    });
    participant = repository.getParticipantByUserId(body.userId)!;
  }

  const plainToken = generateId(32);
  const tokenHash = await hashToken(plainToken);

  repository.updateParticipantWsToken(participant.id, tokenHash, now);

  log.info("Generated WS token", { participant_id: participant.id, user_id: body.userId });

  return Response.json({
    token: plainToken,
    participantId: participant.id,
  });
}

async function handleArchive(deps: HandlerDeps, request: Request, _url: URL): Promise<Response> {
  const { repository, broadcast } = deps;

  const session = repository.getSession();
  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  let body: { userId?: string };
  try {
    body = (await request.json()) as { userId?: string };
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!body.userId) {
    return Response.json({ error: "userId is required" }, { status: 400 });
  }

  const participant = repository.getParticipantByUserId(body.userId);
  if (!participant) {
    return Response.json({ error: "Not authorized to archive this session" }, { status: 403 });
  }

  const now = Date.now();
  repository.updateSessionStatus(session.id, "archived", now);

  broadcast({ type: "session_status", status: "archived" });

  return Response.json({ status: "archived" });
}

async function handleUnarchive(deps: HandlerDeps, request: Request, _url: URL): Promise<Response> {
  const { repository, broadcast } = deps;

  const session = repository.getSession();
  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  let body: { userId?: string };
  try {
    body = (await request.json()) as { userId?: string };
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!body.userId) {
    return Response.json({ error: "userId is required" }, { status: 400 });
  }

  const participant = repository.getParticipantByUserId(body.userId);
  if (!participant) {
    return Response.json({ error: "Not authorized to unarchive this session" }, { status: 403 });
  }

  const now = Date.now();
  repository.updateSessionStatus(session.id, "active", now);

  broadcast({ type: "session_status", status: "active" });

  return Response.json({ status: "active" });
}

async function handleVerifySandboxToken(
  deps: HandlerDeps,
  request: Request,
  _url: URL
): Promise<Response> {
  const { repository, log } = deps;

  const body = (await request.json()) as { token: string };

  if (!body.token) {
    return new Response(JSON.stringify({ valid: false, error: "Missing token" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sandbox = repository.getSandbox();
  if (!sandbox) {
    log.warn("Sandbox token verification failed: no sandbox");
    return new Response(JSON.stringify({ valid: false, error: "No sandbox" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (sandbox.status === "stopped" || sandbox.status === "stale") {
    log.warn("Sandbox token verification failed: sandbox is stopped/stale", {
      status: sandbox.status,
    });
    return new Response(JSON.stringify({ valid: false, error: "Sandbox stopped" }), {
      status: 410,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (body.token !== sandbox.auth_token) {
    log.warn("Sandbox token verification failed: token mismatch");
    return new Response(JSON.stringify({ valid: false, error: "Invalid token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  log.info("Sandbox token verified successfully");
  return new Response(JSON.stringify({ valid: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// PR creation helpers
// ---------------------------------------------------------------------------

async function getPromptingParticipantForPR(
  deps: HandlerDeps
): Promise<
  | { participant: ParticipantRow; error?: never; status?: never }
  | { participant?: never; error: string; status: number }
> {
  const processingMessage = deps.repository.getProcessingMessageAuthor();

  if (!processingMessage) {
    deps.log.warn("PR creation failed: no processing message found");
    return {
      error: "No active prompt found. PR creation must be triggered by a user prompt.",
      status: 400,
    };
  }

  const participant = deps.repository.getParticipantById(processingMessage.author_id);

  if (!participant) {
    deps.log.warn("PR creation failed: participant not found", {
      participantId: processingMessage.author_id,
    });
    return { error: "User not found. Please re-authenticate.", status: 401 };
  }

  return { participant };
}

async function resolvePromptingUserAuthForPR(
  deps: HandlerDeps,
  participant: ParticipantRow
): Promise<
  | {
      participant: ParticipantRow;
      auth: SourceControlAuthContext | null;
      error?: never;
      status?: never;
    }
  | { participant?: never; auth?: never; error: string; status: number }
> {
  const { env, log } = deps;
  let resolvedParticipant = participant;

  if (!resolvedParticipant.github_access_token_encrypted) {
    log.info("PR creation: prompting user has no OAuth token, using manual fallback", {
      user_id: resolvedParticipant.user_id,
    });
    return { participant: resolvedParticipant, auth: null };
  }

  if (isGitHubTokenExpired(resolvedParticipant)) {
    log.warn("GitHub token expired, attempting server-side refresh", {
      userId: resolvedParticipant.user_id,
    });

    const refreshed = await refreshParticipantToken(deps, resolvedParticipant);
    if (refreshed) {
      resolvedParticipant = refreshed;
    } else {
      return {
        error: "Your GitHub token has expired and could not be refreshed. Please re-authenticate.",
        status: 401,
      };
    }
  }

  if (!resolvedParticipant.github_access_token_encrypted) {
    return { participant: resolvedParticipant, auth: null };
  }

  try {
    const accessToken = await decryptToken(
      resolvedParticipant.github_access_token_encrypted,
      env.TOKEN_ENCRYPTION_KEY
    );

    return {
      participant: resolvedParticipant,
      auth: { authType: "oauth", token: accessToken },
    };
  } catch (error) {
    log.error("Failed to decrypt GitHub token for PR creation", {
      user_id: resolvedParticipant.user_id,
      error: error instanceof Error ? error : String(error),
    });
    return { error: "Failed to process GitHub token for PR creation.", status: 500 };
  }
}

function isGitHubTokenExpired(participant: ParticipantRow, bufferMs = 60000): boolean {
  if (!participant.github_token_expires_at) {
    return false;
  }
  return Date.now() + bufferMs >= participant.github_token_expires_at;
}

async function refreshParticipantToken(
  deps: HandlerDeps,
  participant: ParticipantRow
): Promise<ParticipantRow | null> {
  const { env, log, repository } = deps;

  if (!participant.github_refresh_token_encrypted) {
    log.warn("Cannot refresh: no refresh token stored", { user_id: participant.user_id });
    return null;
  }

  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    log.warn("Cannot refresh: GitHub OAuth credentials not configured");
    return null;
  }

  try {
    const refreshToken = await decryptToken(
      participant.github_refresh_token_encrypted,
      env.TOKEN_ENCRYPTION_KEY
    );

    const newTokens = await refreshAccessToken(refreshToken, {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      encryptionKey: env.TOKEN_ENCRYPTION_KEY,
    });

    const newAccessTokenEncrypted = await encryptToken(
      newTokens.access_token,
      env.TOKEN_ENCRYPTION_KEY
    );

    const newRefreshTokenEncrypted = newTokens.refresh_token
      ? await encryptToken(newTokens.refresh_token, env.TOKEN_ENCRYPTION_KEY)
      : null;

    const newExpiresAt = newTokens.expires_in
      ? Date.now() + newTokens.expires_in * 1000
      : Date.now() + 8 * 60 * 60 * 1000;

    repository.updateParticipantTokens(participant.id, {
      githubAccessTokenEncrypted: newAccessTokenEncrypted,
      githubRefreshTokenEncrypted: newRefreshTokenEncrypted,
      githubTokenExpiresAt: newExpiresAt,
    });

    log.info("Server-side token refresh succeeded", { user_id: participant.user_id });

    return repository.getParticipantById(participant.id);
  } catch (error) {
    log.error("Server-side token refresh failed", {
      user_id: participant.user_id,
      error: error instanceof Error ? error : String(error),
    });
    return null;
  }
}

function parseArtifactMetadata(
  deps: HandlerDeps,
  artifact: Pick<ArtifactRow, "id" | "metadata">
): Record<string, unknown> | null {
  if (!artifact.metadata) return null;
  try {
    return JSON.parse(artifact.metadata) as Record<string, unknown>;
  } catch (error) {
    deps.log.warn("Invalid artifact metadata JSON", {
      artifact_id: artifact.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function getExistingManualBranchArtifact(
  deps: HandlerDeps,
  artifacts: ArtifactRow[],
  headBranch: string
): { artifact: ArtifactRow; metadata: Record<string, unknown> } | null {
  for (const artifact of artifacts) {
    if (artifact.type !== "branch") continue;

    const metadata = parseArtifactMetadata(deps, artifact);
    if (!metadata) continue;

    if (metadata.mode === "manual_pr" && metadata.head === headBranch) {
      return { artifact, metadata };
    }
  }
  return null;
}

function getCreatePrUrlFromManualArtifact(
  existing: { artifact: ArtifactRow; metadata: Record<string, unknown> },
  fallbackUrl: string
): string {
  const metadataUrl = existing.metadata.createPrUrl;
  if (typeof metadataUrl === "string" && metadataUrl.length > 0) return metadataUrl;
  if (existing.artifact.url && existing.artifact.url.length > 0) return existing.artifact.url;
  return fallbackUrl;
}

function buildManualPrFallbackResponse(
  deps: HandlerDeps,
  session: SessionRow,
  headBranch: string,
  baseBranch: string,
  artifacts: ArtifactRow[],
  reason?: string
): Response {
  const { repository, log, broadcast, sourceControlProvider } = deps;

  const manualCreatePrUrl = sourceControlProvider.buildManualPullRequestUrl({
    owner: session.repo_owner,
    name: session.repo_name,
    sourceBranch: headBranch,
    targetBranch: baseBranch,
  });

  const existingManualArtifact = getExistingManualBranchArtifact(deps, artifacts, headBranch);
  if (existingManualArtifact) {
    const createPrUrl = getCreatePrUrlFromManualArtifact(existingManualArtifact, manualCreatePrUrl);
    log.info("Using manual PR fallback", {
      head_branch: headBranch,
      base_branch: baseBranch,
      session_id: session.session_name || session.id,
      existing_artifact_id: existingManualArtifact.artifact.id,
      reason: reason ?? "missing_oauth_token",
    });
    return Response.json({ status: "manual", createPrUrl, headBranch, baseBranch });
  }

  const artifactId = generateId();
  const now = Date.now();
  const metadata: ManualPullRequestArtifactMetadata = {
    head: headBranch,
    base: baseBranch,
    mode: "manual_pr",
    createPrUrl: manualCreatePrUrl,
    provider: sourceControlProvider.name,
  };
  repository.createArtifact({
    id: artifactId,
    type: "branch",
    url: manualCreatePrUrl,
    metadata: JSON.stringify(metadata),
    createdAt: now,
  });

  broadcast({
    type: "artifact_created",
    artifact: { id: artifactId, type: "branch", url: manualCreatePrUrl },
  });

  log.info("Using manual PR fallback", {
    head_branch: headBranch,
    base_branch: baseBranch,
    session_id: session.session_name || session.id,
    artifact_id: artifactId,
    reason: reason ?? "missing_oauth_token",
  });

  return Response.json({
    status: "manual",
    createPrUrl: manualCreatePrUrl,
    headBranch,
    baseBranch,
  });
}

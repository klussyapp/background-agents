/**
 * Session Durable Object implementation.
 *
 * Each session gets its own Durable Object instance with:
 * - SQLite database for persistent state
 * - WebSocket connections with hibernation support
 * - Prompt queue and event streaming
 *
 * Handler logic is extracted into:
 * - internal-routes.ts  — HTTP API handlers
 * - client-handler.ts   — Client WebSocket message handling
 * - sandbox-handler.ts  — Sandbox message handling and queue processing
 */

import { Agent, type Connection, type ConnectionContext } from "agents";
import { initSchema } from "./schema";
import { generateId } from "../auth/crypto";
import { getGitHubAppConfig, getInstallationRepository } from "../auth/github-app";
import { createModalClient } from "../sandbox/client";
import { createModalProvider } from "../sandbox/providers/modal-provider";
import { createLogger, parseLogLevel } from "../logger";
import type { Logger } from "../logger";
import {
  SandboxLifecycleManager,
  DEFAULT_LIFECYCLE_CONFIG,
  type SandboxStorage,
  type SandboxBroadcaster,
  type WebSocketManager,
  type AlarmScheduler,
  type IdGenerator,
} from "../sandbox/lifecycle/manager";
import {
  createSourceControlProvider as createSourceControlProviderImpl,
  resolveScmProviderFromEnv,
  type SourceControlProvider,
} from "../source-control";
import { DEFAULT_MODEL } from "../utils/models";
import type { Env, ServerMessage } from "../types";
import { SessionRepository } from "./repository";
import { SessionWebSocketManagerImpl, type SessionWebSocketManager } from "./websocket-manager";
import { RepoSecretsStore } from "../db/repo-secrets";
import { GlobalSecretsStore } from "../db/global-secrets";
import { mergeSecrets } from "../db/secrets-validation";

import type { HandlerDeps } from "./handler-context";
import { INTERNAL_ROUTES } from "./internal-routes";
import { handleClientMessage } from "./client-handler";
import { handleSandboxMessage, processMessageQueue } from "./sandbox-handler";

/**
 * Timeout for WebSocket authentication (in milliseconds).
 */
const WS_AUTH_TIMEOUT_MS = 30000; // 30 seconds

export class SessionDO extends Agent<Env, void> {
  private sqlStorage: SqlStorage;
  private repository: SessionRepository;
  private initialized = false;
  private log: Logger;

  // WebSocket manager (lazily initialized)
  private _wsManager: SessionWebSocketManager | null = null;
  // Track pending push operations by branch name
  private pendingPushResolvers = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void }
  >();
  // Lifecycle manager (lazily initialized)
  private _lifecycleManager: SandboxLifecycleManager | null = null;
  // Source control provider (lazily initialized)
  private _sourceControlProvider: SourceControlProvider | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sqlStorage = ctx.storage.sql;
    this.repository = new SessionRepository(this.sqlStorage);
    this.log = createLogger("session-do", {}, parseLogLevel(env.LOG_LEVEL));
  }

  // ---------------------------------------------------------------------------
  // Lazy accessors
  // ---------------------------------------------------------------------------

  private get lifecycleManager(): SandboxLifecycleManager {
    if (!this._lifecycleManager) {
      this._lifecycleManager = this.createLifecycleManager();
    }
    return this._lifecycleManager;
  }

  private get sourceControlProvider(): SourceControlProvider {
    if (!this._sourceControlProvider) {
      this._sourceControlProvider = this.createSourceControlProvider();
    }
    return this._sourceControlProvider;
  }

  private get wsManager(): SessionWebSocketManager {
    if (!this._wsManager) {
      this._wsManager = new SessionWebSocketManagerImpl(this.ctx, this.repository, this.log, {
        authTimeoutMs: WS_AUTH_TIMEOUT_MS,
      });
    }
    return this._wsManager;
  }

  // ---------------------------------------------------------------------------
  // HandlerDeps — built per call, always captures the latest `this.log`
  // ---------------------------------------------------------------------------

  private get deps(): HandlerDeps {
    return {
      env: this.env,
      ctx: this.ctx,
      repository: this.repository,
      log: this.log,
      wsManager: this.wsManager,
      lifecycleManager: this.lifecycleManager,
      sourceControlProvider: this.sourceControlProvider,
      pendingPushResolvers: this.pendingPushResolvers,
      broadcast: (msg) => this.broadcastToClients(msg),
      safeSend: (ws, msg) => this.wsManager.send(ws, msg),
    };
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  private ensureInitialized(): void {
    if (this.initialized) return;
    initSchema(this.sqlStorage);
    this.initialized = true;
    const session = this.repository.getSession();
    const sessionId = session?.session_name || session?.id || this.ctx.id.toString();
    this.log = createLogger(
      "session-do",
      { session_id: sessionId },
      parseLogLevel(this.env.LOG_LEVEL)
    );
    this.wsManager.enableAutoPingPong();
  }

  // ---------------------------------------------------------------------------
  // Agent lifecycle hooks
  // ---------------------------------------------------------------------------

  onStart(): void {
    this.ensureInitialized();
  }

  getConnectionTags(connection: Connection, _ctx: ConnectionContext): string[] {
    return ["client", `wsid:${connection.id}`];
  }

  onConnect(connection: Connection, _ctx: ConnectionContext): void {
    this.ctx.waitUntil(this.wsManager.enforceAuthTimeout(connection, connection.id));
  }

  async onMessage(connection: Connection, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    await handleClientMessage(this.deps, connection, message);
  }

  onClose(connection: Connection): void {
    const client = this.wsManager.removeClient(connection);
    if (client) {
      this.broadcastToClients({ type: "presence_leave", userId: client.userId });
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP request handler
  // ---------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const fetchStart = performance.now();

    this.ensureInitialized();
    const initMs = performance.now() - fetchStart;

    // Extract correlation headers and create request-scoped logger
    const traceId = request.headers.get("x-trace-id");
    const requestId = request.headers.get("x-request-id");
    if (traceId || requestId) {
      const correlationCtx: Record<string, unknown> = {};
      if (traceId) correlationCtx.trace_id = traceId;
      if (requestId) correlationCtx.request_id = requestId;
      this.log = this.log.child(correlationCtx);
    }

    const url = new URL(request.url);

    // Sandbox WebSocket: manual pre-acceptance auth
    if (
      request.headers.get("Upgrade") === "websocket" &&
      url.searchParams.get("type") === "sandbox"
    ) {
      return this.handleSandboxWebSocketUpgrade(request, url);
    }

    // Client WebSocket: delegate to Agent/Server connection model.
    // Server (partyserver) expects x-partykit-room for initialization —
    // inject it since our routing doesn't go through routePartykitRequest.
    if (request.headers.get("Upgrade") === "websocket") {
      const headers = new Headers(request.headers);
      headers.set("x-partykit-room", this.ctx.id.toString());
      return super.fetch(new Request(request.url, { headers }));
    }

    // HTTP: match route from static table
    const path = url.pathname;
    const route = INTERNAL_ROUTES.find((r) => r.path === path && r.method === request.method);

    if (route) {
      const handlerStart = performance.now();
      let status = 500;
      let outcome: "success" | "error" = "error";
      try {
        const response = await route.handler(this.deps, request, url);
        status = response.status;
        outcome = status >= 500 ? "error" : "success";
        return response;
      } catch (e) {
        status = 500;
        outcome = "error";
        throw e;
      } finally {
        const handlerMs = performance.now() - handlerStart;
        const totalMs = performance.now() - fetchStart;
        this.log.info("do.request", {
          event: "do.request",
          http_method: request.method,
          http_path: path,
          http_status: status,
          duration_ms: Math.round(totalMs * 100) / 100,
          init_ms: Math.round(initMs * 100) / 100,
          handler_ms: Math.round(handlerMs * 100) / 100,
          outcome,
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  }

  // ---------------------------------------------------------------------------
  // WebSocket lifecycle
  // ---------------------------------------------------------------------------

  private async handleSandboxWebSocketUpgrade(request: Request, _url: URL): Promise<Response> {
    this.log.debug("Sandbox WebSocket upgrade requested");

    const wsStartTime = Date.now();
    const authHeader = request.headers.get("Authorization");
    const sandboxId = request.headers.get("X-Sandbox-ID");

    const sandbox = this.repository.getSandbox();
    const expectedToken = sandbox?.auth_token;
    const expectedSandboxId = sandbox?.modal_sandbox_id;

    // Reject if sandbox should be stopped
    if (sandbox?.status === "stopped" || sandbox?.status === "stale") {
      this.log.warn("ws.connect", {
        event: "ws.connect",
        ws_type: "sandbox",
        outcome: "rejected",
        reject_reason: "sandbox_stopped",
        sandbox_status: sandbox.status,
        duration_ms: Date.now() - wsStartTime,
      });
      return new Response("Sandbox is stopped", { status: 410 });
    }

    // Validate sandbox ID
    if (expectedSandboxId && sandboxId !== expectedSandboxId) {
      this.log.warn("ws.connect", {
        event: "ws.connect",
        ws_type: "sandbox",
        outcome: "auth_failed",
        reject_reason: "sandbox_id_mismatch",
        expected_sandbox_id: expectedSandboxId,
        sandbox_id: sandboxId,
        duration_ms: Date.now() - wsStartTime,
      });
      return new Response("Forbidden: Wrong sandbox ID", { status: 403 });
    }

    // Validate auth token
    if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
      this.log.warn("ws.connect", {
        event: "ws.connect",
        ws_type: "sandbox",
        outcome: "auth_failed",
        reject_reason: "token_mismatch",
        duration_ms: Date.now() - wsStartTime,
      });
      return new Response("Unauthorized: Invalid auth token", { status: 401 });
    }

    try {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      const { replaced } = this.wsManager.acceptAndSetSandboxSocket(server, sandboxId ?? undefined);

      this.lifecycleManager.onSandboxConnected();
      this.repository.updateSandboxStatus("ready");
      this.broadcastToClients({ type: "sandbox_status", status: "ready" });

      const now = Date.now();
      this.lifecycleManager.updateLastActivity(now);
      await this.lifecycleManager.scheduleInactivityCheck();

      this.log.info("ws.connect", {
        event: "ws.connect",
        ws_type: "sandbox",
        outcome: "success",
        sandbox_id: sandboxId,
        replaced_existing: replaced,
        duration_ms: Date.now() - now,
      });

      // Process any pending messages
      processMessageQueue(this.deps);

      return new Response(null, { status: 101, webSocket: client });
    } catch (error) {
      this.log.error("WebSocket upgrade failed", {
        error: error instanceof Error ? error : String(error),
      });
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.ensureInitialized();
    if (typeof message !== "string") return;

    const tags = this.ctx.getTags(ws);
    if (tags.includes("sandbox")) {
      await handleSandboxMessage(this.deps, ws, message);
    } else {
      // Client: delegate to Server → recovers Connection → calls onMessage()
      await super.webSocketMessage(ws, message);
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    this.ensureInitialized();

    const tags = this.ctx.getTags(ws);
    if (tags.includes("sandbox")) {
      const wasActive = this.wsManager.clearSandboxSocketIfMatch(ws);
      if (!wasActive) {
        this.log.debug("Ignoring close for replaced sandbox socket", { code });
        return;
      }

      const isNormalClose = code === 1000 || code === 1001;
      if (isNormalClose) {
        this.repository.updateSandboxStatus("stopped");
      } else {
        this.log.warn("Sandbox WebSocket abnormal close", {
          event: "sandbox.abnormal_close",
          code,
          reason,
        });
        await this.lifecycleManager.scheduleDisconnectCheck();
      }
    } else {
      // Client: delegate to Server → recovers Connection → calls onClose()
      await super.webSocketClose(ws, code, reason, wasClean);
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    this.ensureInitialized();
    this.log.error("WebSocket error", { error });
    ws.close(1011, "Internal error");
  }

  // ---------------------------------------------------------------------------
  // Lifecycle alarm (called by Agent scheduler)
  // ---------------------------------------------------------------------------

  async lifecycleAlarm(): Promise<void> {
    this.ensureInitialized();
    await this.lifecycleManager.handleAlarm();
  }

  // ---------------------------------------------------------------------------
  // Broadcast
  // ---------------------------------------------------------------------------

  private broadcastToClients(message: ServerMessage): void {
    this.wsManager.forEachClientSocket("authenticated_only", (ws) => {
      this.wsManager.send(ws, message);
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle manager creation
  // ---------------------------------------------------------------------------

  private createLifecycleManager(): SandboxLifecycleManager {
    if (!this.env.MODAL_API_SECRET || !this.env.MODAL_WORKSPACE) {
      throw new Error("MODAL_API_SECRET and MODAL_WORKSPACE are required for lifecycle manager");
    }

    const modalClient = createModalClient(this.env.MODAL_API_SECRET, this.env.MODAL_WORKSPACE);
    const provider = createModalProvider(modalClient, this.env.MODAL_API_SECRET);

    const storage: SandboxStorage = {
      getSandbox: () => this.repository.getSandbox(),
      getSandboxWithCircuitBreaker: () => this.repository.getSandboxWithCircuitBreaker(),
      getSession: () => this.repository.getSession(),
      getUserEnvVars: () => this.getUserEnvVars(),
      updateSandboxStatus: (status) => this.repository.updateSandboxStatus(status),
      updateSandboxForSpawn: (data) => this.repository.updateSandboxForSpawn(data),
      updateSandboxModalObjectId: (id) => this.repository.updateSandboxModalObjectId(id),
      updateSandboxSnapshotImageId: (sandboxId, imageId) =>
        this.repository.updateSandboxSnapshotImageId(sandboxId, imageId),
      updateSandboxLastActivity: (timestamp) =>
        this.repository.updateSandboxLastActivity(timestamp),
      incrementCircuitBreakerFailure: (timestamp) =>
        this.repository.incrementCircuitBreakerFailure(timestamp),
      resetCircuitBreaker: () => this.repository.resetCircuitBreaker(),
      setLastSpawnError: (error, timestamp) =>
        this.repository.updateSandboxSpawnError(error, timestamp),
    };

    const broadcaster: SandboxBroadcaster = {
      broadcast: (message) => this.broadcastToClients(message as ServerMessage),
    };

    const wsManager: WebSocketManager = {
      getSandboxWebSocket: () => this.wsManager.getSandboxSocket(),
      closeSandboxWebSocket: (code, reason) => {
        const ws = this.wsManager.getSandboxSocket();
        if (ws) {
          this.wsManager.close(ws, code, reason);
          this.wsManager.clearSandboxSocket();
        }
      },
      sendToSandbox: (message) => {
        const ws = this.wsManager.getSandboxSocket();
        return ws ? this.wsManager.send(ws, message) : false;
      },
      getConnectedClientCount: () => this.wsManager.getConnectedClientCount(),
    };

    const alarmScheduler: AlarmScheduler = {
      scheduleAlarm: async (timestamp) => {
        await this.schedule(new Date(timestamp), "lifecycleAlarm");
      },
    };

    const idGenerator: IdGenerator = {
      generateId: () => generateId(),
    };

    const controlPlaneUrl =
      this.env.WORKER_URL ||
      `https://open-inspect-control-plane.${this.env.CF_ACCOUNT_ID || "workers"}.workers.dev`;

    const session = this.repository.getSession();
    const sessionId = session?.session_name || session?.id || this.ctx.id.toString();

    const config = {
      ...DEFAULT_LIFECYCLE_CONFIG,
      controlPlaneUrl,
      model: DEFAULT_MODEL,
      sessionId,
      inactivity: {
        ...DEFAULT_LIFECYCLE_CONFIG.inactivity,
        timeoutMs: parseInt(this.env.SANDBOX_INACTIVITY_TIMEOUT_MS || "600000", 10),
      },
    };

    return new SandboxLifecycleManager(
      provider,
      storage,
      broadcaster,
      wsManager,
      alarmScheduler,
      idGenerator,
      config
    );
  }

  private createSourceControlProvider(): SourceControlProvider {
    const appConfig = getGitHubAppConfig(this.env);
    const providerType = resolveScmProviderFromEnv(this.env.SCM_PROVIDER);

    return createSourceControlProviderImpl({
      provider: providerType,
      github: { appConfig: appConfig ?? undefined },
    });
  }

  // ---------------------------------------------------------------------------
  // Secrets loading (used by lifecycle manager adapter)
  // ---------------------------------------------------------------------------

  private async getUserEnvVars(): Promise<Record<string, string> | undefined> {
    const session = this.repository.getSession();
    if (!session) {
      this.log.warn("Cannot load secrets: no session");
      return undefined;
    }

    if (!this.env.DB || !this.env.REPO_SECRETS_ENCRYPTION_KEY) {
      this.log.debug("Secrets not configured, skipping", {
        has_db: !!this.env.DB,
        has_encryption_key: !!this.env.REPO_SECRETS_ENCRYPTION_KEY,
      });
      return undefined;
    }

    // Fetch global secrets
    let globalSecrets: Record<string, string> = {};
    try {
      const globalStore = new GlobalSecretsStore(this.env.DB, this.env.REPO_SECRETS_ENCRYPTION_KEY);
      globalSecrets = await globalStore.getDecryptedSecrets();
    } catch (e) {
      this.log.error("Failed to load global secrets, proceeding without", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // Fetch repo secrets
    let repoSecrets: Record<string, string> = {};
    try {
      const repoId = await this.ensureRepoId(session);
      const repoStore = new RepoSecretsStore(this.env.DB, this.env.REPO_SECRETS_ENCRYPTION_KEY);
      repoSecrets = await repoStore.getDecryptedSecrets(repoId);
    } catch (e) {
      this.log.warn("Failed to load repo secrets, proceeding without", {
        repo_owner: session.repo_owner,
        repo_name: session.repo_name,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    const { merged, totalBytes, exceedsLimit } = mergeSecrets(globalSecrets, repoSecrets);
    const globalCount = Object.keys(globalSecrets).length;
    const repoCount = Object.keys(repoSecrets).length;
    const mergedCount = Object.keys(merged).length;

    if (mergedCount > 0) {
      const logLevel = exceedsLimit ? "warn" : "info";
      this.log[logLevel]("Secrets merged for sandbox", {
        global_count: globalCount,
        repo_count: repoCount,
        merged_count: mergedCount,
        payload_bytes: totalBytes,
        exceeds_limit: exceedsLimit,
      });
    }

    return mergedCount === 0 ? undefined : merged;
  }

  private async ensureRepoId(session: {
    repo_id: number | null;
    repo_owner: string;
    repo_name: string;
    id: string;
  }): Promise<number> {
    if (session.repo_id) {
      return session.repo_id;
    }

    const appConfig = getGitHubAppConfig(this.env);
    if (!appConfig) {
      throw new Error("GitHub App not configured");
    }

    const repo = await getInstallationRepository(appConfig, session.repo_owner, session.repo_name);
    if (!repo) {
      throw new Error("Repository is not installed for the GitHub App");
    }

    this.repository.updateSessionRepoId(repo.id);
    return repo.id;
  }
}

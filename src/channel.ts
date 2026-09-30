/**
 * iframe communication channel
 *
 * Secure communication layer based on postMessage
 */

import type { IframeMessage, IframeMessageType, IframeErrorCode } from "./types";
import { IframeError } from "./types";

const CapturedAbortController = globalThis.AbortController;

function errorOrFallback(value: unknown, fallback: string): Error {
  try {
    if (value instanceof Error) return value;
  } catch {
    // Hostile Error/Proxy classification falls through to a safe local error.
  }
  return new Error(fallback);
}

const settledDrainPromise = Promise.resolve();
const nativePromiseThen = Promise.prototype.then;
const maxThenableDrainDepth = 8;

function scheduleThenableDrain(callback: () => void): void {
  const ignore = (): void => undefined;
  try {
    const first = Reflect.apply(nativePromiseThen, settledDrainPromise, [
      ignore,
      ignore,
    ]) as Promise<unknown>;
    const second = Reflect.apply(nativePromiseThen, first, [ignore, ignore]) as Promise<unknown>;
    const runSafely = (): void => {
      try {
        callback();
      } catch {
        // Consumer-controlled work cannot escape the notification boundary.
      }
    };
    const tail = Reflect.apply(nativePromiseThen, second, [runSafely, ignore]) as Promise<unknown>;
    Reflect.apply(nativePromiseThen, tail, [ignore, ignore]);
  } catch {
    // Captured native Promise reactions are the non-blocking notification boundary.
  }
}

function drainThenable(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
  depth = 0
): void {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return;
  if (depth >= maxThenableDrainDepth || seen.has(value)) return;
  seen.add(value);
  scheduleThenableDrain(() => {
    const ignore = (): void => undefined;
    try {
      const reaction = Reflect.apply(nativePromiseThen, value, [undefined, ignore]);
      drainThenable(reaction, seen, depth + 1);
      return;
    } catch {
      // Internal Promise branding accepts subclasses and cross-realm Promises without
      // invoking a public `then`; non-Promises (including Promise proxies) fall through.
    }

    let then: unknown;
    try {
      then = Reflect.get(value, "then");
    } catch {
      return;
    }
    if (typeof then !== "function") return;

    let callbackSettled = false;
    const settle = (candidate: unknown): void => {
      if (callbackSettled) return;
      callbackSettled = true;
      drainThenable(candidate, seen, depth + 1);
    };
    let returned: unknown;
    try {
      returned = Reflect.apply(then, value, [settle, settle]);
    } catch {
      return;
    }
    drainThenable(returned, seen, depth + 1);
  });
}

// =============================================================================
// 메시지 생성
// =============================================================================

let messageIdCounter = 0;

/** Generate unique message ID */
export function generateMessageId(): string {
  return `msg_${Date.now()}_${++messageIdCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Create message */
export function createMessage<T extends IframeMessageType, P>(
  type: T,
  payload: P,
  id?: string
): IframeMessage<T, P> {
  return {
    type,
    id: id ?? generateMessageId(),
    payload,
    timestamp: Date.now(),
  };
}

// =============================================================================
// 메시지 검증
// =============================================================================

/** Validate message */
export function isValidMessage(data: unknown): data is IframeMessage {
  if (!data || typeof data !== "object") return false;

  const msg = data as Record<string, unknown>;
  return (
    typeof msg.type === "string" &&
    typeof msg.id === "string" &&
    typeof msg.timestamp === "number" &&
    "payload" in msg
  );
}

/** Validate origin */
export function isValidOrigin(origin: string, allowedOrigin: string): boolean {
  // ⚠️ SECURITY WARNING: Use "*" only in development environments
  // Never use in production (allows all origins)
  if (allowedOrigin === "*") {
    // Allow only in development mode
    const nodeEnv = (
      globalThis as {
        process?: { env?: { NODE_ENV?: string } };
      }
    ).process?.env?.NODE_ENV;
    if (nodeEnv === "production") {
      return false;
    }
    return true;
  }

  // Exact match
  if (origin === allowedOrigin) return true;

  // Allow localhost variants (for development)
  if (allowedOrigin === "localhost") {
    return (
      origin === "http://localhost:3000" ||
      origin === "http://127.0.0.1:3000" ||
      origin.startsWith("http://localhost:") ||
      origin.startsWith("http://127.0.0.1:")
    );
  }

  return false;
}

// =============================================================================
// 요청-응답 관리
// =============================================================================

interface PendingRequest<T = unknown> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  onRejectClaim: ((error: Error) => void) | null;
  ownership: object;
  timeout: ReturnType<typeof setTimeout> | null;
  timeoutToken: object | null;
  createdAt: number;
}

/**
 * Request-response manager
 *
 * Manages async request-response pattern for postMessage
 */
export class RequestManager {
  private pending = new Map<string, PendingRequest>();
  private defaultTimeout: number;
  private readonly scheduleTimeout: typeof setTimeout;
  private readonly cancelTimeout: typeof clearTimeout;

  constructor(defaultTimeout = 30000) {
    this.defaultTimeout = defaultTimeout;
    const scheduleTimeout = globalThis.setTimeout;
    const cancelTimeout = globalThis.clearTimeout;
    this.scheduleTimeout = ((...args: Parameters<typeof setTimeout>) =>
      Reflect.apply(scheduleTimeout, undefined, args)) as typeof setTimeout;
    this.cancelTimeout = ((...args: Parameters<typeof clearTimeout>) =>
      Reflect.apply(cancelTimeout, undefined, args)) as typeof clearTimeout;
  }

  /** Register request */
  register<T>(messageId: string, timeout?: number): Promise<T> {
    return this.registerWithOwnership<T>(messageId, timeout).response;
  }

  /** Register a request and return its exact internal ownership token. */
  registerWithOwnership<T>(
    messageId: string,
    timeout?: number,
    ownership: object = {},
    onRejectClaim: ((error: Error) => void) | null = null
  ): { response: Promise<T>; ownership: object } {
    const createdAt = Date.now();
    let resolveRequest!: (value: T) => void;
    let rejectRequest!: (error: Error) => void;
    const response = new Promise<T>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const timeoutToken = {};
    const request: PendingRequest<T> = {
      resolve: resolveRequest,
      reject: rejectRequest,
      onRejectClaim,
      ownership,
      timeout: null,
      timeoutToken,
      createdAt,
    };
    this.pending.set(messageId, request as PendingRequest);
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
      timeoutId = this.scheduleTimeout(() => {
        if (this.pending.get(messageId) !== request || request.timeoutToken !== timeoutToken) {
          return;
        }
        this.pending.delete(messageId);
        request.timeout = null;
        request.timeoutToken = null;
        this.publishClaimedRejection(
          request,
          new IframeError("TIMEOUT", `Request timeout: ${messageId}`)
        );
      }, timeout ?? this.defaultTimeout);
    } catch (error) {
      if (this.pending.get(messageId) !== request || request.timeoutToken !== timeoutToken) {
        return { response, ownership };
      }
      this.pending.delete(messageId);
      request.timeoutToken = null;
      this.cancelTimeoutBestEffort(timeoutId);
      throw error;
    }

    if (this.pending.get(messageId) !== request || request.timeoutToken !== timeoutToken) {
      this.cancelTimeoutBestEffort(timeoutId);
      return { response, ownership };
    }
    request.timeout = timeoutId;

    return { response, ownership };
  }

  /** Whether the exact registration still owns this message ID. */
  hasPending(messageId: string, ownership: object): boolean {
    return this.pending.get(messageId)?.ownership === ownership;
  }

  /** Handle response */
  resolve<T>(messageId: string, data: T): boolean {
    const claimed = this.claimRequest(messageId);
    if (!claimed) return false;

    this.cancelTimeoutBestEffort(claimed.timeout);
    claimed.request.resolve(data);
    return true;
  }

  /**
   * Claim one exact registration, publish terminal ownership, then resolve it.
   * The callback runs after the request is removed but before any settlement
   * reaction can observe the result.
   */
  claimAndResolve<T>(messageId: string, ownership: object, data: T, onClaim: () => void): boolean {
    const claimed = this.claimOwnedRequest(messageId, ownership);
    if (!claimed) return false;

    onClaim();
    this.cancelTimeoutBestEffort(claimed.timeout);
    claimed.request.resolve(data);
    return true;
  }

  /** Handle error */
  reject(messageId: string, error: Error): boolean {
    const claimed = this.claimRequest(messageId);
    if (!claimed) return false;

    this.cancelTimeoutBestEffort(claimed.timeout);
    claimed.request.reject(error);
    return true;
  }

  /** Claim one exact registration, publish terminal ownership, then reject it. */
  claimAndReject(messageId: string, ownership: object, error: Error, onClaim: () => void): boolean {
    const claimed = this.claimOwnedRequest(messageId, ownership);
    if (!claimed) return false;

    onClaim();
    this.cancelTimeoutBestEffort(claimed.timeout);
    claimed.request.reject(error);
    return true;
  }

  /** Extend timeout for a pending request (e.g., when onboarding is needed) */
  extendTimeout(messageId: string, newTimeout: number): boolean {
    const request = this.pending.get(messageId);
    if (!request) return false;

    const previousTimeout = request.timeout;
    const nextToken = {};
    request.timeout = null;
    request.timeoutToken = nextToken;
    this.cancelTimeoutBestEffort(previousTimeout);
    if (this.pending.get(messageId) !== request || request.timeoutToken !== nextToken) return false;
    let nextTimeout: ReturnType<typeof setTimeout> | null = null;

    try {
      nextTimeout = this.scheduleTimeout(() => {
        if (this.pending.get(messageId) !== request || request.timeoutToken !== nextToken) return;
        this.pending.delete(messageId);
        request.timeout = null;
        request.timeoutToken = null;
        this.publishClaimedRejection(
          request,
          new IframeError("TIMEOUT", `Request timeout: ${messageId}`)
        );
      }, newTimeout);
    } catch (error) {
      if (this.pending.get(messageId) === request && request.timeoutToken === nextToken) {
        this.pending.delete(messageId);
        request.timeoutToken = null;
        const safeError = errorOrFallback(error, "Request timeout extension failed");
        this.publishClaimedRejection(request, safeError);
        throw safeError;
      }
      return false;
    }

    if (this.pending.get(messageId) !== request || request.timeoutToken !== nextToken) {
      this.cancelTimeoutBestEffort(nextTimeout);
      return false;
    }
    request.timeout = nextTimeout;
    return this.pending.get(messageId) === request && request.timeoutToken === nextToken;
  }

  /** Cancel all pending requests */
  cancelAll(reason: string): void {
    const error = new IframeError("DESTROYED", reason);
    const requests = [...this.pending.values()].map((request) => {
      const timeout = request.timeout;
      request.timeout = null;
      request.timeoutToken = null;
      request.onRejectClaim = null;
      return { request, timeout };
    });
    this.pending.clear();
    requests.forEach(({ request, timeout }) => {
      this.cancelTimeoutBestEffort(timeout);
      request.reject(error);
    });
  }

  /** Number of pending requests */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Cleanup */
  destroy(): void {
    this.cancelAll("Channel destroyed");
  }

  private claimRequest(
    messageId: string
  ): { request: PendingRequest; timeout: ReturnType<typeof setTimeout> | null } | null {
    const request = this.pending.get(messageId);
    if (!request) return null;
    return this.releaseClaimedRequest(messageId, request);
  }

  private claimOwnedRequest(
    messageId: string,
    ownership: object
  ): { request: PendingRequest; timeout: ReturnType<typeof setTimeout> | null } | null {
    const request = this.pending.get(messageId);
    if (!request || request.ownership !== ownership) return null;
    return this.releaseClaimedRequest(messageId, request);
  }

  private releaseClaimedRequest(
    messageId: string,
    request: PendingRequest
  ): { request: PendingRequest; timeout: ReturnType<typeof setTimeout> | null } {
    this.pending.delete(messageId);
    const timeout = request.timeout;
    request.timeout = null;
    request.timeoutToken = null;
    request.onRejectClaim = null;
    return { request, timeout };
  }

  private publishClaimedRejection<T>(request: PendingRequest<T>, error: Error): void {
    const onRejectClaim = request.onRejectClaim;
    request.onRejectClaim = null;
    try {
      onRejectClaim?.(error);
    } catch {
      // Internal bookkeeping cannot prevent the already-claimed request from settling.
    }
    request.reject(error);
  }

  private cancelTimeoutBestEffort(timeout: ReturnType<typeof setTimeout> | null): void {
    if (timeout === null) return;
    try {
      this.cancelTimeout(timeout);
    } catch {
      // Logical request ownership is already released; stale callbacks are token-guarded.
    }
  }
}

// =============================================================================
// 메시지 핸들러 타입
// =============================================================================

export type MessageHandler<T extends IframeMessageType = IframeMessageType> = (
  message: IframeMessage<T>,
  origin: string
) => void | Promise<void>;

export type MessageHandlerMap = Partial<{
  [K in IframeMessageType]: MessageHandler<K>;
}>;

// =============================================================================
// 채널 베이스 클래스
// =============================================================================

/**
 * iframe communication channel base
 *
 * Common functionality used by both parent and iframe
 */
export abstract class IframeChannelBase {
  protected handlers: MessageHandlerMap = {};
  protected requestManager: RequestManager;
  protected allowedOrigin: string;
  protected allowedSource: Window | null = null;
  protected messageListener: ((event: MessageEvent) => void) | null = null;
  private messageListenerRemover: (() => void) | null = null;
  protected destroyed = false;

  constructor(allowedOrigin: string, timeout?: number) {
    this.allowedOrigin = allowedOrigin;
    this.requestManager = new RequestManager(timeout);
  }

  /** Restrict message source window */
  protected setAllowedSourceWindow(source: Window | null): void {
    this.allowedSource = source;
  }

  /** Drain a consumer callback result without awaiting or trusting its thenable surface. */
  protected drainReturnedThenable(value: unknown): void {
    drainThenable(value);
  }

  /** Register message handler */
  on<T extends IframeMessageType>(type: T, handler: MessageHandler<T>): void {
    this.handlers[type] = handler as MessageHandler;
  }

  /** Remove message handler */
  off(type: IframeMessageType): void {
    delete this.handlers[type];
  }

  /** Start message listener */
  protected startListening(): void {
    if (this.destroyed || this.messageListener) return;

    const target = window;
    const controller = new CapturedAbortController();
    const abort = controller.abort.bind(controller);
    if (this.destroyed) return;
    const listener = (event: MessageEvent) => {
      this.handleMessage(event);
    };
    let abortStarted = false;
    let registrationFinished = false;
    let explicitRemovalStarted = false;
    const removeListener = () => {
      if (!abortStarted) {
        abortStarted = true;
        try {
          abort();
        } catch {
          // Explicit removal below is the independent cleanup channel.
        }
      }
      if (!registrationFinished || explicitRemovalStarted) return;
      explicitRemovalStarted = true;
      try {
        target.removeEventListener("message", listener);
      } catch {
        // Listener removal is best-effort after local ownership is released.
      }
    };
    const rollbackRegistration = () => {
      if (this.messageListener === listener) this.messageListener = null;
      if (this.messageListenerRemover === removeListener) this.messageListenerRemover = null;
      try {
        removeListener();
      } catch {
        // Registration rollback is best-effort and preserves the original failure.
      }
    };
    this.messageListener = listener;
    this.messageListenerRemover = removeListener;

    try {
      target.addEventListener("message", listener, { signal: controller.signal });
      registrationFinished = true;
    } catch (error) {
      registrationFinished = true;
      rollbackRegistration();
      throw error;
    }
    if (
      this.destroyed ||
      this.messageListener !== listener ||
      this.messageListenerRemover !== removeListener
    ) {
      rollbackRegistration();
    }
  }

  /** Stop message listener */
  protected stopListening(): void {
    const listener = this.messageListener;
    const fallbackRemoval = this.messageListenerRemover;
    this.messageListener = null;
    this.messageListenerRemover = null;
    if (!listener) return;

    try {
      if (fallbackRemoval) fallbackRemoval();
      else window.removeEventListener("message", listener);
    } catch {
      // Listener removal is best-effort after local ownership is released.
    }
  }

  /** Handle message */
  protected handleMessage(event: MessageEvent): void {
    // Ignore messages from own origin
    if (event.origin === window.location.origin) {
      return;
    }

    // Validate source window (when possible)
    if (this.allowedSource && event.source !== this.allowedSource) {
      return;
    }

    // Validate origin
    if (!isValidOrigin(event.origin, this.allowedOrigin)) {
      return;
    }

    // Validate message
    if (!isValidMessage(event.data)) {
      return;
    }

    const message = event.data as IframeMessage;

    // Handle ERROR message
    if (message.type === "ERROR") {
      const payload = message.payload as { requestId?: string; code: string; message: string };
      if (payload.requestId) {
        this.requestManager.reject(
          payload.requestId,
          new IframeError(payload.code as IframeErrorCode, payload.message)
        );
      }
      return;
    }

    // Call registered handler
    const handler = this.handlers[message.type] as MessageHandler | undefined;
    if (handler) {
      try {
        const result = handler(message as IframeMessage, event.origin);
        this.drainReturnedThenable(result);
      } catch {
        // Ignore handler errors
      }
    }
  }

  /** Destroy channel */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.stopListening();
    } finally {
      try {
        this.requestManager.destroy();
      } finally {
        this.handlers = {};
      }
    }
  }

  /** Check if destroyed */
  get isDestroyed(): boolean {
    return this.destroyed;
  }
}

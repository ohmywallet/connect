/**
 * iframe communication channel
 *
 * Secure communication layer based on postMessage
 */

import type { IframeMessage, IframeMessageType, IframeErrorCode } from "./types";
import { IframeError } from "./types";

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
    if (typeof process !== "undefined" && process.env?.NODE_ENV === "production") {
      console.error("🚨 SECURITY: allowedOrigin='*' cannot be used in production");
      return false;
    }
    console.warn("⚠️ Security warning: All origins allowed (development mode only)");
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
  timeout: ReturnType<typeof setTimeout>;
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

  constructor(defaultTimeout = 30000) {
    this.defaultTimeout = defaultTimeout;
  }

  /** Register request */
  register<T>(messageId: string, timeout?: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(messageId);
        reject(new IframeError("TIMEOUT", `Request timeout: ${messageId}`));
      }, timeout ?? this.defaultTimeout);

      this.pending.set(messageId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout: timeoutId,
        createdAt: Date.now(),
      });
    });
  }

  /** Handle response */
  resolve<T>(messageId: string, data: T): boolean {
    const request = this.pending.get(messageId);
    if (!request) return false;

    clearTimeout(request.timeout);
    this.pending.delete(messageId);
    request.resolve(data);
    return true;
  }

  /** Handle error */
  reject(messageId: string, error: Error): boolean {
    const request = this.pending.get(messageId);
    if (!request) return false;

    clearTimeout(request.timeout);
    this.pending.delete(messageId);
    request.reject(error);
    return true;
  }

  /** Cancel all pending requests */
  cancelAll(reason: string): void {
    const error = new IframeError("DESTROYED", reason);
    this.pending.forEach((request) => {
      clearTimeout(request.timeout);
      request.reject(error);
    });
    this.pending.clear();
  }

  /** Number of pending requests */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Cleanup */
  destroy(): void {
    this.cancelAll("Channel destroyed");
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
  protected destroyed = false;

  constructor(allowedOrigin: string, timeout?: number) {
    this.allowedOrigin = allowedOrigin;
    this.requestManager = new RequestManager(timeout);
  }

  /** Restrict message source window */
  protected setAllowedSourceWindow(source: Window | null): void {
    this.allowedSource = source;
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
    if (this.messageListener) return;

    this.messageListener = (event: MessageEvent) => {
      this.handleMessage(event);
    };

    window.addEventListener("message", this.messageListener);
  }

  /** Stop message listener */
  protected stopListening(): void {
    if (this.messageListener) {
      window.removeEventListener("message", this.messageListener);
      this.messageListener = null;
    }
  }

  /** Handle message */
  protected handleMessage(event: MessageEvent): void {
    // Ignore messages from own origin
    if (event.origin === window.location.origin) {
      console.log("[IframeChannelBase] 자신의 origin에서 온 메시지 무시", event.origin);
      return;
    }

    // Validate source window (when possible)
    if (this.allowedSource && event.source !== this.allowedSource) {
      console.log("[IframeChannelBase] 허용되지 않은 source window", event.source);
      return;
    }

    // Validate origin
    if (!isValidOrigin(event.origin, this.allowedOrigin)) {
      console.log(
        "[IframeChannelBase] 허용되지 않은 origin",
        event.origin,
        "allowed:",
        this.allowedOrigin
      );
      return;
    }

    // Validate message
    if (!isValidMessage(event.data)) {
      console.log("[IframeChannelBase] 유효하지 않은 메시지 형식", event.data);
      return;
    }

    const message = event.data as IframeMessage;
    console.log("[IframeChannelBase] 메시지 수신", message.type, message);

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
        handler(message as IframeMessage, event.origin);
      } catch {
        // Ignore handler errors
      }
    }
  }

  /** Destroy channel */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopListening();
    this.requestManager.destroy();
    this.handlers = {};
  }

  /** Check if destroyed */
  get isDestroyed(): boolean {
    return this.destroyed;
  }
}

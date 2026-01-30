/**
 * iframe 통신 채널
 *
 * postMessage 기반 안전한 통신 레이어
 */

import type { IframeMessage, IframeMessageType, IframeErrorCode } from "./types";
import { IframeError } from "./types";

// =============================================================================
// 메시지 생성
// =============================================================================

let messageIdCounter = 0;

/** 고유 메시지 ID 생성 */
export function generateMessageId(): string {
  return `msg_${Date.now()}_${++messageIdCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 메시지 생성 */
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

/** 메시지 유효성 검사 */
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

/** origin 검증 */
export function isValidOrigin(origin: string, allowedOrigin: string): boolean {
  // 개발 환경 허용
  if (allowedOrigin === "*") return true;

  // 정확한 매칭
  if (origin === allowedOrigin) return true;

  // localhost 변형 허용 (개발용)
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
 * 요청-응답 관리자
 *
 * postMessage의 비동기 요청-응답 패턴 관리
 */
export class RequestManager {
  private pending = new Map<string, PendingRequest>();
  private defaultTimeout: number;

  constructor(defaultTimeout = 30000) {
    this.defaultTimeout = defaultTimeout;
  }

  /** 요청 등록 */
  register<T>(messageId: string, timeout?: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(messageId);
        reject(new IframeError("TIMEOUT", `요청 타임아웃: ${messageId}`));
      }, timeout ?? this.defaultTimeout);

      this.pending.set(messageId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout: timeoutId,
        createdAt: Date.now(),
      });
    });
  }

  /** 응답 처리 */
  resolve<T>(messageId: string, data: T): boolean {
    const request = this.pending.get(messageId);
    if (!request) return false;

    clearTimeout(request.timeout);
    this.pending.delete(messageId);
    request.resolve(data);
    return true;
  }

  /** 에러 처리 */
  reject(messageId: string, error: Error): boolean {
    const request = this.pending.get(messageId);
    if (!request) return false;

    clearTimeout(request.timeout);
    this.pending.delete(messageId);
    request.reject(error);
    return true;
  }

  /** 모든 대기 중인 요청 취소 */
  cancelAll(reason: string): void {
    const error = new IframeError("DESTROYED", reason);
    this.pending.forEach((request) => {
      clearTimeout(request.timeout);
      request.reject(error);
    });
    this.pending.clear();
  }

  /** 대기 중인 요청 수 */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** 정리 */
  destroy(): void {
    this.cancelAll("채널이 종료되었습니다");
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
 * iframe 통신 채널 베이스
 *
 * 부모와 iframe 모두 사용하는 공통 기능
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

  /** 메시지 소스 윈도우 제한 */
  protected setAllowedSourceWindow(source: Window | null): void {
    this.allowedSource = source;
  }

  /** 메시지 핸들러 등록 */
  on<T extends IframeMessageType>(type: T, handler: MessageHandler<T>): void {
    this.handlers[type] = handler as MessageHandler;
  }

  /** 메시지 핸들러 제거 */
  off(type: IframeMessageType): void {
    delete this.handlers[type];
  }

  /** 메시지 리스너 시작 */
  protected startListening(): void {
    if (this.messageListener) return;

    this.messageListener = (event: MessageEvent) => {
      this.handleMessage(event);
    };

    window.addEventListener("message", this.messageListener);
  }

  /** 메시지 리스너 중지 */
  protected stopListening(): void {
    if (this.messageListener) {
      window.removeEventListener("message", this.messageListener);
      this.messageListener = null;
    }
  }

  /** 메시지 처리 */
  protected handleMessage(event: MessageEvent): void {
    // 자기 자신의 origin에서 오는 메시지는 무시
    if (event.origin === window.location.origin) {
      return;
    }

    // source 윈도우 검증 (가능한 경우)
    if (this.allowedSource && event.source !== this.allowedSource) {
      return;
    }

    // origin 검증
    if (!isValidOrigin(event.origin, this.allowedOrigin)) {
      return;
    }

    // 메시지 유효성 검사
    if (!isValidMessage(event.data)) {
      return;
    }

    const message = event.data as IframeMessage;

    // ERROR 메시지 처리
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

    // 등록된 핸들러 호출
    const handler = this.handlers[message.type] as MessageHandler | undefined;
    if (handler) {
      try {
        handler(message as IframeMessage, event.origin);
      } catch {
        // 핸들러 에러 무시
      }
    }
  }

  /** 채널 종료 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopListening();
    this.requestManager.destroy();
    this.handlers = {};
  }

  /** 종료 여부 */
  get isDestroyed(): boolean {
    return this.destroyed;
  }
}

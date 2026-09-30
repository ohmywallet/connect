/**
 * IframeHost - dApp wallet connection
 *
 * Derivation-only relay v2 wallet connection and signing management.
 *
 * @example
 * ```typescript
 * import { IframeHost } from "@ohmywallet/connect";
 *
 * const wallet = new IframeHost({
 *   iframeSrc: "https://embed.ohmywallet.xyz",
 * });
 *
 * const connection = await wallet.connect();
 * const signature = await wallet.sign(
 *   { kind: "message", message: { type: "text", value: "Sign in to Example" } },
 *   { address: connection.address.address }
 * );
 * ```
 */

import { isAddress } from "viem";
import type {
  IframeHostConfig,
  SupportedLocale,
  DerivationConnectOptions,
  DerivationConnectResult,
  DerivationSignOptions,
  DerivationSignResult,
  DeriveAddressOptions,
  DeriveAddressSuccess,
  EvmSignOptions,
  EvmSigningRequest,
  PrimaryConnectResult,
  PrimarySignResult,
  SolanaRawSigningRequest,
  SolanaSignOptions,
  IframeErrorCode,
  IframeHost as PublicIframeHost,
} from "./types";
import { IframeError } from "./types";
import { IframeChannelBase, generateMessageId } from "./channel";
import {
  bindActiveRequest,
  buildCancel,
  buildConnect,
  buildDeriveAddress,
  buildDestroy,
  buildRelayInit,
  buildSign,
  parseRelayOnboarding,
  parseRelayReady,
  parseTerminal,
  type ActiveProtocolRequest,
  type ParentRequest,
} from "./relay-protocol";
import {
  HostSurfaceContainerDisconnectedError,
  createHostSurface,
  type HostSurface,
} from "./host-surface";

export const DEFAULT_IFRAME_SRC = "https://embed.ohmywallet.xyz";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 30_000;
const RELAY_INITIALIZATION_RETRY_MS = 250;
const CANCELLATION_DRAIN_TIMEOUT_MS = 2_000;

type WalletOperationRequest = Extract<
  ParentRequest,
  { type: "CONNECT" | "DERIVE_ADDRESS" | "SIGN_WITH_DERIVATION" }
>;

type OperationPhase = "initializing" | "dispatching" | "active" | "cancelling" | "terminal";

type OperationTerminal =
  | Readonly<{ status: "fulfilled"; value: unknown }>
  | Readonly<{ status: "rejected"; error: IframeError }>;

interface PublicOperationContext {
  errorEmitted: boolean;
}

interface ActiveHostOperation {
  readonly message: WalletOperationRequest;
  readonly protocol: ActiveProtocolRequest;
  readonly response: Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: IframeError) => void;
  phase: OperationPhase;
  terminalClaimed: boolean;
  publicSettled: boolean;
  cancelRequested: boolean;
  deferredCancellationPublication: boolean;
  dispatched: boolean;
  readonly requestOwnership: object;
  readonly publicContext: PublicOperationContext;
  terminal: OperationTerminal | null;
  cancellationTimeout: ReturnType<typeof setTimeout> | null;
  cancellationTimeoutToken: object | null;
}

function createActiveHostOperation(
  message: WalletOperationRequest,
  publicContext: PublicOperationContext
): ActiveHostOperation {
  let resolveOperation!: (value: unknown) => void;
  let rejectOperation!: (error: IframeError) => void;
  let settled = false;
  const response = new Promise<unknown>((resolve, reject) => {
    resolveOperation = resolve;
    rejectOperation = reject;
  });

  const operation: ActiveHostOperation = {
    message,
    protocol: bindActiveRequest(message),
    response,
    resolve: (value) => {
      if (settled) return;
      settled = true;
      operation.publicSettled = true;
      resolveOperation(value);
    },
    reject: (error) => {
      if (settled) return;
      settled = true;
      operation.publicSettled = true;
      rejectOperation(error);
    },
    phase: "initializing",
    terminalClaimed: false,
    publicSettled: false,
    cancelRequested: false,
    deferredCancellationPublication: false,
    dispatched: false,
    requestOwnership: {},
    publicContext,
    terminal: null,
    cancellationTimeout: null,
    cancellationTimeoutToken: null,
  };
  return operation;
}

const normalizedIframeErrors = new WeakSet<object>();
const iframeErrorCodes = new Set<string>([
  "NOT_INITIALIZED",
  "ALREADY_INITIALIZED",
  "TIMEOUT",
  "DESTROYED",
  "SIGN_FAILED",
  "INVALID_MESSAGE",
  "INVALID_ORIGIN",
  "VALIDATION_FAILED",
  "CREDENTIAL_INACCESSIBLE",
  "ALREADY_EXISTS",
  "USER_CANCELLED",
  "UNKNOWN_KEY",
  "UNKNOWN_ADDRESS",
  "EIP7702_UNAVAILABLE",
  "SECURITY_BOUNDARY_VIOLATION",
]);

function isIframeErrorCode(value: unknown): value is IframeErrorCode {
  return typeof value === "string" && iframeErrorCodes.has(value);
}

function toIframeError(cause: unknown): IframeError {
  const cacheKey =
    (typeof cause === "object" && cause !== null) || typeof cause === "function" ? cause : null;
  if (cacheKey !== null) {
    if (normalizedIframeErrors.has(cacheKey)) return cacheKey as IframeError;
  }

  let code: IframeErrorCode = "SIGN_FAILED";
  let message = "Wallet operation failed";
  try {
    const candidateCode = cause instanceof IframeError ? cause.code : null;
    if (isIframeErrorCode(candidateCode)) {
      code = candidateCode;
    }
  } catch {
    // Hostile Error/Proxy metadata falls back to a bounded public error.
  }
  try {
    const candidateMessage = cause instanceof Error ? cause.message : null;
    if (typeof candidateMessage === "string" && candidateMessage.length > 0) {
      message = candidateMessage.slice(0, 1_024);
    }
  } catch {
    // Hostile Error/Proxy metadata falls back to the generic public message.
  }

  const normalized = new IframeError(code, message);
  Object.freeze(normalized);
  normalizedIframeErrors.add(normalized);
  return normalized;
}

function errorOrFallback(value: unknown, fallback: string): Error {
  try {
    if (value instanceof Error) return value;
  } catch {
    // Hostile Error/Proxy classification falls through to a safe local error.
  }
  return new Error(fallback);
}

function isContainerDisconnectedError(value: unknown): boolean {
  try {
    return value instanceof HostSurfaceContainerDisconnectedError;
  } catch {
    return false;
  }
}

function isExactDerivationConnectOptions(value: unknown): value is DerivationConnectOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== "signerType") return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, "signerType");
  return (
    descriptor !== undefined &&
    descriptor.enumerable === true &&
    "value" in descriptor &&
    descriptor.value === "derivation"
  );
}

interface InitializationAttempt {
  readonly generation: number;
  readonly handoff: InitializationHandoff;
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

interface InitializationHandoff {
  readonly generation: number;
}

interface IframeLifecycleOwnership {
  readonly generation: number;
  readonly surface: HostSurface;
  readonly iframe: HTMLIFrameElement;
}

function createInitializationAttempt(generation: number): InitializationAttempt {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    generation,
    handoff: { generation },
    promise,
    resolve: () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
    reject: (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}

/** Detect browser locale and convert to SupportedLocale (15 languages supported) */
function detectLocale(): SupportedLocale {
  if (typeof navigator === "undefined") return "ko";

  const browserLang = navigator.language.toLowerCase();

  // Exact match first (zh-CN, zh-TW, etc.)
  const exactMatch: Record<string, SupportedLocale> = {
    "zh-cn": "zh-CN",
    "zh-tw": "zh-TW",
    "zh-hk": "zh-TW", // Hong Kong uses Traditional Chinese
    "zh-sg": "zh-CN", // Singapore uses Simplified Chinese
  };

  if (exactMatch[browserLang]) {
    return exactMatch[browserLang];
  }

  // Language code based matching
  const langCode = browserLang.split("-")[0];
  const langMatch: Record<string, SupportedLocale> = {
    ko: "ko",
    en: "en",
    zh: "zh-CN", // Default Chinese is Simplified
    es: "es",
    hi: "hi",
    id: "id",
    vi: "vi",
    ru: "ru",
    pt: "pt",
    tr: "tr",
    ja: "ja",
    fr: "fr",
    de: "de",
    ar: "ar",
  };

  return langMatch[langCode] ?? "ko";
}

/** IframeHost state */
export type IframeHostState = "idle" | "loading" | "ready" | "error" | "destroyed";

/** IframeHost events */
export interface IframeHostEvents {
  error: (error: IframeError) => void;
  destroyed: () => void;
}

/**
 * IframeHost
 *
 * Provides wallet functionality through OhMyWallet iframe in dApps.
 */
export class IframeHost extends IframeChannelBase implements PublicIframeHost {
  private config: IframeHostConfig & { iframeSrc: string };
  private iframeOrigin: string;
  private surface: HostSurface | null = null;
  private iframe: HTMLIFrameElement | null = null;
  private state: IframeHostState = "idle";
  private eventHandlers: Partial<IframeHostEvents> = {};
  private initializationAttempt: InitializationAttempt | null = null;
  private initializationHandoff: InitializationHandoff | null = null;
  private loadRejecter: ((error: Error) => void) | null = null;
  private loadTimeout: ReturnType<typeof setTimeout> | null = null;
  private loadTimeoutToken: object | null = null;
  private readyResolver: (() => void) | null = null;
  private readyRejecter: ((error: Error) => void) | null = null;
  private readyTimeout: ReturnType<typeof setTimeout> | null = null;
  private readyTimeoutToken: object | null = null;
  private relayInitializationRetry: ReturnType<typeof setInterval> | null = null;
  private relayInitializationRetryToken: object | null = null;
  private relayInitializationSent = false;
  private relayInitialized = false;
  private activeOperation: ActiveHostOperation | null = null;
  private activeRequest: ActiveProtocolRequest | null = null;
  private lifecycleGeneration = 0;
  private destroyedEventEmitted = false;
  private readonly scheduleTimeout: typeof setTimeout;
  private readonly cancelTimeout: typeof clearTimeout;
  private readonly scheduleInterval: typeof setInterval;
  private readonly cancelInterval: typeof clearInterval;
  private readonly scheduleMicrotask: typeof queueMicrotask;

  constructor(config: IframeHostConfig = {}) {
    const iframeSrc = config.iframeSrc ?? DEFAULT_IFRAME_SRC;
    const origin = new URL(iframeSrc).origin;
    super(origin, config.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS);
    this.config = { ...config, iframeSrc };
    this.iframeOrigin = origin;
    const scheduleTimeout = globalThis.setTimeout;
    const cancelTimeout = globalThis.clearTimeout;
    const scheduleInterval = globalThis.setInterval;
    const cancelInterval = globalThis.clearInterval;
    const scheduleMicrotask = globalThis.queueMicrotask;
    this.scheduleTimeout = ((...args: Parameters<typeof setTimeout>) =>
      Reflect.apply(scheduleTimeout, undefined, args)) as typeof setTimeout;
    this.cancelTimeout = ((...args: Parameters<typeof clearTimeout>) =>
      Reflect.apply(cancelTimeout, undefined, args)) as typeof clearTimeout;
    this.scheduleInterval = ((...args: Parameters<typeof setInterval>) =>
      Reflect.apply(scheduleInterval, undefined, args)) as typeof setInterval;
    this.cancelInterval = ((...args: Parameters<typeof clearInterval>) =>
      Reflect.apply(cancelInterval, undefined, args)) as typeof clearInterval;
    this.scheduleMicrotask = (callback) => {
      Reflect.apply(scheduleMicrotask, undefined, [callback]);
    };
  }

  /** Current state */
  get currentState(): IframeHostState {
    return this.state;
  }

  /** Register event handler */
  onEvent<K extends keyof IframeHostEvents>(event: K, handler: IframeHostEvents[K]): () => void {
    // Keep replacement semantics while giving each registration its own cleanup identity.
    const registered = ((...args: Parameters<IframeHostEvents[K]>) =>
      Reflect.apply(handler, undefined, args)) as IframeHostEvents[K];
    this.eventHandlers[event] = registered;
    return () => {
      if (this.eventHandlers[event] === registered) delete this.eventHandlers[event];
    };
  }

  // ==========================================================================
  // Public Derivation-only API
  // ==========================================================================

  connect(): Promise<PrimaryConnectResult> {
    return this.runPublicOperation((context) => this.connectCore(context));
  }

  deriveAddress(options: DeriveAddressOptions): Promise<DeriveAddressSuccess> {
    return this.runPublicOperation((context) => this.deriveAddressCore(options, context));
  }

  sign(request: EvmSigningRequest, options: EvmSignOptions): Promise<PrimarySignResult>;
  sign(request: SolanaRawSigningRequest, options: SolanaSignOptions): Promise<PrimarySignResult>;
  sign(
    request: EvmSigningRequest | SolanaRawSigningRequest,
    options: EvmSignOptions | SolanaSignOptions
  ): Promise<PrimarySignResult> {
    return this.runPublicOperation((context) => this.signCore(request, options, context));
  }

  cancel(): boolean {
    const operation = this.activeOperation;
    if (
      operation === null ||
      operation.terminalClaimed ||
      operation.phase === "cancelling" ||
      operation.phase === "terminal"
    ) {
      return false;
    }

    const error = toIframeError(new IframeError("USER_CANCELLED", "User cancelled the operation"));
    operation.cancelRequested = true;
    operation.terminalClaimed = true;
    operation.terminal = { status: "rejected", error };

    if (!operation.dispatched) {
      operation.phase = "terminal";
      this.requestManager.claimAndReject(
        operation.protocol.id,
        operation.requestOwnership,
        error,
        () => undefined
      );
      if (this.relayInitialized && this.surface !== null) {
        operation.deferredCancellationPublication = true;
        return true;
      }
      this.emitErrorSafely(error, operation.publicContext);
      this.abortInitializationForCancellation(error);
      operation.reject(error);
      this.finishOperation(operation, { restoreFocus: false });
      return true;
    }

    operation.phase = "cancelling";
    this.emitErrorSafely(error, operation.publicContext);
    this.requestManager.claimAndReject(
      operation.protocol.id,
      operation.requestOwnership,
      error,
      () => undefined
    );
    operation.reject(error);
    try {
      this.hide();
    } catch {
      // Cancellation already owns the public terminal; focus cleanup is best-effort.
    }

    try {
      this.postToIframe(
        buildCancel(operation.protocol.id, generateMessageId(), Date.now()),
        () => this.activeOperation === operation && operation.phase === "cancelling"
      );
    } catch {
      // The bounded reset below is authoritative when relay delivery is unavailable.
    }
    this.startCancellationDrain(operation);
    return true;
  }

  /** @deprecated Use `connect()` instead. */
  connectWithSignerType(options: DerivationConnectOptions): Promise<DerivationConnectResult> {
    return this.runPublicOperation(
      (context) => {
        let validOptions = false;
        try {
          validOptions = isExactDerivationConnectOptions(options);
        } catch {
          // Validation remains false; destroyed precedence is checked below.
        }
        if (this.destroyed || this.state === "destroyed") {
          throw new IframeError("DESTROYED", "IframeHost destroyed");
        }
        if (!validOptions) {
          throw new IframeError("VALIDATION_FAILED", "Relay protocol v2 is Derivation-only");
        }
        return this.connectCore(context);
      },
      (result) => ({ ...result, signerType: "derivation" as const })
    );
  }

  /** @deprecated Use `sign()` instead. */
  signWithDerivation(
    request: EvmSigningRequest,
    options: EvmSignOptions
  ): Promise<DerivationSignResult>;
  signWithDerivation(
    request: SolanaRawSigningRequest,
    options: SolanaSignOptions
  ): Promise<DerivationSignResult>;
  signWithDerivation(
    request: EvmSigningRequest | SolanaRawSigningRequest,
    options: DerivationSignOptions
  ): Promise<DerivationSignResult> {
    return this.runPublicOperation(
      (context) => this.signCore(request, options, context),
      (result) => ({ ...result, signerType: "derivation" as const })
    );
  }

  private async runPublicOperation<T>(
    operation: (context: PublicOperationContext) => Promise<T>
  ): Promise<T>;
  private async runPublicOperation<T, R>(
    operation: (context: PublicOperationContext) => Promise<T>,
    adapt: (value: T) => R
  ): Promise<R>;
  private async runPublicOperation<T, R>(
    operation: (context: PublicOperationContext) => Promise<T>,
    adapt?: (value: T) => R
  ): Promise<T | R> {
    const context: PublicOperationContext = { errorEmitted: false };
    try {
      const value = await operation(context);
      return adapt === undefined ? value : adapt(value);
    } catch (cause) {
      const error = toIframeError(cause);
      this.emitErrorSafely(error, context);
      throw error;
    }
  }

  private emitErrorSafely(error: IframeError, context: PublicOperationContext): void {
    const safeError = toIframeError(error);
    if (context.errorEmitted) return;
    context.errorEmitted = true;
    let result: unknown;
    try {
      result = this.eventHandlers.error?.(safeError);
    } catch {
      // A consumer handler cannot replace or delay the owned operation outcome.
      return;
    }
    this.drainReturnedThenable(result);
  }

  private connectCore(context: PublicOperationContext): Promise<PrimaryConnectResult> {
    this.assertHostActive();
    let message: WalletOperationRequest;
    try {
      const built = buildConnect(generateMessageId(), Date.now());
      this.assertHostActive();
      if (built.type !== "CONNECT") {
        throw new IframeError("INVALID_MESSAGE", "Invalid connect operation");
      }
      message = built;
    } catch (cause) {
      if (this.destroyed || this.state === "destroyed") {
        throw new IframeError("DESTROYED", "IframeHost destroyed");
      }
      throw cause;
    }
    return this.startOperation<PrimaryConnectResult>(message, { initialize: true }, context);
  }

  private deriveAddressCore(
    options: DeriveAddressOptions,
    context: PublicOperationContext
  ): Promise<DeriveAddressSuccess> {
    this.assertHostActive();
    let message: WalletOperationRequest;
    try {
      const built = buildDeriveAddress(generateMessageId(), options, Date.now());
      this.assertHostActive();
      if (built.type !== "DERIVE_ADDRESS") throw new TypeError("Invalid derive operation");
      message = built;
    } catch {
      if (this.destroyed || this.state === "destroyed") {
        throw new IframeError("DESTROYED", "IframeHost destroyed");
      }
      throw new IframeError("VALIDATION_FAILED", "Invalid derive-address request");
    }
    if (message.type !== "DERIVE_ADDRESS") {
      throw new IframeError("INVALID_MESSAGE", "Invalid derive-address operation");
    }
    return this.startOperation<DeriveAddressSuccess>(message, { initialize: false }, context);
  }

  private signCore(
    request: EvmSigningRequest | SolanaRawSigningRequest,
    options: EvmSignOptions | SolanaSignOptions,
    context: PublicOperationContext
  ): Promise<PrimarySignResult> {
    this.assertHostActive();
    let message: WalletOperationRequest;
    try {
      const materializeSign = buildSign as (
        id: string,
        signingRequest: EvmSigningRequest | SolanaRawSigningRequest,
        signingOptions: EvmSignOptions | SolanaSignOptions,
        timestamp: number
      ) => ParentRequest;
      const built = materializeSign(generateMessageId(), request, options, Date.now());
      this.assertHostActive();
      if (built.type !== "SIGN_WITH_DERIVATION") {
        throw new TypeError("Invalid signing operation");
      }
      message = built;
    } catch {
      if (this.destroyed || this.state === "destroyed") {
        throw new IframeError("DESTROYED", "IframeHost destroyed");
      }
      throw new IframeError("VALIDATION_FAILED", "Invalid signing request");
    }

    if (
      Object.hasOwn(message.payload, "address") &&
      typeof message.payload.address === "string" &&
      message.payload.address.startsWith("0x") &&
      !isAddress(message.payload.address)
    ) {
      throw new IframeError("VALIDATION_FAILED", "Invalid EVM address format");
    }
    return this.startOperation<PrimarySignResult>(message, { initialize: false }, context);
  }

  private assertHostActive(): void {
    if (this.destroyed || this.state === "destroyed") {
      throw new IframeError("DESTROYED", "IframeHost destroyed");
    }
  }

  private startOperation<T>(
    message: WalletOperationRequest,
    options: Readonly<{ initialize: boolean }>,
    context: PublicOperationContext
  ): Promise<T> {
    this.assertHostActive();
    if (this.activeOperation !== null) {
      throw new IframeError("SIGN_FAILED", "Another wallet request is already active");
    }

    const operation = createActiveHostOperation(message, context);
    this.activeOperation = operation;
    this.activeRequest = operation.protocol;
    void this.driveOperation(operation, options);
    return operation.response as Promise<T>;
  }

  private async driveOperation(
    operation: ActiveHostOperation,
    options: Readonly<{ initialize: boolean }>
  ): Promise<void> {
    let initializationHandoff: InitializationHandoff | null = null;
    try {
      if (options.initialize) {
        initializationHandoff = await this.ensureIframeReady();
        this.assertOperationOwnership(operation);
      } else {
        this.assertReady();
      }

      if (operation.terminalClaimed) return;

      await this.dispatchOperation(operation, initializationHandoff);
    } catch (cause) {
      if (!operation.terminalClaimed) {
        const error =
          this.destroyed || this.state === "destroyed"
            ? new IframeError("DESTROYED", "IframeHost destroyed")
            : toIframeError(cause);
        operation.terminalClaimed = true;
        operation.phase = "terminal";
        operation.terminal = { status: "rejected", error };
      }
    } finally {
      this.releaseInitializationHandoff(initializationHandoff);
      if (operation.phase !== "cancelling") {
        const terminal = operation.terminal;
        const deferredCancellation =
          operation.deferredCancellationPublication && terminal?.status === "rejected";
        if (
          terminal?.status === "fulfilled" &&
          operation.message.type === "CONNECT" &&
          !this.destroyed &&
          this.state !== "destroyed"
        ) {
          this.state = "ready";
        }
        if (
          terminal?.status === "rejected" &&
          operation.message.type === "CONNECT" &&
          this.activeOperation === operation &&
          !this.destroyed &&
          this.state === "loading"
        ) {
          this.state = "idle";
        }
        if (deferredCancellation) {
          this.hideOperationSurface(operation, { restoreFocus: true });
          this.emitErrorSafely(terminal.error, operation.publicContext);
          if (!operation.publicSettled) operation.reject(terminal.error);
          this.releaseOperationOwnership(operation);
        } else {
          this.finishOperation(operation, { restoreFocus: true });
        }
        if (
          operation.cancelRequested &&
          !operation.dispatched &&
          !this.destroyed &&
          this.state !== "destroyed" &&
          this.surface !== null
        ) {
          this.lifecycleGeneration += 1;
          this.setAllowedSourceWindow(null);
          this.cleanupIframe();
          this.state = "idle";
        }
        if (!deferredCancellation && !operation.publicSettled && terminal !== null) {
          if (terminal.status === "fulfilled") operation.resolve(terminal.value);
          else operation.reject(terminal.error);
        }
      }
    }
  }

  private async dispatchOperation(
    operation: ActiveHostOperation,
    initializationHandoff: InitializationHandoff | null
  ): Promise<void> {
    this.assertOperationOwnership(operation);
    if (initializationHandoff !== null && !this.ownsInitializationHandoff(initializationHandoff)) {
      throw new IframeError("SIGN_FAILED", "Another wallet request is already active");
    }
    if (initializationHandoff !== null) this.initializationHandoff = null;

    this.show();
    this.assertOperationOwnership(operation);
    if (operation.terminalClaimed) return;
    operation.phase = "dispatching";
    const registration = this.requestManager.registerWithOwnership<unknown>(
      operation.protocol.id,
      undefined,
      operation.requestOwnership,
      (cause) => {
        if (operation.terminalClaimed) return;
        const error = toIframeError(cause);
        operation.terminalClaimed = true;
        operation.phase = "terminal";
        operation.terminal = { status: "rejected", error };
      }
    );
    if (
      this.destroyed ||
      this.state === "destroyed" ||
      this.activeOperation !== operation ||
      this.activeRequest !== operation.protocol
    ) {
      this.requestManager.claimAndReject(
        operation.protocol.id,
        registration.ownership,
        new IframeError("DESTROYED", "IframeHost destroyed"),
        () => undefined
      );
    }
    const canDeliver = (): boolean =>
      this.activeOperation === operation &&
      !operation.terminalClaimed &&
      this.requestManager.hasPending(operation.protocol.id, registration.ownership);

    try {
      if (canDeliver()) {
        this.postToIframe(operation.message, canDeliver, () => {
          this.assertOperationOwnership(operation);
          operation.dispatched = true;
          operation.phase = "active";
        });
      }
    } catch (cause) {
      if (!operation.terminalClaimed) {
        const error = toIframeError(cause);
        this.requestManager.claimAndReject(
          operation.protocol.id,
          registration.ownership,
          error,
          () => {
            operation.terminalClaimed = true;
            operation.phase = "terminal";
            operation.terminal = { status: "rejected", error };
          }
        );
      }
    }

    try {
      await registration.response;
    } catch (cause) {
      if (!operation.terminalClaimed) {
        const error = toIframeError(cause);
        operation.terminalClaimed = true;
        operation.phase = "terminal";
        operation.terminal = { status: "rejected", error };
      }
    }
  }

  private assertOperationOwnership(operation: ActiveHostOperation): void {
    if (this.destroyed || this.state === "destroyed") {
      throw new IframeError("DESTROYED", "IframeHost destroyed");
    }
    if (this.activeOperation !== operation || this.activeRequest !== operation.protocol) {
      throw new IframeError("SIGN_FAILED", "Wallet request ownership was lost");
    }
  }

  private finishOperation(
    operation: ActiveHostOperation,
    options: Readonly<{ restoreFocus: boolean }>
  ): void {
    this.hideOperationSurface(operation, options);
    this.releaseOperationOwnership(operation);
  }

  private hideOperationSurface(
    operation: ActiveHostOperation,
    options: Readonly<{ restoreFocus: boolean }>
  ): void {
    this.stopCancellationDrain(operation);
    if (this.activeOperation !== operation) return;
    try {
      this.surface?.hide({ restoreFocus: options.restoreFocus });
    } catch {
      // Cleanup/focus failures cannot replace the owned operation terminal.
    }
  }

  private releaseOperationOwnership(operation: ActiveHostOperation): void {
    if (this.activeOperation === operation) this.activeOperation = null;
    if (this.activeRequest === operation.protocol) this.activeRequest = null;
  }

  private abortInitializationForCancellation(error: IframeError): void {
    this.lifecycleGeneration += 1;
    const attempt = this.initializationAttempt;
    this.initializationAttempt = null;
    this.initializationHandoff = null;
    attempt?.reject(error);
    this.rejectLoad(error);
    this.rejectReady(error);
    this.cleanupIframe();
    if (!this.destroyed && this.state !== "destroyed") this.state = "idle";
  }

  private startCancellationDrain(operation: ActiveHostOperation): void {
    if (this.activeOperation !== operation || operation.phase !== "cancelling") return;
    const token = {};
    operation.cancellationTimeoutToken = token;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      timeout = this.scheduleTimeout(() => {
        if (
          this.activeOperation !== operation ||
          operation.phase !== "cancelling" ||
          operation.cancellationTimeoutToken !== token ||
          this.destroyed ||
          this.state === "destroyed"
        ) {
          return;
        }
        operation.cancellationTimeout = null;
        operation.cancellationTimeoutToken = null;
        this.resetRelayAfterCancellation(operation);
      }, CANCELLATION_DRAIN_TIMEOUT_MS);
    } catch {
      this.resetRelayAfterCancellation(operation);
      return;
    }
    if (
      this.activeOperation !== operation ||
      operation.phase !== "cancelling" ||
      operation.cancellationTimeoutToken !== token
    ) {
      this.cancelTimeoutBestEffort(timeout);
      return;
    }
    operation.cancellationTimeout = timeout;
  }

  private stopCancellationDrain(operation: ActiveHostOperation): void {
    const timeout = operation.cancellationTimeout;
    operation.cancellationTimeout = null;
    operation.cancellationTimeoutToken = null;
    this.cancelTimeoutBestEffort(timeout);
  }

  private completeCancellationDrain(operation: ActiveHostOperation): void {
    if (this.activeOperation !== operation || operation.phase !== "cancelling") return;
    this.stopCancellationDrain(operation);
    operation.phase = "terminal";
    if (!this.destroyed && this.state === "loading") {
      this.state = "idle";
    }
    this.finishOperation(operation, { restoreFocus: false });
  }

  private resetRelayAfterCancellation(operation: ActiveHostOperation): void {
    if (this.activeOperation !== operation || operation.phase !== "cancelling") return;
    this.lifecycleGeneration += 1;
    this.setAllowedSourceWindow(null);
    this.cleanupIframe();
    operation.phase = "terminal";
    this.finishOperation(operation, { restoreFocus: false });
    if (!this.destroyed && this.state !== "destroyed") this.state = "idle";
  }

  // ==========================================================================
  // Private: UI 제어
  // ==========================================================================

  /** Show modal (internal use only) */
  private show(): void {
    const surface = this.surface;
    if (!surface) throw new IframeError("NOT_INITIALIZED", "Host surface is unavailable");
    let initiator: Element | null = null;
    try {
      initiator = document.activeElement;
    } catch {
      // Focus capture is best-effort and must not block a wallet operation.
    }
    surface.show(initiator);
    if (
      this.destroyed ||
      this.state === "destroyed" ||
      this.surface !== surface ||
      this.iframe !== surface.iframe
    ) {
      throw new IframeError("DESTROYED", "IframeHost destroyed");
    }
  }

  /** Hide modal (internal use only) */
  private hide(): void {
    this.surface?.hide({ restoreFocus: true });
  }

  /** Clear the embedded account grant while retaining the reusable relay transport. */
  disconnect(): void {
    this.cancel();
    if (!this.destroyed && this.relayInitialized && this.allowedSource) {
      try {
        this.allowedSource.postMessage(
          { type: "DISCONNECT", id: generateMessageId(), payload: {}, timestamp: Date.now() },
          this.iframeOrigin
        );
      } catch {
        // A failed revocation cannot leave a live, reusable embedded account.
        this.destroy();
      }
    }
  }

  /** Destroy iframe */
  override destroy(): void {
    this.destroyHostOnce();
  }

  private destroyHostOnce(): void {
    if (this.destroyed || this.state === "destroyed") return;
    const relayTarget = this.allowedSource;
    const shouldNotifyRelay = this.relayInitialized && relayTarget !== null;
    const operation = this.activeOperation;
    this.lifecycleGeneration += 1;
    this.state = "destroyed";
    const error = toIframeError(new IframeError("DESTROYED", "IframeHost destroyed"));
    const deferDestroyedEvent = operation !== null;
    if (operation !== null && !operation.publicSettled) {
      if (!operation.terminalClaimed || operation.terminal === null) {
        operation.terminalClaimed = true;
        operation.phase = "terminal";
        operation.terminal = { status: "rejected", error };
      }
      const terminal = operation.terminal;
      if (terminal.status === "fulfilled") {
        operation.resolve(terminal.value);
      } else {
        const terminalError = toIframeError(terminal.error);
        operation.terminal = { status: "rejected", error: terminalError };
        this.emitErrorSafely(terminalError, operation.publicContext);
        operation.reject(terminalError);
      }
    }
    if (operation !== null) this.stopCancellationDrain(operation);
    if (this.activeOperation === operation) this.activeOperation = null;
    if (operation !== null && this.activeRequest === operation.protocol) this.activeRequest = null;
    const initializationAttempt = this.initializationAttempt;
    this.initializationAttempt = null;
    this.initializationHandoff = null;
    initializationAttempt?.reject(error);
    super.destroy();
    try {
      this.rejectLoad(error);
    } catch {
      // DOM cleanup failures cannot interrupt authoritative teardown.
    }
    try {
      this.rejectReady(error);
    } catch {
      // Timer cleanup failures cannot interrupt authoritative teardown.
    }

    if (shouldNotifyRelay) {
      try {
        relayTarget.postMessage(buildDestroy(generateMessageId(), Date.now()), this.iframeOrigin);
      } catch {
        // Local teardown remains authoritative when the relay cannot be reached.
      }
    }

    this.cleanupIframe();
    if (deferDestroyedEvent) {
      this.scheduleMicrotask(() =>
        this.scheduleMicrotask(() => this.scheduleMicrotask(() => this.emitDestroyedSafely()))
      );
    } else {
      this.emitDestroyedSafely();
    }
  }

  private emitDestroyedSafely(): void {
    if (this.destroyedEventEmitted) return;
    this.destroyedEventEmitted = true;
    let result: unknown;
    try {
      result = this.eventHandlers.destroyed?.();
    } catch {
      // Notification failures cannot interrupt authoritative local teardown.
      return;
    }
    this.drainReturnedThenable(result);
  }

  // ==========================================================================
  // Private 메서드
  // ==========================================================================

  private ownsIframeLifecycle(ownership: IframeLifecycleOwnership): boolean {
    return (
      this.lifecycleGeneration === ownership.generation &&
      !this.destroyed &&
      this.state !== "destroyed" &&
      this.surface === ownership.surface &&
      this.iframe === ownership.iframe
    );
  }

  private assertIframeLifecycle(ownership: IframeLifecycleOwnership): void {
    if (!this.ownsIframeLifecycle(ownership)) {
      throw new IframeError("DESTROYED", "IframeHost destroyed");
    }
  }

  private captureIframeOwnership(): IframeLifecycleOwnership {
    if (this.destroyed || this.state === "destroyed") {
      throw new IframeError("DESTROYED", "IframeHost destroyed");
    }
    const surface = this.surface;
    const iframe = this.iframe;
    if (!surface || !iframe) {
      throw new IframeError("NOT_INITIALIZED", "iframe not initialized");
    }
    return { generation: this.lifecycleGeneration, surface, iframe };
  }

  private readOwnedIframeWindow(ownership: IframeLifecycleOwnership): Window | null {
    this.assertIframeLifecycle(ownership);
    let target: Window | null;
    try {
      target = ownership.iframe.contentWindow;
    } catch (error) {
      this.assertIframeLifecycle(ownership);
      throw error;
    }
    this.assertIframeLifecycle(ownership);
    return target;
  }

  private readPinnedIframeWindow(ownership: IframeLifecycleOwnership): Window {
    const target = this.readOwnedIframeWindow(ownership);
    if (target === null || this.allowedSource === null || target !== this.allowedSource) {
      this.destroy();
      throw new IframeError("DESTROYED", "IframeHost destroyed");
    }
    return target;
  }

  private createIframe(): void {
    // The relay binds the parent from MessageEvent.source/origin, never URL parameters.
    const locale = this.config.locale ?? detectLocale();
    const baseUrl = this.config.iframeSrc.replace(/\/$/, ""); // Remove trailing slash
    const sandboxValue =
      this.config.sandbox ??
      "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox";
    const generation = this.lifecycleGeneration;
    const surface = createHostSurface({
      ...(this.config.container === undefined ? {} : { container: this.config.container }),
      iframeSrc: `${baseUrl}/${locale}`,
      sandbox: sandboxValue,
      onEscape: () => {
        this.cancel();
      },
      onDisconnect: () => this.destroyHostOnce(),
    });
    if (this.lifecycleGeneration !== generation || this.destroyed || this.state === "destroyed") {
      surface.destroy();
      throw new IframeError("DESTROYED", "IframeHost destroyed");
    }

    const iframe = surface.iframe;
    this.surface = surface;
    this.iframe = iframe;
    const ownership = { generation, surface, iframe };
    const source = this.readOwnedIframeWindow(ownership);
    if (source === null) {
      throw new IframeError("NOT_INITIALIZED", "iframe content window unavailable");
    }
    this.setAllowedSourceWindow(source);
  }

  private waitForIframeLoad(): Promise<void> {
    return new Promise((resolve, reject) => {
      const generation = this.lifecycleGeneration;
      const surface = this.surface;
      const iframe = this.iframe;
      if (!surface || !iframe) {
        reject(new IframeError("NOT_INITIALIZED", "iframe not created"));
        return;
      }
      const ownership = { generation, surface, iframe };
      const timeoutToken = {};

      let onloadAttempted = false;
      let onerrorAttempted = false;
      let settled = false;
      const releaseHandlers = () => {
        if (onloadAttempted) {
          try {
            iframe.onload = null;
          } catch {
            // Handler release is best-effort during setup rollback.
          }
        }
        if (onerrorAttempted) {
          try {
            iframe.onerror = null;
          } catch {
            // Handler release is best-effort during setup rollback.
          }
        }
      };

      const cleanup = (): boolean => {
        if (settled || this.loadTimeoutToken !== timeoutToken) return false;
        settled = true;
        const timeout = this.loadTimeout;
        this.loadTimeout = null;
        this.loadTimeoutToken = null;
        this.loadRejecter = null;
        this.cancelTimeoutBestEffort(timeout);
        releaseHandlers();
        return true;
      };

      const rejectLoad = (error: Error): boolean => {
        const claimed = cleanup();
        if (claimed) reject(error);
        return claimed;
      };
      this.loadTimeoutToken = timeoutToken;
      this.loadRejecter = rejectLoad;

      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        timeout = this.scheduleTimeout(() => {
          if (this.loadTimeoutToken !== timeoutToken) return;
          rejectLoad(new IframeError("TIMEOUT", "iframe load timeout"));
        }, 10000);
      } catch (error) {
        if (this.loadTimeoutToken === timeoutToken) {
          rejectLoad(
            this.ownsIframeLifecycle(ownership)
              ? errorOrFallback(error, "iframe load timer failed")
              : new IframeError("DESTROYED", "IframeHost destroyed")
          );
        }
        return;
      }
      if (this.loadTimeoutToken !== timeoutToken || !this.ownsIframeLifecycle(ownership)) {
        this.cancelTimeoutBestEffort(timeout);
        if (this.loadTimeoutToken === timeoutToken) {
          rejectLoad(new IframeError("DESTROYED", "IframeHost destroyed"));
        }
        return;
      }
      this.loadTimeout = timeout;

      const onload = () => {
        if (cleanup()) resolve();
      };
      const onerror = () => {
        rejectLoad(new IframeError("SIGN_FAILED", "iframe load failed"));
      };

      onloadAttempted = true;
      try {
        iframe.onload = onload;
      } catch (error) {
        if (!rejectLoad(errorOrFallback(error, "iframe load handler failed"))) {
          releaseHandlers();
        }
        return;
      }
      if (!this.ownsIframeLifecycle(ownership)) {
        if (!rejectLoad(new IframeError("DESTROYED", "IframeHost destroyed"))) {
          releaseHandlers();
        }
        return;
      }

      onerrorAttempted = true;
      try {
        iframe.onerror = onerror;
      } catch (error) {
        if (!rejectLoad(errorOrFallback(error, "iframe error handler failed"))) {
          releaseHandlers();
        }
        return;
      }
      if (!this.ownsIframeLifecycle(ownership)) {
        if (!rejectLoad(new IframeError("DESTROYED", "IframeHost destroyed"))) {
          releaseHandlers();
        }
      }
    });
  }

  private rejectLoad(error: Error): void {
    this.loadRejecter?.(error);
  }

  /** Wait for the exact relay acknowledgement. */
  private waitForWorkerReady(attempt: InitializationAttempt): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutMs = this.config.timeout ?? DEFAULT_INITIALIZATION_TIMEOUT_MS;
      const timeoutToken = {};
      let settled = false;
      const cleanup = (): boolean => {
        if (settled || this.readyTimeoutToken !== timeoutToken) return false;
        settled = true;
        const timeout = this.readyTimeout;
        this.readyTimeout = null;
        this.readyTimeoutToken = null;
        if (this.readyResolver === resolveReady) this.readyResolver = null;
        if (this.readyRejecter === rejectReady) this.readyRejecter = null;
        this.stopRelayInitializationRetry();
        this.cancelTimeoutBestEffort(timeout);
        return true;
      };
      const resolveReady = () => {
        if (cleanup()) resolve();
      };
      const rejectReady = (error: Error) => {
        if (cleanup()) reject(error);
      };
      this.readyTimeoutToken = timeoutToken;
      this.readyResolver = resolveReady;
      this.readyRejecter = rejectReady;

      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        timeout = this.scheduleTimeout(() => {
          if (this.readyTimeoutToken !== timeoutToken) return;
          rejectReady(new IframeError("TIMEOUT", "IframeWorker ready timeout"));
        }, timeoutMs);
      } catch (error) {
        if (this.readyTimeoutToken === timeoutToken) {
          rejectReady(
            this.ownsInitialization(attempt)
              ? errorOrFallback(error, "iframe ready timer failed")
              : new IframeError("DESTROYED", "IframeHost destroyed")
          );
        }
        return;
      }
      if (this.readyTimeoutToken !== timeoutToken || !this.ownsInitialization(attempt)) {
        this.cancelTimeoutBestEffort(timeout);
        if (this.readyTimeoutToken === timeoutToken) {
          rejectReady(new IframeError("DESTROYED", "IframeHost destroyed"));
        }
        return;
      }
      this.readyTimeout = timeout;
    });
  }

  private resolveReady(): void {
    this.readyResolver?.();
  }

  private rejectReady(error: Error): void {
    this.readyRejecter?.(error);
  }

  private stopRelayInitializationRetry(): void {
    const retry = this.relayInitializationRetry;
    this.relayInitializationRetry = null;
    this.relayInitializationRetryToken = null;
    this.cancelIntervalBestEffort(retry);
  }

  private sendRelayInitialization(): void {
    try {
      this.postToIframe(buildRelayInit());
    } catch (error) {
      this.rejectReady(errorOrFallback(error, "Relay init failed"));
    }
  }

  private startRelayInitialization(attempt: InitializationAttempt): void {
    if (this.readyResolver === null || !this.ownsInitialization(attempt)) return;
    this.relayInitializationSent = true;
    this.sendRelayInitialization();
    if (this.readyResolver === null || !this.ownsInitialization(attempt)) return;

    const retryToken = {};
    this.relayInitializationRetryToken = retryToken;
    let retry: ReturnType<typeof setInterval> | null = null;
    try {
      retry = this.scheduleInterval(() => {
        if (
          this.relayInitializationRetryToken !== retryToken ||
          this.readyResolver === null ||
          !this.ownsInitialization(attempt)
        ) {
          return;
        }
        this.sendRelayInitialization();
      }, RELAY_INITIALIZATION_RETRY_MS);
    } catch (error) {
      if (
        this.relayInitializationRetryToken !== retryToken ||
        this.readyResolver === null ||
        !this.ownsInitialization(attempt)
      ) {
        return;
      }
      this.relayInitializationRetryToken = null;
      throw error;
    }
    if (this.readyResolver === null || !this.ownsInitialization(attempt)) {
      if (this.relayInitializationRetryToken === retryToken) {
        this.relayInitializationRetryToken = null;
      }
      this.cancelIntervalBestEffort(retry);
      return;
    }
    this.relayInitializationRetry = retry;
  }

  private cleanupIframe(): void {
    const loadTimeout = this.loadTimeout;
    this.loadTimeout = null;
    this.loadTimeoutToken = null;
    this.loadRejecter = null;
    const readyTimeout = this.readyTimeout;
    this.readyTimeout = null;
    this.readyTimeoutToken = null;
    this.readyResolver = null;
    this.readyRejecter = null;
    const relayRetry = this.relayInitializationRetry;
    this.relayInitializationRetry = null;
    this.relayInitializationRetryToken = null;
    this.cancelTimeoutBestEffort(loadTimeout);
    this.cancelTimeoutBestEffort(readyTimeout);
    this.cancelIntervalBestEffort(relayRetry);
    if (this.iframe) {
      try {
        this.iframe.onload = null;
      } catch {
        // Handler release is best-effort during teardown.
      }
      try {
        this.iframe.onerror = null;
      } catch {
        // Handler release is best-effort during teardown.
      }
    }
    this.surface?.destroy();
    this.surface = null;
    this.iframe = null;
    this.setAllowedSourceWindow(null);
    this.stopListening();
    this.relayInitializationSent = false;
    this.relayInitialized = false;
  }

  private cancelTimeoutBestEffort(timeout: ReturnType<typeof setTimeout> | null): void {
    if (timeout === null) return;
    try {
      this.cancelTimeout(timeout);
    } catch {
      // Logical timer ownership is already released; stale callbacks are token-guarded.
    }
  }

  private cancelIntervalBestEffort(interval: ReturnType<typeof setInterval> | null): void {
    if (interval === null) return;
    try {
      this.cancelInterval(interval);
    } catch {
      // Logical retry ownership is already released; stale callbacks are token-guarded.
    }
  }

  protected override handleMessage(event: MessageEvent): void {
    const source = this.allowedSource;
    if (
      source === null ||
      event.source !== source ||
      event.origin !== this.iframeOrigin ||
      this.destroyed ||
      this.state === "destroyed"
    ) {
      return;
    }
    if (parseRelayReady(event.data)) {
      if (this.relayInitializationSent) this.resolveReady();
      return;
    }
    this.handleRelayProtocolMessage(event.data);
  }

  private handleRelayProtocolMessage(value: unknown): void {
    const operation = this.activeOperation;
    const active = this.activeRequest;
    if (!operation || !active || operation.protocol !== active) return;

    if (parseRelayOnboarding(value, active)) {
      if (!operation.terminalClaimed && this.requestManager.extendTimeout(active.id, 300_000)) {
        try {
          this.show();
        } catch (cause) {
          void cause;
          const error =
            this.destroyed || this.state === "destroyed"
              ? new IframeError("DESTROYED", "IframeHost destroyed")
              : new IframeError("SIGN_FAILED", "Failed to show wallet request");
          this.requestManager.claimAndReject(active.id, operation.requestOwnership, error, () => {
            operation.terminalClaimed = true;
            operation.phase = "terminal";
            operation.terminal = { status: "rejected", error };
          });
        }
      }
      return;
    }

    const terminal = parseTerminal(value, active);
    if (!terminal) return;
    if (operation.phase === "cancelling") {
      if (terminal.type === "ERROR" && terminal.error.code === "USER_CANCELLED") {
        this.completeCancellationDrain(operation);
      }
      return;
    }
    if (operation.terminalClaimed) return;

    if (terminal.type === "ERROR") {
      const error = new IframeError(terminal.error.code, terminal.error.message);
      this.requestManager.claimAndReject(active.id, operation.requestOwnership, error, () => {
        operation.terminalClaimed = true;
        operation.phase = "terminal";
        operation.terminal = { status: "rejected", error };
      });
      return;
    }
    this.requestManager.claimAndResolve(
      active.id,
      operation.requestOwnership,
      terminal.result,
      () => {
        operation.terminalClaimed = true;
        operation.phase = "terminal";
        operation.terminal = { status: "fulfilled", value: terminal.result };
      }
    );
  }

  private postToIframe(
    message: unknown,
    canDeliver: (() => boolean) | null = null,
    onDeliver: (() => void) | null = null
  ): boolean {
    if (canDeliver !== null && !canDeliver()) return false;
    const ownership = this.captureIframeOwnership();
    const target = this.readPinnedIframeWindow(ownership);
    if (canDeliver !== null && !canDeliver()) return false;

    let postMessage: typeof target.postMessage;
    try {
      postMessage = target.postMessage.bind(target);
    } catch (error) {
      this.assertIframeLifecycle(ownership);
      throw error;
    }
    this.assertIframeLifecycle(ownership);
    if (canDeliver !== null && !canDeliver()) return false;
    onDeliver?.();
    postMessage(message, this.iframeOrigin);
    this.assertIframeLifecycle(ownership);
    return true;
  }

  private assertReady(): void {
    if (this.state !== "ready") {
      throw new IframeError("NOT_INITIALIZED", `IframeHost is not ready (state: ${this.state})`);
    }
  }

  private beginInitialization(): InitializationAttempt {
    const attempt = createInitializationAttempt(this.lifecycleGeneration);
    this.initializationAttempt = attempt;
    this.initializationHandoff = attempt.handoff;
    this.state = "loading";
    void this.runInitialization(attempt);
    return attempt;
  }

  private ownsInitialization(attempt: InitializationAttempt): boolean {
    return (
      this.initializationAttempt === attempt &&
      this.lifecycleGeneration === attempt.generation &&
      !this.destroyed &&
      this.state !== "destroyed"
    );
  }

  private assertInitializationOwnership(attempt: InitializationAttempt): void {
    if (!this.ownsInitialization(attempt) || this.surface === null || this.iframe === null) {
      throw new IframeError("DESTROYED", "IframeHost destroyed");
    }
  }

  private ownsInitializationHandoff(handoff: InitializationHandoff): boolean {
    return (
      this.initializationHandoff === handoff &&
      this.lifecycleGeneration === handoff.generation &&
      !this.destroyed &&
      this.state !== "destroyed"
    );
  }

  private releaseInitializationHandoff(handoff: InitializationHandoff | null): void {
    if (handoff !== null && this.initializationHandoff === handoff) {
      this.initializationHandoff = null;
    }
  }

  private async runInitialization(attempt: InitializationAttempt): Promise<void> {
    let committed = false;
    try {
      this.createIframe();
      this.startListening();
      this.assertInitializationOwnership(attempt);
      committed = true;

      await this.waitForIframeLoad();
      this.assertInitializationOwnership(attempt);
      const ready = this.waitForWorkerReady(attempt);
      this.startRelayInitialization(attempt);
      await ready;
      this.assertInitializationOwnership(attempt);

      this.relayInitialized = true;
      this.initializationAttempt = null;
      attempt.resolve();
    } catch (error) {
      this.failInitialization(attempt, error, committed);
    }
  }

  private failInitialization(
    attempt: InitializationAttempt,
    error: unknown,
    committed: boolean
  ): void {
    if (!this.ownsInitialization(attempt)) {
      attempt.reject(
        this.destroyed || this.state === "destroyed"
          ? new IframeError("DESTROYED", "IframeHost destroyed")
          : error
      );
      return;
    }

    this.cleanupIframe();
    if (!this.ownsInitialization(attempt)) {
      attempt.reject(new IframeError("DESTROYED", "IframeHost destroyed"));
      return;
    }

    this.state = committed ? "error" : "idle";
    this.initializationAttempt = null;
    this.releaseInitializationHandoff(attempt.handoff);
    attempt.reject(
      isContainerDisconnectedError(error)
        ? new IframeError("NOT_INITIALIZED", "Host surface container is disconnected")
        : error
    );
  }

  /** Ensure iframe is ready, create if needed */
  private async ensureIframeReady(): Promise<InitializationHandoff | null> {
    if (this.destroyed || this.state === "destroyed") {
      throw new IframeError("DESTROYED", "IframeHost destroyed");
    }
    if (this.state === "error") this.state = "idle";
    if (this.state !== "loading" && this.state !== "idle" && this.state !== "ready") {
      throw new IframeError("NOT_INITIALIZED", `IframeHost is not ready (state: ${this.state})`);
    }

    let attempt = this.initializationAttempt;
    const startsInitialization = !this.iframe && attempt === null;
    if (!this.iframe && attempt === null) {
      if (this.initializationHandoff !== null) {
        throw new IframeError("SIGN_FAILED", "Another wallet request is already active");
      }
      attempt = this.beginInitialization();
    }
    if (!this.relayInitialized && attempt !== null) {
      await attempt.promise;
      if (this.destroyed || this.currentState === "destroyed") {
        throw new IframeError("DESTROYED", "IframeHost destroyed");
      }
      if (!startsInitialization) {
        throw new IframeError("SIGN_FAILED", "Another wallet request is already active");
      }
      if (!this.ownsInitializationHandoff(attempt.handoff)) {
        throw new IframeError("SIGN_FAILED", "Another wallet request is already active");
      }
      return attempt.handoff;
    }
    if (this.destroyed || this.currentState === "destroyed") {
      throw new IframeError("DESTROYED", "IframeHost destroyed");
    }
    if (this.initializationHandoff !== null) {
      throw new IframeError("SIGN_FAILED", "Another wallet request is already active");
    }
    return null;
  }
}

/**
 * IframeHost - dApp wallet connection
 *
 * SignerType-based wallet connection and signing management
 *
 * @example
 * ```typescript
 * import { IframeHost } from "@ohmywallet/connect";
 *
 * const wallet = new IframeHost({
 *   iframeSrc: "https://vault.ohmywallet.xyz",
 * });
 *
 * // Connect with PasskeySigner
 * const passkey = await wallet.connectWithSignerType({ signerType: "passkey" });
 * const sig = await wallet.signWithPasskey(challenge, { keyId: passkey.passkeys[0].keyId });
 *
 * // Connect with DerivationSigner
 * const derived = await wallet.connectWithSignerType({ signerType: "derivation" });
 * const sig = await wallet.signWithDerivation(txHash, { address: derived.addresses[0].address });
 * ```
 */

import type { Hash } from "viem";
import { isAddress, isHex } from "viem";
import type {
  IframeHostConfig,
  IframeMessage,
  SupportedLocale,
  // 새 API 타입
  ConnectOptions,
  ConnectResult,
  PasskeyConnectOptions,
  PasskeyConnectResult,
  DerivationConnectOptions,
  DerivationConnectResult,
  PasskeySignOptions,
  PasskeySignResult,
  DerivationSignOptions,
  DerivationSignResult,
  ConnectPayload,
  PasskeySignPayload,
  DerivationSignPayload,
  DeriveAddressOptions,
  DeriveAddressResult,
  DeriveAddressPayload,
} from "./types";
import { IframeError } from "./types";
import { IframeChannelBase, createMessage } from "./channel";

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
export class IframeHost extends IframeChannelBase {
  private config: IframeHostConfig;
  private iframeOrigin: string;
  private iframe: HTMLIFrameElement | null = null;
  private overlay: HTMLDivElement | null = null;
  private state: IframeHostState = "idle";
  private eventHandlers: Partial<IframeHostEvents> = {};
  private readyResolver: (() => void) | null = null;

  constructor(config: IframeHostConfig) {
    const origin = new URL(config.iframeSrc).origin;
    super(origin, config.timeout ?? 30000);
    this.config = config;
    this.iframeOrigin = origin;
    this.setupHandlers();
  }

  /** Current state */
  get currentState(): IframeHostState {
    return this.state;
  }

  /** Register event handler */
  onEvent<K extends keyof IframeHostEvents>(event: K, handler: IframeHostEvents[K]): void {
    this.eventHandlers[event] = handler;
  }

  // ==========================================================================
  // SignerType 기반 API
  // ==========================================================================

  /**
   * Connect with SignerType
   *
   * @example
   * ```typescript
   * // Connect with PasskeySigner
   * const result = await wallet.connectWithSignerType({ signerType: "passkey" });
   * // → { signerType: "passkey", passkeys: [...], activePasskey: {...} }
   *
   * // Connect with DerivationSigner
   * const result = await wallet.connectWithSignerType({ signerType: "derivation" });
   * // → { signerType: "derivation", addresses: [...], activeAddress: {...} }
   * ```
   */
  async connectWithSignerType(options: PasskeyConnectOptions): Promise<PasskeyConnectResult>;
  async connectWithSignerType(options: DerivationConnectOptions): Promise<DerivationConnectResult>;
  async connectWithSignerType(options: ConnectOptions): Promise<ConnectResult> {
    await this.ensureIframeReady();

    // Build payload based on signerType
    const payload: ConnectPayload =
      options.signerType === "passkey"
        ? {
            signerType: "passkey",
            dappName: options.dappName,
            dappIcon: options.dappIcon,
          }
        : {
            signerType: "derivation",
            // derivation is a universal wallet, no dApp info needed
          };

    const message = createMessage("CONNECT", payload);
    this.postToIframe(message);

    const result = await this.requestManager.register<ConnectResult>(message.id);
    this.state = "ready";

    return result;
  }

  /**
   * Sign with PasskeySigner
   *
   * @param hash Hash to sign
   * @param options Signing options including keyId
   * @returns P-256 signature result (r, s, authenticatorData, clientDataJSON)
   *
   * @example
   * ```typescript
   * const sig = await wallet.signWithPasskey(challenge, {
   *   keyId: passkey.keyId,
   * });
   * // → { signerType: "passkey", keyId, signature: { r, s }, authenticatorData, clientDataJSON }
   * ```
   */
  async signWithPasskey(hash: Hash, options: PasskeySignOptions): Promise<PasskeySignResult> {
    this.assertReady();

    // Input validation
    if (!isHex(hash)) {
      throw new IframeError("VALIDATION_FAILED", "hash must be in Hex format");
    }
    if (!isHex(options.keyId)) {
      throw new IframeError("VALIDATION_FAILED", "keyId must be in Hex format");
    }

    // WebAuthn requires iframe to be visible, show during signing
    this.show();

    const payload: PasskeySignPayload = {
      hash,
      keyId: options.keyId,
      requireConfirmation: options.requireConfirmation,
      transactionInfo: options.transactionInfo,
    };

    const message = createMessage("SIGN_WITH_PASSKEY", payload);
    this.postToIframe(message);

    try {
      const result = await this.requestManager.register<PasskeySignResult>(message.id);
      this.hide();
      return result;
    } catch (error) {
      this.hide();
      throw error;
    }
  }

  /**
   * Derive address (DerivationSigner only)
   *
   * @param options Derivation options (keyIndex, curve, group, etc.)
   * @returns Derived address information
   *
   * @example
   * ```typescript
   * const { address } = await wallet.deriveAddress({
   *   keyIndex: 0,
   *   group: "evm",
   * });
   * // → { address: { address: "0x...", keyIndex: 0, curve: "secp256k1", group: "evm" } }
   * ```
   */
  async deriveAddress(options: DeriveAddressOptions): Promise<DeriveAddressResult> {
    this.assertReady();

    const payload: DeriveAddressPayload = {
      keyIndex: options.keyIndex,
      curve: options.curve ?? "secp256k1",
      group: options.group ?? "evm",
      bitcoinAddressType: options.bitcoinAddressType,
      bitcoinNetwork: options.bitcoinNetwork,
    };

    const message = createMessage("DERIVE_ADDRESS", payload);
    this.postToIframe(message);

    return await this.requestManager.register<DeriveAddressResult>(message.id);
  }

  /**
   * Sign with DerivationSigner
   *
   * @param hash Hash to sign
   * @param options Signing options including address or (group + keyIndex)
   * @returns Signature in chain-specific format
   *
   * @example
   * ```typescript
   * // Method 1: Sign with address
   * const sig = await wallet.signWithDerivation(txHash, {
   *   address: "0x1234...abcd",
   * });
   *
   * // Method 2: Sign with group + keyIndex
   * const sig = await wallet.signWithDerivation(txHash, {
   *   group: "evm",
   *   keyIndex: 0,
   * });
   * ```
   */
  async signWithDerivation(
    hash: Hash,
    options: DerivationSignOptions
  ): Promise<DerivationSignResult> {
    this.assertReady();

    // Input validation: hash
    if (!isHex(hash)) {
      throw new IframeError("VALIDATION_FAILED", "hash must be in Hex format");
    }

    // XOR validation: either address or (group + keyIndex)
    const hasAddress = !!options.address;
    const hasGroupKey = !!(options.group && options.keyIndex !== undefined);

    if (hasAddress === hasGroupKey) {
      throw new IframeError(
        "VALIDATION_FAILED",
        "Provide either address or (group + keyIndex), not both"
      );
    }

    // Input validation: address format (EVM addresses only)
    if (options.address && options.address.startsWith("0x") && !isAddress(options.address)) {
      throw new IframeError("VALIDATION_FAILED", "Invalid EVM address format");
    }

    // Input validation: keyIndex range
    if (options.keyIndex !== undefined && (options.keyIndex < 0 || options.keyIndex > 2147483647)) {
      throw new IframeError("VALIDATION_FAILED", "keyIndex must be between 0 and 2147483647");
    }

    // Show transaction confirmation modal when requireConfirmation=true
    if (options.requireConfirmation) {
      this.show();
    }

    const payload: DerivationSignPayload = {
      hash,
      address: options.address,
      group: options.group,
      keyIndex: options.keyIndex,
      requireConfirmation: options.requireConfirmation,
      transactionInfo: options.transactionInfo,
    };

    const message = createMessage("SIGN_WITH_DERIVATION", payload);
    this.postToIframe(message);

    try {
      const result = await this.requestManager.register<DerivationSignResult>(message.id);
      if (options.requireConfirmation) {
        this.hide();
      }
      return result;
    } catch (error) {
      if (options.requireConfirmation) {
        this.hide();
      }
      throw error;
    }
  }

  // ==========================================================================
  // Private: UI 제어
  // ==========================================================================

  /** Show modal (internal use only) */
  private show(): void {
    if (this.overlay) {
      this.overlay.style.opacity = "1";
      this.overlay.style.pointerEvents = "auto";

      // Ensure iframe focus on iOS Safari
      if (this.iframe?.contentWindow) {
        this.iframe.contentWindow.focus();
      }
    }
  }

  /** Hide modal (internal use only) */
  private hide(): void {
    if (this.overlay) {
      this.overlay.style.opacity = "0";
      this.overlay.style.pointerEvents = "none";
    }
  }

  /** Destroy iframe */
  override destroy(): void {
    if (this.destroyed) return;

    if (this.state === "ready" && this.iframe?.contentWindow) {
      try {
        const message = createMessage("DESTROY", { reason: "Host destroyed" });
        this.postToIframe(message);
      } catch {
        // Ignore
      }
    }

    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
    if (this.iframe) {
      this.iframe = null;
    }

    this.state = "destroyed";

    this.eventHandlers.destroyed?.();

    super.destroy();
  }

  // ==========================================================================
  // Private 메서드
  // ==========================================================================

  private setupHandlers(): void {
    // READY handler - called when iframe worker is ready
    this.on("READY", () => {
      if (this.readyResolver) {
        this.readyResolver();
        this.readyResolver = null;
      }
    });

    // New API response handlers
    this.on("CONNECT_RESULT", (message) => {
      const payload = message.payload as { requestId: string; data: ConnectResult };
      this.requestManager.resolve(payload.requestId, payload.data);
      // Hide overlay after connection completes
      this.hide();
    });

    // Needs onboarding - show overlay
    this.on("NEEDS_ONBOARDING", () => {
      // Show overlay to display onboarding UI
      // Wait until CONNECT_RESULT arrives (Promise is still pending)
      this.show();
    });

    this.on("SIGN_RESULT", (message) => {
      const payload = message.payload as {
        requestId: string;
        data: PasskeySignResult | DerivationSignResult;
      };
      this.requestManager.resolve(payload.requestId, payload.data);
    });

    // Add DERIVE_ADDRESS_RESULT handler
    this.on("DERIVE_ADDRESS_RESULT", (message) => {
      const payload = message.payload as {
        requestId: string;
        data: DeriveAddressResult;
      };
      this.requestManager.resolve(payload.requestId, payload.data);
    });
  }

  private createIframe(): void {
    const overlay = document.createElement("div");
    overlay.id = "ohmywallet-overlay";
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 99999;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease;
    `;

    const iframeContainer = document.createElement("div");
    iframeContainer.style.cssText = `
      width: 100%;
      max-width: 420px;
      height: 90%;
      max-height: 700px;
      background: transparent;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: none;
      position: relative;
    `;

    const iframe = document.createElement("iframe");

    // Include locale in URL path and add origin parameter
    const locale = this.config.locale ?? detectLocale();
    const baseUrl = this.config.iframeSrc.replace(/\/$/, ""); // Remove trailing slash
    const dappOrigin = this.config.origin ?? window.location.origin;
    const params = new URLSearchParams();
    params.set("origin", dappOrigin);
    iframe.src = `${baseUrl}/${locale}?${params.toString()}`;

    // Set referrerpolicy - ensure referrer is sent on iOS Safari
    iframe.referrerPolicy = "origin";

    iframe.style.cssText = `
      width: 100%;
      height: 100%;
      border: none;
    `;

    // Delegate WebAuthn permissions
    iframe.allow = "publickey-credentials-get *; publickey-credentials-create *";

    // Apply sandbox (allow-popups: needed for local dev environment)
    const sandboxValue =
      this.config.sandbox ?? "allow-scripts allow-forms allow-same-origin allow-popups";
    iframe.setAttribute("sandbox", sandboxValue);

    // Close button removed (transaction modal already has a close button to avoid duplication)
    // Can be closed with ESC key or modal's internal button if needed

    iframeContainer.appendChild(iframe);
    overlay.appendChild(iframeContainer);

    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.iframe = iframe;
    this.setAllowedSourceWindow(iframe.contentWindow);
  }

  private waitForIframeLoad(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.iframe) {
        reject(new IframeError("NOT_INITIALIZED", "iframe not created"));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new IframeError("TIMEOUT", "iframe load timeout"));
      }, 10000);

      this.iframe.onload = () => {
        clearTimeout(timeout);
        resolve();
      };

      this.iframe.onerror = () => {
        clearTimeout(timeout);
        reject(new IframeError("SIGN_FAILED", "iframe load failed"));
      };
    });
  }

  /** Wait for IframeWorker to send READY message */
  private waitForWorkerReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.readyResolver = null;
        reject(new IframeError("TIMEOUT", "IframeWorker ready timeout"));
      }, 10000);

      this.readyResolver = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
  }

  private postToIframe(message: IframeMessage): void {
    if (!this.iframe?.contentWindow) {
      throw new IframeError("NOT_INITIALIZED", "iframe not initialized");
    }

    this.iframe.contentWindow.postMessage(message, this.iframeOrigin);
  }

  private assertReady(): void {
    if (this.state !== "ready") {
      throw new IframeError("NOT_INITIALIZED", `IframeHost is not ready (state: ${this.state})`);
    }
  }

  /** Ensure iframe is ready, create if needed */
  private async ensureIframeReady(): Promise<void> {
    if (this.state !== "loading" && this.state !== "idle" && this.state !== "ready") {
      throw new IframeError("NOT_INITIALIZED", `IframeHost is not ready (state: ${this.state})`);
    }

    if (!this.iframe) {
      this.state = "loading";
      this.createIframe();
      this.startListening();
      await this.waitForIframeLoad();
      // IframeWorker가 READY를 보낼 때까지 대기
      await this.waitForWorkerReady();
    }
  }
}

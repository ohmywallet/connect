/**
 * IframeHost - dApp 측 지갑 연결
 *
 * SignerType 기반 지갑 연결 및 서명 관리
 *
 * @example
 * ```typescript
 * import { IframeHost } from "@ohmywallet/connect";
 *
 * const wallet = new IframeHost({
 *   iframeSrc: "https://vault.ohmywallet.xyz",
 * });
 *
 * // PasskeySigner 연결
 * const passkey = await wallet.connectWithSignerType({ signerType: "passkey" });
 * const sig = await wallet.signWithPasskey(challenge, { keyId: passkey.passkeys[0].keyId });
 *
 * // DerivationSigner 연결
 * const derived = await wallet.connectWithSignerType({ signerType: "derivation" });
 * const sig = await wallet.signWithDerivation(txHash, { address: derived.addresses[0].address });
 * ```
 */

import type { Hash } from "viem";
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
  DeriveAddressPayload,
  DeriveAddressResult,
} from "./types";
import { IframeError } from "./types";
import { IframeChannelBase, createMessage } from "./channel";

/** 브라우저 언어를 SupportedLocale로 변환 */
function detectLocale(): SupportedLocale {
  if (typeof navigator === "undefined") return "ko";

  const browserLang = navigator.language.toLowerCase();
  if (browserLang.startsWith("en")) return "en";
  if (browserLang.startsWith("zh")) return "zh";
  if (browserLang.startsWith("ko")) return "ko";

  return "ko"; // 기본값
}

/** IframeHost 상태 */
export type IframeHostState = "idle" | "loading" | "ready" | "error" | "destroyed";

/** IframeHost 이벤트 */
export interface IframeHostEvents {
  error: (error: IframeError) => void;
  destroyed: () => void;
}

/**
 * IframeHost
 *
 * dApp에서 OhMyWallet iframe을 통해 지갑 기능을 사용합니다.
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

  /** 현재 상태 */
  get currentState(): IframeHostState {
    return this.state;
  }

  /** 이벤트 핸들러 등록 */
  onEvent<K extends keyof IframeHostEvents>(event: K, handler: IframeHostEvents[K]): void {
    this.eventHandlers[event] = handler;
  }

  // ==========================================================================
  // SignerType 기반 API
  // ==========================================================================

  /**
   * SignerType 기반 연결
   *
   * @example
   * ```typescript
   * // PasskeySigner 연결
   * const result = await wallet.connectWithSignerType({ signerType: "passkey" });
   * // → { signerType: "passkey", passkeys: [...], activePasskey: {...} }
   *
   * // DerivationSigner 연결
   * const result = await wallet.connectWithSignerType({ signerType: "derivation" });
   * // → { signerType: "derivation", addresses: [...], activeAddress: {...} }
   * ```
   */
  async connectWithSignerType(options: PasskeyConnectOptions): Promise<PasskeyConnectResult>;
  async connectWithSignerType(options: DerivationConnectOptions): Promise<DerivationConnectResult>;
  async connectWithSignerType(options: ConnectOptions): Promise<ConnectResult> {
    await this.ensureIframeReady();

    const payload: ConnectPayload = {
      signerType: options.signerType,
      dappName: options.dappName,
      dappIcon: options.dappIcon,
    };

    const message = createMessage("CONNECT", payload);
    this.postToIframe(message);

    const result = await this.requestManager.register<ConnectResult>(message.id);
    this.state = "ready";

    return result;
  }

  /**
   * PasskeySigner로 서명
   *
   * @param hash 서명할 해시
   * @param options keyId를 포함한 서명 옵션
   * @returns P-256 서명 결과 (r, s, authenticatorData, clientDataJSON)
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

    // WebAuthn은 iframe이 보여야 동작하므로 서명 시 표시
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
   * DerivationSigner로 서명
   *
   * @param hash 서명할 해시
   * @param options address를 포함한 서명 옵션
   * @returns 체인에 맞는 서명 포맷
   *
   * @example
   * ```typescript
   * const sig = await wallet.signWithDerivation(txHash, {
   *   address: "0x1234...abcd",
   * });
   * // → { signerType: "derivation", address, signature: "0x..." }
   * ```
   */
  async signWithDerivation(
    hash: Hash,
    options: DerivationSignOptions
  ): Promise<DerivationSignResult> {
    this.assertReady();

    // requireConfirmation=true일 때는 트랜잭션 확인 모달 표시
    if (options.requireConfirmation) {
      this.show();
    }

    const payload: DerivationSignPayload = {
      hash,
      address: options.address,
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

  /**
   * 새 파생 주소 생성
   *
   * @param keyIndex 파생할 키 인덱스
   * @param options 파생 옵션 (curve, group)
   * @returns 파생 결과
   *
   * @example
   * ```typescript
   * const result = await wallet.deriveAddress(1);
   * if (result.success && result.address) {
   *   console.log("새 주소:", result.address.address);
   * }
   * ```
   */
  async deriveAddress(
    keyIndex: number,
    options?: {
      curve?: "secp256k1" | "ed25519";
      group?: "evm" | "solana" | "bitcoin";
      bitcoinAddressType?: "p2wpkh" | "p2tr";
      bitcoinNetwork?: "mainnet" | "testnet4";
    }
  ): Promise<DeriveAddressResult> {
    this.assertReady();

    const payload: DeriveAddressPayload = {
      keyIndex,
      curve: options?.curve ?? "secp256k1",
      group: options?.group ?? "evm",
      bitcoinAddressType: options?.bitcoinAddressType,
      bitcoinNetwork: options?.bitcoinNetwork,
    };

    const message = createMessage("DERIVE_ADDRESS", payload);
    this.postToIframe(message);

    return this.requestManager.register<DeriveAddressResult>(message.id);
  }

  // ==========================================================================
  // UI 제어
  // ==========================================================================

  /** 모달 표시 */
  show(): void {
    if (this.overlay) {
      this.overlay.style.display = "flex";
    }
  }

  /** 모달 숨기기 */
  hide(): void {
    if (this.overlay) {
      this.overlay.style.display = "none";
    }
  }

  /** iframe 종료 */
  override destroy(): void {
    if (this.destroyed) return;

    if (this.state === "ready" && this.iframe?.contentWindow) {
      try {
        const message = createMessage("DESTROY", { reason: "호스트 종료" });
        this.postToIframe(message);
      } catch {
        // 무시
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
    // READY 핸들러 - iframe 워커가 준비되면 호출
    this.on("READY", () => {
      if (this.readyResolver) {
        this.readyResolver();
        this.readyResolver = null;
      }
    });

    // 새 API 응답 핸들러
    this.on("CONNECT_RESULT", (message) => {
      const payload = message.payload as { requestId: string; data: ConnectResult };
      this.requestManager.resolve(payload.requestId, payload.data);
      // 연결 완료 후 overlay 숨김
      this.hide();
    });

    // 온보딩 필요 - overlay 표시
    this.on("NEEDS_ONBOARDING", () => {
      // 온보딩 UI를 표시하기 위해 overlay를 보여줌
      // CONNECT_RESULT가 올 때까지 대기 (Promise는 아직 pending)
      this.show();
    });

    this.on("SIGN_RESULT", (message) => {
      const payload = message.payload as {
        requestId: string;
        data: PasskeySignResult | DerivationSignResult;
      };
      this.requestManager.resolve(payload.requestId, payload.data);
    });

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
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 99999;
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

    // locale을 URL 경로에 포함하고, origin 파라미터 추가
    const locale = this.config.locale ?? detectLocale();
    const baseUrl = this.config.iframeSrc.replace(/\/$/, ""); // 끝의 / 제거
    const dappOrigin = this.config.origin ?? window.location.origin;
    const params = new URLSearchParams();
    params.set("origin", dappOrigin);
    iframe.src = `${baseUrl}/${locale}?${params.toString()}`;

    // referrerpolicy 설정 - iOS Safari에서 referrer 전달 보장
    iframe.referrerPolicy = "origin";

    iframe.style.cssText = `
      width: 100%;
      height: 100%;
      border: none;
    `;

    // WebAuthn 권한 위임
    iframe.allow = "publickey-credentials-get *; publickey-credentials-create *";

    // sandbox 적용 (allow-popups: 로컬 개발 환경에서 필요)
    const sandboxValue =
      this.config.sandbox ?? "allow-scripts allow-forms allow-same-origin allow-popups";
    iframe.setAttribute("sandbox", sandboxValue);

    // 닫기 버튼 제거 (트랜잭션 모달에 이미 닫기 버튼이 있어 중복 방지)
    // 필요시 ESC 키나 모달 내부 버튼으로 닫기 가능

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
        reject(new IframeError("NOT_INITIALIZED", "iframe이 생성되지 않았습니다"));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new IframeError("TIMEOUT", "iframe 로드 타임아웃"));
      }, 10000);

      this.iframe.onload = () => {
        clearTimeout(timeout);
        resolve();
      };

      this.iframe.onerror = () => {
        clearTimeout(timeout);
        reject(new IframeError("SIGN_FAILED", "iframe 로드 실패"));
      };
    });
  }

  /** IframeWorker가 READY 메시지를 보낼 때까지 대기 */
  private waitForWorkerReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.readyResolver = null;
        reject(new IframeError("TIMEOUT", "IframeWorker 준비 타임아웃"));
      }, 10000);

      this.readyResolver = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
  }

  private postToIframe(message: IframeMessage): void {
    if (!this.iframe?.contentWindow) {
      throw new IframeError("NOT_INITIALIZED", "iframe이 초기화되지 않았습니다");
    }

    this.iframe.contentWindow.postMessage(message, this.iframeOrigin);
  }

  private assertReady(): void {
    if (this.state !== "ready") {
      throw new IframeError(
        "NOT_INITIALIZED",
        `IframeHost가 준비되지 않았습니다 (상태: ${this.state})`
      );
    }
  }

  /** iframe이 준비되었는지 확인하고 필요시 생성 */
  private async ensureIframeReady(): Promise<void> {
    if (this.state !== "loading" && this.state !== "idle" && this.state !== "ready") {
      throw new IframeError(
        "NOT_INITIALIZED",
        `IframeHost가 준비되지 않았습니다 (상태: ${this.state})`
      );
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

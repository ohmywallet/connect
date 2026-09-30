/**
 * @ohmywallet/connect
 *
 * Derivation-only signer integration for dApps. The public surface exposes
 * structured EVM signing, raw Solana signing, and address derivation without
 * exposing relay protocol details or signing secrets.
 */

import { DEFAULT_IFRAME_SRC, IframeHost as RuntimeIframeHost } from "./host";
import type {
  DerivationConnectOptions,
  DerivationConnectResult,
  DerivationSignResult,
  DeriveAddressOptions,
  DeriveAddressSuccess,
  EvmSignOptions,
  EvmSigningRequest,
  IframeHost as PublicIframeHost,
  IframeHostConfig,
  IframeHostEvents,
  IframeHostState,
  PrimaryConnectResult,
  PrimarySignResult,
  SolanaRawSigningRequest,
  SolanaSignOptions,
} from "./types";

export { DEFAULT_IFRAME_SRC };

/** Derivation-only host with an exact, declaration-safe public surface. */
export class IframeHost {
  readonly #runtime: PublicIframeHost;

  constructor(config: IframeHostConfig = {}) {
    this.#runtime = new RuntimeIframeHost(config);
  }

  get currentState(): IframeHostState {
    return this.#runtime.currentState;
  }

  connect(): Promise<PrimaryConnectResult> {
    return this.#runtime.connect();
  }

  deriveAddress(options: DeriveAddressOptions): Promise<DeriveAddressSuccess> {
    return this.#runtime.deriveAddress(options);
  }

  sign(request: EvmSigningRequest, options: EvmSignOptions): Promise<PrimarySignResult>;
  sign(request: SolanaRawSigningRequest, options: SolanaSignOptions): Promise<PrimarySignResult>;
  sign(
    request: EvmSigningRequest | SolanaRawSigningRequest,
    options: EvmSignOptions | SolanaSignOptions
  ): Promise<PrimarySignResult> {
    return Reflect.apply(this.#runtime.sign, this.#runtime, [request, options]);
  }

  cancel(): boolean {
    return this.#runtime.cancel();
  }

  destroy(): void {
    this.#runtime.destroy();
  }

  onEvent<K extends keyof IframeHostEvents>(event: K, handler: IframeHostEvents[K]): () => void {
    return this.#runtime.onEvent(event, handler);
  }

  /** @deprecated Use `connect()` instead. This alias will be removed in 0.8. */
  connectWithSignerType(options: DerivationConnectOptions): Promise<DerivationConnectResult> {
    return this.#runtime.connectWithSignerType(options);
  }

  /** @deprecated Use `sign()` instead. This alias will be removed in 0.8. */
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
    options: EvmSignOptions | SolanaSignOptions
  ): Promise<DerivationSignResult> {
    return Reflect.apply(this.#runtime.signWithDerivation, this.#runtime, [request, options]);
  }
}

export type {
  IframeHostState,
  IframeHostEvents,
  DerivationCurve,
  DerivationGroup,
  BitcoinAddressType,
  BitcoinNetwork,
  SigningContext,
  SigningMessage,
  SigningTypedData,
  EvmSigningRequest,
  EvmSignOptions,
  SolanaRawSigningRequest,
  SolanaSignOptions,
  DerivationAddressInfo,
  DeriveAddressOptions,
  DeriveAddressSuccess,
  PrimaryConnectResult as ConnectResult,
  PrimarySignResult as SignResult,
  DerivationConnectOptions,
  DerivationConnectResult,
  DerivationSignOptions,
  DerivationSignResult,
  IframeHostConfig,
  SupportedLocale,
  IframeErrorCode,
} from "./types";

export { IframeError, isDerivationResult, isDerivationSignResult } from "./types";

export {
  createProvider,
  ConnectProvider,
  ProviderRpcError,
  CONNECT_CAPABILITIES,
} from "./provider";
export type { ConnectProviderOptions } from "./provider";

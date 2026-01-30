/**
 * @ohmywallet/connect
 *
 * dApp에서 OhMyWallet을 연결하기 위한 공개 라이브러리
 *
 * 이 패키지는 iframe 기반 통신만 제공합니다.
 * 개인키 관련 API는 포함되지 않습니다.
 *
 * ## SignerType 기반 API
 *
 * @example
 * ```typescript
 * import { IframeHost } from "@ohmywallet/connect";
 *
 * const wallet = new IframeHost({
 *   iframeSrc: "https://vault.ohmywallet.xyz",
 * });
 *
 * // === PasskeySigner (P-256 직접 서명) ===
 * const passkey = await wallet.connectWithSignerType({ signerType: "passkey" });
 * // → { signerType: "passkey", passkeys: [...], activePasskey: {...} }
 *
 * const sig = await wallet.signWithPasskey(challenge, {
 *   keyId: passkey.passkeys[0].keyId,
 * });
 * // → { signerType: "passkey", keyId, signature: { r, s }, authenticatorData, clientDataJSON }
 *
 * // === DerivationSigner (파생 키 서명) ===
 * const derived = await wallet.connectWithSignerType({ signerType: "derivation" });
 * // → { signerType: "derivation", addresses: [...], activeAddress: {...} }
 *
 * const sig = await wallet.signWithDerivation(txHash, {
 *   address: derived.addresses[0].address,
 * });
 * // → { signerType: "derivation", address, signature: "0x..." }
 *
 * // 종료
 * wallet.destroy();
 * ```
 */

// Host (dApp 측)
export { IframeHost, type IframeHostState, type IframeHostEvents } from "./host";

// =============================================================================
// SignerType 기반 API 타입
// =============================================================================

export type {
  // 서명자 타입
  SignerType,
  // PasskeySigner
  PasskeyInfo,
  PasskeyConnectOptions,
  PasskeyConnectResult,
  PasskeySignOptions,
  PasskeySignResult,
  // DerivationSigner
  DerivationAddressInfo,
  DerivationConnectOptions,
  DerivationConnectResult,
  DerivationSignOptions,
  DerivationSignResult,
  // Derive Address (새 기능)
  DeriveAddressOptions,
  DeriveAddressResult,
  DeriveAddressPayload,
  // Union 타입
  ConnectOptions,
  ConnectResult,
  SignOptions,
  SignResult,
  // 메시지
  IframeMessageType,
  IframeMessage,
  // 페이로드
  ConnectPayload,
  PasskeySignPayload,
  DerivationSignPayload,
  // 설정
  IframeHostConfig,
  SupportedLocale,
  // 에러
  IframeErrorCode,
} from "./types";

export {
  IframeError,
  // 타입 가드
  isPasskeyResult,
  isDerivationResult,
  isPasskeySignResult,
  isDerivationSignResult,
  // 참고용 상수 & 헬퍼
  RIP7212_NATIVE_CHAINS,
  supportsRIP7212,
} from "./types";

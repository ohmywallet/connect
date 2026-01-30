/**
 * @ohmywallet/connect 공개 타입 정의
 *
 * dApp에서 사용하는 타입만 노출합니다.
 * 내부 구현 세부사항(credentialId, 개인키 등)은 노출하지 않습니다.
 *
 * ## SignerType 기반 API
 *
 * - PasskeySigner: P-256 직접 서명 (RIP-7212, WebAuthn 인증 등)
 * - DerivationSigner: 파생 키 서명 (EVM EOA, Solana, Bitcoin 등)
 */

import type { Hash, Hex } from "viem";

// =============================================================================
// Derivation 관련 타입 (npm 배포용 독립 정의)
// =============================================================================

/** 파생 키 커브 타입 */
export type DerivationCurve = "secp256k1" | "ed25519";

/** 파생 키 체인 그룹 */
export type DerivationGroup = "evm" | "solana" | "bitcoin";

/** Bitcoin 주소 타입 */
export type BitcoinAddressType = "p2wpkh" | "p2tr";

/** Bitcoin 네트워크 */
export type BitcoinNetwork = "mainnet" | "testnet4";

// =============================================================================
// 트랜잭션 확인 관련 타입
// =============================================================================

/** 트랜잭션 정보 */
export interface TransactionInfo {
  /** 보내는 주소 */
  from: Hex;
  /** 받는 주소 */
  to: Hex;
  /** 전송 금액 (wei, string으로 전달) */
  value?: string;
  /** 컨트랙트 호출 데이터 */
  data?: Hex;
  /** 가스 한도 (string으로 전달) */
  gasLimit?: string;
  /** 체인 ID */
  chainId: number;
  /** 체인 이름 */
  chainName?: string;
  /** 사용자의 현재 체인 ID */
  currentChainId?: number;
  /** 사용자의 평균 전송 금액 (과도한 금액 감지용, string으로 전달) */
  averageTransactionValue?: string;
}

// =============================================================================
// 메시지 타입
// =============================================================================

/** 메시지 종류 */
export type IframeMessageType =
  // 부모 → iframe
  | "CONNECT" // SignerType 기반 연결
  | "SIGN_WITH_PASSKEY" // PasskeySigner 서명
  | "SIGN_WITH_DERIVATION" // DerivationSigner 서명
  | "DERIVE_ADDRESS" // 주소 파생 요청
  | "DESTROY" // 세션 종료
  // iframe → 부모
  | "READY" // iframe 준비 완료
  | "CONNECT_RESULT" // 연결 결과
  | "NEEDS_ONBOARDING" // 온보딩 필요 (지갑 없음)
  | "SIGN_RESULT" // 서명 결과
  | "DERIVE_ADDRESS_RESULT" // 주소 파생 결과
  | "ERROR"; // 에러 응답

/** 기본 메시지 구조 */
export interface IframeMessage<T extends IframeMessageType = IframeMessageType, P = unknown> {
  type: T;
  id: string;
  payload: P;
  timestamp: number;
}

// =============================================================================
// SignerType 기반 Connect API
// =============================================================================

/** 서명자 타입 */
export type SignerType = "passkey" | "derivation";

// -----------------------------------------------------------------------------
// PasskeySigner Types
// -----------------------------------------------------------------------------

/** PassKey 정보 (dApp에 노출되는 정보) */
export interface PasskeyInfo {
  /** 키 식별자 (keccak256(x, y)) - 서명 시 사용 */
  keyId: Hex;
  /** P-256 공개키 */
  publicKey: {
    x: Hex;
    y: Hex;
  };
  /** 생성 시각 */
  createdAt: number;
  /** 사용자 지정 라벨 */
  label?: string;
  /** WebAuthn userId (base64url) - 외부 서비스 연동용 */
  userId?: string;
}

/** PasskeySigner 연결 옵션 (dApp 전용) */
export interface PasskeyConnectOptions {
  signerType: "passkey";
  /** dApp 이름 (PassKey displayName에 사용) */
  dappName?: string;
  /** dApp 아이콘 URL */
  dappIcon?: string;
}

/** PasskeySigner 연결 결과 */
export interface PasskeyConnectResult {
  signerType: "passkey";
  /** 사용 가능한 PassKey 목록 */
  passkeys: PasskeyInfo[];
  /** 현재 활성화된 PassKey */
  activePasskey?: PasskeyInfo;
}

/** PasskeySigner 서명 옵션 */
export interface PasskeySignOptions {
  /** 서명할 PassKey의 keyId */
  keyId: Hex;
  /** 트랜잭션 확인 모달 표시 여부 (선택) */
  requireConfirmation?: boolean;
  /** 트랜잭션 정보 (requireConfirmation=true일 때 권장) */
  transactionInfo?: TransactionInfo;
}

/** PasskeySigner 서명 결과 */
export interface PasskeySignResult {
  signerType: "passkey";
  keyId: Hex;
  /** P-256 서명 */
  signature: {
    r: Hex;
    s: Hex;
  };
  /** WebAuthn authenticatorData */
  authenticatorData: Hex;
  /** WebAuthn clientDataJSON */
  clientDataJSON: string;
}

// -----------------------------------------------------------------------------
// DerivationSigner Types
// -----------------------------------------------------------------------------

/** 파생 주소 정보 (dApp에 노출되는 정보) */
export interface DerivationAddressInfo {
  /** 주소 - 서명 시 식별자로 사용 */
  address: string;
  /** 키 인덱스 (참고용) */
  keyIndex: number;
  /** 파생 커브 */
  curve: DerivationCurve;
  /** 체인 그룹 */
  group: DerivationGroup;
  /** Bitcoin 주소 타입 (bitcoin 그룹 전용) */
  bitcoinAddressType?: BitcoinAddressType;
  /** Bitcoin 네트워크 (bitcoin 그룹 전용) */
  bitcoinNetwork?: BitcoinNetwork;
}

/**
 * DerivationSigner 연결 옵션 (범용 지갑)
 *
 * ⚠️ Derivation은 범용 지갑이므로 dApp 특정 정보를 포함하지 않습니다.
 */
export interface DerivationConnectOptions {
  signerType: "derivation";
  // dappName, dappIcon 없음 (범용 지갑)
}

/** DerivationSigner 연결 결과 */
export interface DerivationConnectResult {
  signerType: "derivation";
  // addresses, activeAddress 제거 (iframe localStorage 종속 제거)
}

/** DerivationSigner 서명 옵션 */
export interface DerivationSignOptions {
  /** 서명할 주소 (XOR: address 또는 group+keyIndex 중 하나만) */
  address?: string;
  /** 파생 키 그룹 (XOR: address 또는 group+keyIndex 중 하나만) */
  group?: DerivationGroup;
  /** 파생 키 인덱스 (XOR: address 또는 group+keyIndex 중 하나만) */
  keyIndex?: number;
  /** 트랜잭션 확인 모달 표시 여부 (선택) */
  requireConfirmation?: boolean;
  /** 트랜잭션 정보 (requireConfirmation=true일 때 권장) */
  transactionInfo?: TransactionInfo;
}

/** DerivationSigner 서명 결과 */
export interface DerivationSignResult {
  signerType: "derivation";
  address: string;
  /** 체인에 맞는 서명 포맷 */
  signature: Hex;
}

// -----------------------------------------------------------------------------
// Derive Address Types
// -----------------------------------------------------------------------------

/** 주소 파생 요청 옵션 */
export interface DeriveAddressOptions {
  /** 파생 키 인덱스 */
  keyIndex: number;
  /** 파생 커브 (기본값: secp256k1) */
  curve?: DerivationCurve;
  /** 체인 그룹 (기본값: evm) */
  group?: DerivationGroup;
  /** Bitcoin 주소 타입 (bitcoin 그룹 전용) */
  bitcoinAddressType?: BitcoinAddressType;
  /** Bitcoin 네트워크 (bitcoin 그룹 전용) */
  bitcoinNetwork?: BitcoinNetwork;
}

/** 주소 파생 결과 */
export interface DeriveAddressResult {
  address: DerivationAddressInfo;
}

/** 주소 파생 요청 페이로드 */
export type DeriveAddressPayload = DeriveAddressOptions;

// -----------------------------------------------------------------------------
// Union Types
// -----------------------------------------------------------------------------

/** Connect 옵션 (SignerType 기반) */
export type ConnectOptions = PasskeyConnectOptions | DerivationConnectOptions;

/** Connect 결과 (SignerType 기반) */
export type ConnectResult = PasskeyConnectResult | DerivationConnectResult;

/** Sign 옵션 (SignerType 기반) */
export type SignOptions = PasskeySignOptions | DerivationSignOptions;

/** Sign 결과 (SignerType 기반) */
export type SignResult = PasskeySignResult | DerivationSignResult;

// =============================================================================
// 메시지 페이로드
// =============================================================================

/**
 * Connect 요청 페이로드
 *
 * PassKey: dApp 전용 (dappName, dappIcon 포함)
 * Derivation: 범용 지갑 (dApp 정보 없음)
 */
export type ConnectPayload =
  | {
      signerType: "passkey";
      dappName?: string;
      dappIcon?: string;
    }
  | {
      signerType: "derivation";
      // dappName, dappIcon 없음
    };

/** PasskeySigner 서명 요청 페이로드 */
export interface PasskeySignPayload {
  hash: Hash;
  keyId: Hex;
  /** 트랜잭션 확인 모달 표시 여부 (선택) */
  requireConfirmation?: boolean;
  /** 트랜잭션 정보 (requireConfirmation=true일 때 필수) */
  transactionInfo?: TransactionInfo;
}

/** DerivationSigner 서명 요청 페이로드 */
export interface DerivationSignPayload {
  hash: Hash;
  /** 서명할 주소 (XOR: address 또는 group+keyIndex 중 하나만) */
  address?: string;
  /** 파생 키 그룹 (XOR: address 또는 group+keyIndex 중 하나만) */
  group?: DerivationGroup;
  /** 파생 키 인덱스 (XOR: address 또는 group+keyIndex 중 하나만) */
  keyIndex?: number;
  /** 트랜잭션 확인 모달 표시 여부 (선택) */
  requireConfirmation?: boolean;
  /** 트랜잭션 정보 (requireConfirmation=true일 때 필수) */
  transactionInfo?: TransactionInfo;
}

// =============================================================================
// 에러 타입
// =============================================================================

/** iframe 에러 코드 */
export type IframeErrorCode =
  | "NOT_INITIALIZED"
  | "ALREADY_INITIALIZED"
  | "TIMEOUT"
  | "DESTROYED"
  | "SIGN_FAILED"
  | "INVALID_MESSAGE"
  | "INVALID_ORIGIN"
  | "VALIDATION_FAILED"
  | "CREDENTIAL_INACCESSIBLE"
  | "ALREADY_EXISTS"
  | "USER_CANCELLED"
  | "UNKNOWN_KEY" // keyId를 찾을 수 없음
  | "UNKNOWN_ADDRESS"; // address를 찾을 수 없음

/** iframe 에러 */
export class IframeError extends Error {
  readonly code: IframeErrorCode;

  constructor(code: IframeErrorCode, message: string) {
    super(message);
    this.name = "IframeError";
    this.code = code;
  }
}

// =============================================================================
// 설정 타입
// =============================================================================

/**
 * 지원하는 로케일 (15개 언어)
 *
 * - Tier 1 (Critical): ko, en, zh-CN, zh-TW, es, hi
 * - Tier 2 (High): id, vi, ru, pt, tr
 * - Tier 3 (Medium): ja, fr, de, ar
 */
export type SupportedLocale =
  | "ko"
  | "en"
  | "zh-CN"
  | "zh-TW"
  | "es"
  | "hi"
  | "id"
  | "vi"
  | "ru"
  | "pt"
  | "tr"
  | "ja"
  | "fr"
  | "de"
  | "ar";

/** IframeHost 설정 */
export interface IframeHostConfig {
  /** iframe src URL (예: https://vault.ohmywallet.xyz) */
  iframeSrc: string;
  /** 요청 타임아웃 (ms, 기본값: 30000) */
  timeout?: number;
  /** iframe sandbox 속성 */
  sandbox?: string;
  /** iframe을 삽입할 컨테이너 */
  container?: HTMLElement;
  /** iframe UI 언어 (기본값: 브라우저 언어 또는 'ko') */
  locale?: SupportedLocale;
  /** dApp origin (기본값: window.location.origin). iframe이 postMessage origin 검증에 사용 */
  origin?: string;
}

// =============================================================================
// 타입 가드 (Type Guards)
// =============================================================================

/**
 * ConnectResult가 PasskeyConnectResult인지 확인
 *
 * @example
 * ```typescript
 * const result = await wallet.connectWithSignerType({ signerType: "passkey" });
 *
 * if (isPasskeyResult(result)) {
 *   // TypeScript가 result를 PasskeyConnectResult로 인식
 *   console.log(result.passkeys);
 * }
 * ```
 */
export function isPasskeyResult(result: ConnectResult): result is PasskeyConnectResult {
  return result.signerType === "passkey";
}

/**
 * ConnectResult가 DerivationConnectResult인지 확인
 *
 * @example
 * ```typescript
 * const result = await wallet.connectWithSignerType({ signerType: "derivation" });
 *
 * if (isDerivationResult(result)) {
 *   // TypeScript가 result를 DerivationConnectResult로 인식
 *   console.log(result.addresses);
 * }
 * ```
 */
export function isDerivationResult(result: ConnectResult): result is DerivationConnectResult {
  return result.signerType === "derivation";
}

/**
 * SignResult가 PasskeySignResult인지 확인
 */
export function isPasskeySignResult(result: SignResult): result is PasskeySignResult {
  return result.signerType === "passkey";
}

/**
 * SignResult가 DerivationSignResult인지 확인
 */
export function isDerivationSignResult(result: SignResult): result is DerivationSignResult {
  return result.signerType === "derivation";
}

// =============================================================================
// 참고용 상수 (Reference Only)
// =============================================================================

/**
 * RIP-7212 네이티브 지원 체인 목록 (참고용)
 *
 * ⚠️ 주의: 자동 선택에 사용하지 마세요. 명시적 선택이 안전합니다.
 *
 * @see https://github.com/ethereum/RIPs/blob/master/RIPS/rip-7212.md
 */
export const RIP7212_NATIVE_CHAINS = [
  324, // zkSync Era
  1101, // Polygon zkEVM
  59144, // Linea
  534352, // Scroll
] as const;

/**
 * 체인이 RIP-7212을 네이티브 지원하는지 확인 (참고용)
 *
 * ⚠️ 주의: 자동 선택에 사용하지 마세요.
 * 이 함수는 dApp이 판단에 참고할 수 있도록 제공되지만,
 * signerType은 항상 명시적으로 선택해야 합니다.
 *
 * @example
 * ```typescript
 * // ❌ 나쁜 예: 자동 선택 (위험)
 * const signerType = supportsRIP7212(chainId) ? "passkey" : "derivation";
 *
 * // ✅ 좋은 예: 참고만 하고 명시적 선택
 * if (supportsRIP7212(324)) {
 *   console.log("zkSync Era는 PassKey를 권장합니다");
 * }
 * const result = await wallet.connectWithSignerType({
 *   signerType: "passkey", // 명시적 선택
 * });
 * ```
 */
export function supportsRIP7212(chainId: number): boolean {
  return (RIP7212_NATIVE_CHAINS as readonly number[]).includes(chainId);
}

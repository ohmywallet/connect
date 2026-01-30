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
  // 부모 → iframe (새 API)
  | "CONNECT" // SignerType 기반 연결
  | "SIGN_WITH_PASSKEY" // PasskeySigner 서명
  | "SIGN_WITH_DERIVATION" // DerivationSigner 서명
  | "DERIVE_ADDRESS" // 새 주소 파생 요청
  | "DESTROY" // 세션 종료
  // iframe → 부모 (새 API)
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
}

/** PasskeySigner 연결 옵션 */
export interface PasskeyConnectOptions {
  signerType: "passkey";
  dappName?: string;
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

/** DerivationSigner 연결 옵션 */
export interface DerivationConnectOptions {
  signerType: "derivation";
  dappName?: string;
  dappIcon?: string;
}

/** DerivationSigner 연결 결과 */
export interface DerivationConnectResult {
  signerType: "derivation";
  /** 사용 가능한 파생 주소 목록 */
  addresses: DerivationAddressInfo[];
  /** 현재 활성화된 주소 */
  activeAddress?: DerivationAddressInfo;
}

/** DerivationSigner 서명 옵션 */
export interface DerivationSignOptions {
  /** 서명할 주소 - 지갑이 내부에서 메타데이터 조회 */
  address: string;
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

/** Connect 요청 페이로드 */
export interface ConnectPayload {
  signerType: SignerType;
  dappName?: string;
  dappIcon?: string;
}

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
  address: string;
  /** 트랜잭션 확인 모달 표시 여부 (선택) */
  requireConfirmation?: boolean;
  /** 트랜잭션 정보 (requireConfirmation=true일 때 필수) */
  transactionInfo?: TransactionInfo;
}

/** 주소 파생 요청 페이로드 */
export interface DeriveAddressPayload {
  /** 파생할 키 인덱스 */
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
  /** 성공 여부 */
  success: boolean;
  /** 파생된 주소 정보 */
  address?: DerivationAddressInfo;
  /** 에러 메시지 (실패 시) */
  error?: string;
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

/** 지원하는 로케일 */
export type SupportedLocale = "ko" | "en" | "zh";

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

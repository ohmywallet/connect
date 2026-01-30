/**
 * HostWalletManager - IframeHost를 WalletManager-like 인터페이스로 래핑
 *
 * apps/wallet에서 사용하기 위한 매니저입니다.
 * IframeHost를 통해 iframe과 통신하며, 서명은 iframe 내부에서 격리 실행됩니다.
 *
 * @example
 * ```typescript
 * import { IframeHost, HostWalletManager } from "@ohmywallet/connect";
 *
 * const iframeHost = new IframeHost({
 *   iframeSrc: "https://vault.ohmywallet.xyz",
 * });
 *
 * const manager = new HostWalletManager({
 *   iframeHost,
 *   onStateChange: (state) => console.log("State:", state),
 *   onReady: (address) => console.log("Ready:", address),
 * });
 *
 * await manager.initialize();
 * const { signature, address } = await manager.sign(hash);
 * ```
 */

import type { Hash, Hex } from "viem";
import { IframeHost } from "./host";
import type {
  DerivationGroup,
  BitcoinAddressType,
  BitcoinNetwork,
  TransactionInfo,
  IframeHostConfig,
} from "./types";
import { IframeError } from "./types";

// =============================================================================
// 상수
// =============================================================================

/** Host 앱에서 파생된 주소 목록을 캐시하는 localStorage 키 */
const HOST_ADDRESSES_STORAGE_KEY = "ohmywallet:host:addresses";

// =============================================================================
// 타입 정의
// =============================================================================

/** HostWalletManager 상태 */
export type HostWalletManagerState =
  | "idle" // 초기 상태
  | "connecting" // 연결 중
  | "no_wallet" // 지갑 없음 (온보딩 필요)
  | "ready" // 준비 완료
  | "destroyed"; // 종료됨

/** 주소 정보 */
export interface HostWalletAddressInfo {
  keyIndex: number;
  address: string;
  group: DerivationGroup;
  bitcoinAddressType?: BitcoinAddressType;
  bitcoinNetwork?: BitcoinNetwork;
}

/** 주소 파생 옵션 */
export interface HostDeriveAddressOptions {
  /** 체인 그룹 (기본값: evm) */
  group?: DerivationGroup;
  /** Bitcoin 주소 타입 (bitcoin 그룹 전용) */
  bitcoinAddressType?: BitcoinAddressType;
  /** Bitcoin 네트워크 (bitcoin 그룹 전용) */
  bitcoinNetwork?: BitcoinNetwork;
}

/** HostWalletManager 설정 */
export interface HostWalletManagerConfig {
  /** IframeHost 인스턴스 또는 설정 */
  iframeHost: IframeHost | IframeHostConfig;
  /** 상태 변경 콜백 */
  onStateChange?: (state: HostWalletManagerState) => void;
  /** 지갑 준비 완료 콜백 */
  onReady?: (address: string) => void;
  /** 에러 콜백 */
  onError?: (error: Error) => void;
  /** 온보딩 필요 콜백 */
  onNeedsOnboarding?: () => void;
  /** 주소 목록 변경 콜백 (캐시 복원 시 호출) */
  onAddressesChange?: (addresses: HostWalletAddressInfo[]) => void;
}

// =============================================================================
// 메인 클래스
// =============================================================================

/**
 * HostWalletManager
 *
 * IframeHost를 사용하여 iframe과 통신하는 매니저입니다.
 * WalletManager 인터페이스와 유사한 API를 제공합니다.
 *
 * 보안:
 * - 개인키는 iframe 내부에서만 존재
 * - 서명 요청은 postMessage로 전달
 * - 서명 결과만 반환
 */
export class HostWalletManager {
  private host: IframeHost;
  private ownedHost: boolean; // host를 직접 생성했는지 여부
  private config: HostWalletManagerConfig;
  private state: HostWalletManagerState = "idle";
  private currentAddress: string | null = null;
  private currentKeyIndex: number = 0;
  private addresses: HostWalletAddressInfo[] = [];

  constructor(config: HostWalletManagerConfig) {
    this.config = config;

    // IframeHost 인스턴스 또는 설정으로 초기화
    if (config.iframeHost instanceof IframeHost) {
      this.host = config.iframeHost;
      this.ownedHost = false;
    } else {
      this.host = new IframeHost(config.iframeHost);
      this.ownedHost = true;
    }
  }

  // ===========================================================================
  // Getters
  // ===========================================================================

  /** 현재 상태 */
  get currentState(): HostWalletManagerState {
    return this.state;
  }

  /** 현재 활성 keyIndex */
  get activeKeyIndex(): number {
    return this.currentKeyIndex;
  }

  /** 복구 진행 상태 조회 (지원하지 않음) */
  getRecoveryProgress(): null {
    // HostWalletManager는 복구 진행 상태를 추적하지 않음
    // 복구는 iframe 내부에서 처리됨
    return null;
  }

  /**
   * 현재 지갑 주소 조회
   *
   * @returns 지갑 주소 (없으면 null)
   */
  getAddress(): string | null {
    if (this.state !== "ready") {
      return null;
    }
    return this.currentAddress;
  }

  // ===========================================================================
  // Public 메서드
  // ===========================================================================

  /**
   * 매니저 초기화
   *
   * IframeHost를 통해 iframe에 연결합니다.
   * 지갑이 없으면 onNeedsOnboarding 콜백이 호출됩니다.
   */
  async initialize(): Promise<void> {
    if (this.state !== "idle") {
      return;
    }

    this.setState("connecting");

    try {
      // DerivationSigner로 연결 시도
      await this.host.connectWithSignerType({
        signerType: "derivation",
      });

      // 연결 성공 - ready 상태로 전환
      // DerivationConnectResult는 addresses를 포함하지 않음
      // 첫 번째 주소를 파생해야 함
      await this.initializeFirstAddress();
    } catch (error) {
      // NEEDS_ONBOARDING 처리
      if (error instanceof IframeError) {
        if (error.code === "NOT_INITIALIZED" && error.message.includes("지갑이 없습니다")) {
          this.setState("no_wallet");
          this.config.onNeedsOnboarding?.();
          return;
        }
      }

      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * 첫 번째 주소 초기화 및 캐시된 주소 복원
   *
   * 연결 후:
   * 1. 캐시된 주소 목록을 먼저 로드합니다.
   * 2. 기본 주소(keyIndex=0)를 파생합니다.
   * 3. 캐시된 다른 주소들을 복원합니다.
   */
  private async initializeFirstAddress(): Promise<void> {
    try {
      // 1. 캐시된 주소 목록 먼저 로드 (덮어쓰기 방지)
      const cachedAddresses = this.loadCachedAddresses();

      // 2. 기본 주소(keyIndex=0) 파생
      const result = await this.host.deriveAddress({
        keyIndex: 0,
        group: "evm",
      });

      const addressInfo: HostWalletAddressInfo = {
        keyIndex: result.address.keyIndex,
        address: result.address.address,
        group: result.address.group,
        bitcoinAddressType: result.address.bitcoinAddressType,
        bitcoinNetwork: result.address.bitcoinNetwork,
      };

      this.addresses = [addressInfo];
      this.currentAddress = addressInfo.address;
      this.currentKeyIndex = addressInfo.keyIndex;

      this.setState("ready");
      this.config.onReady?.(addressInfo.address);

      // 3. 캐시된 주소 목록 복원 (백그라운드)
      // 캐시가 있으면 복원, 없으면 현재 주소만 저장
      if (cachedAddresses.length > 1) {
        this.restoreCachedAddressesFromList(cachedAddresses).catch(() => {
          // 복원 실패 시 현재 상태만 저장
          this.saveCachedAddresses();
        });
      } else {
        // 캐시가 없거나 EVM만 있으면 현재 상태 저장
        this.saveCachedAddresses();
      }
    } catch (error) {
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * 캐시된 주소 목록을 iframe에서 다시 파생하여 복원
   *
   * @param cachedAddresses - 미리 로드한 캐시된 주소 목록
   */
  private async restoreCachedAddressesFromList(
    cachedAddresses: HostWalletAddressInfo[]
  ): Promise<void> {
    // 이미 있는 주소(keyIndex=0, group=evm) 제외하고 복원
    const toRestore = cachedAddresses.filter(
      (cached) =>
        !this.addresses.some(
          (existing) =>
            existing.keyIndex === cached.keyIndex &&
            existing.group === cached.group &&
            existing.bitcoinNetwork === cached.bitcoinNetwork
        )
    );

    // 순차적으로 복원 (병렬 요청 시 iframe 부하 방지)
    for (const cached of toRestore) {
      try {
        const curve = cached.group === "solana" ? "ed25519" : "secp256k1";
        const result = await this.host.deriveAddress({
          keyIndex: cached.keyIndex,
          group: cached.group,
          curve,
          bitcoinAddressType: cached.bitcoinAddressType,
          bitcoinNetwork: cached.bitcoinNetwork,
        });

        // 복원된 주소가 캐시와 일치하는지 확인
        if (result.address) {
          const addressInfo: HostWalletAddressInfo = {
            keyIndex: result.address.keyIndex,
            address: result.address.address,
            group: result.address.group,
            bitcoinAddressType: result.address.bitcoinAddressType,
            bitcoinNetwork: result.address.bitcoinNetwork,
          };

          // 중복 확인 후 추가
          const existingIndex = this.addresses.findIndex(
            (a) =>
              a.keyIndex === addressInfo.keyIndex &&
              a.group === addressInfo.group &&
              a.bitcoinNetwork === addressInfo.bitcoinNetwork
          );

          if (existingIndex < 0) {
            this.addresses.push(addressInfo);
          }
        }
      } catch {
        // 개별 주소 복원 실패 무시
      }
    }

    // 복원 완료 후 캐시 업데이트 및 UI 알림
    this.saveCachedAddresses();

    // 새 주소가 추가되었으면 UI에 알림
    if (toRestore.length > 0) {
      this.config.onAddressesChange?.([...this.addresses]);
    }
  }

  /**
   * 지갑 생성
   *
   * HostWalletManager에서는 지갑 생성을 직접 지원하지 않습니다.
   * iframe 내부의 UI를 통해 생성해야 합니다.
   *
   * @throws IframeError - 지원하지 않는 작업
   */
  async createWallet(_userName?: string): Promise<string> {
    // HostWalletManager는 지갑 생성을 지원하지 않음
    // iframe 내부에서 온보딩 UI가 자동으로 표시됨
    throw new IframeError(
      "VALIDATION_FAILED",
      "HostWalletManager에서는 직접 지갑 생성을 지원하지 않습니다. " +
        "iframe 내부의 온보딩 UI를 사용해주세요."
    );
  }

  /**
   * 기존 지갑 복구
   *
   * HostWalletManager에서는 복구를 직접 지원하지 않습니다.
   * iframe 내부의 UI를 통해 복구해야 합니다.
   *
   * @returns null (지원하지 않음)
   */
  async recoverExistingWallet(): Promise<string | null> {
    // HostWalletManager는 복구를 지원하지 않음
    // iframe 내부에서 복구 UI가 자동으로 표시됨
    return null;
  }

  /**
   * 서명
   *
   * @param hash - 서명할 해시
   * @param options - 서명 옵션
   * @returns 서명 결과 (signature, address)
   */
  async sign(
    hash: Hash,
    options?: {
      requireConfirmation?: boolean;
      transactionInfo?: TransactionInfo;
    }
  ): Promise<{ signature: Hex; address: string }> {
    if (this.state !== "ready" || !this.currentAddress) {
      throw new IframeError("NOT_INITIALIZED", "매니저가 준비되지 않았습니다");
    }

    const result = await this.host.signWithDerivation(hash, {
      address: this.currentAddress,
      requireConfirmation: options?.requireConfirmation,
      transactionInfo: options?.transactionInfo,
    });

    return {
      signature: result.signature,
      address: result.address,
    };
  }

  /**
   * 추가 주소 파생
   *
   * @param keyIndex - 파생할 키 인덱스
   * @param options - 파생 옵션
   * @returns 파생된 주소
   */
  async deriveAddress(keyIndex: number, options?: HostDeriveAddressOptions): Promise<string> {
    if (this.state !== "ready") {
      throw new IframeError("NOT_INITIALIZED", "매니저가 준비되지 않았습니다");
    }

    // 그룹에 따라 curve 자동 결정
    const group = options?.group ?? "evm";
    const curve = group === "solana" ? "ed25519" : "secp256k1";

    const result = await this.host.deriveAddress({
      keyIndex,
      group,
      curve,
      bitcoinAddressType: options?.bitcoinAddressType,
      bitcoinNetwork: options?.bitcoinNetwork,
    });

    // 에러 응답 처리 (IframeWorker에서 { success: false, error } 형식 반환 가능)
    const resultAny = result as unknown as {
      success?: boolean;
      error?: string;
      address?: typeof result.address;
    };
    if (resultAny.success === false) {
      throw new IframeError("SIGN_FAILED", resultAny.error ?? "주소 파생에 실패했습니다");
    }

    // 캐시 업데이트
    const addressData = resultAny.address ?? result.address;
    if (!addressData) {
      throw new IframeError("SIGN_FAILED", "주소 파생 결과가 없습니다");
    }

    const addressInfo: HostWalletAddressInfo = {
      keyIndex: addressData.keyIndex,
      address: addressData.address,
      group: addressData.group,
      bitcoinAddressType: addressData.bitcoinAddressType,
      bitcoinNetwork: addressData.bitcoinNetwork,
    };

    // 기존 주소 업데이트 또는 추가
    // Bitcoin은 같은 keyIndex라도 network가 다르면 다른 주소
    const existingIndex = this.addresses.findIndex(
      (a) =>
        a.keyIndex === keyIndex &&
        a.group === addressInfo.group &&
        a.bitcoinNetwork === addressInfo.bitcoinNetwork
    );
    if (existingIndex >= 0) {
      this.addresses[existingIndex] = addressInfo;
    } else {
      this.addresses.push(addressInfo);
    }

    // localStorage 캐시 업데이트
    this.saveCachedAddresses();

    return addressInfo.address;
  }

  /**
   * 모든 파생 주소 목록 조회
   *
   * @returns 파생된 주소 목록
   */
  getAddresses(): HostWalletAddressInfo[] {
    return [...this.addresses];
  }

  /**
   * 특정 keyIndex로 전환
   *
   * @param keyIndex - 전환할 키 인덱스
   * @returns 전환된 주소
   */
  switchToAddress(keyIndex: number): string {
    if (this.state !== "ready") {
      throw new IframeError("NOT_INITIALIZED", "매니저가 준비되지 않았습니다");
    }

    const addressInfo = this.addresses.find((a) => a.keyIndex === keyIndex);
    if (!addressInfo) {
      throw new IframeError("UNKNOWN_ADDRESS", `keyIndex ${keyIndex}에 해당하는 주소가 없습니다`);
    }

    this.currentAddress = addressInfo.address;
    this.currentKeyIndex = keyIndex;

    return addressInfo.address;
  }

  /**
   * 주소 제거
   *
   * 주소 목록에서 특정 주소를 제거합니다.
   * 현재 활성 주소는 제거할 수 없습니다.
   * 최소 1개의 주소는 유지해야 합니다.
   *
   * @param addressToRemove - 제거할 주소 문자열
   * @returns 제거 성공 여부
   */
  removeAddress(addressToRemove: string): boolean {
    if (this.state !== "ready") {
      throw new IframeError("NOT_INITIALIZED", "매니저가 준비되지 않았습니다");
    }

    // 최소 1개 주소 유지
    if (this.addresses.length <= 1) {
      return false;
    }

    // 현재 활성 주소는 제거 불가
    if (
      this.currentAddress &&
      this.currentAddress.toLowerCase() === addressToRemove.toLowerCase()
    ) {
      return false;
    }

    // 주소 찾기
    const index = this.addresses.findIndex(
      (a) => a.address.toLowerCase() === addressToRemove.toLowerCase()
    );

    if (index < 0) {
      return false;
    }

    // 주소 제거
    this.addresses.splice(index, 1);

    // localStorage 캐시 업데이트
    this.saveCachedAddresses();

    // UI 알림
    this.config.onAddressesChange?.([...this.addresses]);

    return true;
  }

  /**
   * 온보딩 완료 후 재초기화
   *
   * iframe에서 온보딩이 완료된 후 호출하여 상태를 갱신합니다.
   * 이전 캐시를 삭제하고 새로 초기화합니다.
   */
  async reinitialize(): Promise<void> {
    this.state = "idle";
    this.addresses = [];
    this.currentAddress = null;
    this.currentKeyIndex = 0;

    // 이전 캐시 삭제 (새 지갑으로 재시작)
    this.clearCachedAddresses();

    await this.initialize();
  }

  /** 매니저 종료 */
  destroy(): void {
    if (this.state === "destroyed") return;

    // 직접 생성한 host만 destroy
    if (this.ownedHost) {
      this.host.destroy();
    }

    this.currentAddress = null;
    this.addresses = [];
    this.setState("destroyed");
  }

  // ===========================================================================
  // Private 메서드
  // ===========================================================================

  private setState(newState: HostWalletManagerState): void {
    if (this.state === newState) return;
    if (this.state === "destroyed" && newState !== "destroyed") return;

    this.state = newState;
    this.config.onStateChange?.(newState);
  }

  // ===========================================================================
  // localStorage 캐시 메서드
  // ===========================================================================

  /**
   * 캐시된 주소 목록 로드
   *
   * @returns 캐시된 주소 정보 배열 (없으면 빈 배열)
   */
  private loadCachedAddresses(): HostWalletAddressInfo[] {
    if (typeof localStorage === "undefined") return [];

    try {
      const stored = localStorage.getItem(HOST_ADDRESSES_STORAGE_KEY);
      if (!stored) return [];

      const data = JSON.parse(stored) as { addresses: HostWalletAddressInfo[] };
      return data.addresses ?? [];
    } catch {
      return [];
    }
  }

  /**
   * 주소 목록을 localStorage에 캐시
   */
  private saveCachedAddresses(): void {
    if (typeof localStorage === "undefined") return;

    try {
      const data = { addresses: this.addresses };
      localStorage.setItem(HOST_ADDRESSES_STORAGE_KEY, JSON.stringify(data));
    } catch {
      // 저장 실패 무시 (localStorage 용량 초과 등)
    }
  }

  /**
   * 캐시된 주소 삭제
   */
  private clearCachedAddresses(): void {
    if (typeof localStorage === "undefined") return;

    try {
      localStorage.removeItem(HOST_ADDRESSES_STORAGE_KEY);
    } catch {
      // 삭제 실패 무시
    }
  }
}

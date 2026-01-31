# @ohmywallet/connect

dApp에서 OhMyWallet을 통합하기 위한 공식 라이브러리입니다.

[English](./README.md)

## OhMyWallet 소개

**OhMyWallet**은 PassKey 기반의 차세대 멀티체인 스마트 지갑입니다.

하나의 PassKey로 **EVM**, **Solana**, **Bitcoin**을 지원합니다.

### 왜 OhMyWallet인가?

| 기존 지갑의 문제         | OhMyWallet 솔루션          |
| ------------------------ | -------------------------- |
| 시드 구문 12/24단어 기억 | 생체인증 (Face ID, 지문)   |
| 개인키 노출 위험         | 하드웨어 보안 칩에 격리    |
| 피싱 공격                | Origin 검증 및 iframe 격리 |
| 체인별 새 지갑 필요      | 멀티체인 단일 지갑         |

### 핵심 장점

- **시드 구문 없음**: PassKey만으로 지갑 생성/복구
- **하드웨어 보안**: 개인키가 절대 브라우저에 노출되지 않음
- **크로스 디바이스**: iCloud/Google 동기화로 모든 기기에서 동일 지갑
- **멀티체인**: 하나의 PassKey로 EVM, Solana, Bitcoin 지원
- **WalletConnect**: 수천 개의 dApp과 연동 가능
- **15개 언어 지원**: 완벽한 i18n (ko, en, zh-CN, zh-TW, ja, es, fr, de, pt, ru, ar, hi, id, vi, tr)

## 설치

```bash
npm install @ohmywallet/connect
# or
pnpm add @ohmywallet/connect
# or
yarn add @ohmywallet/connect
```

## 어떤 서명 방식을 사용해야 하나요?

OhMyWallet은 **두 가지 서명 방식**을 지원합니다. 필요에 따라 명시적으로 선택하세요:

### 🔐 PassKey 서명 (하드웨어 보안 ★★★★★)

**권장**: [RIP-7212](https://github.com/ethereum/RIPs/blob/master/RIPS/rip-7212.md) 지원 체인

**장점:**

- ✅ **하드웨어 보안**: 개인키가 **절대** 노출되지 않음 (디바이스 보안 칩에 저장)
- ✅ **WebAuthn**: 생체인증 사용 (Face ID, Touch ID, Windows Hello)
- ✅ **P-256 네이티브**: 체인에서 직접 서명 검증
- ✅ **최고 보안**: 키 탈취에 대한 최고 수준 보호

**단점:**

- ❌ **제한된 체인**: RIP-7212 호환 체인만 지원
- ❌ **스마트 지갑 필요**: Ethereum 메인넷은 AA(Account Abstraction) 필요

**지원 체인:**

| 체인          | Chain ID | 네이티브 RIP-7212 | 비고             |
| ------------- | -------- | ----------------- | ---------------- |
| zkSync Era    | 324      | ✅                | 완전 지원        |
| Polygon zkEVM | 1101     | ✅                | 완전 지원        |
| Linea         | 59144    | ✅                | 완전 지원        |
| Scroll        | 534352   | ✅                | 완전 지원        |
| Ethereum\*    | 1        | ⚠️                | 스마트 지갑 필요 |
| Arbitrum\*    | 42161    | ⚠️                | 스마트 지갑 필요 |
| Optimism\*    | 10       | ⚠️                | 스마트 지갑 필요 |

\*Account Abstraction(ERC-4337)을 통해 PassKey 사용 가능

---

### 🔑 Derivation 서명 (범용 ★★★☆☆)

**권장**: RIP-7212 미지원 체인, 또는 멀티체인 dApp

**장점:**

- ✅ **범용성**: **모든** 체인에서 작동 (EVM, Solana, Bitcoin 등)
- ✅ **멀티체인**: 하나의 PassKey → 모든 체인의 키 파생
- ✅ **AA 불필요**: EOA(일반 지갑)에서 작동
- ✅ **모든 곡선**: secp256k1 (EVM/Bitcoin), ed25519 (Solana)

**단점:**

- ⚠️ **낮은 보안**: 개인키가 JavaScript 메모리에 존재 (iframe 격리)
- ⚠️ **소프트웨어 기반**: PassKey처럼 하드웨어 보안이 아님

**지원 체인:**

- **EVM**: Ethereum, Arbitrum, Optimism, Base, BSC, Polygon, Avalanche, Fantom...
- **Non-EVM**: Solana, Bitcoin, Cosmos, Near...
- **모든 체인**: secp256k1 또는 ed25519 사용 블록체인

---

### 선택 가이드

```
당신의 dApp이 사용하는 체인은...

┌─────────────────────────────────┐
│  zkSync Era, Polygon zkEVM,     │
│  Linea, Scroll                  │  →  ✅ PassKey 사용 (최고 보안)
└─────────────────────────────────┘

┌─────────────────────────────────┐
│  Ethereum 메인넷 (EOA)          │
│  Arbitrum, Optimism, Base       │  →  ✅ Derivation 사용
│  BSC, Polygon PoS               │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│  Solana, Bitcoin                │  →  ✅ Derivation 사용 (유일한 선택)
└─────────────────────────────────┘

┌─────────────────────────────────┐
│  멀티체인 지원                  │  →  ✅ Derivation 사용 (범용)
└─────────────────────────────────┘

┌─────────────────────────────────┐
│  Ethereum 메인넷 (AA 지갑)      │  →  ✅ PassKey 사용 (AA 구현 시)
└─────────────────────────────────┘
```

**⚠️ 중요**: PassKey와 Derivation은 **서로 다른 주소**를 생성합니다. dApp에서 하나를 선택하여 일관되게 사용하세요.

---

## 빠른 시작

### 옵션 1: PassKey 서명 (하드웨어 보안)

```typescript
import { IframeHost } from "@ohmywallet/connect";

// 1. 지갑 인스턴스 생성
const wallet = new IframeHost({
  iframeSrc: "https://vault.ohmywallet.xyz",
});

// 2. PassKey로 연결
const result = await wallet.connectWithSignerType({
  signerType: "passkey", // 명시적 선택
  dappName: "My Awesome dApp",
  dappIcon: "https://my-dapp.com/icon.png",
});

// 3. 활성 PassKey로 서명 (P-256)
if (!result.activePasskey) {
  throw new Error("활성 PassKey가 없습니다");
}

const sig = await wallet.signWithPasskey("0x1234...abcd", {
  keyId: result.activePasskey.keyId, // 활성 PassKey 사용
});

// 4. 정리
wallet.destroy();
```

### 옵션 2: Derivation 서명 (범용)

```typescript
import { IframeHost } from "@ohmywallet/connect";

// 1. 지갑 인스턴스 생성
const wallet = new IframeHost({
  iframeSrc: "https://vault.ohmywallet.xyz",
});

// 2. Derivation으로 연결 (연결만, 주소 정보 없음)
await wallet.connectWithSignerType({
  signerType: "derivation", // 명시적 선택
});

// 3. 주소 파생 (연결 후 필수 단계)
const { address: primaryAddress } = await wallet.deriveAddress({
  keyIndex: 0,
  group: "evm",
  curve: "secp256k1",
});

// 4. 파생된 주소로 서명
const sig = await wallet.signWithDerivation("0x1234...abcd", {
  address: primaryAddress.address,
});

// 5. 정리
wallet.destroy();
```

## API 레퍼런스

### `IframeHost`

dApp에서 OhMyWallet과 통신하는 메인 클래스입니다.

#### 생성자

```typescript
const wallet = new IframeHost(config: IframeHostConfig);
```

| 옵션        | 타입              | 필수 | 설명                                              |
| ----------- | ----------------- | ---- | ------------------------------------------------- |
| `iframeSrc` | `string`          | ✅   | OhMyWallet iframe URL                             |
| `timeout`   | `number`          | -    | 요청 타임아웃 (기본: 30000ms)                     |
| `sandbox`   | `string`          | -    | iframe sandbox 속성                               |
| `container` | `HTMLElement`     | -    | iframe 삽입 위치                                  |
| `locale`    | `SupportedLocale` | -    | iframe UI 언어 - 15개 언어 지원 (기본: 자동 감지) |
| `origin`    | `string`          | -    | dApp origin (기본: `window.location.origin`)      |

#### 메서드

##### `connectWithSignerType(options): Promise<ConnectResult>`

SignerType 기반으로 연결합니다.

```typescript
const passkey = await wallet.connectWithSignerType({
  signerType: "passkey",
  dappName: "My dApp",
});

const derivation = await wallet.connectWithSignerType({
  signerType: "derivation",
});
```

##### `signWithPasskey(hash, options): Promise<PasskeySignResult>`

PassKey로 P-256 서명합니다.

```typescript
const sig = await wallet.signWithPasskey("0x1234...abcd", {
  keyId: passkey.passkeys[0].keyId,
});
```

##### `signWithDerivation(hash, options): Promise<DerivationSignResult>`

파생 키(secp256k1/ed25519)로 서명합니다.

**방법 1: address로 서명** (권장)

```typescript
// 먼저 주소 파생
const { address } = await wallet.deriveAddress({
  keyIndex: 0,
  group: "evm",
  curve: "secp256k1",
});

// 파생된 주소로 서명
const sig = await wallet.signWithDerivation("0x1234...abcd", {
  address: address.address,
});
```

**방법 2: group + keyIndex로 서명**

```typescript
const sig = await wallet.signWithDerivation("0x1234...abcd", {
  group: "evm", // "evm" | "solana" | "bitcoin"
  keyIndex: 0,
});
```

##### `deriveAddress(options): Promise<DeriveAddressResult>`

연결 없이 새 주소를 파생합니다.

```typescript
const result = await wallet.deriveAddress({
  keyIndex: 1,
  curve: "secp256k1", // "secp256k1" | "ed25519"
  group: "evm", // "evm" | "solana" | "bitcoin"
});
// → { address: { address: "0x...", keyIndex: 1, curve: "secp256k1", group: "evm" } }

// Bitcoin의 경우
const btcResult = await wallet.deriveAddress({
  keyIndex: 0,
  curve: "secp256k1",
  group: "bitcoin",
  bitcoinAddressType: "p2wpkh", // "p2wpkh" | "p2tr"
  bitcoinNetwork: "mainnet", // "mainnet" | "testnet4"
});
```

##### `destroy()`

인스턴스를 정리하고 리소스를 해제합니다.

#### 속성

| 속성           | 타입              | 설명                                                         |
| -------------- | ----------------- | ------------------------------------------------------------ |
| `currentState` | `IframeHostState` | 현재 상태 (`idle`, `loading`, `ready`, `error`, `destroyed`) |

#### 이벤트

```typescript
// 일반 이벤트
wallet.onEvent("error", (error) => { ... });
wallet.onEvent("destroyed", () => { ... });
```

## 프레임워크 통합

### React

```tsx
import { useEffect, useState, useRef } from "react";
import { IframeHost } from "@ohmywallet/connect";
import type { Address } from "viem";

function useOhMyWallet() {
  const walletRef = useRef<IframeHost | null>(null);
  const [address, setAddress] = useState<Address | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  useEffect(() => {
    walletRef.current = new IframeHost({
      iframeSrc: "https://vault.ohmywallet.xyz",
    });

    return () => walletRef.current?.destroy();
  }, []);

  const connect = async () => {
    if (!walletRef.current) return;
    setIsConnecting(true);
    try {
      // 1. 연결 (연결만)
      await walletRef.current.connectWithSignerType({
        signerType: "derivation",
      });

      // 2. 주소 파생 (필수 단계)
      const { address: derived } = await walletRef.current.deriveAddress({
        keyIndex: 0,
        group: "evm",
        curve: "secp256k1",
      });

      setAddress(derived.address as Address);
    } finally {
      setIsConnecting(false);
    }
  };

  const sign = async (hash: `0x${string}`) => {
    if (!walletRef.current) throw new Error("Wallet not initialized");
    if (!address) throw new Error("No address selected");
    return walletRef.current.signWithDerivation(hash, { address });
  };

  return { address, isConnecting, connect, sign };
}

function WalletButton() {
  const { address, isConnecting, connect } = useOhMyWallet();

  if (address) {
    return (
      <span>
        {address.slice(0, 6)}...{address.slice(-4)}
      </span>
    );
  }

  return (
    <button onClick={connect} disabled={isConnecting}>
      {isConnecting ? "연결 중..." : "지갑 연결"}
    </button>
  );
}
```

### Vue 3

```vue
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { IframeHost } from "@ohmywallet/connect";

const wallet = ref<IframeHost | null>(null);
const address = ref<string | null>(null);
const isConnecting = ref(false);

onMounted(() => {
  wallet.value = new IframeHost({
    iframeSrc: "https://vault.ohmywallet.xyz",
  });
});

onUnmounted(() => {
  wallet.value?.destroy();
});

async function connect() {
  if (!wallet.value) return;
  isConnecting.value = true;
  try {
    // 1. 연결 (연결만)
    await wallet.value.connectWithSignerType({
      signerType: "derivation",
    });

    // 2. 주소 파생 (필수 단계)
    const { address: derived } = await wallet.value.deriveAddress({
      keyIndex: 0,
      group: "evm",
      curve: "secp256k1",
    });

    address.value = derived.address;
  } finally {
    isConnecting.value = false;
  }
}
</script>

<template>
  <button @click="connect" :disabled="isConnecting">
    {{ address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "지갑 연결" }}
  </button>
</template>
```

### Vanilla JavaScript

```html
<script type="module">
  import { IframeHost } from "https://esm.sh/@ohmywallet/connect";

  const wallet = new IframeHost({
    iframeSrc: "https://vault.ohmywallet.xyz",
  });

  document.getElementById("connect-btn").onclick = async () => {
    // 1. 연결 (연결만)
    await wallet.connectWithSignerType({
      signerType: "derivation",
    });

    // 2. 주소 파생 (필수 단계)
    const { address: derived } = await wallet.deriveAddress({
      keyIndex: 0,
      group: "evm",
      curve: "secp256k1",
    });

    document.getElementById("address").textContent = derived.address;
  };

  document.getElementById("sign-btn").onclick = async () => {
    const hash = "0x" + "ab".repeat(32);
    const address = document.getElementById("address").textContent;
    if (!address || address === "-") return;
    const signature = await wallet.signWithDerivation(hash, { address });
    console.log("서명:", signature);
  };
</script>

<button id="connect-btn">지갑 연결</button>
<button id="sign-btn">서명하기</button>
<p>주소: <span id="address">-</span></p>
```

## 보안

### iframe 격리

OhMyWallet은 **iframe 격리 아키텍처**를 사용합니다:

```
┌─────────────────────────────────┐
│  dApp (your-dapp.com)           │
│  ┌───────────────────────────┐  │
│  │ @ohmywallet/connect       │  │
│  │ (IframeHost)              │  │
│  └───────────┬───────────────┘  │
│              │ postMessage      │
│  ┌───────────▼───────────────┐  │
│  │ iframe                    │  │
│  │ (vault.ohmywallet.xyz)    │  │
│  │                           │  │
│  │  ┌─────────────────────┐  │  │
│  │  │ PassKey + 개인키    │  │  │
│  │  │ (절대 외부 노출 X)  │  │  │
│  │  └─────────────────────┘  │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

- **키 격리**: 개인키는 iframe 컨텍스트 내부에서만 존재
- **Origin 검증**: 허용된 dApp만 통신 가능
- **postMessage 통신**: 서명 결과만 전달 (개인키 전달 X)

### 권장 CSP

```
frame-src https://vault.ohmywallet.xyz;
```

## 에러 처리

```typescript
import { IframeError } from "@ohmywallet/connect";

try {
  await wallet.connectWithSignerType({ signerType: "derivation" });
} catch (error) {
  if (error instanceof IframeError) {
    switch (error.code) {
      case "TIMEOUT":
        console.error("요청 시간 초과");
        break;
      case "USER_CANCELLED":
        console.error("사용자가 취소함");
        break;
      case "NOT_INITIALIZED":
        console.error("지갑이 초기화되지 않음");
        break;
      default:
        console.error("지갑 에러:", error.message);
    }
  }
}
```

### 에러 코드

| 코드                      | 설명                         |
| ------------------------- | ---------------------------- |
| `NOT_INITIALIZED`         | 지갑이 초기화되지 않음       |
| `ALREADY_INITIALIZED`     | 이미 초기화됨                |
| `TIMEOUT`                 | 요청 시간 초과               |
| `DESTROYED`               | 인스턴스가 파괴됨            |
| `SIGN_FAILED`             | 서명 실패                    |
| `INVALID_MESSAGE`         | 잘못된 메시지 형식           |
| `INVALID_ORIGIN`          | 허용되지 않은 origin         |
| `VALIDATION_FAILED`       | 페이로드 검증 실패           |
| `CREDENTIAL_INACCESSIBLE` | PassKey 자격 증명 접근 불가  |
| `ALREADY_EXISTS`          | 지갑이 이미 존재함           |
| `USER_CANCELLED`          | 사용자가 취소함              |
| `UNKNOWN_KEY`             | PassKey keyId를 찾을 수 없음 |
| `UNKNOWN_ADDRESS`         | 파생 주소를 찾을 수 없음     |

## TypeScript

이 패키지는 TypeScript로 작성되었으며 완전한 타입 정의를 제공합니다.

```typescript
import type {
  IframeHostConfig,
  IframeHostState,
  ConnectResult,
  SignResult,
  IframeErrorCode,
} from "@ohmywallet/connect";
```

### 타입 가드

타입 가드를 사용하여 유니온 타입을 안전하게 좁힐 수 있습니다:

```typescript
import {
  isPasskeyResult,
  isDerivationResult,
  isPasskeySignResult,
  isDerivationSignResult,
} from "@ohmywallet/connect";

// 연결 결과
const result = await wallet.connectWithSignerType({ signerType: "passkey" });

if (isPasskeyResult(result)) {
  // TypeScript가 result를 PasskeyConnectResult로 인식
  console.log(result.passkeys);
  console.log(result.activePasskey?.keyId);
}

if (isDerivationResult(result)) {
  // TypeScript가 result를 DerivationConnectResult로 인식
  // 참고: 주소는 connect 결과가 아닌 deriveAddress()로 얻습니다
  console.log(result.signerType); // "derivation"
}

// 서명 결과
const sig = await wallet.signWithPasskey(hash, { keyId });

if (isPasskeySignResult(sig)) {
  // TypeScript가 sig를 PasskeySignResult로 인식
  console.log(sig.signature.r, sig.signature.s);
  console.log(sig.authenticatorData);
}

if (isDerivationSignResult(sig)) {
  // TypeScript가 sig를 DerivationSignResult로 인식
  console.log(sig.signature); // Hex 문자열
}
```

### 참고용 헬퍼

체인 호환성 확인 (참고용으로만 사용, 자동 선택에 사용 금지):

```typescript
import { supportsRIP7212, RIP7212_NATIVE_CHAINS } from "@ohmywallet/connect";

// 체인이 RIP-7212를 네이티브 지원하는지 확인
if (supportsRIP7212(324)) {
  console.log("zkSync Era는 PassKey를 네이티브 지원합니다");
}

// RIP-7212 네이티브 지원 체인 목록
console.log(RIP7212_NATIVE_CHAINS); // [324, 1101, 59144, 534352]

// ⚠️ 중요: signerType 자동 선택에 사용하지 마세요
// ❌ 나쁜 예: const signerType = supportsRIP7212(chainId) ? "passkey" : "derivation";
// ✅ 좋은 예: 항상 signerType을 명시적으로 선택
```

## 브라우저 지원

- Chrome 67+
- Firefox 60+
- Safari 14+
- Edge 79+

> WebAuthn (PassKey) 지원이 필요합니다.

## 라이선스

MIT

## 링크

- [OhMyWallet 공식 사이트](https://ohmywallet.xyz)
- [GitHub](https://github.com/ohmywallet/connect)
- [문서](https://docs.ohmywallet.xyz)

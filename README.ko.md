# @ohmywallet/connect

dApp에서 OhMyWallet을 통합하기 위한 공식 라이브러리입니다.

[English](./README.md)

## OhMyWallet 소개

**OhMyWallet**은 PassKey 기반의 차세대 EVM 스마트 지갑입니다.

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
- **Account Abstraction**: 가스비 대납, 배치 트랜잭션 지원
- **RIP-7212 지원**: P-256 서명 온체인 검증 (지원 체인)

## 설치

```bash
npm install @ohmywallet/connect
# or
pnpm add @ohmywallet/connect
# or
yarn add @ohmywallet/connect
```

## 빠른 시작

```typescript
import { IframeHost } from "@ohmywallet/connect";

// 1. 지갑 인스턴스 생성
const wallet = new IframeHost({
  iframeSrc: "https://vault.ohmywallet.xyz",
});

// 2. SignerType 기반 연결
const passkey = await wallet.connectWithSignerType({
  signerType: "passkey",
  dappName: "My Awesome dApp",
  dappIcon: "https://my-dapp.com/icon.png",
});

// 3. Passkey 서명 (P-256)
const messageHash = "0x...";
const passkeySig = await wallet.signWithPasskey(messageHash, {
  keyId: passkey.passkeys[0].keyId,
});

// 4. 파생 서명 (k1)
const derivation = await wallet.connectWithSignerType({ signerType: "derivation" });
const derivationSig = await wallet.signWithDerivation(messageHash, {
  address: derivation.addresses[0].address,
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

| 옵션        | 타입                   | 필수 | 설명                                             |
| ----------- | ---------------------- | ---- | ------------------------------------------------ |
| `iframeSrc` | `string`               | ✅   | OhMyWallet iframe URL                            |
| `timeout`   | `number`               | -    | 요청 타임아웃 (기본: 30000ms)                    |
| `sandbox`   | `string`               | -    | iframe sandbox 속성                              |
| `container` | `HTMLElement`          | -    | iframe 삽입 위치                                 |
| `locale`    | `"ko" \| "en" \| "zh"` | -    | iframe UI 언어 (기본: 브라우저 언어 또는 `"ko"`) |
| `origin`    | `string`               | -    | dApp origin (기본: `window.location.origin`)     |

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

파생 주소(k1)로 서명합니다.

```typescript
const sig = await wallet.signWithDerivation("0x1234...abcd", {
  address: derivation.addresses[0].address,
});
```

##### `show() / hide()`

지갑 모달을 표시하거나 숨깁니다.

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
      const result = await walletRef.current.connectWithSignerType({
        signerType: "derivation",
        dappName: "My React dApp",
      });
      setAddress(result.addresses[0]?.address ?? null);
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
    const result = await wallet.value.connectWithSignerType({
      signerType: "derivation",
      dappName: "My Vue dApp",
    });
    address.value = result.addresses[0]?.address ?? null;
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
    const result = await wallet.connectWithSignerType({
      signerType: "derivation",
      dappName: "My dApp",
    });
    const address = result.addresses[0]?.address;
    document.getElementById("address").textContent = address ?? "-";
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

| 코드                  | 설명                   |
| --------------------- | ---------------------- |
| `NOT_INITIALIZED`     | 지갑이 초기화되지 않음 |
| `ALREADY_INITIALIZED` | 이미 초기화됨          |
| `TIMEOUT`             | 요청 시간 초과         |
| `DESTROYED`           | 인스턴스가 파괴됨      |
| `SIGN_FAILED`         | 서명 실패              |
| `INVALID_ORIGIN`      | 허용되지 않은 origin   |
| `USER_CANCELLED`      | 사용자가 취소함        |

## 지원 체인

| 체인         | Chain ID | RIP-7212 |
| ------------ | -------- | -------- |
| Base         | 8453     | ✅       |
| Base Sepolia | 84532    | ✅       |
| Optimism     | 10       | ✅       |
| Arbitrum     | 42161    | -        |
| Polygon      | 137      | -        |
| Ethereum     | 1        | -        |

> RIP-7212 지원 체인에서는 P-256 직접 서명으로 최고 수준의 보안을 제공합니다.

## TypeScript

이 패키지는 TypeScript로 작성되었으며 완전한 타입 정의를 제공합니다.

```typescript
import type {
  IframeHostConfig,
  IframeHostState,
  ConnectResultData,
  SignResultData,
  IframeErrorCode,
} from "@ohmywallet/connect";
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
- [GitHub](https://github.com/ohmywallet/ohmywallet)
- [문서](https://docs.ohmywallet.xyz)

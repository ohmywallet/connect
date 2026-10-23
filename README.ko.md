# @ohmywallet/connect

EIP-1193 Provider 또는 wagmi 커넥터로 dApp에 OhMyWallet을 연결하세요. 서비스에 맞는 연결 방식을 선택할 수 있습니다.

| 연결 방식                                       | 사용자 경험                                              | 연결 계정                                                          |
| ----------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| Embed · `createProvider()` / `ohmywallet()`     | 서비스 안의 지갑 화면과 별도 Vault 승인 창               | 패스키로 파생한 EVM 기본 계정. App에서는 수수료 지갑이라고 불러요. |
| App · `createAppProvider()` / `ohmywalletApp()` | WalletConnect로 OhMyWallet App을 열고 지갑에서 요청 확인 | App에서 사용자가 선택한 준비된 관리 지갑(Safe)                     |

[English](./README.md) · [데모](https://demo.ohmywallet.xyz/connect) · [공개 Connect 스냅샷](https://github.com/ohmywallet/connect)

두 방식은 별도 세션이며 App 로그인·연결 권한·브라우저 저장소를 서비스와 공유하지 않습니다. 개인키와 PRF 비밀값은 Vault 밖으로 전달하지 않으며, SDK가 직접 WebAuthn 인증을 실행하지 않습니다.

## 실제 연결부터 확인하세요

- **App의 관리 Safe 연결:** [App 연결 데모 바로 열기](https://demo.ohmywallet.xyz/connect?wallet=app&lang=ko). 선택한 테스트넷의 관리 Safe가 준비되어 있어야 합니다. 이 데모는 승인된 계정 연결·조회만 하며 서명이나 자금 이동은 하지 않습니다.
- **서비스 안의 기본 EVM 계정 연결:** [Embed 데모 바로 열기](https://demo.ohmywallet.xyz/connect?wallet=embed&lang=ko). App에 표시된 관리 Safe와 별개의 기본 계정을 연결합니다.

데모는 설정이 완료된 서비스에서 실행됩니다. 자신의 origin에서 SDK를 실행하려면 아래 사전 조건이 필요하며, 패키지 설치만으로 설정이 끝나지는 않습니다.

## 단일 파일 React 스타터 실행

[connect-starter.tsx 다운로드](https://www.ohmywallet.xyz/examples/connect-starter.tsx.txt).

Vite의 React TypeScript 프로젝트처럼 **기존 React TypeScript 클라이언트**에 넣어 실행하는 소스입니다. 독립 HTML 파일이나 브라우저에서 직접 불러오는 스크립트 URL이 아닙니다. 새 앱 구조·CSS 프레임워크·QR 의존성은 필요하지 않습니다.

1. 기존 클라이언트 프로젝트에서 SDK와 선택형 App peer를 설치합니다.

   ```sh
   npm install @ohmywallet/connect@0.8.1 @walletconnect/sign-client@^2.23.10
   ```

2. 다운로드한 파일을 `src/ConnectStarter.tsx`로 저장합니다. 기존 `src/App.tsx`를 다음 내용으로 바꿉니다.

   ```tsx
   import ConnectStarter from "./ConnectStarter";

   export default function App() {
     return <ConnectStarter locale="ko" />;
   }
   ```

3. `npm run dev`처럼 기존 개발 명령으로 실행한 뒤 **App** 또는 **Embed**를 선택하고 사전 설정을 완료합니다.

   | 방식  | 연결 전 필요한 것                                                                                                                                                                                                                                                                                  |
   | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | App   | [Reown 대시보드](https://dashboard.reown.com/)에서 프로젝트를 만들고 공개 식별자인 32자리 프로젝트 ID를 입력합니다. OhMyWallet App에 **Base Sepolia** 관리 Safe를 준비합니다. 지갑 준비는 이 예제와 별도이며 테스트넷 수수료가 필요할 수 있습니다.                                                 |
   | Embed | 프로토콜·호스트명·포트를 포함한 [정확한 origin 등록](mailto:hello@ohmywallet.xyz)을 OhMyWallet에 문의합니다. 로컬 개발 origin도 포함하며 스타터가 localhost나 임의 도메인을 자동 허용하지 않습니다. CSP `frame-src`에 `https://embed.ohmywallet.xyz`를 허용하고 별도 Vault 승인 팝업도 허용합니다. |

4. **지갑 연결**을 누릅니다. App은 생성된 **App에서 연결 승인** 링크를 누르고 App에서 연결을 승인한 뒤 돌아옵니다. Embed는 표시된 Embed/Vault 연결 흐름을 완료합니다. 성공 기준은 링크를 열거나 인증을 시작한 상태가 아닌 **실제로 승인된 주소와 체인 ID**입니다.

스타터는 Base Sepolia(`84532`)에서 `eth_requestAccounts`만 요청합니다. 서명·거래 제출·서버 로그인 세션 생성·새로고침 후 자동 연결은 하지 않습니다. App 링크는 같은 기기에서 이용합니다. 다른 기기용 QR이 필요하면 WalletConnect URI를 외부 QR 서비스에 보내는 대신 완성된 App 데모를 이용하세요.

취소·만료·연결 해제·이벤트 구독 해제·언마운트 정리를 포함하며, 늦게 온 응답이 취소한 세션을 복원하지 않습니다. 연결 링크는 메모리에서만 유지하고 상태가 바뀌면 지웁니다. 분석 도구·로그·영속 저장소로 보내지 마세요.

### 연결이 멈췄을 때

| 결과                                | 다음 행동                                                                                                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4001`                              | 사용자가 요청을 거절하거나 취소했습니다. 다시 버튼을 누른 경우에만 재연결합니다.                                                                                       |
| 링크 만료 / 만료 사유가 있는 `4900` | 새 연결 요청을 만들어주세요. 이전 링크를 다시 이용하지 않습니다.                                                                                                       |
| App 연결 전 `-32602`                | 공개 WalletConnect 프로젝트 ID를 확인합니다. 16진수 32자리여야 합니다.                                                                                                 |
| 그 밖의 오류                        | 선택한 방식의 사전 설정, 등록 origin, CSP·팝업 정책, 브라우저·패스키 호환성을 확인합니다. 스타터는 원시 요청이나 연결 URI를 출력하지 않고 숫자 오류 코드만 표시합니다. |

자체 App UI를 만들 때도 계정 요청 전에 구독하고 스타터와 같은 수명 관리를 유지하세요. 아래의 낮은 수준 예제는 API 설명이며, 주석만으로 실제 연결 UI가 완성되는 것은 아닙니다.

## 설치

```sh
npm install @ohmywallet/connect
```

ESM과 TypeScript 타입을 제공합니다. 임베딩할 서비스 도메인은 OhMyWallet에 등록해야 합니다. 등록은 [문의하기](mailto:hello@ohmywallet.xyz)를 이용하세요. 선택형 App 연결에는 아래 WalletConnect peer 의존성도 필요합니다.

## App으로 연결

1. 사용자가 서비스의 연결 버튼을 누릅니다.
2. 같은 기기에서 지갑을 여는 링크와 다른 기기용 QR을 보여줍니다.
3. App에서 사용자가 요청된 네트워크의 준비된 관리 지갑을 선택합니다.
4. 지갑에서 연결과 각 서명·거래 요청을 확인하고 승인합니다.
5. 서비스는 계정과 요청 결과를 받으며, 사용이 끝나면 연결을 해제합니다.

Embed iframe 대신 WalletConnect를 사용하는 경로입니다. [App 연결 데모](https://demo.ohmywallet.xyz/connect?wallet=app&lang=ko)에서 흐름을 확인할 수 있습니다.

```sh
npm install @ohmywallet/connect @walletconnect/sign-client
```

브라우저의 클라이언트 생명주기에서 Provider를 만들고, 계정 요청 **이전에** 상태를 구독해 연결 링크와 QR을 표시하세요.

```ts
import { createAppProvider } from "@ohmywallet/connect/app";

const provider = createAppProvider({
  projectId: "WC_PROJECT_ID",
  chainId: 8453,
  metadata: { name: "My dApp" },
  locale: "ko",
});

provider.on("stateChanged", (state) => {
  // 링크와 QR은 서비스 UI에서 제공합니다. 탭을 자동으로 열지 않습니다.
  // 상태가 바뀔 때마다 이전 연결 대기 화면을 지워 주세요.
  if (state.pairing) {
    const { uri, appUrl, expiresAt } = state.pairing;
    // 링크는 appUrl, QR 내용은 uri입니다. expiresAt에 둘 다 숨깁니다.
  }
});

// 연결 버튼:
const [account] = (await provider.request({
  method: "eth_requestAccounts",
})) as string[];
```

`appUrl`은 사용자가 직접 누르는 링크로 표시하세요. 새 탭을 사용한다면 `target="_blank" rel="noopener noreferrer"`를 설정합니다. 언어가 적용된 고정 App 주소이며 비공개 연결 URI는 fragment에만 담깁니다. `uri`는 QR 내용으로 사용하고, query·분석 도구·로그·영속 저장소에 넣지 마세요. 연결 완료·대기 해제·취소·종료·만료 시 QR과 링크를 지웁니다. App을 열거나 QR을 스캔하는 것만으로 연결을 승인하지 않습니다.

현재 App 링크·QR 경로는 App에서 배포·현재 제어권을 확인한 관리 지갑(Safe)을 연결합니다. 이 경로에서는 수수료 지갑 연결을 제공하지 않습니다. 어댑터는 EOA라고 가정하지 않고 서명을 전달하며, 계정 종류는 SDK 옵션으로 지정하지 않습니다. 세션은 체인 하나와 계정 하나에 고정됩니다. 변경하려면 명시적으로 연결을 끊고 다시 연결하며, 바뀐 세션을 조용히 받아들이지 않습니다. 세션은 메모리에서만 유지하고 새로고침 뒤 자동 복원하지 않습니다.

`personal_sign`, `eth_signTypedData_v4`, `eth_sendTransaction`은 익숙한 EIP-1193 요청으로 사용합니다. 사용자는 App과 Vault에서 요청을 확인하고 승인합니다. Safe 서명은 컨트랙트 서명이므로 연결한 체인에서 ERC-1271로 검증해야 합니다. 컨트랙트를 지원하는 viem 검증 기능 등을 사용할 수 있으며, EOA 주소 복구만으로 검증하면 안 됩니다. 일부 서비스나 EOA 전용 permit 서명은 관리 지갑과 호환되지 않습니다.

거래 요청의 반환값은 네트워크 거래 해시이며 실행 완료를 뜻하지 않습니다. receipt와 Safe의 관리 지갑 실행 결과를 확인하세요. 제출이 불확실한 요청을 자동으로 반복하지 마세요. 이 경로가 `eth_sign`, 원시 거래 서명, 일괄 실행, 가스 대납 또는 EIP-7702를 추가하지는 않습니다.

로그아웃하거나 명시적으로 다시 연결할 때 `provider.disconnect()`, 해당 화면을 해제할 때 `provider.destroy()`를 호출하세요. 취소는 로컬 요청을 정리하며, 지갑이 이미 제출한 거래를 되돌리지 않습니다.

### App과 wagmi

위 WalletConnect peer와 함께 `@wagmi/core`, `viem`을 설치하고 별도 커넥터를 사용하세요. 기존 `ohmywallet()` 커넥터는 계속 Embed를 이용합니다.

```ts
import { connect, createConfig } from "@wagmi/core";
import { ohmywalletApp } from "@ohmywallet/connect/app-wagmi";
import { http } from "viem";
import { base } from "viem/chains";

const config = createConfig({
  chains: [base],
  connectors: [
    ohmywalletApp({
      projectId: "WC_PROJECT_ID",
      chainId: base.id,
      metadata: { name: "My dApp" },
      locale: "ko",
    }),
  ],
  transports: { [base.id]: http() },
});

const connector = config.connectors[0];
const provider = await connector.getProvider();
provider.on("stateChanged", (state) => {
  // state.pairing으로 위의 링크·QR 화면을 만들고, 값이 없으면 지웁니다.
});

// 연결 버튼:
await connect(config, { connector });
```

## Embed 연결

흐름은 **dApp → Connect → Embed iframe → Vault 독립창**입니다. 별도의 OhMyWallet App은 필요하지 않습니다. 연결 계정과 권한은 Embed 세션에서만 관리하고, 새로고침·연결 해제 후에는 다시 연결합니다. 이 Provider는 관리 지갑(Safe)을 연결하지 않습니다.

브라우저의 클라이언트 생명주기에서 Provider를 한 번 만들고, 연결 버튼에서 요청하세요.

```ts
import { createProvider } from "@ohmywallet/connect";

const provider = createProvider({ chainId: 1 });

const [account] = (await provider.request({
  method: "eth_requestAccounts",
})) as string[];

// 로그아웃할 때:
provider.disconnect();

// 해당 화면을 해제할 때:
provider.destroy();
```

viem의 `custom(provider)` transport와 함께 사용할 수 있습니다. EVM 계정 연결, SIWE 로그인 메시지, EIP-712 구조화 데이터, 거래 전송과 네트워크 변경을 지원합니다. 사용자는 별도 지갑 창에서 요청을 확인하고 승인합니다.

지원 메인넷: Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche, Arc.
지원 테스트넷: Ethereum Sepolia, Base Sepolia, Arc Testnet. 네트워크 정보와 고정 RPC는 공통 체인 카탈로그를 따르며 임의 네트워크 등록은 지원하지 않습니다. Arc의 native USDC는 `value`와 가스에 18자리 단위를 사용하며 ERC-20 토큰 단위와 구분해야 합니다.

연결 후 [EIP-5792 `wallet_getCapabilities`](https://eips.ethereum.org/EIPS/eip-5792#wallet_getcapabilities)에 `[account, optionalHexChainIds]`를 전달할 수 있습니다. 지원하는 조회 네트워크에는 `atomic.status: "unsupported"`를 반환하고 미지원 네트워크는 생략합니다. 기능 조회는 인증이나 권한 추가를 시작하지 않으며, 이 Provider의 배치·가스비 대납·Safe 계정·EIP-7702 지원을 의미하지 않습니다.

## Embed와 wagmi

`@wagmi/core` 3용 선택형 진입점입니다. SDK와 함께 `@wagmi/core`, `viem`을 설치하세요.

```ts
import { connect, createConfig, disconnect } from "@wagmi/core";
import { ohmywallet } from "@ohmywallet/connect/wagmi";
import { http } from "viem";
import { mainnet } from "viem/chains";

const config = createConfig({
  chains: [mainnet],
  connectors: [ohmywallet()],
  transports: { [mainnet.id]: http() },
});

// 연결 버튼:
await connect(config, { connector: config.connectors[0] });

// 로그아웃할 때:
await disconnect(config);
```

## Embed 연동 시 확인할 사항

- CSP의 `frame-src`에 `https://embed.ohmywallet.xyz`를 허용하고, 지갑 승인 팝업을 허용하세요.
- 요청 실패를 서비스 화면에서 처리하세요. 오류 코드 `4001`은 사용자 거절·취소입니다. 거래 전송은 자동 재시도하지 마세요.
- `accountsChanged`, `chainChanged` 이벤트를 반영하세요. 새로고침 후 다시 연결해야 하며, `disconnect()`는 현재 Provider 세션을 해제합니다.
- 잔액·거래 상태·로그인 세션은 서비스에서 관리합니다. SIWE challenge 검증과 nonce 소비는 서비스의 인증 계층에서 처리하세요.
- Connect는 현재 EVM 계정을 지원합니다. 전체 지갑 화면, 가스 대납, 일괄 거래는 제공하지 않습니다.

## 라이선스

MIT

## 0.8.1 릴리스

공개 저장소 메타데이터와 태그에 결합된 npm 출처 증명 발행 환경을 수정합니다. App·Embed API와 지갑 동작은 유지합니다.

## 보안

[현재 지갑 보안 모델](https://www.ohmywallet.xyz/ko/security/) · [비공개 보안 제보](mailto:support@ohmywallet.xyz)

제품 전체 소스는 비공개입니다. 공개 Connect 스냅샷은 최신 패키지 및 운영 서비스와 다를 수 있습니다. 서명 중 PRF 파생 키는 Vault JavaScript 메모리에 존재하며, 하드웨어 지갑 수준의 보호를 보장하지 않습니다.

# @ohmywallet/connect

EIP-1193 Provider 또는 wagmi 커넥터로 dApp에 OhMyWallet을 연결하세요.
Connect SDK는 Embed iframe과 Vault 독립창으로 EVM 지갑 연결·메시지 승인·거래 요청을 처리합니다. 별도의 OhMyWallet App은 필요하지 않습니다.

[English](./README.md) · [데모](https://demo.ohmywallet.xyz/connect) · [공개 Connect 스냅샷](https://github.com/ohmywallet/connect)

흐름은 **dApp → Connect → Embed iframe → Vault 독립창**입니다. 연결 계정과 권한은 Embed 세션에서만 관리하며 App 로그인이나 공유 저장소에 의존하지 않습니다. 개인키와 PRF 비밀값은 Vault 밖으로 전달하지 않습니다. 새로고침·연결 해제 후에는 다시 연결합니다.

## 설치

```sh
npm install @ohmywallet/connect
```

ESM과 TypeScript 타입을 제공합니다. 임베딩할 서비스 도메인은 OhMyWallet에 등록해야 합니다. 등록은 [문의하기](mailto:hello@ohmywallet.xyz)를 이용하세요.

## 연결

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

지원 네트워크: Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche, Sepolia.

## wagmi

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

## 연동 시 확인할 사항

- CSP의 `frame-src`에 `https://embed.ohmywallet.xyz`를 허용하고, 지갑 승인 팝업을 허용하세요.
- 요청 실패를 서비스 화면에서 처리하세요. 오류 코드 `4001`은 사용자 거절·취소입니다. 거래 전송은 자동 재시도하지 마세요.
- `accountsChanged`, `chainChanged` 이벤트를 반영하세요. 새로고침 후 다시 연결해야 하며, `disconnect()`는 현재 Provider 세션을 해제합니다.
- 잔액·거래 상태·로그인 세션은 서비스에서 관리합니다. SIWE challenge 검증과 nonce 소비는 서비스의 인증 계층에서 처리하세요.
- Connect는 현재 EVM 계정을 지원합니다. 전체 지갑 화면, 가스 대납, 일괄 거래는 제공하지 않습니다.

## 라이선스

MIT

## 보안

[현재 지갑 보안 모델](https://www.ohmywallet.xyz/ko/security/) · [비공개 보안 제보](mailto:support@ohmywallet.xyz)

제품 전체 소스는 비공개입니다. 공개 Connect 스냅샷은 최신 패키지 및 운영 서비스와 다를 수 있습니다. 서명 중 PRF 파생 키는 Vault JavaScript 메모리에 존재하며, 하드웨어 지갑 수준의 보호를 보장하지 않습니다.

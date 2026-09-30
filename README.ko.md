# @ohmywallet/connect — 공개 소스 스냅샷

[English](./README.md) · [현재 SDK 패키지](https://www.npmjs.com/package/@ohmywallet/connect) · [제품 문서](https://www.ohmywallet.xyz/ko/#developers)

이 저장소는 현재 **0.6.2 소스 스냅샷**을 포함합니다. 최신 npm 패키지나 운영 App·Embed·Vault와 다를 수 있습니다. 제품 전체 소스나 독립 보안 감사 결과로 해석하지 말고 설치하는 패키지의 버전을 확인해 주세요.

## 현재 제품 구조

현재 Connect 제품의 흐름은 dApp → Connect → Embed iframe → 별도 Vault 창입니다. 임베디드 EVM 지갑 연결에는 독립 App이 필요하지 않습니다. 이는 현재 서비스 설명이며 이 저장소의 과거 스냅샷에 대한 호환성 보장은 아닙니다.

현재 PRF 지갑은 WebAuthn PRF의 비밀값으로 Vault JavaScript에서 서명 키를 파생합니다. 패스키 인증을 사용한다고 파생 지갑 키가 하드웨어 보안 칩 안에만 머무는 것은 아닙니다. 서명 중 키는 브라우저 메모리에 존재합니다. 출처 격리·CSP·새 인증은 일부 위험을 줄이지만, 악성 Vault 코드·배포 및 도메인 권한 탈취·감염된 브라우저나 기기의 위험은 남습니다.

복구에는 같은 패스키와 PRF 호환 브라우저·저장소가 필요합니다. 클라우드 동기화만으로 모든 기기에서 복구를 보장하지 않습니다. 하드웨어 지갑 수준의 보호나 공개 독립 감사 완료를 주장하지 않습니다.

현재 경로·지원 기능·한계는 [보안과 복구 안내](https://www.ohmywallet.xyz/ko/security/)와 [구조 설명 JSON](https://www.ohmywallet.xyz/security-model.json)을 확인해 주세요.

## 보안 제보

[SECURITY.md](./SECURITY.md)에 따라 support@ohmywallet.xyz로 비공개 제보해 주세요. 공개 이슈에 개인키·패스키 비밀값·인증 토큰을 게시하지 마세요.

## 패키지 배포

이 스냅샷의 과거 npm 배포 워크플로는 비활성화되어 있습니다. 오래된 소스를 최신 패키지 위에 독립적으로 배포하면 안 됩니다. 패키지 발행은 제품의 별도 검증된 릴리스 절차를 따르며, README 수정으로 npm 패키지가 발행되지는 않습니다.

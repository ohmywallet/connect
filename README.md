# @ohmywallet/connect

Connect OhMyWallet to your dApp with an EIP-1193 Provider or a wagmi connector.
The SDK uses the Embed iframe for EVM account connection and opens the independent Vault window for passkey authentication and signing. The standalone OhMyWallet App is not required.

Flow: **dApp → Connect → Embed iframe → Vault window**. Public account metadata and the connection grant live only in the Embed session; reload or disconnect requires reconnection. No App login or shared browser storage is required. Private keys and PRF secrets stay inside Vault.

[한국어](./README.ko.md) · [Demo](https://demo.ohmywallet.xyz/connect) · [Public Connect snapshot](https://github.com/ohmywallet/connect)

## Install

```sh
npm install @ohmywallet/connect
```

ESM with TypeScript types. Your service origin must be registered with OhMyWallet before embedding. [Contact](mailto:hello@ohmywallet.xyz) for registration.

## Connect

Create one Provider in your browser/client lifecycle. Request connection from your connect button.

```ts
import { createProvider } from "@ohmywallet/connect";

const provider = createProvider({ chainId: 1 });

const [account] = (await provider.request({
  method: "eth_requestAccounts",
})) as string[];

// On logout:
provider.disconnect();

// When the owning view unmounts:
provider.destroy();
```

The Provider works with viem’s `custom(provider)` transport. It supports EVM account access, SIWE login messages, EIP-712 typed data, transaction submission and network switching. Users review and approve requests in a separate wallet window.

Supported networks: Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche and Sepolia.

## wagmi

Optional entry point for `@wagmi/core` 3. Install `@wagmi/core` and `viem` alongside the SDK.

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

// Connect button:
await connect(config, { connector: config.connectors[0] });

// On logout:
await disconnect(config);
```

## Integration essentials

- Allow `https://embed.ohmywallet.xyz` in your CSP `frame-src`, and allow the wallet approval popup.
- Handle request rejections in your UI. Code `4001` means the user declined or cancelled; do not automatically retry a transaction submission.
- Listen for `accountsChanged` and `chainChanged`. A page reload requires reconnection; `disconnect()` clears this Provider session.
- Your app owns balances, transaction status and login sessions. Verify SIWE challenges and consume nonces in your authentication service.
- Connect currently supports EVM accounts. It does not provide the full wallet dashboard, gas sponsorship or batch transactions.

## License

MIT

## Security / 보안

[Current wallet security model](https://www.ohmywallet.xyz/en/security/) · [Report privately](mailto:support@ohmywallet.xyz)

The full product source is private. The public Connect snapshot may lag the published package and deployed services. PRF-derived keys exist in Vault JavaScript memory during signing; this is not hardware-wallet-equivalent protection.

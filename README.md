# @ohmywallet/connect

Connect OhMyWallet to your dApp with an EIP-1193 Provider or a wagmi connector. Choose the experience your service needs:

| Connection                                      | User experience                                                          | Account                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Embed · `createProvider()` / `ohmywallet()`     | Wallet interface in your service; independent Vault approval window      | Passkey-derived EVM basic account, called the fee wallet in App |
| App · `createAppProvider()` / `ohmywalletApp()` | Open OhMyWallet App through WalletConnect; review requests in the wallet | A prepared managed Safe account selected in App                 |

These paths have separate sessions. Neither shares App login, connection permissions or browser storage with your service. Private keys and PRF secrets stay inside Vault; the SDK does not perform WebAuthn authentication.

[한국어](./README.ko.md) · [Demo](https://demo.ohmywallet.xyz/connect) · [Public Connect snapshot](https://github.com/ohmywallet/connect)

## Start with a real connection

- **Managed Safe in App:** [Open the App connection demo](https://demo.ohmywallet.xyz/connect?wallet=app&lang=en). Have a prepared managed Safe on the selected testnet ready. The App demo connects and reads the approved account; it does not sign or transfer funds.
- **Basic EVM account in your service:** [Open the Embed demo](https://demo.ohmywallet.xyz/connect?wallet=embed&lang=en). This connects a separate basic account, not the managed Safe shown in App.

The demos run on a configured service. Running the same SDK on your own origin has the prerequisites below; installing the package alone does not complete setup.

## Run the single-file React starter

[Download connect-starter.tsx](https://www.ohmywallet.xyz/examples/connect-starter.tsx.txt).

The starter targets an **existing React TypeScript client**, such as a Vite React TypeScript app. It is source to compile in your app, not a standalone HTML file or a browser script URL. No new app scaffold, CSS framework or QR dependency is needed.

1. In your existing client project, install the SDK and its optional App peer:

   ```sh
   npm install @ohmywallet/connect@0.8.1 @walletconnect/sign-client@^2.23.10
   ```

2. Save the download as `src/ConnectStarter.tsx`. Replace your existing `src/App.tsx` with:

   ```tsx
   import ConnectStarter from "./ConnectStarter";

   export default function App() {
     return <ConnectStarter locale="en" />;
   }
   ```

3. Run your existing development command, for example `npm run dev`. Choose **App** or **Embed** and finish its setup:

   | Path  | Before connecting                                                                                                                                                                                                                                                                                                                          |
   | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | App   | Create a project in the [Reown dashboard](https://dashboard.reown.com/) and enter its public 32-character project ID. Prepare a managed Safe on **Base Sepolia** in OhMyWallet App. Preparing the wallet is separate from this example and may require testnet fees.                                                                       |
   | Embed | [Register your exact origin](mailto:hello@ohmywallet.xyz) with OhMyWallet, including scheme, hostname and port. This includes local development origins; the starter does not automatically allow localhost or arbitrary domains. Permit `https://embed.ohmywallet.xyz` in CSP `frame-src` and allow the independent Vault approval popup. |

4. Click **Connect wallet**. For App, click the generated **Open App to approve** link, approve the connection in App, then return. For Embed, complete the visible Embed/Vault connection flow. Success is the **actual approved address and chain ID**, not opening a link or starting authentication.

The starter uses Base Sepolia (`84532`) and requests only `eth_requestAccounts`. It never requests a signature, submits a transaction, creates a server login session, or restores a connection after reload. Its App link works on the same device. For a QR code on another device, use the complete App demo rather than sending a WalletConnect URI to an external QR service.

It includes cancellation, expiry, disconnect, event unsubscription and unmount cleanup. Old callbacks cannot restore a cancelled session. Pairing links stay in memory and are removed when the connection changes. Do not send them to analytics, logs or persistent storage.

### If connection stops

| Result                                   | Next action                                                                                                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4001`                                   | The request was declined or cancelled. Reconnect only after another user click.                                                                                                           |
| Expired link / `4900` with expiry reason | Connect again to create a new pairing. Do not reuse the previous link.                                                                                                                    |
| `-32602` before App connects             | Check the public WalletConnect project ID. It must contain 32 hexadecimal characters.                                                                                                     |
| Other failure                            | Check the selected path's setup, registered origin, CSP/popup policy and browser/passkey compatibility. The starter shows a numeric code without printing the raw request or pairing URI. |

For your own App UI, subscribe before requesting accounts and preserve the same lifecycle demonstrated by the starter. The lower-level snippets below describe the APIs; their comments are not a substitute for the runnable connection UI.

## Install

```sh
npm install @ohmywallet/connect
```

ESM with TypeScript types. Your service origin must be registered with OhMyWallet before embedding. [Contact](mailto:hello@ohmywallet.xyz) for registration. The optional App path also needs the WalletConnect peer dependency below.

## Connect through App

1. The user clicks your connect button.
2. Show a link to open the wallet on this device, plus a QR code for another device.
3. In App, the user chooses a prepared managed wallet on the requested network.
4. The user reviews the connection and each signing or transaction request in their wallet.
5. Your service receives the account and request results; disconnect when the user finishes.

This path uses WalletConnect rather than the Embed iframe. [Try the App connection demo](https://demo.ohmywallet.xyz/connect?wallet=app&lang=en).

```sh
npm install @ohmywallet/connect @walletconnect/sign-client
```

Create the Provider in your browser/client lifecycle. Subscribe **before** requesting accounts so your UI can show the pairing link and QR code:

```ts
import { createAppProvider } from "@ohmywallet/connect/app";

const provider = createAppProvider({
  projectId: "WC_PROJECT_ID",
  chainId: 8453,
  metadata: { name: "My dApp" },
  locale: "en",
});

provider.on("stateChanged", (state) => {
  // Your UI owns the link and QR code. No tab opens automatically.
  // Clear the previous pairing UI on every state update.
  if (state.pairing) {
    const { uri, appUrl, expiresAt } = state.pairing;
    // Link: appUrl; QR payload: uri; hide both at expiresAt.
  }
});

// Connect button:
const [account] = (await provider.request({
  method: "eth_requestAccounts",
})) as string[];
```

Render `appUrl` as a user-clicked link, for example with `target="_blank" rel="noopener noreferrer"`. It points to the fixed localized App URL and carries the private pairing URI in the fragment. Use `uri` only as the QR payload. Do not put it in a query string, analytics, logs or persistent storage. Remove the pairing view on connection, idle, cancellation, closure and expiry. Opening App or scanning the QR code is not connection approval.

The current App link and QR handoff connects a managed Safe account after App checks deployment and current control. Fee-wallet connection is not available through this handoff. The adapter transports signatures without assuming an EOA; account type is not an SDK option. One session is bound to one chain and one account. Changing either requires an explicit disconnect and new connection; a mutated session is rejected rather than silently switched. Sessions stay in memory, with no automatic restoration after a reload.

Use familiar EIP-1193 requests for `personal_sign`, `eth_signTypedData_v4` and `eth_sendTransaction`. Users still review and approve requests in App and Vault. Safe signatures are contract signatures: verify them with ERC-1271 on the connected chain, for example through a contract-aware viem verification action. EOA-only address recovery is insufficient. Some services and EOA-only permit signatures are incompatible with managed wallets.

Transaction submission returns a network transaction hash; it does not mean execution has completed. Track the receipt and, for a Safe, the managed-wallet execution result. Never automatically repeat an uncertain submission. This path does not add `eth_sign`, raw transaction signing, batch execution, gas sponsorship or EIP-7702.

Call `provider.disconnect()` on logout or explicit reconnection, and `provider.destroy()` when the owning view unmounts. Cancellation clears the local request; it cannot reverse a transaction that the wallet already submitted.

### App with wagmi

Install the optional WalletConnect peer above, plus `@wagmi/core` and `viem`. Use the separate connector; the existing `ohmywallet()` connector continues to use Embed.

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
      locale: "en",
    }),
  ],
  transports: { [base.id]: http() },
});

const connector = config.connectors[0];
const provider = await connector.getProvider();
provider.on("stateChanged", (state) => {
  // Render state.pairing as the link/QR view described above; clear when absent.
});

// Connect button:
await connect(config, { connector });
```

## Embed connection

Flow: **dApp → Connect → Embed iframe → Vault window**. The standalone OhMyWallet App is not required. Users authenticate and sign in the independent Vault window. Public account metadata and the connection grant live only in the Embed session; reload or disconnect requires reconnection. This Provider does not connect managed Safe accounts.

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

Supported mainnets: Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche and Arc.
Supported testnets: Ethereum Sepolia, Base Sepolia and Arc Testnet. Network metadata and fixed RPC endpoints follow the shared chain catalog; arbitrary network registration is not supported. Arc's native USDC uses 18 decimals for `value` and gas, independently of ERC-20 token units.

After connection, [EIP-5792 `wallet_getCapabilities`](https://eips.ethereum.org/EIPS/eip-5792#wallet_getcapabilities) accepts `[account, optionalHexChainIds]`. It reports `atomic.status: "unsupported"` for supported queried networks and omits unsupported networks. Capability queries do not open authentication or add permissions; batch requests, gas sponsorship, Safe accounts and EIP-7702 are not enabled by this Provider.

## Embed with wagmi

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

## Embed integration essentials

- Allow `https://embed.ohmywallet.xyz` in your CSP `frame-src`, and allow the wallet approval popup.
- Handle request rejections in your UI. Code `4001` means the user declined or cancelled; do not automatically retry a transaction submission.
- Listen for `accountsChanged` and `chainChanged`. A page reload requires reconnection; `disconnect()` clears this Provider session.
- Your app owns balances, transaction status and login sessions. Verify SIWE challenges and consume nonces in your authentication service.
- Connect currently supports EVM accounts. It does not provide the full wallet dashboard, gas sponsorship or batch transactions.

## License

MIT

## 0.8.1 release

This patch corrects public repository metadata and the tag-bound npm provenance publishing environment. The App and Embed APIs and wallet behavior are unchanged.

## Security / 보안

[Current wallet security model](https://www.ohmywallet.xyz/en/security/) · [Report privately](mailto:support@ohmywallet.xyz)

The full product source is private. The public Connect snapshot may lag the published package and deployed services. PRF-derived keys exist in Vault JavaScript memory during signing; this is not hardware-wallet-equivalent protection.

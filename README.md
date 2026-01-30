# @ohmywallet/connect

The official library for integrating OhMyWallet into your dApp.

[한국어](./README.ko.md)

## What is OhMyWallet?

**OhMyWallet** is a next-generation EVM smart wallet powered by PassKeys.

### Why OhMyWallet?

| Traditional Wallet Problems | OhMyWallet Solution                    |
| --------------------------- | -------------------------------------- |
| Memorize 12/24 seed words   | Biometric auth (Face ID, fingerprint)  |
| Private key exposure risk   | Isolated in hardware security chip     |
| Phishing attacks            | Origin verification & iframe isolation |
| New wallet per chain        | Single multi-chain wallet              |

### Key Benefits

- **No Seed Phrase**: Create and recover wallets with PassKey only
- **Hardware Security**: Private keys never exposed to browser
- **Cross-Device**: Same wallet on all devices via iCloud/Google sync
- **Account Abstraction**: Gas sponsorship, batch transactions
- **RIP-7212 Support**: On-chain P-256 signature verification (supported chains)

## Installation

```bash
npm install @ohmywallet/connect
# or
pnpm add @ohmywallet/connect
# or
yarn add @ohmywallet/connect
```

## Quick Start

```typescript
import { IframeHost } from "@ohmywallet/connect";

// 1. Create wallet instance
const wallet = new IframeHost({
  iframeSrc: "https://vault.ohmywallet.xyz",
});

// 2. Connect with signer type
const passkey = await wallet.connectWithSignerType({
  signerType: "passkey",
  dappName: "My Awesome dApp",
  dappIcon: "https://my-dapp.com/icon.png",
});

// 3. Passkey signature (P-256)
const messageHash = "0x...";
const passkeySig = await wallet.signWithPasskey(messageHash, {
  keyId: passkey.passkeys[0].keyId,
});

// 4. Derivation signature (k1)
const derivation = await wallet.connectWithSignerType({ signerType: "derivation" });
const derivationSig = await wallet.signWithDerivation(messageHash, {
  address: derivation.addresses[0].address,
});

// 5. Cleanup
wallet.destroy();
```

## API Reference

### `IframeHost`

Main class for communicating with OhMyWallet from your dApp.

#### Constructor

```typescript
const wallet = new IframeHost(config: IframeHostConfig);
```

| Option      | Type                   | Required | Description                                            |
| ----------- | ---------------------- | -------- | ------------------------------------------------------ |
| `iframeSrc` | `string`               | ✅       | OhMyWallet iframe URL                                  |
| `timeout`   | `number`               | -        | Request timeout (default: 30000ms)                     |
| `sandbox`   | `string`               | -        | iframe sandbox attribute                               |
| `container` | `HTMLElement`          | -        | Container for iframe insertion                         |
| `locale`    | `"ko" \| "en" \| "zh"` | -        | iframe UI locale (default: browser language or `"ko"`) |
| `origin`    | `string`               | -        | dApp origin (default: `window.location.origin`)        |

#### Methods

##### `connectWithSignerType(options): Promise<ConnectResult>`

Connect using a signer type.

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

P-256 signature using PassKey.

```typescript
const sig = await wallet.signWithPasskey("0x1234...abcd", {
  keyId: passkey.passkeys[0].keyId,
});
```

##### `signWithDerivation(hash, options): Promise<DerivationSignResult>`

k1 signature using a derived address.

```typescript
const sig = await wallet.signWithDerivation("0x1234...abcd", {
  address: derivation.addresses[0].address,
});
```

##### `show() / hide()`

Show or hide the wallet modal.

##### `destroy()`

Cleanup instance and release resources.

#### Properties

| Property       | Type              | Description                                                      |
| -------------- | ----------------- | ---------------------------------------------------------------- |
| `currentState` | `IframeHostState` | Current state (`idle`, `loading`, `ready`, `error`, `destroyed`) |

#### Events

```typescript
// General events
wallet.onEvent("error", (error) => { ... });
wallet.onEvent("destroyed", () => { ... });
```

## Framework Integration

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
      {isConnecting ? "Connecting..." : "Connect Wallet"}
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
    {{ address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "Connect Wallet" }}
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
    console.log("Signature:", signature);
  };
</script>

<button id="connect-btn">Connect Wallet</button>
<button id="sign-btn">Sign Message</button>
<p>Address: <span id="address">-</span></p>
```

## Security

### Iframe Isolation

OhMyWallet uses an **iframe isolation architecture**:

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
│  │  │ PassKey + Private   │  │  │
│  │  │ Key (never exposed) │  │  │
│  │  └─────────────────────┘  │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

- **Key Isolation**: Private keys exist only within iframe context
- **Origin Verification**: Only authorized dApps can communicate
- **postMessage Communication**: Only signatures transmitted (never private keys)

### Recommended CSP

```
frame-src https://vault.ohmywallet.xyz;
```

## Error Handling

```typescript
import { IframeError } from "@ohmywallet/connect";

try {
  await wallet.connectWithSignerType({ signerType: "derivation" });
} catch (error) {
  if (error instanceof IframeError) {
    switch (error.code) {
      case "TIMEOUT":
        console.error("Request timed out");
        break;
      case "USER_CANCELLED":
        console.error("User cancelled");
        break;
      case "NOT_INITIALIZED":
        console.error("Wallet not initialized");
        break;
      default:
        console.error("Wallet error:", error.message);
    }
  }
}
```

### Error Codes

| Code                  | Description            |
| --------------------- | ---------------------- |
| `NOT_INITIALIZED`     | Wallet not initialized |
| `ALREADY_INITIALIZED` | Already initialized    |
| `TIMEOUT`             | Request timed out      |
| `DESTROYED`           | Instance destroyed     |
| `SIGN_FAILED`         | Signature failed       |
| `INVALID_ORIGIN`      | Unauthorized origin    |
| `USER_CANCELLED`      | User cancelled         |

## Advanced Usage

### ZKsync Era Integration

When integrating with ZKsync Era, you need to properly structure EIP-712 transactions. Here's a complete example:

```typescript
import { IframeHost } from "@ohmywallet/connect";
import { Contract, Interface, parseUnits, hexlify } from "ethers";
import { Provider, EIP712Signer, utils } from "zksync-ethers";

// 1. Connect wallet
const wallet = new IframeHost({
  iframeSrc: "https://vault.ohmywallet.xyz",
});

const result = await wallet.connectWithSignerType({
  signerType: "derivation",
  dappName: "My ZKsync dApp",
});

const userAddress = result.addresses[0].address;

// 2. Setup provider and contract
const provider = new Provider("https://sepolia.era.zksync.dev");
const contract = new Contract(contractAddress, contractABI, provider);

// 3. Encode function data
const iface = new Interface(contractABI);
const data = iface.encodeFunctionData("transfer", [toAddress, parseUnits("1", 18)]);

// 4. Build transaction
const [chain, feeData, nonce] = await Promise.all([
  provider.getNetwork(),
  provider.getFeeData(),
  provider.getTransactionCount(userAddress),
]);

const tx = {
  type: utils.EIP712_TX_TYPE,
  chainId: chain.chainId,
  from: userAddress,
  to: contractAddress,
  data,
  value: 0n,
  maxFeePerGas: feeData.maxFeePerGas ?? 1n,
  maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? feeData.maxFeePerGas ?? 1n,
  nonce,
  gasLimit: 1_000_000n, // Estimate first if needed
  customData: {
    gasPerPubdata: utils.DEFAULT_GAS_PER_PUBDATA_LIMIT,
    customSignature: "0x", // Will be filled after signing
  },
};

// 5. Generate EIP-712 digest and sign
const digest = EIP712Signer.getSignedDigest(tx);
const signResult = await wallet.signWithDerivation(hexlify(digest), {
  address: userAddress,
});

// 6. ⚠️ IMPORTANT: Add signature to transaction
tx.customData.customSignature = signResult.signature;

// 7. Serialize and broadcast
const serialized = utils.serializeEip712(tx);
const response = await provider.broadcastTransaction(serialized);
await response.wait();

console.log("Transaction hash:", response.hash);
```

#### Important Notes for ZKsync Era

1. **Custom Signature Field**

   ```typescript
   // ❌ Wrong: Signature in second parameter
   const serialized = utils.serializeEip712(tx, signature);

   // ✅ Correct: Signature in tx.customData
   tx.customData.customSignature = signature;
   const serialized = utils.serializeEip712(tx);
   ```

2. **EIP-712 Digest**
   - Use `EIP712Signer.getSignedDigest(tx)` to generate the correct digest
   - Sign the digest (not the transaction directly)

3. **Gas Estimation**

   ```typescript
   const estimate = await provider.estimateGas({
     ...tx,
     customData: {
       gasPerPubdata: utils.DEFAULT_GAS_PER_PUBDATA_LIMIT,
     },
   });
   tx.gasLimit = estimate;
   ```

4. **Paymaster Support** (Optional)

   ```typescript
   const paymasterParams = utils.getPaymasterParams(paymasterAddress, {
     type: "ApprovalBased",
     token: tokenAddress,
     minimalAllowance: gasLimit * maxFeePerGas,
     innerInput: new Uint8Array(),
   });

   tx.customData.paymasterParams = paymasterParams;
   ```

### Content Security Policy (CSP)

If your dApp uses strict CSP headers, ensure they don't block React event handlers or Next.js features:

**Recommended CSP for Next.js:**

```typescript
// next.config.js
async headers() {
  return [
    {
      source: "/:path*",
      headers: [
        {
          key: "Content-Security-Policy",
          value: [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'", // Required for React
            "frame-src https://vault.ohmywallet.xyz",
            "connect-src 'self' https://*.zksync.dev", // Add RPC endpoints
          ].join("; "),
        },
      ],
    },
  ];
}
```

**Common CSP Issues:**

- `script-src 'self'` only → Blocks React event handlers
- Missing `frame-src` → Blocks OhMyWallet iframe
- Too strict in development → Use conditional CSP:

```typescript
if (process.env.NODE_ENV === "development") {
  return []; // No CSP in development
}
```

## Supported Chains

| Chain        | Chain ID | RIP-7212 |
| ------------ | -------- | -------- |
| Base         | 8453     | ✅       |
| Base Sepolia | 84532    | ✅       |
| Optimism     | 10       | ✅       |
| Arbitrum     | 42161    | -        |
| Polygon      | 137      | -        |
| Ethereum     | 1        | -        |

> RIP-7212 supported chains provide the highest security with native P-256 signature verification.

## TypeScript

This package is written in TypeScript and provides complete type definitions.

```typescript
import type {
  IframeHostConfig,
  IframeHostState,
  ConnectResultData,
  SignResultData,
  IframeErrorCode,
} from "@ohmywallet/connect";
```

## Browser Support

- Chrome 67+
- Firefox 60+
- Safari 14+
- Edge 79+

> Requires WebAuthn (PassKey) support.

## License

MIT

## Links

- [OhMyWallet Website](https://ohmywallet.xyz)
- [GitHub](https://github.com/anthropics/ohmywallet)
- [Documentation](https://docs.ohmywallet.xyz)

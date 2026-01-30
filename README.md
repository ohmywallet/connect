# @ohmywallet/connect

The official library for integrating OhMyWallet into your dApp.

[한국어](./README.ko.md)

## What is OhMyWallet?

**OhMyWallet** is a next-generation multi-chain smart wallet powered by PassKeys.

Supports **EVM**, **Solana**, and **Bitcoin** with a single PassKey.

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
- **Multi-Chain**: EVM, Solana, Bitcoin from one PassKey
- **WalletConnect**: Connect to thousands of dApps
- **15 Languages**: Full i18n support (ko, en, zh-CN, zh-TW, ja, es, fr, de, pt, ru, ar, hi, id, vi, tr)

## Installation

```bash
npm install @ohmywallet/connect
# or
pnpm add @ohmywallet/connect
# or
yarn add @ohmywallet/connect
```

## Which Signer Should I Use?

OhMyWallet supports **two signing methods**. Choose explicitly based on your needs:

### 🔐 PassKey Signer (Hardware Security ★★★★★)

**Recommended for**: Chains with [RIP-7212](https://github.com/ethereum/RIPs/blob/master/RIPS/rip-7212.md) support

**Pros:**

- ✅ **Hardware-secured**: Private key **never** exposed (stored in device secure chip)
- ✅ **WebAuthn**: Uses biometrics (Face ID, Touch ID, Windows Hello)
- ✅ **P-256 native**: Direct signature verification on-chain
- ✅ **Maximum security**: Best protection against key theft

**Cons:**

- ❌ **Limited chains**: Only RIP-7212 compatible chains
- ❌ **Smart wallet required**: Ethereum mainnet needs AA (Account Abstraction)

**Supported Chains:**

| Chain         | Chain ID | Native RIP-7212 | Notes                 |
| ------------- | -------- | --------------- | --------------------- |
| zkSync Era    | 324      | ✅              | Full support          |
| Polygon zkEVM | 1101     | ✅              | Full support          |
| Linea         | 59144    | ✅              | Full support          |
| Scroll        | 534352   | ✅              | Full support          |
| Ethereum\*    | 1        | ⚠️              | Requires smart wallet |
| Arbitrum\*    | 42161    | ⚠️              | Requires smart wallet |
| Optimism\*    | 10       | ⚠️              | Requires smart wallet |

\*Can use PassKey via Account Abstraction (ERC-4337)

---

### 🔑 Derivation Signer (Universal ★★★☆☆)

**Recommended for**: All chains without RIP-7212, or multi-chain dApps

**Pros:**

- ✅ **Universal**: Works on **all** chains (EVM, Solana, Bitcoin, etc.)
- ✅ **Multi-chain**: Single PassKey → derive keys for any chain
- ✅ **No AA required**: Works with EOAs (regular wallets)
- ✅ **All curves**: secp256k1 (EVM/Bitcoin), ed25519 (Solana)

**Cons:**

- ⚠️ **Lower security**: Private key exists in JavaScript memory (iframe-isolated)
- ⚠️ **Software-based**: Not hardware-secured like PassKey

**Supported Chains:**

- **EVM**: Ethereum, Arbitrum, Optimism, Base, BSC, Polygon, Avalanche, Fantom...
- **Non-EVM**: Solana, Bitcoin, Cosmos, Near...
- **All chains**: Any blockchain using secp256k1 or ed25519

---

### Decision Guide

```
Your dApp uses...

┌─────────────────────────────────┐
│  zkSync Era, Polygon zkEVM,     │
│  Linea, Scroll                  │  →  ✅ Use PassKey (best security)
└─────────────────────────────────┘

┌─────────────────────────────────┐
│  Ethereum mainnet (EOA)         │
│  Arbitrum, Optimism, Base       │  →  ✅ Use Derivation
│  BSC, Polygon PoS               │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│  Solana, Bitcoin                │  →  ✅ Use Derivation (only option)
└─────────────────────────────────┘

┌─────────────────────────────────┐
│  Multi-chain support            │  →  ✅ Use Derivation (universal)
└─────────────────────────────────┘

┌─────────────────────────────────┐
│  Ethereum mainnet (AA wallet)   │  →  ✅ Use PassKey (if you implement AA)
└─────────────────────────────────┘
```

**⚠️ Important**: PassKey and Derivation generate **different addresses**. Choose one and stick with it for your dApp.

---

## Quick Start

### Option 1: PassKey Signer (Hardware Security)

```typescript
import { IframeHost } from "@ohmywallet/connect";

// 1. Create wallet instance
const wallet = new IframeHost({
  iframeSrc: "https://vault.ohmywallet.xyz",
});

// 2. Connect with PassKey
const result = await wallet.connectWithSignerType({
  signerType: "passkey", // Explicit choice
  dappName: "My Awesome dApp",
  dappIcon: "https://my-dapp.com/icon.png",
});

// 3. Sign with active PassKey (P-256)
if (!result.activePasskey) {
  throw new Error("No active PassKey");
}

const sig = await wallet.signWithPasskey("0x1234...abcd", {
  keyId: result.activePasskey.keyId, // Use active PassKey
});

// 4. Cleanup
wallet.destroy();
```

### Option 2: Derivation Signer (Universal)

```typescript
import { IframeHost } from "@ohmywallet/connect";

// 1. Create wallet instance
const wallet = new IframeHost({
  iframeSrc: "https://vault.ohmywallet.xyz",
});

// 2. Connect with Derivation
const result = await wallet.connectWithSignerType({
  signerType: "derivation", // Explicit choice
  dappName: "My Awesome dApp",
  dappIcon: "https://my-dapp.com/icon.png",
});

// 3. Sign with active address (secp256k1, ed25519, etc.)
if (!result.activeAddress) {
  throw new Error("No active address");
}

const sig = await wallet.signWithDerivation("0x1234...abcd", {
  address: result.activeAddress.address, // Use active address
});

// 4. Cleanup
wallet.destroy();
```

## API Reference

### `IframeHost`

Main class for communicating with OhMyWallet from your dApp.

#### Constructor

```typescript
const wallet = new IframeHost(config: IframeHostConfig);
```

| Option      | Type              | Required | Description                                                      |
| ----------- | ----------------- | -------- | ---------------------------------------------------------------- |
| `iframeSrc` | `string`          | ✅       | OhMyWallet iframe URL                                            |
| `timeout`   | `number`          | -        | Request timeout (default: 30000ms)                               |
| `sandbox`   | `string`          | -        | iframe sandbox attribute                                         |
| `container` | `HTMLElement`     | -        | Container for iframe insertion                                   |
| `locale`    | `SupportedLocale` | -        | iframe UI locale - 15 languages supported (default: auto-detect) |
| `origin`    | `string`          | -        | dApp origin (default: `window.location.origin`)                  |

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

Signature using a derived key (secp256k1/ed25519).

**Option 1: By address** (recommended)

```typescript
const sig = await wallet.signWithDerivation("0x1234...abcd", {
  address: derivation.addresses[0].address,
});
```

**Option 2: By group + keyIndex**

```typescript
const sig = await wallet.signWithDerivation("0x1234...abcd", {
  group: "evm", // "evm" | "solana" | "bitcoin"
  keyIndex: 0,
});
```

##### `deriveAddress(options): Promise<DeriveAddressResult>`

Derive a new address without connecting.

```typescript
const result = await wallet.deriveAddress({
  keyIndex: 1,
  curve: "secp256k1", // "secp256k1" | "ed25519"
  group: "evm", // "evm" | "solana" | "bitcoin"
});
// → { address: { address: "0x...", keyIndex: 1, curve: "secp256k1", group: "evm" } }

// For Bitcoin
const btcResult = await wallet.deriveAddress({
  keyIndex: 0,
  curve: "secp256k1",
  group: "bitcoin",
  bitcoinAddressType: "p2wpkh", // "p2wpkh" | "p2tr"
  bitcoinNetwork: "mainnet", // "mainnet" | "testnet4"
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
      setAddress(result.activeAddress?.address ?? null);
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
    address.value = result.activeAddress?.address ?? null;
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
    const address = result.activeAddress?.address;
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

| Code                      | Description                       |
| ------------------------- | --------------------------------- |
| `NOT_INITIALIZED`         | Wallet not initialized            |
| `ALREADY_INITIALIZED`     | Already initialized               |
| `TIMEOUT`                 | Request timed out                 |
| `DESTROYED`               | Instance destroyed                |
| `SIGN_FAILED`             | Signature failed                  |
| `INVALID_MESSAGE`         | Invalid message format            |
| `INVALID_ORIGIN`          | Unauthorized origin               |
| `VALIDATION_FAILED`       | Payload validation failed         |
| `CREDENTIAL_INACCESSIBLE` | PassKey credential not accessible |
| `ALREADY_EXISTS`          | Wallet already exists             |
| `USER_CANCELLED`          | User cancelled the operation      |
| `UNKNOWN_KEY`             | PassKey keyId not found           |
| `UNKNOWN_ADDRESS`         | Derivation address not found      |

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

## TypeScript

This package is written in TypeScript and provides complete type definitions.

```typescript
import type {
  IframeHostConfig,
  IframeHostState,
  ConnectResult,
  SignResult,
  IframeErrorCode,
} from "@ohmywallet/connect";
```

### Type Guards

Use type guards to safely narrow union types:

```typescript
import {
  isPasskeyResult,
  isDerivationResult,
  isPasskeySignResult,
  isDerivationSignResult,
} from "@ohmywallet/connect";

// Connect result
const result = await wallet.connectWithSignerType({ signerType: "passkey" });

if (isPasskeyResult(result)) {
  // TypeScript knows result is PasskeyConnectResult
  console.log(result.passkeys);
  console.log(result.activePasskey?.keyId);
}

if (isDerivationResult(result)) {
  // TypeScript knows result is DerivationConnectResult
  console.log(result.addresses);
  console.log(result.activeAddress?.address);
}

// Sign result
const sig = await wallet.signWithPasskey(hash, { keyId });

if (isPasskeySignResult(sig)) {
  // TypeScript knows sig is PasskeySignResult
  console.log(sig.signature.r, sig.signature.s);
  console.log(sig.authenticatorData);
}

if (isDerivationSignResult(sig)) {
  // TypeScript knows sig is DerivationSignResult
  console.log(sig.signature); // Hex string
}
```

### Reference Helpers

Check chain compatibility (for reference only, not for automatic selection):

```typescript
import { supportsRIP7212, RIP7212_NATIVE_CHAINS } from "@ohmywallet/connect";

// Check if chain natively supports RIP-7212
if (supportsRIP7212(324)) {
  console.log("zkSync Era supports PassKey natively");
}

// List of chains with native RIP-7212 support
console.log(RIP7212_NATIVE_CHAINS); // [324, 1101, 59144, 534352]

// ⚠️ Important: Do NOT use for automatic signerType selection
// ❌ BAD: const signerType = supportsRIP7212(chainId) ? "passkey" : "derivation";
// ✅ GOOD: Always choose signerType explicitly
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
- [GitHub](https://github.com/ohmywallet/connect)
- [Documentation](https://docs.ohmywallet.xyz)

import {
  createPublicClient,
  defineChain,
  http,
  isAddress,
  serializeTransaction,
  parseTransaction,
  recoverTransactionAddress,
  verifyMessage,
  verifyTypedData,
  hexToString,
  keccak256,
  type Address,
  type Hex,
  type TransactionSerialized,
  type Chain,
} from "viem";
import {
  mainnet,
  base,
  arbitrum,
  optimism,
  polygon,
  bsc,
  avalanche,
  sepolia,
  arc,
  arcTestnet,
  baseSepolia,
} from "viem/chains";
import { IframeHost } from "./index";
import { DEVELOPMENT_CHAIN_ID, connectEnvironment } from "./deployment";
import type {
  IframeHostConfig,
  PrimaryConnectResult,
  PrimarySignResult,
  EvmSigningRequest,
  EvmSignOptions,
} from "./types";

// Fixed public metadata projection. Catalog consistency is checked offline in tests;
// Connect's runtime remains independent of workspace data and wallet packages.
const chainIds = [1, 8453, 42161, 10, 137, 56, 43114, 11155111, 5042, 84532, 5042002] as const;
const existingChains: readonly Chain[] = [
  mainnet,
  base,
  arbitrum,
  optimism,
  polygon,
  bsc,
  avalanche,
  sepolia,
  arc,
  arcTestnet,
  baseSepolia,
];
const reviewedMetadata = {
  1: {
    name: "Ethereum",
    currency: "Ethereum",
    symbol: "ETH",
    rpc: "https://ethereum-rpc.publicnode.com",
    explorer: "https://etherscan.io",
    testnet: false,
  },
  8453: {
    name: "Base",
    currency: "Ethereum",
    symbol: "ETH",
    rpc: "https://mainnet.base.org",
    explorer: "https://basescan.org",
    testnet: false,
  },
  42161: {
    name: "Arbitrum One",
    currency: "Ethereum",
    symbol: "ETH",
    rpc: "https://arb1.arbitrum.io/rpc",
    explorer: "https://arbiscan.io",
    testnet: false,
  },
  10: {
    name: "Optimism",
    currency: "Ethereum",
    symbol: "ETH",
    rpc: "https://mainnet.optimism.io",
    explorer: "https://optimistic.etherscan.io",
    testnet: false,
  },
  137: {
    name: "Polygon",
    currency: "POL",
    symbol: "POL",
    rpc: "https://polygon.drpc.org",
    explorer: "https://polygonscan.com",
    testnet: false,
  },
  56: {
    name: "BNB Smart Chain",
    currency: "BNB",
    symbol: "BNB",
    rpc: "https://bsc-dataseed.binance.org",
    explorer: "https://bscscan.com",
    testnet: false,
  },
  43114: {
    name: "Avalanche C-Chain",
    currency: "Avalanche",
    symbol: "AVAX",
    rpc: "https://api.avax.network/ext/bc/C/rpc",
    explorer: "https://snowtrace.io",
    testnet: false,
  },
  11155111: {
    name: "Ethereum Sepolia",
    currency: "Ethereum",
    symbol: "ETH",
    rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
    testnet: true,
  },
  5042: {
    name: "Arc",
    currency: "USDC",
    symbol: "USDC",
    rpc: "https://arc-rpc.publicnode.com",
    explorer: "https://explorer.arc.io",
    testnet: false,
  },
  84532: {
    name: "Base Sepolia",
    currency: "Ethereum",
    symbol: "ETH",
    rpc: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
    testnet: true,
  },
  5042002: {
    name: "Arc Testnet",
    currency: "USDC",
    symbol: "USDC",
    rpc: "https://arc-testnet.drpc.org",
    explorer: "https://testnet.arcscan.app",
    testnet: true,
  },
} as const;
const chains: readonly Chain[] = Object.freeze(
  chainIds.map((id) => {
    const entry = reviewedMetadata[id];
    const chain = existingChains.find((chain) => chain.id === id);
    if (!chain) throw new Error("Missing reviewed Connect chain");
    return defineChain({
      ...chain,
      id,
      name: entry.name,
      nativeCurrency: Object.freeze({ name: entry.currency, symbol: entry.symbol, decimals: 18 }),
      rpcUrls: { default: { http: [entry.rpc] } },
      blockExplorers: { default: { name: entry.name, url: entry.explorer } },
      testnet: entry.testnet,
    });
  })
);
export const CONNECT_CAPABILITIES = Object.freeze({
  version: 1,
  wallet: "prf",
  accounts: "evm",
  message: true,
  typedData: true,
  transactionTypes: Object.freeze(["legacy", "eip1559"]),
  deriveAddress: false,
  rawSigning: false,
  batch: false,
  sponsorship: false,
  chainIds: Object.freeze(chains.map((chain) => chain.id)),
});
export class ProviderRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: { transactionHash: string; chainId: number }
  ) {
    super(message);
    this.name = "ProviderRpcError";
  }
}
interface Host {
  connect(): Promise<PrimaryConnectResult>;
  sign(request: EvmSigningRequest, options: EvmSignOptions): Promise<PrimarySignResult>;
  cancel(): boolean;
  disconnect?(): void;
  destroy(): void;
}
export interface ConnectProviderOptions {
  chainId?: number;
  hostConfig?: IframeHostConfig;
}
type Event = "accountsChanged" | "chainChanged" | "connect" | "disconnect";
type Listener = (value: unknown) => void;
const fail = (code: number, message: string): never => {
  throw new ProviderRpcError(code, message);
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail(-32602, "Invalid parameters");
  return value as Record<string, unknown>;
}
function address(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value)) return fail(-32602, "Invalid account");
  return value;
}
function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value))
    return fail(-32602, "Invalid quantity");
  return BigInt(value);
}
const readonlyMethods = new Set([
  "eth_blockNumber",
  "eth_getBalance",
  "eth_getCode",
  "eth_call",
  "eth_estimateGas",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_gasPrice",
  "eth_feeHistory",
  "eth_maxPriorityFeePerGas",
  "eth_getLogs",
]);
/** EIP-1193 adapter. Accounts are session-local; reconnect always requires consent.
 * disconnect revokes this provider session, not all browser/site permissions. */
export class ConnectProvider {
  #host: Host;
  #account: Address | undefined;
  #chain: (typeof chains)[number];
  #epoch = 0;
  #busy = false;
  #destroyed = false;
  readonly #development: boolean;
  #listeners = new Map<Event, Set<Listener>>();
  constructor(options: ConnectProviderOptions = {}, host?: Host) {
    this.#development = connectEnvironment(options.hostConfig?.environment) === "development";
    const chain = chains.find(
      (c) => c.id === (options.chainId ?? (this.#development ? DEVELOPMENT_CHAIN_ID : mainnet.id))
    );
    if (!chain) throw new ProviderRpcError(4902, "Unsupported chain");
    if (this.#development && chain.id !== DEVELOPMENT_CHAIN_ID)
      throw new ProviderRpcError(4902, "Development Connect supports only Base Sepolia");
    this.#chain = chain;
    this.#host = host ?? new IframeHost(options.hostConfig);
  }
  on(event: Event, listener: Listener): this {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
    return this;
  }
  removeListener(event: Event, listener: Listener): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }
  #emit(event: Event, value: unknown) {
    for (const listener of this.#listeners.get(event) ?? []) {
      try {
        listener(value);
      } catch {
        /* Consumer callbacks cannot change protocol success. */
      }
    }
  }
  cancel(): boolean {
    ++this.#epoch;
    return this.#host.cancel();
  }
  disconnect(): void {
    ++this.#epoch;
    this.#account = undefined;
    if (this.#host.disconnect) this.#host.disconnect();
    else this.#host.cancel();
    this.#emit("accountsChanged", []);
  }
  destroy(): void {
    if (this.#destroyed) return;
    this.disconnect();
    this.#destroyed = true;
    this.#host.destroy();
    this.#emit("disconnect", new ProviderRpcError(4900, "Provider destroyed"));
    this.#listeners.clear();
  }
  async request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown> {
    if (this.#destroyed) return fail(4900, "Provider destroyed");
    if (!args || typeof args.method !== "string") return fail(-32600, "Invalid request");
    if (args.params !== undefined && !Array.isArray(args.params))
      return fail(-32602, "Expected positional parameters");
    const params = (args.params ?? []) as readonly unknown[];
    if (args.method === "eth_accounts") return this.#account ? [this.#account] : [];
    if (args.method === "eth_chainId") return `0x${this.#chain.id.toString(16)}`;
    if (args.method === "wallet_getCapabilities") {
      if (params.length < 1 || params.length > 2)
        return fail(-32602, "Expected an account and optional chain IDs");
      const requestedAccount = address(params[0]);
      if (!this.#account || requestedAccount.toLowerCase() !== this.#account.toLowerCase())
        return fail(4100, "Account not authorized");
      let selected = this.#development
        ? chains.filter((chain) => chain.id === DEVELOPMENT_CHAIN_ID)
        : chains;
      if (params.length === 2) {
        if (!Array.isArray(params[1])) return fail(-32602, "Expected chain IDs");
        const requested = new Set(params[1].map(quantity));
        // EIP-5792 omits unsupported queried chains instead of rejecting them.
        selected = selected.filter((chain) => requested.has(BigInt(chain.id)));
      }
      return Object.fromEntries(
        selected.map((chain) => [
          `0x${chain.id.toString(16)}`,
          { atomic: { status: "unsupported" } },
        ])
      );
    }
    if (readonlyMethods.has(args.method))
      return createPublicClient({ chain: this.#chain, transport: http() }).request({
        method: args.method,
        params,
      } as never);
    if (
      ![
        "eth_requestAccounts",
        "personal_sign",
        "eth_signTypedData_v4",
        "eth_sendTransaction",
        "wallet_switchEthereumChain",
      ].includes(args.method)
    )
      return fail(4200, "Unsupported method");
    if (this.#busy) return fail(-32002, "A wallet request is already pending");
    this.#busy = true;
    const epoch = this.#epoch;
    const current = () => {
      if (epoch !== this.#epoch || this.#destroyed) fail(4001, "Request cancelled");
    };
    try {
      if (args.method === "eth_requestAccounts") {
        const result = await this.#host.connect();
        current();
        if (result.address.group !== "evm") return fail(4200, "Unsupported account");
        const next = address(result.address.address);
        const changed = next !== this.#account;
        this.#account = next;
        this.#emit("connect", { chainId: `0x${this.#chain.id.toString(16)}` });
        if (changed) this.#emit("accountsChanged", [next]);
        return [next];
      }
      if (!this.#account) return fail(4100, "Connect an account first");
      const account = this.#account;
      if (args.method === "wallet_switchEthereumChain") {
        if (params.length !== 1) return fail(-32602, "Invalid parameters");
        const id = quantity(object(params[0]).chainId);
        if (this.#development && id !== BigInt(DEVELOPMENT_CHAIN_ID))
          return fail(4902, "Development Connect supports only Base Sepolia");
        const next = chains.find((c) => BigInt(c.id) === id);
        if (!next) return fail(4902, "Unsupported chain");
        if (next.id !== this.#chain.id) {
          this.#chain = next;
          ++this.#epoch;
          this.#emit("chainChanged", `0x${next.id.toString(16)}`);
        }
        return null;
      }
      const chainId = this.#chain.id;
      const requireAccount = (value: unknown) => {
        if (address(value).toLowerCase() !== account.toLowerCase())
          fail(4100, "Account not authorized");
      };
      if (args.method === "personal_sign") {
        if (params.length !== 2) return fail(-32602, "Invalid parameters");
        requireAccount(params[1]);
        if (typeof params[0] !== "string" || !/^0x(?:[a-f0-9]{2})*$/i.test(params[0]))
          return fail(-32602, "Expected UTF-8 encoded message");
        const bytes = params[0] as Hex;
        const message = hexToString(bytes);
        // No replacement characters: this MVP deliberately supports UTF-8 text only.
        if (message.includes("\ufffd")) return fail(4200, "Binary message signing is unsupported");
        const result = await this.#host.sign(
          { kind: "message", message: { type: "text", value: message }, context: { chainId } },
          { address: account }
        );
        current();
        if (
          result.address.toLowerCase() !== account.toLowerCase() ||
          !(await verifyMessage({
            address: account,
            message: { raw: bytes },
            signature: result.signature,
          }))
        )
          return fail(-32603, "Invalid signature result");
        current();
        return result.signature;
      }
      if (args.method === "eth_signTypedData_v4") {
        if (params.length !== 2) return fail(-32602, "Invalid parameters");
        requireAccount(params[0]);
        const data = object(typeof params[1] === "string" ? JSON.parse(params[1]) : params[1]);
        const typedData = JSON.parse(JSON.stringify(data)) as Extract<
          EvmSigningRequest,
          { kind: "typedData" }
        >["typedData"];
        if (
          !typedData.domain ||
          !typedData.types ||
          typeof typedData.primaryType !== "string" ||
          !typedData.message
        )
          return fail(-32602, "Invalid typed data");
        if (
          typedData.domain.chainId !== undefined &&
          BigInt(typedData.domain.chainId as string) !== BigInt(chainId)
        )
          return fail(-32602, "Chain mismatch");
        const result = await this.#host.sign(
          { kind: "typedData", typedData, context: { chainId } },
          { address: account }
        );
        current();
        const { EIP712Domain: _domain, ...types } = typedData.types;
        if (
          result.address.toLowerCase() !== account.toLowerCase() ||
          !(await verifyTypedData({
            ...typedData,
            types,
            address: account,
            signature: result.signature,
          }))
        )
          return fail(-32603, "Invalid signature result");
        current();
        return result.signature;
      }
      if (params.length !== 1) return fail(-32602, "Invalid parameters");
      const tx = JSON.parse(JSON.stringify(object(params[0]))) as Record<string, unknown>;
      const allowed = new Set([
        "from",
        "to",
        "value",
        "data",
        "gas",
        "gasPrice",
        "maxFeePerGas",
        "maxPriorityFeePerGas",
        "nonce",
        "chainId",
        "type",
      ]);
      if (Object.keys(tx).some((key) => !allowed.has(key)))
        return fail(4200, "Unsupported transaction fields");
      requireAccount(tx.from);
      const to = address(tx.to);
      if (tx.chainId !== undefined && quantity(tx.chainId) !== BigInt(chainId))
        return fail(-32602, "Chain mismatch");
      if (tx.type !== undefined && tx.type !== "0x0" && tx.type !== "0x2")
        return fail(4200, "Unsupported transaction type");
      if (
        tx.gasPrice !== undefined &&
        (tx.maxFeePerGas !== undefined ||
          tx.maxPriorityFeePerGas !== undefined ||
          tx.type === "0x2")
      )
        return fail(-32602, "Conflicting fee fields");
      if (
        tx.type === "0x0" &&
        (tx.maxFeePerGas !== undefined || tx.maxPriorityFeePerGas !== undefined)
      )
        return fail(-32602, "Conflicting fee fields");
      const data = (tx.data ?? "0x") as Hex;
      if (typeof data !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(data) || data.length > 32770)
        return fail(-32602, "Invalid transaction data");
      const value = tx.value === undefined ? 0n : quantity(tx.value);
      const client = createPublicClient({ chain: this.#chain, transport: http() });
      if ((await client.getChainId()) !== chainId) return fail(4901, "RPC chain mismatch");
      current();
      const estimated = await client.estimateGas({ account, to, value, data });
      current();
      const gas = tx.gas === undefined ? (estimated * 120n + 99n) / 100n : quantity(tx.gas);
      if (gas < estimated) return fail(-32602, "Gas limit is below estimate");
      const nonceValue =
        tx.nonce === undefined
          ? BigInt(await client.getTransactionCount({ address: account, blockTag: "pending" }))
          : quantity(tx.nonce);
      current();
      if (nonceValue > BigInt(Number.MAX_SAFE_INTEGER)) return fail(-32602, "Invalid nonce");
      const common = { chainId, to, value, data, gas, nonce: Number(nonceValue) };
      let unsigned: Hex;
      let fee: bigint;
      if (tx.gasPrice !== undefined || tx.type === "0x0") {
        const gasPrice =
          tx.gasPrice === undefined ? await client.getGasPrice() : quantity(tx.gasPrice);
        unsigned = serializeTransaction({ ...common, type: "legacy", gasPrice });
        fee = gasPrice;
      } else {
        const fees = await client.estimateFeesPerGas();
        const maxFeePerGas =
          tx.maxFeePerGas === undefined ? fees.maxFeePerGas : quantity(tx.maxFeePerGas);
        const maxPriorityFeePerGas =
          tx.maxPriorityFeePerGas === undefined
            ? fees.maxPriorityFeePerGas
            : quantity(tx.maxPriorityFeePerGas);
        if (maxPriorityFeePerGas > maxFeePerGas) return fail(-32602, "Invalid fee cap");
        unsigned = serializeTransaction({
          ...common,
          type: "eip1559",
          maxFeePerGas,
          maxPriorityFeePerGas,
        });
        fee = maxFeePerGas;
      }
      current();
      if ((await client.getBalance({ address: account })) < value + gas * fee)
        return fail(-32000, "Insufficient balance including fees");
      current();
      const result = await this.#host.sign(
        { kind: "transaction", serializedTransaction: unsigned, context: { chainId } },
        { address: account }
      );
      current();
      const signed = parseTransaction(result.signature);
      const original = serializeTransaction({
        ...signed,
        r: undefined,
        s: undefined,
        v: undefined,
        yParity: undefined,
      } as Parameters<typeof serializeTransaction>[0]);
      if (
        original !== unsigned ||
        signed.chainId !== chainId ||
        result.address.toLowerCase() !== account.toLowerCase() ||
        (
          await recoverTransactionAddress({
            serializedTransaction: result.signature as TransactionSerialized,
          })
        ).toLowerCase() !== account.toLowerCase()
      )
        return fail(-32603, "Invalid transaction result");
      current();
      const hash = await client.sendRawTransaction({ serializedTransaction: result.signature });
      if (hash.toLowerCase() !== keccak256(result.signature))
        return fail(-32603, "Unexpected transaction hash");
      return hash;
    } catch (error) {
      if (error instanceof ProviderRpcError) throw error;
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "USER_CANCELLED") return fail(4001, "User rejected the request");
      if (code === "TIMEOUT") return fail(4001, "Request expired");
      if (code === "INVALID_MESSAGE" || error instanceof SyntaxError)
        return fail(-32602, "Invalid request parameters");
      return fail(-32603, "Wallet request failed");
    } finally {
      this.#busy = false;
    }
  }
}
export function createProvider(options: ConnectProviderOptions = {}): ConnectProvider {
  return new ConnectProvider(options);
}

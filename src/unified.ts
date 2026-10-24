import { createAppProvider, type AppProviderOptions, type AppProviderState } from "./app";
import { ManagedEmbedProvider } from "./managed-embed";
import { createProvider, ProviderRpcError } from "./provider";
import type { IframeHostConfig, SupportedLocale } from "./types";

export type ConnectAccount = "managed" | "fee";
export type ConnectTransport = "embedded" | "walletconnect";
interface CommonOptions {
  account?: ConnectAccount;
  chainId?: number;
  locale?: SupportedLocale;
}
export type UnifiedConnectOptions = CommonOptions &
  (
    | { transport?: "embedded"; hostConfig?: IframeHostConfig; projectId?: never; metadata?: never }
    | {
        transport: "walletconnect";
        projectId: string;
        metadata: AppProviderOptions["metadata"];
        hostConfig?: never;
      }
  );
export interface UnifiedConnectState extends AppProviderState {
  readonly account: ConnectAccount;
  readonly transport: ConnectTransport;
}
type Event = "accountsChanged" | "chainChanged" | "connect" | "disconnect" | "stateChanged";
type Listener = (value: unknown) => void;
type RpcRequest = { method: string; params?: readonly unknown[] | object };
const READ_METHODS = new Set([
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
interface Adapter {
  request(args: RpcRequest): Promise<unknown>;
  on(event: never, listener: Listener): unknown;
  removeListener(event: never, listener: Listener): unknown;
  cancel(): boolean;
  disconnect(): Promise<void> | void;
  destroy(): void;
}

/** A new opt-in facade. Existing root and App adapters keep their published defaults. */
export class UnifiedConnectProvider {
  readonly #adapter: Adapter;
  readonly #listeners = new Map<Event, Set<Listener>>();
  readonly #subscriptions: [Event, Listener][] = [];
  #state: UnifiedConnectState;
  #epoch = 0;
  #destroyed = false;
  #pending = false;
  #readProvider?: { chainId: number; provider: ReturnType<typeof createProvider> };

  constructor(options: UnifiedConnectOptions = {}) {
    const account = options.account ?? "managed";
    const transport = options.transport ?? "embedded";
    if (!["managed", "fee"].includes(account) || !["embedded", "walletconnect"].includes(transport))
      throw new ProviderRpcError(-32602, "Invalid account or connection transport");
    const chainId = options.chainId ?? 1;
    this.#state = Object.freeze({ account, transport, chainId, status: "idle", busy: false });
    if (options.transport === "walletconnect") {
      if (options.hostConfig !== undefined)
        throw new ProviderRpcError(-32602, "Embed configuration does not apply to WalletConnect");
      this.#adapter = createAppProvider({ ...options, account });
    } else {
      const hostConfig = {
        ...options.hostConfig,
        ...(options.locale ? { locale: options.locale } : {}),
      };
      this.#adapter =
        account === "managed"
          ? new ManagedEmbedProvider({ chainId, hostConfig })
          : createProvider({ chainId, hostConfig });
    }
    for (const event of ["accountsChanged", "chainChanged", "connect", "disconnect"] as const) {
      const listener = (value: unknown) => {
        if (this.#destroyed) return;
        if (event === "accountsChanged") {
          const address =
            Array.isArray(value) && value.length === 1 && typeof value[0] === "string"
              ? value[0]
              : undefined;
          this.#update({ address, status: address ? "connected" : "idle", pairing: undefined });
        } else if (
          event === "chainChanged" &&
          typeof value === "string" &&
          /^0x[0-9a-f]+$/iu.test(value)
        ) {
          this.#update({ chainId: Number(BigInt(value)) });
        } else if (event === "disconnect") {
          ++this.#epoch;
          this.#update({ address: undefined, status: "idle", busy: false, pairing: undefined });
        }
        this.#emit(event, value);
      };
      this.#adapter.on(event as never, listener);
      this.#subscriptions.push([event, listener]);
    }
    if (transport === "walletconnect") {
      const listener = (value: unknown) => {
        if (this.#destroyed) return;
        this.#update(value as AppProviderState);
      };
      this.#adapter.on("stateChanged" as never, listener);
      this.#subscriptions.push(["stateChanged", listener]);
    }
  }
  get currentState(): UnifiedConnectState {
    return this.#state;
  }
  on(event: "stateChanged", listener: (state: UnifiedConnectState) => void): this;
  on(event: Event, listener: Listener): this;
  on(event: Event, listener: Listener | ((state: UnifiedConnectState) => void)): this {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(listener as Listener);
    this.#listeners.set(event, listeners);
    return this;
  }
  removeListener(event: "stateChanged", listener: (state: UnifiedConnectState) => void): this;
  removeListener(event: Event, listener: Listener): this;
  removeListener(event: Event, listener: Listener | ((state: UnifiedConnectState) => void)): this {
    this.#listeners.get(event)?.delete(listener as Listener);
    return this;
  }
  #emit(event: Event, value: unknown) {
    for (const listener of this.#listeners.get(event) ?? []) {
      try {
        listener(value);
      } catch {
        /* UI callbacks cannot change connection authority. */
      }
    }
  }
  #update(next: Partial<AppProviderState>) {
    this.#state = Object.freeze({
      ...this.#state,
      ...next,
      account: this.#state.account,
      transport: this.#state.transport,
    });
    this.#emit("stateChanged", this.#state);
  }
  async request(args: RpcRequest): Promise<unknown> {
    if (this.#destroyed) throw new ProviderRpcError(4900, "Provider destroyed");
    if (READ_METHODS.has(args?.method)) {
      if (this.#readProvider?.chainId !== this.#state.chainId) {
        this.#readProvider?.provider.destroy();
        this.#readProvider = {
          chainId: this.#state.chainId,
          provider: createProvider({ chainId: this.#state.chainId }),
        };
      }
      // This adapter receives only the closed public read-method set, never account or signing requests.
      return this.#readProvider.provider.request(args);
    }
    const passive = ["eth_accounts", "eth_chainId", "wallet_getCapabilities"].includes(
      args?.method
    );
    if (passive) return this.#adapter.request(args);
    if (this.#pending) throw new ProviderRpcError(-32002, "A wallet request is already pending");
    const epoch = this.#epoch;
    this.#pending = true;
    this.#update({
      busy: true,
      ...(args?.method === "eth_requestAccounts" ? { status: "connecting" as const } : {}),
    });
    try {
      if (epoch !== this.#epoch || this.#destroyed)
        throw new ProviderRpcError(4001, "Request cancelled");
      const result = await this.#adapter.request(args);
      if (epoch !== this.#epoch || this.#destroyed)
        throw new ProviderRpcError(4001, "Request cancelled");
      return result;
    } finally {
      this.#pending = false;
      if (!this.#destroyed && epoch === this.#epoch)
        this.#update({ busy: false, status: this.#state.address ? "connected" : "idle" });
    }
  }
  cancel(): boolean {
    ++this.#epoch;
    const cancelled = this.#adapter.cancel();
    this.#update({
      busy: false,
      status: this.#state.address ? "connected" : "idle",
      pairing: undefined,
    });
    return cancelled;
  }
  async disconnect(): Promise<void> {
    ++this.#epoch;
    this.#readProvider?.provider.destroy();
    this.#readProvider = undefined;
    this.#update({ address: undefined, status: "idle", busy: false, pairing: undefined });
    await this.#adapter.disconnect();
  }
  destroy(): void {
    if (this.#destroyed) return;
    ++this.#epoch;
    this.#destroyed = true;
    this.#readProvider?.provider.destroy();
    this.#readProvider = undefined;
    for (const [event, listener] of this.#subscriptions)
      this.#adapter.removeListener(event as never, listener);
    this.#adapter.destroy();
    this.#state = Object.freeze({
      ...this.#state,
      address: undefined,
      status: "closed",
      busy: false,
      pairing: undefined,
    });
    this.#emit("stateChanged", this.#state);
    this.#emit("disconnect", new ProviderRpcError(4900, "Provider destroyed"));
    this.#listeners.clear();
  }
}
export function createConnectProvider(options: UnifiedConnectOptions = {}): UnifiedConnectProvider {
  return new UnifiedConnectProvider(options);
}

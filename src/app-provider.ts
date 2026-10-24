import { isAddress } from "viem";
import { createClient, memoryStorage, type AppClientOptions } from "./app-client";
import {
  APP_CHAIN_IDS,
  APP_METHODS,
  APP_EVENTS,
  fail,
  object,
  quantity,
  sameAddress,
  sessionAccount,
  pairingInfo,
  rpcError,
  type AppSignClient,
  type AppProtocolEvent,
  type AppProtocolSession,
} from "./app-protocol";
import {
  AppProviderRpcError,
  type AppProviderOptions,
  type AppProviderState,
  type AppProviderEvent,
  type AppProviderListener,
} from "./app-types";

const locales = [
  "ko",
  "en",
  "zh-CN",
  "zh-TW",
  "es",
  "hi",
  "id",
  "vi",
  "ru",
  "pt",
  "tr",
  "ja",
  "fr",
  "de",
  "ar",
];
const UNKNOWN_SUBMISSION = "Transaction outcome unknown; check App activity before retrying";
interface Context {
  topic: string;
  pairingTopic: string;
  address: string;
  expiry: number;
}
/** Internal test seam; it is absent from the package's public entrypoints. */
export interface AppProviderDependencies {
  createClient?(options: AppClientOptions): Promise<AppSignClient>;
  origin?(): string;
  now?(): number;
  nonce?(): string;
}

/** Session authority stays in memory. This adapter never authenticates, signs or submits directly. */
export class AppProviderRuntime {
  readonly #options: AppProviderOptions;
  readonly #dependencies: AppProviderDependencies;
  #state: AppProviderState;
  #client?: AppSignClient;
  #context?: Context;
  #pairingTopic?: string;
  #epoch = 0;
  #busy = false;
  #destroyed = false;
  #dispatchedTransaction = false;
  #submissionUncertain = false;
  #rejectPending?: (error: Error) => void;
  #expiryTimer?: ReturnType<typeof setTimeout>;
  #listeners = new Map<AppProviderEvent, Set<AppProviderListener>>();
  #protocolListeners: [AppProtocolEvent, (value: unknown) => void][] = [];

  constructor(options: AppProviderOptions, dependencies: AppProviderDependencies = {}) {
    if (
      !options ||
      !/^[a-f0-9]{32}$/iu.test(options.projectId) ||
      !options.metadata ||
      typeof options.metadata.name !== "string" ||
      !options.metadata.name.trim() ||
      options.metadata.name.length > 128 ||
      (options.account !== undefined &&
        options.account !== "managed" &&
        options.account !== "fee") ||
      (options.metadata.description !== undefined &&
        (typeof options.metadata.description !== "string" ||
          options.metadata.description.length > 512)) ||
      (options.locale !== undefined && !locales.includes(options.locale))
    )
      fail(-32602, "Invalid App connector configuration");
    const chainId = options.chainId ?? 1;
    if (!(APP_CHAIN_IDS as readonly number[]).includes(chainId))
      fail(4902, "Unsupported App network");
    const icons = options.metadata.icons ?? [];
    if (
      !Array.isArray(icons) ||
      icons.length > 3 ||
      icons.some((icon) => {
        try {
          return (
            typeof icon !== "string" || icon.length > 2048 || new URL(icon).protocol !== "https:"
          );
        } catch {
          return true;
        }
      })
    )
      fail(-32602, "Invalid App connector icons");
    this.#options = { ...options, chainId, metadata: { ...options.metadata, icons: [...icons] } };
    this.#dependencies = dependencies;
    this.#state = Object.freeze({ status: "idle", chainId, busy: false });
  }
  get currentState(): AppProviderState {
    return this.#state;
  }
  #now() {
    return (this.#dependencies.now ?? Date.now)();
  }
  on(event: AppProviderEvent, listener: AppProviderListener): this {
    const values = this.#listeners.get(event) ?? new Set();
    values.add(listener);
    this.#listeners.set(event, values);
    return this;
  }
  removeListener(event: AppProviderEvent, listener: AppProviderListener): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }
  #emit(event: AppProviderEvent, value: unknown) {
    for (const listener of this.#listeners.get(event) ?? []) {
      try {
        listener(value);
      } catch {
        /* Consumer presentation cannot authorize protocol work. */
      }
    }
  }
  #stateChanged(next: AppProviderState) {
    this.#state = Object.freeze(next);
    this.#emit("stateChanged", this.#state);
  }
  #alive(epoch: number) {
    if (this.#destroyed || epoch !== this.#epoch) fail(4001, "Request cancelled");
  }
  #clearTimer() {
    if (this.#expiryTimer !== undefined) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = undefined;
  }
  #expireAt(expiresAt: number, epoch: number) {
    this.#clearTimer();
    this.#expiryTimer = setTimeout(
      () => {
        if (epoch === this.#epoch)
          void this.#stop(new AppProviderRpcError(4900, "Wallet connection expired", "expired"));
      },
      Math.max(1, Math.min(expiresAt - this.#now(), 2_147_483_647))
    );
    this.#expiryTimer.unref?.();
  }
  async #cleanup(client: AppSignClient, context?: Context, pairingTopic?: string) {
    // A remote relay failure must not retain local session data or delay disconnect indefinitely.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([
          context
            ? client.disconnect({
                topic: context.topic,
                reason: { code: 6000, message: "USER_DISCONNECTED" },
              })
            : undefined,
          pairingTopic ? client.disconnectPairing(pairingTopic) : undefined,
        ]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5_000);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await client.close().catch(() => {});
    }
  }
  async #stop(reason = new AppProviderRpcError(4001, "Request cancelled")) {
    ++this.#epoch;
    this.#clearTimer();
    const client = this.#client,
      context = this.#context,
      pairingTopic = this.#pairingTopic;
    this.#client = undefined;
    this.#context = undefined;
    this.#pairingTopic = undefined;
    if (client) for (const [event, handler] of this.#protocolListeners) client.off(event, handler);
    this.#protocolListeners = [];
    this.#rejectPending?.(
      this.#dispatchedTransaction ? new AppProviderRpcError(-32000, UNKNOWN_SUBMISSION) : reason
    );
    this.#rejectPending = undefined;
    this.#busy = false;
    this.#dispatchedTransaction = false;
    this.#stateChanged({
      status: this.#destroyed ? "closed" : "idle",
      chainId: this.#state.chainId,
      busy: false,
    });
    if (context) {
      this.#emit("accountsChanged", []);
      this.#emit("disconnect", new AppProviderRpcError(4900, "Wallet disconnected"));
    }
    if (client) await this.#cleanup(client, context, pairingTopic);
  }
  cancel(): boolean {
    if (!this.#busy || this.#destroyed) return false;
    void this.#stop();
    return true;
  }
  disconnect(): Promise<void> {
    return this.#stop();
  }
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    void this.#stop();
    this.#listeners.clear();
  }
  #current(epoch: number) {
    this.#alive(epoch);
    const context = this.#context,
      client = this.#client;
    if (!context || !client) fail(4100, "Connect an App account first");
    try {
      const session = client.session.get(context.topic);
      const address = this.#sessionAccount(session);
      if (
        session.topic !== context.topic ||
        session.pairingTopic !== context.pairingTopic ||
        session.expiry !== context.expiry ||
        !sameAddress(address, context.address)
      )
        fail(4100, "Wallet session changed");
    } catch {
      void this.#stop();
      fail(4100, "Wallet session changed; reconnect explicitly");
    }
    return { client, context };
  }
  #sessionAccount(session: AppProtocolSession): string {
    if (
      this.#options.account !== undefined &&
      (session.sessionProperties?.["ohmywallet.connect"] !== "1" ||
        session.sessionProperties?.["ohmywallet.account"] !== this.#options.account)
    )
      fail(4100, "Wallet account intent changed; reconnect explicitly");
    return sessionAccount(session, this.#state.chainId, this.#now());
  }
  #register(client: AppSignClient) {
    for (const event of [
      "session_delete",
      "session_expire",
      "session_update",
      "session_event",
    ] as const) {
      const callback = (value: unknown) => {
        if (this.#client !== client || !this.#context || !value || typeof value !== "object")
          return;
        const payload = value as {
          topic?: string;
          params?: {
            namespaces?: AppProtocolSession["namespaces"];
            chainId?: string;
            event?: { name?: string; data?: unknown };
            sessionProperties?: Record<string, string>;
          };
        };
        if (payload.topic !== this.#context.topic) return;
        if (event === "session_delete" || event === "session_expire") {
          void this.#stop();
          return;
        }
        const eventEpoch = this.#epoch;
        try {
          const { context } = this.#current(eventEpoch);
          if (event === "session_update") {
            const session = client.session.get(context.topic);
            if (payload.params?.sessionProperties !== undefined)
              this.#sessionAccount({
                ...session,
                sessionProperties: payload.params.sessionProperties,
              });
            if (
              !sameAddress(
                this.#sessionAccount({ ...session, namespaces: payload.params?.namespaces ?? {} }),
                context.address
              )
            )
              fail(4100, "Wallet session changed");
          } else {
            if (payload.params?.chainId !== `eip155:${this.#state.chainId}`)
              fail(4100, "Wallet network changed");
            const change = payload.params?.event;
            if (change?.name === "accountsChanged") {
              if (
                !Array.isArray(change.data) ||
                change.data.length !== 1 ||
                !sameAddress(change.data[0], context.address)
              )
                fail(4100, "Wallet account changed");
            } else if (change?.name === "chainChanged") {
              if (
                change.data !== this.#state.chainId &&
                change.data !== `0x${this.#state.chainId.toString(16)}`
              )
                fail(4100, "Wallet network changed");
            } else fail(4100, "Unexpected wallet event");
          }
        } catch {
          if (this.#epoch === eventEpoch && this.#client === client) void this.#stop();
        }
      };
      this.#protocolListeners.push([event, callback]);
      client.on(event, callback);
    }
  }
  async #initialize(epoch: number) {
    const origin = (this.#dependencies.origin ?? (() => window.location.origin))();
    let source: URL;
    try {
      source = new URL(origin);
    } catch {
      return fail(-32602, "Invalid dApp origin");
    }
    if (
      source.origin !== origin ||
      (source.protocol !== "https:" &&
        !(source.protocol === "http:" && ["localhost", "127.0.0.1"].includes(source.hostname)))
    )
      fail(-32602, "Use an HTTPS dApp origin");
    const storage = memoryStorage();
    let client: AppSignClient;
    try {
      client = await (this.#dependencies.createClient ?? createClient)({
        projectId: this.#options.projectId,
        metadata: {
          name: this.#options.metadata.name,
          description: this.#options.metadata.description ?? "",
          url: origin,
          icons: [...(this.#options.metadata.icons ?? [])],
        },
        storage,
        customStoragePrefix: `omw-app-${(this.#dependencies.nonce ?? (() => crypto.randomUUID()))()}`,
        relayUrl: "wss://relay.walletconnect.org",
        logger: "silent",
        telemetryEnabled: false,
      });
    } catch {
      storage.clear();
      fail(4900, "Could not start wallet connection");
    }
    if (this.#destroyed || epoch !== this.#epoch) {
      void client.close().catch(() => {});
      fail(4001, "Request cancelled");
    }
    this.#client = client;
    this.#register(client);
    return client;
  }
  async #connect(epoch: number) {
    this.#alive(epoch);
    if (this.#context) return [this.#current(epoch).context.address];
    this.#stateChanged({ status: "connecting", chainId: this.#state.chainId, busy: true });
    this.#alive(epoch);
    const client = await this.#initialize(epoch);
    this.#alive(epoch);
    const connection = await client.connect({
      requiredNamespaces: {
        eip155: {
          chains: [`eip155:${this.#state.chainId}`],
          methods: [...APP_METHODS],
          events: [...APP_EVENTS],
        },
      },
      ...(this.#options.account === undefined
        ? {}
        : {
            sessionProperties: {
              "ohmywallet.account": this.#options.account,
              "ohmywallet.connect": "1",
            },
          }),
    });
    const approval = connection.approval();
    let info: ReturnType<typeof pairingInfo>;
    try {
      info = pairingInfo(connection.uri, this.#now());
      this.#alive(epoch);
    } catch (error) {
      void approval.then((late) => this.#cleanup(client, { ...late, address: "" })).catch(() => {});
      throw error;
    }
    this.#pairingTopic = info.topic;
    this.#expireAt(info.expiresAt, epoch);
    const pairing = Object.freeze({
      uri: info.uri,
      appUrl: `https://app.ohmywallet.xyz/${this.#options.locale ?? "en"}#wc=${encodeURIComponent(info.uri)}${this.#options.account === undefined ? "" : `&account=${this.#options.account}&chainId=${this.#state.chainId}`}`,
      expiresAt: info.expiresAt,
    });
    this.#stateChanged({ status: "pairing", chainId: this.#state.chainId, busy: true, pairing });
    const session = await approval;
    try {
      this.#alive(epoch);
      const address = this.#sessionAccount(session);
      if (session.pairingTopic !== info.topic) fail(4100, "Wallet pairing changed");
      const persisted = client.session.get(session.topic);
      if (
        persisted.topic !== session.topic ||
        persisted.pairingTopic !== session.pairingTopic ||
        persisted.expiry !== session.expiry ||
        !sameAddress(this.#sessionAccount(persisted), address)
      )
        fail(4100, "Wallet session changed");
      this.#context = {
        topic: session.topic,
        pairingTopic: session.pairingTopic,
        address,
        expiry: session.expiry,
      };
      this.#submissionUncertain = false;
      this.#expireAt(session.expiry * 1000, epoch);
      this.#stateChanged({
        status: "connected",
        chainId: this.#state.chainId,
        address,
        busy: true,
      });
      this.#alive(epoch);
      this.#emit("connect", { chainId: `0x${this.#state.chainId.toString(16)}` });
      this.#alive(epoch);
      this.#emit("accountsChanged", [address]);
      this.#alive(epoch);
      return [address];
    } catch (error) {
      void this.#cleanup(client, { ...session, address: "" });
      throw error;
    }
  }
  async request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown> {
    if (this.#destroyed) fail(4900, "Provider destroyed");
    if (!args || typeof args.method !== "string") fail(-32600, "Invalid request");
    if (args.params !== undefined && !Array.isArray(args.params))
      fail(-32602, "Expected positional parameters");
    const params = (args.params ?? []) as readonly unknown[];
    if (args.method === "eth_chainId") {
      if (params.length) fail(-32602, "Unexpected parameters");
      return `0x${this.#state.chainId.toString(16)}`;
    }
    if (args.method === "eth_accounts") {
      if (params.length) fail(-32602, "Unexpected parameters");
      if (!this.#context) return [];
      try {
        return [this.#current(this.#epoch).context.address];
      } catch {
        return [];
      }
    }
    if (args.method === "wallet_switchEthereumChain") {
      if (params.length !== 1) fail(-32602, "Expected a chain");
      const id = quantity(object(params[0]).chainId);
      if (id === BigInt(this.#state.chainId)) {
        this.#current(this.#epoch);
        return null;
      }
      fail(4200, "Disconnect and reconnect explicitly to change the App network");
    }
    if (args.method === "wallet_getCapabilities") {
      const { context } = this.#current(this.#epoch);
      if (params.length < 1 || params.length > 2 || !sameAddress(params[0], context.address))
        fail(-32602, "Expected the connected account");
      let selected = true;
      if (params.length === 2) {
        if (!Array.isArray(params[1])) fail(-32602, "Expected chain IDs");
        selected = params[1].map(quantity).includes(BigInt(this.#state.chainId));
      }
      return selected
        ? { [`0x${this.#state.chainId.toString(16)}`]: { atomic: { status: "unsupported" } } }
        : {};
    }
    if (
      args.method !== "eth_requestAccounts" &&
      !(APP_METHODS as readonly string[]).includes(args.method)
    )
      fail(4200, "Unsupported App wallet method");
    if (this.#busy) fail(-32002, "A wallet request is already pending");
    const epoch = this.#epoch;
    this.#busy = true;
    let rejectPending!: (error: Error) => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectPending = reject;
    });
    this.#rejectPending = rejectPending;
    this.#stateChanged({ ...this.#state, busy: true });
    const work = async () => {
      this.#alive(epoch);
      if (args.method === "eth_requestAccounts") {
        if (params.length) fail(-32602, "Unexpected parameters");
        return this.#connect(epoch);
      }
      const { client, context } = this.#current(epoch);
      // Clone before any asynchronous work: mutable consumer data cannot change the reviewed request.
      let cloned: unknown[];
      try {
        const serialized = JSON.stringify(params);
        if (serialized.length > 131072) fail(-32602, "Request too large");
        cloned = JSON.parse(serialized);
      } catch {
        return fail(-32602, "Invalid parameters");
      }
      if (args.method === "personal_sign") {
        if (
          cloned.length !== 2 ||
          !sameAddress(cloned[1], context.address) ||
          typeof cloned[0] !== "string" ||
          !/^0x(?:[a-f0-9]{2})*$/iu.test(cloned[0]) ||
          cloned[0].length > 131074
        )
          fail(-32602, "Expected a message and the connected account");
      } else if (args.method === "eth_signTypedData_v4") {
        if (cloned.length !== 2 || !sameAddress(cloned[0], context.address))
          fail(-32602, "Expected the connected account and typed data");
        let typed: Record<string, unknown>;
        try {
          typed = object(typeof cloned[1] === "string" ? JSON.parse(cloned[1]) : cloned[1]);
        } catch {
          return fail(-32602, "Invalid typed data");
        }
        const domain = object(typed.domain);
        if (!typed.types || typeof typed.primaryType !== "string" || !typed.message)
          fail(-32602, "Invalid typed data");
        try {
          if (
            domain.chainId !== undefined &&
            BigInt(domain.chainId as string) !== BigInt(this.#state.chainId)
          )
            fail(-32602, "Typed data network mismatch");
        } catch {
          fail(-32602, "Typed data network mismatch");
        }
      } else {
        if (this.#submissionUncertain) fail(-32002, UNKNOWN_SUBMISSION);
        if (cloned.length !== 1) fail(-32602, "Expected a transaction");
        const tx = object(cloned[0]);
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
          fail(4200, "Unsupported transaction fields");
        if (
          !sameAddress(tx.from, context.address) ||
          typeof tx.to !== "string" ||
          !isAddress(tx.to)
        )
          fail(-32602, "Transaction account mismatch");
        if (tx.chainId !== undefined && quantity(tx.chainId) !== BigInt(this.#state.chainId))
          fail(-32602, "Transaction network mismatch");
        for (const key of [
          "value",
          "gas",
          "gasPrice",
          "maxFeePerGas",
          "maxPriorityFeePerGas",
          "nonce",
        ])
          if (tx[key] !== undefined) quantity(tx[key]);
        if (
          (tx.type !== undefined && tx.type !== "0x0" && tx.type !== "0x2") ||
          (tx.data !== undefined &&
            (typeof tx.data !== "string" || !/^0x(?:[a-f0-9]{2})*$/iu.test(tx.data)))
        )
          fail(-32602, "Invalid transaction");
        if (
          (tx.gasPrice !== undefined || tx.type === "0x0") &&
          (tx.maxFeePerGas !== undefined ||
            tx.maxPriorityFeePerGas !== undefined ||
            tx.type === "0x2")
        )
          fail(-32602, "Conflicting fee fields");
        if (
          tx.maxFeePerGas !== undefined &&
          tx.maxPriorityFeePerGas !== undefined &&
          quantity(tx.maxPriorityFeePerGas) > quantity(tx.maxFeePerGas)
        )
          fail(-32602, "Conflicting fee fields");
      }
      this.#current(epoch);
      const transaction = args.method === "eth_sendTransaction";
      this.#dispatchedTransaction = transaction;
      try {
        const value = await client.request({
          topic: context.topic,
          chainId: `eip155:${this.#state.chainId}`,
          request: { method: args.method, params: cloned },
          expiry: 300,
        });
        this.#current(epoch);
        if (
          typeof value !== "string" ||
          !/^0x(?:[a-f0-9]{2})+$/iu.test(value) ||
          (transaction ? value.length !== 66 : value.length > 32770)
        )
          fail(-32603, "Invalid wallet response");
        return value;
      } catch (error) {
        if (transaction && rpcError(error).code !== 4001) {
          if (epoch === this.#epoch) this.#submissionUncertain = true;
          throw new AppProviderRpcError(-32000, UNKNOWN_SUBMISSION);
        }
        throw error;
      } finally {
        if (epoch === this.#epoch) this.#dispatchedTransaction = false;
      }
    };
    const timer = setTimeout(
      () =>
        rejectPending(
          new AppProviderRpcError(
            -32000,
            this.#dispatchedTransaction ? UNKNOWN_SUBMISSION : "Wallet request timed out",
            args.method === "eth_requestAccounts" ? "expired" : undefined
          )
        ),
      300_000
    );
    timer.unref?.();
    try {
      return await Promise.race([work(), cancelled]);
    } catch (error) {
      if (args.method === "eth_requestAccounts" && epoch === this.#epoch) await this.#stop();
      else if (
        epoch === this.#epoch &&
        args.method === "eth_sendTransaction" &&
        this.#dispatchedTransaction
      )
        this.#submissionUncertain = true;
      throw rpcError(error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (epoch === this.#epoch) {
        this.#rejectPending = undefined;
        this.#busy = false;
        this.#stateChanged({ ...this.#state, busy: false });
      }
    }
  }
}

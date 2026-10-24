import { getAddress, isAddress, zeroAddress } from "viem";
import { APP_CHAIN_IDS, sameAddress } from "./app-protocol";
import { ProviderRpcError } from "./provider";
import { createHostSurface, type HostSurface } from "./host-surface";
import type { IframeHostConfig } from "./types";

type Listener = (value: unknown) => void;
type Event = "accountsChanged" | "chainChanged" | "connect" | "disconnect";
type RpcRequest = { method: string; params?: readonly unknown[] | object };
interface Pending {
  id: string;
  method: string;
  params: unknown[];
  dispatched: boolean;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
const VERSION = 1;
const TIMEOUT = 120_000;
const UNKNOWN_SUBMISSION = "Transaction outcome unknown; check wallet activity before retrying";
const METHODS = new Set([
  "eth_requestAccounts",
  "personal_sign",
  "eth_signTypedData_v4",
  "eth_sendTransaction",
]);
const fail = (code: number, message: string): never => {
  throw new ProviderRpcError(code, message);
};
const opaqueId = () => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(-32602, "Invalid parameters");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

/** Internal managed-only adapter. It never runs WebAuthn or receives credential material. */
export class ManagedEmbedProvider {
  readonly #chainId: number;
  readonly #config: IframeHostConfig;
  readonly #url: string;
  readonly #origin: string;
  readonly #listeners = new Map<Event, Set<Listener>>();
  #surface?: HostSurface;
  #sessionId?: string;
  #ready = false;
  #pending?: Pending;
  #address?: string;
  #destroyed = false;
  #uncertain = false;
  #initRetry?: ReturnType<typeof setInterval>;
  #initTimeout?: ReturnType<typeof setTimeout>;

  constructor(options: { chainId?: number; hostConfig?: IframeHostConfig } = {}) {
    this.#chainId = options.chainId ?? 1;
    if (!(APP_CHAIN_IDS as readonly number[]).includes(this.#chainId))
      fail(4902, "Unsupported managed network");
    this.#config = { ...options.hostConfig };
    const url = new URL(this.#config.iframeSrc ?? "https://embed.ohmywallet.xyz");
    if (
      !["https://embed.ohmywallet.xyz", "http://localhost:3122"].includes(url.origin) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      fail(-32602, "Use the fixed Embed endpoint");
    if (this.#config.sandbox !== undefined || this.#config.origin !== undefined)
      fail(-32602, "Managed Embed origin and sandbox are fixed");
    if (
      this.#config.timeout !== undefined &&
      (!Number.isSafeInteger(this.#config.timeout) ||
        this.#config.timeout < 1_000 ||
        this.#config.timeout > TIMEOUT)
    )
      fail(-32602, "Invalid managed request timeout");
    url.searchParams.set("account", "managed");
    url.pathname = `/${this.#config.locale ?? "en"}`;
    this.#url = url.href;
    this.#origin = url.origin;
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
        /* Consumer callbacks cannot authorize work. */
      }
    }
  }
  #post(message: object) {
    this.#surface?.iframe.contentWindow?.postMessage(message, this.#origin);
  }
  #clearInitialization() {
    if (this.#initRetry !== undefined) clearInterval(this.#initRetry);
    if (this.#initTimeout !== undefined) clearTimeout(this.#initTimeout);
    this.#initRetry = undefined;
    this.#initTimeout = undefined;
  }
  #finish(error?: Error, result?: unknown, keepVisible = false) {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    clearTimeout(pending.timer);
    if (!keepVisible) this.#surface?.hide({ restoreFocus: true });
    if (error) pending.reject(error);
    else pending.resolve(result);
  }
  #invalidate(message: string) {
    if (this.#pending?.method === "eth_sendTransaction" && this.#pending.dispatched)
      this.#uncertain = true;
    this.#address = undefined;
    this.#emit("accountsChanged", []);
    this.#finish(new ProviderRpcError(4100, message));
    this.#removeSurface();
  }
  readonly #message = (event: MessageEvent) => {
    if (
      event.origin !== this.#origin ||
      event.source !== this.#surface?.iframe.contentWindow ||
      !event.data ||
      typeof event.data !== "object" ||
      Array.isArray(event.data)
    )
      return;
    const value = event.data as Record<string, unknown>;
    if (value.version !== VERSION || value.sessionId !== this.#sessionId) return;
    if (
      value.type === "OMW_MANAGED_DISMISS" &&
      exact(value, ["type", "version", "sessionId"]) &&
      !this.#pending &&
      this.#uncertain
    ) {
      this.#surface?.hide({ restoreFocus: true });
      return;
    }
    if (value.type === "OMW_MANAGED_READY") {
      if (!exact(value, ["type", "version", "sessionId"])) return;
      this.#ready = true;
      this.#clearInitialization();
      this.#dispatch();
      return;
    }
    const pending = this.#pending;
    if (!pending || !pending.dispatched || value.id !== pending.id) return;
    const common = ["type", "version", "sessionId", "id", "chainId", "account"];
    if (value.chainId !== this.#chainId || value.account !== "managed") {
      this.#invalidate("Managed wallet identity changed");
      return;
    }
    if (value.type === "OMW_MANAGED_ERROR") {
      if (!exact(value, [...common, "error"], ["address", "transactionHash"])) {
        this.#invalidate("Invalid managed wallet response");
        return;
      }
      const error = value.error;
      if (
        !error ||
        typeof error !== "object" ||
        Array.isArray(error) ||
        !exact(error as Record<string, unknown>, ["code", "message"]) ||
        !Number.isSafeInteger((error as Record<string, unknown>).code) ||
        typeof (error as Record<string, unknown>).message !== "string" ||
        ((error as Record<string, unknown>).message as string).length > 1024 ||
        (value.address !== undefined &&
          !sameAddress(value.address, this.#address ?? String(value.address)))
      ) {
        this.#invalidate("Invalid managed wallet error");
        return;
      }
      const rpc = error as { code: number; message: string };
      if (
        value.transactionHash !== undefined &&
        (pending.method !== "eth_sendTransaction" ||
          rpc.code !== -32003 ||
          typeof value.transactionHash !== "string" ||
          !/^0x[a-f0-9]{64}$/iu.test(value.transactionHash))
      ) {
        this.#invalidate("Invalid transaction outcome response");
        return;
      }
      if (rpc.code === 4100 || rpc.code === 4900) {
        this.#invalidate(rpc.message);
        return;
      }
      if (pending.method === "eth_sendTransaction" && rpc.code !== 4001) this.#uncertain = true;
      this.#finish(
        new ProviderRpcError(
          rpc.code,
          rpc.message,
          typeof value.transactionHash === "string"
            ? { transactionHash: value.transactionHash, chainId: this.#chainId }
            : undefined
        ),
        undefined,
        rpc.code === -32003 && typeof value.transactionHash === "string"
      );
      return;
    }
    if (value.type !== "OMW_MANAGED_RESULT") return;
    if (
      !exact(value, [...common, "address", "result"]) ||
      typeof value.address !== "string" ||
      !isAddress(value.address) ||
      sameAddress(value.address, zeroAddress) ||
      (this.#address !== undefined && !sameAddress(value.address, this.#address))
    ) {
      this.#invalidate("Managed wallet identity changed");
      return;
    }
    if (pending.method === "eth_requestAccounts") {
      if (
        !Array.isArray(value.result) ||
        value.result.length !== 1 ||
        !sameAddress(value.result[0], value.address)
      ) {
        this.#invalidate("Invalid managed account response");
        return;
      }
      this.#address = getAddress(value.address);
      this.#emit("connect", { chainId: `0x${this.#chainId.toString(16)}` });
      // A consumer may cancel or disconnect from an event handler.
      if (this.#pending !== pending || !this.#address) return;
      this.#emit("accountsChanged", [this.#address]);
      if (this.#pending !== pending || !this.#address) return;
      this.#finish(undefined, [this.#address]);
      return;
    }
    if (
      typeof value.result !== "string" ||
      !/^0x(?:[a-f0-9]{2})+$/iu.test(value.result) ||
      (pending.method === "eth_sendTransaction"
        ? value.result.length !== 66
        : value.result.length > 32770)
    ) {
      if (pending.method === "eth_sendTransaction") this.#uncertain = true;
      this.#finish(new ProviderRpcError(-32603, "Invalid managed result"));
      return;
    }
    this.#finish(undefined, value.result);
  };
  #dispatch() {
    const pending = this.#pending;
    if (!this.#ready || !pending || pending.dispatched) return;
    pending.dispatched = true;
    this.#post({
      type: "OMW_MANAGED_REQUEST",
      version: VERSION,
      sessionId: this.#sessionId,
      id: pending.id,
      chainId: this.#chainId,
      method: pending.method,
      params: pending.params,
    });
  }
  #ensureSurface() {
    if (this.#surface) return;
    this.#sessionId = opaqueId();
    this.#ready = false;
    window.addEventListener("message", this.#message);
    this.#surface = createHostSurface({
      iframeSrc: this.#url,
      allow: `publickey-credentials-get ${this.#origin}`,
      container: this.#config.container,
      sandbox: "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox",
      onEscape: () => {
        if (!this.cancel() && this.#uncertain) this.#surface?.hide({ restoreFocus: true });
      },
      onDisconnect: () => {
        this.disconnect();
      },
    });
    const initialize = () =>
      this.#post({ type: "OMW_MANAGED_INIT", version: VERSION, sessionId: this.#sessionId });
    initialize();
    this.#initRetry = setInterval(initialize, 250);
    this.#initTimeout = setTimeout(() => {
      this.#clearInitialization();
      this.#finish(new ProviderRpcError(4900, "Managed wallet initialization timed out"));
      this.#removeSurface();
    }, 30_000);
  }
  #removeSurface() {
    this.#clearInitialization();
    if (typeof window !== "undefined") window.removeEventListener("message", this.#message);
    const surface = this.#surface;
    this.#surface = undefined;
    this.#sessionId = undefined;
    this.#ready = false;
    surface?.destroy();
  }
  cancel(): boolean {
    const pending = this.#pending;
    if (!pending) return false;
    this.#post({
      type: "OMW_MANAGED_CANCEL",
      version: VERSION,
      sessionId: this.#sessionId,
      id: pending.id,
    });
    const uncertain = pending.method === "eth_sendTransaction" && pending.dispatched;
    if (uncertain) this.#uncertain = true;
    if (pending.method === "eth_requestAccounts") this.#address = undefined;
    this.#finish(
      new ProviderRpcError(
        uncertain ? -32000 : 4001,
        uncertain ? UNKNOWN_SUBMISSION : "Request cancelled"
      )
    );
    return true;
  }
  disconnect(): void {
    this.cancel();
    this.#post({ type: "OMW_MANAGED_DESTROY", version: VERSION, sessionId: this.#sessionId });
    this.#address = undefined;
    this.#uncertain = false;
    this.#removeSurface();
    this.#emit("accountsChanged", []);
  }
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.disconnect();
    this.#emit("disconnect", new ProviderRpcError(4900, "Provider destroyed"));
    this.#listeners.clear();
  }
  async request(args: RpcRequest): Promise<unknown> {
    if (this.#destroyed) fail(4900, "Provider destroyed");
    if (!args || typeof args.method !== "string") fail(-32600, "Invalid request");
    if (args.params !== undefined && !Array.isArray(args.params))
      fail(-32602, "Expected positional parameters");
    const params = (args.params ?? []) as readonly unknown[];
    if (args.method === "eth_accounts" || args.method === "eth_chainId") {
      if (params.length) fail(-32602, "Unexpected parameters");
      return args.method === "eth_accounts"
        ? this.#address
          ? [this.#address]
          : []
        : `0x${this.#chainId.toString(16)}`;
    }
    if (args.method === "wallet_switchEthereumChain") {
      if (!this.#address) fail(4100, "Connect a managed account first");
      if (params.length !== 1 || record(params[0]).chainId !== `0x${this.#chainId.toString(16)}`)
        fail(4200, "Disconnect and reconnect explicitly to change the managed network");
      return null;
    }
    if (args.method === "wallet_getCapabilities") {
      if (!this.#address || !sameAddress(params[0], this.#address))
        fail(4100, "Account not authorized");
      if (
        params.length < 1 ||
        params.length > 2 ||
        (params[1] !== undefined &&
          (!Array.isArray(params[1]) ||
            params[1].some(
              (chain) => typeof chain !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/iu.test(chain)
            )))
      )
        fail(-32602, "Invalid capability parameters");
      return params[1] === undefined ||
        (params[1] as unknown[]).includes(`0x${this.#chainId.toString(16)}`)
        ? { [`0x${this.#chainId.toString(16)}`]: { atomic: { status: "unsupported" } } }
        : {};
    }
    if (!METHODS.has(args.method)) fail(4200, "Unsupported managed wallet method");
    if (this.#pending) fail(-32002, "A wallet request is already pending");
    if (args.method === "eth_requestAccounts" && params.length)
      fail(-32602, "Unexpected parameters");
    if (args.method === "eth_requestAccounts" && this.#address) return [this.#address];
    if (args.method !== "eth_requestAccounts") {
      if (!this.#address) fail(4100, "Connect a managed account first");
      const selected =
        args.method === "personal_sign"
          ? params[1]
          : args.method === "eth_signTypedData_v4"
            ? params[0]
            : record(params[0]).from;
      if (!sameAddress(selected, this.#address!)) fail(-32602, "Managed account mismatch");
      if (args.method === "eth_sendTransaction" && this.#uncertain)
        fail(-32002, UNKNOWN_SUBMISSION);
    }
    let copied: unknown[];
    try {
      const serialized = JSON.stringify(params);
      if (serialized.length > 131_072) fail(-32602, "Request too large");
      copied = JSON.parse(serialized);
    } catch {
      return fail(-32602, "Invalid parameters");
    }
    return new Promise((resolve, reject) => {
      const id = opaqueId();
      this.#pending = {
        id,
        method: args.method,
        params: copied,
        dispatched: false,
        resolve,
        reject,
        timer: setTimeout(() => {
          const pending = this.#pending;
          if (pending?.id !== id) return;
          const uncertain = pending.method === "eth_sendTransaction" && pending.dispatched;
          if (uncertain) this.#uncertain = true;
          this.#post({
            type: "OMW_MANAGED_CANCEL",
            version: VERSION,
            sessionId: this.#sessionId,
            id,
          });
          this.#finish(
            new ProviderRpcError(
              -32000,
              uncertain ? UNKNOWN_SUBMISSION : "Wallet request timed out"
            )
          );
        }, this.#config.timeout ?? TIMEOUT),
      };
      try {
        this.#ensureSurface();
        this.#surface!.show(document.activeElement);
        this.#dispatch();
      } catch (error) {
        this.#finish(
          error instanceof Error
            ? error
            : new ProviderRpcError(4900, "Could not open managed wallet")
        );
        this.#removeSurface();
      }
    });
  }
}

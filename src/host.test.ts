import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_IFRAME_SRC, IframeHost } from "./host";
import { IframeHost as ExportedIframeHost } from "./index";
import { IframeError, type IframeMessage } from "./types";

const EMBED_ORIGIN = "https://embed.ohmywallet.xyz";
const PRIMARY_EVM = {
  address: "0x0000000000000000000000000000000000000001",
  keyIndex: 0,
  curve: "secp256k1",
  group: "evm",
} as const;
const LEGACY_CONNECT_RESULT = { address: PRIMARY_EVM, signerType: "derivation" } as const;

class FakeContentWindow {
  readonly focus = vi.fn();
  readonly postMessage = vi.fn((_message: unknown, _targetOrigin: string) => undefined);
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly style = { cssText: "", opacity: "", pointerEvents: "" };
  readonly attributes = new Map<string, string>();
  readonly focus = vi.fn(() => {
    if (this.isConnected) this.ownerDocument.focusElement(this);
  });
  id = "";
  inert = false;
  parentElement: FakeElement | null = null;
  readonly remove = vi.fn(() => {
    this.parentElement?.removeChild(this);
  });

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName: string
  ) {}

  get isConnected(): boolean {
    return this === this.ownerDocument.documentElement || this.parentElement?.isConnected === true;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement?.removeChild(child);
    this.children.push(child);
    child.parentElement = this;
    return child;
  }

  removeChild(child: FakeElement): void {
    const index = this.children.indexOf(child);
    if (index === -1) return;
    this.children.splice(index, 1);
    child.parentElement = null;
  }

  contains(other: FakeElement): boolean {
    let candidate: FakeElement | null = other;
    while (candidate) {
      if (candidate === this) return true;
      candidate = candidate.parentElement;
    }
    return false;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "inert") this.inert = true;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === "inert") this.inert = false;
  }
}

class FakeIframe extends FakeElement {
  readonly contentWindow = new FakeContentWindow();
  src = "";
  referrerPolicy = "";
  allow = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(ownerDocument: FakeDocument) {
    super(ownerDocument, "iframe");
  }
}

class FakeDocument {
  readonly documentElement: FakeElement;
  readonly body: FakeElement;
  readonly iframes: FakeIframe[] = [];
  iframe: FakeIframe | null = null;
  overlay: FakeElement | null = null;
  activeElement: FakeElement | null;
  private readonly keydownListeners = new Set<(event: { key: string }) => void>();
  private readonly focusinListeners = new Set<(event: { target: FakeElement }) => void>();

  constructor() {
    this.documentElement = new FakeElement(this, "html");
    this.body = new FakeElement(this, "body");
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }

  createElement(tagName: string): FakeElement {
    if (tagName === "iframe") {
      this.iframe = new FakeIframe(this);
      this.iframes.push(this.iframe);
      return this.iframe;
    }
    const element = new FakeElement(this, tagName);
    if (tagName === "div" && this.overlay === null) this.overlay = element;
    return element;
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    if (type === "keydown") {
      this.keydownListeners.add(listener as unknown as (event: { key: string }) => void);
    }
    if (type === "focusin") {
      this.focusinListeners.add(listener as unknown as (event: { target: FakeElement }) => void);
    }
  }

  removeEventListener(type: string, listener: (event: never) => void): void {
    if (type === "keydown") {
      this.keydownListeners.delete(listener as unknown as (event: { key: string }) => void);
    }
    if (type === "focusin") {
      this.focusinListeners.delete(listener as unknown as (event: { target: FakeElement }) => void);
    }
  }

  dispatchKey(key: string): void {
    for (const listener of this.keydownListeners) listener({ key });
  }

  focusElement(element: FakeElement): void {
    this.activeElement = element;
    for (const listener of this.focusinListeners) listener({ target: element });
  }

  get keydownListenerCount(): number {
    return this.keydownListeners.size;
  }

  get focusinListenerCount(): number {
    return this.focusinListeners.size;
  }
}

class FakeMutationObserver {
  static readonly instances: FakeMutationObserver[] = [];

  readonly observe = vi.fn(
    (_target: unknown, _options: { childList?: boolean; subtree?: boolean }) => undefined
  );
  readonly disconnect = vi.fn(() => {
    this.disconnected = true;
    this.pendingRecords.length = 0;
  });
  readonly takeRecords = vi.fn(() => this.pendingRecords.splice(0));
  private disconnected = false;
  private readonly pendingRecords: MutationRecord[] = [];

  constructor(
    private readonly callback: (records: MutationRecord[], observer: MutationObserver) => void
  ) {
    FakeMutationObserver.instances.push(this);
  }

  flush(records: MutationRecord[] = []): void {
    if (!this.disconnected) this.callback(records, this as unknown as MutationObserver);
  }

  enqueue(records: MutationRecord[]): void {
    if (!this.disconnected) this.pendingRecords.push(...records);
  }

  static flushAll(records: MutationRecord[] = []): void {
    for (const observer of FakeMutationObserver.instances) observer.flush(records);
  }

  static reset(): void {
    FakeMutationObserver.instances.length = 0;
  }

  get isDisconnected(): boolean {
    return this.disconnected;
  }
}

class FakeWindow {
  readonly location = { origin: "https://merchant.example" };
  private readonly listeners = new Set<(event: MessageEvent) => void>();
  private readonly signalRemovers = new Map<(event: MessageEvent) => void, () => void>();

  addEventListener(
    type: string,
    listener: (event: MessageEvent) => void,
    options?: boolean | AddEventListenerOptions
  ): void {
    if (type !== "message") return;

    const signal = typeof options === "object" ? options.signal : undefined;
    if (signal?.aborted) return;

    this.signalRemovers.get(listener)?.();
    this.listeners.add(listener);
    if (!signal) return;

    const handleAbort = () => {
      this.listeners.delete(listener);
      this.signalRemovers.delete(listener);
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    this.signalRemovers.set(listener, () => {
      signal.removeEventListener("abort", handleAbort);
    });
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type !== "message") return;
    this.listeners.delete(listener);
    this.signalRemovers.get(listener)?.();
    this.signalRemovers.delete(listener);
  }

  dispatch(event: Partial<MessageEvent>): void {
    for (const listener of this.listeners) listener(event as MessageEvent);
  }

  get messageListenerCount(): number {
    return this.listeners.size;
  }
}

let fakeDocument: FakeDocument;
let fakeWindow: FakeWindow;

beforeEach(() => {
  vi.useFakeTimers();
  fakeDocument = new FakeDocument();
  fakeWindow = new FakeWindow();
  FakeMutationObserver.reset();
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("navigator", { language: "en-US" });
  vi.stubGlobal("MutationObserver", FakeMutationObserver);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function messages(iframe: FakeIframe): unknown[] {
  return iframe.contentWindow.postMessage.mock.calls.map(([message]) => message);
}

function asHTMLElement(element: FakeElement): HTMLElement {
  return element as unknown as HTMLElement;
}

function removalRecord(...removedNodes: FakeElement[]): MutationRecord {
  return { removedNodes } as unknown as MutationRecord;
}

function requestOfType(iframe: FakeIframe, type: string): IframeMessage {
  const request = messages(iframe).find(
    (message): message is IframeMessage =>
      typeof message === "object" && message !== null && "type" in message && message.type === type
  );
  if (!request) throw new Error(`Missing ${type} request`);
  return request;
}

function dispatchFromIframe(
  iframe: FakeIframe,
  data: unknown,
  options: { origin?: string; source?: unknown } = {}
): void {
  fakeWindow.dispatch({
    origin: options.origin ?? EMBED_ORIGIN,
    source: (options.source ?? iframe.contentWindow) as MessageEventSource,
    data,
  });
}

function response(type: IframeMessage["type"], requestId: string, data: unknown): IframeMessage {
  return {
    type,
    id: requestId,
    payload: { requestId, data },
    timestamp: 1,
  };
}

function expectRequestReleased(host: IframeHost): void {
  const state = requestState(host);
  expect(state.activeRequest).toBeNull();
  expect(state.requestManager.pendingCount).toBe(0);
}

function requestState(host: IframeHost): {
  activeRequest: unknown;
  requestManager: { pendingCount: number };
} {
  return host as unknown as {
    activeRequest: unknown;
    requestManager: { pendingCount: number };
  };
}

async function beginConnect(
  host: IframeHost
): Promise<{ iframe: FakeIframe; result: Promise<unknown> }> {
  const result = host.connectWithSignerType({ signerType: "derivation" });
  const iframe = fakeDocument.iframe!;
  iframe.onload?.();
  await flushPromises();
  return { iframe, result };
}

async function acknowledgeRelay(iframe: FakeIframe): Promise<void> {
  dispatchFromIframe(iframe, { type: "RELAY_READY", version: 2 });
  await flushPromises();
}

async function connectHost(): Promise<{
  host: IframeHost;
  iframe: FakeIframe;
}> {
  const host = new IframeHost();
  const { iframe, result } = await beginConnect(host);
  await acknowledgeRelay(iframe);
  const connectRequest = requestOfType(iframe, "CONNECT");
  dispatchFromIframe(
    iframe,
    response("CONNECT_RESULT", connectRequest.id, { address: PRIMARY_EVM })
  );
  await result;
  return { host, iframe };
}

async function beginPrimaryConnect(
  host: IframeHost
): Promise<{ iframe: FakeIframe; result: Promise<unknown> }> {
  const result = host.connect();
  const iframe = fakeDocument.iframe!;
  iframe.onload?.();
  await flushPromises();
  return { iframe, result };
}

function requestsOfType(iframe: FakeIframe, type: string): IframeMessage[] {
  return messages(iframe).filter(
    (message): message is IframeMessage =>
      typeof message === "object" && message !== null && "type" in message && message.type === type
  );
}

describe("IframeHost primary lifecycle and cancellation", () => {
  it("does not grant ready after an acknowledged initial CONNECT cancellation", async () => {
    const host = new IframeHost();
    const { iframe, result } = await beginPrimaryConnect(host);
    await acknowledgeRelay(iframe);
    const request = requestOfType(iframe, "CONNECT");
    expect(host.cancel()).toBe(true);
    await expect(result).rejects.toMatchObject({ code: "USER_CANCELLED" });
    dispatchFromIframe(iframe, {
      type: "ERROR",
      id: request.id,
      payload: {
        requestId: request.id,
        code: "USER_CANCELLED",
        message: "User cancelled the operation",
      },
      timestamp: 1,
    });
    expect(host.currentState).toBe("idle");
    const sent = messages(iframe).length;
    await expect(
      host.deriveAddress({ keyIndex: 1, curve: "secp256k1", group: "evm" })
    ).rejects.toMatchObject({ code: "NOT_INITIALIZED" });
    await expect(
      host.sign(
        { kind: "message", message: { type: "text", value: "test" } },
        { address: PRIMARY_EVM.address }
      )
    ).rejects.toMatchObject({ code: "NOT_INITIALIZED" });
    expect(messages(iframe)).toHaveLength(sent);
    expectRequestReleased(host);
    host.destroy();
  });

  it("does not revoke an already-ready Host on a later CONNECT rejection", async () => {
    const { host, iframe } = await connectHost();
    const rejected = host.connect();
    await flushPromises();
    const request = requestsOfType(iframe, "CONNECT").at(-1)!;
    dispatchFromIframe(iframe, {
      type: "ERROR",
      id: request.id,
      payload: { requestId: request.id, code: "SIGN_FAILED", message: "denied" },
      timestamp: 1,
    });
    await expect(rejected).rejects.toMatchObject({ code: "SIGN_FAILED" });
    expect(host.currentState).toBe("ready");
    host.destroy();
  });

  it("unsubscribes an event handler idempotently", () => {
    const host = new IframeHost();
    const handler = vi.fn();
    const unsubscribe = host.onEvent("destroyed", handler);
    unsubscribe();
    unsubscribe();
    host.destroy();
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps a newer registration when an older subscription is cleaned up", () => {
    const host = new IframeHost();
    const handler = vi.fn();
    const unsubscribe = host.onEvent("destroyed", handler);
    host.onEvent("destroyed", handler);
    unsubscribe();
    host.destroy();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("publishes idle before rejection callbacks and preserves reentrant destruction", async () => {
    const host = new IframeHost();
    const states: string[] = [];
    host.onEvent("error", () => {
      states.push(host.currentState);
      host.destroy();
    });
    const { iframe, result } = await beginPrimaryConnect(host);
    await acknowledgeRelay(iframe);
    const request = requestOfType(iframe, "CONNECT");
    dispatchFromIframe(iframe, {
      type: "ERROR",
      id: request.id,
      payload: { requestId: request.id, code: "SIGN_FAILED", message: "denied" },
      timestamp: 1,
    });
    await expect(result).rejects.toMatchObject({ code: "SIGN_FAILED" });
    expect(states).toEqual(["idle"]);
    expect(host.currentState).toBe("destroyed");
  });

  it("returns an initially denied connection to idle without authorizing derive or sign", async () => {
    const host = new IframeHost();
    const { iframe, result } = await beginPrimaryConnect(host);
    await acknowledgeRelay(iframe);
    const request = requestOfType(iframe, "CONNECT");
    dispatchFromIframe(iframe, {
      type: "ERROR",
      id: request.id,
      payload: {
        requestId: request.id,
        code: "SIGN_FAILED",
        message: "The wallet request could not be completed.",
      },
      timestamp: 1,
    });
    await expect(result).rejects.toMatchObject({ code: "SIGN_FAILED" });
    expect(host.currentState).toBe("idle");
    const sent = messages(iframe).length;
    await expect(
      host.deriveAddress({ keyIndex: 1, curve: "secp256k1", group: "evm" })
    ).rejects.toMatchObject({ code: "NOT_INITIALIZED" });
    await expect(
      host.sign(
        { kind: "message", message: { type: "text", value: "test" } },
        { address: PRIMARY_EVM.address }
      )
    ).rejects.toMatchObject({ code: "NOT_INITIALIZED" });
    expect(messages(iframe)).toHaveLength(sent);
    const retry = host.connect();
    await flushPromises();
    const second = requestsOfType(iframe, "CONNECT").at(-1)!;
    expect(second.id).not.toBe(request.id);
    dispatchFromIframe(iframe, response("CONNECT_RESULT", second.id, { address: PRIMARY_EVM }));
    await expect(retry).resolves.toEqual({ address: PRIMARY_EVM });
    expect(host.currentState).toBe("ready");
    host.destroy();
  });

  it("keeps the declaration-safe package constructor wired to the concrete runtime", async () => {
    const host = new ExportedIframeHost();
    const connection = host.connect();
    const iframe = fakeDocument.iframe!;
    iframe.onload?.();
    await flushPromises();
    await acknowledgeRelay(iframe);
    const request = requestOfType(iframe, "CONNECT");
    dispatchFromIframe(iframe, response("CONNECT_RESULT", request.id, { address: PRIMARY_EVM }));

    await expect(connection).resolves.toEqual({ address: PRIMARY_EVM });
    expect(host.currentState).toBe("ready");
    host.destroy();
  });

  it("reserves the primary connect operation before iframe load and returns one exact result", async () => {
    const host = new IframeHost();
    const connection = host.connect();
    const reserved = requestState(host).activeRequest as { id: string; operation: string };

    expect(reserved).toMatchObject({ operation: "CONNECT" });
    expect(typeof reserved.id).toBe("string");

    const iframe = fakeDocument.iframe!;
    iframe.onload?.();
    await flushPromises();
    await acknowledgeRelay(iframe);
    const requests = requestsOfType(iframe, "CONNECT");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.id).toBe(reserved.id);

    dispatchFromIframe(iframe, response("CONNECT_RESULT", reserved.id, { address: PRIMARY_EVM }));
    await expect(connection).resolves.toEqual({ address: PRIMARY_EVM });
    expectRequestReleased(host);
    host.destroy();
  });

  it("adapts deprecated connect and sign results without starting a second request", async () => {
    const host = new IframeHost();
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    const iframe = fakeDocument.iframe!;
    iframe.onload?.();
    await flushPromises();
    await acknowledgeRelay(iframe);
    const connectRequest = requestOfType(iframe, "CONNECT");
    dispatchFromIframe(
      iframe,
      response("CONNECT_RESULT", connectRequest.id, { address: PRIMARY_EVM })
    );
    await expect(connection).resolves.toEqual(LEGACY_CONNECT_RESULT);
    expect(requestsOfType(iframe, "CONNECT")).toHaveLength(1);

    const signing = host.signWithDerivation(
      { kind: "message", message: { type: "text", value: "compatibility" } },
      { group: "evm", keyIndex: 0 }
    );
    const signRequest = requestsOfType(iframe, "SIGN_WITH_DERIVATION").at(-1)!;
    dispatchFromIframe(
      iframe,
      response("SIGN_RESULT", signRequest.id, {
        address: PRIMARY_EVM.address,
        signature: "0x0102",
      })
    );
    await expect(signing).resolves.toEqual({
      address: PRIMARY_EVM.address,
      signature: "0x0102",
      signerType: "derivation",
    });
    expect(requestsOfType(iframe, "SIGN_WITH_DERIVATION")).toHaveLength(1);
    host.destroy();
  });

  it("supports both primary sign overloads and derives through one operation each", async () => {
    const { host, iframe } = await connectHost();

    const derivation = host.deriveAddress({ keyIndex: 1, group: "evm" });
    const deriveRequest = requestsOfType(iframe, "DERIVE_ADDRESS").at(-1)!;
    const derivedAddress = {
      ...PRIMARY_EVM,
      address: "0x0000000000000000000000000000000000000002",
      keyIndex: 1,
    };
    dispatchFromIframe(
      iframe,
      response("DERIVE_ADDRESS_RESULT", deriveRequest.id, {
        success: true,
        address: derivedAddress,
      })
    );
    await expect(derivation).resolves.toEqual({ success: true, address: derivedAddress });

    const evmSigning = host.sign(
      { kind: "message", message: { type: "text", value: "primary" } },
      { address: PRIMARY_EVM.address }
    );
    const evmRequest = requestsOfType(iframe, "SIGN_WITH_DERIVATION").at(-1)!;
    dispatchFromIframe(
      iframe,
      response("SIGN_RESULT", evmRequest.id, {
        address: PRIMARY_EVM.address,
        signature: "0x0102",
      })
    );
    await expect(evmSigning).resolves.toEqual({
      address: PRIMARY_EVM.address,
      signature: "0x0102",
    });

    const solanaSigning = host.sign(
      { kind: "raw", payload: "0x0102" },
      { group: "solana", keyIndex: 2 }
    );
    const solanaRequest = requestsOfType(iframe, "SIGN_WITH_DERIVATION").at(-1)!;
    dispatchFromIframe(
      iframe,
      response("SIGN_RESULT", solanaRequest.id, {
        address: "solana-address",
        signature: "0x0304",
      })
    );
    await expect(solanaSigning).resolves.toEqual({
      address: "solana-address",
      signature: "0x0304",
    });
    expect(requestsOfType(iframe, "DERIVE_ADDRESS")).toHaveLength(1);
    expect(requestsOfType(iframe, "SIGN_WITH_DERIVATION")).toHaveLength(2);
    host.destroy();
  });

  it("materializes hostile public inputs before state checks without invoking accessors or wiring", async () => {
    const host = new IframeHost();
    const errorTrace: string[] = [];
    let accessorReads = 0;
    host.onEvent("error", (error) => errorTrace.push(error.code));
    const request = {};
    Object.defineProperty(request, "kind", {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return "raw";
      },
    });

    await expect(
      host.sign(request as { kind: "raw"; payload: `0x${string}` }, {
        group: "solana",
        keyIndex: 0,
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(accessorReads).toBe(0);
    expect(errorTrace).toEqual(["VALIDATION_FAILED"]);
    expect(fakeDocument.iframes).toHaveLength(0);
    expect(requestState(host).activeRequest).toBeNull();

    let directReads = 0;
    const proxiedRequest = new Proxy(
      { kind: "raw" as const, payload: "0x0102" as const },
      {
        get: (target, key, receiver) => {
          directReads += 1;
          return Reflect.get(target, key, receiver);
        },
      }
    );
    const proxiedOptions = new Proxy(
      { group: "solana" as const, keyIndex: 0 },
      {
        get: (target, key, receiver) => {
          directReads += 1;
          return Reflect.get(target, key, receiver);
        },
      }
    );
    await expect(host.sign(proxiedRequest, proxiedOptions)).rejects.toMatchObject({
      code: "NOT_INITIALIZED",
    });
    expect(directReads).toBe(0);
    expect(errorTrace).toEqual(["VALIDATION_FAILED", "NOT_INITIALIZED"]);
    expect(fakeDocument.iframes).toHaveLength(0);
    expectRequestReleased(host);
    host.destroy();
  });

  it("maps hostile deprecated connect options to one validation error without mounting", async () => {
    const host = new IframeHost();
    const errors: string[] = [];
    host.onEvent("error", (error) => errors.push(error.code));
    const options = new Proxy(
      { signerType: "derivation" as const },
      {
        ownKeys: () => {
          throw new Error("hostile option reflection");
        },
      }
    );

    await expect(host.connectWithSignerType(options)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(errors).toEqual(["VALIDATION_FAILED"]);
    expect(fakeDocument.iframes).toHaveLength(0);
    expectRequestReleased(host);
    host.destroy();
  });

  it("keeps destroyed precedence for invalid deprecated connect options", async () => {
    const host = new IframeHost();
    const errors: string[] = [];
    host.onEvent("error", (error) => errors.push(error.code));
    host.destroy();

    await expect(
      host.connectWithSignerType({ signerType: "passkey" } as never)
    ).rejects.toMatchObject({ code: "DESTROYED" });

    expect(errors).toEqual(["DESTROYED"]);
    expect(fakeDocument.iframes).toHaveLength(0);
    expectRequestReleased(host);
  });

  it("rejects destroyed primary calls before reading ambient ID capabilities", async () => {
    const host = new IframeHost();
    host.destroy();
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("destroyed Date.now must not run");
    });
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("destroyed Math.random must not run");
    });

    const outcomes = await Promise.all([
      host.connect().catch((error: unknown) => error),
      host.deriveAddress({ keyIndex: 0, group: "evm" }).catch((error: unknown) => error),
      host
        .sign(
          { kind: "message", message: { type: "text", value: "destroyed" } },
          { group: "evm", keyIndex: 0 }
        )
        .catch((error: unknown) => error),
    ]);
    const dateCalls = dateNow.mock.calls.length;
    const randomCalls = random.mock.calls.length;
    dateNow.mockRestore();
    random.mockRestore();

    expect(outcomes).toMatchObject([
      { code: "DESTROYED" },
      { code: "DESTROYED" },
      { code: "DESTROYED" },
    ]);
    expect(dateCalls).toBe(0);
    expect(randomCalls).toBe(0);
    expect(fakeDocument.iframes).toHaveLength(0);
    expectRequestReleased(host);
  });

  it.each(["Date.now", "Math.random"] as const)(
    "keeps DESTROYED authoritative when %s reenters connect and throws",
    async (capability) => {
      const host = new IframeHost();
      const errors: string[] = [];
      host.onEvent("error", (error) => errors.push(error.code));
      const ambientError = new Error(`${capability} failed after destroy`);
      const spy =
        capability === "Date.now"
          ? vi.spyOn(Date, "now").mockImplementation(() => {
              host.destroy();
              throw ambientError;
            })
          : vi.spyOn(Math, "random").mockImplementation(() => {
              host.destroy();
              throw ambientError;
            });

      const outcome = await host.connect().catch((error: unknown) => error);
      const calls = spy.mock.calls.length;
      spy.mockRestore();

      expect(outcome).toMatchObject({ code: "DESTROYED", message: "IframeHost destroyed" });
      expect(errors).toEqual(["DESTROYED"]);
      expect(calls).toBe(1);
      expect(host.currentState).toBe("destroyed");
      expect(fakeDocument.iframes).toHaveLength(0);
      expectRequestReleased(host);
    }
  );

  it("emits exactly one validation error before rejection even when its handler throws", async () => {
    const host = new IframeHost();
    const trace: string[] = [];
    host.onEvent("error", (error) => {
      trace.push(`event:${error.code}`);
      throw new Error("consumer error handler failed");
    });

    await expect(
      host.sign({ kind: "raw", payload: "0x01" }, { group: "evm", keyIndex: 0 } as never)
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    trace.push("rejected");

    expect(trace).toEqual(["event:VALIDATION_FAILED", "rejected"]);
    expect(fakeDocument.iframes).toHaveLength(0);
    host.destroy();
  });

  it("publishes one immutable error object to the handler and public rejection", async () => {
    const host = new IframeHost();
    let emitted: IframeError | null = null;
    let codeMutation: boolean | null = null;
    let messageMutation: boolean | null = null;
    host.onEvent("error", (error) => {
      emitted = error;
      codeMutation = Reflect.defineProperty(error, "code", {
        value: "DESTROYED",
      });
      messageMutation = Reflect.defineProperty(error, "message", {
        value: "consumer mutation",
      });
    });

    const rejected = await host
      .sign({ kind: "raw", payload: "0x01" }, { group: "evm", keyIndex: 0 } as never)
      .catch((error: unknown) => error);

    expect(rejected).toBe(emitted);
    expect(rejected).toBeInstanceOf(IframeError);
    expect(Object.isFrozen(rejected)).toBe(true);
    expect(codeMutation).toBe(false);
    expect(messageMutation).toBe(false);
    expect(rejected).toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Invalid signing request",
    });
    host.destroy();
  });

  it("emits once for each reentrant public rejection that reuses one normalized error", async () => {
    const host = new IframeHost();
    const emitted: IframeError[] = [];
    const nestedOutcomes: Promise<unknown>[] = [];
    const dateNow = vi.spyOn(Date, "now");
    let reentered = false;
    host.onEvent("error", (error) => {
      emitted.push(error);
      if (reentered) return;
      reentered = true;
      dateNow.mockImplementation(() => {
        throw error;
      });
      nestedOutcomes.push(host.connect().catch((cause: unknown) => cause));
    });

    const outer = await host
      .deriveAddress({ keyIndex: -1, group: "evm" })
      .catch((error: unknown) => error);
    const nested = await nestedOutcomes[0]!;
    dateNow.mockRestore();

    expect(outer).toBeInstanceOf(IframeError);
    expect(nested).toBe(outer);
    expect(emitted).toEqual([outer, nested]);
    host.destroy();
  });

  it("drains a rejected Promise returned by a deprecated error handler without delaying rejection", async () => {
    const host = new IframeHost();
    const trace: string[] = [];
    class ObservablePromise extends Promise<void> {}
    const handlerFailure = new ObservablePromise((_resolve, reject) => {
      reject(new Error("async consumer error"));
    });
    void handlerFailure.catch(() => undefined);
    let speciesReads = 0;
    Object.defineProperty(ObservablePromise, Symbol.species, {
      configurable: true,
      get: () => {
        speciesReads += 1;
        return Promise;
      },
    });
    const thenSpy = vi.spyOn(handlerFailure, "then");
    host.onEvent("error", (error) => {
      trace.push(`error:${error.code}`);
      return handlerFailure;
    });

    await expect(
      host.connectWithSignerType({ signerType: "passkey" } as never)
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    trace.push("rejected");
    await flushPromises();

    expect(trace).toEqual(["error:VALIDATION_FAILED", "rejected"]);
    expect(speciesReads).toBe(1);
    expect(thenSpy).not.toHaveBeenCalled();
    thenSpy.mockRestore();
    host.destroy();
  });

  it("contains a throwing then getter returned by an error handler", async () => {
    const host = new IframeHost();
    let thenReads = 0;
    const hostileThenable = Object.defineProperty({}, "then", {
      get: () => {
        thenReads += 1;
        throw new Error("hostile then getter");
      },
    });
    const errors: string[] = [];
    host.onEvent("error", (error) => {
      errors.push(error.code);
      return hostileThenable as never;
    });

    await expect(host.deriveAddress({ keyIndex: -1, group: "evm" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });

    expect(errors).toEqual(["VALIDATION_FAILED"]);
    expect(thenReads).toBe(1);
    host.destroy();
  });

  it("drains a rejected Promise returned by a hostile thenable handler", async () => {
    const host = new IframeHost();
    class ObservablePromise extends Promise<void> {}
    const returnedRejection = new ObservablePromise((_resolve, reject) => {
      reject(new Error("then return rejection"));
    });
    void returnedRejection.catch(() => undefined);
    let speciesReads = 0;
    Object.defineProperty(ObservablePromise, Symbol.species, {
      configurable: true,
      get: () => {
        speciesReads += 1;
        return Promise;
      },
    });
    const returnedThenSpy = vi.spyOn(returnedRejection, "then");
    let hostileThenCalls = 0;
    host.onEvent("error", () => {
      return {
        then(resolve: () => void) {
          hostileThenCalls += 1;
          resolve();
          return returnedRejection;
        },
      } as never;
    });

    await expect(host.deriveAddress({ keyIndex: -1, group: "evm" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await flushPromises();

    expect(hostileThenCalls).toBe(1);
    expect(speciesReads).toBe(1);
    expect(returnedThenSpy).not.toHaveBeenCalled();
    returnedThenSpy.mockRestore();
    host.destroy();
  });

  it("does not run returned thenable work before the public rejection", async () => {
    const host = new IframeHost();
    const trace: string[] = [];
    const returnedThenable = {
      then: (resolve: () => void) => {
        trace.push("thenable");
        resolve();
      },
    };
    host.onEvent("error", (error) => {
      trace.push(`error:${error.code}`);
      return returnedThenable as never;
    });

    const outcome = host.deriveAddress({ keyIndex: -1, group: "evm" }).catch((error: unknown) => {
      trace.push(`rejected:${(error as { code?: string }).code}`);
    });
    await outcome;

    expect(trace).toEqual(["error:VALIDATION_FAILED", "rejected:VALIDATION_FAILED"]);
    await flushPromises();
    expect(trace).toEqual(["error:VALIDATION_FAILED", "rejected:VALIDATION_FAILED", "thenable"]);
    host.destroy();
  });

  it("validates derive and both sign shapes before creating DOM or sending wire data", async () => {
    const host = new IframeHost();
    const errors: string[] = [];
    host.onEvent("error", (error) => errors.push(error.code));

    await expect(host.deriveAddress({ keyIndex: -1, group: "evm" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(
      host.sign(
        { kind: "message", message: { type: "text", value: "invalid address" } },
        { address: "0x1234" }
      )
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      host.sign({ kind: "raw", payload: "0x1" }, { group: "solana", keyIndex: 0 })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(errors).toEqual(["VALIDATION_FAILED", "VALIDATION_FAILED", "VALIDATION_FAILED"]);
    expect(fakeDocument.iframes).toHaveLength(0);
    expectRequestReleased(host);
    host.destroy();
  });

  it("normalizes a hostile Error message without leaving the public operation pending", async () => {
    const container = fakeDocument.createElement("wallet-container");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const hostileError = new Error("placeholder");
    Object.defineProperty(hostileError, "message", {
      configurable: true,
      get: () => {
        throw new Error("hostile message getter");
      },
    });
    vi.spyOn(container, "appendChild").mockImplementation(() => {
      throw hostileError;
    });
    const errors: string[] = [];
    host.onEvent("error", (error) => errors.push(error.code));
    let observed: { status: "fulfilled" | "rejected"; error?: unknown } | null = null;
    void host.connect().then(
      () => {
        observed = { status: "fulfilled" };
      },
      (error: unknown) => {
        observed = { status: "rejected", error };
      }
    );

    await flushPromises();
    const snapshot = observed;
    host.destroy();
    await flushPromises();

    expect(snapshot).toMatchObject({
      status: "rejected",
      error: { code: "SIGN_FAILED", message: "Wallet operation failed" },
    });
    expect(errors).toEqual(["SIGN_FAILED"]);
  });

  it("settles initialization when an Error proxy rejects instanceof classification", async () => {
    const container = fakeDocument.createElement("wallet-container");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const hostileError = new Proxy(new Error("hostile append failure"), {
      getPrototypeOf: () => {
        throw new Error("hostile getPrototypeOf trap");
      },
    });
    Object.defineProperty(container, "appendChild", {
      configurable: true,
      value: () => {
        throw hostileError;
      },
    });
    const errors: string[] = [];
    host.onEvent("error", (error) => errors.push(error.code));
    let observed: { status: "fulfilled" | "rejected"; error?: unknown } | null = null;
    void host.connect().then(
      () => {
        observed = { status: "fulfilled" };
      },
      (error: unknown) => {
        observed = { status: "rejected", error };
      }
    );

    await flushPromises();
    const snapshot = observed;
    host.destroy();
    await flushPromises();

    expect(snapshot).toMatchObject({
      status: "rejected",
      error: { code: "SIGN_FAILED", message: "Wallet operation failed" },
    });
    expect(errors).toEqual(["SIGN_FAILED"]);
  });

  it("emits once per operation when an external hook reuses the same Error object", async () => {
    const container = fakeDocument.createElement("wallet-container");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const reusedError = new Error("reused append failure");
    vi.spyOn(container, "appendChild").mockImplementation(() => {
      throw reusedError;
    });
    const errors: string[] = [];
    host.onEvent("error", (error) => errors.push(`${error.code}:${error.message}`));

    await expect(host.connect()).rejects.toMatchObject({ code: "SIGN_FAILED" });
    await expect(host.connect()).rejects.toMatchObject({ code: "SIGN_FAILED" });

    expect(errors).toEqual([
      "SIGN_FAILED:reused append failure",
      "SIGN_FAILED:reused append failure",
    ]);
    expectRequestReleased(host);
    host.destroy();
  });

  it("bounds a mutated external IframeError code to the public union", async () => {
    const container = fakeDocument.createElement("wallet-container");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const externalError = new IframeError("SIGN_FAILED", "external append failure");
    Object.defineProperty(externalError, "code", {
      configurable: true,
      value: "NOT_A_PUBLIC_ERROR_CODE",
    });
    vi.spyOn(container, "appendChild").mockImplementation(() => {
      throw externalError;
    });
    const errors: string[] = [];
    host.onEvent("error", (error) => errors.push(error.code));

    await expect(host.connect()).rejects.toMatchObject({
      code: "SIGN_FAILED",
      message: "external append failure",
    });

    expect(errors).toEqual(["SIGN_FAILED"]);
    host.destroy();
  });

  it("emits one initialization error and retries after a disconnected container is attached", async () => {
    const container = fakeDocument.createElement("wallet-container");
    const host = new IframeHost({ container: asHTMLElement(container) });
    const trace: string[] = [];
    host.onEvent("error", (error) => trace.push(`event:${error.code}`));

    await expect(host.connect()).rejects.toMatchObject({ code: "NOT_INITIALIZED" });
    trace.push("rejected");
    expect(trace).toEqual(["event:NOT_INITIALIZED", "rejected"]);
    expect(requestState(host).activeRequest).toBeNull();

    fakeDocument.body.appendChild(container);
    const { iframe, result } = await beginPrimaryConnect(host);
    await acknowledgeRelay(iframe);
    const request = requestOfType(iframe, "CONNECT");
    dispatchFromIframe(iframe, response("CONNECT_RESULT", request.id, { address: PRIMARY_EVM }));
    await expect(result).resolves.toEqual({ address: PRIMARY_EVM });
    host.destroy();
  });

  it("emits one timeout error before rejection and remains reusable", async () => {
    const host = new IframeHost({ timeout: 50 });
    const trace: string[] = [];
    host.onEvent("error", (error) => trace.push(`event:${error.code}`));
    const { iframe, result } = await beginPrimaryConnect(host);
    const outcome = result.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    await acknowledgeRelay(iframe);
    expect(requestsOfType(iframe, "CONNECT")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(51);
    await expect(outcome).resolves.toMatchObject({
      status: "rejected",
      error: { code: "TIMEOUT" },
    });
    trace.push("rejected");
    expect(trace).toEqual(["event:TIMEOUT", "rejected"]);
    expectRequestReleased(host);

    const retry = host.connect();
    await flushPromises();
    const retryRequest = requestsOfType(iframe, "CONNECT").at(-1)!;
    dispatchFromIframe(
      iframe,
      response("CONNECT_RESULT", retryRequest.id, { address: PRIMARY_EVM })
    );
    await expect(retry).resolves.toEqual({ address: PRIMARY_EVM });
    host.destroy();
  });

  it("emits one relay error through a deprecated wrapper before rejection", async () => {
    const { host, iframe } = await connectHost();
    const trace: string[] = [];
    host.onEvent("error", (error) => {
      trace.push(`event:${error.code}`);
      throw new Error("throwing relay-error consumer");
    });
    const signing = host.signWithDerivation(
      { kind: "message", message: { type: "text", value: "relay failure" } },
      { group: "evm", keyIndex: 0 }
    );
    const request = requestsOfType(iframe, "SIGN_WITH_DERIVATION").at(-1)!;

    dispatchFromIframe(iframe, {
      type: "ERROR",
      id: request.id,
      payload: {
        requestId: request.id,
        code: "SIGN_FAILED",
        message: "Relay rejected signing",
      },
      timestamp: 1,
    });
    await expect(signing).rejects.toMatchObject({
      code: "SIGN_FAILED",
      message: "Relay rejected signing",
    });
    trace.push("rejected");

    expect(trace).toEqual(["event:SIGN_FAILED", "rejected"]);
    expectRequestReleased(host);
    host.destroy();
  });

  it("cancels initialization locally once and reuses the host without sending CANCEL", async () => {
    const host = new IframeHost();
    const errors: string[] = [];
    host.onEvent("error", (error) => errors.push(error.code));
    expect(host.cancel()).toBe(false);
    const connection = host.connect();
    const firstIframe = fakeDocument.iframe!;
    const outcome = connection.catch((error: unknown) => error);

    expect(host.cancel()).toBe(true);
    expect(host.cancel()).toBe(false);
    await expect(outcome).resolves.toMatchObject({ code: "USER_CANCELLED" });
    expect(errors).toEqual(["USER_CANCELLED"]);
    expect(requestsOfType(firstIframe, "CANCEL")).toHaveLength(0);
    expect(host.currentState).toBe("idle");
    expectRequestReleased(host);

    const { iframe, result } = await beginPrimaryConnect(host);
    expect(iframe).not.toBe(firstIframe);
    await acknowledgeRelay(iframe);
    const request = requestOfType(iframe, "CONNECT");
    dispatchFromIframe(iframe, response("CONNECT_RESULT", request.id, { address: PRIMARY_EVM }));
    await expect(result).resolves.toEqual({ address: PRIMARY_EVM });
    host.destroy();
  });

  it("keeps USER_CANCELLED authoritative when its error handler destroys the host", async () => {
    const host = new IframeHost();
    const trace: string[] = [];
    host.onEvent("error", (error) => {
      trace.push(`error:${error.code}`);
      host.destroy();
    });
    host.onEvent("destroyed", () => trace.push("destroyed"));
    const pending = host.connect().catch((error: { code: string }) => {
      trace.push(`rejected:${error.code}`);
    });

    expect(host.cancel()).toBe(true);
    await pending;
    await flushPromises();

    expect(trace).toEqual(["error:USER_CANCELLED", "rejected:USER_CANCELLED", "destroyed"]);
    expect(host.currentState).toBe("destroyed");
    expectRequestReleased(host);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rolls back a surface whose configured-container append reenters local cancellation", async () => {
    const container = fakeDocument.createElement("wallet-container");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const appendChild = container.appendChild.bind(container);
    let cancelResult: boolean | null = null;
    let cancelDuringAppend = true;
    vi.spyOn(container, "appendChild").mockImplementation((child) => {
      const appended = appendChild(child);
      if (cancelDuringAppend) {
        cancelDuringAppend = false;
        cancelResult = host.cancel();
      }
      return appended;
    });

    await expect(host.connect()).rejects.toMatchObject({ code: "USER_CANCELLED" });
    await flushPromises();
    expect(cancelResult).toBe(true);
    expect(host.currentState).toBe("idle");
    expect(container.children).toHaveLength(0);
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);

    const retry = host.connect();
    const iframe = fakeDocument.iframe!;
    iframe.onload?.();
    await flushPromises();
    await acknowledgeRelay(iframe);
    const request = requestOfType(iframe, "CONNECT");
    dispatchFromIframe(iframe, response("CONNECT_RESULT", request.id, { address: PRIMARY_EVM }));
    await expect(retry).resolves.toEqual({ address: PRIMARY_EVM });
    host.destroy();
  });

  it("lets a synchronously claimed request timeout win over reentrant cancellation", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    let host: IframeHost | null = null;
    let timeoutThenCancel = false;
    let cancelResult: boolean | null = null;
    vi.stubGlobal("setTimeout", ((...args: Parameters<typeof setTimeout>) => {
      const timeout = nativeSetTimeout(...args);
      if (timeoutThenCancel) {
        timeoutThenCancel = false;
        const callback = args[0];
        if (typeof callback === "function") callback(...args.slice(2));
        cancelResult = host!.cancel();
      }
      return timeout;
    }) as typeof setTimeout);
    host = new IframeHost({ timeout: 60_000 });
    const { iframe, result } = await beginPrimaryConnect(host);
    await acknowledgeRelay(iframe);
    const connectRequest = requestOfType(iframe, "CONNECT");
    dispatchFromIframe(
      iframe,
      response("CONNECT_RESULT", connectRequest.id, { address: PRIMARY_EVM })
    );
    await result;
    const errors: string[] = [];
    host.onEvent("error", (error) => errors.push(error.code));

    timeoutThenCancel = true;
    const signing = host.sign(
      { kind: "message", message: { type: "text", value: "timeout owns terminal" } },
      { group: "evm", keyIndex: 0 }
    );

    await expect(signing).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(cancelResult).toBe(false);
    expect(errors).toEqual(["TIMEOUT"]);
    expect(requestsOfType(iframe, "SIGN_WITH_DERIVATION")).toHaveLength(0);
    expect(requestsOfType(iframe, "CANCEL")).toHaveLength(0);
    expectRequestReleased(host);
    expect(vi.getTimerCount()).toBe(0);
    host.destroy();
  });

  it("keeps cancellation local when relay delivery access reenters before postMessage", async () => {
    const { host, iframe } = await connectHost();
    const trigger = fakeDocument.createElement("button");
    fakeDocument.body.appendChild(trigger);
    fakeDocument.activeElement = trigger;
    let cancelResult: boolean | null = null;
    const delivered: unknown[] = [];
    const errors: string[] = [];
    host.onEvent("error", (error) => errors.push(error.code));
    Object.defineProperty(iframe.contentWindow, "postMessage", {
      configurable: true,
      get: () => {
        cancelResult = host.cancel();
        return (message: unknown) => delivered.push(message);
      },
    });

    const signing = host.sign(
      { kind: "message", message: { type: "text", value: "pre-delivery cancel" } },
      { group: "evm", keyIndex: 0 }
    );
    await expect(signing).rejects.toMatchObject({ code: "USER_CANCELLED" });
    await flushPromises();

    expect(cancelResult).toBe(true);
    expect(delivered).toEqual([]);
    expect(errors).toEqual(["USER_CANCELLED"]);
    expect(trigger.focus).toHaveBeenCalledOnce();
    expect(fakeDocument.activeElement).toBe(trigger);
    expect(host.currentState).toBe("idle");
    expectRequestReleased(host);
    expect(vi.getTimerCount()).toBe(0);

    const retry = host.connect();
    const retryIframe = fakeDocument.iframe!;
    retryIframe.onload?.();
    await flushPromises();
    await acknowledgeRelay(retryIframe);
    const retryRequest = requestOfType(retryIframe, "CONNECT");
    dispatchFromIframe(
      retryIframe,
      response("CONNECT_RESULT", retryRequest.id, { address: PRIMARY_EVM })
    );
    await expect(retry).resolves.toEqual({ address: PRIMARY_EVM });
    host.destroy();
  });

  it("restores focus when iframe focus reenters pre-dispatch cancellation", async () => {
    const { host, iframe } = await connectHost();
    const trigger = fakeDocument.createElement("button");
    fakeDocument.body.appendChild(trigger);
    fakeDocument.activeElement = trigger;
    const errors: string[] = [];
    let cancelResult: boolean | null = null;
    host.onEvent("error", (error) => errors.push(error.code));
    iframe.focus.mockImplementation(() => {
      fakeDocument.focusElement(iframe);
      cancelResult = host.cancel();
    });

    const signing = host.sign(
      { kind: "message", message: { type: "text", value: "focus reentry cancel" } },
      { group: "evm", keyIndex: 0 }
    );
    await expect(signing).rejects.toMatchObject({ code: "USER_CANCELLED" });
    await flushPromises();

    expect(cancelResult).toBe(true);
    expect(errors).toEqual(["USER_CANCELLED"]);
    expect(requestsOfType(iframe, "SIGN_WITH_DERIVATION")).toHaveLength(0);
    expect(requestsOfType(iframe, "CANCEL")).toHaveLength(0);
    expect(trigger.focus).toHaveBeenCalledOnce();
    expect(fakeDocument.activeElement).toBe(trigger);
    expect(host.currentState).toBe("idle");
    expectRequestReleased(host);
    expect(vi.getTimerCount()).toBe(0);

    const retry = host.connect();
    const retryIframe = fakeDocument.iframe!;
    retryIframe.onload?.();
    await flushPromises();
    await acknowledgeRelay(retryIframe);
    const retryRequest = requestOfType(retryIframe, "CONNECT");
    dispatchFromIframe(
      retryIframe,
      response("CONNECT_RESULT", retryRequest.id, { address: PRIMARY_EVM })
    );
    await expect(retry).resolves.toEqual({ address: PRIMARY_EVM });
    host.destroy();
  });

  it.each(["iframe focus", "postMessage getter"] as const)(
    "restores focus before a %s cancellation error handler destroys the host",
    async (reentry) => {
      const { host, iframe } = await connectHost();
      const trigger = fakeDocument.createElement("button");
      fakeDocument.body.appendChild(trigger);
      fakeDocument.activeElement = trigger;
      const trace: string[] = [];
      let cancelResult: boolean | null = null;
      host.onEvent("error", (error) => {
        trace.push(`error:${error.code}`);
        host.destroy();
      });
      host.onEvent("destroyed", () => trace.push("destroyed"));

      if (reentry === "iframe focus") {
        iframe.focus.mockImplementation(() => {
          fakeDocument.focusElement(iframe);
          cancelResult = host.cancel();
        });
      } else {
        const deliver = iframe.contentWindow.postMessage;
        Object.defineProperty(iframe.contentWindow, "postMessage", {
          configurable: true,
          get: () => {
            if (cancelResult === null) cancelResult = host.cancel();
            return deliver;
          },
        });
      }

      const signing = host
        .sign(
          { kind: "message", message: { type: "text", value: "cancel then destroy" } },
          { group: "evm", keyIndex: 0 }
        )
        .catch((error: { code: string }) => {
          trace.push(`rejected:${error.code}`);
        });
      await signing;
      await flushPromises();

      expect(cancelResult).toBe(true);
      expect(trigger.focus).toHaveBeenCalledOnce();
      expect(fakeDocument.activeElement).toBe(trigger);
      expect(trace).toEqual(["error:USER_CANCELLED", "rejected:USER_CANCELLED", "destroyed"]);
      expect(host.currentState).toBe("destroyed");
      expectRequestReleased(host);
      expect(fakeDocument.overlay?.parentElement).toBeNull();
      expect(fakeWindow.messageListenerCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("claims post-dispatch cancellation, drains its exact acknowledgement, and then reuses relay", async () => {
    const host = new IframeHost();
    const errors: string[] = [];
    host.onEvent("error", (error) => errors.push(error.code));
    const { iframe, result } = await beginPrimaryConnect(host);
    await acknowledgeRelay(iframe);
    const activeRequest = requestOfType(iframe, "CONNECT");
    const outcome = result.catch((error: unknown) => error);

    expect(host.cancel()).toBe(true);
    expect(host.cancel()).toBe(false);
    await expect(outcome).resolves.toMatchObject({ code: "USER_CANCELLED" });
    const cancel = requestOfType(iframe, "CANCEL");
    expect(cancel.id).not.toBe(activeRequest.id);
    expect(cancel.payload).toEqual({ requestId: activeRequest.id });
    expect(errors).toEqual(["USER_CANCELLED"]);

    await expect(host.deriveAddress({ keyIndex: 0, group: "evm" })).rejects.toMatchObject({
      code: "SIGN_FAILED",
    });
    expect(errors).toEqual(["USER_CANCELLED", "SIGN_FAILED"]);

    dispatchFromIframe(iframe, {
      type: "ERROR",
      id: activeRequest.id,
      payload: {
        requestId: activeRequest.id,
        code: "USER_CANCELLED",
        message: "User cancelled the operation",
      },
      timestamp: 1,
    });
    await flushPromises();
    expectRequestReleased(host);
    expect(vi.getTimerCount()).toBe(0);

    const retry = host.connect();
    await flushPromises();
    const retryRequest = requestsOfType(iframe, "CONNECT").at(-1)!;
    dispatchFromIframe(
      iframe,
      response("CONNECT_RESULT", retryRequest.id, { address: PRIMARY_EVM })
    );
    await expect(retry).resolves.toEqual({ address: PRIMARY_EVM });
    host.destroy();
  });

  it("routes overlay Escape through the same exact post-dispatch cancellation", async () => {
    const host = new IframeHost();
    const { iframe, result } = await beginPrimaryConnect(host);
    const outcome = result.catch((error: unknown) => error);
    await acknowledgeRelay(iframe);
    const activeRequest = requestOfType(iframe, "CONNECT");

    fakeDocument.dispatchKey("Escape");
    await expect(outcome).resolves.toMatchObject({ code: "USER_CANCELLED" });
    const cancels = requestsOfType(iframe, "CANCEL");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.payload).toEqual({ requestId: activeRequest.id });

    dispatchFromIframe(iframe, {
      type: "ERROR",
      id: activeRequest.id,
      payload: {
        requestId: activeRequest.id,
        code: "USER_CANCELLED",
        message: "User cancelled the operation",
      },
      timestamp: 1,
    });
    await flushPromises();
    expectRequestReleased(host);
    expect(vi.getTimerCount()).toBe(0);
    host.destroy();
  });

  it("resets only the stale relay after the two-second cancellation drain bound", async () => {
    const host = new IframeHost();
    const { iframe: oldIframe, result } = await beginPrimaryConnect(host);
    await acknowledgeRelay(oldIframe);
    const oldRequest = requestOfType(oldIframe, "CONNECT");
    const outcome = result.catch((error: unknown) => error);

    expect(host.cancel()).toBe(true);
    await expect(outcome).resolves.toMatchObject({ code: "USER_CANCELLED" });
    await vi.advanceTimersByTimeAsync(2_001);

    expect(host.currentState).toBe("idle");
    expect(oldIframe.isConnected).toBe(false);
    expectRequestReleased(host);

    const retry = host.connect();
    const newIframe = fakeDocument.iframe!;
    expect(newIframe).not.toBe(oldIframe);
    dispatchFromIframe(
      oldIframe,
      response("CONNECT_RESULT", oldRequest.id, { address: PRIMARY_EVM })
    );
    newIframe.onload?.();
    await flushPromises();
    await acknowledgeRelay(newIframe);
    const newRequest = requestOfType(newIframe, "CONNECT");
    dispatchFromIframe(
      newIframe,
      response("CONNECT_RESULT", newRequest.id, { address: PRIMARY_EVM })
    );
    await expect(retry).resolves.toEqual({ address: PRIMARY_EVM });
    host.destroy();
  });

  it("lets a fully validated terminal win before a later cancellation", async () => {
    const { host, iframe } = await connectHost();
    const signing = host.sign(
      { kind: "message", message: { type: "text", value: "first claim" } },
      { group: "evm", keyIndex: 0 }
    );
    const request = requestsOfType(iframe, "SIGN_WITH_DERIVATION").at(-1)!;

    dispatchFromIframe(
      iframe,
      response("SIGN_RESULT", request.id, {
        address: PRIMARY_EVM.address,
        signature: "0x0102",
      })
    );
    expect(host.cancel()).toBe(false);
    await expect(signing).resolves.toEqual({
      address: PRIMARY_EVM.address,
      signature: "0x0102",
    });
    expect(requestsOfType(iframe, "CANCEL")).toHaveLength(0);
    host.destroy();
  });

  it("orders direct active destruction as error, rejection, then one destroyed event", async () => {
    const host = new IframeHost();
    const trace: string[] = [];
    host.onEvent("error", (error) => {
      trace.push(`error:${error.code}`);
      throw new Error("throwing error listener");
    });
    host.onEvent("destroyed", () => {
      trace.push("destroyed");
      throw new Error("throwing destroyed listener");
    });
    const pending = host.connect().catch((error: { code: string }) => {
      trace.push(`rejected:${error.code}`);
    });

    host.destroy();
    host.destroy();
    await pending;
    await flushPromises();

    expect(trace).toEqual(["error:DESTROYED", "rejected:DESTROYED", "destroyed"]);
    expect(host.currentState).toBe("destroyed");
    expectRequestReleased(host);
  });

  it("drains a hostile destroyed thenable once while preserving active destroy ordering", async () => {
    const host = new IframeHost();
    const trace: string[] = [];
    let thenReads = 0;
    let thenCalls = 0;
    let rejectCalls = 0;
    const handlerFailure = new Error("destroyed thenable rejection");
    const hostileThenable = Object.defineProperty({}, "then", {
      get: () => {
        thenReads += 1;
        return (_resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
          thenCalls += 1;
          host.destroy();
          rejectCalls += 1;
          reject(handlerFailure);
          rejectCalls += 1;
          reject(handlerFailure);
          throw new Error("destroyed thenable throw");
        };
      },
    });
    host.onEvent("error", (error) => trace.push(`error:${error.code}`));
    host.onEvent("destroyed", () => {
      trace.push("destroyed");
      return hostileThenable as never;
    });
    const pending = host.connect().catch((error: { code: string }) => {
      trace.push(`rejected:${error.code}`);
    });

    expect(() => host.destroy()).not.toThrow();
    await pending;
    await flushPromises();

    expect(trace).toEqual(["error:DESTROYED", "rejected:DESTROYED", "destroyed"]);
    expect(thenReads).toBe(1);
    expect(thenCalls).toBe(1);
    expect(rejectCalls).toBe(2);
    expectRequestReleased(host);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["primary", "synchronous"],
    ["primary", "throwing"],
    ["deprecated", "synchronous"],
    ["deprecated", "throwing"],
  ] as const)(
    "keeps %s destroy ordering under a %s queueMicrotask replacement",
    async (api, replacement) => {
      const host = new IframeHost();
      const trace: string[] = [];
      host.onEvent("error", (error) => trace.push(`error:${error.code}`));
      host.onEvent("destroyed", () => trace.push("destroyed"));
      const pending = (
        api === "primary"
          ? host.connect()
          : host.connectWithSignerType({ signerType: "derivation" })
      ).catch((error: { code: string }) => {
        trace.push(`rejected:${error.code}`);
      });
      vi.stubGlobal(
        "queueMicrotask",
        replacement === "synchronous"
          ? (callback: VoidFunction) => callback()
          : () => {
              throw new Error("replacement queueMicrotask failed");
            }
      );

      expect(() => host.destroy()).not.toThrow();
      expect(trace).toEqual(["error:DESTROYED"]);
      await pending;
      await flushPromises();

      expect(trace).toEqual(["error:DESTROYED", "rejected:DESTROYED", "destroyed"]);
      expect(host.currentState).toBe("destroyed");
      expectRequestReleased(host);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("preserves active destruction ordering through the deprecated connect adapter", async () => {
    const host = new IframeHost();
    const trace: string[] = [];
    host.onEvent("error", (error) => trace.push(`error:${error.code}`));
    host.onEvent("destroyed", () => trace.push("destroyed"));
    const pending = host
      .connectWithSignerType({ signerType: "derivation" })
      .catch((error: { code: string }) => {
        trace.push(`rejected:${error.code}`);
      });

    host.destroy();
    await pending;
    await flushPromises();

    expect(trace).toEqual(["error:DESTROYED", "rejected:DESTROYED", "destroyed"]);
    expectRequestReleased(host);
  });

  it("orders configured-container destruction once and ignores late terminals", async () => {
    const container = fakeDocument.createElement("wallet-container");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const trace: string[] = [];
    host.onEvent("error", (error) => trace.push(`error:${error.code}`));
    host.onEvent("destroyed", () => trace.push("destroyed"));
    const { iframe, result } = await beginPrimaryConnect(host);
    await acknowledgeRelay(iframe);
    const request = requestOfType(iframe, "CONNECT");
    const pending = result.catch((error: { code: string }) => {
      trace.push(`rejected:${error.code}`);
    });

    container.remove();
    FakeMutationObserver.flushAll([removalRecord(container)]);
    FakeMutationObserver.flushAll([removalRecord(container)]);
    dispatchFromIframe(iframe, response("CONNECT_RESULT", request.id, { address: PRIMARY_EVM }));
    await pending;
    await flushPromises();

    expect(trace).toEqual(["error:DESTROYED", "rejected:DESTROYED", "destroyed"]);
    expect(host.currentState).toBe("destroyed");
    expectRequestReleased(host);
  });
});

describe("IframeHost contentWindow access inventory", () => {
  it("reads the owned iframe window only for initial binding and outbound delivery", async () => {
    const container = fakeDocument.createElement("section");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const appendChild = container.appendChild.bind(container);
    let getterCalls = 0;
    let relayWindow: FakeContentWindow | null = null;
    vi.spyOn(container, "appendChild").mockImplementation((child) => {
      const appended = appendChild(child);
      const iframe = fakeDocument.iframe!;
      relayWindow = iframe.contentWindow;
      Object.defineProperty(iframe, "contentWindow", {
        configurable: true,
        get: () => {
          getterCalls += 1;
          return relayWindow;
        },
      });
      return appended;
    });

    const connection = host.connectWithSignerType({ signerType: "derivation" });
    const iframe = fakeDocument.iframe!;
    expect(getterCalls).toBe(1);

    iframe.onload?.();
    await flushPromises();
    expect(getterCalls).toBe(2);

    dispatchFromIframe(iframe, { type: "RELAY_READY", version: 2 }, { source: relayWindow });
    await flushPromises();
    expect(getterCalls).toBe(3);
    const connectRequest = relayWindow!.postMessage.mock.calls
      .map(([message]) => message as IframeMessage)
      .find((message) => message.type === "CONNECT");
    if (!connectRequest) throw new Error("Missing CONNECT request");

    dispatchFromIframe(
      iframe,
      response("CONNECT_RESULT", connectRequest.id, { address: PRIMARY_EVM }),
      { source: relayWindow }
    );
    await expect(connection).resolves.toEqual(LEGACY_CONNECT_RESULT);
    expect(getterCalls).toBe(3);

    host.destroy();
    expect(getterCalls).toBe(3);
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("IframeHost relay bootstrap", () => {
  it("uses the maintained embed relay and a sandbox without WebAuthn delegation by default", async () => {
    expect(DEFAULT_IFRAME_SRC).toBe(EMBED_ORIGIN);

    const host = new IframeHost();
    void host.connectWithSignerType({ signerType: "derivation" }).catch(() => undefined);
    const iframe = fakeDocument.iframe!;

    expect(iframe.src).toBe(`${EMBED_ORIGIN}/en`);
    expect(iframe.referrerPolicy).toBe("no-referrer");
    expect(iframe.allow).toBe("");
    expect(iframe.attributes.get("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
    );
    host.destroy();
  });

  it("sends exact RELAY_INIT only after the iframe load event", async () => {
    const host = new IframeHost();
    void host.connectWithSignerType({ signerType: "derivation" }).catch(() => undefined);
    const iframe = fakeDocument.iframe!;

    expect(iframe.contentWindow.postMessage).not.toHaveBeenCalled();
    iframe.onload?.();
    await flushPromises();

    expect(iframe.contentWindow.postMessage).toHaveBeenCalledWith(
      { type: "RELAY_INIT", version: 2 },
      EMBED_ORIGIN
    );
    host.destroy();
  });

  it("retries RELAY_INIT when the relay starts listening after the first delivery", async () => {
    const host = new IframeHost({ timeout: 2_000 });
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    void connection.catch(() => undefined);
    const iframe = fakeDocument.iframe!;
    let initAttempts = 0;
    iframe.contentWindow.postMessage.mockImplementation((message) => {
      if (
        JSON.stringify(message) === JSON.stringify({ type: "RELAY_INIT", version: 2 }) &&
        ++initAttempts === 2
      ) {
        dispatchFromIframe(iframe, { type: "RELAY_READY", version: 2 });
      }
    });

    iframe.onload?.();
    await flushPromises();
    expect(initAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(initAttempts).toBe(2);
    const initCalls = iframe.contentWindow.postMessage.mock.calls.filter(
      ([message]) => (message as { type?: string }).type === "RELAY_INIT"
    );
    expect(initCalls).toEqual([
      [{ type: "RELAY_INIT", version: 2 }, EMBED_ORIGIN],
      [{ type: "RELAY_INIT", version: 2 }, EMBED_ORIGIN],
    ]);

    const request = requestOfType(iframe, "CONNECT");
    expect(request.payload).toEqual({});
    dispatchFromIframe(iframe, response("CONNECT_RESULT", request.id, { address: PRIMARY_EVM }));
    await expect(connection).resolves.toEqual(LEGACY_CONNECT_RESULT);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(initAttempts).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves relay readiness when the retry scheduler throws after READY settles", async () => {
    const nativeSetInterval = globalThis.setInterval;
    const schedulingError = new Error("relay retry scheduler failed after READY");
    let iframe: FakeIframe | null = null;
    let schedulerCalls = 0;
    vi.stubGlobal("setInterval", ((...args: Parameters<typeof setInterval>) => {
      schedulerCalls += 1;
      nativeSetInterval(...args);
      if (iframe) dispatchFromIframe(iframe, { type: "RELAY_READY", version: 2 });
      throw schedulingError;
    }) as typeof setInterval);
    const host = new IframeHost();
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    const outcome = connection.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    iframe = fakeDocument.iframe!;

    iframe.onload?.();
    await flushPromises();
    await flushPromises();

    expect(schedulerCalls).toBe(1);
    expect(
      messages(iframe).filter((message) => (message as { type?: string }).type === "RELAY_INIT")
    ).toHaveLength(1);
    const request = requestOfType(iframe, "CONNECT");
    dispatchFromIframe(iframe, response("CONNECT_RESULT", request.id, { address: PRIMARY_EVM }));
    await expect(outcome).resolves.toEqual({
      status: "fulfilled",
      value: LEGACY_CONNECT_RESULT,
    });
    const timerState = host as unknown as {
      relayInitializationRetry: ReturnType<typeof setInterval> | null;
      relayInitializationRetryToken: object | null;
    };
    expect(timerState.relayInitializationRetry).toBeNull();
    expect(timerState.relayInitializationRetryToken).toBeNull();

    const wireCount = messages(iframe).length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(messages(iframe)).toHaveLength(wireCount);
    expectRequestReleased(host);
    host.destroy();
  });

  it("clears a retry interval returned after its scheduler destroys the host", async () => {
    const nativeSetInterval = globalThis.setInterval;
    let host: IframeHost | null = null;
    let wrapperCalls = 0;
    vi.stubGlobal("setInterval", ((...args: Parameters<typeof setInterval>) => {
      wrapperCalls += 1;
      const interval = nativeSetInterval(...args);
      host?.destroy();
      return interval;
    }) as typeof setInterval);
    host = new IframeHost();
    const onDestroyed = vi.fn();
    host.onEvent("destroyed", onDestroyed);
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    const rejection = expect(connection).rejects.toMatchObject({ code: "DESTROYED" });
    const iframe = fakeDocument.iframe!;

    iframe.onload?.();
    await flushPromises();
    await rejection;

    const timerState = host as unknown as {
      relayInitializationRetry: ReturnType<typeof setInterval> | null;
    };
    expect(wrapperCalls).toBe(1);
    expect(timerState.relayInitializationRetry).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(onDestroyed).toHaveBeenCalledOnce();
    expect(fakeDocument.overlay?.parentElement).toBeNull();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);
  });

  it.each(["before", "after"] as const)(
    "uses its captured interval capability when a replacement throws %s native scheduling",
    async (throwPhase) => {
      const host = new IframeHost();
      const nativeSetInterval = globalThis.setInterval;
      const wrapperError = new Error(`interval replacement threw ${throwPhase} native scheduling`);
      let wrapperCalls = 0;
      vi.stubGlobal("setInterval", ((...args: Parameters<typeof setInterval>) => {
        wrapperCalls += 1;
        if (throwPhase === "before") throw wrapperError;
        nativeSetInterval(...args);
        throw wrapperError;
      }) as typeof setInterval);
      const connection = host.connectWithSignerType({ signerType: "derivation" });
      const outcome = connection.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error })
      );
      const iframe = fakeDocument.iframe!;

      try {
        iframe.onload?.();
        await flushPromises();
        expect(wrapperCalls).toBe(0);
      } finally {
        host.destroy();
        await outcome;
      }

      await expect(outcome).resolves.toMatchObject({
        status: "rejected",
        error: { code: "DESTROYED" },
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(fakeDocument.overlay?.parentElement).toBeNull();
      expect(fakeWindow.messageListenerCount).toBe(0);
    }
  );

  it("uses its captured load timer when a replacement destroys then throws after native scheduling", async () => {
    const host = new IframeHost();
    const nativeSetTimeout = globalThis.setTimeout;
    const schedulingError = new Error("load timer replacement failed after native scheduling");
    let wrapperCalls = 0;
    vi.stubGlobal("setTimeout", ((...args: Parameters<typeof setTimeout>) => {
      wrapperCalls += 1;
      nativeSetTimeout(...args);
      host.destroy();
      throw schedulingError;
    }) as typeof setTimeout);
    const outcome = host.connectWithSignerType({ signerType: "derivation" }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );

    await flushPromises();
    expect(wrapperCalls).toBe(0);
    expect(host.currentState).toBe("loading");

    host.destroy();
    await expect(outcome).resolves.toMatchObject({
      status: "rejected",
      error: { code: "DESTROYED" },
    });
    const timerState = host as unknown as {
      loadTimeout: ReturnType<typeof setTimeout> | null;
    };
    expect(timerState.loadTimeout).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(fakeDocument.overlay?.parentElement).toBeNull();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);
  });

  it("uses captured timer cancellation capabilities after global replacements", async () => {
    const host = new IframeHost();
    let timeoutCancellationCalls = 0;
    let intervalCancellationCalls = 0;
    vi.stubGlobal("clearTimeout", (() => {
      timeoutCancellationCalls += 1;
      throw new Error("replacement clearTimeout failed");
    }) as typeof clearTimeout);
    vi.stubGlobal("clearInterval", (() => {
      intervalCancellationCalls += 1;
      throw new Error("replacement clearInterval failed");
    }) as typeof clearInterval);
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    const iframe = fakeDocument.iframe!;

    iframe.onload?.();
    await flushPromises();
    await acknowledgeRelay(iframe);
    const request = requestOfType(iframe, "CONNECT");
    dispatchFromIframe(iframe, response("CONNECT_RESULT", request.id, { address: PRIMARY_EVM }));
    await expect(connection).resolves.toEqual(LEGACY_CONNECT_RESULT);
    expect(() => host.destroy()).not.toThrow();

    expect(timeoutCancellationCalls).toBe(0);
    expect(intervalCancellationCalls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(fakeDocument.overlay?.parentElement).toBeNull();
    expect(fakeWindow.messageListenerCount).toBe(0);
  });

  it("does not resurrect relay initialization after its ready timer scheduler destroys", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    let host: IframeHost | null = null;
    let schedulerCalls = 0;
    vi.stubGlobal("setTimeout", ((...args: Parameters<typeof setTimeout>) => {
      schedulerCalls += 1;
      const timeout = nativeSetTimeout(...args);
      if (schedulerCalls === 2) host?.destroy();
      return timeout;
    }) as typeof setTimeout);
    host = new IframeHost();
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    const outcome = connection.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    const iframe = fakeDocument.iframe!;

    iframe.onload?.();
    await flushPromises();

    await expect(outcome).resolves.toMatchObject({
      status: "rejected",
      error: { code: "DESTROYED" },
    });
    const timerState = host as unknown as {
      readyTimeout: ReturnType<typeof setTimeout> | null;
      readyResolver: (() => void) | null;
      relayInitializationSent: boolean;
    };
    expect(schedulerCalls).toBe(2);
    expect(timerState.readyTimeout).toBeNull();
    expect(timerState.readyResolver).toBeNull();
    expect(timerState.relayInitializationSent).toBe(false);
    expect(
      messages(iframe).filter((message) => (message as { type?: string }).type === "RELAY_INIT")
    ).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(fakeDocument.overlay?.parentElement).toBeNull();
    expect(fakeWindow.messageListenerCount).toBe(0);
  });

  it("accepts RELAY_READY only with the exact source, origin, and shape", async () => {
    const host = new IframeHost();
    const { iframe, result } = await beginConnect(host);

    dispatchFromIframe(iframe, { type: "RELAY_READY", version: 2 }, { source: {} });
    dispatchFromIframe(
      iframe,
      { type: "RELAY_READY", version: 2 },
      { origin: "https://evil.test" }
    );
    dispatchFromIframe(iframe, { type: "RELAY_READY", version: 1 });
    dispatchFromIframe(iframe, { type: "RELAY_READY", version: 2, extra: true });
    dispatchFromIframe(iframe, { type: "RELAY_READY", version: "2" });
    await flushPromises();
    expect(
      messages(iframe).filter((message) => (message as { type?: string }).type === "CONNECT")
    ).toHaveLength(0);

    await acknowledgeRelay(iframe);
    const connectRequest = requestOfType(iframe, "CONNECT");
    let settled = false;
    void result.finally(() => {
      settled = true;
    });
    dispatchFromIframe(
      iframe,
      response("CONNECT_RESULT", connectRequest.id, { address: PRIMARY_EVM }),
      { source: {} }
    );
    dispatchFromIframe(
      iframe,
      response("CONNECT_RESULT", connectRequest.id, { address: PRIMARY_EVM }),
      { origin: "https://evil.test" }
    );
    await flushPromises();
    expect(settled).toBe(false);

    dispatchFromIframe(
      iframe,
      response("CONNECT_RESULT", connectRequest.id, { address: PRIMARY_EVM })
    );
    await expect(result).resolves.toEqual(LEGACY_CONNECT_RESULT);
  });

  it("does not treat the historical READY envelope as relay initialization", async () => {
    const host = new IframeHost();
    const { iframe, result } = await beginConnect(host);

    dispatchFromIframe(iframe, {
      type: "READY",
      id: "historical-ready",
      payload: {},
      timestamp: 1,
    });
    await flushPromises();
    expect(
      messages(iframe).filter((message) => (message as { type?: string }).type === "CONNECT")
    ).toHaveLength(0);

    await acknowledgeRelay(iframe);
    const connectRequest = requestOfType(iframe, "CONNECT");
    dispatchFromIframe(
      iframe,
      response("CONNECT_RESULT", connectRequest.id, { address: PRIMARY_EVM })
    );
    await expect(result).resolves.toEqual(LEGACY_CONNECT_RESULT);
  });
});

describe("IframeHost surface ownership", () => {
  it("keeps a second host active and the background isolated when the first settles", async () => {
    const background = fakeDocument.createElement("main");
    fakeDocument.body.appendChild(background);
    const hostA = new IframeHost();
    const resultA = hostA.connectWithSignerType({ signerType: "derivation" });
    const iframeA = fakeDocument.iframe!;
    iframeA.onload?.();
    await flushPromises();
    await acknowledgeRelay(iframeA);
    const requestA = requestOfType(iframeA, "CONNECT");
    const overlayA = iframeA.parentElement!.parentElement!;

    const hostB = new IframeHost();
    const resultB = hostB.connectWithSignerType({ signerType: "derivation" });
    const iframeB = fakeDocument.iframe!;
    iframeB.onload?.();
    await flushPromises();
    await acknowledgeRelay(iframeB);
    const requestB = requestOfType(iframeB, "CONNECT");
    const overlayB = iframeB.parentElement!.parentElement!;

    expect(overlayA.inert).toBe(false);
    expect(overlayA.hasAttribute("aria-hidden")).toBe(false);
    expect(overlayB.inert).toBe(false);
    expect(overlayB.hasAttribute("aria-hidden")).toBe(false);
    expect(background.inert).toBe(true);
    expect(background.getAttribute("aria-hidden")).toBe("true");

    dispatchFromIframe(iframeA, response("CONNECT_RESULT", requestA.id, { address: PRIMARY_EVM }));
    await expect(resultA).resolves.toEqual(LEGACY_CONNECT_RESULT);

    expect(overlayB.style.opacity).toBe("1");
    expect(overlayB.inert).toBe(false);
    expect(overlayB.hasAttribute("aria-hidden")).toBe(false);
    expect(background.inert).toBe(true);
    expect(background.getAttribute("aria-hidden")).toBe("true");

    dispatchFromIframe(iframeB, response("CONNECT_RESULT", requestB.id, { address: PRIMARY_EVM }));
    await expect(resultB).resolves.toEqual(LEGACY_CONNECT_RESULT);

    expect(background.inert).toBe(false);
    expect(background.hasAttribute("inert")).toBe(false);
    expect(background.hasAttribute("aria-hidden")).toBe(false);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);
    hostA.destroy();
    hostB.destroy();
  });

  it("mounts the default relay surface in document.body", async () => {
    const host = new IframeHost();
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    void connection.catch(() => undefined);

    expect(fakeDocument.overlay?.parentElement).toBe(fakeDocument.body);

    host.destroy();
    await flushPromises();
  });

  it("mounts the relay surface in the exact configured container", async () => {
    const container = fakeDocument.createElement("section");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    void connection.catch(() => undefined);

    try {
      expect(fakeDocument.overlay?.parentElement).toBe(container);
    } finally {
      host.destroy();
      await flushPromises();
    }
  });

  it("rejects destroyed and discards a surface returned after append reentry destroys the host", async () => {
    const container = fakeDocument.createElement("wallet-container");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const onDestroyed = vi.fn();
    host.onEvent("destroyed", onDestroyed);
    const appendChild = container.appendChild.bind(container);
    let destroyDuringAppend = true;
    vi.spyOn(container, "appendChild").mockImplementation((child) => {
      const appended = appendChild(child);
      if (destroyDuringAppend) {
        destroyDuringAppend = false;
        host.destroy();
      }
      return appended;
    });

    let rejection: unknown;
    let settled = false;
    void host.connectWithSignerType({ signerType: "derivation" }).catch((error: unknown) => {
      rejection = error;
      settled = true;
    });
    await flushPromises();

    expect(settled).toBe(true);
    expect(rejection).toMatchObject({ code: "DESTROYED" });
    expect(host.currentState).toBe("destroyed");
    expect(onDestroyed).toHaveBeenCalledOnce();
    expect(container.children).toHaveLength(0);
    expect(fakeDocument.overlay?.parentElement).toBeNull();
    expect(fakeDocument.iframe?.isConnected).toBe(false);
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);

    const iframeCount = fakeDocument.iframes.length;
    await expect(host.connectWithSignerType({ signerType: "derivation" })).rejects.toMatchObject({
      code: "DESTROYED",
    });
    expect(fakeDocument.iframes).toHaveLength(iframeCount);
  });

  it("shares one initialization when container append reenters connect", async () => {
    const container = fakeDocument.createElement("wallet-container");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const appendChild = container.appendChild.bind(container);
    let nestedConnection: Promise<unknown> | null = null;
    let reenter = true;
    vi.spyOn(container, "appendChild").mockImplementation((child) => {
      const appended = appendChild(child);
      if (reenter) {
        reenter = false;
        nestedConnection = host.connectWithSignerType({ signerType: "derivation" });
      }
      return appended;
    });

    const outerConnection = host.connectWithSignerType({ signerType: "derivation" });
    expect(nestedConnection).not.toBeNull();
    expect(fakeDocument.iframes).toHaveLength(1);
    expect(container.children).toHaveLength(1);
    const iframe = fakeDocument.iframe!;
    const outerOutcome = outerConnection.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    const nestedOutcome = nestedConnection!.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );

    iframe.onload?.();
    await flushPromises();
    await acknowledgeRelay(iframe);
    const relayInitializations = messages(iframe).filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "RELAY_INIT"
    );
    const connectRequests = messages(iframe).filter(
      (message): message is IframeMessage =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "CONNECT"
    );
    expect(relayInitializations).toHaveLength(1);
    expect(connectRequests).toHaveLength(1);
    dispatchFromIframe(
      iframe,
      response("CONNECT_RESULT", connectRequests[0]!.id, { address: PRIMARY_EVM })
    );

    await expect(outerOutcome).resolves.toEqual({
      status: "fulfilled",
      value: LEGACY_CONNECT_RESULT,
    });
    await expect(nestedOutcome).resolves.toMatchObject({
      status: "rejected",
      error: { code: "SIGN_FAILED", message: "Another wallet request is already active" },
    });

    host.destroy();
    expect(container.children).toHaveLength(0);
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reserves the initialized handoff for the starter ahead of later microtasks", async () => {
    const container = fakeDocument.createElement("wallet-container");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const appendChild = container.appendChild.bind(container);
    let nestedOutcome: Promise<unknown> | null = null;
    let reenter = true;
    vi.spyOn(container, "appendChild").mockImplementation((child) => {
      const appended = appendChild(child);
      if (reenter) {
        reenter = false;
        nestedOutcome = host.connectWithSignerType({ signerType: "derivation" }).then(
          (value) => ({ status: "fulfilled" as const, value }),
          (error: unknown) => ({ status: "rejected" as const, error })
        );
      }
      return appended;
    });

    const outerOutcome = host.connectWithSignerType({ signerType: "derivation" }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    const iframe = fakeDocument.iframe!;
    iframe.onload?.();
    await flushPromises();

    dispatchFromIframe(iframe, { type: "RELAY_READY", version: 2 });
    let laterOutcome: Promise<unknown> | null = null;
    await Promise.resolve().then(() => {
      laterOutcome = host.connectWithSignerType({ signerType: "derivation" }).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error })
      );
    });
    await flushPromises();

    expect(
      messages(iframe).filter((message) => (message as { type?: string }).type === "RELAY_INIT")
    ).toHaveLength(1);
    const connectRequests = messages(iframe).filter(
      (message): message is IframeMessage =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "CONNECT"
    );
    expect(connectRequests).toHaveLength(1);
    dispatchFromIframe(
      iframe,
      response("CONNECT_RESULT", connectRequests[0]!.id, { address: PRIMARY_EVM })
    );

    await expect(outerOutcome).resolves.toEqual({
      status: "fulfilled",
      value: LEGACY_CONNECT_RESULT,
    });
    await expect(nestedOutcome!).resolves.toMatchObject({
      status: "rejected",
      error: { code: "SIGN_FAILED", message: "Another wallet request is already active" },
    });
    await expect(laterOutcome!).resolves.toMatchObject({
      status: "rejected",
      error: { code: "SIGN_FAILED", message: "Another wallet request is already active" },
    });

    host.destroy();
    expect(container.children).toHaveLength(0);
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);
  });

  it("makes destroy authoritative during the initialized handoff window", async () => {
    const container = fakeDocument.createElement("wallet-container");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const onDestroyed = vi.fn();
    host.onEvent("destroyed", onDestroyed);
    const appendChild = container.appendChild.bind(container);
    let nestedOutcome: Promise<unknown> | null = null;
    let reenter = true;
    vi.spyOn(container, "appendChild").mockImplementation((child) => {
      const appended = appendChild(child);
      if (reenter) {
        reenter = false;
        nestedOutcome = host.connectWithSignerType({ signerType: "derivation" }).then(
          (value) => ({ status: "fulfilled" as const, value }),
          (error: unknown) => ({ status: "rejected" as const, error })
        );
      }
      return appended;
    });

    const outerOutcome = host.connectWithSignerType({ signerType: "derivation" }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    const iframe = fakeDocument.iframe!;
    iframe.onload?.();
    await flushPromises();

    dispatchFromIframe(iframe, { type: "RELAY_READY", version: 2 });
    await Promise.resolve().then(() => host.destroy());
    await flushPromises();

    await expect(outerOutcome).resolves.toMatchObject({
      status: "rejected",
      error: { code: "DESTROYED", message: "IframeHost destroyed" },
    });
    await expect(nestedOutcome!).resolves.toMatchObject({
      status: "rejected",
      error: { code: "SIGN_FAILED", message: "Another wallet request is already active" },
    });
    expect(
      messages(iframe).filter((message) => (message as { type?: string }).type === "CONNECT")
    ).toHaveLength(0);
    expect(host.currentState).toBe("destroyed");
    expect(host.isDestroyed).toBe(true);
    expect(onDestroyed).toHaveBeenCalledOnce();
    expect(container.children).toHaveLength(0);
    expect(fakeDocument.overlay?.parentElement).toBeNull();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);
    expect(() => host.destroy()).not.toThrow();
    expect(onDestroyed).toHaveBeenCalledOnce();
  });

  it("releases the initialized handoff when the starter fails before claiming the request", async () => {
    const container = fakeDocument.createElement("wallet-container");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const appendChild = container.appendChild.bind(container);
    let nestedOutcome: Promise<unknown> | null = null;
    let reenter = true;
    vi.spyOn(container, "appendChild").mockImplementation((child) => {
      const appended = appendChild(child);
      if (reenter) {
        reenter = false;
        nestedOutcome = host.connectWithSignerType({ signerType: "derivation" }).then(
          (value) => ({ status: "fulfilled" as const, value }),
          (error: unknown) => ({ status: "rejected" as const, error })
        );
      }
      return appended;
    });

    const outerOutcome = host.connectWithSignerType({ signerType: "derivation" }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    const iframe = fakeDocument.iframe!;
    iframe.onload?.();
    await flushPromises();

    const clockError = new Error("handoff clock failure");
    dispatchFromIframe(iframe, { type: "RELAY_READY", version: 2 });
    let dateNowSpy: ReturnType<typeof vi.spyOn> | null = null;
    await Promise.resolve().then(() => {
      dateNowSpy = vi.spyOn(Date, "now").mockImplementationOnce(() => {
        throw clockError;
      });
    });
    await flushPromises();
    dateNowSpy!.mockRestore();

    await expect(outerOutcome).resolves.toMatchObject({
      status: "rejected",
      error: { code: "SIGN_FAILED", message: clockError.message },
    });
    await expect(nestedOutcome!).resolves.toMatchObject({
      status: "rejected",
      error: { code: "SIGN_FAILED", message: "Another wallet request is already active" },
    });
    expect(
      messages(iframe).filter((message) => (message as { type?: string }).type === "CONNECT")
    ).toHaveLength(0);

    const retryOutcome = host.connectWithSignerType({ signerType: "derivation" }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    await flushPromises();
    const retryRequests = messages(iframe).filter(
      (message): message is IframeMessage =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "CONNECT"
    );
    expect(retryRequests).toHaveLength(1);
    dispatchFromIframe(
      iframe,
      response("CONNECT_RESULT", retryRequests[0]!.id, { address: PRIMARY_EVM })
    );
    await expect(retryOutcome).resolves.toEqual({
      status: "fulfilled",
      value: LEGACY_CONNECT_RESULT,
    });
    expect(
      messages(iframe).filter((message) => (message as { type?: string }).type === "RELAY_INIT")
    ).toHaveLength(1);

    host.destroy();
    expect(container.children).toHaveLength(0);
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);
  });

  it("rejects the starter when connect delivery destroys before request registration", async () => {
    const container = fakeDocument.createElement("wallet-container");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const onDestroyed = vi.fn();
    host.onEvent("destroyed", onDestroyed);
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    let settled = false;
    let connectionError: unknown;
    void connection.catch((error: unknown) => {
      connectionError = error;
      settled = true;
    });
    const iframe = fakeDocument.iframe!;
    iframe.onload?.();
    await flushPromises();

    let destroyOnConnect = true;
    iframe.contentWindow.postMessage.mockImplementation((message) => {
      if (
        destroyOnConnect &&
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "CONNECT"
      ) {
        destroyOnConnect = false;
        host.destroy();
      }
    });
    dispatchFromIframe(iframe, { type: "RELAY_READY", version: 2 });
    await flushPromises();
    await flushPromises();

    expect(settled).toBe(true);
    expect(connectionError).toMatchObject({
      code: "DESTROYED",
      message: "IframeHost destroyed",
    });
    expect(
      messages(iframe).filter((message) => (message as { type?: string }).type === "CONNECT")
    ).toHaveLength(1);
    expect(host.currentState).toBe("destroyed");
    expect(host.isDestroyed).toBe(true);
    expect(onDestroyed).toHaveBeenCalledOnce();
    expect(container.children).toHaveLength(0);
    expect(fakeDocument.overlay?.parentElement).toBeNull();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);
    expect(() => host.destroy()).not.toThrow();
    expect(onDestroyed).toHaveBeenCalledOnce();
  });

  it("preserves a connect response delivered synchronously before postMessage throws", async () => {
    const host = new IframeHost();
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    const iframe = fakeDocument.iframe!;
    iframe.onload?.();
    await flushPromises();

    const nativePostMessage = iframe.contentWindow.postMessage.getMockImplementation()!;
    const deliveryError = new Error("connect threw after synchronous response");
    iframe.contentWindow.postMessage.mockImplementation((message, targetOrigin) => {
      nativePostMessage(message, targetOrigin);
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "CONNECT" &&
        "id" in message &&
        typeof message.id === "string"
      ) {
        dispatchFromIframe(
          iframe,
          response("CONNECT_RESULT", message.id, { address: PRIMARY_EVM })
        );
        throw deliveryError;
      }
    });
    dispatchFromIframe(iframe, { type: "RELAY_READY", version: 2 });

    await expect(connection).resolves.toEqual(LEGACY_CONNECT_RESULT);
    expect(
      messages(iframe).filter((message) => (message as { type?: string }).type === "CONNECT")
    ).toHaveLength(1);
    expect(host.currentState).toBe("ready");
    expectRequestReleased(host);
    expect(vi.getTimerCount()).toBe(0);

    host.destroy();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a connect relay error delivered synchronously before postMessage throws", async () => {
    const host = new IframeHost();
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    const iframe = fakeDocument.iframe!;
    iframe.onload?.();
    await flushPromises();

    const deliveryError = new Error("connect threw after synchronous relay error");
    iframe.contentWindow.postMessage.mockImplementation((message) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "CONNECT" &&
        "id" in message &&
        typeof message.id === "string"
      ) {
        dispatchFromIframe(iframe, {
          type: "ERROR",
          id: message.id,
          payload: {
            requestId: message.id,
            code: "USER_CANCELLED",
            message: "Relay cancelled connect",
          },
          timestamp: 1,
        });
        throw deliveryError;
      }
    });
    dispatchFromIframe(iframe, { type: "RELAY_READY", version: 2 });

    await expect(connection).rejects.toMatchObject({
      code: "USER_CANCELLED",
      message: "Relay cancelled connect",
    });
    expect(host.currentState).toBe("idle");
    expectRequestReleased(host);
    expect(vi.getTimerCount()).toBe(0);

    host.destroy();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a ready derive response delivered synchronously before postMessage throws", async () => {
    const { host, iframe } = await connectHost();
    const deliveryError = new Error("derive threw after synchronous response");
    iframe.contentWindow.postMessage.mockImplementation((message) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "DERIVE_ADDRESS" &&
        "id" in message &&
        typeof message.id === "string"
      ) {
        dispatchFromIframe(
          iframe,
          response("DERIVE_ADDRESS_RESULT", message.id, {
            success: true,
            address: PRIMARY_EVM,
          })
        );
        throw deliveryError;
      }
    });

    await expect(host.deriveAddress({ keyIndex: 0, group: "evm" })).resolves.toEqual({
      success: true,
      address: PRIMARY_EVM,
    });
    expect(host.currentState).toBe("ready");
    expectRequestReleased(host);
    expect(vi.getTimerCount()).toBe(0);

    host.destroy();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a ready sign relay error delivered synchronously before postMessage throws", async () => {
    const { host, iframe } = await connectHost();
    const deliveryError = new Error("sign threw after synchronous relay error");
    iframe.contentWindow.postMessage.mockImplementation((message) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "SIGN_WITH_DERIVATION" &&
        "id" in message &&
        typeof message.id === "string"
      ) {
        dispatchFromIframe(iframe, {
          type: "ERROR",
          id: message.id,
          payload: {
            requestId: message.id,
            code: "USER_CANCELLED",
            message: "Relay cancelled signing",
          },
          timestamp: 1,
        });
        throw deliveryError;
      }
    });

    await expect(
      host.signWithDerivation(
        { kind: "message", message: { type: "text", value: "terminal ordering" } },
        { group: "evm", keyIndex: 0 }
      )
    ).rejects.toMatchObject({
      code: "USER_CANCELLED",
      message: "Relay cancelled signing",
    });
    expect(host.currentState).toBe("ready");
    expectRequestReleased(host);
    expect(vi.getTimerCount()).toBe(0);

    host.destroy();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  const firstTerminalCases = [
    {
      name: "connect",
      requestType: "CONNECT",
      initialize: true,
      invoke: (host: IframeHost) => host.connect(),
      resultType: "CONNECT_RESULT" as const,
      resultData: { address: PRIMARY_EVM },
      expected: { address: PRIMARY_EVM },
    },
    {
      name: "deprecated connect",
      requestType: "CONNECT",
      initialize: true,
      invoke: (host: IframeHost) => host.connectWithSignerType({ signerType: "derivation" }),
      resultType: "CONNECT_RESULT" as const,
      resultData: { address: PRIMARY_EVM },
      expected: LEGACY_CONNECT_RESULT,
    },
    {
      name: "derive",
      requestType: "DERIVE_ADDRESS",
      initialize: false,
      invoke: (host: IframeHost) => host.deriveAddress({ keyIndex: 0, group: "evm" }),
      resultType: "DERIVE_ADDRESS_RESULT" as const,
      resultData: { success: true, address: PRIMARY_EVM },
      expected: { success: true, address: PRIMARY_EVM },
    },
    {
      name: "sign",
      requestType: "SIGN_WITH_DERIVATION",
      initialize: false,
      invoke: (host: IframeHost) =>
        host.sign(
          { kind: "message", message: { type: "text", value: "first terminal" } },
          { group: "evm", keyIndex: 0 }
        ),
      resultType: "SIGN_RESULT" as const,
      resultData: { address: PRIMARY_EVM.address, signature: "0x0102" },
      expected: { address: PRIMARY_EVM.address, signature: "0x0102" },
    },
    {
      name: "deprecated sign",
      requestType: "SIGN_WITH_DERIVATION",
      initialize: false,
      invoke: (host: IframeHost) =>
        host.signWithDerivation(
          { kind: "message", message: { type: "text", value: "first terminal alias" } },
          { group: "evm", keyIndex: 0 }
        ),
      resultType: "SIGN_RESULT" as const,
      resultData: { address: PRIMARY_EVM.address, signature: "0x0304" },
      expected: {
        address: PRIMARY_EVM.address,
        signature: "0x0304",
        signerType: "derivation",
      },
    },
  ];

  it.each(firstTerminalCases)(
    "keeps a synchronous $name success claimed before postMessage destroys the host",
    async (testCase) => {
      const initialized = testCase.initialize ? null : await connectHost();
      const host = initialized?.host ?? new IframeHost();
      let iframe = initialized?.iframe ?? null;
      const trace: string[] = [];
      host.onEvent("error", (error) => trace.push(`error:${error.code}`));
      host.onEvent("destroyed", () => trace.push("destroyed"));
      let result: Promise<unknown>;

      if (testCase.initialize) {
        result = testCase.invoke(host);
        iframe = fakeDocument.iframe!;
        iframe.onload?.();
        await flushPromises();
      } else {
        result = Promise.resolve(undefined);
      }

      iframe!.contentWindow.postMessage.mockImplementation((message) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === testCase.requestType &&
          "id" in message &&
          typeof message.id === "string"
        ) {
          dispatchFromIframe(
            iframe!,
            response(testCase.resultType, message.id, testCase.resultData)
          );
          host.destroy();
        }
      });
      if (testCase.initialize) {
        dispatchFromIframe(iframe!, { type: "RELAY_READY", version: 2 });
      } else {
        result = testCase.invoke(host);
      }
      const outcome = result.then(
        (value) => {
          trace.push("resolved");
          return { status: "fulfilled" as const, value };
        },
        (error: unknown) => {
          trace.push(`rejected:${(error as { code?: string }).code}`);
          return { status: "rejected" as const, error };
        }
      );

      await expect(outcome).resolves.toEqual({
        status: "fulfilled",
        value: testCase.expected,
      });
      await flushPromises();

      expect(trace).toEqual(["resolved", "destroyed"]);
      expect(host.currentState).toBe("destroyed");
      expectRequestReleased(host);
      expect(fakeDocument.overlay?.parentElement).toBeNull();
      expect(fakeWindow.messageListenerCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(
        true
      );
    }
  );

  it.each(firstTerminalCases)(
    "keeps a synchronous $name relay error claimed before postMessage destroys the host",
    async (testCase) => {
      const initialized = testCase.initialize ? null : await connectHost();
      const host = initialized?.host ?? new IframeHost();
      let iframe = initialized?.iframe ?? null;
      const trace: string[] = [];
      host.onEvent("error", (error) => trace.push(`error:${error.code}`));
      host.onEvent("destroyed", () => trace.push("destroyed"));
      let result: Promise<unknown>;

      if (testCase.initialize) {
        result = testCase.invoke(host);
        iframe = fakeDocument.iframe!;
        iframe.onload?.();
        await flushPromises();
      } else {
        result = Promise.resolve(undefined);
      }

      iframe!.contentWindow.postMessage.mockImplementation((message) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === testCase.requestType &&
          "id" in message &&
          typeof message.id === "string"
        ) {
          dispatchFromIframe(iframe!, {
            type: "ERROR",
            id: message.id,
            payload: {
              requestId: message.id,
              code: "USER_CANCELLED",
              message: "Relay owns the first terminal",
            },
            timestamp: 1,
          });
          host.destroy();
        }
      });
      if (testCase.initialize) {
        dispatchFromIframe(iframe!, { type: "RELAY_READY", version: 2 });
      } else {
        result = testCase.invoke(host);
      }
      const outcome = result.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => {
          trace.push(`rejected:${(error as { code?: string }).code}`);
          return { status: "rejected" as const, error };
        }
      );

      await expect(outcome).resolves.toMatchObject({
        status: "rejected",
        error: { code: "USER_CANCELLED", message: "Relay owns the first terminal" },
      });
      await flushPromises();

      expect(trace).toEqual(["error:USER_CANCELLED", "rejected:USER_CANCELLED", "destroyed"]);
      expect(host.currentState).toBe("destroyed");
      expectRequestReleased(host);
      expect(fakeDocument.overlay?.parentElement).toBeNull();
      expect(fakeWindow.messageListenerCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(
        true
      );
    }
  );

  it("preserves synchronous destroy over a later sign postMessage error", async () => {
    const { host, iframe } = await connectHost();
    const deliveryError = new Error("sign threw after synchronous destroy");
    iframe.contentWindow.postMessage.mockImplementation((message) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "SIGN_WITH_DERIVATION"
      ) {
        host.destroy();
        throw deliveryError;
      }
    });

    await expect(
      host.signWithDerivation(
        { kind: "message", message: { type: "text", value: "destroy ordering" } },
        { group: "evm", keyIndex: 0 }
      )
    ).rejects.toMatchObject({ code: "DESTROYED" });
    expect(host.currentState).toBe("destroyed");
    expect(host.isDestroyed).toBe(true);
    expectRequestReleased(host);
    expect(fakeDocument.overlay?.parentElement).toBeNull();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);
  });

  it.each(["before", "after"] as const)(
    "removes the pending tracker when connect postMessage throws %s native delivery",
    async (throwPhase) => {
      const host = new IframeHost();
      const connection = host.connectWithSignerType({ signerType: "derivation" });
      const connectionOutcome = connection.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error })
      );
      const iframe = fakeDocument.iframe!;
      iframe.onload?.();
      await flushPromises();

      const deliveryError = new Error(`connect ${throwPhase}-native delivery failure`);
      const nativePostMessage = iframe.contentWindow.postMessage.getMockImplementation()!;
      iframe.contentWindow.postMessage.mockImplementation((message, targetOrigin) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "CONNECT"
        ) {
          if (throwPhase === "after") nativePostMessage(message, targetOrigin);
          throw deliveryError;
        }
        nativePostMessage(message, targetOrigin);
      });
      dispatchFromIframe(iframe, { type: "RELAY_READY", version: 2 });
      await flushPromises();
      await flushPromises();

      await expect(connectionOutcome).resolves.toMatchObject({
        status: "rejected",
        error: { code: "SIGN_FAILED", message: deliveryError.message },
      });
      expect(
        messages(iframe).filter((message) => (message as { type?: string }).type === "CONNECT")
      ).toHaveLength(1);
      expect(host.currentState).toBe("idle");
      expect(host.isDestroyed).toBe(false);
      expect(vi.getTimerCount()).toBe(0);

      host.destroy();
      expect(fakeWindow.messageListenerCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("does not deliver connect when request registration reenters destroy", async () => {
    const container = fakeDocument.createElement("wallet-container");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const onDestroyed = vi.fn();
    host.onEvent("destroyed", onDestroyed);
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    let settled = false;
    let connectionError: unknown;
    void connection.catch((error: unknown) => {
      connectionError = error;
      settled = true;
    });
    const iframe = fakeDocument.iframe!;
    iframe.onload?.();
    await flushPromises();

    const originalDateNow = Date.now.bind(Date);
    dispatchFromIframe(iframe, { type: "RELAY_READY", version: 2 });
    let dateNowCalls = 0;
    let dateNowSpy: ReturnType<typeof vi.spyOn> | null = null;
    await Promise.resolve().then(() => {
      dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
        dateNowCalls += 1;
        if (dateNowCalls === 1) {
          host.destroy();
        }
        return originalDateNow();
      });
    });
    await flushPromises();
    await flushPromises();
    dateNowSpy!.mockRestore();

    expect(settled).toBe(true);
    expect(connectionError).toMatchObject({
      code: "DESTROYED",
      message: "IframeHost destroyed",
    });
    expect(
      messages(iframe).filter((message) => (message as { type?: string }).type === "CONNECT")
    ).toHaveLength(0);
    expect(host.currentState).toBe("destroyed");
    expect(host.isDestroyed).toBe(true);
    expect(onDestroyed).toHaveBeenCalledOnce();
    expect(container.children).toHaveLength(0);
    expect(fakeDocument.overlay?.parentElement).toBeNull();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);
    expect(() => host.destroy()).not.toThrow();
    expect(onDestroyed).toHaveBeenCalledOnce();
  });

  it("does not deliver connect after request registration settles synchronously", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    let settleNextRequest = false;
    vi.stubGlobal("setTimeout", ((...args: Parameters<typeof setTimeout>) => {
      const timeout = nativeSetTimeout(...args);
      if (settleNextRequest) {
        settleNextRequest = false;
        const callback = args[0];
        if (typeof callback === "function") callback(...args.slice(2));
      }
      return timeout;
    }) as typeof setTimeout);
    const host = new IframeHost({ timeout: 60_000 });
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    const outcome = connection.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    const iframe = fakeDocument.iframe!;
    iframe.onload?.();
    await flushPromises();

    settleNextRequest = true;
    dispatchFromIframe(iframe, { type: "RELAY_READY", version: 2 });
    await flushPromises();
    await flushPromises();

    await expect(outcome).resolves.toMatchObject({
      status: "rejected",
      error: { code: "TIMEOUT" },
    });
    expect(
      messages(iframe).filter((message) => (message as { type?: string }).type === "CONNECT")
    ).toHaveLength(0);
    expectRequestReleased(host);
    expect(vi.getTimerCount()).toBe(0);
    host.destroy();
  });

  it("does not deliver sign after request registration settles synchronously", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    let settleNextRequest = false;
    vi.stubGlobal("setTimeout", ((...args: Parameters<typeof setTimeout>) => {
      const timeout = nativeSetTimeout(...args);
      if (settleNextRequest) {
        settleNextRequest = false;
        const callback = args[0];
        if (typeof callback === "function") callback(...args.slice(2));
      }
      return timeout;
    }) as typeof setTimeout);
    const { host, iframe } = await connectHost();

    settleNextRequest = true;
    const signing = host.signWithDerivation(
      { kind: "message", message: { type: "text", value: "synchronous timeout" } },
      { group: "evm", keyIndex: 0 }
    );
    const outcome = signing.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    await flushPromises();

    await expect(outcome).resolves.toMatchObject({
      status: "rejected",
      error: { code: "TIMEOUT" },
    });
    expect(
      messages(iframe).filter(
        (message) => (message as { type?: string }).type === "SIGN_WITH_DERIVATION"
      )
    ).toHaveLength(0);
    expectRequestReleased(host);
    expect(vi.getTimerCount()).toBe(0);
    host.destroy();
  });

  it("accepts a connect result that settles request registration synchronously without delivery", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    let settleNextRequest: (() => void) | null = null;
    vi.stubGlobal("setTimeout", ((...args: Parameters<typeof setTimeout>) => {
      const timeout = nativeSetTimeout(...args);
      const settle = settleNextRequest;
      settleNextRequest = null;
      settle?.();
      return timeout;
    }) as typeof setTimeout);
    const host = new IframeHost({ timeout: 60_000 });
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    const iframe = fakeDocument.iframe!;
    iframe.onload?.();
    await flushPromises();

    settleNextRequest = () => {
      const active = requestState(host).activeRequest as { id: string };
      dispatchFromIframe(iframe, response("CONNECT_RESULT", active.id, { address: PRIMARY_EVM }));
    };
    dispatchFromIframe(iframe, { type: "RELAY_READY", version: 2 });
    await flushPromises();

    await expect(connection).resolves.toEqual(LEGACY_CONNECT_RESULT);
    expect(
      messages(iframe).filter((message) => (message as { type?: string }).type === "CONNECT")
    ).toHaveLength(0);
    expectRequestReleased(host);
    host.destroy();
  });

  it("preserves a relay error that settles sign registration synchronously without delivery", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    let settleNextRequest: (() => void) | null = null;
    vi.stubGlobal("setTimeout", ((...args: Parameters<typeof setTimeout>) => {
      const timeout = nativeSetTimeout(...args);
      const settle = settleNextRequest;
      settleNextRequest = null;
      settle?.();
      return timeout;
    }) as typeof setTimeout);
    const { host, iframe } = await connectHost();
    const relayError = {
      code: "SIGN_FAILED",
      message: "Relay rejected during registration",
    } as const;
    settleNextRequest = () => {
      const active = requestState(host).activeRequest as { id: string };
      dispatchFromIframe(iframe, {
        type: "ERROR",
        id: active.id,
        payload: { requestId: active.id, ...relayError },
        timestamp: 1,
      });
    };

    const signing = host.signWithDerivation(
      { kind: "message", message: { type: "text", value: "synchronous rejection" } },
      { group: "evm", keyIndex: 0 }
    );

    await expect(signing).rejects.toMatchObject(relayError);
    expect(
      messages(iframe).filter(
        (message) => (message as { type?: string }).type === "SIGN_WITH_DERIVATION"
      )
    ).toHaveLength(0);
    expectRequestReleased(host);
    host.destroy();
  });

  it("does not start another initialization for reentrant derive or sign calls", async () => {
    const container = fakeDocument.createElement("wallet-container");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const appendChild = container.appendChild.bind(container);
    let deriveError: unknown;
    let signError: unknown;
    let reenter = true;
    vi.spyOn(container, "appendChild").mockImplementation((child) => {
      const appended = appendChild(child);
      if (reenter) {
        reenter = false;
        void host.deriveAddress({ keyIndex: 0, group: "evm" }).catch((error: unknown) => {
          deriveError = error;
        });
        void host
          .signWithDerivation(
            { kind: "message", message: { type: "text", value: "reentrant" } },
            { group: "evm", keyIndex: 0 }
          )
          .catch((error: unknown) => {
            signError = error;
          });
      }
      return appended;
    });

    const connection = host.connectWithSignerType({ signerType: "derivation" });
    expect(fakeDocument.iframes).toHaveLength(1);
    expect(container.children).toHaveLength(1);
    await flushPromises();
    expect(deriveError).toMatchObject({ code: "SIGN_FAILED" });
    expect(signError).toMatchObject({ code: "SIGN_FAILED" });

    const iframe = fakeDocument.iframe!;
    iframe.onload?.();
    await flushPromises();
    await acknowledgeRelay(iframe);
    const request = requestOfType(iframe, "CONNECT");
    expect(
      messages(iframe).filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          (message.type === "DERIVE_ADDRESS" || message.type === "SIGN_WITH_DERIVATION")
      )
    ).toHaveLength(0);
    dispatchFromIframe(iframe, response("CONNECT_RESULT", request.id, { address: PRIMARY_EVM }));
    await expect(connection).resolves.toEqual(LEGACY_CONNECT_RESULT);
    host.destroy();
  });

  it("rejects a concurrent caller and retries after reentrant append failure", async () => {
    const container = fakeDocument.createElement("wallet-container");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const appendChild = container.appendChild.bind(container);
    const appendError = new Error("append failed after reentrant connect");
    let nestedSettled = false;
    let nestedError: unknown;
    let failFirstAppend = true;
    vi.spyOn(container, "appendChild").mockImplementation((child) => {
      const appended = appendChild(child);
      if (failFirstAppend) {
        failFirstAppend = false;
        void host.connectWithSignerType({ signerType: "derivation" }).catch((error: unknown) => {
          nestedError = error;
          nestedSettled = true;
        });
        throw appendError;
      }
      return appended;
    });

    let outerSettled = false;
    let outerError: unknown;
    void host.connectWithSignerType({ signerType: "derivation" }).catch((error: unknown) => {
      outerError = error;
      outerSettled = true;
    });
    await flushPromises();

    expect(outerSettled).toBe(true);
    expect(nestedSettled).toBe(true);
    expect(outerError).toMatchObject({ code: "SIGN_FAILED", message: appendError.message });
    expect(nestedError).toMatchObject({
      code: "SIGN_FAILED",
      message: "Another wallet request is already active",
    });
    expect(host.currentState).toBe("idle");
    expect(host.isDestroyed).toBe(false);
    expect(fakeDocument.iframes).toHaveLength(1);
    expect(container.children).toHaveLength(0);
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);

    const retry = host.connectWithSignerType({ signerType: "derivation" });
    const iframe = fakeDocument.iframe!;
    iframe.onload?.();
    await flushPromises();
    await acknowledgeRelay(iframe);
    const request = requestOfType(iframe, "CONNECT");
    dispatchFromIframe(iframe, response("CONNECT_RESULT", request.id, { address: PRIMARY_EVM }));
    await expect(retry).resolves.toEqual(LEGACY_CONNECT_RESULT);
    host.destroy();
    expect(container.children).toHaveLength(0);
  });

  it("rejects the reserved operation and its concurrent caller when append reentry destroys", async () => {
    const container = fakeDocument.createElement("wallet-container");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const onDestroyed = vi.fn();
    host.onEvent("destroyed", onDestroyed);
    const appendChild = container.appendChild.bind(container);
    let nestedSettled = false;
    let nestedError: unknown;
    let destroyDuringAppend = true;
    vi.spyOn(container, "appendChild").mockImplementation((child) => {
      const appended = appendChild(child);
      if (destroyDuringAppend) {
        destroyDuringAppend = false;
        void host.connectWithSignerType({ signerType: "derivation" }).catch((error: unknown) => {
          nestedError = error;
          nestedSettled = true;
        });
        host.destroy();
      }
      return appended;
    });

    let outerSettled = false;
    let outerError: unknown;
    void host.connectWithSignerType({ signerType: "derivation" }).catch((error: unknown) => {
      outerError = error;
      outerSettled = true;
    });
    await flushPromises();

    expect(outerSettled).toBe(true);
    expect(nestedSettled).toBe(true);
    expect(outerError).toMatchObject({ code: "DESTROYED" });
    expect(nestedError).toMatchObject({ code: "SIGN_FAILED" });
    expect(host.currentState).toBe("destroyed");
    expect(host.isDestroyed).toBe(true);
    expect(onDestroyed).toHaveBeenCalledOnce();
    expect(fakeDocument.iframes).toHaveLength(1);
    expect(container.children).toHaveLength(0);
    expect(fakeDocument.overlay?.parentElement).toBeNull();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);

    expect(() => host.destroy()).not.toThrow();
    expect(onDestroyed).toHaveBeenCalledOnce();
  });

  it("rejects a disconnected configured container before DOM creation and retries once attached", async () => {
    const container = fakeDocument.createElement("section");
    const host = new IframeHost({ container: asHTMLElement(container) });
    const first = host.connectWithSignerType({ signerType: "derivation" });
    let firstError: unknown;
    let firstSettled = false;
    void first.catch((error: unknown) => {
      firstError = error;
      firstSettled = true;
    });

    await flushPromises();
    expect(firstSettled).toBe(true);
    expect(firstError).toMatchObject({ code: "NOT_INITIALIZED" });
    expect(host.currentState).toBe("idle");
    expect(fakeDocument.iframes).toHaveLength(0);

    fakeDocument.body.appendChild(container);
    const retry = host.connectWithSignerType({ signerType: "derivation" });
    const iframe = fakeDocument.iframe!;
    expect(fakeDocument.iframes).toHaveLength(1);
    expect(fakeDocument.overlay?.parentElement).toBe(container);
    iframe.onload?.();
    await flushPromises();
    await acknowledgeRelay(iframe);
    const request = requestOfType(iframe, "CONNECT");
    dispatchFromIframe(iframe, response("CONNECT_RESULT", request.id, { address: PRIMARY_EVM }));
    await expect(retry).resolves.toEqual(LEGACY_CONNECT_RESULT);
  });

  it("destroys once when the configured container is replaced after mounting", async () => {
    const parent = fakeDocument.createElement("div");
    const container = fakeDocument.createElement("section");
    fakeDocument.body.appendChild(parent);
    parent.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const onDestroyed = vi.fn();
    host.onEvent("destroyed", onDestroyed);
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    const outcome = connection.then(
      () => undefined,
      (error: unknown) => error
    );
    const overlay = fakeDocument.iframe!.parentElement!.parentElement!;

    container.remove();
    const replacement = fakeDocument.createElement("section");
    parent.appendChild(replacement);
    FakeMutationObserver.flushAll();
    FakeMutationObserver.flushAll();

    try {
      expect(host.currentState).toBe("destroyed");
      expect(await outcome).toMatchObject({ code: "DESTROYED" });
      await flushPromises();
      expect(onDestroyed).toHaveBeenCalledOnce();
      expect(overlay.remove).toHaveBeenCalledOnce();
      expect(overlay.parentElement).toBeNull();
      expect(replacement.children).not.toContain(overlay);
      expect(fakeDocument.keydownListenerCount).toBe(0);
    } finally {
      host.destroy();
    }
  });

  it("completes configured-disconnect teardown when the destroyed handler throws", async () => {
    const container = fakeDocument.createElement("section");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    const iframe = fakeDocument.iframe!;
    iframe.onload?.();
    await flushPromises();
    await acknowledgeRelay(iframe);
    const connectRequest = requestOfType(iframe, "CONNECT");
    dispatchFromIframe(
      iframe,
      response("CONNECT_RESULT", connectRequest.id, { address: PRIMARY_EVM })
    );
    await connection;

    const destroyedError = new Error("destroyed notification failed");
    const onDestroyed = vi.fn(() => {
      throw destroyedError;
    });
    host.onEvent("destroyed", onDestroyed);
    const signing = host.signWithDerivation(
      { kind: "message", message: { type: "text", value: "disconnect" } },
      { group: "evm", keyIndex: 0 }
    );
    let requestError: unknown;
    let requestSettled = false;
    void signing.catch((error: unknown) => {
      requestError = error;
      requestSettled = true;
    });
    requestOfType(iframe, "SIGN_WITH_DERIVATION");
    const configuredContainerObserver = FakeMutationObserver.instances[0];

    container.remove();
    expect(() => configuredContainerObserver.flush([removalRecord(container)])).not.toThrow();
    await flushPromises();

    expect(host.currentState).toBe("destroyed");
    expect(host.isDestroyed).toBe(true);
    expect(requestSettled).toBe(true);
    expect(requestError).toMatchObject({ code: "DESTROYED" });
    expect(onDestroyed).toHaveBeenCalledOnce();
    expect(() => host.destroy()).not.toThrow();
    expect(onDestroyed).toHaveBeenCalledOnce();
    expect(fakeDocument.overlay?.parentElement).toBeNull();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("completes configured-disconnect teardown when message listener removal throws", async () => {
    const container = fakeDocument.createElement("section");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container), timeout: 60_000 });
    const onDestroyed = vi.fn();
    host.onEvent("destroyed", onDestroyed);
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    let requestError: unknown;
    let requestSettled = false;
    void connection.catch((error: unknown) => {
      requestError = error;
      requestSettled = true;
    });
    const iframe = fakeDocument.iframe!;
    iframe.onload?.();
    await flushPromises();
    await acknowledgeRelay(iframe);
    requestOfType(iframe, "CONNECT");
    const configuredContainerObserver = FakeMutationObserver.instances[0];
    const removeEventListener = vi
      .spyOn(fakeWindow, "removeEventListener")
      .mockImplementation(() => {
        throw new Error("message listener removal failed");
      });

    container.remove();
    expect(() => configuredContainerObserver.flush([removalRecord(container)])).not.toThrow();
    await flushPromises();

    expect(host.currentState).toBe("destroyed");
    expect(host.isDestroyed).toBe(true);
    expect(requestSettled).toBe(true);
    expect(requestError).toMatchObject({ code: "DESTROYED" });
    expect(onDestroyed).toHaveBeenCalledOnce();
    expect(container.children).toHaveLength(0);
    expect(fakeDocument.overlay?.parentElement).toBeNull();
    expect(fakeDocument.iframe?.isConnected).toBe(false);
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);
    expect(removeEventListener).toHaveBeenCalledOnce();

    expect(() => host.destroy()).not.toThrow();
    expect(onDestroyed).toHaveBeenCalledOnce();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeEventListener).toHaveBeenCalledOnce();
  });

  it("destroys when the same configured container is reparented within one mutation batch", async () => {
    const firstParent = fakeDocument.createElement("section");
    const secondParent = fakeDocument.createElement("section");
    const container = fakeDocument.createElement("section");
    fakeDocument.body.appendChild(firstParent);
    fakeDocument.body.appendChild(secondParent);
    firstParent.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const onDestroyed = vi.fn();
    host.onEvent("destroyed", onDestroyed);
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    const outcome = connection.then(
      () => undefined,
      (error: unknown) => error
    );
    const overlay = fakeDocument.iframe!.parentElement!.parentElement!;

    container.remove();
    secondParent.appendChild(container);
    expect(container.isConnected).toBe(true);
    FakeMutationObserver.flushAll([removalRecord(container)]);

    try {
      expect(host.currentState).toBe("destroyed");
      expect(await outcome).toMatchObject({ code: "DESTROYED" });
      await flushPromises();
      expect(onDestroyed).toHaveBeenCalledOnce();
      expect(overlay.remove).toHaveBeenCalledOnce();
      expect(overlay.parentElement).toBeNull();
    } finally {
      host.destroy();
    }
  });

  it("does not post a wallet request when isolation synchronously removes its overlay", async () => {
    const background = fakeDocument.createElement("main");
    fakeDocument.body.appendChild(background);
    const host = new IframeHost();
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    const outcome = connection.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    const iframe = fakeDocument.iframe!;
    const overlay = iframe.parentElement!.parentElement!;
    let inertValue = false;
    Object.defineProperty(background, "inert", {
      configurable: true,
      get: () => inertValue,
      set: (value: boolean) => {
        inertValue = value;
        if (value) overlay.remove();
      },
    });
    iframe.onload?.();
    await flushPromises();

    try {
      await acknowledgeRelay(iframe);
      expect(
        messages(iframe).filter((message) => (message as { type?: string }).type === "CONNECT")
      ).toHaveLength(0);
      expect(host.currentState).toBe("destroyed");
      await expect(outcome).resolves.toMatchObject({ error: { code: "DESTROYED" } });
      expect(fakeDocument.keydownListenerCount).toBe(0);
      expect(fakeDocument.focusinListenerCount).toBe(0);
      expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(
        true
      );
    } finally {
      host.destroy();
    }
  });

  it("shows and settles a wallet request when active-element capture throws", async () => {
    const host = new IframeHost();
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    const outcome = connection.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    const iframe = fakeDocument.iframe!;
    let activeElement: FakeElement | null = fakeDocument.body;
    Object.defineProperty(fakeDocument, "activeElement", {
      configurable: true,
      get: () => {
        throw new Error("active element unavailable");
      },
      set: (value: FakeElement | null) => {
        activeElement = value;
      },
    });
    iframe.onload?.();
    await flushPromises();

    await acknowledgeRelay(iframe);
    const connectMessages = messages(iframe).filter(
      (message): message is IframeMessage =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "CONNECT"
    );
    expect(connectMessages).toHaveLength(1);
    const request = connectMessages[0]!;
    dispatchFromIframe(iframe, response("CONNECT_RESULT", request.id, { address: PRIMARY_EVM }));

    await expect(outcome).resolves.toEqual({ value: LEGACY_CONNECT_RESULT });
    expect(activeElement).toBe(iframe);
    expect(fakeDocument.keydownListenerCount).toBe(0);
    expect(fakeDocument.focusinListenerCount).toBe(0);
    host.destroy();
  });

  it("focuses the relay frame and restores the active initiating element after hide", async () => {
    const trigger = fakeDocument.createElement("button");
    fakeDocument.body.appendChild(trigger);
    fakeDocument.activeElement = trigger;
    const host = new IframeHost();
    const { iframe, result } = await beginConnect(host);
    await acknowledgeRelay(iframe);
    const request = requestOfType(iframe, "CONNECT");

    expect(iframe.focus).toHaveBeenCalledOnce();
    expect(trigger.inert).toBe(true);
    expect(trigger.getAttribute("aria-hidden")).toBe("true");

    dispatchFromIframe(iframe, response("CONNECT_RESULT", request.id, { address: PRIMARY_EVM }));
    await expect(result).resolves.toEqual(LEGACY_CONNECT_RESULT);
    expect(trigger.inert).toBe(false);
    expect(trigger.hasAttribute("inert")).toBe(false);
    expect(trigger.hasAttribute("aria-hidden")).toBe(false);
    expect(trigger.focus).toHaveBeenCalledOnce();
    expect(fakeDocument.activeElement).toBe(trigger);
  });

  it("preserves a successful result when restoring focus throws and releases ownership", async () => {
    const trigger = fakeDocument.createElement("button");
    fakeDocument.body.appendChild(trigger);
    fakeDocument.activeElement = trigger;
    trigger.focus.mockImplementation(() => {
      throw new Error("focus restore failed");
    });
    const host = new IframeHost();
    const { iframe, result } = await beginConnect(host);
    await acknowledgeRelay(iframe);
    const request = requestOfType(iframe, "CONNECT");

    dispatchFromIframe(iframe, response("CONNECT_RESULT", request.id, { address: PRIMARY_EVM }));
    await expect(result).resolves.toEqual(LEGACY_CONNECT_RESULT);

    const retry = host.deriveAddress({ keyIndex: 0, curve: "secp256k1", group: "evm" });
    const retryRequest = requestOfType(iframe, "DERIVE_ADDRESS");
    dispatchFromIframe(
      iframe,
      response("DERIVE_ADDRESS_RESULT", retryRequest.id, {
        success: true,
        address: PRIMARY_EVM,
      })
    );
    await expect(retry).resolves.toEqual({ success: true, address: PRIMARY_EVM });
    expect(fakeDocument.keydownListenerCount).toBe(0);
    expect(fakeDocument.focusinListenerCount).toBe(0);
    host.destroy();
  });

  it("preserves the original relay error when restoring focus throws and releases ownership", async () => {
    const { host, iframe } = await connectHost();
    const trigger = fakeDocument.createElement("button");
    fakeDocument.body.appendChild(trigger);
    fakeDocument.activeElement = trigger;
    trigger.focus.mockImplementation(() => {
      throw new Error("focus restore failed");
    });
    const signing = host.signWithDerivation(
      { kind: "message", message: { type: "text", value: "cancel" } },
      { group: "evm", keyIndex: 0 }
    );
    const request = requestOfType(iframe, "SIGN_WITH_DERIVATION");

    dispatchFromIframe(iframe, {
      type: "ERROR",
      id: request.id,
      payload: { requestId: request.id, code: "SIGN_FAILED", message: "Cancelled" },
      timestamp: 1,
    });
    await expect(signing).rejects.toMatchObject({ code: "SIGN_FAILED", message: "Cancelled" });

    const retry = host.deriveAddress({ keyIndex: 0, curve: "secp256k1", group: "evm" });
    const retryRequest = requestOfType(iframe, "DERIVE_ADDRESS");
    dispatchFromIframe(
      iframe,
      response("DERIVE_ADDRESS_RESULT", retryRequest.id, {
        success: true,
        address: PRIMARY_EVM,
      })
    );
    await expect(retry).resolves.toEqual({ success: true, address: PRIMARY_EVM });
    expect(fakeDocument.keydownListenerCount).toBe(0);
    expect(fakeDocument.focusinListenerCount).toBe(0);
    host.destroy();
  });

  it("cannot resurrect or remount a host destroyed by the restored focus handler", async () => {
    const trigger = fakeDocument.createElement("button");
    fakeDocument.body.appendChild(trigger);
    fakeDocument.activeElement = trigger;
    const host = new IframeHost();
    trigger.focus.mockImplementation(() => {
      fakeDocument.activeElement = trigger;
      host.destroy();
    });
    const { iframe, result } = await beginConnect(host);
    await acknowledgeRelay(iframe);
    const request = requestOfType(iframe, "CONNECT");

    dispatchFromIframe(iframe, response("CONNECT_RESULT", request.id, { address: PRIMARY_EVM }));
    const firstOutcome = await result.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    const iframeCountAfterDestroy = fakeDocument.iframes.length;
    let laterError: unknown;
    let laterSettled = false;
    void host.connectWithSignerType({ signerType: "derivation" }).catch((error: unknown) => {
      laterError = error;
      laterSettled = true;
    });
    await flushPromises();

    expect(firstOutcome).toEqual({ value: LEGACY_CONNECT_RESULT });
    expect(host.currentState).toBe("destroyed");
    expect(laterSettled).toBe(true);
    expect(laterError).toMatchObject({ code: "DESTROYED" });
    expect(fakeDocument.iframes).toHaveLength(iframeCountAfterDestroy);
    expect(fakeDocument.keydownListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases request ownership and surface mutations when showing throws", async () => {
    const background = fakeDocument.createElement("main");
    fakeDocument.body.appendChild(background);
    const setAttribute = background.setAttribute.bind(background);
    let throwOnAriaHidden = true;
    vi.spyOn(background, "setAttribute").mockImplementation((name, value) => {
      setAttribute(name, value);
      if (throwOnAriaHidden && name === "aria-hidden") {
        throw new Error("surface show failed");
      }
    });
    const host = new IframeHost();
    const first = host.connectWithSignerType({ signerType: "derivation" });
    const firstOutcome = first.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    const iframe = fakeDocument.iframe!;
    iframe.onload?.();
    await flushPromises();
    await acknowledgeRelay(iframe);
    throwOnAriaHidden = false;

    try {
      expect(await firstOutcome).toMatchObject({ error: { message: "surface show failed" } });
      expect(
        messages(iframe).filter((message) => (message as { type?: string }).type === "CONNECT")
      ).toHaveLength(0);
      expect(background.inert).toBe(false);
      expect(background.hasAttribute("inert")).toBe(false);
      expect(background.hasAttribute("aria-hidden")).toBe(false);
      expect(fakeDocument.overlay?.inert).toBe(true);
      expect(fakeDocument.overlay?.getAttribute("aria-hidden")).toBe("true");
      expect(fakeDocument.keydownListenerCount).toBe(0);
      expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(
        true
      );

      const retry = host.connectWithSignerType({ signerType: "derivation" });
      const retryOutcome = retry.then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
      await flushPromises();
      const request = requestOfType(iframe, "CONNECT");
      dispatchFromIframe(iframe, response("CONNECT_RESULT", request.id, { address: PRIMARY_EVM }));

      expect(await retryOutcome).toMatchObject({ value: LEGACY_CONNECT_RESULT });
      expect(background.inert).toBe(false);
      expect(background.hasAttribute("inert")).toBe(false);
      expect(background.hasAttribute("aria-hidden")).toBe(false);
      expect(fakeDocument.keydownListenerCount).toBe(0);
    } finally {
      throwOnAriaHidden = false;
      host.destroy();
      await flushPromises();
    }
  });

  it("does not post a request started synchronously from surface cleanup", async () => {
    const host = new IframeHost();
    const { iframe, result } = await beginConnect(host);
    await acknowledgeRelay(iframe);
    const connectRequest = requestOfType(iframe, "CONNECT");
    const overlay = iframe.parentElement!.parentElement!;
    const setAttribute = overlay.setAttribute.bind(overlay);
    let nestedOutcome: Promise<{ value?: unknown; error?: unknown }> | null = null;
    vi.spyOn(overlay, "setAttribute").mockImplementation((name, value) => {
      setAttribute(name, value);
      if (name !== "inert" || nestedOutcome) return;
      nestedOutcome = host.deriveAddress({ keyIndex: 7, curve: "secp256k1", group: "evm" }).then(
        (nestedValue) => ({ value: nestedValue }),
        (error: unknown) => ({ error })
      );
    });

    dispatchFromIframe(
      iframe,
      response("CONNECT_RESULT", connectRequest.id, { address: PRIMARY_EVM })
    );

    try {
      await expect(result).resolves.toEqual(LEGACY_CONNECT_RESULT);
      expect(nestedOutcome).not.toBeNull();
      expect(
        messages(iframe).filter(
          (message) => (message as { type?: string }).type === "DERIVE_ADDRESS"
        )
      ).toHaveLength(0);
      await expect(nestedOutcome!).resolves.toMatchObject({
        error: { code: "SIGN_FAILED", message: "Another wallet request is already active" },
      });

      const retry = host.deriveAddress({ keyIndex: 0, curve: "secp256k1", group: "evm" });
      await flushPromises();
      const retryRequest = requestOfType(iframe, "DERIVE_ADDRESS");
      dispatchFromIframe(
        iframe,
        response("DERIVE_ADDRESS_RESULT", retryRequest.id, {
          success: true,
          address: PRIMARY_EVM,
        })
      );
      await expect(retry).resolves.toEqual({ success: true, address: PRIMARY_EVM });
    } finally {
      host.destroy();
      await flushPromises();
    }
  });
});

describe("IframeHost wallet request visibility", () => {
  it("shows the overlay before CONNECT is posted and hides after the matching result", async () => {
    const host = new IframeHost();
    const result = host.connectWithSignerType({ signerType: "derivation" });
    const iframe = fakeDocument.iframe!;
    const visibilityAtPost: string[] = [];
    iframe.contentWindow.postMessage.mockImplementation((message) => {
      if ((message as { type?: string }).type === "CONNECT") {
        visibilityAtPost.push(fakeDocument.overlay!.style.opacity);
      }
    });
    iframe.onload?.();
    await flushPromises();
    await acknowledgeRelay(iframe);

    expect(visibilityAtPost).toEqual(["1"]);
    expect(fakeDocument.overlay!.style.opacity).toBe("1");

    const connectRequest = requestOfType(iframe, "CONNECT");
    expect(connectRequest.payload).toEqual({});
    dispatchFromIframe(
      iframe,
      response("CONNECT_RESULT", "different-request", { address: PRIMARY_EVM })
    );
    dispatchFromIframe(iframe, {
      type: "NEEDS_ONBOARDING",
      id: connectRequest.id,
      payload: { requestId: connectRequest.id, signerType: "derivation" },
      timestamp: 1,
    });
    await flushPromises();
    expect(fakeDocument.overlay!.style.opacity).toBe("1");

    dispatchFromIframe(
      iframe,
      response("CONNECT_RESULT", connectRequest.id, { address: PRIMARY_EVM })
    );
    await expect(result).resolves.toEqual(LEGACY_CONNECT_RESULT);
    expect(fakeDocument.overlay!.style.opacity).toBe("0");
    expect(fakeDocument.overlay!.style.pointerEvents).toBe("none");
  });

  it("rejects and cleans an active request when onboarding cannot refocus the surface", async () => {
    const host = new IframeHost();
    const { iframe, result } = await beginConnect(host);
    await acknowledgeRelay(iframe);
    const request = requestOfType(iframe, "CONNECT");
    iframe.focus.mockImplementation(() => {
      throw new Error("onboarding focus failed");
    });

    expect(() =>
      dispatchFromIframe(iframe, {
        type: "NEEDS_ONBOARDING",
        id: request.id,
        payload: { requestId: request.id, signerType: "derivation" },
        timestamp: 1,
      })
    ).not.toThrow();

    await expect(result).rejects.toMatchObject({
      code: "SIGN_FAILED",
      message: "Failed to show wallet request",
    });
    expect(fakeDocument.overlay!.inert).toBe(true);
    expect(fakeDocument.overlay!.getAttribute("aria-hidden")).toBe("true");
    expect(fakeDocument.keydownListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not extend CONNECT for a matching-id onboarding message with the wrong signer", async () => {
    const host = new IframeHost({ timeout: 50 });
    const { iframe, result } = await beginConnect(host);
    await acknowledgeRelay(iframe);
    const request = requestOfType(iframe, "CONNECT");
    let rejection: unknown;
    void result.catch((error: unknown) => {
      rejection = error;
    });

    dispatchFromIframe(iframe, {
      type: "NEEDS_ONBOARDING",
      id: request.id,
      payload: { requestId: request.id, signerType: "passkey" },
      timestamp: 1,
    });
    await vi.advanceTimersByTimeAsync(50);
    await flushPromises();

    expect(rejection).toMatchObject({ code: "TIMEOUT" });
    expect(fakeDocument.overlay!.style.opacity).toBe("0");
  });

  it.each([
    {
      name: "DERIVE_ADDRESS",
      invoke: (host: IframeHost) => host.deriveAddress({ keyIndex: 0, group: "evm" }),
      terminalType: "DERIVE_ADDRESS_RESULT" as const,
      terminalData: {
        success: true,
        address: {
          address: "0x1111111111111111111111111111111111111111",
          keyIndex: 0,
          curve: "secp256k1",
          group: "evm",
        },
      },
      expectedResult: {
        success: true,
        address: {
          address: "0x1111111111111111111111111111111111111111",
          keyIndex: 0,
          curve: "secp256k1",
          group: "evm",
        },
      },
    },
    {
      name: "SIGN_WITH_DERIVATION",
      invoke: (host: IframeHost) =>
        host.signWithDerivation(
          { kind: "message", message: { type: "text", value: "hello" } },
          { group: "evm", keyIndex: 0 }
        ),
      terminalType: "SIGN_RESULT" as const,
      terminalData: {
        address: "0x1111111111111111111111111111111111111111",
        signature: "0x1234",
      },
      expectedResult: {
        signerType: "derivation",
        address: "0x1111111111111111111111111111111111111111",
        signature: "0x1234",
      },
    },
  ])("keeps $name visible until its matching terminal response", async (testCase) => {
    const { host, iframe } = await connectHost();
    expect(fakeDocument.overlay!.style.opacity).toBe("0");

    let visibilityAtPost = "";
    iframe.contentWindow.postMessage.mockImplementation((message) => {
      if ((message as { type?: string }).type === testCase.name) {
        visibilityAtPost = fakeDocument.overlay!.style.opacity;
      }
    });
    const result = testCase.invoke(host);
    const request = requestOfType(iframe, testCase.name);
    if (testCase.name === "DERIVE_ADDRESS") {
      expect(request.payload).toEqual({ keyIndex: 0, group: "evm" });
    } else {
      expect(request.payload).toEqual({
        request: { kind: "message", message: { type: "text", value: "hello" } },
        group: "evm",
        keyIndex: 0,
      });
    }
    expect(visibilityAtPost).toBe("1");
    expect(fakeDocument.overlay!.style.opacity).toBe("1");
    expect(fakeDocument.overlay!.style.pointerEvents).toBe("auto");

    dispatchFromIframe(
      iframe,
      response(testCase.terminalType, "different-request", testCase.terminalData)
    );
    await flushPromises();
    expect(fakeDocument.overlay!.style.opacity).toBe("1");

    dispatchFromIframe(iframe, response(testCase.terminalType, request.id, testCase.terminalData));
    await expect(result).resolves.toEqual(testCase.expectedResult);
    expect(fakeDocument.overlay!.style.opacity).toBe("0");
  });

  it("keeps derive pending until the result matches its effective selector", async () => {
    const { host, iframe } = await connectHost();
    const derivation = host.deriveAddress({ keyIndex: 0, group: "evm" });
    let settled = false;
    void derivation.finally(() => {
      settled = true;
    });
    const request = requestOfType(iframe, "DERIVE_ADDRESS");

    dispatchFromIframe(
      iframe,
      response("DERIVE_ADDRESS_RESULT", request.id, {
        success: true,
        address: {
          address: "So11111111111111111111111111111111111111112",
          keyIndex: 99,
          curve: "ed25519",
          group: "solana",
        },
      })
    );
    await flushPromises();
    expect(settled).toBe(false);

    const terminalData = { success: true, address: PRIMARY_EVM };
    dispatchFromIframe(iframe, response("DERIVE_ADDRESS_RESULT", request.id, terminalData));
    await expect(derivation).resolves.toEqual(terminalData);
  });

  it("keeps address-selected signing pending for a different result address", async () => {
    const { host, iframe } = await connectHost();
    const requestedAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    const returnedAddress = requestedAddress.toLowerCase();
    const signing = host.signWithDerivation(
      { kind: "message", message: { type: "text", value: "selector binding" } },
      { address: requestedAddress }
    );
    let settled = false;
    void signing.finally(() => {
      settled = true;
    });
    const request = requestOfType(iframe, "SIGN_WITH_DERIVATION");

    dispatchFromIframe(
      iframe,
      response("SIGN_RESULT", request.id, {
        address: "0x0000000000000000000000000000000000000002",
        signature: "0x1234",
      })
    );
    await flushPromises();
    expect(settled).toBe(false);

    const terminalData = { address: returnedAddress, signature: "0x1234" };
    dispatchFromIframe(iframe, response("SIGN_RESULT", request.id, terminalData));
    await expect(signing).resolves.toEqual({ ...terminalData, signerType: "derivation" });
  });

  it("does not let a concurrent request replace or hide the active request", async () => {
    const { host, iframe } = await connectHost();
    const first = host.deriveAddress({ keyIndex: 0, group: "evm" });
    const request = requestOfType(iframe, "DERIVE_ADDRESS");

    await expect(
      host.signWithDerivation(
        { kind: "message", message: { type: "text", value: "second" } },
        { group: "evm", keyIndex: 1 }
      )
    ).rejects.toThrow("Another wallet request is already active");
    expect(fakeDocument.overlay!.style.opacity).toBe("1");
    expect(
      messages(iframe).filter(
        (message) => (message as { type?: string }).type === "SIGN_WITH_DERIVATION"
      )
    ).toHaveLength(0);

    const terminalData = {
      success: true,
      address: {
        address: "0x1111111111111111111111111111111111111111",
        keyIndex: 0,
        curve: "secp256k1",
        group: "evm",
      },
    };
    dispatchFromIframe(iframe, response("DERIVE_ADDRESS_RESULT", request.id, terminalData));
    await expect(first).resolves.toEqual(terminalData);
    expect(fakeDocument.overlay!.style.opacity).toBe("0");
  });

  it("hides the active request after a matching relay error", async () => {
    const { host, iframe } = await connectHost();
    const signing = host.signWithDerivation(
      { kind: "message", message: { type: "text", value: "cancel" } },
      { group: "evm", keyIndex: 0 }
    );
    const request = requestOfType(iframe, "SIGN_WITH_DERIVATION");

    dispatchFromIframe(iframe, {
      type: "ERROR",
      id: request.id,
      payload: { requestId: request.id, code: "SIGN_FAILED", message: "Cancelled" },
      timestamp: 1,
    });

    await expect(signing).rejects.toThrow("Cancelled");
    expect(fakeDocument.overlay!.style.opacity).toBe("0");
  });

  it("ignores a matching-id result of the wrong terminal type or shape", async () => {
    const { host, iframe } = await connectHost();
    const signing = host.signWithDerivation(
      { kind: "message", message: { type: "text", value: "bound terminal" } },
      { group: "evm", keyIndex: 0 }
    );
    let settled = false;
    void signing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    const request = requestOfType(iframe, "SIGN_WITH_DERIVATION");

    dispatchFromIframe(iframe, response("CONNECT_RESULT", request.id, { address: PRIMARY_EVM }));
    dispatchFromIframe(
      iframe,
      response("SIGN_RESULT", request.id, {
        signerType: "passkey",
        keyId: `0x${"11".repeat(32)}`,
        signature: { r: `0x${"22".repeat(32)}`, s: `0x${"33".repeat(32)}` },
        authenticatorData: "0x04",
        clientDataJSON: "{}",
      })
    );
    dispatchFromIframe(
      iframe,
      response("SIGN_RESULT", request.id, {
        address: "0x1111111111111111111111111111111111111111",
        signature: "not-hex",
      })
    );
    await flushPromises();
    expect(settled).toBe(false);
    expect(fakeDocument.overlay!.style.opacity).toBe("1");

    const terminalData = {
      address: "0x1111111111111111111111111111111111111111",
      signature: "0x1234",
    };
    dispatchFromIframe(iframe, response("SIGN_RESULT", request.id, terminalData));
    await expect(signing).resolves.toEqual({ ...terminalData, signerType: "derivation" });
    expect(fakeDocument.overlay!.style.opacity).toBe("0");
  });

  it("ignores a malformed matching-id ERROR envelope", async () => {
    const { host, iframe } = await connectHost();
    const signing = host.signWithDerivation(
      { kind: "message", message: { type: "text", value: "error binding" } },
      { group: "evm", keyIndex: 0 }
    );
    let settled = false;
    void signing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    const request = requestOfType(iframe, "SIGN_WITH_DERIVATION");

    dispatchFromIframe(iframe, {
      type: "ERROR",
      id: request.id,
      payload: {
        requestId: request.id,
        code: "SIGN_FAILED",
        message: "Forged cancellation",
        extra: true,
      },
      timestamp: 1,
    });
    await flushPromises();
    expect(settled).toBe(false);
    expect(fakeDocument.overlay!.style.opacity).toBe("1");

    dispatchFromIframe(iframe, {
      type: "ERROR",
      id: request.id,
      payload: { requestId: request.id, code: "USER_CANCELLED", message: "Cancelled" },
      timestamp: 1,
    });
    await expect(signing).rejects.toThrow("Cancelled");
    expect(fakeDocument.overlay!.style.opacity).toBe("0");
  });

  it("ignores v1 and PassKey signing results under the v2 session", async () => {
    const { host, iframe } = await connectHost();
    const signing = host.signWithDerivation(
      { kind: "message", message: { type: "text", value: "cross-version" } },
      { group: "evm", keyIndex: 0 }
    );
    let settled = false;
    void signing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    const request = requestOfType(iframe, "SIGN_WITH_DERIVATION");
    dispatchFromIframe(
      iframe,
      response("SIGN_RESULT", request.id, {
        signerType: "passkey",
        keyId: `0x${"11".repeat(32)}`,
        signature: { r: `0x${"22".repeat(32)}`, s: `0x${"33".repeat(32)}` },
        authenticatorData: "0x03",
        clientDataJSON: "{}",
      })
    );
    dispatchFromIframe(
      iframe,
      response("SIGN_RESULT", request.id, {
        signerType: "derivation",
        address: PRIMARY_EVM.address,
        signature: "0x1234",
      })
    );
    await flushPromises();
    expect(settled).toBe(false);
    expect(fakeDocument.overlay!.style.opacity).toBe("1");

    const terminalData = {
      address: PRIMARY_EVM.address,
      signature: "0x1234",
    };
    dispatchFromIframe(iframe, response("SIGN_RESULT", request.id, terminalData));
    await expect(signing).resolves.toEqual({ ...terminalData, signerType: "derivation" });
    expect(fakeDocument.overlay!.style.opacity).toBe("0");
  });

  it("hides the active request after its timeout", async () => {
    const host = new IframeHost({ timeout: 50 });
    const { iframe, result } = await beginConnect(host);
    await acknowledgeRelay(iframe);
    const connectRequest = requestOfType(iframe, "CONNECT");
    dispatchFromIframe(
      iframe,
      response("CONNECT_RESULT", connectRequest.id, { address: PRIMARY_EVM })
    );
    await result;

    const signing = host.signWithDerivation(
      { kind: "message", message: { type: "text", value: "timeout" } },
      { group: "evm", keyIndex: 0 }
    );
    expect(fakeDocument.overlay!.style.opacity).toBe("1");

    const rejection = expect(signing).rejects.toThrow("Request timeout");
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(fakeDocument.overlay!.style.opacity).toBe("0");
  });
});

describe("IframeHost initialization cleanup", () => {
  it.each(["before", "after"] as const)(
    "settles load, ready, and request ownership when cancellation throws %s native clear",
    async (clearPhase) => {
      const nativeClearTimeout = globalThis.clearTimeout;
      const nativeClearInterval = globalThis.clearInterval;
      const cancellationError = new Error(`${clearPhase} native host timer cancellation failed`);
      vi.stubGlobal("clearTimeout", ((timeout: ReturnType<typeof setTimeout>) => {
        if (clearPhase === "after") nativeClearTimeout(timeout);
        throw cancellationError;
      }) as typeof clearTimeout);
      vi.stubGlobal("clearInterval", ((interval: ReturnType<typeof setInterval>) => {
        if (clearPhase === "after") nativeClearInterval(interval);
        throw cancellationError;
      }) as typeof clearInterval);
      const host = new IframeHost({ timeout: 30_000 });
      const connection = host.connectWithSignerType({ signerType: "derivation" });
      let settlements = 0;
      const outcome = connection.then(
        (value) => {
          settlements += 1;
          return { status: "fulfilled" as const, value };
        },
        (error: unknown) => {
          settlements += 1;
          return { status: "rejected" as const, error };
        }
      );
      const iframe = fakeDocument.iframe!;

      expect(() => iframe.onload?.()).not.toThrow();
      await flushPromises();
      expect(() => dispatchFromIframe(iframe, { type: "RELAY_READY", version: 2 })).not.toThrow();
      await flushPromises();
      const request = requestOfType(iframe, "CONNECT");
      expect(() =>
        dispatchFromIframe(iframe, response("CONNECT_RESULT", request.id, { address: PRIMARY_EVM }))
      ).not.toThrow();

      await expect(outcome).resolves.toEqual({
        status: "fulfilled",
        value: LEGACY_CONNECT_RESULT,
      });
      expect(settlements).toBe(1);
      expectRequestReleased(host);
      expect(() => host.destroy()).not.toThrow();
      const messageCount = messages(iframe).length;
      expect(fakeDocument.overlay?.parentElement).toBeNull();
      expect(fakeWindow.messageListenerCount).toBe(0);
      expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(
        true
      );
      if (clearPhase === "after") expect(vi.getTimerCount()).toBe(0);
      else expect(vi.getTimerCount()).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(120_001);
      expect(messages(iframe)).toHaveLength(messageCount);
      expect(settlements).toBe(1);
      expectRequestReleased(host);
    }
  );

  it("keeps destroy authoritative when ready timer cancellation throws", async () => {
    vi.stubGlobal("clearTimeout", (() => {
      throw new Error("ready timeout cancellation failed");
    }) as typeof clearTimeout);
    vi.stubGlobal("clearInterval", (() => {
      throw new Error("relay retry cancellation failed");
    }) as typeof clearInterval);
    const host = new IframeHost({ timeout: 30_000 });
    const onDestroyed = vi.fn();
    host.onEvent("destroyed", onDestroyed);
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    const outcome = connection.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    const iframe = fakeDocument.iframe!;

    expect(() => iframe.onload?.()).not.toThrow();
    await flushPromises();
    const relayInitCount = messages(iframe).filter(
      (message) => (message as { type?: string }).type === "RELAY_INIT"
    ).length;
    expect(relayInitCount).toBe(1);
    expect(() => host.destroy()).not.toThrow();

    await expect(outcome).resolves.toMatchObject({
      status: "rejected",
      error: { code: "DESTROYED" },
    });
    expect(onDestroyed).toHaveBeenCalledOnce();
    expectRequestReleased(host);
    expect(fakeDocument.overlay?.parentElement).toBeNull();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);

    await vi.advanceTimersByTimeAsync(30_001);
    expect(
      messages(iframe).filter((message) => (message as { type?: string }).type === "RELAY_INIT")
    ).toHaveLength(relayInitCount);
    expect(onDestroyed).toHaveBeenCalledOnce();
  });

  it("preserves the setup error when load timeout rollback cancellation throws", async () => {
    const nativeClearTimeout = globalThis.clearTimeout;
    let throwCancellationOnce = true;
    vi.stubGlobal("clearTimeout", ((timeout: ReturnType<typeof setTimeout>) => {
      if (throwCancellationOnce) {
        throwCancellationOnce = false;
        throw new Error("load timeout rollback cancellation failed");
      }
      nativeClearTimeout(timeout);
    }) as typeof clearTimeout);
    const container = fakeDocument.createElement("section");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const setupError = new Error("iframe onload setup failed");
    const appendChild = container.appendChild.bind(container);
    vi.spyOn(container, "appendChild").mockImplementation((child) => {
      const appended = appendChild(child);
      const iframe = fakeDocument.iframe!;
      let storedOnload: (() => void) | null = null;
      Object.defineProperty(iframe, "onload", {
        configurable: true,
        get: () => storedOnload,
        set: (value: (() => void) | null) => {
          if (value !== null) throw setupError;
          storedOnload = value;
        },
      });
      return appended;
    });

    const outcome = host.connectWithSignerType({ signerType: "derivation" }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    await flushPromises();

    await expect(outcome).resolves.toMatchObject({
      status: "rejected",
      error: { code: "SIGN_FAILED", message: setupError.message },
    });
    expect(host.currentState).toBe("error");
    expect(fakeDocument.overlay?.parentElement).toBeNull();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);
    expect(() => host.destroy()).not.toThrow();

    await vi.advanceTimersByTimeAsync(10_001);
    expect(host.currentState).toBe("destroyed");
  });

  it("rejects a null initial contentWindow before publishing relay ownership", async () => {
    const container = fakeDocument.createElement("section");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const appendChild = container.appendChild.bind(container);
    let relayWindow: FakeContentWindow | null = null;
    vi.spyOn(container, "appendChild").mockImplementation((child) => {
      const appended = appendChild(child);
      const iframe = fakeDocument.iframe!;
      relayWindow = iframe.contentWindow;
      Object.defineProperty(iframe, "contentWindow", {
        configurable: true,
        get: () => null,
      });
      return appended;
    });

    let connectionError: unknown;
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    void connection.catch((error: unknown) => {
      connectionError = error;
    });

    try {
      await flushPromises();
      expect(connectionError).toMatchObject({ code: "NOT_INITIALIZED" });
      expect(host.currentState).toBe("idle");
      expect(relayWindow!.postMessage).not.toHaveBeenCalled();
      expect(fakeWindow.messageListenerCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(container.children).toHaveLength(0);
      expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(
        true
      );
    } finally {
      host.destroy();
      await connection.catch(() => undefined);
    }
  });

  it("destroys the lifecycle before sending through a substituted contentWindow", async () => {
    const { host, iframe } = await connectHost();
    const pinnedSource = iframe.contentWindow;
    const substitute = new FakeContentWindow();
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      get: () => substitute,
    });
    let signingError: unknown;
    const signing = host.signWithDerivation(
      { kind: "message", message: { type: "text", value: "substituted source" } },
      { group: "evm", keyIndex: 0 }
    );
    void signing.catch((error: unknown) => {
      signingError = error;
    });

    try {
      await flushPromises();
      expect(signingError).toMatchObject({ code: "DESTROYED" });
      expect(
        substitute.postMessage.mock.calls.filter(
          ([message]) => (message as { type?: string }).type === "SIGN_WITH_DERIVATION"
        )
      ).toHaveLength(0);
      expect(
        pinnedSource.postMessage.mock.calls.filter(
          ([message]) => (message as { type?: string }).type === "DESTROY"
        )
      ).toHaveLength(1);
      expect(host.currentState).toBe("destroyed");
      expectRequestReleased(host);
      expect(fakeDocument.overlay?.parentElement).toBeNull();
      expect(fakeWindow.messageListenerCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      host.destroy();
      await signing.catch(() => undefined);
    }
  });

  it("destroys the lifecycle before sending through a null current contentWindow", async () => {
    const { host, iframe } = await connectHost();
    const pinnedSource = iframe.contentWindow;
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      get: () => null,
    });
    let signingError: unknown;
    const signing = host.signWithDerivation(
      { kind: "message", message: { type: "text", value: "null source" } },
      { group: "evm", keyIndex: 0 }
    );
    void signing.catch((error: unknown) => {
      signingError = error;
    });

    try {
      await flushPromises();
      expect(signingError).toMatchObject({ code: "DESTROYED" });
      expect(
        pinnedSource.postMessage.mock.calls.filter(
          ([message]) => (message as { type?: string }).type === "SIGN_WITH_DERIVATION"
        )
      ).toHaveLength(0);
      expect(
        pinnedSource.postMessage.mock.calls.filter(
          ([message]) => (message as { type?: string }).type === "DESTROY"
        )
      ).toHaveLength(1);
      expect(host.currentState).toBe("destroyed");
      expectRequestReleased(host);
      expect(fakeDocument.overlay?.parentElement).toBeNull();
      expect(fakeWindow.messageListenerCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      host.destroy();
      await signing.catch(() => undefined);
    }
  });

  it.each(["CONNECT_RESULT", "ERROR"] as const)(
    "ignores a substituted same-origin %s and waits for the pinned source",
    async (messageType) => {
      const host = new IframeHost();
      const { iframe, result } = await beginConnect(host);
      const pinnedSource = iframe.contentWindow;
      await acknowledgeRelay(iframe);
      const request = requestOfType(iframe, "CONNECT");
      const substitute = new FakeContentWindow();
      Object.defineProperty(iframe, "contentWindow", {
        configurable: true,
        get: () => substitute,
      });
      let settled = false;
      void result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );

      try {
        dispatchFromIframe(
          iframe,
          messageType === "CONNECT_RESULT"
            ? response("CONNECT_RESULT", request.id, { address: PRIMARY_EVM })
            : {
                type: "ERROR",
                id: request.id,
                payload: {
                  requestId: request.id,
                  code: "USER_CANCELLED",
                  message: "Substituted source error",
                },
                timestamp: 1,
              },
          { source: substitute }
        );
        await flushPromises();
        expect(settled).toBe(false);

        dispatchFromIframe(
          iframe,
          response("CONNECT_RESULT", request.id, { address: PRIMARY_EVM }),
          { source: pinnedSource }
        );
        await expect(result).resolves.toEqual(LEGACY_CONNECT_RESULT);
      } finally {
        host.destroy();
        await result.catch(() => undefined);
      }
    }
  );

  it("does not resurrect the relay source or listener after contentWindow access destroys", async () => {
    const container = fakeDocument.createElement("section");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const onDestroyed = vi.fn();
    host.onEvent("destroyed", onDestroyed);
    const appendChild = container.appendChild.bind(container);
    let getterCalls = 0;
    vi.spyOn(container, "appendChild").mockImplementation((child) => {
      const appended = appendChild(child);
      const iframe = fakeDocument.iframe!;
      const contentWindow = iframe.contentWindow;
      Object.defineProperty(iframe, "contentWindow", {
        configurable: true,
        get: () => {
          getterCalls += 1;
          host.destroy();
          return contentWindow;
        },
      });
      return appended;
    });

    const outcome = host.connectWithSignerType({ signerType: "derivation" }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    await flushPromises();

    await expect(outcome).resolves.toMatchObject({
      status: "rejected",
      error: { code: "DESTROYED" },
    });
    const channelState = host as unknown as {
      allowedSource: Window | null;
      messageListener: ((event: MessageEvent) => void) | null;
    };
    expect(getterCalls).toBe(1);
    expect(channelState.allowedSource).toBeNull();
    expect(channelState.messageListener).toBeNull();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(onDestroyed).toHaveBeenCalledOnce();
    expect(container.children).toHaveLength(0);
    expect(fakeDocument.overlay?.parentElement).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);
  });

  it("does not send RELAY_INIT after its contentWindow getter destroys the host", async () => {
    const container = fakeDocument.createElement("section");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const onDestroyed = vi.fn();
    host.onEvent("destroyed", onDestroyed);
    const appendChild = container.appendChild.bind(container);
    let getterCalls = 0;
    let relayWindow: FakeContentWindow | null = null;
    vi.spyOn(container, "appendChild").mockImplementation((child) => {
      const appended = appendChild(child);
      const iframe = fakeDocument.iframe!;
      relayWindow = iframe.contentWindow;
      Object.defineProperty(iframe, "contentWindow", {
        configurable: true,
        get: () => {
          getterCalls += 1;
          if (getterCalls === 2) host.destroy();
          return relayWindow;
        },
      });
      return appended;
    });

    const outcome = host.connectWithSignerType({ signerType: "derivation" }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    const iframe = fakeDocument.iframe!;
    iframe.onload?.();
    await flushPromises();

    await expect(outcome).resolves.toMatchObject({
      status: "rejected",
      error: { code: "DESTROYED" },
    });
    expect(getterCalls).toBe(2);
    expect(relayWindow!.postMessage).not.toHaveBeenCalled();
    expect(onDestroyed).toHaveBeenCalledOnce();
    expect(container.children).toHaveLength(0);
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);
  });

  it("does not deliver a request after its postMessage getter destroys the host", async () => {
    const { host, iframe } = await connectHost();
    const onDestroyed = vi.fn();
    host.onEvent("destroyed", onDestroyed);
    const relayWindow = iframe.contentWindow;
    const postMessage = relayWindow.postMessage;
    let getterCalls = 0;
    Object.defineProperty(relayWindow, "postMessage", {
      configurable: true,
      get: () => {
        getterCalls += 1;
        if (getterCalls === 1) host.destroy();
        return postMessage;
      },
    });

    const signing = host.signWithDerivation(
      { kind: "message", message: { type: "text", value: "post getter reentry" } },
      { group: "evm", keyIndex: 0 }
    );

    await expect(signing).rejects.toMatchObject({ code: "DESTROYED" });
    const delivered = postMessage.mock.calls.map(([message]) => message as { type?: string });
    expect(delivered.filter((message) => message.type === "SIGN_WITH_DERIVATION")).toHaveLength(0);
    expect(delivered.filter((message) => message.type === "DESTROY")).toHaveLength(1);
    expect(onDestroyed).toHaveBeenCalledOnce();
    expectRequestReleased(host);
    expect(fakeDocument.overlay?.parentElement).toBeNull();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);
  });

  it("rolls back an onload handler stored after its setter destroys the host", async () => {
    const container = fakeDocument.createElement("section");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const onDestroyed = vi.fn();
    host.onEvent("destroyed", onDestroyed);
    const appendChild = container.appendChild.bind(container);
    let storedOnload: (() => void) | null = null;
    let storedOnerror: (() => void) | null = null;
    let nonNullOnerrorAssignments = 0;
    let destroyOnLoadInstall = true;
    vi.spyOn(container, "appendChild").mockImplementation((child) => {
      const appended = appendChild(child);
      const iframe = fakeDocument.iframe!;
      Object.defineProperty(iframe, "onload", {
        configurable: true,
        get: () => storedOnload,
        set: (value: (() => void) | null) => {
          if (value !== null && destroyOnLoadInstall) {
            destroyOnLoadInstall = false;
            host.destroy();
          }
          storedOnload = value;
        },
      });
      Object.defineProperty(iframe, "onerror", {
        configurable: true,
        get: () => storedOnerror,
        set: (value: (() => void) | null) => {
          if (value !== null) nonNullOnerrorAssignments += 1;
          storedOnerror = value;
        },
      });
      return appended;
    });

    const outcome = host.connectWithSignerType({ signerType: "derivation" }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    await flushPromises();

    await expect(outcome).resolves.toMatchObject({
      status: "rejected",
      error: { code: "DESTROYED" },
    });
    expect(storedOnload).toBeNull();
    expect(storedOnerror).toBeNull();
    expect(nonNullOnerrorAssignments).toBe(0);
    expect(onDestroyed).toHaveBeenCalledOnce();
    expect(container.children).toHaveLength(0);
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);
  });

  it("rolls back an onerror handler stored after its setter destroys the host", async () => {
    const container = fakeDocument.createElement("section");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const onDestroyed = vi.fn();
    host.onEvent("destroyed", onDestroyed);
    const appendChild = container.appendChild.bind(container);
    let storedOnload: (() => void) | null = null;
    let storedOnerror: (() => void) | null = null;
    let destroyOnErrorInstall = true;
    vi.spyOn(container, "appendChild").mockImplementation((child) => {
      const appended = appendChild(child);
      const iframe = fakeDocument.iframe!;
      Object.defineProperty(iframe, "onload", {
        configurable: true,
        get: () => storedOnload,
        set: (value: (() => void) | null) => {
          storedOnload = value;
        },
      });
      Object.defineProperty(iframe, "onerror", {
        configurable: true,
        get: () => storedOnerror,
        set: (value: (() => void) | null) => {
          if (value !== null && destroyOnErrorInstall) {
            destroyOnErrorInstall = false;
            host.destroy();
          }
          storedOnerror = value;
        },
      });
      return appended;
    });

    const outcome = host.connectWithSignerType({ signerType: "derivation" }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    await flushPromises();

    await expect(outcome).resolves.toMatchObject({
      status: "rejected",
      error: { code: "DESTROYED" },
    });
    expect(storedOnload).toBeNull();
    expect(storedOnerror).toBeNull();
    expect(onDestroyed).toHaveBeenCalledOnce();
    expect(container.children).toHaveLength(0);
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);
  });

  it("rolls back a partially registered listener and retries initialization", async () => {
    const container = fakeDocument.createElement("section");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const nativeAddEventListener = fakeWindow.addEventListener.bind(fakeWindow);
    const registrationError = new Error("message listener registration failed after native add");
    let throwAfterNativeAdd = true;
    vi.spyOn(fakeWindow, "addEventListener").mockImplementation((type, listener, options) => {
      nativeAddEventListener(type, listener, throwAfterNativeAdd ? undefined : options);
      if (!throwAfterNativeAdd) return;
      throwAfterNativeAdd = false;
      throw registrationError;
    });

    const firstConnection = host.connectWithSignerType({ signerType: "derivation" });
    let firstError: unknown;
    void firstConnection.catch((error: unknown) => {
      firstError = error;
    });
    await flushPromises();

    expect(firstError).toMatchObject({ code: "SIGN_FAILED", message: registrationError.message });
    expect(host.currentState).toBe("idle");
    expect(host.isDestroyed).toBe(false);
    expect(container.children).toHaveLength(0);
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);

    const retry = host.connectWithSignerType({ signerType: "derivation" });
    const iframe = fakeDocument.iframe!;
    iframe.onload?.();
    await flushPromises();
    await acknowledgeRelay(iframe);
    const request = requestOfType(iframe, "CONNECT");
    dispatchFromIframe(iframe, response("CONNECT_RESULT", request.id, { address: PRIMARY_EVM }));
    await expect(retry).resolves.toEqual(LEGACY_CONNECT_RESULT);

    host.destroy();
    expect(container.children).toHaveLength(0);
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps synchronous destruction authoritative during listener registration", async () => {
    const container = fakeDocument.createElement("section");
    fakeDocument.body.appendChild(container);
    const host = new IframeHost({ container: asHTMLElement(container) });
    const onDestroyed = vi.fn();
    host.onEvent("destroyed", onDestroyed);
    const nativeAddEventListener = fakeWindow.addEventListener.bind(fakeWindow);
    vi.spyOn(fakeWindow, "addEventListener").mockImplementation((type, listener, options) => {
      nativeAddEventListener(type, listener, options);
      host.destroy();
    });

    const connection = host.connectWithSignerType({ signerType: "derivation" });
    let requestError: unknown;
    void connection.catch((error: unknown) => {
      requestError = error;
    });
    await flushPromises();

    expect(requestError).toMatchObject({ code: "DESTROYED" });
    expect(host.currentState).toBe("destroyed");
    expect(host.isDestroyed).toBe(true);
    expect(onDestroyed).toHaveBeenCalledOnce();
    expect(container.children).toHaveLength(0);
    expect(fakeDocument.overlay?.parentElement).toBeNull();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);

    expect(() => host.destroy()).not.toThrow();
    expect(onDestroyed).toHaveBeenCalledOnce();
  });

  it("sends exact relay teardown from the first active ready destroy owner", async () => {
    const { host, iframe } = await connectHost();
    vi.setSystemTime(10);
    const signing = host.signWithDerivation(
      { kind: "message", message: { type: "text", value: "destroy" } },
      { group: "evm", keyIndex: 0 }
    );
    requestOfType(iframe, "SIGN_WITH_DERIVATION");
    const rejection = expect(signing).rejects.toMatchObject({ code: "DESTROYED" });

    host.destroy();
    await rejection;

    const destroy = requestOfType(iframe, "DESTROY");
    expect(destroy).toEqual({
      type: "DESTROY",
      id: expect.any(String),
      payload: { reason: "Host destroyed" },
      timestamp: 10,
    });
    expect(destroy.id.length).toBeGreaterThan(0);
    expect(destroy.id.length).toBeLessThanOrEqual(128);
    expect(iframe.contentWindow.postMessage).toHaveBeenCalledWith(destroy, EMBED_ORIGIN);
  });

  it("claims ready teardown before a DESTROY delivery reenters destroy", async () => {
    const { host, iframe } = await connectHost();
    const onDestroyed = vi.fn();
    host.onEvent("destroyed", onDestroyed);
    let teardownSnapshot:
      | {
          state: string;
          isDestroyed: boolean;
          activeRequest: unknown;
          pendingCount: number;
        }
      | undefined;

    iframe.contentWindow.postMessage.mockImplementation((message) => {
      if ((message as { type?: string }).type !== "DESTROY" || teardownSnapshot) return;
      const ownership = requestState(host);
      teardownSnapshot = {
        state: host.currentState,
        isDestroyed: host.isDestroyed,
        activeRequest: ownership.activeRequest,
        pendingCount: ownership.requestManager.pendingCount,
      };
      host.destroy();
    });

    host.destroy();

    expect(teardownSnapshot).toEqual({
      state: "destroyed",
      isDestroyed: true,
      activeRequest: null,
      pendingCount: 0,
    });
    expect(
      messages(iframe).filter((message) => (message as { type?: string }).type === "DESTROY")
    ).toHaveLength(1);
    expect(onDestroyed).toHaveBeenCalledOnce();
    expect(host.currentState).toBe("destroyed");
    expect(host.isDestroyed).toBe(true);
    expectRequestReleased(host);
    expect(fakeDocument.overlay?.parentElement).toBeNull();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("claims active request teardown before a DESTROY delivery reenters destroy", async () => {
    const { host, iframe } = await connectHost();
    const onDestroyed = vi.fn();
    host.onEvent("destroyed", onDestroyed);
    const signing = host.signWithDerivation(
      { kind: "message", message: { type: "text", value: "destroy reentry" } },
      { group: "evm", keyIndex: 0 }
    );
    requestOfType(iframe, "SIGN_WITH_DERIVATION");
    let teardownSnapshot:
      | {
          state: string;
          isDestroyed: boolean;
          activeRequest: unknown;
          pendingCount: number;
        }
      | undefined;

    iframe.contentWindow.postMessage.mockImplementation((message) => {
      if ((message as { type?: string }).type !== "DESTROY" || teardownSnapshot) return;
      const ownership = requestState(host);
      teardownSnapshot = {
        state: host.currentState,
        isDestroyed: host.isDestroyed,
        activeRequest: ownership.activeRequest,
        pendingCount: ownership.requestManager.pendingCount,
      };
      host.destroy();
    });

    const rejection = expect(signing).rejects.toMatchObject({ code: "DESTROYED" });
    host.destroy();
    await rejection;

    expect(teardownSnapshot).toEqual({
      state: "destroyed",
      isDestroyed: true,
      activeRequest: null,
      pendingCount: 0,
    });
    expect(
      messages(iframe).filter((message) => (message as { type?: string }).type === "DESTROY")
    ).toHaveLength(1);
    expect(onDestroyed).toHaveBeenCalledOnce();
    expectRequestReleased(host);
    expect(fakeDocument.overlay?.parentElement).toBeNull();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps loading teardown idempotent when the destroyed handler reenters", async () => {
    const host = new IframeHost();
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    const iframe = fakeDocument.iframe!;
    const onDestroyed = vi.fn(() => host.destroy());
    host.onEvent("destroyed", onDestroyed);

    const rejection = expect(connection).rejects.toMatchObject({ code: "DESTROYED" });
    host.destroy();
    await rejection;

    expect(
      messages(iframe).filter((message) => (message as { type?: string }).type === "DESTROY")
    ).toHaveLength(0);
    expect(onDestroyed).toHaveBeenCalledOnce();
    expect(host.currentState).toBe("destroyed");
    expect(host.isDestroyed).toBe(true);
    expectRequestReleased(host);
    expect(fakeDocument.overlay?.parentElement).toBeNull();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("claims loading teardown before iframe handler cleanup reenters and throws", async () => {
    const host = new IframeHost();
    const onDestroyed = vi.fn();
    host.onEvent("destroyed", onDestroyed);
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    const outcome = connection.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    const iframe = fakeDocument.iframe!;
    const cleanupError = new Error("iframe onload cleanup failed");
    let currentOnload = iframe.onload;
    let teardownSnapshot:
      | {
          state: string;
          isDestroyed: boolean;
          activeRequest: unknown;
          pendingCount: number;
        }
      | undefined;
    Object.defineProperty(iframe, "onload", {
      configurable: true,
      get: () => currentOnload,
      set: (value: (() => void) | null) => {
        currentOnload = value;
        if (value !== null || teardownSnapshot) return;
        const ownership = requestState(host);
        teardownSnapshot = {
          state: host.currentState,
          isDestroyed: host.isDestroyed,
          activeRequest: ownership.activeRequest,
          pendingCount: ownership.requestManager.pendingCount,
        };
        host.destroy();
        throw cleanupError;
      },
    });

    expect(() => host.destroy()).not.toThrow();

    expect(teardownSnapshot).toEqual({
      state: "destroyed",
      isDestroyed: true,
      activeRequest: null,
      pendingCount: 0,
    });
    await expect(outcome).resolves.toMatchObject({
      status: "rejected",
      error: { code: "DESTROYED" },
    });
    expect(onDestroyed).toHaveBeenCalledOnce();
    expectRequestReleased(host);
    expect(fakeDocument.overlay?.parentElement).toBeNull();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);
  });

  it("completes claimed ready teardown when DESTROY delivery throws", async () => {
    const { host, iframe } = await connectHost();
    const onDestroyed = vi.fn();
    host.onEvent("destroyed", onDestroyed);
    const deliveryError = new Error("DESTROY delivery failed");
    iframe.contentWindow.postMessage.mockImplementation((message) => {
      if ((message as { type?: string }).type === "DESTROY") throw deliveryError;
    });

    expect(() => host.destroy()).not.toThrow();

    expect(
      messages(iframe).filter((message) => (message as { type?: string }).type === "DESTROY")
    ).toHaveLength(1);
    expect(onDestroyed).toHaveBeenCalledOnce();
    expect(host.currentState).toBe("destroyed");
    expect(host.isDestroyed).toBe(true);
    expectRequestReleased(host);
    expect(fakeDocument.overlay?.parentElement).toBeNull();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("completes claimed ready teardown when contentWindow access throws", async () => {
    const { host, iframe } = await connectHost();
    const onDestroyed = vi.fn();
    host.onEvent("destroyed", onDestroyed);
    const accessError = new Error("contentWindow access failed");
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      get: () => {
        throw accessError;
      },
    });

    expect(() => host.destroy()).not.toThrow();

    expect(onDestroyed).toHaveBeenCalledOnce();
    expect(host.currentState).toBe("destroyed");
    expect(host.isDestroyed).toBe(true);
    expectRequestReleased(host);
    expect(fakeDocument.overlay?.parentElement).toBeNull();
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);
  });

  it("rejects immediately and cancels the iframe load timer when destroyed before load", async () => {
    const host = new IframeHost();
    const connection = host.connectWithSignerType({ signerType: "derivation" });
    let rejection: unknown;
    void connection.catch((error: unknown) => {
      rejection = error;
    });

    host.destroy();
    await flushPromises();

    expect(rejection).toMatchObject({ code: "DESTROYED" });
    expect(vi.getTimerCount()).toBe(0);
    expect(host.currentState).toBe("destroyed");
  });

  it("cleans a failed iframe initialization and permits an explicit retry", async () => {
    const host = new IframeHost();
    const firstConnection = host.connectWithSignerType({ signerType: "derivation" });
    const firstIframe = fakeDocument.iframe!;
    const firstOverlay = fakeDocument.overlay!;

    firstIframe.onerror?.();
    await expect(firstConnection).rejects.toThrow("iframe load failed");
    expect(host.currentState).toBe("error");
    expect(firstOverlay.remove).toHaveBeenCalledOnce();

    const retry = host.connectWithSignerType({ signerType: "derivation" });
    const retryIframe = fakeDocument.iframe!;
    expect(retryIframe).not.toBe(firstIframe);
    expect(fakeDocument.iframes).toHaveLength(2);
    retryIframe.onload?.();
    await flushPromises();
    await acknowledgeRelay(retryIframe);
    const request = requestOfType(retryIframe, "CONNECT");
    dispatchFromIframe(
      retryIframe,
      response("CONNECT_RESULT", request.id, { address: PRIMARY_EVM })
    );
    await expect(retry).resolves.toEqual(LEGACY_CONNECT_RESULT);
  });

  it("cleans iframe resources when the exact relay acknowledgement times out", async () => {
    const host = new IframeHost({ timeout: 50 });
    const { result } = await beginConnect(host);
    const overlay = fakeDocument.overlay!;
    const rejection = expect(result).rejects.toThrow("IframeWorker ready timeout");

    await vi.advanceTimersByTimeAsync(50);
    await rejection;

    expect(host.currentState).toBe("error");
    expect(overlay.remove).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("disconnect clears the embedded grant without destroying a usable relay", async () => {
  const { host, iframe } = await connectHost();
  host.disconnect();
  expect(
    messages(iframe).filter((message) => (message as { type?: string }).type === "DISCONNECT")
  ).toHaveLength(1);
  expect(host.isDestroyed).toBe(false);
  host.destroy();
});
it("disconnect destroys the relay when grant revocation cannot be delivered", async () => {
  const { host, iframe } = await connectHost();
  iframe.contentWindow.postMessage.mockImplementation((message) => {
    if ((message as { type?: string }).type === "DISCONNECT")
      throw new Error("Disconnected transport");
  });
  host.disconnect();
  expect(host.isDestroyed).toBe(true);
});

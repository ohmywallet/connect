import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedEmbedProvider } from "./managed-embed";

const fixture = vi.hoisted(() => ({ surface: vi.fn(), messages: [] as Record<string, unknown>[] }));
vi.mock("./host-surface", () => ({
  createHostSurface: (options: unknown) => fixture.surface(options),
}));
const ADDRESS = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const ORIGIN = "https://embed.ohmywallet.xyz";
let listeners: Set<(event: MessageEvent) => void>;
let source: { postMessage: ReturnType<typeof vi.fn> };
let surface: {
  iframe: { contentWindow: typeof source };
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};
const providers: ManagedEmbedProvider[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  fixture.messages = [];
  listeners = new Set();
  source = {
    postMessage: vi.fn((message: Record<string, unknown>) => {
      fixture.messages.push(message);
    }),
  };
  surface = { iframe: { contentWindow: source }, show: vi.fn(), hide: vi.fn(), destroy: vi.fn() };
  fixture.surface.mockReturnValue(surface);
  vi.stubGlobal("window", {
    addEventListener: (_event: string, listener: (event: MessageEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (_event: string, listener: (event: MessageEvent) => void) =>
      listeners.delete(listener),
  });
  vi.stubGlobal("document", { activeElement: null });
});
afterEach(() => {
  for (const provider of providers) provider.destroy();
  providers.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function create() {
  const provider = new ManagedEmbedProvider({ chainId: 8453 });
  providers.push(provider);
  return provider;
}
function message(data: object, origin = ORIGIN, sender: unknown = source) {
  for (const listener of [...listeners]) listener({ data, origin, source: sender } as MessageEvent);
}
function ready() {
  const init = [...fixture.messages].reverse().find((item) => item.type === "OMW_MANAGED_INIT")!;
  message({ type: "OMW_MANAGED_READY", version: 1, sessionId: init.sessionId });
  return [...fixture.messages].reverse().find((item) => item.type === "OMW_MANAGED_REQUEST")!;
}
function result(request: Record<string, unknown>, value: unknown, overrides: object = {}) {
  return {
    type: "OMW_MANAGED_RESULT",
    version: 1,
    sessionId: request.sessionId,
    id: request.id,
    chainId: 8453,
    account: "managed",
    address: ADDRESS,
    result: value,
    ...overrides,
  };
}
async function connect(provider: ManagedEmbedProvider) {
  const promise = provider.request({ method: "eth_requestAccounts" });
  const request = ready();
  message(result(request, [ADDRESS]));
  expect(await promise).toEqual([ADDRESS]);
  return request;
}
describe("managed Embed authenticated public RPC", () => {
  it("is passive until consent and opens only the fixed managed iframe", async () => {
    const provider = create();
    expect(await provider.request({ method: "eth_accounts" })).toEqual([]);
    expect(await provider.request({ method: "eth_chainId" })).toBe("0x2105");
    expect(fixture.surface).not.toHaveBeenCalled();
    await connect(provider);
    expect(fixture.surface.mock.calls[0]![0]).toMatchObject({
      iframeSrc: `${ORIGIN}/en?account=managed`,
      allow: `publickey-credentials-get ${ORIGIN}`,
    });
    expect(source.postMessage).toHaveBeenCalledWith(expect.any(Object), ORIGIN);
    expect(surface.hide).toHaveBeenCalledWith({ restoreFocus: true });
  });
  it("ignores wrong origins, sources, sessions and stale request ids", async () => {
    const provider = create();
    const pending = provider.request({ method: "eth_requestAccounts" });
    const request = ready();
    message(result(request, [ADDRESS]), "https://evil.example");
    message(result(request, [ADDRESS]), ORIGIN, {});
    message(result(request, [ADDRESS], { sessionId: "ab".repeat(16) }));
    message(result(request, [ADDRESS], { id: "cd".repeat(16) }));
    expect(await provider.request({ method: "eth_accounts" })).toEqual([]);
    message(result(request, [ADDRESS]));
    expect(await pending).toEqual([ADDRESS]);
  });
  it.each([{ chainId: 1 }, { account: "fee" }, { address: OTHER, result: [ADDRESS] }])(
    "fails closed on identity mismatch %o",
    async (overrides) => {
      const provider = create();
      const pending = provider.request({ method: "eth_requestAccounts" });
      const rejected = expect(pending).rejects.toMatchObject({ code: 4100 });
      message(result(ready(), [ADDRESS], overrides));
      await rejected;
      expect(await provider.request({ method: "eth_accounts" })).toEqual([]);
      expect(surface.destroy).toHaveBeenCalled();
    }
  );
  it("preserves contract signatures and binds requests to the connected address", async () => {
    const provider = create();
    await connect(provider);
    await expect(
      provider.request({ method: "personal_sign", params: ["0x1234", OTHER] })
    ).rejects.toMatchObject({ code: -32602 });
    const pending = provider.request({ method: "personal_sign", params: ["0x1234", ADDRESS] });
    const request = [...fixture.messages]
      .reverse()
      .find((item) => item.type === "OMW_MANAGED_REQUEST")!;
    const signature = `0x${"ab".repeat(512)}`;
    message(result(request, signature));
    expect(await pending).toBe(signature);
  });
  it("cancels exactly one request and ignores its late terminal result", async () => {
    const provider = create();
    const pending = provider.request({ method: "eth_requestAccounts" });
    const request = ready();
    const rejected = expect(pending).rejects.toMatchObject({ code: 4001 });
    expect(provider.cancel()).toBe(true);
    await rejected;
    expect(fixture.messages.at(-1)).toMatchObject({ type: "OMW_MANAGED_CANCEL", id: request.id });
    message(result(request, [ADDRESS]));
    expect(await provider.request({ method: "eth_accounts" })).toEqual([]);
  });
  it("requires explicit reconnection for a chain change and never connects an EOA instead", async () => {
    const provider = create();
    await connect(provider);
    await expect(
      provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] })
    ).rejects.toMatchObject({ code: 4200 });
    expect(await provider.request({ method: "eth_accounts" })).toEqual([ADDRESS]);
  });
  it("clears an expired peer session instead of returning a stale connected account", async () => {
    const provider = create();
    await connect(provider);
    const pending = provider.request({ method: "personal_sign", params: ["0x1234", ADDRESS] });
    const request = [...fixture.messages]
      .reverse()
      .find((item) => item.type === "OMW_MANAGED_REQUEST")!;
    const rejected = expect(pending).rejects.toMatchObject({ code: 4100 });
    message({
      type: "OMW_MANAGED_ERROR",
      version: 1,
      sessionId: request.sessionId,
      id: request.id,
      chainId: 8453,
      account: "managed",
      error: { code: 4100, message: "Reconnect explicitly" },
    });
    await rejected;
    expect(await provider.request({ method: "eth_accounts" })).toEqual([]);
    expect(surface.destroy).toHaveBeenCalled();
  });
  it("blocks blind transaction resubmission after a dispatched request times out", async () => {
    const provider = create();
    await connect(provider);
    const args = {
      method: "eth_sendTransaction",
      params: [{ from: ADDRESS, to: OTHER, value: "0x1" }],
    };
    const pending = provider.request(args);
    const rejected = expect(pending).rejects.toThrow("outcome unknown");
    await vi.advanceTimersByTimeAsync(120_000);
    await rejected;
    await expect(provider.request(args)).rejects.toMatchObject({ code: -32002 });
  });
  it("returns a known uncertain hash while preserving the recovery frame until authenticated dismissal", async () => {
    const provider = create();
    await connect(provider);
    surface.hide.mockClear();
    const args = {
      method: "eth_sendTransaction",
      params: [{ from: ADDRESS, to: OTHER, value: "0x1" }],
    };
    const pending = provider.request(args);
    const request = [...fixture.messages]
      .reverse()
      .find((item) => item.type === "OMW_MANAGED_REQUEST")!;
    const hash = `0x${"ab".repeat(32)}`;
    const rejected = expect(pending).rejects.toMatchObject({
      code: -32003,
      data: { transactionHash: hash, chainId: 8453 },
    });
    message({
      type: "OMW_MANAGED_ERROR",
      version: 1,
      sessionId: request.sessionId,
      id: request.id,
      chainId: 8453,
      account: "managed",
      transactionHash: hash,
      error: { code: -32003, message: "Transaction outcome unknown" },
    });
    await rejected;
    expect(surface.hide).not.toHaveBeenCalled();
    await expect(provider.request(args)).rejects.toMatchObject({ code: -32002 });
    const dismiss = { type: "OMW_MANAGED_DISMISS", version: 1, sessionId: request.sessionId };
    message(dismiss, "https://evil.example");
    expect(surface.hide).not.toHaveBeenCalled();
    message(dismiss);
    expect(surface.hide).toHaveBeenCalledExactlyOnceWith({ restoreFocus: true });
  });
  it("does not return an account if a connect-event listener disconnects", async () => {
    const provider = create();
    provider.on("connect", () => provider.disconnect());
    const pending = provider.request({ method: "eth_requestAccounts" });
    const rejected = expect(pending).rejects.toMatchObject({ code: 4001 });
    message(result(ready(), [ADDRESS]));
    await rejected;
    expect(await provider.request({ method: "eth_accounts" })).toEqual([]);
  });
  it("rejects arbitrary iframe origins and sandbox overrides before creating a surface", () => {
    expect(
      () => new ManagedEmbedProvider({ hostConfig: { iframeSrc: "https://evil.example" } })
    ).toThrow("fixed Embed");
    expect(() => new ManagedEmbedProvider({ hostConfig: { sandbox: "allow-scripts" } })).toThrow(
      "fixed"
    );
    expect(fixture.surface).not.toHaveBeenCalled();
  });
});

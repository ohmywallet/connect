import { beforeEach, expect, it, vi } from "vitest";
import { createConnectProvider, type UnifiedConnectOptions } from "./unified";

const fixture = vi.hoisted(() => ({
  factories: { managed: vi.fn(), fee: vi.fn(), app: vi.fn() },
}));
vi.mock("./managed-embed", () => ({
  ManagedEmbedProvider: class {
    constructor(options: unknown) {
      return fixture.factories.managed(options);
    }
  },
}));
vi.mock("./app", () => ({
  createAppProvider: (options: unknown) => fixture.factories.app(options),
}));
vi.mock("./provider", async (original) => ({
  ...(await original<object>()),
  createProvider: (options: unknown) => fixture.factories.fee(options),
}));
const ADDRESS = "0x1111111111111111111111111111111111111111";
class Adapter {
  listeners = new Map<string, Set<(value: unknown) => void>>();
  request = vi.fn(async (_args: { method: string }): Promise<unknown> => [ADDRESS]);
  cancel = vi.fn(() => true);
  disconnect = vi.fn(async () => {});
  destroy = vi.fn();
  on(event: string, listener: (value: unknown) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }
  removeListener(event: string, listener: (value: unknown) => void) {
    this.listeners.get(event)?.delete(listener);
  }
}
let adapter: Adapter;
beforeEach(() => {
  vi.resetAllMocks();
  adapter = new Adapter();
  for (const factory of Object.values(fixture.factories)) factory.mockReturnValue(adapter);
});
it("defaults to managed embedded without initializing a fee wallet or WalletConnect", () => {
  const provider = createConnectProvider();
  expect(provider.currentState).toEqual({
    account: "managed",
    transport: "embedded",
    chainId: 1,
    status: "idle",
    busy: false,
  });
  expect(fixture.factories.managed).toHaveBeenCalledExactlyOnceWith({ chainId: 1, hostConfig: {} });
  expect(fixture.factories.fee).not.toHaveBeenCalled();
  expect(fixture.factories.app).not.toHaveBeenCalled();
  expect(adapter.request).not.toHaveBeenCalled();
  provider.destroy();
});
it.each([
  ["managed", "embedded", "managed"],
  ["fee", "embedded", "fee"],
  ["managed", "walletconnect", "app"],
  ["fee", "walletconnect", "app"],
] as const)("selects only %s via %s", async (account, transport, factory) => {
  const options: UnifiedConnectOptions =
    transport === "walletconnect"
      ? { account, transport, projectId: "ab".repeat(16), metadata: { name: "My service" } }
      : { account, transport };
  const provider = createConnectProvider(options);
  expect(fixture.factories[factory]).toHaveBeenCalledTimes(1);
  for (const [key, value] of Object.entries(fixture.factories))
    if (key !== factory) expect(value).not.toHaveBeenCalled();
  if (transport === "walletconnect")
    expect(fixture.factories.app.mock.calls[0]![0]).toMatchObject({ account });
  expect(await provider.request({ method: "eth_requestAccounts" })).toEqual([ADDRESS]);
  expect(provider.currentState.account).toBe(account);
  provider.destroy();
});
it("preserves managed rejection instead of falling back to a fee account", async () => {
  const provider = createConnectProvider();
  adapter.request.mockRejectedValueOnce(
    Object.assign(new Error("Managed wallet not prepared"), { code: 4100 })
  );
  await expect(provider.request({ method: "eth_requestAccounts" })).rejects.toMatchObject({
    code: 4100,
  });
  expect(fixture.factories.fee).not.toHaveBeenCalled();
  expect(fixture.factories.app).not.toHaveBeenCalled();
  expect(provider.currentState).toMatchObject({ account: "managed", status: "idle", busy: false });
  provider.destroy();
});
it("does not accept a late successful result after cancellation", async () => {
  let resolve!: (value: unknown) => void;
  adapter.request.mockImplementationOnce(
    () =>
      new Promise((accept) => {
        resolve = accept;
      })
  );
  const provider = createConnectProvider();
  const pending = provider.request({ method: "eth_requestAccounts" });
  const rejected = expect(pending).rejects.toMatchObject({ code: 4001 });
  provider.cancel();
  resolve([ADDRESS]);
  await rejected;
  expect(provider.currentState).toMatchObject({ account: "managed", busy: false });
  expect(provider.currentState.address).toBeUndefined();
  expect(fixture.factories.fee).not.toHaveBeenCalled();
  provider.destroy();
});
it("forwards the same contract signing request without assuming an EOA signature", async () => {
  const provider = createConnectProvider();
  const signature = `0x${"ab".repeat(512)}`;
  adapter.request.mockResolvedValueOnce(signature);
  const args = { method: "personal_sign", params: ["0x1234", ADDRESS] };
  expect(await provider.request(args)).toBe(signature);
  expect(adapter.request).toHaveBeenCalledExactlyOnceWith(args);
  provider.destroy();
});
it("uses a passive read transport for public RPC without authorizing a fee account", async () => {
  const provider = createConnectProvider({
    account: "managed",
    transport: "embedded",
    chainId: 8453,
  });
  expect(fixture.factories.fee).not.toHaveBeenCalled();
  adapter.request.mockResolvedValueOnce("0x10");
  const args = { method: "eth_getBalance", params: [ADDRESS, "latest"] };
  expect(await provider.request(args)).toBe("0x10");
  expect(fixture.factories.fee).toHaveBeenCalledExactlyOnceWith({ chainId: 8453 });
  expect(adapter.request).toHaveBeenCalledExactlyOnceWith(args);
  expect(provider.currentState).toMatchObject({ account: "managed", status: "idle" });
  expect(provider.currentState.address).toBeUndefined();
  provider.destroy();
});

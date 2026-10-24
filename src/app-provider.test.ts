import { getAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppClientOptions } from "./app-client";
import { AppProviderRuntime } from "./app-provider";
import type { AppProtocolEvent, AppProtocolSession, AppSignClient } from "./app-protocol";
import type { AppProviderOptions, AppProviderState } from "./app-types";

const NOW = 1_800_000_000_000;
const CHAIN_ID = 8453;
const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const CHECKSUM_ADDRESS = getAddress(ADDRESS);
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const TOPIC = "ab".repeat(32);
const PAIRING_TOPIC = "cd".repeat(32);
const URI = `wc:${PAIRING_TOPIC}@2?relay-protocol=irn&symKey=${"ef".repeat(32)}`;
const HASH = `0x${"12".repeat(32)}`;
const SIGNATURE = `0x${"34".repeat(260)}`;
const OPTIONS: AppProviderOptions = {
  projectId: "12".repeat(16),
  chainId: CHAIN_ID,
  metadata: {
    name: "My service",
    description: "Connection test",
    icons: ["https://dapp.example/icon.png"],
  },
  locale: "ko",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function protocolSession(): AppProtocolSession {
  return {
    topic: TOPIC,
    pairingTopic: PAIRING_TOPIC,
    expiry: NOW / 1000 + 3600,
    namespaces: {
      eip155: {
        chains: [`eip155:${CHAIN_ID}`],
        accounts: [`eip155:${CHAIN_ID}:${ADDRESS}`],
        methods: ["personal_sign", "eth_signTypedData_v4", "eth_sendTransaction"],
        events: ["accountsChanged", "chainChanged"],
      },
    },
  };
}

class FakeClient implements AppSignClient {
  readonly approval = deferred<AppProtocolSession>();
  stored = protocolSession();
  uri = URI;
  readonly listeners = new Map<AppProtocolEvent, Set<(payload: unknown) => void>>();
  readonly session = { get: vi.fn((_topic: string) => this.stored) };
  readonly connect = vi.fn(async (_params: Parameters<AppSignClient["connect"]>[0]) => ({
    uri: this.uri,
    approval: () => this.approval.promise,
  }));
  readonly request = vi.fn(
    async (_params: Parameters<AppSignClient["request"]>[0]): Promise<unknown> => SIGNATURE
  );
  readonly disconnect = vi.fn(async (_params: Parameters<AppSignClient["disconnect"]>[0]) => {});
  readonly disconnectPairing = vi.fn(async (_topic: string) => {});
  readonly close = vi.fn(async () => {});
  readonly on = vi.fn((event: AppProtocolEvent, callback: (payload: unknown) => void) => {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(callback);
    this.listeners.set(event, listeners);
  });
  readonly off = vi.fn((event: AppProtocolEvent, callback: (payload: unknown) => void) => {
    this.listeners.get(event)?.delete(callback);
  });
  emit(event: AppProtocolEvent, payload: unknown) {
    for (const callback of [...(this.listeners.get(event) ?? [])]) callback(payload);
  }
}

const providers = new Set<AppProviderRuntime>();
function harness(
  settings: {
    client?: FakeClient;
    origin?: string;
    now?: () => number;
    options?: AppProviderOptions;
  } = {}
) {
  const client = settings.client ?? new FakeClient();
  const createClient = vi.fn(async (_options: AppClientOptions): Promise<AppSignClient> => client);
  const provider = new AppProviderRuntime(settings.options ?? OPTIONS, {
    createClient,
    origin: () => settings.origin ?? "https://dapp.example",
    now: settings.now ?? (() => NOW),
    nonce: () => "test-instance",
  });
  providers.add(provider);
  return { provider, client, createClient };
}
type Harness = ReturnType<typeof harness>;
async function flush() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}
function observe(promise: Promise<unknown>) {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
}
async function connect(value: Harness) {
  const result = value.provider.request({ method: "eth_requestAccounts" });
  await flush();
  expect(value.provider.currentState.status).toBe("pairing");
  value.client.approval.resolve(value.client.stored);
  expect(await result).toEqual([CHECKSUM_ADDRESS]);
  expect(value.provider.currentState).toMatchObject({
    status: "connected",
    address: CHECKSUM_ADDRESS,
    busy: false,
  });
}
const transaction = () => ({
  from: CHECKSUM_ADDRESS,
  to: RECIPIENT,
  value: "0x1",
  chainId: "0x2105",
});
const typedData = () => ({
  domain: { name: "Test", chainId: CHAIN_ID },
  types: { Message: [{ name: "text", type: "string" }] },
  primaryType: "Message",
  message: { text: "Please review" },
});

afterEach(async () => {
  for (const provider of providers) provider.destroy();
  providers.clear();
  await flush();
  vi.useRealTimers();
});

describe("App provider lifecycle and pairing UI", () => {
  it.each(["managed", "fee"] as const)(
    "binds explicit %s account intent in the encrypted proposal and approval",
    async (account) => {
      const value = harness({ options: { ...OPTIONS, account } });
      value.client.stored.sessionProperties = {
        "ohmywallet.account": account,
        "ohmywallet.connect": "1",
      };
      const pending = value.provider.request({ method: "eth_requestAccounts" });
      await flush();
      expect(value.client.connect.mock.calls[0]![0]).toMatchObject({
        sessionProperties: value.client.stored.sessionProperties,
      });
      expect(value.provider.currentState.pairing?.appUrl).toContain(
        `&account=${account}&chainId=${CHAIN_ID}`
      );
      value.client.approval.resolve(value.client.stored);
      expect(await pending).toEqual([CHECKSUM_ADDRESS]);
    }
  );

  it.each([1, 84532])(
    "includes the validated requested chain %s as an advisory App hint",
    async (chainId) => {
      const value = harness({ options: { ...OPTIONS, account: "managed", chainId } });
      value.client.stored.sessionProperties = {
        "ohmywallet.account": "managed",
        "ohmywallet.connect": "1",
      };
      value.client.stored.namespaces.eip155!.chains = [`eip155:${chainId}`];
      value.client.stored.namespaces.eip155!.accounts = [`eip155:${chainId}:${ADDRESS}`];
      const pending = value.provider.request({ method: "eth_requestAccounts" });
      await flush();
      expect(value.provider.currentState.pairing?.appUrl).toBe(
        `https://app.ohmywallet.xyz/ko#wc=${encodeURIComponent(URI)}&account=managed&chainId=${chainId}`
      );
      expect(value.client.connect.mock.calls[0]![0].requiredNamespaces.eip155.chains).toEqual([
        `eip155:${chainId}`,
      ]);
      value.client.approval.resolve(value.client.stored);
      expect(await pending).toEqual([CHECKSUM_ADDRESS]);
    }
  );

  it.each([
    undefined,
    { "ohmywallet.account": "fee", "ohmywallet.connect": "1" },
    { "ohmywallet.account": "managed", "ohmywallet.connect": "2" },
  ])(
    "rejects an approval that does not echo the explicit managed account intent: %o",
    async (properties) => {
      const value = harness({ options: { ...OPTIONS, account: "managed" } });
      value.client.stored.sessionProperties = properties;
      const pending = value.provider.request({ method: "eth_requestAccounts" });
      const rejected = expect(pending).rejects.toMatchObject({ code: 4100 });
      await flush();
      value.client.approval.resolve(value.client.stored);
      await rejected;
      expect(await value.provider.request({ method: "eth_accounts" })).toEqual([]);
    }
  );

  it("revokes a live session if its encrypted account intent changes", async () => {
    const value = harness({ options: { ...OPTIONS, account: "managed" } });
    value.client.stored.sessionProperties = {
      "ohmywallet.account": "managed",
      "ohmywallet.connect": "1",
    };
    await connect(value);
    value.client.stored.sessionProperties["ohmywallet.account"] = "fee";
    expect(await value.provider.request({ method: "eth_accounts" })).toEqual([]);
  });

  it("does not initialize WalletConnect or restore accounts during construction or passive reads", async () => {
    const { provider, createClient } = harness();
    expect(provider.currentState).toEqual({ status: "idle", chainId: CHAIN_ID, busy: false });
    expect(await provider.request({ method: "eth_accounts" })).toEqual([]);
    expect(await provider.request({ method: "eth_chainId" })).toBe("0x2105");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("lazily uses the actual dApp origin, isolated in-memory storage and a fixed App fragment link", async () => {
    const value = harness();
    const result = value.provider.request({ method: "eth_requestAccounts" });
    await flush();
    const options = value.createClient.mock.calls[0]![0];
    expect(options).toMatchObject({
      projectId: OPTIONS.projectId,
      metadata: {
        name: "My service",
        url: "https://dapp.example",
        description: "Connection test",
        icons: ["https://dapp.example/icon.png"],
      },
      customStoragePrefix: "omw-app-test-instance",
      relayUrl: "wss://relay.walletconnect.org",
      logger: "silent",
      telemetryEnabled: false,
    });
    expect(await options.storage.getKeys()).toEqual([]);
    const data = { address: ADDRESS };
    await options.storage.setItem("public", data);
    data.address = RECIPIENT;
    expect(await options.storage.getItem("public")).toEqual({ address: ADDRESS });
    expect(value.client.connect).toHaveBeenCalledWith({
      requiredNamespaces: {
        eip155: {
          chains: ["eip155:8453"],
          methods: ["personal_sign", "eth_signTypedData_v4", "eth_sendTransaction"],
          events: ["accountsChanged", "chainChanged"],
        },
      },
    });
    expect(value.provider.currentState.pairing).toEqual({
      uri: URI,
      appUrl: `https://app.ohmywallet.xyz/ko#wc=${encodeURIComponent(URI)}`,
      expiresAt: NOW + 300_000,
    });
    expect(Object.isFrozen(value.provider.currentState)).toBe(true);
    expect(Object.isFrozen(value.provider.currentState.pairing)).toBe(true);
    value.client.approval.resolve(value.client.stored);
    expect(await result).toEqual([CHECKSUM_ADDRESS]);
    expect(value.provider.currentState.pairing).toBeUndefined();
  });

  it.each([
    "http://evil.example",
    "https://dapp.example/path",
    "file:///tmp/page",
    "not-an-origin",
  ])("rejects an invalid actual origin %s before creating a relay client", async (origin) => {
    const value = harness({ origin });
    await expect(value.provider.request({ method: "eth_requestAccounts" })).rejects.toMatchObject({
      code: -32602,
    });
    expect(value.createClient).not.toHaveBeenCalled();
    expect(value.provider.currentState.status).toBe("idle");
  });

  it("emits the approved account and reuses only this live session", async () => {
    const value = harness();
    const accounts = vi.fn(),
      connected = vi.fn();
    value.provider.on("accountsChanged", accounts).on("connect", connected);
    await connect(value);
    expect(accounts).toHaveBeenLastCalledWith([CHECKSUM_ADDRESS]);
    expect(connected).toHaveBeenCalledWith({ chainId: "0x2105" });
    expect(await value.provider.request({ method: "eth_requestAccounts" })).toEqual([
      CHECKSUM_ADDRESS,
    ]);
    expect(value.client.connect).toHaveBeenCalledTimes(1);
    expect(value.createClient).toHaveBeenCalledTimes(1);
    await value.provider.disconnect();
    expect(await value.provider.request({ method: "eth_accounts" })).toEqual([]);
    expect(accounts).toHaveBeenLastCalledWith([]);
    expect(value.client.close).toHaveBeenCalled();
  });

  it("keeps separate Provider instances from sharing their memory storage or connection", async () => {
    const first = harness(),
      second = harness();
    await connect(first);
    const storage = first.createClient.mock.calls[0]![0].storage;
    await storage.setItem("session", { topic: TOPIC });
    expect(await second.provider.request({ method: "eth_accounts" })).toEqual([]);
    expect(second.createClient).not.toHaveBeenCalled();
    await connect(second);
    expect(await second.createClient.mock.calls[0]![0].storage.getKeys()).toEqual([]);
  });

  it.each(["cancel", "destroy"] as const)(
    "%s rejects a pending pairing and cannot resurrect a late approval",
    async (action) => {
      const value = harness();
      const accounts = vi.fn(),
        connected = vi.fn();
      value.provider.on("accountsChanged", accounts).on("connect", connected);
      const result = observe(value.provider.request({ method: "eth_requestAccounts" }));
      await flush();
      if (action === "cancel") expect(value.provider.cancel()).toBe(true);
      else value.provider.destroy();
      expect(await result).toMatchObject({ error: { code: 4001 } });
      expect(value.provider.currentState.status).toBe(action === "destroy" ? "closed" : "idle");
      expect(value.provider.currentState.pairing).toBeUndefined();
      await flush();
      value.client.approval.resolve(value.client.stored);
      await flush();
      expect(connected).not.toHaveBeenCalled();
      expect(accounts).not.toHaveBeenCalled();
      expect(value.client.disconnectPairing).toHaveBeenCalledWith(PAIRING_TOPIC);
      expect(value.client.disconnect).toHaveBeenCalledWith(
        expect.objectContaining({ topic: TOPIC })
      );
      expect(value.client.close).toHaveBeenCalled();
      expect(value.provider.currentState.address).toBeUndefined();
    }
  );

  it("expires pairing without waiting for the remote approval promise", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const client = new FakeClient();
    client.uri = `${URI}&expiryTimestamp=${NOW / 1000 + 30}`;
    const value = harness({ client, now: Date.now });
    const result = observe(value.provider.request({ method: "eth_requestAccounts" }));
    await flush();
    expect(value.provider.currentState.pairing?.expiresAt).toBe(NOW + 30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toMatchObject({ error: { code: 4900, reason: "expired" } });
    expect(value.provider.currentState).toEqual({ status: "idle", chainId: CHAIN_ID, busy: false });
    expect(value.client.disconnectPairing).toHaveBeenCalledWith(PAIRING_TOPIC);
    expect(value.client.request).not.toHaveBeenCalled();
  });

  it("clears an expired connected session without a relay delete event", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const value = harness({ now: Date.now });
    await connect(value);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(await value.provider.request({ method: "eth_accounts" })).toEqual([]);
    expect(value.provider.currentState.status).toBe("idle");
    expect(value.client.close).toHaveBeenCalled();
  });
});

describe("App request transport and account boundaries", () => {
  it("passes a variable-length contract signature without treating it as an EOA signature", async () => {
    const value = harness();
    await connect(value);
    expect(
      await value.provider.request({
        method: "personal_sign",
        params: ["0x68656c6c6f", CHECKSUM_ADDRESS],
      })
    ).toBe(SIGNATURE);
    expect(value.client.request).toHaveBeenCalledWith({
      topic: TOPIC,
      chainId: "eip155:8453",
      request: { method: "personal_sign", params: ["0x68656c6c6f", CHECKSUM_ADDRESS] },
      expiry: 300,
    });
  });

  it("snapshots typed data before the caller can mutate the request", async () => {
    const value = harness();
    await connect(value);
    const reply = deferred<unknown>();
    value.client.request.mockImplementationOnce(async () => reply.promise);
    const payload = typedData();
    const result = value.provider.request({
      method: "eth_signTypedData_v4",
      params: [CHECKSUM_ADDRESS, payload],
    });
    payload.message.text = "Changed after approval started";
    payload.domain.chainId = 1;
    const captured = value.client.request.mock.calls[0]![0];
    expect(captured.request.params[1]).toMatchObject({
      domain: { chainId: CHAIN_ID },
      message: { text: "Please review" },
    });
    reply.resolve(SIGNATURE);
    expect(await result).toBe(SIGNATURE);
  });

  it("returns an accepted network hash without reporting execution success", async () => {
    const value = harness();
    await connect(value);
    value.client.request.mockResolvedValueOnce(HASH);
    expect(
      await value.provider.request({ method: "eth_sendTransaction", params: [transaction()] })
    ).toBe(HASH);
    expect(value.client.request).toHaveBeenCalledTimes(1);
    expect(value.provider.currentState).toMatchObject({ status: "connected", busy: false });
  });

  it.each([
    [
      "transaction sender",
      { method: "eth_sendTransaction", params: [{ ...transaction(), from: RECIPIENT }] },
    ],
    [
      "transaction chain",
      { method: "eth_sendTransaction", params: [{ ...transaction(), chainId: "0x1" }] },
    ],
    ["message sender", { method: "personal_sign", params: ["0x1234", RECIPIENT] }],
    ["typed data sender", { method: "eth_signTypedData_v4", params: [RECIPIENT, typedData()] }],
    [
      "typed data chain",
      {
        method: "eth_signTypedData_v4",
        params: [CHECKSUM_ADDRESS, { ...typedData(), domain: { chainId: 1 } }],
      },
    ],
    [
      "conflicting transaction fees",
      {
        method: "eth_sendTransaction",
        params: [{ ...transaction(), gasPrice: "0x1", maxFeePerGas: "0x2" }],
      },
    ],
  ])("rejects a mismatched %s before forwarding to the wallet", async (_, args) => {
    const value = harness();
    await connect(value);
    await expect(value.provider.request(args)).rejects.toMatchObject({ code: -32602 });
    expect(value.client.request).not.toHaveBeenCalled();
  });

  it.each(["eth_sign", "eth_signTransaction", "wallet_sendCalls", "wallet_addEthereumChain"])(
    "does not expand the App path to %s",
    async (method) => {
      const value = harness();
      await connect(value);
      await expect(value.provider.request({ method, params: [] })).rejects.toMatchObject({
        code: 4200,
      });
      expect(value.client.request).not.toHaveBeenCalled();
    }
  );

  it("requires explicit reconnection for a different chain", async () => {
    const value = harness();
    await connect(value);
    expect(
      await value.provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x2105" }],
      })
    ).toBeNull();
    await expect(
      value.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] })
    ).rejects.toMatchObject({ code: 4200 });
    expect(value.provider.currentState.chainId).toBe(CHAIN_ID);
    expect(value.client.request).not.toHaveBeenCalled();
  });

  it("blocks a second connection request while pairing is still pending", async () => {
    const value = harness();
    const result = observe(value.provider.request({ method: "eth_requestAccounts" }));
    await flush();
    await expect(value.provider.request({ method: "eth_requestAccounts" })).rejects.toMatchObject({
      code: -32002,
    });
    expect(value.client.connect).toHaveBeenCalledTimes(1);
    value.provider.cancel();
    expect(await result).toMatchObject({ error: { code: 4001 } });
  });

  it("blocks concurrent signing instead of sending a second wallet request", async () => {
    const value = harness();
    await connect(value);
    const reply = deferred<unknown>();
    value.client.request.mockImplementationOnce(async () => reply.promise);
    const args = { method: "personal_sign", params: ["0x1234", CHECKSUM_ADDRESS] };
    const first = value.provider.request(args);
    await expect(value.provider.request(args)).rejects.toMatchObject({ code: -32002 });
    expect(value.client.request).toHaveBeenCalledTimes(1);
    reply.resolve(SIGNATURE);
    expect(await first).toBe(SIGNATURE);
  });

  it("keeps a network failure uncertain and prevents another submission", async () => {
    const value = harness();
    await connect(value);
    value.client.request.mockRejectedValueOnce(new Error("Relay disconnected after dispatch"));
    const args = { method: "eth_sendTransaction", params: [transaction()] };
    await expect(value.provider.request(args)).rejects.toMatchObject({
      code: -32000,
      message: expect.stringContaining("unknown"),
    });
    await expect(value.provider.request(args)).rejects.toMatchObject({ code: -32002 });
    expect(value.client.request).toHaveBeenCalledTimes(1);
  });

  it("keeps a timed-out transaction uncertain even when its response arrives late", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const value = harness({ now: Date.now });
    await connect(value);
    const reply = deferred<unknown>();
    value.client.request.mockImplementationOnce(async () => reply.promise);
    const args = { method: "eth_sendTransaction", params: [transaction()] };
    const result = observe(value.provider.request(args));
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await result).toMatchObject({
      error: { code: -32000, message: expect.stringContaining("unknown") },
    });
    await expect(value.provider.request(args)).rejects.toMatchObject({ code: -32002 });
    reply.resolve(HASH);
    await flush();
    await expect(value.provider.request(args)).rejects.toMatchObject({ code: -32002 });
    expect(value.client.request).toHaveBeenCalledTimes(1);
  });

  it("allows an explicit new transaction after a confirmed user rejection", async () => {
    const value = harness();
    await connect(value);
    value.client.request.mockRejectedValueOnce({ code: 4001 }).mockResolvedValueOnce(HASH);
    const args = { method: "eth_sendTransaction", params: [transaction()] };
    await expect(value.provider.request(args)).rejects.toMatchObject({ code: 4001 });
    expect(await value.provider.request(args)).toBe(HASH);
    expect(value.client.request).toHaveBeenCalledTimes(2);
  });
});

describe("session drift and consumer listener cancellation", () => {
  it.each(["account", "chain", "topic", "expiry"])(
    "disconnects when the stored session changes its %s",
    async (field) => {
      const value = harness();
      await connect(value);
      const changed = structuredClone(value.client.stored);
      if (field === "account")
        changed.namespaces.eip155!.accounts = [`eip155:${CHAIN_ID}:${RECIPIENT}`];
      else if (field === "chain") changed.namespaces.eip155!.chains = ["eip155:1"];
      else if (field === "topic") changed.topic = "99".repeat(32);
      else changed.expiry += 1;
      value.client.stored = changed;
      await expect(
        value.provider.request({ method: "personal_sign", params: ["0x1234", CHECKSUM_ADDRESS] })
      ).rejects.toMatchObject({ code: 4100 });
      expect(value.client.request).not.toHaveBeenCalled();
      expect(value.provider.currentState.status).toBe("idle");
    }
  );

  it("ignores unrelated protocol topics and accepts unchanged authorized events", async () => {
    const value = harness();
    await connect(value);
    value.client.emit("session_delete", { topic: "99".repeat(32) });
    value.client.emit("session_event", {
      topic: TOPIC,
      params: {
        chainId: "eip155:8453",
        event: { name: "accountsChanged", data: [CHECKSUM_ADDRESS] },
      },
    });
    value.client.emit("session_event", {
      topic: TOPIC,
      params: { chainId: "eip155:8453", event: { name: "chainChanged", data: "0x2105" } },
    });
    expect(await value.provider.request({ method: "eth_accounts" })).toEqual([CHECKSUM_ADDRESS]);
    expect(value.client.close).not.toHaveBeenCalled();
  });

  it.each([
    ["account", { chainId: "eip155:8453", event: { name: "accountsChanged", data: [RECIPIENT] } }],
    ["chain", { chainId: "eip155:8453", event: { name: "chainChanged", data: "0x1" } }],
    [
      "event chain",
      { chainId: "eip155:1", event: { name: "accountsChanged", data: [CHECKSUM_ADDRESS] } },
    ],
    ["unknown event", { chainId: "eip155:8453", event: { name: "other", data: [] } }],
  ])("disconnects on %s drift rather than switching silently", async (_, params) => {
    const value = harness();
    await connect(value);
    value.client.emit("session_event", { topic: TOPIC, params });
    expect(value.provider.currentState.status).toBe("idle");
    expect(await value.provider.request({ method: "eth_accounts" })).toEqual([]);
    expect(value.client.off).toHaveBeenCalledTimes(4);
  });

  it("rejects a namespace update that changes the approved account", async () => {
    const value = harness();
    await connect(value);
    const namespaces = structuredClone(value.client.stored.namespaces);
    namespaces.eip155!.accounts = [`eip155:${CHAIN_ID}:${RECIPIENT}`];
    value.client.emit("session_update", { topic: TOPIC, params: { namespaces } });
    expect(value.provider.currentState.status).toBe("idle");
    expect(await value.provider.request({ method: "eth_accounts" })).toEqual([]);
  });

  it("isolates consumer rendering exceptions from protocol processing", async () => {
    const value = harness();
    value.provider.on("stateChanged", () => {
      throw new Error("UI rendering failed");
    });
    await connect(value);
    expect(await value.provider.request({ method: "eth_accounts" })).toEqual([CHECKSUM_ADDRESS]);
  });

  it("honors cancellation by a pairing-state listener without returning the late account", async () => {
    const value = harness();
    value.provider.on("stateChanged", (raw) => {
      if ((raw as AppProviderState).status === "pairing") value.provider.cancel();
    });
    const result = observe(value.provider.request({ method: "eth_requestAccounts" }));
    await flush();
    value.client.approval.resolve(value.client.stored);
    expect(await result).toMatchObject({ error: { code: 4001 } });
    expect(value.provider.currentState.status).toBe("idle");
    expect(value.provider.currentState.pairing).toBeUndefined();
  });

  it("does not announce a connected account after a connected-state listener cancels", async () => {
    const value = harness();
    const accounts = vi.fn(),
      connected = vi.fn();
    value.provider.on("accountsChanged", accounts).on("connect", connected);
    value.provider.on("stateChanged", (raw) => {
      if ((raw as AppProviderState).status === "connected") value.provider.cancel();
    });
    const result = observe(value.provider.request({ method: "eth_requestAccounts" }));
    await flush();
    value.client.approval.resolve(value.client.stored);
    expect(await result).toMatchObject({ error: { code: 4001 } });
    expect(value.provider.currentState.status).toBe("idle");
    expect(connected).not.toHaveBeenCalled();
    expect(
      accounts.mock.calls.every(([addresses]) => Array.isArray(addresses) && addresses.length === 0)
    ).toBe(true);
  });
});

describe("App connection generation races", () => {
  it("does not let a cancelled transaction's late failure poison a newly connected session", async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    const value = harness({ client: first });
    value.createClient.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await connect(value);
    const late = deferred<unknown>();
    first.request.mockImplementationOnce(async () => late.promise);
    const args = { method: "eth_sendTransaction", params: [transaction()] };
    const cancelled = observe(value.provider.request(args));
    expect(first.request).toHaveBeenCalledTimes(1);
    expect(value.provider.cancel()).toBe(true);
    expect(await cancelled).toMatchObject({ error: { code: -32000 } });

    const reconnected = value.provider.request({ method: "eth_requestAccounts" });
    await flush();
    expect(value.provider.currentState.status).toBe("pairing");
    second.approval.resolve(second.stored);
    expect(await reconnected).toEqual([CHECKSUM_ADDRESS]);
    late.reject(new Error("Old relay response arrived after cancellation"));
    await flush();

    second.request.mockResolvedValueOnce(HASH);
    expect(await value.provider.request(args)).toBe(HASH);
    expect(first.request).toHaveBeenCalledTimes(1);
    expect(second.request).toHaveBeenCalledTimes(1);
    expect(value.provider.currentState).toMatchObject({ status: "connected", busy: false });
  });

  it("immediately cancels a reentrant reconnect started by the first request's idle listener", async () => {
    const value = harness();
    let firstBusy = true;
    let reconnectOnIdle = false;
    let newOutcome: Awaited<ReturnType<typeof observe>> | undefined;
    value.provider.on("stateChanged", (raw) => {
      const state = raw as AppProviderState;
      if (firstBusy && state.status === "idle" && state.busy) {
        firstBusy = false;
        reconnectOnIdle = true;
        value.provider.cancel();
      } else if (reconnectOnIdle && state.status === "idle" && !state.busy) {
        reconnectOnIdle = false;
        void observe(value.provider.request({ method: "eth_requestAccounts" })).then((outcome) => {
          newOutcome = outcome;
        });
      }
    });
    const original = observe(value.provider.request({ method: "eth_requestAccounts" }));
    await flush();
    expect(await original).toMatchObject({ error: { code: 4001 } });
    expect(value.provider.currentState.status).toBe("pairing");
    expect(newOutcome).toBeUndefined();
    expect(value.provider.cancel()).toBe(true);
    await flush();

    // No timer advances and no remote approval: cancellation must settle the new request now.
    expect(newOutcome).toMatchObject({ error: { code: 4001 } });
    expect(value.provider.currentState).toEqual({ status: "idle", chainId: CHAIN_ID, busy: false });
  });

  it("does not stop a new connection when an old session event already invalidated its own scope", async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    const value = harness({ client: first });
    value.createClient.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await connect(value);
    let reconnectOnIdle = true;
    let newResult: ReturnType<typeof observe> | undefined;
    value.provider.on("stateChanged", (raw) => {
      const state = raw as AppProviderState;
      if (reconnectOnIdle && state.status === "idle" && !state.busy) {
        reconnectOnIdle = false;
        newResult = observe(value.provider.request({ method: "eth_requestAccounts" }));
      }
    });
    first.stored = { ...first.stored, topic: "99".repeat(32) };
    first.emit("session_event", {
      topic: TOPIC,
      params: { chainId: "eip155:8453", event: { name: "chainChanged", data: "0x2105" } },
    });
    await flush();
    expect(newResult).toBeDefined();
    expect(value.provider.currentState.status).toBe("pairing");
    expect(second.connect).toHaveBeenCalledTimes(1);
    expect(second.close).not.toHaveBeenCalled();
    second.approval.resolve(second.stored);
    expect(await newResult).toEqual({ value: [CHECKSUM_ADDRESS] });
    expect(await value.provider.request({ method: "eth_accounts" })).toEqual([CHECKSUM_ADDRESS]);
  });
});

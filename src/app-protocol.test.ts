import { getAddress, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { AppProviderRpcError } from "./app-types";
import {
  object,
  pairingInfo,
  quantity,
  rpcError,
  sameAddress,
  sessionAccount,
  type AppProtocolSession,
} from "./app-protocol";

const NOW = 1_800_000_000_000;
const CHAIN_ID = 8453;
const TOPIC = "ab".repeat(32);
const PAIRING_TOPIC = "cd".repeat(32);
const SYM_KEY = "ef".repeat(32);
const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const ACCOUNT = `eip155:${CHAIN_ID}:${ADDRESS}`;
const URI = `wc:${PAIRING_TOPIC}@2?relay-protocol=irn&symKey=${SYM_KEY}`;

function session(): AppProtocolSession {
  return {
    topic: TOPIC,
    pairingTopic: PAIRING_TOPIC,
    expiry: NOW / 1000 + 3600,
    namespaces: {
      eip155: {
        accounts: [ACCOUNT],
        chains: [`eip155:${CHAIN_ID}`],
        methods: ["personal_sign", "eth_signTypedData_v4", "eth_sendTransaction"],
        events: ["accountsChanged", "chainChanged"],
      },
    },
  };
}

function expectRpcError(action: () => unknown, code: number) {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(AppProviderRpcError);
  expect(error).toMatchObject({ code });
}

describe("App WalletConnect session authority", () => {
  it.each(["eip155", `eip155:${CHAIN_ID}`])(
    "accepts one exact account in the %s namespace and returns its checksum address",
    (namespace) => {
      const value = session();
      value.namespaces = { [namespace]: value.namespaces.eip155! };
      expect(sessionAccount(value, CHAIN_ID, NOW)).toBe(getAddress(ADDRESS));
    }
  );

  it("accepts reordered method/event sets and a namespace without redundant chains", () => {
    const value = session();
    const namespace = value.namespaces.eip155!;
    namespace.methods.reverse();
    namespace.events.reverse();
    delete namespace.chains;
    expect(sessionAccount(value, CHAIN_ID, NOW)).toBe(getAddress(ADDRESS));
  });

  it.each([
    [
      "second namespace",
      (value: AppProtocolSession) => {
        value.namespaces.solana = { accounts: ["solana:mainnet:example"], methods: [], events: [] };
      },
    ],
    [
      "second chain namespace",
      (value: AppProtocolSession) => {
        value.namespaces[`eip155:1`] = value.namespaces.eip155!;
      },
    ],
    [
      "wrong namespace",
      (value: AppProtocolSession) => {
        value.namespaces = { "eip155:1": value.namespaces.eip155! };
      },
    ],
    [
      "second chain",
      (value: AppProtocolSession) => {
        value.namespaces.eip155!.chains!.push("eip155:1");
      },
    ],
    [
      "duplicate chain",
      (value: AppProtocolSession) => {
        value.namespaces.eip155!.chains!.push(`eip155:${CHAIN_ID}`);
      },
    ],
    [
      "wrong chain",
      (value: AppProtocolSession) => {
        value.namespaces.eip155!.chains = ["eip155:1"];
      },
    ],
    [
      "second account",
      (value: AppProtocolSession) => {
        value.namespaces.eip155!.accounts.push(`eip155:${CHAIN_ID}:0x${"11".repeat(20)}`);
      },
    ],
    [
      "duplicate account",
      (value: AppProtocolSession) => {
        value.namespaces.eip155!.accounts.push(ACCOUNT);
      },
    ],
    [
      "account on another chain",
      (value: AppProtocolSession) => {
        value.namespaces.eip155!.accounts = [`eip155:1:${ADDRESS}`];
      },
    ],
    [
      "noncanonical account chain",
      (value: AppProtocolSession) => {
        value.namespaces.eip155!.accounts = [`eip155:08453:${ADDRESS}`];
      },
    ],
  ] as const)("rejects %s instead of expanding scope", (_, mutate) => {
    const value = session();
    mutate(value);
    expectRpcError(() => sessionAccount(value, CHAIN_ID, NOW), 4100);
  });

  it.each([
    ["missing method", ["personal_sign", "eth_sendTransaction"]],
    ["extra method", ["personal_sign", "eth_signTypedData_v4", "eth_sendTransaction", "eth_sign"]],
    ["duplicate method", ["personal_sign", "personal_sign", "eth_sendTransaction"]],
    ["unsupported replacement", ["personal_sign", "eth_signTypedData_v4", "eth_signTransaction"]],
    ["empty methods", []],
    ["missing events", ["accountsChanged"]],
    ["extra event", ["accountsChanged", "chainChanged", "message"]],
    ["duplicate event", ["accountsChanged", "accountsChanged"]],
  ] as const)("rejects %s", (label, values) => {
    const value = session();
    if (label.includes("event")) value.namespaces.eip155!.events = [...values];
    else value.namespaces.eip155!.methods = [...values];
    expectRpcError(() => sessionAccount(value, CHAIN_ID, NOW), 4100);
  });

  it.each([NOW / 1000, NOW / 1000 - 1, 0, -1, 1.5, Number.NaN, Infinity, "1800003600"])(
    "rejects expired or malformed session expiry %s",
    (expiry) => {
      const value = { ...session(), expiry } as unknown as AppProtocolSession;
      expectRpcError(() => sessionAccount(value, CHAIN_ID, NOW), 4100);
    }
  );

  it.each(["topic", "pairingTopic"] as const)("validates the %s", (field) => {
    for (const topic of [
      null,
      undefined,
      "",
      "ab",
      "gh".repeat(32),
      "AB".repeat(32),
      `${TOPIC}0`,
    ]) {
      const value = { ...session(), [field]: topic } as unknown as AppProtocolSession;
      expectRpcError(() => sessionAccount(value, CHAIN_ID, NOW), 4100);
    }
  });

  it.each([
    null,
    undefined,
    false,
    [],
    {},
    { ...session(), namespaces: null },
    { ...session(), namespaces: { eip155: null } },
  ])("rejects malformed protocol envelopes without returning an account (%j)", (value) => {
    expectRpcError(() => sessionAccount(value as AppProtocolSession, CHAIN_ID, NOW), 4100);
  });

  it.each([
    ["accounts", null],
    ["accounts", [null]],
    ["accounts", "not-an-array"],
    ["methods", null],
    ["methods", [null, "personal_sign", "eth_sendTransaction"]],
    ["events", null],
    ["chains", null],
  ] as const)("rejects malformed namespace %s %j", (field, invalid) => {
    const value = session();
    Object.assign(value.namespaces.eip155!, { [field]: invalid });
    expectRpcError(() => sessionAccount(value, CHAIN_ID, NOW), 4100);
  });

  it.each([zeroAddress, "0x1234", "not-an-address", `${ADDRESS}:extra`, ADDRESS.slice(2)])(
    "rejects unusable account address %s",
    (address) => {
      const value = session();
      value.namespaces.eip155!.accounts = [`eip155:${CHAIN_ID}:${address}`];
      expectRpcError(() => sessionAccount(value, CHAIN_ID, NOW), 4100);
    }
  );
});

describe("private App pairing carrier", () => {
  it("accepts a v2 URI and caps a distant declared expiry at five minutes", () => {
    const uri = `${URI}&expiryTimestamp=${NOW / 1000 + 3600}`;
    expect(pairingInfo(uri, NOW)).toEqual({ uri, topic: PAIRING_TOPIC, expiresAt: NOW + 300_000 });
  });

  it("limits older URIs without an expiry to five minutes", () => {
    expect(pairingInfo(URI, NOW)).toEqual({
      uri: URI,
      topic: PAIRING_TOPIC,
      expiresAt: NOW + 300_000,
    });
  });

  it("respects a shorter declared expiry without extending it", () => {
    const uri = `${URI}&expiryTimestamp=${NOW / 1000 + 45}`;
    expect(pairingInfo(uri, NOW).expiresAt).toBe(NOW + 45_000);
  });

  it("accepts reviewed optional relay data and proposal methods", () => {
    const uri = `${URI}&relay-data=0123ab&methods=${encodeURIComponent("[wc_sessionPropose],[wc_sessionRequest,wc_sessionDelete]")}`;
    expect(pairingInfo(uri, NOW)).toMatchObject({ uri, topic: PAIRING_TOPIC });
  });

  it("preserves the private URI while normalizing its hexadecimal topic", () => {
    const uri = URI.replace(PAIRING_TOPIC, PAIRING_TOPIC.toUpperCase());
    expect(pairingInfo(uri, NOW)).toMatchObject({ uri, topic: PAIRING_TOPIC });
  });

  it.each([
    ["duplicate key", `${URI}&symKey=${SYM_KEY}`],
    ["encoded duplicate key", `${URI}&%73ymKey=${SYM_KEY}`],
    ["duplicate relay", `${URI}&relay-protocol=irn`],
    [
      "duplicate expiry",
      `${URI}&expiryTimestamp=${NOW / 1000 + 60}&expiryTimestamp=${NOW / 1000 + 120}`,
    ],
    ["redirect injection", `${URI}&redirect_uri=https%3A%2F%2Fevil.example`],
    ["origin injection", `${URI}&origin=https%3A%2F%2Fevil.example`],
    ["chain injection", `${URI}&chainId=1`],
    ["wrong relay", URI.replace("relay-protocol=irn", "relay-protocol=evil")],
    ["missing relay", `wc:${PAIRING_TOPIC}@2?symKey=${SYM_KEY}`],
    ["missing key", `wc:${PAIRING_TOPIC}@2?relay-protocol=irn`],
    ["short key", URI.replace(SYM_KEY, "01")],
    ["nonhex key", URI.replace(SYM_KEY, "gg".repeat(32))],
    ["odd relay data", `${URI}&relay-data=abc`],
    ["oversized relay data", `${URI}&relay-data=${"ab".repeat(257)}`],
    ["nonhex relay data", `${URI}&relay-data=xy`],
    ["wrong version", URI.replace("@2?", "@1?")],
    ["wrong scheme", URI.replace("wc:", "https:")],
    ["short topic", URI.replace(PAIRING_TOPIC, "abcd")],
    ["nonhex topic", URI.replace(PAIRING_TOPIC, "xx".repeat(32))],
    ["leading whitespace", ` ${URI}`],
    ["embedded whitespace", URI.replace("@2", " @2")],
    ["line break", `${URI}\n`],
    ["NUL", `${URI}\0`],
    ["fragment", `${URI}#payload`],
    ["oversized URI", `${URI}&relay-data=${"ab".repeat(1100)}`],
    ["methods without proposal", `${URI}&methods=${encodeURIComponent("[wc_sessionRequest]")}`],
    ["unbracketed methods", `${URI}&methods=wc_sessionPropose`],
    ["malformed methods", `${URI}&methods=${encodeURIComponent("[wc_sessionPropose,]")}`],
    ["empty methods", `${URI}&methods=`],
  ] as const)("rejects %s", (_, uri) => {
    expectRpcError(() => pairingInfo(uri, NOW), -32603);
  });

  it.each([
    "0",
    "-1",
    "1.5",
    "01800000060",
    "1e10",
    "Infinity",
    "99999999999999",
    String(NOW / 1000),
    String(NOW / 1000 - 1),
  ])("rejects expired or malformed pairing expiry %s", (expiry) => {
    expectRpcError(() => pairingInfo(`${URI}&expiryTimestamp=${expiry}`, NOW), -32603);
  });

  it.each([null, undefined, {}, [], 1, ""])("rejects a non-URI value %j", (value) => {
    expectRpcError(() => pairingInfo(value, NOW), -32603);
  });
});

describe("App RPC parameter boundaries", () => {
  it("compares valid addresses case-insensitively without coercing input", () => {
    expect(sameAddress(getAddress(ADDRESS), ADDRESS)).toBe(true);
    expect(sameAddress(ADDRESS, getAddress(ADDRESS))).toBe(true);
    expect(sameAddress(`0x${ADDRESS.slice(2).toUpperCase()}`, ADDRESS)).toBe(false);
    for (const value of [null, undefined, {}, [], ADDRESS.slice(2), `${ADDRESS}00`, "0x1234"])
      expect(sameAddress(value, ADDRESS)).toBe(false);
    expect(sameAddress(`0x${"11".repeat(20)}`, ADDRESS)).toBe(false);
  });

  it("accepts canonical hexadecimal quantities without rounding", () => {
    expect(quantity("0x0")).toBe(0n);
    expect(quantity("0x1")).toBe(1n);
    expect(quantity("0x20000000000001")).toBe(9_007_199_254_740_993n);
  });

  it.each([null, undefined, 1, "1", "0x", "0x00", "0x01", "0x-1", "0x1.2", "0x1 "])(
    "rejects noncanonical quantity %j",
    (value) => expectRpcError(() => quantity(value), -32602)
  );

  it("keeps objects intact and rejects array/null parameters", () => {
    const params = { address: ADDRESS };
    expect(object(params)).toBe(params);
    for (const value of [null, undefined, [], 1, "params"])
      expectRpcError(() => object(value), -32602);
  });

  it("preserves local RPC errors and maps peer rejection codes to user rejection", () => {
    const error = new AppProviderRpcError(4100, "Not connected");
    expect(rpcError(error)).toBe(error);
    for (const code of [4001, 5000, 5001]) expect(rpcError({ code })).toMatchObject({ code: 4001 });
  });

  it("does not expose arbitrary peer errors or pairing material", () => {
    const error = rpcError({ code: -32000, message: URI, uri: URI });
    expect(error).toBeInstanceOf(AppProviderRpcError);
    expect(error.code).toBe(-32603);
    expect(error.message).not.toContain(SYM_KEY);
    expect(error.message).not.toContain(URI);
  });
});

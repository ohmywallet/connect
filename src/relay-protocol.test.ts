import { hashTypedData, type TypedDataDefinition } from "viem";
import { describe, expect, it, vi } from "vitest";

import {
  buildCancel,
  buildConnect,
  buildDeriveAddress,
  buildRelayInit,
  buildSign,
  parseRelayOnboarding,
  parseRelayReady,
  parseTerminal,
  type ActiveProtocolRequest,
} from "./relay-protocol";

const ACTIVE_ID = "active-request";
const CANCEL_ID = "cancel-request";
const PRIMARY_EVM = {
  address: "0x0000000000000000000000000000000000000001",
  keyIndex: 0,
  curve: "secp256k1",
  group: "evm",
} as const;
const STRUCTURED_REQUEST = {
  kind: "message",
  message: { type: "text", value: "hello" },
} as const;
const RAW_REQUEST = { kind: "raw", payload: "0x0102" } as const;

function zkSyncTypedData() {
  return {
    domain: { name: "zkSync", version: "2", chainId: 300n },
    types: {
      Transaction: [
        { name: "txType", type: "uint256" },
        { name: "from", type: "uint256" },
        { name: "to", type: "uint256" },
        { name: "gasLimit", type: "uint256" },
        { name: "gasPerPubdataByteLimit", type: "uint256" },
        { name: "maxFeePerGas", type: "uint256" },
        { name: "maxPriorityFeePerGas", type: "uint256" },
        { name: "paymaster", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
        { name: "factoryDeps", type: "bytes32[]" },
        { name: "paymasterInput", type: "bytes" },
      ],
    },
    primaryType: "Transaction",
    message: {
      txType: 113,
      from: "0x1111111111111111111111111111111111111111",
      to: "0x2222222222222222222222222222222222222222",
      gasLimit: 1_000_000n,
      gasPerPubdataByteLimit: 50_000,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      paymaster: "0x0000000000000000000000000000000000000000",
      nonce: 0,
      value: 3n,
      data: "0x",
      factoryDeps: [],
      paymasterInput: "0x",
    },
  } as const;
}

function builtTypedData(request: unknown) {
  const built = buildSign(
    ACTIVE_ID,
    { kind: "typedData", typedData: request } as never,
    { address: PRIMARY_EVM.address },
    10
  );
  if (built.type !== "SIGN_WITH_DERIVATION" || built.payload.request.kind !== "typedData") {
    throw new Error("Expected a typed-data signing request");
  }
  return built.payload.request.typedData;
}

function typedDataRequest(domain: unknown) {
  return {
    kind: "typedData",
    typedData: {
      domain,
      types: { Mail: [{ name: "value", type: "string" }] },
      primaryType: "Mail",
      message: { value: "hello" },
    },
  } as const;
}

function active(
  operation: ActiveProtocolRequest["operation"],
  id = ACTIVE_ID
): ActiveProtocolRequest {
  if (operation === "CONNECT") return { version: 2, id, operation };
  if (operation === "DERIVE_ADDRESS") {
    return {
      version: 2,
      id,
      operation,
      selector: { keyIndex: 0, group: "evm", curve: "secp256k1" },
    } as unknown as ActiveProtocolRequest;
  }
  return {
    version: 2,
    id,
    operation,
    selector: { group: "evm", keyIndex: 0 },
  } as unknown as ActiveProtocolRequest;
}

function activeAddressSign(address: string): ActiveProtocolRequest {
  return {
    version: 2,
    id: ACTIVE_ID,
    operation: "SIGN_WITH_DERIVATION",
    selector: { address },
  } as unknown as ActiveProtocolRequest;
}

function terminalEnvelope(type: string, data: unknown, requestId = ACTIVE_ID): unknown {
  return {
    type,
    id: requestId,
    payload: { requestId, data },
    timestamp: 10,
  };
}

function connectEnvelope(address: unknown, requestId = ACTIVE_ID): unknown {
  return terminalEnvelope("CONNECT_RESULT", { address }, requestId);
}

function parseConnectResult(value: unknown) {
  const terminal = parseTerminal(value, active("CONNECT"));
  return terminal?.type === "CONNECT_RESULT" ? terminal.result : null;
}

function countCharCodeAtCalls(action: () => void): { calls: number; error: unknown } {
  const original = String.prototype.charCodeAt;
  const spy = vi.spyOn(String.prototype, "charCodeAt").mockImplementation(function (
    this: string,
    index: number
  ) {
    return original.call(this, index);
  });
  spy.mockClear();
  let error: unknown;
  let calls = 0;
  try {
    action();
  } catch (caught) {
    error = caught;
  } finally {
    calls = spy.mock.calls.length;
    spy.mockRestore();
  }
  return { calls, error };
}

describe("relay v2 request builders", () => {
  it("builds exact init, connect, derive, sign, and cancellation records", () => {
    expect(buildRelayInit()).toEqual({ type: "RELAY_INIT", version: 2 });
    expect(buildConnect(ACTIVE_ID, 10)).toEqual({
      type: "CONNECT",
      id: ACTIVE_ID,
      payload: {},
      timestamp: 10,
    });
    expect(
      buildDeriveAddress(ACTIVE_ID, { keyIndex: 7, group: "evm", curve: "secp256k1" }, 10)
    ).toEqual({
      type: "DERIVE_ADDRESS",
      id: ACTIVE_ID,
      payload: { keyIndex: 7, group: "evm", curve: "secp256k1" },
      timestamp: 10,
    });
    expect(buildSign(ACTIVE_ID, STRUCTURED_REQUEST, { address: PRIMARY_EVM.address }, 10)).toEqual({
      type: "SIGN_WITH_DERIVATION",
      id: ACTIVE_ID,
      payload: { request: STRUCTURED_REQUEST, address: PRIMARY_EVM.address },
      timestamp: 10,
    });
    expect(buildSign(ACTIVE_ID, RAW_REQUEST, { group: "solana", keyIndex: 3 }, 10)).toEqual({
      type: "SIGN_WITH_DERIVATION",
      id: ACTIVE_ID,
      payload: { request: RAW_REQUEST, group: "solana", keyIndex: 3 },
      timestamp: 10,
    });
    expect(buildCancel(ACTIVE_ID, CANCEL_ID, 10)).toEqual({
      type: "CANCEL",
      id: CANCEL_ID,
      payload: { requestId: ACTIVE_ID },
      timestamp: 10,
    });
  });

  it.each(["", "x".repeat(129)])("rejects the bounded request ID %j", (id) => {
    expect(() => buildConnect(id, 10)).toThrow(TypeError);
    expect(() => buildCancel(ACTIVE_ID, id, 10)).toThrow(TypeError);
    expect(() => buildCancel(id, CANCEL_ID, 10)).toThrow(TypeError);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects the unsafe timestamp %s",
    (timestamp) => {
      expect(() => buildConnect(ACTIVE_ID, timestamp)).toThrow(TypeError);
      expect(() => buildCancel(ACTIVE_ID, CANCEL_ID, timestamp)).toThrow(TypeError);
    }
  );

  it.each([
    [{ keyIndex: -1, group: "evm", curve: "secp256k1" }, "negative key index"],
    [{ keyIndex: 0x80000000, group: "evm", curve: "secp256k1" }, "large key index"],
    [{ keyIndex: 0, group: "evm", curve: "ed25519" }, "wrong EVM curve"],
    [{ keyIndex: 0, group: "solana", curve: "secp256k1" }, "wrong Solana curve"],
    [
      { keyIndex: 0, group: "evm", curve: "secp256k1", bitcoinAddressType: "p2tr" },
      "Bitcoin data on EVM",
    ],
    [{ keyIndex: 0, group: "bitcoin", curve: "secp256k1" }, "missing Bitcoin metadata"],
  ] as const)("rejects invalid derive options: $1", (options, _case) => {
    expect(() => buildDeriveAddress(ACTIVE_ID, options as never, 10)).toThrow(TypeError);
  });

  it.each([
    [STRUCTURED_REQUEST, { group: "solana", keyIndex: 0 }, "structured Solana selector"],
    [STRUCTURED_REQUEST, { group: "bitcoin", keyIndex: 0 }, "structured Bitcoin selector"],
    [RAW_REQUEST, { address: PRIMARY_EVM.address }, "raw address selector"],
    [RAW_REQUEST, { group: "evm", keyIndex: 0 }, "raw EVM selector"],
    [RAW_REQUEST, { group: "bitcoin", keyIndex: 0 }, "raw Bitcoin selector"],
    [STRUCTURED_REQUEST, {}, "missing selector"],
    [
      STRUCTURED_REQUEST,
      { address: PRIMARY_EVM.address, group: "evm", keyIndex: 0 },
      "mixed selector",
    ],
  ] as const)("rejects $2", (request, options, _case) => {
    expect(() => buildSign(ACTIVE_ID, request as never, options as never, 10)).toThrow(TypeError);
  });

  it("rejects restricted JSON toJSON hooks", () => {
    expect(() =>
      buildSign(
        ACTIVE_ID,
        typedDataRequest({ toJSON: "not-a-hook" }) as never,
        { address: PRIMARY_EVM.address },
        10
      )
    ).toThrow(TypeError);
  });

  it("rejects restricted JSON containers at the maximum depth", () => {
    let domain: Record<string, unknown> = {};
    for (let depth = 0; depth < 32; depth += 1) {
      domain = { nested: domain };
    }

    expect(() =>
      buildSign(ACTIVE_ID, typedDataRequest(domain) as never, { address: PRIMARY_EVM.address }, 10)
    ).toThrow(TypeError);
  });

  it("enforces the complete ceremony-envelope node budget", () => {
    const largeRecord = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `items${index}`,
        Array.from({ length: 256 }, () => null),
      ])
    );

    expect(() =>
      buildSign(
        ACTIVE_ID,
        {
          kind: "typedData",
          typedData: {
            domain: largeRecord,
            types: { Mail: [{ name: "value", type: "string" }] },
            primaryType: "Mail",
            message: largeRecord,
          },
        },
        { address: PRIMARY_EVM.address },
        10
      )
    ).toThrow(TypeError);
  });

  it("reserves the complete ceremony-envelope nesting depth", () => {
    let domain: Record<string, unknown> = {};
    for (let depth = 0; depth < 28; depth += 1) {
      domain = { nested: domain };
    }

    expect(() =>
      buildSign(ACTIVE_ID, typedDataRequest(domain) as never, { address: PRIMARY_EVM.address }, 10)
    ).toThrow(TypeError);
  });

  it("reserves the complete ceremony-envelope byte budget", () => {
    expect(() =>
      buildSign(
        ACTIVE_ID,
        { kind: "raw", payload: `0x${"00".repeat(65_385)}` },
        { group: "solana", keyIndex: 0 },
        10
      )
    ).toThrow(TypeError);
  });

  it("rejects non-Unicode-scalar restricted JSON keys", () => {
    expect(() =>
      buildSign(
        ACTIVE_ID,
        typedDataRequest({ ["\ud800"]: true }) as never,
        { address: PRIMARY_EVM.address },
        10
      )
    ).toThrow(TypeError);
  });

  it("rejects non-canonical uppercase hex requests", () => {
    expect(() =>
      buildSign(
        ACTIVE_ID,
        { kind: "raw", payload: "0xAB" } as never,
        { group: "solana", keyIndex: 0 },
        10
      )
    ).toThrow(TypeError);
  });

  it("rejects oversized hex before evaluating the byte-pattern regex", () => {
    const regexTest = vi.spyOn(RegExp.prototype, "test");
    regexTest.mockClear();
    let error: unknown;
    let calls = 0;
    try {
      buildSign(
        ACTIVE_ID,
        { kind: "raw", payload: `0x${"00".repeat(131_073)}` },
        { group: "solana", keyIndex: 0 },
        10
      );
    } catch (caught) {
      error = caught;
    } finally {
      calls = regexTest.mock.calls.length;
      regexTest.mockRestore();
    }

    expect(error).toBeInstanceOf(TypeError);
    expect(calls).toBe(0);
  });

  it("rejects oversized average transaction values before evaluating the decimal regex", () => {
    const regexTest = vi.spyOn(RegExp.prototype, "test");
    regexTest.mockClear();
    let error: unknown;
    let calls = 0;
    try {
      buildSign(
        ACTIVE_ID,
        {
          ...STRUCTURED_REQUEST,
          context: { averageTransactionValue: "1".repeat(131_073) },
        },
        { address: PRIMARY_EVM.address },
        10
      );
    } catch (caught) {
      error = caught;
    } finally {
      calls = regexTest.mock.calls.length;
      regexTest.mockRestore();
    }

    expect(error).toBeInstanceOf(TypeError);
    expect(calls).toBe(0);
  });

  it.each([
    ["string", () => typedDataRequest({ value: "x".repeat(131_073) })],
    ["key", () => typedDataRequest({ ["x".repeat(131_073)]: true })],
  ] as const)(
    "rejects an oversized restricted JSON %s before scanning all code units",
    (_case, request) => {
      const measured = countCharCodeAtCalls(() => {
        buildSign(ACTIVE_ID, request() as never, { address: PRIMARY_EVM.address }, 10);
      });

      expect(measured.error).toBeInstanceOf(TypeError);
      expect(measured.calls).toBeLessThan(100);
    }
  );

  it("rejects an oversized restricted JSON array before enumerating its keys", () => {
    const values = new Proxy(new Array(257), {
      ownKeys() {
        throw new Error("oversized arrays must fail before ownKeys");
      },
    });

    expect(() =>
      buildSign(
        ACTIVE_ID,
        typedDataRequest({ values }) as never,
        { address: PRIMARY_EVM.address },
        10
      )
    ).toThrow(TypeError);
  });

  it("enforces the running canonical byte budget without serializing the full envelope", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    stringify.mockClear();
    encode.mockClear();
    let error: unknown;
    let stringifyCalls = 0;
    let encodeCalls = 0;
    try {
      buildSign(
        ACTIVE_ID,
        { kind: "raw", payload: `0x${"00".repeat(65_125)}` },
        { group: "solana", keyIndex: 0 },
        10
      );
    } catch (caught) {
      error = caught;
    } finally {
      stringifyCalls = stringify.mock.calls.length;
      encodeCalls = encode.mock.calls.length;
      stringify.mockRestore();
      encode.mockRestore();
    }

    expect(error).toBeInstanceOf(TypeError);
    expect(stringifyCalls).toBe(0);
    expect(encodeCalls).toBe(0);
  });

  it("preserves the exact canonical raw-payload byte boundary", () => {
    expect(() =>
      buildSign(
        ACTIVE_ID,
        { kind: "raw", payload: `0x${"00".repeat(65_124)}` },
        { group: "solana", keyIndex: 0 },
        10
      )
    ).not.toThrow();
    expect(() =>
      buildSign(
        ACTIVE_ID,
        { kind: "raw", payload: `0x${"00".repeat(65_125)}` },
        { group: "solana", keyIndex: 0 },
        10
      )
    ).toThrow(TypeError);
  });

  it("rejects extra, inherited, accessor, and symbol data without invoking getters", () => {
    expect(() =>
      buildSign(
        ACTIVE_ID,
        { ...STRUCTURED_REQUEST, authenticatorData: "0x01" } as never,
        { address: PRIMARY_EVM.address },
        10
      )
    ).toThrow(TypeError);

    const inherited = Object.create({ inherited: true }) as Record<string, unknown>;
    Object.assign(inherited, STRUCTURED_REQUEST);
    expect(() =>
      buildSign(ACTIVE_ID, inherited as never, { address: PRIMARY_EVM.address }, 10)
    ).toThrow(TypeError);

    let getterCalls = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "kind", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "message";
      },
    });
    Object.defineProperty(accessor, "message", {
      enumerable: true,
      value: STRUCTURED_REQUEST.message,
    });
    expect(() =>
      buildSign(ACTIVE_ID, accessor as never, { address: PRIMARY_EVM.address }, 10)
    ).toThrow(TypeError);
    expect(getterCalls).toBe(0);

    const symbol = { ...STRUCTURED_REQUEST } as Record<PropertyKey, unknown>;
    symbol[Symbol("hidden")] = true;
    expect(() =>
      buildSign(ACTIVE_ID, symbol as never, { address: PRIMARY_EVM.address }, 10)
    ).toThrow(TypeError);
  });

  it("normalizes the confirmed ZKsync EIP-712 bigint shape without changing its digest", () => {
    const original = zkSyncTypedData();
    const originalDigest = hashTypedData(original as TypedDataDefinition);

    const normalized = builtTypedData(original);

    expect(normalized).toEqual({
      domain: { name: "zkSync", version: "2", chainId: "300" },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
        ],
        Transaction: original.types.Transaction,
      },
      primaryType: "Transaction",
      message: {
        ...original.message,
        gasLimit: "1000000",
        maxFeePerGas: "2",
        maxPriorityFeePerGas: "1",
        value: "3",
      },
    });
    expect(hashTypedData(normalized as TypedDataDefinition)).toBe(originalDigest);
    expect(original.domain.chainId).toBe(300n);
    expect(original.message.gasLimit).toBe(1_000_000n);
    expect(Object.hasOwn(original.types, "EIP712Domain")).toBe(false);
  });

  it("normalizes signed and unsigned bigint leaves through nested structs and arrays", () => {
    const normalized = builtTypedData({
      domain: { name: "Nested", chainId: 1n, epoch: -2n },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "chainId", type: "uint" },
          { name: "epoch", type: "int8" },
        ],
        Batch: [
          { name: "orders", type: "Order[2][]" },
          { name: "matrix", type: "uint16[][2]" },
        ],
        Order: [
          { name: "amount", type: "uint64" },
          { name: "adjustment", type: "int" },
        ],
      },
      primaryType: "Batch",
      message: {
        orders: [
          [
            { amount: 1n, adjustment: -1n },
            { amount: 2n, adjustment: 0n },
          ],
        ],
        matrix: [[3n, 4n], [5n]],
      },
    });

    expect(normalized.domain).toEqual({ name: "Nested", chainId: "1", epoch: "-2" });
    expect(normalized.types.EIP712Domain).toEqual([
      { name: "name", type: "string" },
      { name: "chainId", type: "uint" },
      { name: "epoch", type: "int8" },
    ]);
    expect(normalized.message).toEqual({
      orders: [
        [
          { amount: "1", adjustment: "-1" },
          { amount: "2", adjustment: "0" },
        ],
      ],
      matrix: [["3", "4"], ["5"]],
    });
  });

  it("mirrors viem's recognized standard domain fields without adding absent fields", () => {
    const original = {
      domain: {
        name: "",
        version: "",
        chainId: 300n,
        verifyingContract: "0x1111111111111111111111111111111111111111",
        salt: `0x${"22".repeat(32)}`,
      },
      types: { Example: [{ name: "value", type: "uint256" }] },
      primaryType: "Example",
      message: { value: 1n },
    } as const;

    const normalized = builtTypedData(original);

    expect(normalized.types.EIP712Domain).toEqual([
      { name: "name", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
    ]);
    expect(hashTypedData(normalized as TypedDataDefinition)).toBe(
      hashTypedData(original as TypedDataDefinition)
    );
  });

  it.each([
    ["string field", { fieldType: "string", value: 1n }],
    ["bytes field", { fieldType: "bytes32", value: 1n }],
    ["boolean field", { fieldType: "bool", value: 1n }],
    ["address field", { fieldType: "address", value: 1n }],
    ["unknown struct", { fieldType: "Missing", value: { nested: 1n } }],
    ["unknown struct array", { fieldType: "Missing[]", value: [{ nested: 1n }] }],
  ] as const)("rejects bigint in a %s", (_case, { fieldType, value }) => {
    expect(() =>
      builtTypedData({
        domain: {},
        types: { Example: [{ name: "value", type: fieldType }] },
        primaryType: "Example",
        message: { value },
      })
    ).toThrow(TypeError);
  });

  it("rejects bigint in untyped extra fields", () => {
    expect(() =>
      builtTypedData({
        domain: { extra: 1n },
        types: { Example: [{ name: "value", type: "uint256" }] },
        primaryType: "Example",
        message: { value: 1n },
      })
    ).toThrow(TypeError);
    expect(() =>
      builtTypedData({
        domain: {},
        types: { Example: [{ name: "value", type: "uint256" }] },
        primaryType: "Example",
        message: { value: 1n, extra: 2n },
      })
    ).toThrow(TypeError);
  });

  it.each([
    ["uint8 negative", "uint8", -1n],
    ["uint8 overflow", "uint8", 256n],
    ["int8 underflow", "int8", -129n],
    ["int8 overflow", "int8", 128n],
    ["invalid uint width", "uint7", 1n],
    ["noncanonical uint width", "uint08", 1n],
    ["invalid int width", "int264", 1n],
    ["default uint256 overflow", "uint", 1n << 256n],
    ["default int256 underflow", "int", -(1n << 255n) - 1n],
    ["default int256 overflow", "int", 1n << 255n],
  ] as const)("rejects %s", (_case, fieldType, value) => {
    expect(() =>
      builtTypedData({
        domain: {},
        types: { Example: [{ name: "value", type: fieldType }] },
        primaryType: "Example",
        message: { value },
      })
    ).toThrow(TypeError);
  });

  it("does not broaden unsafe numbers or accept the wrong fixed-array length", () => {
    expect(() =>
      builtTypedData({
        domain: {},
        types: { Example: [{ name: "value", type: "uint256" }] },
        primaryType: "Example",
        message: { value: Number.MAX_SAFE_INTEGER + 1 },
      })
    ).toThrow(TypeError);
    expect(() =>
      builtTypedData({
        domain: {},
        types: { Example: [{ name: "values", type: "uint256[2]" }] },
        primaryType: "Example",
        message: { values: [1n] },
      })
    ).toThrow(TypeError);
  });

  it("rejects hostile and cyclic schema-guided containers without invoking getters", () => {
    let getterCalls = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1n;
      },
    });
    expect(() =>
      builtTypedData({
        domain: {},
        types: { Example: [{ name: "value", type: "uint256" }] },
        primaryType: "Example",
        message: accessor,
      })
    ).toThrow(TypeError);
    expect(getterCalls).toBe(0);

    const cycle: Record<string, unknown> = {};
    cycle.next = cycle;
    expect(() =>
      builtTypedData({
        domain: {},
        types: {
          Example: [{ name: "next", type: "Example" }],
        },
        primaryType: "Example",
        message: cycle,
      })
    ).toThrow(TypeError);
  });

  it("rejects an oversized domain proxy before requesting property descriptors", () => {
    let descriptorCalls = 0;
    const domain = new Proxy(
      {},
      {
        ownKeys() {
          return ["chainId", ...Array.from({ length: 256 }, (_, index) => `field${index}`)];
        },
        getOwnPropertyDescriptor(_target, key) {
          descriptorCalls += 1;
          return {
            configurable: true,
            enumerable: true,
            value: key === "chainId" ? 1n : true,
            writable: true,
          };
        },
      }
    );

    expect(() =>
      builtTypedData({
        domain,
        types: { Example: [{ name: "value", type: "uint256" }] },
        primaryType: "Example",
        message: { value: 1n },
      })
    ).toThrow(TypeError);
    expect(descriptorCalls).toBe(0);
  });

  it("inspects only recognized domain descriptors before the normal bounded copy", () => {
    let ownKeysCalls = 0;
    const descriptorKeys: string[] = [];
    const domain = new Proxy(
      {},
      {
        ownKeys() {
          ownKeysCalls += 1;
          if (ownKeysCalls > 1) throw new TypeError("stop before normal copy");
          return ["name", "version", "chainId", "verifyingContract", "salt", "extra"];
        },
        getOwnPropertyDescriptor(_target, key) {
          descriptorKeys.push(String(key));
          const values: Record<string, unknown> = {
            name: "Example",
            version: "1",
            chainId: 1n,
            verifyingContract: "0x1111111111111111111111111111111111111111",
            salt: `0x${"22".repeat(32)}`,
          };
          return {
            configurable: true,
            enumerable: true,
            value: values[String(key)],
            writable: true,
          };
        },
      }
    );

    expect(() =>
      builtTypedData({
        domain,
        types: { Example: [{ name: "value", type: "uint256" }] },
        primaryType: "Example",
        message: { value: 1n },
      })
    ).toThrow(TypeError);
    expect(descriptorKeys).toEqual(["chainId", "name", "version", "verifyingContract", "salt"]);
  });

  it("rejects an accessor domain chainId without invoking its getter", () => {
    let getterCalls = 0;
    const domain = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(domain, "chainId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1n;
      },
    });

    expect(() =>
      builtTypedData({
        domain,
        types: { Example: [{ name: "value", type: "uint256" }] },
        primaryType: "Example",
        message: { value: 1n },
      })
    ).toThrow(TypeError);
    expect(getterCalls).toBe(0);
  });
});

describe("relay v2 response parsing", () => {
  it("parses only the exact relay v2 ready acknowledgement", () => {
    expect(parseRelayReady({ type: "RELAY_READY", version: 2 })).toEqual({
      type: "RELAY_READY",
      version: 2,
    });

    for (const value of [
      { type: "RELAY_READY", version: 1 },
      { type: "RELAY_READY", version: "2" },
      { type: "RELAY_READY", version: 2, extra: true },
      { type: "READY", version: 2 },
    ]) {
      expect(parseRelayReady(value)).toBeNull();
    }
  });

  it("rejects hostile ready containers without invoking accessors", () => {
    let getterCalls = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "type", {
      enumerable: true,
      value: "RELAY_READY",
    });
    Object.defineProperty(accessor, "version", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 2;
      },
    });
    expect(parseRelayReady(accessor)).toBeNull();
    expect(getterCalls).toBe(0);

    const inherited = Object.create({ inherited: true }) as Record<string, unknown>;
    Object.assign(inherited, { type: "RELAY_READY", version: 2 });
    expect(parseRelayReady(inherited)).toBeNull();

    const symbol = { type: "RELAY_READY", version: 2 } as Record<PropertyKey, unknown>;
    symbol[Symbol("hidden")] = true;
    expect(parseRelayReady(symbol)).toBeNull();

    const hostileProxy = new Proxy(
      { type: "RELAY_READY", version: 2 },
      {
        ownKeys() {
          throw new Error("must fail closed");
        },
      }
    );
    expect(parseRelayReady(hostileProxy)).toBeNull();
  });

  it("parses the exact v2 connect result to the primary EVM address", () => {
    expect(parseConnectResult(connectEnvelope(PRIMARY_EVM))).toEqual({ address: PRIMARY_EVM });
  });

  it("parses operation-bound derive, sign, and error terminals", () => {
    expect(
      parseTerminal(
        terminalEnvelope("DERIVE_ADDRESS_RESULT", { success: true, address: PRIMARY_EVM }),
        active("DERIVE_ADDRESS")
      )
    ).toEqual({
      type: "DERIVE_ADDRESS_RESULT",
      result: { success: true, address: PRIMARY_EVM },
    });
    expect(
      parseTerminal(
        terminalEnvelope("SIGN_RESULT", {
          address: PRIMARY_EVM.address,
          signature: "0x1234",
        }),
        active("SIGN_WITH_DERIVATION")
      )
    ).toEqual({
      type: "SIGN_RESULT",
      result: { address: PRIMARY_EVM.address, signature: "0x1234" },
    });
    expect(
      parseTerminal(
        {
          type: "ERROR",
          id: ACTIVE_ID,
          payload: { requestId: ACTIVE_ID, code: "USER_CANCELLED", message: "Cancelled" },
          timestamp: 10,
        },
        active("SIGN_WITH_DERIVATION")
      )
    ).toEqual({
      type: "ERROR",
      error: { code: "USER_CANCELLED", message: "Cancelled" },
    });
  });

  it("correlates derive results to the exact effective selector", () => {
    for (const address of [
      { ...PRIMARY_EVM, keyIndex: 99 },
      {
        address: "So11111111111111111111111111111111111111112",
        keyIndex: 99,
        curve: "ed25519",
        group: "solana",
      },
    ]) {
      expect(
        parseTerminal(
          terminalEnvelope("DERIVE_ADDRESS_RESULT", { success: true, address }),
          active("DERIVE_ADDRESS")
        )
      ).toBeNull();
    }
  });

  it("correlates Bitcoin derive metadata exactly", () => {
    const address = {
      address: "bc1ptest",
      keyIndex: 7,
      curve: "secp256k1",
      group: "bitcoin",
      bitcoinAddressType: "p2tr",
      bitcoinNetwork: "mainnet",
    } as const;
    const request = {
      version: 2,
      id: ACTIVE_ID,
      operation: "DERIVE_ADDRESS",
      selector: {
        keyIndex: 7,
        curve: "secp256k1",
        group: "bitcoin",
        bitcoinAddressType: "p2tr",
        bitcoinNetwork: "mainnet",
      },
    } as unknown as ActiveProtocolRequest;

    expect(
      parseTerminal(terminalEnvelope("DERIVE_ADDRESS_RESULT", { success: true, address }), request)
    ).toEqual({
      type: "DERIVE_ADDRESS_RESULT",
      result: { success: true, address },
    });
    for (const mismatch of [
      { ...address, bitcoinAddressType: "p2wpkh" },
      { ...address, bitcoinNetwork: "testnet4" },
      { ...address, keyIndex: 8 },
    ]) {
      expect(
        parseTerminal(
          terminalEnvelope("DERIVE_ADDRESS_RESULT", { success: true, address: mismatch }),
          request
        )
      ).toBeNull();
    }
  });

  it("correlates address-selected signing with EVM case-insensitive identity", () => {
    const requested = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    const returned = requested.toLowerCase();
    expect(
      parseTerminal(
        terminalEnvelope("SIGN_RESULT", { address: returned, signature: "0x1234" }),
        activeAddressSign(requested)
      )
    ).toEqual({
      type: "SIGN_RESULT",
      result: { address: returned, signature: "0x1234" },
    });
    expect(
      parseTerminal(
        terminalEnvelope("SIGN_RESULT", {
          address: "0x0000000000000000000000000000000000000002",
          signature: "0x1234",
        }),
        activeAddressSign(requested)
      )
    ).toBeNull();
  });

  it("rejects non-canonical uppercase hex terminals", () => {
    expect(
      parseTerminal(
        terminalEnvelope("SIGN_RESULT", {
          address: PRIMARY_EVM.address,
          signature: "0xAB",
        }),
        active("SIGN_WITH_DERIVATION")
      )
    ).toBeNull();
  });

  it("parses only exact v2 Derivation onboarding for an active connect", () => {
    const value = {
      type: "NEEDS_ONBOARDING",
      id: ACTIVE_ID,
      payload: { requestId: ACTIVE_ID, signerType: "derivation" },
      timestamp: 10,
    };
    expect(parseRelayOnboarding(value, active("CONNECT"))).toEqual({
      type: "NEEDS_ONBOARDING",
    });
    expect(
      parseRelayOnboarding(
        { ...value, payload: { requestId: ACTIVE_ID, signerType: "passkey" } },
        active("CONNECT")
      )
    ).toBeNull();
    expect(parseRelayOnboarding(value, active("DERIVE_ADDRESS"))).toBeNull();
  });

  it.each([
    [
      "outer/payload ID mismatch",
      {
        type: "CONNECT_RESULT",
        id: ACTIVE_ID,
        payload: { requestId: "another-request", data: { address: PRIMARY_EVM } },
        timestamp: 10,
      },
    ],
    ["active request mismatch", connectEnvelope(PRIMARY_EVM, "another-request")],
    ["wrong operation", terminalEnvelope("SIGN_RESULT", { address: "x", signature: "0x01" })],
    ["extra envelope field", { ...(connectEnvelope(PRIMARY_EVM) as object), extra: true }],
    [
      "extra payload field",
      {
        type: "CONNECT_RESULT",
        id: ACTIVE_ID,
        payload: { requestId: ACTIVE_ID, data: { address: PRIMARY_EVM }, extra: true },
        timestamp: 10,
      },
    ],
    ["NaN timestamp", { ...(connectEnvelope(PRIMARY_EVM) as object), timestamp: Number.NaN }],
    [
      "unsafe timestamp",
      { ...(connectEnvelope(PRIMARY_EVM) as object), timestamp: Number.MAX_SAFE_INTEGER + 1 },
    ],
  ] as const)("rejects %s", (_case, value) => {
    expect(parseTerminal(value, active("CONNECT"))).toBeNull();
  });

  it("rejects wrong address groups, curves, bounds, and primary-result extras", () => {
    for (const address of [
      { ...PRIMARY_EVM, group: "solana", curve: "ed25519" },
      { ...PRIMARY_EVM, curve: "ed25519" },
      { ...PRIMARY_EVM, keyIndex: -1 },
      { ...PRIMARY_EVM, keyIndex: 0x80000000 },
      { ...PRIMARY_EVM, address: "" },
      { ...PRIMARY_EVM, address: "x".repeat(129) },
      { ...PRIMARY_EVM, bitcoinAddressType: "p2tr" },
    ]) {
      expect(parseConnectResult(connectEnvelope(address))).toBeNull();
    }

    expect(
      parseConnectResult(
        terminalEnvelope("CONNECT_RESULT", {
          address: PRIMARY_EVM,
          signerType: "derivation",
        })
      )
    ).toBeNull();
  });

  it("rejects PassKey data and cross-version terminal shapes", () => {
    expect(
      parseConnectResult(
        terminalEnvelope("CONNECT_RESULT", {
          signerType: "passkey",
          passkeys: [],
        })
      )
    ).toBeNull();
    expect(
      parseConnectResult(terminalEnvelope("CONNECT_RESULT", { signerType: "derivation" }))
    ).toBeNull();
    expect(
      parseTerminal(
        terminalEnvelope("SIGN_RESULT", {
          signerType: "derivation",
          address: PRIMARY_EVM.address,
          signature: "0x1234",
        }),
        active("SIGN_WITH_DERIVATION")
      )
    ).toBeNull();
    expect(
      parseTerminal(
        terminalEnvelope("SIGN_RESULT", {
          signerType: "passkey",
          keyId: `0x${"11".repeat(32)}`,
          signature: { r: `0x${"22".repeat(32)}`, s: `0x${"33".repeat(32)}` },
          authenticatorData: "0x01",
          clientDataJSON: "{}",
        }),
        active("SIGN_WITH_DERIVATION")
      )
    ).toBeNull();
    expect(
      parseTerminal(connectEnvelope(PRIMARY_EVM), {
        version: 1,
        id: ACTIVE_ID,
        operation: "CONNECT",
      } as never)
    ).toBeNull();
  });

  it("rejects malformed error codes and bounded strings", () => {
    for (const payload of [
      { requestId: ACTIVE_ID, code: "NOT_A_CODE", message: "Failed" },
      { requestId: ACTIVE_ID, code: "SIGN_FAILED", message: "" },
      { requestId: ACTIVE_ID, code: "SIGN_FAILED", message: "x".repeat(1025) },
      { requestId: ACTIVE_ID, code: "SIGN_FAILED", message: "Failed", extra: true },
    ]) {
      expect(
        parseTerminal(
          { type: "ERROR", id: ACTIVE_ID, payload, timestamp: 10 },
          active("SIGN_WITH_DERIVATION")
        )
      ).toBeNull();
    }
  });

  it("rejects hostile terminal containers without invoking accessors", () => {
    let getterCalls = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "type", { enumerable: true, value: "CONNECT_RESULT" });
    Object.defineProperty(accessor, "id", { enumerable: true, value: ACTIVE_ID });
    Object.defineProperty(accessor, "payload", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { requestId: ACTIVE_ID, data: { address: PRIMARY_EVM } };
      },
    });
    Object.defineProperty(accessor, "timestamp", { enumerable: true, value: 10 });
    expect(parseTerminal(accessor, active("CONNECT"))).toBeNull();
    expect(getterCalls).toBe(0);

    const inherited = Object.create({ inherited: true }) as Record<string, unknown>;
    Object.assign(inherited, connectEnvelope(PRIMARY_EVM));
    expect(parseTerminal(inherited, active("CONNECT"))).toBeNull();

    const symbol = connectEnvelope(PRIMARY_EVM) as Record<PropertyKey, unknown>;
    symbol[Symbol("hidden")] = true;
    expect(parseTerminal(symbol, active("CONNECT"))).toBeNull();

    const hostileProxy = new Proxy(connectEnvelope(PRIMARY_EVM) as object, {
      ownKeys() {
        throw new Error("must fail closed");
      },
    });
    expect(parseTerminal(hostileProxy, active("CONNECT"))).toBeNull();
  });
});

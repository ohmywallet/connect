import type {
  DerivationAddressInfo,
  DeriveAddressOptions,
  DeriveAddressSuccess,
  EvmSignOptions,
  EvmSigningRequest,
  IframeErrorCode,
  PrimaryConnectResult,
  PrimarySignResult,
  SigningContext,
  SolanaRawSigningRequest,
  SolanaSignOptions,
} from "./types";

const MAX_ID_LENGTH = 128;
const MAX_ADDRESS_LENGTH = 128;
const MAX_ERROR_MESSAGE_LENGTH = 1_024;
const MAX_DERIVATION_KEY_INDEX = 0x7fffffff;
const MAX_VARIABLE_HEX_BYTES = 131_072;
const MAX_SIGNATURE_BYTES = 512;
const MAX_TEXT_MESSAGE_LENGTH = 100_000;
const MAX_RESTRICTED_JSON_BYTES = 131_072;
const MAX_RESTRICTED_JSON_DEPTH = 32;
const MAX_RESTRICTED_JSON_NODES = 4_096;
const MAX_RESTRICTED_RECORD_KEYS = 256;
const MAX_RESTRICTED_ARRAY_ITEMS = 256;
const CEREMONY_RANDOM_ID_LENGTH = 22;
// Serialized HTTP(S) origins are ASCII and bounded by their host plus scheme and optional port.
const CEREMONY_PARENT_ORIGIN_RESERVE_LENGTH = 512;

const FORBIDDEN_RECORD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const IFRAME_ERROR_CODES = new Set<IframeErrorCode>([
  "NOT_INITIALIZED",
  "ALREADY_INITIALIZED",
  "TIMEOUT",
  "DESTROYED",
  "SIGN_FAILED",
  "INVALID_MESSAGE",
  "INVALID_ORIGIN",
  "VALIDATION_FAILED",
  "CREDENTIAL_INACCESSIBLE",
  "ALREADY_EXISTS",
  "USER_CANCELLED",
  "UNKNOWN_KEY",
  "UNKNOWN_ADDRESS",
  "EIP7702_UNAVAILABLE",
  "SECURITY_BOUNDARY_VIOLATION",
]);

type ExactRecord = Record<string, unknown>;

export type RelayOperation = "CONNECT" | "DERIVE_ADDRESS" | "SIGN_WITH_DERIVATION";

type ActiveDeriveSelector = Readonly<{
  keyIndex: number;
  curve: "secp256k1" | "ed25519";
  group: "evm" | "solana" | "bitcoin";
  bitcoinAddressType?: "p2wpkh" | "p2tr";
  bitcoinNetwork?: "mainnet" | "testnet4";
}>;

type ActiveSignSelector =
  Readonly<{ address: string }> | Readonly<{ group: "evm" | "solana"; keyIndex: number }>;

export type ActiveProtocolRequest =
  | Readonly<{ version: 2; id: string; operation: "CONNECT" }>
  | Readonly<{
      version: 2;
      id: string;
      operation: "DERIVE_ADDRESS";
      selector: ActiveDeriveSelector;
    }>
  | Readonly<{
      version: 2;
      id: string;
      operation: "SIGN_WITH_DERIVATION";
      selector: ActiveSignSelector;
    }>;

export type ParentRequest =
  | Readonly<{
      type: "CONNECT";
      id: string;
      payload: Readonly<Record<string, never>>;
      timestamp: number;
    }>
  | Readonly<{
      type: "DERIVE_ADDRESS";
      id: string;
      payload: DeriveAddressOptions;
      timestamp: number;
    }>
  | Readonly<{
      type: "SIGN_WITH_DERIVATION";
      id: string;
      payload: Readonly<{
        request: EvmSigningRequest | SolanaRawSigningRequest;
        address?: string;
        group?: "evm" | "solana";
        keyIndex?: number;
      }>;
      timestamp: number;
    }>
  | Readonly<{
      type: "CANCEL";
      id: string;
      payload: Readonly<{ requestId: string }>;
      timestamp: number;
    }>
  | Readonly<{
      type: "DESTROY";
      id: string;
      payload: Readonly<{ reason: "Host destroyed" }>;
      timestamp: number;
    }>;

export type RelayReadyV2 = Readonly<{ type: "RELAY_READY"; version: 2 }>;

export type RelayTerminal =
  | Readonly<{ type: "CONNECT_RESULT"; result: PrimaryConnectResult }>
  | Readonly<{ type: "DERIVE_ADDRESS_RESULT"; result: DeriveAddressSuccess }>
  | Readonly<{ type: "SIGN_RESULT"; result: PrimarySignResult }>
  | Readonly<{
      type: "ERROR";
      error: Readonly<{ code: IframeErrorCode; message: string }>;
    }>;

export type RelayOnboarding = Readonly<{ type: "NEEDS_ONBOARDING" }>;

function copyExactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = []
): ExactRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Plain record expected");
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Plain record expected");
  }

  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  const ownKeys = Reflect.ownKeys(value);
  const ownKeySet = new Set(ownKeys);
  for (const key of ownKeys) {
    if (typeof key !== "string" || FORBIDDEN_RECORD_KEYS.has(key) || !allowedKeys.has(key)) {
      throw new TypeError("Unexpected record key");
    }
  }
  for (const key of requiredKeys) {
    if (!ownKeySet.has(key)) throw new TypeError("Missing record key");
  }

  const copy = Object.create(null) as ExactRecord;
  for (const key of ownKeys) {
    if (typeof key !== "string") throw new TypeError("Unexpected record key");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("Enumerable data properties required");
    }
    copy[key] = descriptor.value;
  }
  return copy;
}

function copyExactArray(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError("Exact array expected");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor)) {
    throw new TypeError("Array length must be a data property");
  }
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
    throw new TypeError("Array item limit exceeded");
  }
  const ownKeys = Reflect.ownKeys(value);
  const keySet = new Set(ownKeys);
  if (ownKeys.length !== length + 1) throw new TypeError("Unexpected array key");

  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!keySet.has(key)) throw new TypeError("Array holes are not allowed");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("Enumerable array data properties required");
    }
    copy.push(descriptor.value);
  }
  return copy;
}

function isUnicodeScalarString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    isUnicodeScalarString(value)
  );
}

function isBoundedId(value: unknown): value is string {
  return isBoundedString(value, 1, MAX_ID_LENGTH);
}

function isSafeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSafeKeyIndex(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_DERIVATION_KEY_INDEX
  );
}

function isHexBytes(
  value: unknown,
  options: { readonly maximumBytes: number; readonly nonEmpty?: boolean }
): value is `0x${string}` {
  if (
    typeof value !== "string" ||
    value.length > options.maximumBytes * 2 + 2 ||
    !/^0x(?:[0-9a-f]{2})*$/u.test(value)
  ) {
    return false;
  }
  const byteLength = (value.length - 2) / 2;
  if (options.nonEmpty && byteLength === 0) return false;
  return byteLength <= options.maximumBytes;
}

function assertEnvelopeIdentity(id: unknown, timestamp: unknown): asserts id is string {
  if (!isBoundedId(id) || !isSafeTimestamp(timestamp)) {
    throw new TypeError("Invalid relay envelope identity");
  }
}

function copySigningContext(value: unknown): SigningContext {
  const context = copyExactRecord(
    value,
    [],
    ["account", "chainId", "chainName", "currentChainId", "averageTransactionValue"]
  );
  if (Object.hasOwn(context, "account") && !isBoundedString(context.account, 1, 128)) {
    throw new TypeError("Invalid signing account");
  }
  if (Object.hasOwn(context, "chainName") && !isBoundedString(context.chainName, 1, 128)) {
    throw new TypeError("Invalid signing chain name");
  }
  for (const key of ["chainId", "currentChainId"] as const) {
    if (
      Object.hasOwn(context, key) &&
      (!Number.isSafeInteger(context[key]) || (context[key] as number) <= 0)
    ) {
      throw new TypeError("Invalid signing chain ID");
    }
  }
  if (
    Object.hasOwn(context, "averageTransactionValue") &&
    (typeof context.averageTransactionValue !== "string" ||
      context.averageTransactionValue.length > MAX_RESTRICTED_JSON_BYTES ||
      !/^(?:0|[1-9][0-9]*)$/u.test(context.averageTransactionValue))
  ) {
    throw new TypeError("Invalid average transaction value");
  }

  return {
    ...(Object.hasOwn(context, "account") ? { account: context.account as string } : {}),
    ...(Object.hasOwn(context, "chainId") ? { chainId: context.chainId as number } : {}),
    ...(Object.hasOwn(context, "chainName") ? { chainName: context.chainName as string } : {}),
    ...(Object.hasOwn(context, "currentChainId")
      ? { currentChainId: context.currentChainId as number }
      : {}),
    ...(Object.hasOwn(context, "averageTransactionValue")
      ? { averageTransactionValue: context.averageTransactionValue as string }
      : {}),
  };
}

interface RestrictedJsonBudget {
  activeContainers: WeakSet<object>;
  canonicalBytes: number;
  nodes: number;
}

type TypedDataArrayLength = number | null;

interface TypedDataTypeReference {
  base: string;
  arrays: readonly TypedDataArrayLength[];
}

interface TypedDataSchema {
  fields: ReadonlyMap<string, ReadonlyMap<string, TypedDataTypeReference | null>>;
}

interface RestrictedJsonSchemaContext {
  schema: TypedDataSchema;
  type: TypedDataTypeReference;
}

function createRestrictedJsonBudget(): RestrictedJsonBudget {
  return { activeContainers: new WeakSet<object>(), canonicalBytes: 0, nodes: 0 };
}

function addCanonicalBytes(budget: RestrictedJsonBudget, bytes: number): void {
  if (bytes > MAX_RESTRICTED_JSON_BYTES - budget.canonicalBytes) {
    throw new TypeError("Canonical JSON byte limit exceeded");
  }
  budget.canonicalBytes += bytes;
}

function measureCanonicalStringBytes(value: string, budget: RestrictedJsonBudget): void {
  if (value.length > MAX_RESTRICTED_JSON_BYTES) {
    throw new TypeError("Canonical JSON byte limit exceeded");
  }

  addCanonicalBytes(budget, 2);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      addCanonicalBytes(budget, 2);
    } else if (code <= 0x1f) {
      addCanonicalBytes(
        budget,
        code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6
      );
    } else if (code <= 0x7f) {
      addCanonicalBytes(budget, 1);
    } else if (code <= 0x7ff) {
      addCanonicalBytes(budget, 2);
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("Invalid JSON string");
      }
      addCanonicalBytes(budget, 4);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("Invalid JSON string");
    } else {
      addCanonicalBytes(budget, 3);
    }
  }
}

function parseTypedDataType(value: string): TypedDataTypeReference | null {
  const firstArray = value.indexOf("[");
  const base = firstArray === -1 ? value : value.slice(0, firstArray);
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(base)) return null;

  const arrays: TypedDataArrayLength[] = [];
  let cursor = firstArray === -1 ? value.length : firstArray;
  while (cursor < value.length) {
    if (value[cursor] !== "[") return null;
    const close = value.indexOf("]", cursor + 1);
    if (close === -1) return null;
    const length = value.slice(cursor + 1, close);
    if (length === "") {
      arrays.push(null);
    } else {
      if (!/^[1-9][0-9]*$/u.test(length)) return null;
      const parsed = Number(length);
      if (!Number.isSafeInteger(parsed) || parsed > MAX_RESTRICTED_ARRAY_ITEMS) return null;
      arrays.push(parsed);
    }
    cursor = close + 1;
  }

  return { base, arrays };
}

function integerRange(type: string): { minimum: bigint; maximum: bigint } | null {
  const match = /^(u?int)([0-9]*)$/u.exec(type);
  if (match === null) return null;
  const widthText = match[2] as string;
  if (widthText.length > 1 && widthText[0] === "0") return null;
  const width = widthText === "" ? 256 : Number(widthText);
  if (!Number.isSafeInteger(width) || width < 8 || width > 256 || width % 8 !== 0) return null;

  if (match[1] === "uint") {
    return { minimum: 0n, maximum: (1n << BigInt(width)) - 1n };
  }
  const boundary = 1n << BigInt(width - 1);
  return { minimum: -boundary, maximum: boundary - 1n };
}

function childSchemaContext(
  context: RestrictedJsonSchemaContext | undefined,
  key: string | number
): RestrictedJsonSchemaContext | undefined {
  if (context === undefined) return undefined;
  const arrays = context.type.arrays;
  if (arrays.length > 0) {
    if (typeof key !== "number") return undefined;
    return {
      schema: context.schema,
      type: { base: context.type.base, arrays: arrays.slice(0, -1) },
    };
  }
  if (typeof key !== "string") return undefined;
  const field = context.schema.fields.get(context.type.base)?.get(key);
  return field === undefined || field === null
    ? undefined
    : { schema: context.schema, type: field };
}

function copyTypedDataBigInt(
  value: bigint,
  budget: RestrictedJsonBudget,
  context: RestrictedJsonSchemaContext | undefined
): string {
  if (context === undefined || context.type.arrays.length !== 0) {
    throw new TypeError("Restricted JSON value required");
  }
  const range = integerRange(context.type.base);
  if (range === null || value < range.minimum || value > range.maximum) {
    throw new TypeError("Invalid typed-data integer");
  }
  const normalized = value.toString(10);
  measureCanonicalStringBytes(normalized, budget);
  return normalized;
}

function copyRestrictedJson(
  value: unknown,
  budget: RestrictedJsonBudget,
  depth = 0,
  schemaContext?: RestrictedJsonSchemaContext
): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_RESTRICTED_JSON_NODES) {
    throw new TypeError("Restricted JSON limit exceeded");
  }
  if (value === null) {
    addCanonicalBytes(budget, 4);
    return value;
  }
  if (typeof value === "boolean") {
    addCanonicalBytes(budget, value ? 4 : 5);
    return value;
  }
  if (typeof value === "string") {
    measureCanonicalStringBytes(value, budget);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("Safe JSON integer required");
    addCanonicalBytes(budget, String(value).length);
    return value;
  }
  if (typeof value === "bigint") {
    return copyTypedDataBigInt(value, budget, schemaContext);
  }
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Restricted JSON value required");
  }
  if (depth >= MAX_RESTRICTED_JSON_DEPTH) {
    throw new TypeError("Restricted JSON limit exceeded");
  }
  if (budget.activeContainers.has(value)) {
    throw new TypeError("Cyclic JSON values are not allowed");
  }
  budget.activeContainers.add(value);

  try {
    if (Array.isArray(value)) {
      const array = copyExactArray(value, MAX_RESTRICTED_ARRAY_ITEMS);
      const expectedLength = schemaContext?.type.arrays.at(-1);
      if (
        expectedLength !== undefined &&
        expectedLength !== null &&
        array.length !== expectedLength
      ) {
        throw new TypeError("Invalid typed-data fixed array length");
      }
      addCanonicalBytes(budget, 2 + Math.max(0, array.length - 1));
      return array.map((item, index) =>
        copyRestrictedJson(item, budget, depth + 1, childSchemaContext(schemaContext, index))
      );
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Plain JSON record required");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_RESTRICTED_RECORD_KEYS) {
      throw new TypeError("Restricted JSON key limit exceeded");
    }
    addCanonicalBytes(budget, 2 + Math.max(0, keys.length - 1) + keys.length);
    const entries: [string, unknown][] = [];
    for (const key of keys) {
      if (typeof key !== "string" || key === "toJSON" || FORBIDDEN_RECORD_KEYS.has(key)) {
        throw new TypeError("Invalid JSON record key");
      }
      measureCanonicalStringBytes(key, budget);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("Enumerable JSON data properties required");
      }
      entries.push([key, descriptor.value]);
    }

    const copy: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
      copy[key] = copyRestrictedJson(
        entryValue,
        budget,
        depth + 1,
        childSchemaContext(schemaContext, key)
      );
    }
    return copy;
  } finally {
    budget.activeContainers.delete(value);
  }
}

function copyTypedDataTypes(value: unknown): {
  schema: TypedDataSchema;
  types: Record<string, unknown>;
} {
  const copied = copyRestrictedJson(value, createRestrictedJsonBudget());
  if (copied === null || typeof copied !== "object" || Array.isArray(copied)) {
    throw new TypeError("Typed-data types record required");
  }

  const schemaFields = new Map<string, ReadonlyMap<string, TypedDataTypeReference | null>>();
  for (const [typeName, fields] of Object.entries(copied)) {
    if (!Array.isArray(fields) || fields.length === 0 || fields.length > 256) {
      throw new TypeError("Invalid typed-data fields");
    }
    const parsedFields = new Map<string, TypedDataTypeReference | null>();
    for (const field of fields) {
      const parsed = copyExactRecord(field, ["name", "type"]);
      if (!isBoundedString(parsed.name, 1, 128) || !isBoundedString(parsed.type, 1, 128)) {
        throw new TypeError("Invalid typed-data field");
      }
      const name = parsed.name;
      parsedFields.set(
        name,
        parsedFields.has(name) ? null : parseTypedDataType(parsed.type as string)
      );
    }
    schemaFields.set(typeName, parsedFields);
  }

  return { schema: { fields: schemaFields }, types: copied as Record<string, unknown> };
}

const STANDARD_DOMAIN_FIELD_TYPES = Object.freeze({
  name: "string",
  version: "string",
  chainId: "uint256",
  verifyingContract: "address",
  salt: "bytes32",
} as const);

function inferredDomainFields(value: unknown): readonly { name: string; type: string }[] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;

  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_RESTRICTED_RECORD_KEYS) {
    throw new TypeError("Restricted JSON key limit exceeded");
  }
  for (const key of keys) {
    if (typeof key !== "string" || key === "toJSON" || FORBIDDEN_RECORD_KEYS.has(key)) {
      throw new TypeError("Invalid JSON record key");
    }
  }
  const keySet = new Set(keys);
  const dataDescriptor = (key: string): PropertyDescriptor | undefined => {
    if (!keySet.has(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && "value" in descriptor ? descriptor : undefined;
  };

  const chainId = dataDescriptor("chainId");
  if (chainId === undefined || typeof chainId.value !== "bigint") {
    return null;
  }

  const fields: { name: string; type: string }[] = [];
  const name = dataDescriptor("name");
  if (name !== undefined && typeof name.value === "string") {
    fields.push({ name: "name", type: STANDARD_DOMAIN_FIELD_TYPES.name });
  }
  const version = dataDescriptor("version");
  if (version !== undefined && Boolean(version.value)) {
    fields.push({ name: "version", type: STANDARD_DOMAIN_FIELD_TYPES.version });
  }
  fields.push({ name: "chainId", type: STANDARD_DOMAIN_FIELD_TYPES.chainId });
  const verifyingContract = dataDescriptor("verifyingContract");
  if (verifyingContract !== undefined && Boolean(verifyingContract.value)) {
    fields.push({
      name: "verifyingContract",
      type: STANDARD_DOMAIN_FIELD_TYPES.verifyingContract,
    });
  }
  const salt = dataDescriptor("salt");
  if (salt !== undefined && Boolean(salt.value)) {
    fields.push({ name: "salt", type: STANDARD_DOMAIN_FIELD_TYPES.salt });
  }
  return fields;
}

function withInferredDomainSchema(
  value: unknown,
  copiedTypes: Record<string, unknown>,
  schema: TypedDataSchema
): { schema: TypedDataSchema; types: Record<string, unknown> } {
  if (Object.hasOwn(copiedTypes, "EIP712Domain")) return { schema, types: copiedTypes };
  const fields = inferredDomainFields(value);
  if (fields === null) return { schema, types: copiedTypes };

  const domainFields = new Map<string, TypedDataTypeReference>();
  for (const field of fields) {
    const parsed = parseTypedDataType(field.type);
    if (parsed === null) throw new TypeError("Invalid inferred domain field");
    domainFields.set(field.name, parsed);
  }
  const nextSchema = new Map(schema.fields);
  nextSchema.set("EIP712Domain", domainFields);
  return {
    schema: { fields: nextSchema },
    types: { EIP712Domain: fields, ...copiedTypes },
  };
}

function assertCeremonyEnvelopeBudget(
  operation: "CONNECT_DERIVATION" | "DERIVE_ADDRESS" | "SIGN_DERIVATION",
  payload: unknown
): void {
  const envelope = {
    version: 2,
    sessionId: "A".repeat(CEREMONY_RANDOM_ID_LENGTH),
    requestId: "B".repeat(CEREMONY_RANDOM_ID_LENGTH),
    nonce: "C".repeat(CEREMONY_RANDOM_ID_LENGTH),
    createdAt: Number.MAX_SAFE_INTEGER,
    expiresAt: Number.MAX_SAFE_INTEGER,
    requestingOrigin: "x".repeat(CEREMONY_PARENT_ORIGIN_RESERVE_LENGTH),
    operation,
    payload,
  };
  copyRestrictedJson(envelope, createRestrictedJsonBudget());
}

function attachContext(
  target: Record<string, unknown>,
  source: ExactRecord
): Record<string, unknown> {
  if (Object.hasOwn(source, "context")) target.context = copySigningContext(source.context);
  return target;
}

function copySigningRequest(value: unknown): EvmSigningRequest | SolanaRawSigningRequest {
  const candidate = copyExactRecord(
    value,
    ["kind"],
    ["serializedTransaction", "context", "message", "typedData", "payload"]
  );
  let request: Record<string, unknown>;

  if (candidate.kind === "transaction") {
    const source = copyExactRecord(value, ["kind", "serializedTransaction"], ["context"]);
    if (
      !isHexBytes(source.serializedTransaction, {
        maximumBytes: MAX_VARIABLE_HEX_BYTES,
        nonEmpty: true,
      })
    ) {
      throw new TypeError("Invalid serialized transaction");
    }
    request = attachContext(
      { kind: "transaction", serializedTransaction: source.serializedTransaction },
      source
    );
  } else if (candidate.kind === "message") {
    const source = copyExactRecord(value, ["kind", "message"], ["context"]);
    const message = copyExactRecord(source.message, ["type", "value"]);
    if (message.type === "text") {
      if (!isBoundedString(message.value, 0, MAX_TEXT_MESSAGE_LENGTH)) {
        throw new TypeError("Invalid text signing message");
      }
    } else if (
      message.type !== "raw" ||
      !isHexBytes(message.value, { maximumBytes: MAX_VARIABLE_HEX_BYTES, nonEmpty: true })
    ) {
      throw new TypeError("Invalid raw signing message");
    }
    request = attachContext(
      { kind: "message", message: { type: message.type, value: message.value } },
      source
    );
  } else if (candidate.kind === "typedData") {
    const source = copyExactRecord(value, ["kind", "typedData"], ["context"]);
    const typedData = copyExactRecord(source.typedData, [
      "domain",
      "types",
      "primaryType",
      "message",
    ]);
    if (!isBoundedString(typedData.primaryType, 1, 128)) {
      throw new TypeError("Invalid typed-data primary type");
    }
    const copiedTypes = copyTypedDataTypes(typedData.types);
    const typedDataSchema = withInferredDomainSchema(
      typedData.domain,
      copiedTypes.types,
      copiedTypes.schema
    );
    const domain = copyRestrictedJson(typedData.domain, createRestrictedJsonBudget(), 0, {
      schema: typedDataSchema.schema,
      type: { base: "EIP712Domain", arrays: [] },
    });
    const message = copyRestrictedJson(typedData.message, createRestrictedJsonBudget(), 0, {
      schema: typedDataSchema.schema,
      type: { base: typedData.primaryType, arrays: [] },
    });
    const types = typedDataSchema.types;
    if (
      domain === null ||
      message === null ||
      types === null ||
      typeof domain !== "object" ||
      typeof message !== "object" ||
      typeof types !== "object" ||
      Array.isArray(domain) ||
      Array.isArray(message) ||
      Array.isArray(types)
    ) {
      throw new TypeError("Typed-data records required");
    }
    request = attachContext(
      {
        kind: "typedData",
        typedData: { domain, types, primaryType: typedData.primaryType, message },
      },
      source
    );
  } else if (candidate.kind === "raw") {
    const source = copyExactRecord(value, ["kind", "payload"], ["context"]);
    if (
      !isHexBytes(source.payload, {
        maximumBytes: MAX_VARIABLE_HEX_BYTES,
        nonEmpty: true,
      })
    ) {
      throw new TypeError("Invalid raw signing payload");
    }
    request = attachContext({ kind: "raw", payload: source.payload }, source);
  } else {
    throw new TypeError("Unsupported signing request");
  }

  return request as EvmSigningRequest | SolanaRawSigningRequest;
}

function copyDeriveOptions(value: unknown): DeriveAddressOptions {
  const source = copyExactRecord(
    value,
    ["keyIndex"],
    ["curve", "group", "bitcoinAddressType", "bitcoinNetwork"]
  );
  if (!isSafeKeyIndex(source.keyIndex)) throw new TypeError("Invalid derivation key index");

  const hasGroup = Object.hasOwn(source, "group");
  const hasCurve = Object.hasOwn(source, "curve");
  if (
    (hasGroup &&
      source.group !== "evm" &&
      source.group !== "solana" &&
      source.group !== "bitcoin") ||
    (hasCurve && source.curve !== "secp256k1" && source.curve !== "ed25519")
  ) {
    throw new TypeError("Invalid derivation group or curve");
  }
  const group = hasGroup ? source.group : "evm";
  const curve = hasCurve ? source.curve : group === "solana" ? "ed25519" : "secp256k1";
  if (
    (group === "evm" && curve !== "secp256k1") ||
    (group === "solana" && curve !== "ed25519") ||
    (group === "bitcoin" && curve !== "secp256k1")
  ) {
    throw new TypeError("Incompatible derivation group and curve");
  }

  const hasBitcoinAddressType = Object.hasOwn(source, "bitcoinAddressType");
  const hasBitcoinNetwork = Object.hasOwn(source, "bitcoinNetwork");
  if (group === "bitcoin") {
    if (
      !hasBitcoinAddressType ||
      !hasBitcoinNetwork ||
      (source.bitcoinAddressType !== "p2wpkh" && source.bitcoinAddressType !== "p2tr") ||
      (source.bitcoinNetwork !== "mainnet" && source.bitcoinNetwork !== "testnet4")
    ) {
      throw new TypeError("Bitcoin derivation metadata required");
    }
  } else if (hasBitcoinAddressType || hasBitcoinNetwork) {
    throw new TypeError("Bitcoin metadata is not allowed for this group");
  }

  return {
    keyIndex: source.keyIndex,
    ...(hasCurve ? { curve: source.curve as "secp256k1" | "ed25519" } : {}),
    ...(hasGroup ? { group: source.group as "evm" | "solana" | "bitcoin" } : {}),
    ...(hasBitcoinAddressType
      ? { bitcoinAddressType: source.bitcoinAddressType as "p2wpkh" | "p2tr" }
      : {}),
    ...(hasBitcoinNetwork
      ? { bitcoinNetwork: source.bitcoinNetwork as "mainnet" | "testnet4" }
      : {}),
  };
}

function copySignOptions(
  value: unknown,
  request: EvmSigningRequest | SolanaRawSigningRequest
): EvmSignOptions | SolanaSignOptions {
  const candidate = copyExactRecord(value, [], ["address", "group", "keyIndex"]);
  if (request.kind === "raw") {
    const source = copyExactRecord(value, ["group", "keyIndex"]);
    if (source.group !== "solana" || !isSafeKeyIndex(source.keyIndex)) {
      throw new TypeError("Raw signing requires a Solana selector");
    }
    return { group: "solana", keyIndex: source.keyIndex };
  }

  if (Object.hasOwn(candidate, "address")) {
    const source = copyExactRecord(value, ["address"]);
    if (!isBoundedString(source.address, 1, MAX_ADDRESS_LENGTH)) {
      throw new TypeError("Invalid signing address");
    }
    return { address: source.address };
  }

  const source = copyExactRecord(value, ["group", "keyIndex"]);
  if (source.group !== "evm" || !isSafeKeyIndex(source.keyIndex)) {
    throw new TypeError("Structured signing requires an EVM selector");
  }
  return { group: "evm", keyIndex: source.keyIndex };
}

function effectiveDeriveSelector(options: DeriveAddressOptions): ActiveDeriveSelector {
  const group = options.group ?? "evm";
  const curve = options.curve ?? (group === "solana" ? "ed25519" : "secp256k1");
  return {
    keyIndex: options.keyIndex,
    group,
    curve,
    ...(options.bitcoinAddressType === undefined
      ? {}
      : { bitcoinAddressType: options.bitcoinAddressType }),
    ...(options.bitcoinNetwork === undefined ? {} : { bitcoinNetwork: options.bitcoinNetwork }),
  };
}

function copyActiveDeriveSelector(value: unknown): ActiveDeriveSelector {
  copyExactRecord(value, ["keyIndex", "curve", "group"], ["bitcoinAddressType", "bitcoinNetwork"]);
  return effectiveDeriveSelector(copyDeriveOptions(value));
}

function copyActiveSignSelector(value: unknown): ActiveSignSelector {
  const candidate = copyExactRecord(value, [], ["address", "group", "keyIndex"]);
  if (Object.hasOwn(candidate, "address")) {
    const source = copyExactRecord(value, ["address"]);
    if (!isBoundedString(source.address, 1, MAX_ADDRESS_LENGTH)) {
      throw new TypeError("Invalid active signing address");
    }
    return { address: source.address };
  }

  const source = copyExactRecord(value, ["group", "keyIndex"]);
  if ((source.group !== "evm" && source.group !== "solana") || !isSafeKeyIndex(source.keyIndex)) {
    throw new TypeError("Invalid active signing key selector");
  }
  return { group: source.group, keyIndex: source.keyIndex };
}

function sameEvmAddress(left: string, right: string): boolean {
  const isEvmAddress = (value: string) => /^0x[0-9a-fA-F]{40}$/u.test(value);
  return isEvmAddress(left) && isEvmAddress(right)
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isActiveAddressSelector(
  selector: ActiveSignSelector
): selector is Readonly<{ address: string }> {
  return Object.hasOwn(selector, "address");
}

function matchesDeriveSelector(
  address: DerivationAddressInfo,
  selector: ActiveDeriveSelector
): boolean {
  return (
    address.keyIndex === selector.keyIndex &&
    address.curve === selector.curve &&
    address.group === selector.group &&
    address.bitcoinAddressType === selector.bitcoinAddressType &&
    address.bitcoinNetwork === selector.bitcoinNetwork
  );
}

function parseAddress(value: unknown, primaryEvmOnly: boolean): DerivationAddressInfo | null {
  try {
    const source = copyExactRecord(
      value,
      ["address", "keyIndex", "curve", "group"],
      ["bitcoinAddressType", "bitcoinNetwork"]
    );
    if (
      !isBoundedString(source.address, 1, MAX_ADDRESS_LENGTH) ||
      !isSafeKeyIndex(source.keyIndex) ||
      (source.curve !== "secp256k1" && source.curve !== "ed25519") ||
      (source.group !== "evm" && source.group !== "solana" && source.group !== "bitcoin")
    ) {
      return null;
    }
    if (primaryEvmOnly && (source.group !== "evm" || source.curve !== "secp256k1")) {
      return null;
    }

    const hasBitcoinAddressType = Object.hasOwn(source, "bitcoinAddressType");
    const hasBitcoinNetwork = Object.hasOwn(source, "bitcoinNetwork");
    if (source.group === "bitcoin") {
      if (
        source.curve !== "secp256k1" ||
        !hasBitcoinAddressType ||
        !hasBitcoinNetwork ||
        (source.bitcoinAddressType !== "p2wpkh" && source.bitcoinAddressType !== "p2tr") ||
        (source.bitcoinNetwork !== "mainnet" && source.bitcoinNetwork !== "testnet4")
      ) {
        return null;
      }
    } else if (
      hasBitcoinAddressType ||
      hasBitcoinNetwork ||
      (source.group === "evm" && source.curve !== "secp256k1") ||
      (source.group === "solana" && source.curve !== "ed25519")
    ) {
      return null;
    }

    return {
      address: source.address,
      keyIndex: source.keyIndex,
      curve: source.curve,
      group: source.group,
      ...(hasBitcoinAddressType
        ? { bitcoinAddressType: source.bitcoinAddressType as "p2wpkh" | "p2tr" }
        : {}),
      ...(hasBitcoinNetwork
        ? { bitcoinNetwork: source.bitcoinNetwork as "mainnet" | "testnet4" }
        : {}),
    };
  } catch {
    return null;
  }
}

function parseActive(value: unknown): ActiveProtocolRequest | null {
  try {
    const source = copyExactRecord(value, ["version", "id", "operation"], ["selector"]);
    if (
      source.version !== 2 ||
      !isBoundedId(source.id) ||
      (source.operation !== "CONNECT" &&
        source.operation !== "DERIVE_ADDRESS" &&
        source.operation !== "SIGN_WITH_DERIVATION")
    ) {
      return null;
    }
    if (source.operation === "CONNECT") {
      return Object.hasOwn(source, "selector")
        ? null
        : { version: 2, id: source.id, operation: "CONNECT" };
    }
    if (!Object.hasOwn(source, "selector")) return null;
    if (source.operation === "DERIVE_ADDRESS") {
      return {
        version: 2,
        id: source.id,
        operation: "DERIVE_ADDRESS",
        selector: copyActiveDeriveSelector(source.selector),
      };
    }
    return {
      version: 2,
      id: source.id,
      operation: "SIGN_WITH_DERIVATION",
      selector: copyActiveSignSelector(source.selector),
    };
  } catch {
    return null;
  }
}

function parseEnvelope(value: unknown): ExactRecord | null {
  try {
    const envelope = copyExactRecord(value, ["type", "id", "payload", "timestamp"]);
    if (
      typeof envelope.type !== "string" ||
      !isBoundedId(envelope.id) ||
      !isSafeTimestamp(envelope.timestamp)
    ) {
      return null;
    }
    return envelope;
  } catch {
    return null;
  }
}

function parseSuccessPayload(envelope: ExactRecord, active: ActiveProtocolRequest): unknown | null {
  try {
    const payload = copyExactRecord(envelope.payload, ["requestId", "data"]);
    if (
      !isBoundedId(payload.requestId) ||
      envelope.id !== payload.requestId ||
      payload.requestId !== active.id
    ) {
      return null;
    }
    return payload.data;
  } catch {
    return null;
  }
}

export function buildRelayInit(): Readonly<{ type: "RELAY_INIT"; version: 2 }> {
  return { type: "RELAY_INIT", version: 2 };
}

export function buildConnect(id: string, timestamp: number): ParentRequest {
  assertEnvelopeIdentity(id, timestamp);
  const payload = {};
  assertCeremonyEnvelopeBudget("CONNECT_DERIVATION", payload);
  return { type: "CONNECT", id, payload, timestamp };
}

export function buildDeriveAddress(
  id: string,
  options: DeriveAddressOptions,
  timestamp: number
): ParentRequest {
  assertEnvelopeIdentity(id, timestamp);
  const payload = copyDeriveOptions(options);
  assertCeremonyEnvelopeBudget("DERIVE_ADDRESS", payload);
  return { type: "DERIVE_ADDRESS", id, payload, timestamp };
}

export function buildSign(
  id: string,
  request: EvmSigningRequest,
  options: EvmSignOptions,
  timestamp: number
): ParentRequest;
export function buildSign(
  id: string,
  request: SolanaRawSigningRequest,
  options: SolanaSignOptions,
  timestamp: number
): ParentRequest;
export function buildSign(
  id: string,
  request: EvmSigningRequest | SolanaRawSigningRequest,
  options: EvmSignOptions | SolanaSignOptions,
  timestamp: number
): ParentRequest {
  assertEnvelopeIdentity(id, timestamp);
  const safeRequest = copySigningRequest(request);
  const safeOptions = copySignOptions(options, safeRequest);
  const payload = { request: safeRequest, ...safeOptions };
  assertCeremonyEnvelopeBudget("SIGN_DERIVATION", payload);
  return {
    type: "SIGN_WITH_DERIVATION",
    id,
    payload,
    timestamp,
  };
}

export function buildCancel(requestId: string, id: string, timestamp: number): ParentRequest {
  assertEnvelopeIdentity(requestId, timestamp);
  assertEnvelopeIdentity(id, timestamp);
  return { type: "CANCEL", id, payload: { requestId }, timestamp };
}

export function buildDestroy(id: string, timestamp: number): ParentRequest {
  assertEnvelopeIdentity(id, timestamp);
  return { type: "DESTROY", id, payload: { reason: "Host destroyed" }, timestamp };
}

export function bindActiveRequest(message: ParentRequest): ActiveProtocolRequest {
  if (message.type === "CONNECT") {
    return { version: 2, id: message.id, operation: "CONNECT" };
  }
  if (message.type === "DERIVE_ADDRESS") {
    return {
      version: 2,
      id: message.id,
      operation: "DERIVE_ADDRESS",
      selector: effectiveDeriveSelector(message.payload),
    };
  }
  if (message.type === "SIGN_WITH_DERIVATION") {
    const selector = Object.hasOwn(message.payload, "address")
      ? copyActiveSignSelector({ address: message.payload.address })
      : copyActiveSignSelector({
          group: message.payload.group,
          keyIndex: message.payload.keyIndex,
        });
    return {
      version: 2,
      id: message.id,
      operation: "SIGN_WITH_DERIVATION",
      selector,
    };
  }
  throw new TypeError("Control messages cannot bind an active operation");
}

export function parseRelayReady(value: unknown): RelayReadyV2 | null {
  try {
    const ready = copyExactRecord(value, ["type", "version"]);
    return ready.type === "RELAY_READY" && ready.version === 2
      ? { type: "RELAY_READY", version: 2 }
      : null;
  } catch {
    return null;
  }
}

export function parseRelayOnboarding(
  value: unknown,
  activeValue: ActiveProtocolRequest
): RelayOnboarding | null {
  const active = parseActive(activeValue);
  const envelope = parseEnvelope(value);
  if (!active || active.operation !== "CONNECT" || envelope?.type !== "NEEDS_ONBOARDING") {
    return null;
  }
  try {
    const payload = copyExactRecord(envelope.payload, ["requestId", "signerType"]);
    if (
      payload.signerType !== "derivation" ||
      !isBoundedId(payload.requestId) ||
      envelope.id !== payload.requestId ||
      payload.requestId !== active.id
    ) {
      return null;
    }
    return { type: "NEEDS_ONBOARDING" };
  } catch {
    return null;
  }
}

export function parseTerminal(
  value: unknown,
  activeValue: ActiveProtocolRequest
): RelayTerminal | null {
  const active = parseActive(activeValue);
  const envelope = parseEnvelope(value);
  if (!active || !envelope) return null;

  if (envelope.type === "ERROR") {
    try {
      const payload = copyExactRecord(envelope.payload, ["requestId", "code", "message"]);
      if (
        !isBoundedId(payload.requestId) ||
        envelope.id !== payload.requestId ||
        payload.requestId !== active.id ||
        typeof payload.code !== "string" ||
        !IFRAME_ERROR_CODES.has(payload.code as IframeErrorCode) ||
        !isBoundedString(payload.message, 1, MAX_ERROR_MESSAGE_LENGTH)
      ) {
        return null;
      }
      return {
        type: "ERROR",
        error: { code: payload.code as IframeErrorCode, message: payload.message },
      };
    } catch {
      return null;
    }
  }

  const expectedType =
    active.operation === "CONNECT"
      ? "CONNECT_RESULT"
      : active.operation === "DERIVE_ADDRESS"
        ? "DERIVE_ADDRESS_RESULT"
        : "SIGN_RESULT";
  if (envelope.type !== expectedType) return null;
  const dataValue = parseSuccessPayload(envelope, active);
  if (dataValue === null) return null;

  try {
    if (active.operation === "CONNECT") {
      const data = copyExactRecord(dataValue, ["address"]);
      const address = parseAddress(data.address, true);
      return address ? { type: "CONNECT_RESULT", result: { address } } : null;
    }

    if (active.operation === "DERIVE_ADDRESS") {
      const data = copyExactRecord(dataValue, ["success", "address"]);
      if (data.success !== true) return null;
      const address = parseAddress(data.address, false);
      return address && matchesDeriveSelector(address, active.selector)
        ? { type: "DERIVE_ADDRESS_RESULT", result: { success: true, address } }
        : null;
    }

    const data = copyExactRecord(dataValue, ["address", "signature"]);
    if (
      !isBoundedString(data.address, 1, MAX_ADDRESS_LENGTH) ||
      !isHexBytes(data.signature, { maximumBytes: MAX_SIGNATURE_BYTES, nonEmpty: true })
    ) {
      return null;
    }
    if (
      isActiveAddressSelector(active.selector) &&
      !sameEvmAddress(active.selector.address, data.address)
    ) {
      return null;
    }
    return {
      type: "SIGN_RESULT",
      result: { address: data.address, signature: data.signature },
    };
  } catch {
    return null;
  }
}

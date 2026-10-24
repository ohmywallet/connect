import { getAddress, isAddress, zeroAddress } from "viem";
import { AppProviderRpcError } from "./app-types";

export const APP_CHAIN_IDS = Object.freeze([
  1, 137, 8453, 42161, 56, 5042, 43114, 11155111, 84532, 5042002,
] as const);
export const APP_METHODS = Object.freeze([
  "personal_sign",
  "eth_signTypedData_v4",
  "eth_sendTransaction",
] as const);
export const APP_EVENTS = Object.freeze(["accountsChanged", "chainChanged"]);
export interface AppProtocolSession {
  sessionProperties?: Record<string, string>;
  topic: string;
  pairingTopic: string;
  expiry: number;
  namespaces: Record<
    string,
    { accounts: string[]; methods: string[]; events: string[]; chains?: string[] }
  >;
}
export type AppProtocolEvent =
  "session_delete" | "session_expire" | "session_update" | "session_event";
export interface AppSignClient {
  connect(params: {
    requiredNamespaces: { eip155: { chains: string[]; methods: string[]; events: string[] } };
    sessionProperties?: Record<string, string>;
  }): Promise<{ uri?: string; approval(): Promise<AppProtocolSession> }>;
  request(params: {
    topic: string;
    chainId: string;
    request: { method: string; params: unknown[] };
    expiry: number;
  }): Promise<unknown>;
  disconnect(params: { topic: string; reason: { code: number; message: string } }): Promise<void>;
  session: { get(topic: string): AppProtocolSession };
  on(event: AppProtocolEvent, callback: (payload: unknown) => void): void;
  off(event: AppProtocolEvent, callback: (payload: unknown) => void): void;
  disconnectPairing(topic: string): Promise<void>;
  close(): Promise<void>;
}
export function fail(code: number, message: string): never {
  throw new AppProviderRpcError(code, message);
}
const topicPattern = /^[a-f0-9]{64}$/u;
function exactSet(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    new Set(value).size === value.length &&
    expected.every((item) => value.includes(item))
  );
}
/** A WalletConnect namespace is session authority, never evidence of passkey ownership. */
export function sessionAccount(session: AppProtocolSession, chainId: number, now: number): string {
  if (
    !session ||
    !topicPattern.test(session.topic) ||
    !topicPattern.test(session.pairingTopic) ||
    !Number.isSafeInteger(session.expiry) ||
    session.expiry * 1000 <= now ||
    !session.namespaces ||
    typeof session.namespaces !== "object"
  )
    fail(4100, "Invalid wallet session");
  const entries = Object.entries(session.namespaces);
  if (entries.length !== 1) fail(4100, "Wallet session scope changed");
  const [key, ns] = entries[0]!;
  if (
    !ns ||
    (key !== "eip155" && key !== `eip155:${chainId}`) ||
    !Array.isArray(ns.accounts) ||
    ns.accounts.length !== 1 ||
    !exactSet(ns.methods, APP_METHODS) ||
    !exactSet(ns.events, APP_EVENTS) ||
    (ns.chains !== undefined && !exactSet(ns.chains, [`eip155:${chainId}`]))
  )
    fail(4100, "Wallet session scope changed");
  const parts = typeof ns.accounts[0] === "string" ? ns.accounts[0].split(":") : [];
  if (
    parts.length !== 3 ||
    `${parts[0]}:${parts[1]}` !== `eip155:${chainId}` ||
    !isAddress(parts[2]!) ||
    parts[2]!.toLowerCase() === zeroAddress
  )
    fail(4100, "Invalid wallet account");
  return getAddress(parts[2]!);
}
/** Same narrow v2 handoff grammar as App. URI/key material stays only in memory. */
export function pairingInfo(
  value: unknown,
  now: number
): { uri: string; topic: string; expiresAt: number } {
  if (typeof value !== "string" || value.length > 2048 || /[\s\x00-\x1f\x7f#]/u.test(value))
    fail(-32603, "Invalid wallet pairing");
  const match = /^wc:([a-f0-9]{64})@2\?(.+)$/iu.exec(value);
  if (!match) fail(-32603, "Invalid wallet pairing");
  const params = new URLSearchParams(match[2]);
  const allowed = new Set(["symKey", "relay-protocol", "relay-data", "expiryTimestamp", "methods"]);
  for (const key of params.keys())
    if (!allowed.has(key) || params.getAll(key).length !== 1)
      fail(-32603, "Invalid wallet pairing");
  if (
    !/^[a-f0-9]{64}$/iu.test(params.get("symKey") ?? "") ||
    params.get("relay-protocol") !== "irn"
  )
    fail(-32603, "Invalid wallet pairing");
  const relayData = params.get("relay-data");
  if (relayData !== null && !/^(?:[a-f0-9]{2}){0,256}$/iu.test(relayData))
    fail(-32603, "Invalid wallet pairing");
  const methods = params.get("methods");
  if (
    methods !== null &&
    (!/^\[wc_[a-zA-Z]+(?:,wc_[a-zA-Z]+)*\](?:,\[wc_[a-zA-Z]+(?:,wc_[a-zA-Z]+)*\])*$/u.test(
      methods
    ) ||
      !/(?:\[|,)wc_sessionPropose(?:,|\])/u.test(methods))
  )
    fail(-32603, "Invalid wallet pairing");
  const expiry = params.get("expiryTimestamp");
  if (
    expiry !== null &&
    (!/^[1-9][0-9]{0,12}$/u.test(expiry) ||
      !Number.isSafeInteger(Number(expiry)) ||
      Number(expiry) * 1000 <= now)
  )
    fail(-32603, "Expired wallet pairing");
  return {
    uri: value,
    topic: match[1]!.toLowerCase(),
    expiresAt: Math.min(now + 300_000, expiry === null ? Infinity : Number(expiry) * 1000),
  };
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(-32602, "Invalid parameters");
  return value as Record<string, unknown>;
}
export function sameAddress(value: unknown, expected: string): boolean {
  return (
    typeof value === "string" && isAddress(value) && value.toLowerCase() === expected.toLowerCase()
  );
}
export function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/iu.test(value))
    fail(-32602, "Invalid quantity");
  return BigInt(value);
}
export function rpcError(error: unknown): AppProviderRpcError {
  if (error instanceof AppProviderRpcError) return error;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return code === 4001 || code === 5000 || code === 5001
    ? new AppProviderRpcError(4001, "Request rejected in wallet")
    : new AppProviderRpcError(-32603, "Wallet request failed");
}

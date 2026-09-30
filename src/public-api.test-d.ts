import {
  IframeHost,
  type ConnectResult,
  type DerivationConnectResult,
  type EvmSigningRequest,
  type EvmSignOptions,
  type SolanaRawSigningRequest,
  type SolanaSignOptions,
} from "./index";

// @ts-expect-error Direct PassKey details are not part of the Derivation-only API.
import type { PasskeyInfo } from "./index";
// @ts-expect-error A signer-choice union would advertise unsupported signers.
import type { SignerType } from "./index";
// @ts-expect-error RIP-7212 capability data is unrelated to the Derivation-only API.
import { RIP7212_NATIVE_CHAINS } from "./index";
// @ts-expect-error RIP-7212 capability helpers are unrelated to the Derivation-only API.
import { supportsRIP7212 } from "./index";
// @ts-expect-error Raw iframe message types are package-internal protocol details.
import type { IframeMessage } from "./index";
// @ts-expect-error Raw iframe message discriminators are package-internal protocol details.
import type { IframeMessageType } from "./index";
// @ts-expect-error Raw connect payloads are package-internal protocol details.
import type { ConnectPayload } from "./index";
// @ts-expect-error Raw signing payloads are package-internal protocol details.
import type { DerivationSignPayload } from "./index";
// @ts-expect-error Raw derive-address failures are package-internal protocol details.
import type { DeriveAddressFailure } from "./index";
// @ts-expect-error Raw derive-address results are package-internal protocol details.
import type { DeriveAddressResult } from "./index";
// @ts-expect-error Raw derive-address payloads are package-internal protocol details.
import type { DeriveAddressPayload } from "./index";

type RemovedPublicTypes = [
  PasskeyInfo,
  SignerType,
  IframeMessage,
  IframeMessageType,
  ConnectPayload,
  DerivationSignPayload,
  DeriveAddressFailure,
  DeriveAddressResult,
  DeriveAddressPayload,
];

declare const removedPublicTypes: RemovedPublicTypes;

void RIP7212_NATIVE_CHAINS;
void supportsRIP7212;
void removedPublicTypes;

declare const host: IframeHost;
const concreteHost: import("./types").IframeHost = new IframeHost();

const connection: Promise<ConnectResult> = host.connect();
const evmRequest: EvmSigningRequest = {
  kind: "message",
  message: { type: "text", value: "hello" },
};
const evmOptions: EvmSignOptions = { group: "evm", keyIndex: 0 };
const solanaRequest: SolanaRawSigningRequest = { kind: "raw", payload: "0x0102" };
const solanaOptions: SolanaSignOptions = { group: "solana", keyIndex: 0 };

host.sign(evmRequest, evmOptions);
host.sign(solanaRequest, solanaOptions);
host.sign(
  { kind: "message", message: { type: "text", value: "hello" } },
  { group: "evm", keyIndex: 0 }
);
host.sign({ kind: "raw", payload: "0x0102" }, { group: "solana", keyIndex: 0 });

const legacy: Promise<DerivationConnectResult> = host.connectWithSignerType({
  signerType: "derivation",
});

void connection;
void legacy;
void concreteHost;

// @ts-expect-error Direct PassKey signing is not part of the Derivation-only API.
host.signWithPasskey({ kind: "raw", payload: "0x01" }, { keyId: "0x01" });

// @ts-expect-error Structured requests can select only EVM keys.
host.sign(evmRequest, { group: "solana", keyIndex: 0 });
// @ts-expect-error Structured requests cannot select Bitcoin keys.
host.sign(evmRequest, { group: "bitcoin", keyIndex: 0 });
// @ts-expect-error Raw requests cannot select by address.
host.sign(solanaRequest, { address: "0x1111111111111111111111111111111111111111" });
// @ts-expect-error Raw requests can select only Solana keys.
host.sign(solanaRequest, { group: "evm", keyIndex: 0 });
// @ts-expect-error Every signing request requires exactly one selector.
host.sign(evmRequest, {});
// @ts-expect-error Address and group-plus-index selectors are mutually exclusive.
host.sign(evmRequest, {
  address: "0x1111111111111111111111111111111111111111",
  group: "evm",
  keyIndex: 0,
});
// @ts-expect-error A group selector requires a key index.
host.sign(evmRequest, { group: "evm" });
// @ts-expect-error A key-index selector requires an explicit group.
host.sign(evmRequest, { keyIndex: 0 });

const eventHost = new IframeHost();
const unsubscribe: () => void = eventHost.onEvent("error", () => {});
unsubscribe();

import { createProvider } from "./index";
import { custom, createWalletClient } from "viem";
const providerWallet = createWalletClient({ transport: custom(createProvider()) });
void providerWallet;

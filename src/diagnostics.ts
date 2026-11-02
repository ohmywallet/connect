import { APP_CHAIN_IDS } from "./app-protocol";
import { connectEnvironment, DEVELOPMENT_CHAIN_ID, type ConnectEnvironment } from "./deployment";

export interface ConnectDiagnosticOptions {
  environment?: ConnectEnvironment;
  transport?: "embedded" | "walletconnect";
  account?: "managed" | "fee";
  chainId?: number;
}
export type ConnectCheckStatus = "pass" | "fail" | "unknown";
export type ConnectCheckCode =
  | "BROWSER_CONTEXT"
  | "SUPPORTED_CHAIN"
  | "CALLER_ORIGIN"
  | "SECURE_CONTEXT"
  | "HTTPS_SERVICE"
  | "SERVICE_REGISTRATION"
  | "EMBED_GET_POLICY"
  | "WEBAUTHN_API"
  | "TLS_CERTIFICATE"
  | "CONTENT_SECURITY_POLICY"
  | "REMOTE_FRAME_POLICY"
  | "PASSKEY_AUTHENTICATION"
  | "PRF_SUPPORT";
export interface ConnectDiagnosticCheck {
  readonly code: ConnectCheckCode;
  readonly status: ConnectCheckStatus;
}
export interface ConnectEnvironmentDiagnostic {
  readonly environment: ConnectEnvironment;
  readonly transport: "embedded" | "walletconnect";
  readonly account: "managed" | "fee";
  readonly chainId: number;
  readonly setupUrl: string;
  readonly serviceOrigin?: string;
  /** Local configuration only. Even ready-for-attempt requires a manual wallet attempt. */
  readonly status: "blocked" | "unknown" | "ready-for-attempt";
  readonly checks: readonly ConnectDiagnosticCheck[];
}

const DEVELOPMENT_SERVICES = Object.freeze([
  "http://localhost:4173",
  "http://localhost:4174",
  "https://localhost:4173",
  "https://localhost:4174",
]);
const setupUrl = (environment: ConnectEnvironment) =>
  environment === "development" ? "https://app.dev.ohmywallet.xyz" : "https://app.ohmywallet.xyz";
interface PolicyLike {
  features?: () => unknown;
  allowsFeature?: (feature: string, origin?: string) => unknown;
}

/** Match the App provider's caller-origin grammar without starting a connection. */
function walletConnectCallerOrigin(value: unknown): ConnectCheckStatus {
  if (typeof value !== "string") return "fail";
  try {
    const source = new URL(value);
    return source.origin === value &&
      (source.protocol === "https:" ||
        (source.protocol === "http:" && ["localhost", "127.0.0.1"].includes(source.hostname)))
      ? "pass"
      : "fail";
  } catch {
    return "fail";
  }
}

/** Document denial blocks descendants; document allowance cannot establish iframe delegation. */
function embedGetPolicy(): ConnectCheckStatus {
  try {
    const page = document as Document & {
      permissionsPolicy?: PolicyLike;
      featurePolicy?: PolicyLike;
    };
    const policy = page.permissionsPolicy ?? page.featurePolicy;
    if (typeof policy?.features !== "function" || typeof policy.allowsFeature !== "function")
      return "unknown";
    const features = policy.features();
    if (!Array.isArray(features) || !features.includes("publickey-credentials-get"))
      return "unknown";
    const allowed = policy.allowsFeature("publickey-credentials-get");
    return allowed === false ? "fail" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Read-only configuration snapshot: no network, storage or native credential calls.
 * API presence and document policy cannot establish iframe delegation, remote CSP, PRF support,
 * an available passkey, a deployed Safe or successful authentication.
 */
export function diagnoseConnectEnvironment(
  options: ConnectDiagnosticOptions = {}
): ConnectEnvironmentDiagnostic {
  const environment = connectEnvironment(options.environment);
  const transport = options.transport ?? "embedded";
  const account = options.account ?? "managed";
  const chainId = options.chainId ?? (environment === "development" ? DEVELOPMENT_CHAIN_ID : 1);
  if (
    !["embedded", "walletconnect"].includes(transport) ||
    !["managed", "fee"].includes(account) ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0
  )
    throw new TypeError("Invalid Connect diagnostic options");
  const configuration: ConnectDiagnosticCheck[] = [];
  const add = (code: ConnectCheckCode, status: ConnectCheckStatus) =>
    configuration.push(Object.freeze({ code, status }));
  let browser = false;
  let serviceOrigin: string | undefined;
  let secure: ConnectCheckStatus = "unknown";
  let native: ConnectCheckStatus = "unknown";
  let callerOrigin: ConnectCheckStatus = "unknown";
  try {
    browser = typeof window !== "undefined" && typeof document !== "undefined";
    if (browser) {
      const observed = window.location.origin;
      callerOrigin = walletConnectCallerOrigin(observed);
      if (
        typeof observed === "string" &&
        /^https?:\/\//u.test(observed) &&
        new URL(observed).origin === observed
      )
        serviceOrigin = observed;
      secure =
        window.isSecureContext === true
          ? "pass"
          : window.isSecureContext === false
            ? "fail"
            : "unknown";
    }
  } catch {
    // Sandboxed/inaccessible browser state is not evidence of permission or support.
  }
  add("BROWSER_CONTEXT", browser ? "pass" : "unknown");
  const knownChain =
    (APP_CHAIN_IDS as readonly number[]).includes(chainId) ||
    (transport === "embedded" && account === "fee" && chainId === 10);
  add(
    "SUPPORTED_CHAIN",
    (environment === "development" ? chainId === DEVELOPMENT_CHAIN_ID : knownChain)
      ? "pass"
      : "fail"
  );
  if (transport === "walletconnect") add("CALLER_ORIGIN", callerOrigin);
  if (transport === "embedded") {
    add("SECURE_CONTEXT", secure);
    // Chromium's hosted Vault request also requires trusted TLS at the top dApp.
    // HTTP localhost being potentially trustworthy does not satisfy that condition.
    add(
      "HTTPS_SERVICE",
      serviceOrigin === undefined
        ? "unknown"
        : serviceOrigin.startsWith("https://")
          ? "pass"
          : "fail"
    );
    add(
      "SERVICE_REGISTRATION",
      environment === "development" && serviceOrigin !== undefined
        ? DEVELOPMENT_SERVICES.includes(serviceOrigin)
          ? "pass"
          : "fail"
        : "unknown"
    );
    add("EMBED_GET_POLICY", browser ? embedGetPolicy() : "unknown");
    if (browser)
      try {
        native =
          typeof window.PublicKeyCredential === "function" &&
          typeof navigator.credentials?.get === "function"
            ? "pass"
            : "fail";
      } catch {
        native = "unknown";
      }
    add("WEBAUTHN_API", native);
  }
  const status = configuration.some((check) => check.status === "fail")
    ? "blocked"
    : configuration.some((check) => check.status === "unknown")
      ? "unknown"
      : "ready-for-attempt";
  return Object.freeze({
    environment,
    transport,
    account,
    chainId,
    setupUrl: setupUrl(environment),
    ...(serviceOrigin === undefined ? {} : { serviceOrigin }),
    status,
    checks: Object.freeze([
      ...configuration,
      ...(
        [
          "TLS_CERTIFICATE",
          "CONTENT_SECURITY_POLICY",
          "REMOTE_FRAME_POLICY",
          "PASSKEY_AUTHENTICATION",
          "PRF_SUPPORT",
        ] as const
      ).map((code) => Object.freeze({ code, status: "unknown" as const })),
    ]),
  });
}

export type ConnectErrorCategory =
  "authentication" | "setup" | "network" | "request" | "cancelled" | "unsupported";
export type ConnectErrorAction =
  | "none"
  | "manual-retry"
  | "review-request"
  | "check-configuration"
  | "check-wallet"
  | "check-browser"
  | "open-wallet"
  | "fund-fee-wallet"
  | "wait"
  | "check-transaction";
const ERROR_INFO = {
  DISABLED: ["unsupported", "check-configuration"],
  BUSY: ["request", "wait"],
  CANCELLED: ["cancelled", "none"],
  INVALID_REQUEST: ["request", "review-request"],
  INVALID_CREDENTIAL: ["authentication", "check-wallet"],
  WEBAUTHN_NOT_ALLOWED: ["authentication", "manual-retry"],
  PRF_UNAVAILABLE: ["unsupported", "check-browser"],
  SAFE_PASSKEY_UNSUPPORTED: ["unsupported", "check-browser"],
  SAFE_LEGACY_PASSKEY_UNSUPPORTED: ["unsupported", "check-wallet"],
  SAFE_OWNER_FRAME_UNSUPPORTED: ["unsupported", "check-browser"],
  SAFE_OWNER_PROOF_UNAVAILABLE: ["authentication", "check-wallet"],
  SAFE_TARGETED_PROOF_UNAVAILABLE: ["authentication", "check-browser"],
  INSUFFICIENT_RELAY_FEE: ["setup", "fund-fee-wallet"],
  IDENTITY_MISMATCH: ["authentication", "check-wallet"],
  STORAGE_FAILED: ["setup", "check-browser"],
  EXPIRED: ["request", "manual-retry"],
  SAFE_NOT_DEPLOYED: ["setup", "open-wallet"],
  SAFE_PROFILE_MISMATCH: ["setup", "check-wallet"],
  SAFE_READ_UNAVAILABLE: ["network", "manual-retry"],
} as const satisfies Record<string, readonly [ConnectErrorCategory, ConnectErrorAction]>;
const RPC_ERROR_INFO = {
  4001: ["cancelled", "none"],
  4100: ["authentication", "check-wallet"],
  4200: ["unsupported", "review-request"],
  4900: ["network", "manual-retry"],
  4901: ["network", "manual-retry"],
  4902: ["unsupported", "check-configuration"],
  [-32602]: ["request", "review-request"],
  [-32002]: ["request", "wait"],
  [-32003]: ["network", "check-transaction"],
} as const satisfies Record<number, readonly [ConnectErrorCategory, ConnectErrorAction]>;
export type ConnectDiagnosticErrorCode = keyof typeof ERROR_INFO | keyof typeof RPC_ERROR_INFO;
export interface ConnectErrorInfo {
  readonly code: ConnectDiagnosticErrorCode;
  readonly category: ConnectErrorCategory;
  readonly nextAction: ConnectErrorAction;
  readonly setupUrl?: string;
}

function ownValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}
/** No peer/native exception text, inherited properties or accessors are reflected. */
export function getConnectErrorInfo(
  error: unknown,
  options: { environment?: ConnectEnvironment } = {}
): ConnectErrorInfo | null {
  let code: unknown;
  try {
    if (error === null || typeof error !== "object") return null;
    code = ownValue(error, "code");
    if (code === -32000) {
      const message = ownValue(error, "message");
      if (typeof message !== "string") return null;
      code = message;
    }
  } catch {
    return null;
  }
  const info =
    typeof code === "string" && Object.hasOwn(ERROR_INFO, code)
      ? ERROR_INFO[code as keyof typeof ERROR_INFO]
      : typeof code === "number" && Object.hasOwn(RPC_ERROR_INFO, code)
        ? RPC_ERROR_INFO[code as keyof typeof RPC_ERROR_INFO]
        : undefined;
  if (info === undefined) return null;
  const [category, nextAction] = info;
  return Object.freeze({
    code: code as ConnectDiagnosticErrorCode,
    category,
    nextAction,
    ...(category === "setup"
      ? { setupUrl: setupUrl(connectEnvironment(options.environment)) }
      : {}),
  });
}

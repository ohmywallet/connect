import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnoseConnectEnvironment, getConnectErrorInfo } from "./diagnostics";

afterEach(() => vi.unstubAllGlobals());

function browser(
  options: {
    origin?: string;
    secure?: boolean;
    policy?: unknown;
    legacyPolicy?: unknown;
    native?: boolean;
  } = {}
) {
  const nativeGet = vi.fn();
  vi.stubGlobal("window", {
    location: { origin: options.origin ?? "https://localhost:4173" },
    isSecureContext: options.secure ?? true,
    PublicKeyCredential: options.native === false ? undefined : function () {},
  });
  vi.stubGlobal("document", {
    permissionsPolicy: options.policy,
    featurePolicy: options.legacyPolicy,
    createElement: vi.fn(),
  });
  vi.stubGlobal("navigator", { credentials: { get: nativeGet } });
  return nativeGet;
}
function policy(allowed = true) {
  return {
    features: () => ["publickey-credentials-get"],
    allowsFeature: vi.fn((_feature: string, origin?: string) =>
      origin === undefined ? allowed : false
    ),
  };
}
const status = (result: ReturnType<typeof diagnoseConnectEnvironment>, code: string) =>
  result.checks.find((check) => check.code === code)?.status;

describe("read-only Connect environment diagnostics", () => {
  it("keeps SSR/browser-unavailable checks unknown and does not execute browser APIs", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    const get = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal("navigator", { credentials: { get } });
    vi.stubGlobal("fetch", fetch);
    const result = diagnoseConnectEnvironment({ environment: "development" });
    expect(result).toMatchObject({
      environment: "development",
      transport: "embedded",
      account: "managed",
      chainId: 84532,
      setupUrl: "https://app.dev.ohmywallet.xyz",
      status: "unknown",
    });
    expect(result).not.toHaveProperty("serviceOrigin");
    expect(status(result, "BROWSER_CONTEXT")).toBe("unknown");
    expect(get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a default-self document allowance unknown instead of inferring iframe delegation", () => {
    const delegated = policy();
    const get = browser({ policy: delegated });
    const result = diagnoseConnectEnvironment({ environment: "development" });
    expect(result.status).toBe("unknown");
    expect(status(result, "EMBED_GET_POLICY")).toBe("unknown");
    expect(delegated.allowsFeature).toHaveBeenCalledExactlyOnceWith("publickey-credentials-get");
    expect(status(result, "WEBAUTHN_API")).toBe("pass");
    for (const code of [
      "TLS_CERTIFICATE",
      "CONTENT_SECURITY_POLICY",
      "REMOTE_FRAME_POLICY",
      "PASSKEY_AUTHENTICATION",
      "PRF_SUPPORT",
    ])
      expect(status(result, code)).toBe("unknown");
    expect(get).not.toHaveBeenCalled();
    expect(document.createElement).not.toHaveBeenCalled();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.checks)).toBe(true);
    expect(result.checks.every(Object.isFrozen)).toBe(true);
  });

  it.each(["https://localhost:4173", "https://localhost:4174"])(
    "accepts the exact HTTPS development service %s",
    (origin) => {
      browser({ origin, policy: policy() });
      const result = diagnoseConnectEnvironment({ environment: "development" });
      expect(status(result, "SERVICE_REGISTRATION")).toBe("pass");
      expect(status(result, "HTTPS_SERVICE")).toBe("pass");
      expect(result.status).toBe("unknown");
    }
  );

  it.each(["http://localhost:4173", "http://localhost:4174"])(
    "distinguishes HTTP registration from HTTPS browser readiness at %s",
    (origin) => {
      browser({ origin, secure: true, policy: policy() });
      const result = diagnoseConnectEnvironment({ environment: "development" });
      expect(status(result, "SERVICE_REGISTRATION")).toBe("pass");
      expect(status(result, "SECURE_CONTEXT")).toBe("pass");
      expect(status(result, "HTTPS_SERVICE")).toBe("fail");
      expect(result.status).toBe("blocked");
    }
  );

  it.each([
    "https://localhost:4175",
    "https://127.0.0.1:4173",
    "https://localhost.evil.example:4173",
    "https://demo.ohmywallet.xyz",
  ])("rejects an unregistered development service %s", (origin) => {
    browser({ origin, policy: policy() });
    const result = diagnoseConnectEnvironment({ environment: "development" });
    expect(status(result, "SERVICE_REGISTRATION")).toBe("fail");
    expect(result.status).toBe("blocked");
  });

  it("uses the legacy policy name without creating an iframe", () => {
    const delegated = policy();
    browser({ legacyPolicy: delegated });
    const result = diagnoseConnectEnvironment({ environment: "development" });
    expect(status(result, "EMBED_GET_POLICY")).toBe("unknown");
    expect(delegated.allowsFeature).toHaveBeenCalledOnce();
  });

  it("does not treat a legacy policy that ignores an origin argument as iframe permission", () => {
    const allowsFeature = vi.fn((_feature: string) => true);
    browser({ legacyPolicy: { features: () => ["publickey-credentials-get"], allowsFeature } });
    const result = diagnoseConnectEnvironment({ environment: "development" });
    expect(status(result, "EMBED_GET_POLICY")).toBe("unknown");
    expect(result.status).toBe("unknown");
    expect(allowsFeature).toHaveBeenCalledExactlyOnceWith("publickey-credentials-get");
    expect(document.createElement).not.toHaveBeenCalled();
  });

  it("reports a recognized current-document denial before an authentication attempt", () => {
    const get = browser({ policy: policy(false) });
    const result = diagnoseConnectEnvironment({ environment: "development" });
    expect(status(result, "EMBED_GET_POLICY")).toBe("fail");
    expect(result.status).toBe("blocked");
    expect(get).not.toHaveBeenCalled();
    expect(document.createElement).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { allowsFeature: vi.fn(() => false) },
    { features: () => [], allowsFeature: vi.fn(() => false) },
    { features: () => ["publickey-credentials-get"], allowsFeature: () => "false" },
    {
      features() {
        throw Error("Browser policy unavailable");
      },
      allowsFeature: vi.fn(),
    },
  ])("does not infer a denial or permission from an unavailable policy: %o", (value) => {
    browser({ policy: value });
    const result = diagnoseConnectEnvironment({ environment: "development" });
    expect(status(result, "EMBED_GET_POLICY")).toBe("unknown");
    expect(result.status).toBe("unknown");
  });

  it("keeps an inaccessible policy unknown", () => {
    browser();
    vi.stubGlobal(
      "document",
      Object.defineProperty({}, "permissionsPolicy", {
        get() {
          throw Error("Inaccessible document policy");
        },
      })
    );
    expect(
      status(diagnoseConnectEnvironment({ environment: "development" }), "EMBED_GET_POLICY")
    ).toBe("unknown");
  });

  it("reports API absence without invoking native credential creation or recovery", () => {
    const get = browser({ native: false, policy: policy() });
    const result = diagnoseConnectEnvironment({ environment: "development" });
    expect(status(result, "WEBAUTHN_API")).toBe("fail");
    expect(result.status).toBe("blocked");
    expect(get).not.toHaveBeenCalled();
  });

  it("does not impose Embed registration or local WebAuthn policy on a WalletConnect page", () => {
    browser({ origin: "https://unregistered.example", secure: false, native: false });
    const policyGetter = vi.fn(() => {
      throw Error("WalletConnect must not inspect local embedding policy");
    });
    vi.stubGlobal(
      "document",
      Object.defineProperty({}, "permissionsPolicy", { get: policyGetter })
    );
    const result = diagnoseConnectEnvironment({
      environment: "development",
      transport: "walletconnect",
      account: "fee",
    });
    expect(result).toMatchObject({ status: "ready-for-attempt", chainId: 84532, account: "fee" });
    expect(status(result, "CALLER_ORIGIN")).toBe("pass");
    expect(result.checks.map((check) => check.code)).not.toContain("WEBAUTHN_API");
    expect(result.checks.map((check) => check.code)).not.toContain("SERVICE_REGISTRATION");
    expect(status(result, "PASSKEY_AUTHENTICATION")).toBe("unknown");
    expect(policyGetter).not.toHaveBeenCalled();
  });

  it.each(["http://localhost:4173", "http://127.0.0.1:4174"])(
    "matches the WalletConnect provider's local HTTP caller allowance at %s",
    (origin) => {
      const get = browser({ origin, secure: false, native: false });
      const result = diagnoseConnectEnvironment({
        environment: "development",
        transport: "walletconnect",
      });
      expect(status(result, "CALLER_ORIGIN")).toBe("pass");
      expect(result.status).toBe("ready-for-attempt");
      expect(get).not.toHaveBeenCalled();
    }
  );

  it.each([
    "http://example.com",
    "http://127.0.0.2:4173",
    "http://[::1]:4173",
    "file:///test.html",
    "null",
    "not-an-origin",
    "https://example.com/",
    "https://user:pass@example.com",
  ])("reports an observable invalid WalletConnect caller %s as blocked", (origin) => {
    browser({ origin, secure: false, native: false });
    const result = diagnoseConnectEnvironment({
      environment: "development",
      transport: "walletconnect",
    });
    expect(status(result, "CALLER_ORIGIN")).toBe("fail");
    expect(result.status).toBe("blocked");
  });

  it.each(["ssr", "inaccessible"] as const)(
    "keeps WalletConnect caller-origin permission unknown for %s state",
    (state) => {
      if (state === "ssr") {
        vi.stubGlobal("window", undefined);
        vi.stubGlobal("document", undefined);
      } else {
        browser();
        vi.stubGlobal("window", {
          get location() {
            throw Error("Browser state inaccessible");
          },
        });
      }
      const result = diagnoseConnectEnvironment({
        environment: "development",
        transport: "walletconnect",
      });
      expect(status(result, "CALLER_ORIGIN")).toBe("unknown");
      expect(result.status).toBe("unknown");
    }
  );

  it.each([1, 8453, 11155111, 5042002])(
    "blocks unsupported development chain %i without choosing another chain",
    (chainId) => {
      browser({ policy: policy() });
      const result = diagnoseConnectEnvironment({ environment: "development", chainId });
      expect(result.chainId).toBe(chainId);
      expect(status(result, "SUPPORTED_CHAIN")).toBe("fail");
      expect(result.status).toBe("blocked");
    }
  );

  it("keeps remote production service registration unknown", () => {
    browser({
      origin: "https://my-service.example",
      policy: {
        features: () => ["publickey-credentials-get"],
        allowsFeature: (_feature: string, origin?: string) =>
          origin === undefined || origin === "https://embed.ohmywallet.xyz",
      },
    });
    const result = diagnoseConnectEnvironment();
    expect(result.setupUrl).toBe("https://app.ohmywallet.xyz");
    expect(status(result, "SERVICE_REGISTRATION")).toBe("unknown");
    expect(result.status).toBe("unknown");
  });

  it.each([
    { environment: "staging" },
    { transport: "popup" },
    { account: "other" },
    { chainId: 0 },
    { chainId: NaN },
    { chainId: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects malformed caller configuration: %o", (options) => {
    expect(() => diagnoseConnectEnvironment(options as never)).toThrow();
  });
});

describe("fixed Connect error interpretation", () => {
  it.each([
    ["SAFE_NOT_DEPLOYED", "setup", "open-wallet"],
    ["SAFE_PROFILE_MISMATCH", "setup", "check-wallet"],
    ["SAFE_READ_UNAVAILABLE", "network", "manual-retry"],
    ["WEBAUTHN_NOT_ALLOWED", "authentication", "manual-retry"],
    ["INVALID_CREDENTIAL", "authentication", "check-wallet"],
    ["PRF_UNAVAILABLE", "unsupported", "check-browser"],
    ["INSUFFICIENT_RELAY_FEE", "setup", "fund-fee-wallet"],
    ["CANCELLED", "cancelled", "none"],
  ])("interprets only fixed %s as %s/%s", (code, category, nextAction) => {
    const result = getConnectErrorInfo({ code }, { environment: "development" });
    expect(result).toMatchObject({ code, category, nextAction });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result?.setupUrl).toBe(
      category === "setup" ? "https://app.dev.ohmywallet.xyz" : undefined
    );
  });

  it("accepts the existing own -32000/fixed-message wire projection", () => {
    const result = getConnectErrorInfo(
      Object.assign(new Error("SAFE_NOT_DEPLOYED"), { code: -32000 }),
      { environment: "development" }
    );
    expect(result).toEqual({
      code: "SAFE_NOT_DEPLOYED",
      category: "setup",
      nextAction: "open-wallet",
      setupUrl: "https://app.dev.ohmywallet.xyz",
    });
  });

  it("never turns generic INVALID_REQUEST into an undeployed Safe diagnosis", () => {
    expect(getConnectErrorInfo({ code: -32000, message: "INVALID_REQUEST" })).toEqual({
      code: "INVALID_REQUEST",
      category: "request",
      nextAction: "review-request",
    });
  });

  it("preserves uncertain submission as check-transaction, not retry", () => {
    expect(getConnectErrorInfo({ code: -32003, message: "unsafe native detail" })).toEqual({
      code: -32003,
      category: "network",
      nextAction: "check-transaction",
    });
  });

  it("never reflects arbitrary native text for recognized provider codes", () => {
    expect(getConnectErrorInfo({ code: 4001, message: "credential/raw/server details" })).toEqual({
      code: 4001,
      category: "cancelled",
      nextAction: "none",
    });
    expect(
      getConnectErrorInfo({ code: -32000, message: "credential/raw/server details" })
    ).toBeNull();
  });

  it.each([4001, null, {}, ["SAFE_NOT_DEPLOYED"]])(
    "rejects a non-string -32000 diagnostic message: %o",
    (message) => expect(getConnectErrorInfo({ code: -32000, message })).toBeNull()
  );

  it.each([
    undefined,
    null,
    "SAFE_NOT_DEPLOYED",
    4001,
    {},
    { code: "unknown" },
    { code: "constructor" },
    { code: -1 },
  ])("does not interpret unknown input: %o", (value) =>
    expect(getConnectErrorInfo(value)).toBeNull()
  );

  it("does not read inherited code or fixed-looking inherited message", () => {
    expect(getConnectErrorInfo(Object.create({ code: "SAFE_NOT_DEPLOYED" }))).toBeNull();
    expect(
      getConnectErrorInfo(
        Object.assign(Object.create({ message: "SAFE_NOT_DEPLOYED" }), { code: -32000 })
      )
    ).toBeNull();
  });

  it("does not invoke error accessors", () => {
    const code = vi.fn(() => "SAFE_NOT_DEPLOYED");
    const message = vi.fn(() => "SAFE_NOT_DEPLOYED");
    expect(getConnectErrorInfo(Object.defineProperty({}, "code", { get: code }))).toBeNull();
    expect(
      getConnectErrorInfo(Object.defineProperty({ code: -32000 }, "message", { get: message }))
    ).toBeNull();
    expect(
      getConnectErrorInfo(Object.defineProperty({ code: "CANCELLED" }, "message", { get: message }))
    ).toEqual({ code: "CANCELLED", category: "cancelled", nextAction: "none" });
    expect(code).not.toHaveBeenCalled();
    expect(message).not.toHaveBeenCalled();
  });

  it("fails closed when descriptor inspection throws", () => {
    const value = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw Error("Untrusted trap");
        },
      }
    );
    expect(getConnectErrorInfo(value)).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IframeChannelBase } from "./channel";

class FakeWindow {
  readonly location = { origin: "https://merchant.example" };
  private readonly messageListeners = new Set<(event: MessageEvent) => void>();
  private readonly messageSignalRemovers = new Map<(event: MessageEvent) => void, () => void>();
  lastMessageSignal: AbortSignal | null = null;

  addEventListener(
    type: string,
    listener: (event: MessageEvent) => void,
    options?: boolean | AddEventListenerOptions
  ): void {
    if (type !== "message") return;

    const signal = typeof options === "object" ? options.signal : undefined;
    this.lastMessageSignal = signal ?? null;
    if (signal?.aborted) return;

    this.messageSignalRemovers.get(listener)?.();
    this.messageListeners.add(listener);
    if (!signal) return;

    const handleAbort = () => {
      this.messageListeners.delete(listener);
      this.messageSignalRemovers.delete(listener);
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    this.messageSignalRemovers.set(listener, () => {
      signal.removeEventListener("abort", handleAbort);
    });
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type !== "message") return;
    this.messageListeners.delete(listener);
    this.messageSignalRemovers.get(listener)?.();
    this.messageSignalRemovers.delete(listener);
  }

  dispatch(event: Partial<MessageEvent>): void {
    for (const listener of this.messageListeners) listener(event as MessageEvent);
  }

  get messageListenerCount(): number {
    return this.messageListeners.size;
  }
}

class TestChannel extends IframeChannelBase {
  listen(): void {
    this.startListening();
  }

  request(messageId: string, timeout?: number): Promise<unknown> {
    return this.requestManager.register(messageId, timeout);
  }

  requestWithOwnership(
    messageId: string,
    timeout?: number
  ): { response: Promise<unknown>; ownership: object } {
    return this.requestManager.registerWithOwnership(messageId, timeout);
  }

  ownsRequest(messageId: string, ownership: object): boolean {
    return this.requestManager.hasPending(messageId, ownership);
  }

  resolveRequest(messageId: string, value: unknown): boolean {
    return this.requestManager.resolve(messageId, value);
  }

  rejectRequest(messageId: string, error: Error): boolean {
    return this.requestManager.reject(messageId, error);
  }

  claimAndResolveRequest(
    messageId: string,
    ownership: object,
    value: unknown,
    onClaim: () => void
  ): boolean {
    return this.requestManager.claimAndResolve(messageId, ownership, value, onClaim);
  }

  claimAndRejectRequest(
    messageId: string,
    ownership: object,
    error: Error,
    onClaim: () => void
  ): boolean {
    return this.requestManager.claimAndReject(messageId, ownership, error, onClaim);
  }

  extendRequest(messageId: string, timeout: number): boolean {
    return this.requestManager.extendTimeout(messageId, timeout);
  }

  cancelRequests(reason: string): void {
    this.requestManager.cancelAll(reason);
  }

  get ownsMessageListener(): boolean {
    return this.messageListener !== null;
  }

  get handlerCount(): number {
    return Object.keys(this.handlers).length;
  }

  get pendingRequestCount(): number {
    return this.requestManager.pendingCount;
  }
}

let fakeWindow: FakeWindow;

beforeEach(() => {
  vi.useFakeTimers();
  fakeWindow = new FakeWindow();
  vi.stubGlobal("window", fakeWindow);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function dispatchConnectResult(): void {
  fakeWindow.dispatch({
    origin: "https://embed.ohmywallet.xyz",
    source: null,
    data: {
      type: "CONNECT_RESULT",
      id: "message-handler-result",
      payload: {},
      timestamp: 1,
    },
  });
}

async function flushHandlerDrain(): Promise<void> {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

describe("IframeChannelBase teardown ownership", () => {
  it.each([
    ["resolve", "before"],
    ["resolve", "after"],
    ["reject", "before"],
    ["reject", "after"],
  ] as const)(
    "%s settles exactly once when timeout cancellation throws %s native clear",
    async (operation, clearPhase) => {
      const nativeClearTimeout = globalThis.clearTimeout;
      const cancellationError = new Error(`${clearPhase} native timeout cancellation failure`);
      vi.stubGlobal("clearTimeout", ((timeout: ReturnType<typeof setTimeout>) => {
        if (clearPhase === "after") nativeClearTimeout(timeout);
        throw cancellationError;
      }) as typeof clearTimeout);
      const channel = new TestChannel("https://embed.ohmywallet.xyz", 60_000);
      let settlements = 0;
      const request = channel.request(`${operation}-${clearPhase}`).then(
        (value) => {
          settlements += 1;
          return { status: "fulfilled" as const, value };
        },
        (error: unknown) => {
          settlements += 1;
          return { status: "rejected" as const, error };
        }
      );
      const responseError = new Error("relay rejected request");

      expect(() => {
        if (operation === "resolve") {
          expect(channel.resolveRequest(`${operation}-${clearPhase}`, "accepted")).toBe(true);
        } else {
          expect(channel.rejectRequest(`${operation}-${clearPhase}`, responseError)).toBe(true);
        }
      }).not.toThrow();

      await expect(request).resolves.toMatchObject(
        operation === "resolve"
          ? { status: "fulfilled", value: "accepted" }
          : { status: "rejected", error: responseError }
      );
      expect(channel.pendingRequestCount).toBe(0);
      expect(settlements).toBe(1);
      expect(vi.getTimerCount()).toBe(clearPhase === "after" ? 0 : 1);

      await vi.advanceTimersByTimeAsync(60_001);
      expect(channel.pendingRequestCount).toBe(0);
      expect(settlements).toBe(1);
    }
  );

  it.each(["cancelAll", "destroy"] as const)(
    "%s rejects every request when captured timeout cancellation throws",
    async (operation) => {
      vi.stubGlobal("clearTimeout", (() => {
        throw new Error("timeout cancellation failed before native clear");
      }) as typeof clearTimeout);
      const channel = new TestChannel("https://embed.ohmywallet.xyz", 60_000);
      const outcomes = [channel.request("first"), channel.request("second")].map((request) =>
        request.then(
          (value) => ({ status: "fulfilled" as const, value }),
          (error: unknown) => ({ status: "rejected" as const, error })
        )
      );

      expect(() => {
        if (operation === "cancelAll") channel.cancelRequests("Owner cancelled requests");
        else channel.destroy();
      }).not.toThrow();

      await expect(Promise.all(outcomes)).resolves.toEqual([
        { status: "rejected", error: expect.objectContaining({ code: "DESTROYED" }) },
        { status: "rejected", error: expect.objectContaining({ code: "DESTROYED" }) },
      ]);
      expect(channel.pendingRequestCount).toBe(0);
      expect(() => channel.destroy()).not.toThrow();

      await vi.advanceTimersByTimeAsync(60_001);
      expect(channel.pendingRequestCount).toBe(0);
    }
  );

  it("invalidates the old timeout before a throwing extension cancellation", async () => {
    vi.stubGlobal("clearTimeout", (() => {
      throw new Error("extended timeout cancellation failed");
    }) as typeof clearTimeout);
    const channel = new TestChannel("https://embed.ohmywallet.xyz", 60_000);
    const first = channel.request("reused-id", 10_000);
    let firstSettlements = 0;
    const firstOutcome = first.catch((error: unknown) => {
      firstSettlements += 1;
      return error;
    });

    expect(() => expect(channel.extendRequest("reused-id", 1_000)).toBe(true)).not.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(firstOutcome).resolves.toMatchObject({ code: "TIMEOUT" });
    expect(firstSettlements).toBe(1);
    expect(channel.pendingRequestCount).toBe(0);

    const replacement = channel.request("reused-id", 30_000);
    let replacementSettled = false;
    void replacement.then(
      () => {
        replacementSettled = true;
      },
      () => {
        replacementSettled = true;
      }
    );
    await vi.advanceTimersByTimeAsync(9_001);
    expect(replacementSettled).toBe(false);
    expect(channel.pendingRequestCount).toBe(1);

    const cancellation = new Error("replacement cancelled");
    expect(() => expect(channel.rejectRequest("reused-id", cancellation)).toBe(true)).not.toThrow();
    await expect(replacement).rejects.toBe(cancellation);
    expect(channel.pendingRequestCount).toBe(0);
    expect(firstSettlements).toBe(1);
  });

  it("settles an extension whose thrown Error proxy rejects instanceof classification", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    const hostileError = new Proxy(new Error("hostile extension scheduler"), {
      getPrototypeOf: () => {
        throw new Error("hostile getPrototypeOf trap");
      },
    });
    let scheduleCalls = 0;
    vi.stubGlobal("setTimeout", ((...args: Parameters<typeof setTimeout>) => {
      scheduleCalls += 1;
      if (scheduleCalls === 2) throw hostileError;
      return nativeSetTimeout(...args);
    }) as typeof setTimeout);
    const channel = new TestChannel("https://embed.ohmywallet.xyz", 60_000);
    let observed: { status: "fulfilled" | "rejected"; error?: unknown } | null = null;
    void channel.request("hostile-extension").then(
      () => {
        observed = { status: "fulfilled" };
      },
      (error: unknown) => {
        observed = { status: "rejected", error };
      }
    );
    let thrown: unknown;

    try {
      channel.extendRequest("hostile-extension", 1_000);
    } catch (error) {
      thrown = error;
    }
    await Promise.resolve();
    const snapshot = observed;
    channel.destroy();

    expect((thrown as { message?: unknown }).message).toBe("Request timeout extension failed");
    expect(snapshot).toMatchObject({
      status: "rejected",
      error: { message: "Request timeout extension failed" },
    });
    expect(channel.pendingRequestCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases the previous timeout before an extension scheduler settles the request", async () => {
    const events: string[] = [];
    const scheduledCallbacks: Array<() => void> = [];
    const reusedTimeoutId = 1 as unknown as ReturnType<typeof setTimeout>;
    let clearCalls = 0;
    let channel: TestChannel | null = null;
    let settleDuringExtension = false;
    let extensionSettlement = false;
    vi.stubGlobal("setTimeout", ((...args: Parameters<typeof setTimeout>) => {
      events.push(`schedule-${scheduledCallbacks.length + 1}`);
      const callback = args[0];
      scheduledCallbacks.push(() => {
        if (typeof callback === "function") callback(...args.slice(2));
      });
      if (settleDuringExtension) {
        settleDuringExtension = false;
        extensionSettlement = channel?.resolveRequest("reused-id", "settled") ?? false;
      }
      return reusedTimeoutId;
    }) as typeof setTimeout);
    vi.stubGlobal("clearTimeout", ((timeout: ReturnType<typeof setTimeout>) => {
      expect(timeout).toBe(reusedTimeoutId);
      clearCalls += 1;
      events.push(`clear-${clearCalls}`);
      throw new Error("timeout cancellation failed before native clear");
    }) as typeof clearTimeout);
    channel = new TestChannel("https://embed.ohmywallet.xyz", 60_000);
    const first = channel.request("reused-id", 10_000);

    settleDuringExtension = true;
    expect(channel.extendRequest("reused-id", 5_000)).toBe(false);
    expect(extensionSettlement).toBe(true);
    await expect(first).resolves.toBe("settled");
    expect(events).toContain("clear-1");
    expect(events.indexOf("clear-1")).toBeLessThan(events.indexOf("schedule-2"));
    expect(channel.pendingRequestCount).toBe(0);

    const replacement = channel.request("reused-id", 30_000);
    let replacementSettled = false;
    void replacement.then(
      () => {
        replacementSettled = true;
      },
      () => {
        replacementSettled = true;
      }
    );
    scheduledCallbacks[0]!();
    scheduledCallbacks[1]!();
    await Promise.resolve();
    expect(replacementSettled).toBe(false);
    expect(channel.pendingRequestCount).toBe(1);

    const cancellation = new Error("replacement cancelled");
    expect(channel.rejectRequest("reused-id", cancellation)).toBe(true);
    await expect(replacement).rejects.toBe(cancellation);
    expect(channel.pendingRequestCount).toBe(0);
  });

  it("does not schedule an extension after previous-timeout cleanup settles the request", async () => {
    const reusedTimeoutId = 1 as unknown as ReturnType<typeof setTimeout>;
    let scheduleCalls = 0;
    let channel: TestChannel | null = null;
    vi.stubGlobal("setTimeout", (() => {
      scheduleCalls += 1;
      return reusedTimeoutId;
    }) as typeof setTimeout);
    vi.stubGlobal("clearTimeout", (() => {
      channel?.resolveRequest("cleanup-settlement", "settled during cleanup");
    }) as typeof clearTimeout);
    channel = new TestChannel("https://embed.ohmywallet.xyz", 60_000);
    const request = channel.request("cleanup-settlement", 10_000);

    expect(channel.extendRequest("cleanup-settlement", 5_000)).toBe(false);
    await expect(request).resolves.toBe("settled during cleanup");
    expect(scheduleCalls).toBe(1);
    expect(channel.pendingRequestCount).toBe(0);
  });

  it("distinguishes a replacement request from prior ownership of the same ID", async () => {
    const channel = new TestChannel("https://embed.ohmywallet.xyz", 60_000);
    const first = channel.requestWithOwnership("reused-id");
    expect(channel.ownsRequest("reused-id", first.ownership)).toBe(true);
    expect(channel.resolveRequest("reused-id", "first")).toBe(true);
    await expect(first.response).resolves.toBe("first");

    const replacement = channel.requestWithOwnership("reused-id");
    expect(channel.ownsRequest("reused-id", first.ownership)).toBe(false);
    expect(channel.ownsRequest("reused-id", replacement.ownership)).toBe(true);

    const cancellation = new Error("replacement cancelled");
    expect(channel.rejectRequest("reused-id", cancellation)).toBe(true);
    await expect(replacement.response).rejects.toBe(cancellation);
    expect(channel.pendingRequestCount).toBe(0);
  });

  it.each(["resolve", "reject"] as const)(
    "claims exact request ownership and runs terminal bookkeeping before %s settlement",
    async (operation) => {
      const channel = new TestChannel("https://embed.ohmywallet.xyz", 60_000);
      const registration = channel.requestWithOwnership("owned-request");
      const trace: string[] = [];
      const outcome = registration.response.then(
        (value) => {
          trace.push("settled");
          return { status: "fulfilled" as const, value };
        },
        (error: unknown) => {
          trace.push("settled");
          return { status: "rejected" as const, error };
        }
      );
      const terminalError = new Error("relay rejected");

      const wrongOwner = {};
      const wrongClaim =
        operation === "resolve"
          ? channel.claimAndResolveRequest("owned-request", wrongOwner, "ignored", () => {
              trace.push("wrong-claim");
            })
          : channel.claimAndRejectRequest("owned-request", wrongOwner, terminalError, () => {
              trace.push("wrong-claim");
            });
      expect(wrongClaim).toBe(false);
      expect(trace).toEqual([]);
      expect(channel.ownsRequest("owned-request", registration.ownership)).toBe(true);

      const claimed =
        operation === "resolve"
          ? channel.claimAndResolveRequest(
              "owned-request",
              registration.ownership,
              "accepted",
              () => trace.push("claimed")
            )
          : channel.claimAndRejectRequest(
              "owned-request",
              registration.ownership,
              terminalError,
              () => trace.push("claimed")
            );
      expect(claimed).toBe(true);
      expect(trace).toEqual(["claimed"]);

      await expect(outcome).resolves.toMatchObject(
        operation === "resolve"
          ? { status: "fulfilled", value: "accepted" }
          : { status: "rejected", error: terminalError }
      );
      expect(trace).toEqual(["claimed", "settled"]);
      expect(channel.pendingRequestCount).toBe(0);
    }
  );

  it("does not let a missing ownership token claim a pending request", async () => {
    const channel = new TestChannel("https://embed.ohmywallet.xyz", 60_000);
    const registration = channel.requestWithOwnership("exact-owner-only");
    const onClaim = vi.fn();

    for (const missingOwnership of [null, undefined]) {
      expect(
        channel.claimAndResolveRequest(
          "exact-owner-only",
          missingOwnership as never,
          "unowned",
          onClaim
        )
      ).toBe(false);
    }
    expect(onClaim).not.toHaveBeenCalled();
    expect(channel.ownsRequest("exact-owner-only", registration.ownership)).toBe(true);

    expect(
      channel.claimAndResolveRequest("exact-owner-only", registration.ownership, "owned", onClaim)
    ).toBe(true);
    await expect(registration.response).resolves.toBe("owned");
    expect(onClaim).toHaveBeenCalledOnce();
  });

  it("does not allocate a request timer when metadata capture throws", () => {
    const channel = new TestChannel("https://embed.ohmywallet.xyz", 60_000);
    const metadataError = new Error("request metadata capture failed");
    const dateNow = vi.spyOn(Date, "now").mockImplementationOnce(() => {
      throw metadataError;
    });
    let request: Promise<unknown> | null = null;
    let thrown: unknown;

    try {
      request = channel.request("metadata-failure");
    } catch (error) {
      thrown = error;
    }
    void request?.catch(() => undefined);
    dateNow.mockRestore();

    expect(thrown).toBe(metadataError);
    expect(channel.pendingRequestCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => channel.destroy()).not.toThrow();
    expect(channel.pendingRequestCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses its captured timer capability when the global timer is replaced", async () => {
    const channel = new TestChannel("https://embed.ohmywallet.xyz", 60_000);
    const originalSetTimeout = globalThis.setTimeout;
    const wrapperError = new Error("global timer threw after scheduling");
    let wrapperCalls = 0;
    let cancellationWrapperCalls = 0;
    vi.stubGlobal("setTimeout", ((...args: Parameters<typeof setTimeout>) => {
      wrapperCalls += 1;
      originalSetTimeout(...args);
      throw wrapperError;
    }) as typeof setTimeout);
    vi.stubGlobal("clearTimeout", (() => {
      cancellationWrapperCalls += 1;
      throw new Error("global timer cancellation replacement failed");
    }) as typeof clearTimeout);

    const request = channel.request("stable-timer");
    let requestError: unknown;
    void request.catch((error: unknown) => {
      requestError = error;
    });
    expect(wrapperCalls).toBe(0);
    expect(channel.pendingRequestCount).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    const cancellation = new Error("request cancelled by owner");
    expect(channel.rejectRequest("stable-timer", cancellation)).toBe(true);
    await Promise.resolve();
    expect(requestError).toBe(cancellation);
    expect(cancellationWrapperCalls).toBe(0);
    expect(channel.pendingRequestCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    expect(() => channel.destroy()).not.toThrow();
    expect(channel.pendingRequestCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("invokes captured timer callables without a RequestManager receiver", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    const nativeClearTimeout = globalThis.clearTimeout;
    const schedulingReceivers: unknown[] = [];
    const cancellationReceivers: unknown[] = [];
    vi.stubGlobal("setTimeout", function (this: unknown, ...args: Parameters<typeof setTimeout>) {
      schedulingReceivers.push(this);
      if (this !== undefined) throw new TypeError("Illegal invocation");
      return Reflect.apply(nativeSetTimeout, undefined, args);
    } as typeof setTimeout);
    vi.stubGlobal("clearTimeout", function (
      this: unknown,
      ...args: Parameters<typeof clearTimeout>
    ) {
      cancellationReceivers.push(this);
      if (this !== undefined) throw new TypeError("Illegal invocation");
      return Reflect.apply(nativeClearTimeout, undefined, args);
    } as typeof clearTimeout);
    const channel = new TestChannel("https://embed.ohmywallet.xyz", 60_000);

    const request = channel.request("detached-timer");
    const cancellation = new Error("request cancelled by owner");
    expect(channel.rejectRequest("detached-timer", cancellation)).toBe(true);

    await expect(request).rejects.toBe(cancellation);
    expect(schedulingReceivers).toEqual([undefined]);
    expect(cancellationReceivers).toEqual([undefined]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rolls back a natively registered listener when addEventListener throws", () => {
    const channel = new TestChannel("https://embed.ohmywallet.xyz");
    const nativeAddEventListener = fakeWindow.addEventListener.bind(fakeWindow);
    const registrationError = new Error("message listener registration failed after native add");
    let throwAfterNativeAdd = true;
    vi.spyOn(fakeWindow, "addEventListener").mockImplementation((type, listener, options) => {
      nativeAddEventListener(type, listener, options);
      if (!throwAfterNativeAdd) return;
      throwAfterNativeAdd = false;
      throw registrationError;
    });

    expect(() => channel.listen()).toThrow(registrationError);
    expect(channel.ownsMessageListener).toBe(false);
    expect(fakeWindow.messageListenerCount).toBe(0);

    expect(() => channel.listen()).not.toThrow();
    expect(channel.ownsMessageListener).toBe(true);
    expect(fakeWindow.messageListenerCount).toBe(1);
    channel.destroy();
    expect(fakeWindow.messageListenerCount).toBe(0);
  });

  it("clears registration ownership after addEventListener throws before native add", () => {
    const channel = new TestChannel("https://embed.ohmywallet.xyz");
    const nativeAddEventListener = fakeWindow.addEventListener.bind(fakeWindow);
    const registrationError = new Error("message listener registration failed before native add");
    let throwBeforeNativeAdd = true;
    vi.spyOn(fakeWindow, "addEventListener").mockImplementation((type, listener, options) => {
      if (throwBeforeNativeAdd) {
        throwBeforeNativeAdd = false;
        throw registrationError;
      }
      nativeAddEventListener(type, listener, options);
    });

    expect(() => channel.listen()).toThrow(registrationError);
    expect(channel.ownsMessageListener).toBe(false);
    expect(fakeWindow.messageListenerCount).toBe(0);

    expect(() => channel.listen()).not.toThrow();
    expect(channel.ownsMessageListener).toBe(true);
    expect(fakeWindow.messageListenerCount).toBe(1);
    channel.destroy();
    expect(fakeWindow.messageListenerCount).toBe(0);
  });

  it("explicitly removes a listener when registration drops signal ownership", () => {
    const channel = new TestChannel("https://embed.ohmywallet.xyz");
    const nativeAddEventListener = fakeWindow.addEventListener.bind(fakeWindow);
    const removeEventListener = vi.spyOn(fakeWindow, "removeEventListener");
    vi.spyOn(fakeWindow, "addEventListener").mockImplementation((type, listener) => {
      nativeAddEventListener(type, listener);
    });

    channel.listen();
    expect(fakeWindow.lastMessageSignal).toBeNull();
    expect(fakeWindow.messageListenerCount).toBe(1);

    expect(() => channel.destroy()).not.toThrow();
    expect(removeEventListener).toHaveBeenCalledOnce();
    expect(fakeWindow.messageListenerCount).toBe(0);

    expect(() => channel.destroy()).not.toThrow();
    expect(removeEventListener).toHaveBeenCalledOnce();
  });

  it("explicitly removes a listener when captured signal abort is a no-op", () => {
    const channel = new TestChannel("https://embed.ohmywallet.xyz");
    const abort = vi
      .spyOn(globalThis.AbortController.prototype, "abort")
      .mockImplementation(() => undefined);
    const removeEventListener = vi.spyOn(fakeWindow, "removeEventListener");

    try {
      channel.listen();
      expect(fakeWindow.messageListenerCount).toBe(1);

      expect(() => channel.destroy()).not.toThrow();
      expect(abort).toHaveBeenCalledOnce();
      expect(removeEventListener).toHaveBeenCalledOnce();
      expect(fakeWindow.messageListenerCount).toBe(0);
    } finally {
      abort.mockRestore();
    }
  });

  it("uses the captured AbortController after the ambient constructor is replaced", () => {
    let replacementConstructorCalls = 0;
    vi.stubGlobal(
      "AbortController",
      class {
        constructor() {
          replacementConstructorCalls += 1;
          throw new Error("ambient AbortController replacement must not run");
        }
      }
    );
    const channel = new TestChannel("https://embed.ohmywallet.xyz");

    expect(() => channel.listen()).not.toThrow();
    expect(replacementConstructorCalls).toBe(0);
    expect(fakeWindow.lastMessageSignal).not.toBeNull();
    expect(fakeWindow.lastMessageSignal?.aborted).toBe(false);

    channel.destroy();
    expect(fakeWindow.lastMessageSignal?.aborted).toBe(true);
    expect(fakeWindow.messageListenerCount).toBe(0);
  });

  it("keeps the registration error authoritative when signal cleanup throws after abort", () => {
    const channel = new TestChannel("https://embed.ohmywallet.xyz");
    const nativeAddEventListener = fakeWindow.addEventListener.bind(fakeWindow);
    const nativeAbort = globalThis.AbortController.prototype.abort;
    const registrationError = new Error("message listener registration failed after native add");
    const cleanupError = new Error("signal cleanup failed after abort");
    let abortCalls = 0;
    const abort = vi
      .spyOn(globalThis.AbortController.prototype, "abort")
      .mockImplementation(function (this: AbortController) {
        abortCalls += 1;
        Reflect.apply(nativeAbort, this, []);
        throw cleanupError;
      });
    vi.spyOn(fakeWindow, "addEventListener").mockImplementation((type, listener, options) => {
      nativeAddEventListener(type, listener, options);
      throw registrationError;
    });

    try {
      expect(() => channel.listen()).toThrow(registrationError);
      expect(abortCalls).toBe(1);
      expect(channel.ownsMessageListener).toBe(false);
      expect(fakeWindow.messageListenerCount).toBe(0);
    } finally {
      abort.mockRestore();
    }
  });

  it("does not resurrect a listener when signal-blind registration destroys the channel", () => {
    const channel = new TestChannel("https://embed.ohmywallet.xyz");
    const nativeAddEventListener = fakeWindow.addEventListener.bind(fakeWindow);
    const removeEventListener = vi.spyOn(fakeWindow, "removeEventListener");
    vi.spyOn(fakeWindow, "addEventListener").mockImplementation((type, listener) => {
      channel.destroy();
      nativeAddEventListener(type, listener);
    });

    expect(() => channel.listen()).not.toThrow();
    expect(channel.isDestroyed).toBe(true);
    expect(channel.ownsMessageListener).toBe(false);
    expect(fakeWindow.lastMessageSignal).toBeNull();
    expect(removeEventListener).toHaveBeenCalledOnce();
    expect(fakeWindow.messageListenerCount).toBe(0);
  });

  it.each(["before", "after"] as const)(
    "finishes listener teardown when signal cleanup reenters and throws %s native abort",
    (throwPhase) => {
      const channel = new TestChannel("https://embed.ohmywallet.xyz");
      const nativeAbort = globalThis.AbortController.prototype.abort;
      const cleanupError = new Error(`${throwPhase} native abort failure`);
      let abortCalls = 0;
      const removeEventListener = vi.spyOn(fakeWindow, "removeEventListener");
      const abort = vi
        .spyOn(globalThis.AbortController.prototype, "abort")
        .mockImplementation(function (this: AbortController) {
          abortCalls += 1;
          channel.destroy();
          if (throwPhase === "before") throw cleanupError;
          Reflect.apply(nativeAbort, this, []);
          throw cleanupError;
        });

      try {
        channel.listen();
        expect(fakeWindow.messageListenerCount).toBe(1);

        expect(() => channel.destroy()).not.toThrow();
        expect(() => channel.destroy()).not.toThrow();
        expect(channel.isDestroyed).toBe(true);
        expect(channel.ownsMessageListener).toBe(false);
        expect(abortCalls).toBe(1);
        expect(removeEventListener).toHaveBeenCalledOnce();
        expect(fakeWindow.messageListenerCount).toBe(0);
      } finally {
        abort.mockRestore();
      }
    }
  );

  it("does not start listening after the channel is destroyed", () => {
    const channel = new TestChannel("https://embed.ohmywallet.xyz");

    channel.destroy();
    expect(() => channel.listen()).not.toThrow();

    expect(channel.isDestroyed).toBe(true);
    expect(channel.ownsMessageListener).toBe(false);
    expect(fakeWindow.messageListenerCount).toBe(0);
  });

  it("drains a hostile Promise-like message handler once without escaping dispatch", async () => {
    const channel = new TestChannel("https://embed.ohmywallet.xyz");
    let thenReads = 0;
    let thenCalls = 0;
    let rejectCalls = 0;
    const hostileThenable = Object.defineProperty({}, "then", {
      get: () => {
        thenReads += 1;
        return (_resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
          thenCalls += 1;
          rejectCalls += 1;
          reject(new Error("first async handler rejection"));
          rejectCalls += 1;
          reject(new Error("second async handler rejection"));
          throw new Error("handler thenable throw");
        };
      },
    });
    channel.on("CONNECT_RESULT", () => hostileThenable as never);
    channel.listen();

    expect(() =>
      fakeWindow.dispatch({
        origin: "https://embed.ohmywallet.xyz",
        source: null,
        data: {
          type: "CONNECT_RESULT",
          id: "message-handler-result",
          payload: {},
          timestamp: 1,
        },
      })
    ).not.toThrow();

    expect(thenReads).toBe(0);
    expect(thenCalls).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(thenReads).toBe(1);
    expect(thenCalls).toBe(1);
    expect(rejectCalls).toBe(2);
    channel.destroy();
  });

  it.each(["getter", "method"] as const)(
    "drains a rejected native Promise without invoking its own throwing then %s",
    async (trap) => {
      const channel = new TestChannel("https://embed.ohmywallet.xyz");
      const rejected = Promise.reject(new Error(`native ${trap} rejection`));
      Reflect.apply(Promise.prototype.then, rejected, [undefined, () => undefined]);
      let constructorReads = 0;
      let publicThenTouches = 0;
      Object.defineProperty(rejected, "constructor", {
        configurable: true,
        get: () => {
          constructorReads += 1;
          return Promise;
        },
      });
      Object.defineProperty(
        rejected,
        "then",
        trap === "getter"
          ? {
              configurable: true,
              get: () => {
                publicThenTouches += 1;
                throw new Error("own then getter must not run");
              },
            }
          : {
              configurable: true,
              value: () => {
                publicThenTouches += 1;
                throw new Error("own then method must not run");
              },
            }
      );
      channel.on("CONNECT_RESULT", () => rejected as never);
      channel.listen();

      expect(() => dispatchConnectResult()).not.toThrow();
      await flushHandlerDrain();

      expect(constructorReads).toBe(1);
      expect(publicThenTouches).toBe(0);
      channel.destroy();
    }
  );

  it("drains a rejected Promise subclass without invoking its overridden throwing then", async () => {
    class ThrowingThenPromise extends Promise<void> {}
    const channel = new TestChannel("https://embed.ohmywallet.xyz");
    const rejected = new ThrowingThenPromise((_resolve, reject) => {
      reject(new Error("subclass rejection"));
    });
    Reflect.apply(Promise.prototype.then, rejected, [undefined, () => undefined]);
    let speciesReads = 0;
    let publicThenCalls = 0;
    Object.defineProperty(ThrowingThenPromise, Symbol.species, {
      configurable: true,
      get: () => {
        speciesReads += 1;
        return Promise;
      },
    });
    Object.defineProperty(ThrowingThenPromise.prototype, "then", {
      configurable: true,
      value: () => {
        publicThenCalls += 1;
        throw new Error("subclass then override must not run");
      },
    });
    channel.on("CONNECT_RESULT", () => rejected as never);
    channel.listen();

    expect(() => dispatchConnectResult()).not.toThrow();
    await flushHandlerDrain();

    expect(speciesReads).toBe(1);
    expect(publicThenCalls).toBe(0);
    channel.destroy();
  });

  it("drains a cross-realm rejected Promise without invoking its hostile public then", async () => {
    const channel = new TestChannel("https://embed.ohmywallet.xyz");
    const vmSpecifier: string = "node:vm";
    const { runInNewContext } = (await import(vmSpecifier)) as {
      runInNewContext(source: string): unknown;
    };
    const rejected = runInNewContext(
      "Promise.reject(new Error('cross-realm rejection'))"
    ) as Promise<never>;
    Reflect.apply(Promise.prototype.then, rejected, [undefined, () => undefined]);
    let publicThenReads = 0;
    Object.defineProperty(rejected, "then", {
      configurable: true,
      get: () => {
        publicThenReads += 1;
        throw new Error("cross-realm public then must not run");
      },
    });
    channel.on("CONNECT_RESULT", () => rejected as never);
    channel.listen();

    expect(() => dispatchConnectResult()).not.toThrow();
    await flushHandlerDrain();

    expect(publicThenReads).toBe(0);
    channel.destroy();
  });

  it("drains a rejected reaction Promise returned by a custom species", async () => {
    class SourcePromise extends Promise<void> {}
    const channel = new TestChannel("https://embed.ohmywallet.xyz");
    const source = new SourcePromise((_resolve, reject) => {
      reject(new Error("source rejection"));
    });
    Reflect.apply(Promise.prototype.then, source, [undefined, () => undefined]);
    const reactionRejection = Promise.reject(new Error("species reaction rejection"));
    Reflect.apply(Promise.prototype.then, reactionRejection, [undefined, () => undefined]);
    let reactionConstructorReads = 0;
    let reactionPublicThenReads = 0;
    Object.defineProperty(reactionRejection, "constructor", {
      configurable: true,
      get: () => {
        reactionConstructorReads += 1;
        return Promise;
      },
    });
    Object.defineProperty(reactionRejection, "then", {
      configurable: true,
      get: () => {
        reactionPublicThenReads += 1;
        throw new Error("reaction public then must not run");
      },
    });
    const RejectedReactionSpecies = function (
      executor: (resolve: (value?: unknown) => void, reject: (reason?: unknown) => void) => void
    ): Promise<never> {
      executor(
        () => undefined,
        () => undefined
      );
      return reactionRejection;
    };
    Object.defineProperty(SourcePromise, Symbol.species, {
      configurable: true,
      value: RejectedReactionSpecies,
    });
    channel.on("CONNECT_RESULT", () => source as never);
    channel.listen();

    expect(() => dispatchConnectResult()).not.toThrow();
    await flushHandlerDrain();

    expect(reactionConstructorReads).toBe(1);
    expect(reactionPublicThenReads).toBe(0);
    channel.destroy();
  });

  it("continues to drain a normal rejected Promise asynchronously", async () => {
    const channel = new TestChannel("https://embed.ohmywallet.xyz");
    const trace: string[] = [];
    const rejected = Promise.reject(new Error("normal Promise rejection"));
    channel.on("CONNECT_RESULT", () => {
      trace.push("handler");
      return rejected as never;
    });
    channel.listen();

    expect(() => dispatchConnectResult()).not.toThrow();
    trace.push("dispatched");
    await flushHandlerDrain();

    expect(trace).toEqual(["handler", "dispatched"]);
    channel.destroy();
  });

  it("drains a cyclic generic thenable once", async () => {
    const channel = new TestChannel("https://embed.ohmywallet.xyz");
    let thenCalls = 0;
    const cyclicThenable = {
      then(resolve: (value: unknown) => void) {
        thenCalls += 1;
        resolve(cyclicThenable);
        return cyclicThenable;
      },
    };
    channel.on("CONNECT_RESULT", () => cyclicThenable as never);
    channel.listen();

    expect(() => dispatchConnectResult()).not.toThrow();
    await flushHandlerDrain();

    expect(thenCalls).toBe(1);
    channel.destroy();
  });

  it("finishes request and handler teardown when message listener removal throws", async () => {
    const channel = new TestChannel("https://embed.ohmywallet.xyz", 60_000);
    channel.on("CONNECT_RESULT", vi.fn());
    channel.listen();
    const request = channel.request("active-request");
    let requestError: unknown;
    let requestSettled = false;
    void request.catch((error: unknown) => {
      requestError = error;
      requestSettled = true;
    });
    const removalError = new Error("message listener removal failed");
    const removeEventListener = vi
      .spyOn(fakeWindow, "removeEventListener")
      .mockImplementation(() => {
        expect(channel.ownsMessageListener).toBe(false);
        throw removalError;
      });

    expect(() => channel.destroy()).not.toThrow();
    await Promise.resolve();

    expect(channel.isDestroyed).toBe(true);
    expect(channel.ownsMessageListener).toBe(false);
    expect(fakeWindow.messageListenerCount).toBe(0);
    expect(requestSettled).toBe(true);
    expect(requestError).toMatchObject({ code: "DESTROYED" });
    expect(channel.handlerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeEventListener).toHaveBeenCalledOnce();

    expect(() => channel.destroy()).not.toThrow();
    expect(channel.handlerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeEventListener).toHaveBeenCalledOnce();
  });
});

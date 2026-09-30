import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HostSurfaceContainerDisconnectedError,
  createHostSurface,
  type HostSurface,
  type HostSurfaceOptions,
} from "./host-surface";

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly style = { cssText: "", opacity: "", pointerEvents: "" };
  readonly attributes = new Map<string, string>();
  readonly focus = vi.fn(() => {
    if (this.isConnected) this.ownerDocument.focusElement(this);
  });
  readonly remove = vi.fn(() => {
    this.parentElement?.removeChild(this);
  });
  parentElement: FakeElement | null = null;
  id = "";
  inert = false;
  src = "";
  referrerPolicy = "";

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName: string
  ) {}

  get isConnected(): boolean {
    return this === this.ownerDocument.documentElement || this.parentElement?.isConnected === true;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement?.removeChild(child);
    this.children.push(child);
    child.parentElement = this;
    return child;
  }

  removeChild(child: FakeElement): void {
    const index = this.children.indexOf(child);
    if (index === -1) return;
    this.children.splice(index, 1);
    child.parentElement = null;
  }

  contains(other: FakeElement): boolean {
    let candidate: FakeElement | null = other;
    while (candidate) {
      if (candidate === this) return true;
      candidate = candidate.parentElement;
    }
    return false;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "inert") this.inert = true;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === "inert") this.inert = false;
  }
}

class FakeIframe extends FakeElement {
  readonly contentWindow = { focus: vi.fn() };
  title = "";

  constructor(ownerDocument: FakeDocument) {
    super(ownerDocument, "iframe");
  }
}

class FakeDocument {
  readonly documentElement: FakeElement;
  readonly body: FakeElement;
  activeElement: FakeElement | null;
  createdElementCount = 0;
  private readonly keydownListeners = new Set<(event: { key: string }) => void>();
  private readonly focusinListeners = new Set<(event: { target: FakeElement }) => void>();

  constructor() {
    this.documentElement = new FakeElement(this, "html");
    this.body = new FakeElement(this, "body");
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }

  createElement(tagName: string): FakeElement {
    this.createdElementCount += 1;
    return tagName === "iframe" ? new FakeIframe(this) : new FakeElement(this, tagName);
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    if (type === "keydown") {
      this.keydownListeners.add(listener as unknown as (event: { key: string }) => void);
    }
    if (type === "focusin") {
      this.focusinListeners.add(listener as unknown as (event: { target: FakeElement }) => void);
    }
  }

  removeEventListener(type: string, listener: (event: never) => void): void {
    if (type === "keydown") {
      this.keydownListeners.delete(listener as unknown as (event: { key: string }) => void);
    }
    if (type === "focusin") {
      this.focusinListeners.delete(listener as unknown as (event: { target: FakeElement }) => void);
    }
  }

  dispatchKey(key: string): void {
    for (const listener of this.keydownListeners) listener({ key });
  }

  focusElement(element: FakeElement): void {
    this.activeElement = element;
    for (const listener of this.focusinListeners) listener({ target: element });
  }

  get keydownListenerCount(): number {
    return this.keydownListeners.size;
  }

  get focusinListenerCount(): number {
    return this.focusinListeners.size;
  }

  clearKeydownListeners(): void {
    this.keydownListeners.clear();
  }
}

class FakeMutationObserver {
  static readonly instances: FakeMutationObserver[] = [];
  static observeError: Error | null = null;

  readonly observe = vi.fn(
    (
      target: unknown,
      options: {
        attributes?: boolean;
        attributeFilter?: string[];
        attributeOldValue?: boolean;
        childList?: boolean;
        subtree?: boolean;
      }
    ) => {
      const error = FakeMutationObserver.observeError;
      FakeMutationObserver.observeError = null;
      if (error) throw error;
      this.observedTarget = target as FakeElement;
      this.observedOptions = options;
    }
  );
  readonly disconnect = vi.fn(() => {
    this.disconnected = true;
    this.pendingRecords.length = 0;
  });
  readonly takeRecords = vi.fn(() => this.pendingRecords.splice(0));
  private disconnected = false;
  private readonly pendingRecords: MutationRecord[] = [];
  private observedOptions: {
    attributes?: boolean;
    attributeFilter?: string[];
    attributeOldValue?: boolean;
    childList?: boolean;
    subtree?: boolean;
  } | null = null;
  private observedTarget: FakeElement | null = null;
  callbackCount = 0;

  constructor(
    private readonly callback: (records: MutationRecord[], observer: MutationObserver) => void
  ) {
    FakeMutationObserver.instances.push(this);
  }

  flush(records: MutationRecord[] = []): void {
    if (!this.disconnected) {
      this.callbackCount += 1;
      this.callback(records, this as unknown as MutationObserver);
    }
  }

  enqueue(records: MutationRecord[]): void {
    if (!this.disconnected) this.pendingRecords.push(...records);
  }

  observesAttribute(target: FakeElement, name: string): boolean {
    if (this.disconnected || !this.observedOptions?.attributes || !this.observedTarget)
      return false;
    if (
      this.observedOptions.attributeFilter &&
      !this.observedOptions.attributeFilter.includes(name)
    ) {
      return false;
    }
    return (
      target === this.observedTarget ||
      (this.observedOptions.subtree === true && this.observedTarget.contains(target))
    );
  }

  get isDisconnected(): boolean {
    return this.disconnected;
  }

  static reset(): void {
    FakeMutationObserver.instances.length = 0;
    FakeMutationObserver.observeError = null;
  }
}

let fakeDocument: FakeDocument;
let surfaces: HostSurface[];

beforeEach(() => {
  fakeDocument = new FakeDocument();
  surfaces = [];
  FakeMutationObserver.reset();
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("MutationObserver", FakeMutationObserver);
});

afterEach(() => {
  for (const surface of surfaces.reverse()) surface.destroy();
  expect(fakeDocument.keydownListenerCount).toBe(0);
  expect(fakeDocument.focusinListenerCount).toBe(0);
  expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);
  vi.unstubAllGlobals();
});

function element(tagName = "div"): FakeElement {
  return fakeDocument.createElement(tagName);
}

function mount(parent: FakeElement, child: FakeElement): FakeElement {
  parent.appendChild(child);
  return child;
}

function makeSurface(overrides: Partial<HostSurfaceOptions> = {}): HostSurface {
  const surface = createHostSurface({
    iframeSrc: "https://embed.ohmywallet.xyz/en",
    sandbox: "allow-scripts",
    onEscape: vi.fn(),
    onDisconnect: vi.fn(),
    ...overrides,
  });
  surfaces.push(surface);
  return surface;
}

function asHTMLElement(value: FakeElement): HTMLElement {
  return value as unknown as HTMLElement;
}

function makeInertChannelsIndependent(element: FakeElement): void {
  let inertValue = element.inert;
  const setAttribute = element.setAttribute.bind(element);
  const removeAttribute = element.removeAttribute.bind(element);
  Object.defineProperty(element, "inert", {
    configurable: true,
    get: () => inertValue,
    set: (value: boolean) => {
      inertValue = value;
    },
  });
  vi.spyOn(element, "setAttribute").mockImplementation((name, value) => {
    if (name === "inert") {
      element.attributes.set(name, value);
      return;
    }
    setAttribute(name, value);
  });
  vi.spyOn(element, "removeAttribute").mockImplementation((name) => {
    if (name === "inert") {
      element.attributes.delete(name);
      return;
    }
    removeAttribute(name);
  });
}

function makeInertPropertyReflectAttribute(element: FakeElement): void {
  let inertValue = element.hasAttribute("inert");
  const setAttribute = element.setAttribute.bind(element);
  const removeAttribute = element.removeAttribute.bind(element);
  Object.defineProperty(element, "inert", {
    configurable: true,
    get: () => inertValue,
    set: (value: boolean) => {
      inertValue = value;
      if (value) element.attributes.set("inert", "");
      else element.attributes.delete("inert");
    },
  });
  vi.spyOn(element, "setAttribute").mockImplementation((name, value) => {
    if (name === "inert") {
      element.attributes.set(name, value);
      inertValue = true;
      return;
    }
    setAttribute(name, value);
  });
  vi.spyOn(element, "removeAttribute").mockImplementation((name) => {
    if (name === "inert") {
      element.attributes.delete(name);
      inertValue = false;
      return;
    }
    removeAttribute(name);
  });
}

function makeInertPropertyRemovalReactive(
  element: FakeElement,
  reactionValue = "component-lock"
): () => void {
  let inertValue = element.hasAttribute("inert");
  let reactOnRemoval = false;
  const setAttribute = element.setAttribute.bind(element);
  const removeAttribute = element.removeAttribute.bind(element);
  const enqueueMutation = (oldValue: string | null): void => {
    for (const observer of FakeMutationObserver.instances) {
      if (observer.observesAttribute(element, "inert")) {
        observer.enqueue([attributeRecord(element, "inert", oldValue)]);
      }
    }
  };
  Object.defineProperty(element, "inert", {
    configurable: true,
    get: () => inertValue,
    set: (value: boolean) => {
      if (value) element.setAttribute("inert", "");
      else element.removeAttribute("inert");
    },
  });
  vi.spyOn(element, "setAttribute").mockImplementation((name, value) => {
    if (name !== "inert") {
      setAttribute(name, value);
      return;
    }
    const oldValue = element.getAttribute(name);
    element.attributes.set(name, value);
    inertValue = true;
    enqueueMutation(oldValue);
  });
  vi.spyOn(element, "removeAttribute").mockImplementation((name) => {
    if (name !== "inert") {
      removeAttribute(name);
      return;
    }
    const oldValue = element.getAttribute(name);
    element.attributes.delete(name);
    inertValue = false;
    if (oldValue !== null) enqueueMutation(oldValue);
    if (!reactOnRemoval || oldValue === null) return;
    reactOnRemoval = false;
    element.setAttribute("inert", reactionValue);
  });
  return () => {
    reactOnRemoval = true;
  };
}

function overlayOf(surface: HostSurface): FakeElement {
  const iframe = surface.iframe as unknown as FakeElement;
  const overlay = iframe.parentElement?.parentElement;
  if (!overlay) throw new Error("Surface overlay is missing");
  return overlay;
}

function removalRecord(...removedNodes: FakeElement[]): MutationRecord {
  return { removedNodes } as unknown as MutationRecord;
}

function childListRecord({
  addedNodes = [],
  removedNodes = [],
}: {
  addedNodes?: FakeElement[];
  removedNodes?: FakeElement[];
}): MutationRecord {
  return { addedNodes, removedNodes } as unknown as MutationRecord;
}

function attributeRecord(
  target: FakeElement,
  attributeName: "aria-hidden" | "inert",
  oldValue: string | null
): MutationRecord {
  return {
    addedNodes: [],
    attributeName,
    oldValue,
    removedNodes: [],
    target,
    type: "attributes",
  } as unknown as MutationRecord;
}

function flushPendingMutations(observer: FakeMutationObserver): void {
  for (let pass = 0; pass < 16; pass += 1) {
    const records = observer.takeRecords();
    if (records.length === 0) return;
    observer.flush(records);
  }
  throw new Error("Mutation observer did not settle");
}

describe("HostSurface mounting", () => {
  it("mounts a hidden, labelled dialog in document.body by default", () => {
    const surface = makeSurface();
    const iframe = surface.iframe as unknown as FakeIframe;
    const overlay = overlayOf(surface);

    expect(overlay.parentElement).toBe(fakeDocument.body);
    expect(overlay.getAttribute("role")).toBe("dialog");
    expect(overlay.getAttribute("aria-modal")).toBe("true");
    expect(overlay.getAttribute("aria-label")).toBe("OhMyWallet");
    expect(overlay.inert).toBe(true);
    expect(overlay.hasAttribute("inert")).toBe(true);
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    expect(overlay.style.opacity).toBe("0");
    expect(overlay.style.pointerEvents).toBe("none");
    expect(iframe.src).toBe("https://embed.ohmywallet.xyz/en");
    expect(iframe.title).toBe("OhMyWallet");
    expect(iframe.referrerPolicy).toBe("no-referrer");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(FakeMutationObserver.instances).toHaveLength(0);
  });

  it("mounts in the exact connected configured container", () => {
    const container = mount(fakeDocument.body, element("section"));
    const surface = makeSurface({ container: asHTMLElement(container) });

    expect(overlayOf(surface).parentElement).toBe(container);
    expect(FakeMutationObserver.instances).toHaveLength(1);
    expect(FakeMutationObserver.instances[0].observe).toHaveBeenCalledWith(
      fakeDocument.documentElement,
      { childList: true, subtree: true }
    );
  });

  it("throws a typed condition before creating DOM for a disconnected container", () => {
    const container = element("section");
    const creationsBefore = fakeDocument.createdElementCount;

    expect(() =>
      createHostSurface({
        container: asHTMLElement(container),
        iframeSrc: "https://embed.ohmywallet.xyz/en",
        sandbox: "allow-scripts",
        onEscape: vi.fn(),
        onDisconnect: vi.fn(),
      })
    ).toThrow(HostSurfaceContainerDisconnectedError);

    expect(fakeDocument.createdElementCount).toBe(creationsBefore);
    expect(FakeMutationObserver.instances).toHaveLength(0);
  });

  it("rejects foreign-document and unreachable light-DOM containers before creating DOM", () => {
    const foreignDocument = new FakeDocument();
    const foreignContainer = mount(foreignDocument.body, foreignDocument.createElement("section"));
    const unreachableContainer = element("section");
    Object.defineProperty(unreachableContainer, "isConnected", {
      configurable: true,
      get: () => true,
    });
    const creationsBefore = fakeDocument.createdElementCount;

    for (const container of [foreignContainer, unreachableContainer]) {
      let unexpectedSurface: HostSurface | null = null;
      let creationError: unknown;
      try {
        unexpectedSurface = createHostSurface({
          container: asHTMLElement(container),
          iframeSrc: "https://embed.ohmywallet.xyz/en",
          sandbox: "allow-scripts",
          onEscape: vi.fn(),
          onDisconnect: vi.fn(),
        });
      } catch (error) {
        creationError = error;
      }
      unexpectedSurface?.destroy();
      expect(creationError).toBeInstanceOf(HostSurfaceContainerDisconnectedError);
    }

    expect(fakeDocument.createdElementCount).toBe(creationsBefore);
    expect(FakeMutationObserver.instances).toHaveLength(0);
  });

  it("rolls back the mounted DOM and observer when configured-container observation throws", () => {
    const container = mount(fakeDocument.body, element("section"));
    const observeError = new Error("observe failed");
    FakeMutationObserver.observeError = observeError;

    expect(() =>
      createHostSurface({
        container: asHTMLElement(container),
        iframeSrc: "https://embed.ohmywallet.xyz/en",
        sandbox: "allow-scripts",
        onEscape: vi.fn(),
        onDisconnect: vi.fn(),
      })
    ).toThrow(observeError);

    expect(container.children).toHaveLength(0);
    expect(FakeMutationObserver.instances).toHaveLength(1);
    expect(FakeMutationObserver.instances[0].disconnect).toHaveBeenCalledOnce();
    expect(fakeDocument.keydownListenerCount).toBe(0);
    expect(fakeDocument.focusinListenerCount).toBe(0);

    const retrySurface = makeSurface({ container: asHTMLElement(container) });
    expect(container.children).toEqual([overlayOf(retrySurface)]);
  });

  it("rolls back an overlay adopted before configured-container append throws", () => {
    const container = mount(fakeDocument.body, element("wallet-container"));
    const appendChild = container.appendChild.bind(container);
    const appendError = new Error("append failed after adoption");
    let throwAfterAppend = true;
    vi.spyOn(container, "appendChild").mockImplementation((child) => {
      const appended = appendChild(child);
      if (throwAfterAppend) throw appendError;
      return appended;
    });

    expect(() =>
      createHostSurface({
        container: asHTMLElement(container),
        iframeSrc: "https://embed.ohmywallet.xyz/en",
        sandbox: "allow-scripts",
        onEscape: vi.fn(),
        onDisconnect: vi.fn(),
      })
    ).toThrow(appendError);

    expect(container.children).toHaveLength(0);
    expect(FakeMutationObserver.instances).toHaveLength(1);
    expect(FakeMutationObserver.instances[0].disconnect).toHaveBeenCalledOnce();
    expect(fakeDocument.keydownListenerCount).toBe(0);
    expect(fakeDocument.focusinListenerCount).toBe(0);

    throwAfterAppend = false;
    const retrySurface = makeSurface({ container: asHTMLElement(container) });
    expect(container.children).toEqual([overlayOf(retrySurface)]);
  });

  it("uses captured owned-node cleanup when adopted overlay removal is replaced and append throws", () => {
    const container = mount(fakeDocument.body, element("wallet-container"));
    const appendChild = container.appendChild.bind(container);
    const appendError = new Error("append failed after hostile adoption");
    const capturedRemoveError = new Error("captured overlay removal failed");
    const replacementRemove = vi.fn(() => {
      throw new Error("replacement overlay removal failed");
    });
    let throwAfterAppend = true;
    vi.spyOn(container, "appendChild").mockImplementation((child) => {
      const appended = appendChild(child);
      if (!throwAfterAppend) return appended;
      throwAfterAppend = false;
      child.remove.mockImplementation(() => {
        throw capturedRemoveError;
      });
      Object.defineProperty(child, "remove", {
        configurable: true,
        value: replacementRemove,
      });
      throw appendError;
    });

    expect(() =>
      createHostSurface({
        container: asHTMLElement(container),
        iframeSrc: "https://embed.ohmywallet.xyz/en",
        sandbox: "allow-scripts",
        onEscape: vi.fn(),
        onDisconnect: vi.fn(),
      })
    ).toThrow(appendError);

    expect(container.children).toHaveLength(0);
    expect(FakeMutationObserver.instances).toHaveLength(1);
    expect(FakeMutationObserver.instances[0].disconnect).toHaveBeenCalledOnce();

    const retrySurface = makeSurface({ container: asHTMLElement(container) });
    expect(container.children).toEqual([overlayOf(retrySurface)]);
  });

  it("rejects a configured container transiently removed during overlay append", () => {
    const parent = mount(fakeDocument.body, element("div"));
    const container = mount(parent, element("wallet-container"));
    const appendChild = container.appendChild.bind(container);
    const onDisconnect = vi.fn();
    let detachDuringAppend = true;
    vi.spyOn(container, "appendChild").mockImplementation((child) => {
      const appended = appendChild(child);
      if (!detachDuringAppend) return appended;
      detachDuringAppend = false;
      container.remove();
      parent.appendChild(container);
      FakeMutationObserver.instances
        .at(-1)
        ?.enqueue([
          childListRecord({ removedNodes: [container] }),
          childListRecord({ addedNodes: [container] }),
        ]);
      return appended;
    });

    let creationError: unknown;
    let unexpectedSurface: HostSurface | null = null;
    try {
      unexpectedSurface = createHostSurface({
        container: asHTMLElement(container),
        iframeSrc: "https://embed.ohmywallet.xyz/en",
        sandbox: "allow-scripts",
        onEscape: vi.fn(),
        onDisconnect,
      });
    } catch (error) {
      creationError = error;
    }
    unexpectedSurface?.destroy();

    expect(creationError).toBeInstanceOf(HostSurfaceContainerDisconnectedError);
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(container.children).toHaveLength(0);
    expect(fakeDocument.keydownListenerCount).toBe(0);
    expect(fakeDocument.focusinListenerCount).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);

    const retrySurface = makeSurface({ container: asHTMLElement(container) });
    expect(container.children).toEqual([overlayOf(retrySurface)]);
  });
});

describe("HostSurface modal isolation", () => {
  it("keeps all active overlay paths protected when surfaces close out of order", () => {
    const background = mount(fakeDocument.body, element("main"));
    const preservedBackground = mount(fakeDocument.body, element("aside"));
    preservedBackground.setAttribute("inert", "baseline-inert");
    preservedBackground.setAttribute("aria-hidden", "false");
    const nestedBranch = mount(fakeDocument.body, element("div"));
    const container = mount(nestedBranch, element("section"));
    const containerSibling = mount(container, element("nav"));
    const surfaceA = makeSurface();
    const surfaceB = makeSurface({ container: asHTMLElement(container) });
    const overlayA = overlayOf(surfaceA);
    const overlayB = overlayOf(surfaceB);

    surfaceA.show(null);
    surfaceB.show(null);

    for (const activePathElement of [overlayA, overlayB, container, nestedBranch]) {
      expect(activePathElement.inert).toBe(false);
      expect(activePathElement.hasAttribute("inert")).toBe(false);
      expect(activePathElement.hasAttribute("aria-hidden")).toBe(false);
    }
    for (const isolated of [background, preservedBackground, containerSibling]) {
      expect(isolated.inert).toBe(true);
      expect(isolated.getAttribute("aria-hidden")).toBe("true");
    }

    surfaceA.hide({ restoreFocus: false });
    surfaceA.destroy();

    expect(overlayA.parentElement).toBeNull();
    for (const activePathElement of [overlayB, container, nestedBranch]) {
      expect(activePathElement.inert).toBe(false);
      expect(activePathElement.hasAttribute("aria-hidden")).toBe(false);
    }
    expect(background.inert).toBe(true);
    expect(background.getAttribute("aria-hidden")).toBe("true");
    expect(preservedBackground.inert).toBe(true);
    expect(preservedBackground.getAttribute("aria-hidden")).toBe("true");
    expect(fakeDocument.keydownListenerCount).toBe(1);

    surfaceB.hide({ restoreFocus: false });

    expect(background.inert).toBe(false);
    expect(background.hasAttribute("inert")).toBe(false);
    expect(background.hasAttribute("aria-hidden")).toBe(false);
    expect(preservedBackground.inert).toBe(true);
    expect(preservedBackground.getAttribute("inert")).toBe("baseline-inert");
    expect(preservedBackground.getAttribute("aria-hidden")).toBe("false");
    expect(containerSibling.inert).toBe(false);
    expect(containerSibling.hasAttribute("inert")).toBe(false);
    expect(containerSibling.hasAttribute("aria-hidden")).toBe(false);
    expect(fakeDocument.keydownListenerCount).toBe(0);
  });

  it("restores the original document focus only after the final surface closes", () => {
    const trigger = mount(fakeDocument.body, element("button"));
    const surfaceA = makeSurface();
    const surfaceB = makeSurface();
    const iframeA = surfaceA.iframe as unknown as FakeIframe;
    const iframeB = surfaceB.iframe as unknown as FakeIframe;
    fakeDocument.activeElement = trigger;

    surfaceA.show(trigger as unknown as Element);
    surfaceB.show(null);
    surfaceA.hide({ restoreFocus: true });

    expect(trigger.focus).not.toHaveBeenCalled();
    expect(iframeA.focus).toHaveBeenCalledOnce();
    expect(fakeDocument.activeElement).toBe(iframeB);
    expect(fakeDocument.focusinListenerCount).toBe(1);

    surfaceB.hide({ restoreFocus: true });

    expect(trigger.focus).toHaveBeenCalledOnce();
    expect(fakeDocument.activeElement).toBe(trigger);
    expect(fakeDocument.focusinListenerCount).toBe(0);
  });

  it("isolates every sibling on the overlay-to-body path without inerting its ancestors", () => {
    const pageSibling = mount(fakeDocument.body, element("main"));
    const branch = mount(fakeDocument.body, element("div"));
    const branchSibling = mount(branch, element("aside"));
    const container = mount(branch, element("section"));
    const containerSibling = mount(container, element("nav"));
    const surface = makeSurface({ container: asHTMLElement(container) });

    surface.show(null);

    for (const sibling of [pageSibling, branchSibling, containerSibling]) {
      expect(sibling.inert).toBe(true);
      expect(sibling.getAttribute("aria-hidden")).toBe("true");
    }
    for (const ancestor of [container, branch, fakeDocument.body]) {
      expect(ancestor.inert).toBe(false);
      expect(ancestor.hasAttribute("inert")).toBe(false);
      expect(ancestor.hasAttribute("aria-hidden")).toBe(false);
    }
  });

  it("restores exact pre-existing inert and aria-hidden presence and values", () => {
    const pageSibling = mount(fakeDocument.body, element("main"));
    pageSibling.setAttribute("inert", "page-lock");
    pageSibling.setAttribute("aria-hidden", "false");
    const branch = mount(fakeDocument.body, element("div"));
    const branchSibling = mount(branch, element("aside"));
    branchSibling.setAttribute("aria-hidden", "presentation");
    const container = mount(branch, element("section"));
    const containerSibling = mount(container, element("nav"));
    containerSibling.setAttribute("aria-hidden", "");
    const surface = makeSurface({ container: asHTMLElement(container) });

    surface.show(null);
    surface.hide({ restoreFocus: false });

    expect(pageSibling.inert).toBe(true);
    expect(pageSibling.getAttribute("inert")).toBe("page-lock");
    expect(pageSibling.getAttribute("aria-hidden")).toBe("false");
    expect(branchSibling.inert).toBe(false);
    expect(branchSibling.hasAttribute("inert")).toBe(false);
    expect(branchSibling.getAttribute("aria-hidden")).toBe("presentation");
    expect(containerSibling.inert).toBe(false);
    expect(containerSibling.hasAttribute("inert")).toBe(false);
    expect(containerSibling.getAttribute("aria-hidden")).toBe("");
  });

  it.each([
    { ownerCount: 1, pending: false, propertyFirst: false },
    { ownerCount: 2, pending: true, propertyFirst: true },
  ])(
    "restores independent inert property and attribute baselines with $ownerCount owner(s)",
    ({ ownerCount, pending, propertyFirst }) => {
      const background = mount(fakeDocument.body, element("main"));
      makeInertChannelsIndependent(background);
      const owners = Array.from({ length: ownerCount }, () => makeSurface());
      for (const owner of owners) owner.show(null);
      const coordinatorObserver = FakeMutationObserver.instances[0];
      coordinatorObserver.flush([
        attributeRecord(background, "inert", null),
        attributeRecord(background, "aria-hidden", null),
      ]);

      if (propertyFirst) background.inert = false;
      background.setAttribute("inert", "application-lock");
      if (!propertyFirst) background.inert = false;
      const records = [attributeRecord(background, "inert", "")];
      if (pending) coordinatorObserver.enqueue(records);
      else coordinatorObserver.flush(records);

      for (const owner of owners.reverse()) owner.hide({ restoreFocus: false });

      expect(background.getAttribute("inert")).toBe("application-lock");
      expect(background.inert).toBe(false);
    }
  );

  it("captures an independent inert property divergence before child reconciliation reasserts it", () => {
    const background = mount(fakeDocument.body, element("main"));
    makeInertChannelsIndependent(background);
    background.inert = true;
    const surface = makeSurface();
    surface.show(null);
    const coordinatorObserver = FakeMutationObserver.instances[0];
    coordinatorObserver.flush([
      attributeRecord(background, "inert", null),
      attributeRecord(background, "aria-hidden", null),
    ]);

    background.inert = false;
    const lateSibling = mount(fakeDocument.body, element("button"));
    coordinatorObserver.flush([childListRecord({ addedNodes: [lateSibling] })]);
    expect(background.inert).toBe(true);

    surface.hide({ restoreFocus: false });

    expect(background.hasAttribute("inert")).toBe(false);
    expect(background.inert).toBe(false);
  });

  it("restores an application inert attribute after SDK property cleanup on a reflected channel", () => {
    const background = mount(fakeDocument.body, element("main"));
    makeInertPropertyReflectAttribute(background);
    const surface = makeSurface();
    surface.show(null);
    const coordinatorObserver = FakeMutationObserver.instances[0];
    coordinatorObserver.flush([
      attributeRecord(background, "inert", null),
      attributeRecord(background, "aria-hidden", null),
    ]);

    background.setAttribute("inert", "application-lock");
    coordinatorObserver.flush([attributeRecord(background, "inert", "")]);
    coordinatorObserver.enqueue([attributeRecord(background, "inert", "application-lock")]);
    surface.hide({ restoreFocus: false });

    expect(background.getAttribute("inert")).toBe("application-lock");
    expect(background.inert).toBe(true);
  });

  it.each([
    { delivered: false, ownerCount: 1 },
    { delivered: true, ownerCount: 1 },
    { delivered: false, ownerCount: 2 },
    { delivered: true, ownerCount: 2 },
  ])(
    "preserves a synchronous component inert reaction with $ownerCount owner(s), delivered=$delivered",
    ({ delivered, ownerCount }) => {
      const background = mount(fakeDocument.body, element("wallet-background"));
      const reactOnNextRemoval = makeInertPropertyRemovalReactive(background);
      const owners = Array.from({ length: ownerCount }, () => makeSurface());
      for (const owner of owners) owner.show(null);
      const coordinatorObserver = FakeMutationObserver.instances[0];
      if (delivered) flushPendingMutations(coordinatorObserver);

      reactOnNextRemoval();
      for (const owner of owners.reverse()) owner.hide({ restoreFocus: false });

      expect(background.getAttribute("inert")).toBe("component-lock");
      expect(background.inert).toBe(true);
    }
  );

  it("preserves a canonical synchronous inert reaction while restoring a detached element", () => {
    const background = mount(fakeDocument.body, element("wallet-background"));
    const reactOnNextRemoval = makeInertPropertyRemovalReactive(background, "");
    const surface = makeSurface();
    surface.show(null);
    const coordinatorObserver = FakeMutationObserver.instances[0];
    flushPendingMutations(coordinatorObserver);

    reactOnNextRemoval();
    background.remove();
    coordinatorObserver.flush([childListRecord({ removedNodes: [background] })]);

    expect(background.isConnected).toBe(false);
    expect(background.getAttribute("inert")).toBe("");
    expect(background.inert).toBe(true);
  });

  it("preserves a canonical inert reaction during nested owner-disconnect settlement", () => {
    const background = mount(fakeDocument.body, element("wallet-background"));
    const reactOnNextRemoval = makeInertPropertyRemovalReactive(background, "");
    const onDisconnect = vi.fn();
    const surface = makeSurface({ onDisconnect });
    const overlay = overlayOf(surface);
    surface.show(null);
    const coordinatorObserver = FakeMutationObserver.instances[0];
    flushPendingMutations(coordinatorObserver);

    reactOnNextRemoval();
    overlay.remove();
    coordinatorObserver.enqueue([childListRecord({ removedNodes: [overlay] })]);
    surface.hide({ restoreFocus: false });

    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(background.getAttribute("inert")).toBe("");
    expect(background.inert).toBe(true);
    expect(fakeDocument.keydownListenerCount).toBe(0);
    expect(fakeDocument.focusinListenerCount).toBe(0);
  });

  it.each([
    { delivered: false, ownerCount: 1 },
    { delivered: true, ownerCount: 1 },
    { delivered: false, ownerCount: 2 },
    { delivered: true, ownerCount: 2 },
  ])(
    "preserves a canonical synchronous inert reaction with $ownerCount owner(s), delivered=$delivered",
    ({ delivered, ownerCount }) => {
      const background = mount(fakeDocument.body, element("wallet-background"));
      const reactOnNextRemoval = makeInertPropertyRemovalReactive(background, "");
      const owners = Array.from({ length: ownerCount }, () => makeSurface());
      for (const owner of owners) owner.show(null);
      const coordinatorObserver = FakeMutationObserver.instances[0];
      if (delivered) flushPendingMutations(coordinatorObserver);

      reactOnNextRemoval();
      for (const owner of owners.reverse()) owner.hide({ restoreFocus: false });

      expect(background.getAttribute("inert")).toBe("");
      expect(background.inert).toBe(true);
    }
  );

  it.each([
    {
      expectedAttribute: null,
      mutate: (background: FakeElement) => background.removeAttribute("inert"),
      ownerCount: 1,
    },
    {
      expectedAttribute: "application-lock",
      mutate: (background: FakeElement) => background.setAttribute("inert", "application-lock"),
      ownerCount: 2,
    },
  ])(
    "does not copy an SDK-owned inert property into a pending attribute-only baseline with $ownerCount owner(s)",
    ({ expectedAttribute, mutate, ownerCount }) => {
      const background = mount(fakeDocument.body, element("main"));
      makeInertChannelsIndependent(background);
      const owners = Array.from({ length: ownerCount }, () => makeSurface());
      for (const owner of owners) owner.show(null);
      const coordinatorObserver = FakeMutationObserver.instances[0];
      coordinatorObserver.flush([
        attributeRecord(background, "inert", null),
        attributeRecord(background, "aria-hidden", null),
      ]);

      mutate(background);
      expect(background.inert).toBe(true);
      coordinatorObserver.enqueue([attributeRecord(background, "inert", "")]);
      for (const owner of owners.reverse()) owner.hide({ restoreFocus: false });

      expect(background.getAttribute("inert")).toBe(expectedAttribute);
      expect(background.inert).toBe(false);
    }
  );

  it.each([
    {
      name: "inert removal",
      mutate: (background: FakeElement) => background.removeAttribute("inert"),
      records: (background: FakeElement) => [attributeRecord(background, "inert", "")],
      expectedInert: false,
      expectedInertAttribute: null,
      expectedAriaHidden: "presentation",
    },
    {
      name: "aria-hidden change",
      mutate: (background: FakeElement) => background.setAttribute("aria-hidden", "false"),
      records: (background: FakeElement) => [attributeRecord(background, "aria-hidden", "true")],
      expectedInert: true,
      expectedInertAttribute: "initial-lock",
      expectedAriaHidden: "false",
    },
    {
      name: "both channels",
      mutate: (background: FakeElement) => {
        background.removeAttribute("inert");
        background.setAttribute("aria-hidden", "false");
      },
      records: (background: FakeElement) => [
        attributeRecord(background, "inert", ""),
        attributeRecord(background, "aria-hidden", "true"),
      ],
      expectedInert: false,
      expectedInertAttribute: null,
      expectedAriaHidden: "false",
    },
  ])(
    "re-isolates a connected sibling after live $name and restores that channel's latest baseline",
    ({ mutate, records, expectedInert, expectedInertAttribute, expectedAriaHidden }) => {
      const background = mount(fakeDocument.body, element("main"));
      background.setAttribute("inert", "initial-lock");
      background.setAttribute("aria-hidden", "presentation");
      const surface = makeSurface();

      surface.show(null);
      const coordinatorObserver = FakeMutationObserver.instances[0];
      expect(coordinatorObserver.observe).toHaveBeenCalledWith(fakeDocument.documentElement, {
        attributes: true,
        attributeFilter: ["inert", "aria-hidden"],
        attributeOldValue: true,
        childList: true,
        subtree: true,
      });

      coordinatorObserver.flush([
        attributeRecord(background, "inert", "initial-lock"),
        attributeRecord(background, "aria-hidden", "presentation"),
      ]);
      mutate(background);
      coordinatorObserver.flush(records(background));

      expect(background.inert).toBe(true);
      expect(background.getAttribute("inert")).toBe("");
      expect(background.getAttribute("aria-hidden")).toBe("true");

      surface.hide({ restoreFocus: false });

      expect(background.inert).toBe(expectedInert);
      expect(background.getAttribute("inert")).toBe(expectedInertAttribute);
      expect(background.getAttribute("aria-hidden")).toBe(expectedAriaHidden);
    }
  );

  it.each([
    {
      name: "one owner with an aria-hidden change",
      ownerCount: 1,
      mutate: (background: FakeElement) => background.setAttribute("aria-hidden", "false"),
      records: (background: FakeElement) => [attributeRecord(background, "aria-hidden", "true")],
      expectedInertAttribute: "initial-lock",
      expectedAriaHidden: "false",
    },
    {
      name: "two owners with mixed-channel changes",
      ownerCount: 2,
      mutate: (background: FakeElement) => {
        background.removeAttribute("inert");
        background.setAttribute("aria-hidden", "false");
      },
      records: (background: FakeElement) => [
        attributeRecord(background, "inert", ""),
        attributeRecord(background, "aria-hidden", "true"),
      ],
      expectedInertAttribute: null,
      expectedAriaHidden: "false",
    },
  ])(
    "settles pending application attribute records before synchronously hiding $name",
    ({ ownerCount, mutate, records, expectedInertAttribute, expectedAriaHidden }) => {
      const background = mount(fakeDocument.body, element("main"));
      background.setAttribute("inert", "initial-lock");
      background.setAttribute("aria-hidden", "presentation");
      const owners = Array.from({ length: ownerCount }, () => makeSurface());
      for (const owner of owners) owner.show(null);
      const coordinatorObserver = FakeMutationObserver.instances[0];
      coordinatorObserver.flush([
        attributeRecord(background, "inert", "initial-lock"),
        attributeRecord(background, "aria-hidden", "presentation"),
      ]);
      coordinatorObserver.callbackCount = 0;

      mutate(background);
      coordinatorObserver.enqueue(records(background));
      for (const owner of owners.reverse()) owner.hide({ restoreFocus: false });

      expect(coordinatorObserver.callbackCount).toBe(0);
      expect(background.getAttribute("inert")).toBe(expectedInertAttribute);
      expect(background.getAttribute("aria-hidden")).toBe(expectedAriaHidden);
      expect(coordinatorObserver.takeRecords).toHaveBeenCalled();
    }
  );

  it("isolates body and ancestor-path siblings inserted while a surface is shown", () => {
    const branch = mount(fakeDocument.body, element("div"));
    const container = mount(branch, element("section"));
    const surface = makeSurface({ container: asHTMLElement(container) });

    surface.show(null);

    expect(FakeMutationObserver.instances).toHaveLength(2);
    const coordinatorObserver = FakeMutationObserver.instances[1];
    expect(coordinatorObserver.observe).toHaveBeenCalledWith(fakeDocument.documentElement, {
      attributes: true,
      attributeFilter: ["inert", "aria-hidden"],
      attributeOldValue: true,
      childList: true,
      subtree: true,
    });

    const bodyButton = mount(fakeDocument.body, element("button"));
    const branchButton = element("button");
    branchButton.setAttribute("aria-hidden", "false");
    mount(branch, branchButton);
    coordinatorObserver.flush([childListRecord({ addedNodes: [bodyButton, branchButton] })]);

    for (const sibling of [bodyButton, branchButton]) {
      expect(sibling.inert).toBe(true);
      expect(sibling.getAttribute("aria-hidden")).toBe("true");
    }

    surface.hide({ restoreFocus: false });

    expect(bodyButton.inert).toBe(false);
    expect(bodyButton.hasAttribute("inert")).toBe(false);
    expect(bodyButton.hasAttribute("aria-hidden")).toBe(false);
    expect(branchButton.inert).toBe(false);
    expect(branchButton.hasAttribute("inert")).toBe(false);
    expect(branchButton.getAttribute("aria-hidden")).toBe("false");
    expect(coordinatorObserver.disconnect).toHaveBeenCalledOnce();
  });

  it("recaptures a dynamic sibling baseline when it is removed and reinserted", () => {
    const surface = makeSurface();
    surface.show(null);

    expect(FakeMutationObserver.instances).toHaveLength(1);
    const coordinatorObserver = FakeMutationObserver.instances[0];
    const button = mount(fakeDocument.body, element("button"));
    coordinatorObserver.flush([childListRecord({ addedNodes: [button] })]);

    expect(button.inert).toBe(true);
    expect(button.getAttribute("aria-hidden")).toBe("true");

    button.remove();
    coordinatorObserver.flush([childListRecord({ removedNodes: [button] })]);
    expect(button.inert).toBe(false);
    expect(button.hasAttribute("inert")).toBe(false);
    expect(button.hasAttribute("aria-hidden")).toBe(false);

    button.setAttribute("inert", "reinsertion-lock");
    button.setAttribute("aria-hidden", "false");
    fakeDocument.body.appendChild(button);
    coordinatorObserver.flush([childListRecord({ addedNodes: [button] })]);
    expect(button.inert).toBe(true);
    expect(button.getAttribute("aria-hidden")).toBe("true");

    surface.hide({ restoreFocus: false });

    expect(button.inert).toBe(true);
    expect(button.getAttribute("inert")).toBe("reinsertion-lock");
    expect(button.getAttribute("aria-hidden")).toBe("false");
    expect(coordinatorObserver.disconnect).toHaveBeenCalledOnce();
    expect(fakeDocument.keydownListenerCount).toBe(0);
  });

  it("does not let unobservable detached restoration markers overwrite a later reinsertion baseline", () => {
    const surface = makeSurface();
    surface.show(null);
    const coordinatorObserver = FakeMutationObserver.instances[0];
    const button = mount(fakeDocument.body, element("button"));
    coordinatorObserver.flush([childListRecord({ addedNodes: [button] })]);
    coordinatorObserver.flush([
      attributeRecord(button, "inert", null),
      attributeRecord(button, "aria-hidden", null),
    ]);

    button.remove();
    coordinatorObserver.flush([childListRecord({ removedNodes: [button] })]);
    expect(button.hasAttribute("inert")).toBe(false);
    expect(button.hasAttribute("aria-hidden")).toBe(false);

    button.setAttribute("inert", "reinsertion-lock");
    button.setAttribute("aria-hidden", "false");
    fakeDocument.body.appendChild(button);
    coordinatorObserver.flush([childListRecord({ addedNodes: [button] })]);
    coordinatorObserver.flush([
      attributeRecord(button, "inert", "reinsertion-lock"),
      attributeRecord(button, "aria-hidden", "false"),
    ]);

    surface.hide({ restoreFocus: false });

    expect(button.inert).toBe(true);
    expect(button.getAttribute("inert")).toBe("reinsertion-lock");
    expect(button.getAttribute("aria-hidden")).toBe("false");
  });

  it.each([
    { appValue: "application-lock", attributeName: "inert" as const, sdkValue: "" },
    { appValue: "false", attributeName: "aria-hidden" as const, sdkValue: "true" },
  ])(
    "preserves a later $attributeName baseline after its first SDK write detaches and reinserts a custom element",
    ({ appValue, attributeName, sdkValue }) => {
      const background = mount(fakeDocument.body, element("wallet-background"));
      const setAttribute = background.setAttribute.bind(background);
      const removeAttribute = background.removeAttribute.bind(background);
      let detachOnFirstSdkWrite = true;
      vi.spyOn(background, "setAttribute").mockImplementation((name, value) => {
        const oldValue = background.getAttribute(name);
        const wasConnected = background.isConnected;
        setAttribute(name, value);
        const observer = FakeMutationObserver.instances.at(-1);
        if (wasConnected && observer && (name === "inert" || name === "aria-hidden")) {
          observer.enqueue([attributeRecord(background, name, oldValue)]);
        }
        if (name !== attributeName || value !== sdkValue || !detachOnFirstSdkWrite) return;
        detachOnFirstSdkWrite = false;
        background.remove();
        fakeDocument.body.appendChild(background);
        observer?.enqueue([
          childListRecord({ removedNodes: [background] }),
          childListRecord({ addedNodes: [background] }),
        ]);
      });
      vi.spyOn(background, "removeAttribute").mockImplementation((name) => {
        const oldValue = background.getAttribute(name);
        const wasConnected = background.isConnected;
        removeAttribute(name);
        const observer = FakeMutationObserver.instances.at(-1);
        if (wasConnected && observer && (name === "inert" || name === "aria-hidden")) {
          observer.enqueue([attributeRecord(background, name, oldValue)]);
        }
      });
      const surface = makeSurface();

      surface.show(null);
      const coordinatorObserver = FakeMutationObserver.instances[0];
      flushPendingMutations(coordinatorObserver);
      expect(detachOnFirstSdkWrite).toBe(false);
      expect(background.parentElement).toBe(fakeDocument.body);

      background.setAttribute(attributeName, appValue);
      flushPendingMutations(coordinatorObserver);
      surface.hide({ restoreFocus: false });

      expect(background.getAttribute(attributeName)).toBe(appValue);
    }
  );

  it("recaptures a changed baseline after same-batch removal and reinsertion", () => {
    const surface = makeSurface();
    surface.show(null);
    const coordinatorObserver = FakeMutationObserver.instances[0];
    const button = mount(fakeDocument.body, element("button"));
    coordinatorObserver.flush([childListRecord({ addedNodes: [button] })]);

    button.remove();
    button.setAttribute("inert", "reinsertion-lock");
    button.setAttribute("aria-hidden", "false");
    fakeDocument.body.appendChild(button);
    coordinatorObserver.flush([childListRecord({ addedNodes: [button], removedNodes: [button] })]);

    expect(button.inert).toBe(true);
    expect(button.getAttribute("aria-hidden")).toBe("true");

    surface.hide({ restoreFocus: false });

    expect(button.inert).toBe(true);
    expect(button.getAttribute("inert")).toBe("reinsertion-lock");
    expect(button.getAttribute("aria-hidden")).toBe("false");
  });

  it.each([
    {
      name: "aria-hidden only",
      setup: undefined,
      mutate: (button: FakeElement) => button.setAttribute("aria-hidden", "false"),
      expectedInert: false,
      expectedInertAttribute: null,
      expectedAriaHidden: "false",
    },
    {
      name: "inert property only",
      setup: undefined,
      mutate: (button: FakeElement) => {
        button.inert = false;
      },
      expectedInert: false,
      expectedInertAttribute: null,
      expectedAriaHidden: null,
    },
    {
      name: "inert attribute only",
      setup: (button: FakeElement) => {
        let inertValue = button.inert;
        const setAttribute = button.setAttribute.bind(button);
        const removeAttribute = button.removeAttribute.bind(button);
        Object.defineProperty(button, "inert", {
          configurable: true,
          get: () => inertValue,
          set: (value: boolean) => {
            inertValue = value;
            if (value) button.attributes.set("inert", "");
            else button.attributes.delete("inert");
          },
        });
        vi.spyOn(button, "setAttribute").mockImplementation((name, value) => {
          if (name !== "inert") {
            setAttribute(name, value);
            return;
          }
          button.attributes.set(name, value);
          inertValue = true;
        });
        vi.spyOn(button, "removeAttribute").mockImplementation((name) => {
          if (name !== "inert") {
            removeAttribute(name);
            return;
          }
          button.attributes.delete(name);
          inertValue = false;
        });
      },
      mutate: (button: FakeElement) => button.setAttribute("inert", "application-lock"),
      expectedInert: true,
      expectedInertAttribute: "application-lock",
      expectedAriaHidden: null,
    },
    {
      name: "both isolation channels",
      setup: undefined,
      mutate: (button: FakeElement) => {
        button.removeAttribute("inert");
        button.setAttribute("aria-hidden", "false");
      },
      expectedInert: false,
      expectedInertAttribute: null,
      expectedAriaHidden: "false",
    },
  ])(
    "preserves $name application mutations across same-batch removal and reinsertion",
    ({ setup, mutate, expectedInert, expectedInertAttribute, expectedAriaHidden }) => {
      const surface = makeSurface();
      surface.show(null);
      const coordinatorObserver = FakeMutationObserver.instances[0];
      const button = element("button");
      setup?.(button);
      mount(fakeDocument.body, button);
      coordinatorObserver.flush([childListRecord({ addedNodes: [button] })]);

      button.remove();
      mutate(button);
      fakeDocument.body.appendChild(button);
      coordinatorObserver.flush([
        childListRecord({ addedNodes: [button], removedNodes: [button] }),
      ]);

      expect(button.inert).toBe(true);
      expect(button.getAttribute("inert")).toBe("");
      expect(button.getAttribute("aria-hidden")).toBe("true");

      surface.hide({ restoreFocus: false });

      expect(button.inert).toBe(expectedInert);
      expect(button.getAttribute("inert")).toBe(expectedInertAttribute);
      expect(button.getAttribute("aria-hidden")).toBe(expectedAriaHidden);
    }
  );
});

describe("HostSurface focus and keyboard lifecycle", () => {
  it("captures the active element, focuses the iframe, and restores attributes before focus", () => {
    const trigger = mount(fakeDocument.body, element("button"));
    const surface = makeSurface();
    const iframe = surface.iframe as unknown as FakeIframe;
    const overlay = overlayOf(surface);
    fakeDocument.activeElement = trigger;
    trigger.focus.mockImplementation(() => {
      expect(trigger.inert).toBe(false);
      expect(trigger.hasAttribute("aria-hidden")).toBe(false);
      expect(fakeDocument.focusinListenerCount).toBe(0);
      fakeDocument.activeElement = trigger;
    });

    surface.show(null);

    expect(iframe.focus).toHaveBeenCalledOnce();
    expect(overlay.inert).toBe(false);
    expect(overlay.hasAttribute("inert")).toBe(false);
    expect(overlay.hasAttribute("aria-hidden")).toBe(false);
    expect(trigger.inert).toBe(true);
    surface.hide({ restoreFocus: true });
    expect(overlay.inert).toBe(true);
    expect(overlay.hasAttribute("inert")).toBe(true);
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    expect(trigger.focus).toHaveBeenCalledOnce();
    expect(fakeDocument.activeElement).toBe(trigger);
  });

  it("preserves the first initiator across repeated show calls", () => {
    const trigger = mount(fakeDocument.body, element("button"));
    const surface = makeSurface();
    const iframe = surface.iframe as unknown as FakeIframe;
    fakeDocument.activeElement = trigger;

    surface.show(trigger as unknown as Element);
    surface.show(null);
    surface.hide({ restoreFocus: true });

    expect(iframe.focus).toHaveBeenCalledTimes(2);
    expect(trigger.focus).toHaveBeenCalledOnce();
    expect(fakeDocument.keydownListenerCount).toBe(0);
  });

  it("does not focus an initiator that disconnected while the surface was shown", () => {
    const trigger = mount(fakeDocument.body, element("button"));
    const surface = makeSurface();

    surface.show(trigger as unknown as Element);
    trigger.remove();
    surface.hide({ restoreFocus: true });

    expect(trigger.focus).not.toHaveBeenCalled();
  });

  it("registers Escape only while shown and releases it on hide and destroy", () => {
    const onEscape = vi.fn();
    const surface = makeSurface({ onEscape });

    fakeDocument.dispatchKey("Escape");
    surface.show(null);
    expect(fakeDocument.keydownListenerCount).toBe(1);
    fakeDocument.dispatchKey("Enter");
    fakeDocument.dispatchKey("Escape");
    expect(onEscape).toHaveBeenCalledOnce();

    surface.hide({ restoreFocus: false });
    fakeDocument.dispatchKey("Escape");
    expect(onEscape).toHaveBeenCalledOnce();
    expect(fakeDocument.keydownListenerCount).toBe(0);

    surface.show(null);
    fakeDocument.dispatchKey("Escape");
    expect(onEscape).toHaveBeenCalledTimes(2);
    surface.destroy();
    fakeDocument.dispatchKey("Escape");
    expect(onEscape).toHaveBeenCalledTimes(2);
    expect(fakeDocument.keydownListenerCount).toBe(0);
  });

  it("routes each Escape key to only the topmost active surface", () => {
    const onEscapeA = vi.fn();
    const onEscapeB = vi.fn();
    const surfaceA = makeSurface({ onEscape: onEscapeA });
    const surfaceB = makeSurface({ onEscape: onEscapeB });

    surfaceA.show(null);
    surfaceB.show(null);

    expect(fakeDocument.keydownListenerCount).toBe(1);
    fakeDocument.dispatchKey("Escape");
    expect(onEscapeA).not.toHaveBeenCalled();
    expect(onEscapeB).toHaveBeenCalledOnce();

    surfaceB.hide({ restoreFocus: false });
    fakeDocument.dispatchKey("Escape");
    expect(onEscapeA).toHaveBeenCalledOnce();
    expect(onEscapeB).toHaveBeenCalledOnce();

    surfaceA.hide({ restoreFocus: false });
    expect(fakeDocument.keydownListenerCount).toBe(0);
  });

  it("keeps focus on the top owner when a lower surface is focused or shown again", () => {
    const trigger = mount(fakeDocument.body, element("button"));
    const onEscapeA = vi.fn();
    const onEscapeB = vi.fn();
    const surfaceA = makeSurface({ onEscape: onEscapeA });
    const surfaceB = makeSurface({ onEscape: onEscapeB });
    const iframeA = surfaceA.iframe as unknown as FakeIframe;
    const iframeB = surfaceB.iframe as unknown as FakeIframe;
    fakeDocument.activeElement = trigger;

    surfaceA.show(trigger as unknown as Element);
    surfaceB.show(null);
    iframeA.focus();

    expect(fakeDocument.activeElement).toBe(iframeB);
    expect(iframeA.focus).toHaveBeenCalledTimes(2);
    surfaceA.show(null);
    expect(fakeDocument.activeElement).toBe(iframeB);
    expect(iframeA.focus).toHaveBeenCalledTimes(2);
    fakeDocument.dispatchKey("Escape");
    expect(onEscapeA).not.toHaveBeenCalled();
    expect(onEscapeB).toHaveBeenCalledOnce();

    surfaceB.hide({ restoreFocus: true });
    expect(fakeDocument.activeElement).toBe(iframeA);
    surfaceA.hide({ restoreFocus: true });
    expect(fakeDocument.activeElement).toBe(trigger);
    expect(trigger.focus).toHaveBeenCalledOnce();
    expect(fakeDocument.focusinListenerCount).toBe(0);
    expect(fakeDocument.keydownListenerCount).toBe(0);
  });

  it("contains focus immediately when a late outside element is appended and focused", () => {
    const surface = makeSurface();
    const iframe = surface.iframe as unknown as FakeIframe;
    surface.show(null);

    expect(fakeDocument.focusinListenerCount).toBe(1);
    const lateButton = mount(fakeDocument.body, element("button"));
    lateButton.focus();

    expect(lateButton.focus).toHaveBeenCalledOnce();
    expect(iframe.focus).toHaveBeenCalledTimes(2);
    expect(fakeDocument.activeElement).toBe(iframe);

    surface.hide({ restoreFocus: false });
    expect(fakeDocument.focusinListenerCount).toBe(0);
    lateButton.focus();
    expect(fakeDocument.activeElement).toBe(lateButton);
    expect(iframe.focus).toHaveBeenCalledTimes(2);
  });

  it("redirects focus after reconciliation newly isolates the active element", () => {
    const surface = makeSurface();
    const iframe = surface.iframe as unknown as FakeIframe;
    surface.show(null);
    const coordinatorObserver = FakeMutationObserver.instances[0];
    const lateButton = mount(fakeDocument.body, element("button"));
    fakeDocument.activeElement = lateButton;

    coordinatorObserver.flush([childListRecord({ addedNodes: [lateButton] })]);

    expect(lateButton.inert).toBe(true);
    expect(iframe.focus).toHaveBeenCalledTimes(2);
    expect(fakeDocument.activeElement).toBe(iframe);
    surface.hide({ restoreFocus: false });
  });

  it("contains focus best-effort when the topmost iframe focus throws", () => {
    const surface = makeSurface();
    const iframe = surface.iframe as unknown as FakeIframe;
    surface.show(null);
    iframe.focus.mockImplementation(() => {
      throw new Error("redirect failed");
    });
    const lateButton = mount(fakeDocument.body, element("button"));

    expect(() => lateButton.focus()).not.toThrow();
    expect(fakeDocument.focusinListenerCount).toBe(1);

    surface.hide({ restoreFocus: false });
    expect(fakeDocument.focusinListenerCount).toBe(0);
  });

  it("retains focus containment when final cleanup synchronously activates another surface", () => {
    const surfaceA = makeSurface();
    const surfaceB = makeSurface();
    const iframeB = surfaceB.iframe as unknown as FakeIframe;
    surfaceA.show(null);
    let escapedButton: FakeElement | null = null;
    iframeB.focus.mockImplementation(() => {
      fakeDocument.focusElement(iframeB);
      if (escapedButton) return;
      escapedButton = mount(fakeDocument.body, element("button"));
      escapedButton.focus();
    });
    const removeEventListener = fakeDocument.removeEventListener.bind(fakeDocument);
    let activateSurfaceB = true;
    vi.spyOn(fakeDocument, "removeEventListener").mockImplementation((type, listener) => {
      removeEventListener(type, listener);
      if (type === "focusin" && activateSurfaceB) {
        activateSurfaceB = false;
        surfaceB.show(null);
      }
    });

    surfaceA.hide({ restoreFocus: false });

    expect(fakeDocument.focusinListenerCount).toBe(1);
    expect(escapedButton).not.toBeNull();
    expect(fakeDocument.activeElement).toBe(iframeB);
    const lateButton = mount(fakeDocument.body, element("button"));
    lateButton.focus();
    expect(iframeB.focus).toHaveBeenCalledTimes(3);
    expect(fakeDocument.activeElement).toBe(iframeB);

    surfaceB.hide({ restoreFocus: false });
    expect(fakeDocument.focusinListenerCount).toBe(0);
  });

  it("preserves the pending final focus target when cleanup synchronously starts a new owner chain", () => {
    const trigger = mount(fakeDocument.body, element("button"));
    const surfaceA = makeSurface();
    const surfaceB = makeSurface();
    const iframeB = surfaceB.iframe as unknown as FakeIframe;
    trigger.focus();
    surfaceA.show(trigger as unknown as Element);
    const removeEventListener = fakeDocument.removeEventListener.bind(fakeDocument);
    let activateSurfaceB = true;
    vi.spyOn(fakeDocument, "removeEventListener").mockImplementation((type, listener) => {
      removeEventListener(type, listener);
      if (type === "focusin" && activateSurfaceB) {
        activateSurfaceB = false;
        surfaceB.show(null);
      }
    });

    surfaceA.hide({ restoreFocus: true });

    expect(fakeDocument.activeElement).toBe(iframeB);
    surfaceB.hide({ restoreFocus: true });
    expect(trigger.focus).toHaveBeenCalledTimes(2);
    expect(fakeDocument.activeElement).toBe(trigger);
  });

  it("restores inherited final focus when a reentrant owner fails before activation commits", () => {
    const trigger = mount(fakeDocument.body, element("button"));
    const surfaceA = makeSurface();
    const surfaceB = makeSurface();
    const iframeB = surfaceB.iframe as unknown as FakeIframe;
    trigger.focus();
    surfaceA.show(trigger as unknown as Element);
    const observeError = new Error("reentrant observe failed");
    FakeMutationObserver.observeError = observeError;
    const removeEventListener = fakeDocument.removeEventListener.bind(fakeDocument);
    let activateSurfaceB = true;
    let activationError: unknown;
    vi.spyOn(fakeDocument, "removeEventListener").mockImplementation((type, listener) => {
      removeEventListener(type, listener);
      if (type === "focusin" && activateSurfaceB) {
        activateSurfaceB = false;
        try {
          surfaceB.show(null);
        } catch (error) {
          activationError = error;
        }
      }
    });

    surfaceA.hide({ restoreFocus: true });

    expect(activationError).toBe(observeError);
    expect(iframeB.focus).not.toHaveBeenCalled();
    expect(trigger.focus).toHaveBeenCalledTimes(2);
    expect(fakeDocument.activeElement).toBe(trigger);
  });

  it("returns inherited final focus when a reentrant owner is destroyed before activation commits", () => {
    const trigger = mount(fakeDocument.body, element("button"));
    const background = mount(fakeDocument.body, element("main"));
    const surfaceA = makeSurface();
    const surfaceB = makeSurface();
    trigger.focus();
    surfaceA.show(trigger as unknown as Element);
    const setAttribute = background.setAttribute.bind(background);
    let destroySurfaceB = false;
    vi.spyOn(background, "setAttribute").mockImplementation((name, value) => {
      setAttribute(name, value);
      if (name === "inert" && destroySurfaceB) {
        destroySurfaceB = false;
        surfaceB.destroy();
      }
    });
    const removeEventListener = fakeDocument.removeEventListener.bind(fakeDocument);
    let activateSurfaceB = true;
    vi.spyOn(fakeDocument, "removeEventListener").mockImplementation((type, listener) => {
      removeEventListener(type, listener);
      if (type === "focusin" && activateSurfaceB) {
        activateSurfaceB = false;
        destroySurfaceB = true;
        surfaceB.show(null);
      }
    });

    surfaceA.hide({ restoreFocus: true });

    expect(trigger.focus).toHaveBeenCalledTimes(2);
    expect(fakeDocument.activeElement).toBe(trigger);
  });

  it("returns inherited final focus when reentrant activation cannot settle during cleanup", () => {
    const trigger = mount(fakeDocument.body, element("button"));
    const background = mount(fakeDocument.body, element("main"));
    const surfaceA = makeSurface();
    const surfaceB = makeSurface();
    trigger.focus();
    surfaceA.show(trigger as unknown as Element);
    const removeAttribute = background.removeAttribute.bind(background);
    let activateSurfaceB = true;
    let activationError: unknown;
    vi.spyOn(background, "removeAttribute").mockImplementation((name) => {
      removeAttribute(name);
      if (name === "inert" && activateSurfaceB) {
        activateSurfaceB = false;
        try {
          surfaceB.show(null);
        } catch (error) {
          activationError = error;
        }
      }
    });

    surfaceA.hide({ restoreFocus: true });

    expect(activationError).toEqual(new Error("Host surface activation was interrupted"));
    expect(trigger.focus).toHaveBeenCalledTimes(2);
    expect(fakeDocument.activeElement).toBe(trigger);
  });
});

describe("HostSurface transactional show", () => {
  it("continues transactionally when baseline active-element capture throws", () => {
    const surface = makeSurface();
    const iframe = surface.iframe as unknown as FakeIframe;
    const overlay = overlayOf(surface);
    let activeElement: FakeElement | null = fakeDocument.body;
    let throwOnRead = true;
    Object.defineProperty(fakeDocument, "activeElement", {
      configurable: true,
      get: () => {
        if (throwOnRead) throw new Error("active element failed");
        return activeElement;
      },
      set: (value: FakeElement | null) => {
        activeElement = value;
      },
    });

    expect(() => surface.show(null)).not.toThrow();
    throwOnRead = false;

    expect(overlay.inert).toBe(false);
    expect(overlay.hasAttribute("aria-hidden")).toBe(false);
    expect(fakeDocument.keydownListenerCount).toBe(1);
    expect(fakeDocument.focusinListenerCount).toBe(1);
    expect(iframe.focus).toHaveBeenCalledOnce();
    surface.hide({ restoreFocus: false });
    expect(overlay.inert).toBe(true);
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
  });

  it("does not activate a removed overlay when active-element capture destroys the surface", () => {
    const surface = makeSurface();
    const iframe = surface.iframe as unknown as FakeIframe;
    const overlay = overlayOf(surface);
    let destroyOnRead = true;
    Object.defineProperty(fakeDocument, "activeElement", {
      configurable: true,
      get: () => {
        if (destroyOnRead) {
          destroyOnRead = false;
          surface.destroy();
        }
        return fakeDocument.body;
      },
      set: () => undefined,
    });

    surface.show(null);

    const leakedObserver = FakeMutationObserver.instances.some(
      (observer) => !observer.isDisconnected
    );
    for (const observer of FakeMutationObserver.instances) observer.disconnect();
    expect(overlay.parentElement).toBeNull();
    expect(iframe.focus).not.toHaveBeenCalled();
    expect(fakeDocument.keydownListenerCount).toBe(0);
    expect(leakedObserver).toBe(false);
  });

  it("does not recursively focus when repeated show is called from the iframe focus callback", () => {
    const surface = makeSurface();
    const iframe = surface.iframe as unknown as FakeIframe;
    surface.show(null);
    iframe.focus.mockClear();
    let reenter = true;
    iframe.focus.mockImplementation(() => {
      if (!reenter) return;
      reenter = false;
      surface.show(null);
    });

    surface.show(null);

    expect(iframe.focus).toHaveBeenCalledOnce();
    expect(fakeDocument.keydownListenerCount).toBe(1);
    surface.hide({ restoreFocus: false });
    expect(fakeDocument.keydownListenerCount).toBe(0);
  });

  it("does not allow a new show attempt to enter while hide cleanup owns the surface", () => {
    const background = mount(fakeDocument.body, element("main"));
    const surface = makeSurface();
    const iframe = surface.iframe as unknown as FakeIframe;
    const overlay = overlayOf(surface);
    surface.show(null);
    const setAttribute = overlay.setAttribute.bind(overlay);
    let reenter = true;
    vi.spyOn(overlay, "setAttribute").mockImplementation((name, value) => {
      setAttribute(name, value);
      if (name === "inert" && reenter) {
        reenter = false;
        surface.show(null);
      }
    });

    surface.hide({ restoreFocus: false });

    expect(iframe.focus).toHaveBeenCalledOnce();
    expect(overlay.inert).toBe(true);
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    expect(overlay.style.opacity).toBe("0");
    expect(overlay.style.pointerEvents).toBe("none");
    expect(background.inert).toBe(false);
    expect(background.hasAttribute("inert")).toBe(false);
    expect(background.hasAttribute("aria-hidden")).toBe(false);
    expect(fakeDocument.keydownListenerCount).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);

    surface.show(null);
    expect(iframe.focus).toHaveBeenCalledTimes(2);
    expect(background.inert).toBe(true);
    surface.hide({ restoreFocus: false });
  });

  it("throws when a nested surface cannot settle activation during reconciliation", () => {
    const background = mount(fakeDocument.body, element("main"));
    const surfaceA = makeSurface();
    const surfaceB = makeSurface();
    const iframeB = surfaceB.iframe as unknown as FakeIframe;
    const overlayB = overlayOf(surfaceB);
    const setAttribute = background.setAttribute.bind(background);
    let activateNestedSurface = true;
    let nestedError: unknown;
    vi.spyOn(background, "setAttribute").mockImplementation((name, value) => {
      setAttribute(name, value);
      if (name === "inert" && activateNestedSurface) {
        activateNestedSurface = false;
        try {
          surfaceB.show(null);
        } catch (error) {
          nestedError = error;
        }
      }
    });

    surfaceA.show(null);

    expect(nestedError).toBeInstanceOf(Error);
    expect(iframeB.focus).not.toHaveBeenCalled();
    expect(overlayB.inert).toBe(true);
    expect(overlayB.getAttribute("aria-hidden")).toBe("true");
    expect(fakeDocument.keydownListenerCount).toBe(1);

    surfaceA.hide({ restoreFocus: false });
    surfaceB.show(null);
    expect(iframeB.focus).toHaveBeenCalledOnce();
    surfaceB.hide({ restoreFocus: false });
  });

  it("does not resurrect when an inert setter destroys it during isolation", () => {
    const background = mount(fakeDocument.body, element("main"));
    let inertValue = false;
    let destroyOnInert = true;
    const surface = makeSurface();
    Object.defineProperty(background, "inert", {
      configurable: true,
      get: () => inertValue,
      set: (value: boolean) => {
        inertValue = value;
        if (value && destroyOnInert) {
          destroyOnInert = false;
          surface.destroy();
        }
      },
    });
    const iframe = surface.iframe as unknown as FakeIframe;
    const overlay = overlayOf(surface);

    surface.show(null);

    const leakedKeydownListeners = fakeDocument.keydownListenerCount;
    fakeDocument.clearKeydownListeners();
    expect(overlay.parentElement).toBeNull();
    expect(background.inert).toBe(false);
    expect(background.hasAttribute("inert")).toBe(false);
    expect(background.hasAttribute("aria-hidden")).toBe(false);
    expect(iframe.focus).not.toHaveBeenCalled();
    expect(leakedKeydownListeners).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);

    surface.show(null);
    expect(overlay.parentElement).toBeNull();
    expect(iframe.focus).not.toHaveBeenCalled();
  });

  it.each(["inert", "aria-hidden"] as const)(
    "restores isolation when an SDK %s record is settled during its DOM write",
    (attributeName) => {
      const background = mount(fakeDocument.body, element("main"));
      const surface = makeSurface();
      const overlay = overlayOf(surface);
      const setAttribute = background.setAttribute.bind(background);
      let destroyDuringWrite = true;
      vi.spyOn(background, "setAttribute").mockImplementation((name, value) => {
        const oldValue = background.getAttribute(name);
        setAttribute(name, value);
        if (name !== attributeName || !destroyDuringWrite) return;
        destroyDuringWrite = false;
        const coordinatorObserver = FakeMutationObserver.instances.at(-1);
        if (!coordinatorObserver) throw new Error("Coordinator observer is missing");
        coordinatorObserver.enqueue([attributeRecord(background, attributeName, oldValue)]);
        surface.destroy();
      });

      expect(() => surface.show(null)).not.toThrow();

      expect(overlay.parentElement).toBeNull();
      expect(background.inert).toBe(false);
      expect(background.hasAttribute("inert")).toBe(false);
      expect(background.hasAttribute("aria-hidden")).toBe(false);
      expect(fakeDocument.keydownListenerCount).toBe(0);
      expect(fakeDocument.focusinListenerCount).toBe(0);
      expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(
        true
      );
    }
  );

  it.each([
    {
      appValue: "app-lock",
      attributeName: "inert" as const,
      mutateExternally: (background: FakeElement) => background.removeAttribute("inert"),
      sdkValue: "",
    },
    {
      appValue: "presentation",
      attributeName: "aria-hidden" as const,
      mutateExternally: (background: FakeElement) =>
        background.setAttribute("aria-hidden", "false"),
      sdkValue: "true",
    },
  ])(
    "discards a failed pre-native $attributeName marker before later external baselines",
    ({ appValue, attributeName, mutateExternally, sdkValue }) => {
      const background = mount(fakeDocument.body, element("main"));
      const surface = makeSurface();
      surface.show(null);
      const coordinatorObserver = FakeMutationObserver.instances.at(-1);
      if (!coordinatorObserver) throw new Error("Coordinator observer is missing");
      coordinatorObserver.flush([
        attributeRecord(background, "inert", null),
        attributeRecord(background, "aria-hidden", null),
      ]);

      const setAttribute = background.setAttribute.bind(background);
      let throwBeforeNative = true;
      vi.spyOn(background, "setAttribute").mockImplementation((name, value) => {
        if (name === attributeName && value === sdkValue && throwBeforeNative) {
          throwBeforeNative = false;
          throw new Error("pre-native write failed");
        }
        setAttribute(name, value);
      });

      const firstExternalOldValue = background.getAttribute(attributeName);
      mutateExternally(background);
      const firstExternalValue = background.getAttribute(attributeName);
      coordinatorObserver.flush([
        attributeRecord(background, attributeName, firstExternalOldValue),
      ]);
      coordinatorObserver.flush([attributeRecord(background, attributeName, firstExternalValue)]);

      const latestExternalOldValue = background.getAttribute(attributeName);
      background.setAttribute(attributeName, appValue);
      coordinatorObserver.flush([
        attributeRecord(background, attributeName, latestExternalOldValue),
      ]);
      coordinatorObserver.flush([attributeRecord(background, attributeName, appValue)]);

      surface.hide({ restoreFocus: false });

      expect(background.getAttribute(attributeName)).toBe(appValue);
    }
  );

  it("rolls back isolation and ownership when an attribute mutation throws", () => {
    const background = mount(fakeDocument.body, element("main"));
    const surface = makeSurface();
    const iframe = surface.iframe as unknown as FakeIframe;
    const overlay = overlayOf(surface);
    const setAttribute = background.setAttribute.bind(background);
    let throwOnAriaHidden = true;
    vi.spyOn(background, "setAttribute").mockImplementation((name, value) => {
      setAttribute(name, value);
      if (throwOnAriaHidden && name === "aria-hidden") {
        throw new Error("attribute mutation failed");
      }
    });

    expect(() => surface.show(null)).toThrow("attribute mutation failed");
    throwOnAriaHidden = false;

    expect(background.inert).toBe(false);
    expect(background.hasAttribute("inert")).toBe(false);
    expect(background.hasAttribute("aria-hidden")).toBe(false);
    expect(overlay.inert).toBe(true);
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    expect(iframe.focus).not.toHaveBeenCalled();
    expect(fakeDocument.keydownListenerCount).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);

    surface.show(null);
    surface.hide({ restoreFocus: false });
    expect(iframe.focus).toHaveBeenCalledOnce();
    expect(background.hasAttribute("inert")).toBe(false);
  });

  it("rolls back a show attempt when focusing the iframe throws", () => {
    const background = mount(fakeDocument.body, element("button"));
    const surface = makeSurface();
    const iframe = surface.iframe as unknown as FakeIframe;
    const overlay = overlayOf(surface);
    fakeDocument.activeElement = background;
    iframe.focus.mockImplementation(() => {
      fakeDocument.activeElement = iframe;
      throw new Error("focus failed");
    });

    expect(() => surface.show(null)).toThrow("focus failed");
    iframe.focus.mockImplementation(() => undefined);

    expect(background.inert).toBe(false);
    expect(background.hasAttribute("inert")).toBe(false);
    expect(background.hasAttribute("aria-hidden")).toBe(false);
    expect(overlay.inert).toBe(true);
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    expect(fakeDocument.keydownListenerCount).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);
    expect(background.focus).toHaveBeenCalledOnce();
    expect(fakeDocument.activeElement).toBe(background);

    surface.show(null);
    surface.hide({ restoreFocus: false });
    expect(iframe.focus).toHaveBeenCalledTimes(2);
  });

  it("stays destroyed when the iframe focus callback destroys it and throws", () => {
    const background = mount(fakeDocument.body, element("main"));
    const surface = makeSurface();
    const iframe = surface.iframe as unknown as FakeIframe;
    const overlay = overlayOf(surface);
    iframe.focus.mockImplementation(() => {
      surface.destroy();
      throw new Error("focus callback failed");
    });

    expect(() => surface.show(null)).toThrow("focus callback failed");

    expect(overlay.parentElement).toBeNull();
    expect(background.inert).toBe(false);
    expect(background.hasAttribute("inert")).toBe(false);
    expect(background.hasAttribute("aria-hidden")).toBe(false);
    expect(fakeDocument.keydownListenerCount).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);

    surface.show(null);
    expect(iframe.focus).toHaveBeenCalledOnce();
  });
});

describe("HostSurface teardown and container ownership", () => {
  it("fails closed when an inert callback synchronously removes the active overlay", () => {
    const background = mount(fakeDocument.body, element("main"));
    const onDisconnect = vi.fn();
    const surface = makeSurface({ onDisconnect });
    const iframe = surface.iframe as unknown as FakeIframe;
    const overlay = overlayOf(surface);
    let inertValue = false;
    Object.defineProperty(background, "inert", {
      configurable: true,
      get: () => inertValue,
      set: (value: boolean) => {
        inertValue = value;
        if (value) overlay.remove();
      },
    });

    expect(() => surface.show(null)).not.toThrow();

    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(overlay.parentElement).toBeNull();
    expect(iframe.focus).not.toHaveBeenCalled();
    expect(background.inert).toBe(false);
    expect(background.hasAttribute("inert")).toBe(false);
    expect(background.hasAttribute("aria-hidden")).toBe(false);
    expect(fakeDocument.keydownListenerCount).toBe(0);
    expect(fakeDocument.focusinListenerCount).toBe(0);
    expect(FakeMutationObserver.instances.every((observer) => observer.isDisconnected)).toBe(true);

    surface.show(null);
    expect(iframe.focus).not.toHaveBeenCalled();
  });

  it("fails closed once when an active overlay is reparented in one mutation batch", () => {
    const background = mount(fakeDocument.body, element("main"));
    const destination = mount(fakeDocument.body, element("section"));
    const onDisconnect = vi.fn();
    const surface = makeSurface({ onDisconnect });
    const iframe = surface.iframe as unknown as FakeIframe;
    const overlay = overlayOf(surface);
    surface.show(null);
    const coordinatorObserver = FakeMutationObserver.instances[0];

    overlay.remove();
    destination.appendChild(overlay);
    coordinatorObserver.flush([
      childListRecord({ addedNodes: [overlay], removedNodes: [overlay] }),
    ]);
    coordinatorObserver.flush([removalRecord(overlay)]);

    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(overlay.parentElement).toBe(destination);
    expect(background.inert).toBe(false);
    expect(background.hasAttribute("inert")).toBe(false);
    expect(background.hasAttribute("aria-hidden")).toBe(false);
    expect(fakeDocument.keydownListenerCount).toBe(0);
    expect(fakeDocument.focusinListenerCount).toBe(0);
    expect(coordinatorObserver.disconnect).toHaveBeenCalledOnce();

    surface.show(null);
    expect(iframe.focus).toHaveBeenCalledOnce();
  });

  it("detects configured-container removal from its parent once and never reparents", () => {
    const pageSibling = mount(fakeDocument.body, element("main"));
    const parent = mount(fakeDocument.body, element("div"));
    const container = mount(parent, element("section"));
    const onDisconnect = vi.fn();
    const surface = makeSurface({ container: asHTMLElement(container), onDisconnect });
    const overlay = overlayOf(surface);
    const observer = FakeMutationObserver.instances[0];
    surface.show(pageSibling as unknown as Element);

    container.remove();
    const replacement = mount(parent, element("section"));
    observer.flush();
    observer.flush();

    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(overlay.parentElement).toBe(container);
    expect(replacement.children).not.toContain(overlay);
    expect(pageSibling.inert).toBe(false);
    expect(pageSibling.focus).not.toHaveBeenCalled();
    expect(fakeDocument.keydownListenerCount).toBe(0);

    surface.destroy();
    expect(overlay.parentElement).toBeNull();
  });

  it("treats same-batch reparenting of the configured container as permanent disconnection", () => {
    const firstParent = mount(fakeDocument.body, element("div"));
    const secondParent = mount(fakeDocument.body, element("div"));
    const container = mount(firstParent, element("section"));
    const onDisconnect = vi.fn();
    makeSurface({ container: asHTMLElement(container), onDisconnect });
    const observer = FakeMutationObserver.instances[0];

    container.remove();
    secondParent.appendChild(container);
    expect(container.isConnected).toBe(true);
    observer.flush([removalRecord(container)]);
    observer.flush([removalRecord(container)]);

    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });

  it("makes hide and destroy idempotent without leaking focus, observers, listeners, or nodes", () => {
    const trigger = mount(fakeDocument.body, element("button"));
    const container = mount(fakeDocument.body, element("section"));
    const surface = makeSurface({ container: asHTMLElement(container) });
    const overlay = overlayOf(surface);
    const observer = FakeMutationObserver.instances[0];

    surface.show(trigger as unknown as Element);
    surface.hide({ restoreFocus: true });
    surface.hide({ restoreFocus: true });
    surface.destroy();
    surface.destroy();

    expect(trigger.focus).toHaveBeenCalledOnce();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(fakeDocument.keydownListenerCount).toBe(0);
    expect(overlay.remove).toHaveBeenCalledOnce();
    expect(overlay.parentElement).toBeNull();
  });

  it("uses captured parent cleanup when overlay removal is replaced before destroy", () => {
    const container = mount(fakeDocument.body, element("section"));
    const surface = makeSurface({ container: asHTMLElement(container) });
    const overlay = overlayOf(surface);
    const iframe = surface.iframe as unknown as FakeIframe;
    const replacementRemove = vi.fn(() => {
      throw new Error("replacement overlay removal failed");
    });
    overlay.remove.mockImplementation(() => {
      throw new Error("captured overlay removal failed");
    });
    Object.defineProperty(overlay, "remove", {
      configurable: true,
      value: replacementRemove,
    });

    expect(() => surface.destroy()).not.toThrow();
    expect(() => surface.destroy()).not.toThrow();

    expect(overlay.parentElement).toBeNull();
    expect(iframe.isConnected).toBe(false);
    expect(fakeDocument.keydownListenerCount).toBe(0);
    expect(fakeDocument.focusinListenerCount).toBe(0);
  });
});

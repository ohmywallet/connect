export interface HostSurfaceOptions {
  container?: HTMLElement;
  iframeSrc: string;
  sandbox: string;
  onEscape(): void;
  onDisconnect(): void;
}

export interface HostSurface {
  readonly iframe: HTMLIFrameElement;
  show(initiator: Element | null): void;
  hide(options: { restoreFocus: boolean }): void;
  destroy(): void;
}

export class HostSurfaceContainerDisconnectedError extends Error {
  constructor() {
    super("Host surface container must be connected");
    this.name = "HostSurfaceContainerDisconnectedError";
  }
}

interface AttributeSnapshot {
  present: boolean;
  value: string | null;
}

interface IsolationSnapshot {
  element: Element;
  inertSupported: boolean;
  inertValue: boolean;
  inertAttribute: AttributeSnapshot;
  ariaHiddenAttribute: AttributeSnapshot;
}

interface IsolationState {
  element: Element;
  baseline: IsolationSnapshot;
  applied: IsolationSnapshot;
}

type IsolationAttributeName = "aria-hidden" | "inert";

interface InternalAttributeWrite {
  from: AttributeSnapshot;
  to: AttributeSnapshot;
}

interface InertPropertyMutation {
  attributeBefore: AttributeSnapshot;
  attributeAfter: AttributeSnapshot;
  coordinatorRecordsSettled: boolean;
  externalAttributeAfter: AttributeSnapshot | null;
  reflectedAttribute: AttributeSnapshot;
}

interface PendingFinalFocus {
  target: Element | null;
  restoreRequested: boolean;
}

interface CoordinatorOwner {
  readonly overlay: HTMLElement;
  readonly iframe: HTMLIFrameElement;
  ownsMount(): boolean;
  wasRemoved(removedNode: Node): boolean;
  disconnect(): void;
  escape(): void;
}

type InertElement = Element & { inert: boolean };

const reconciliationInterrupted = Symbol("HostSurface reconciliation interrupted");
const maxMutationSettlementPasses = 8;
const appliedInertAttribute: AttributeSnapshot = { present: true, value: "" };
const appliedAriaHiddenAttribute: AttributeSnapshot = { present: true, value: "true" };

function attributesEqual(left: AttributeSnapshot, right: AttributeSnapshot): boolean {
  return left.present === right.present && left.value === right.value;
}

function removedNodeContains(removedNode: Node, element: Node): boolean {
  if (removedNode === element) return true;
  try {
    const contains = (removedNode as Node & { contains?: (other: Node) => boolean }).contains;
    return typeof contains === "function" && contains.call(removedNode, element);
  } catch {
    return false;
  }
}

function isLightDomContainer(element: Element, ownerDocument: Document): boolean {
  try {
    if (element.ownerDocument !== ownerDocument || !element.isConnected) return false;
    const body = ownerDocument.body;
    if (!body) return false;
    const visited = new Set<Element>();
    let current: Element | null = element;
    while (current && !visited.has(current)) {
      if (current === body) return true;
      visited.add(current);
      current = current.parentElement;
    }
    return false;
  } catch {
    return false;
  }
}

function safeActiveElement(ownerDocument: Document): Element | null {
  try {
    return ownerDocument.activeElement;
  } catch {
    return null;
  }
}

function canRestoreFocus(element: Element, ownerDocument: Document): boolean {
  try {
    if (element.ownerDocument !== ownerDocument || !element.isConnected) return false;
    let current: Element | null = element;
    while (current) {
      if (current.hasAttribute("inert")) return false;
      if ("inert" in current && (current as InertElement).inert) return false;
      if (current.getAttribute("aria-hidden") === "true") return false;
      if (current === ownerDocument.body) break;
      current = current.parentElement;
    }
    return current === ownerDocument.body;
  } catch {
    return false;
  }
}

function focusBestEffort(element: Element | null, ownerDocument: Document): void {
  if (!element || !canRestoreFocus(element, ownerDocument)) return;
  try {
    const focus = (element as Element & { focus?: () => void }).focus;
    if (typeof focus === "function") focus.call(element);
  } catch {
    // Focus restoration must not replace the wallet operation's terminal result.
  }
}

const documentCoordinators = new WeakMap<Document, HostSurfaceCoordinator>();

class HostSurfaceCoordinator {
  private readonly owners: CoordinatorOwner[] = [];
  private readonly isolation = new Map<Element, IsolationState>();
  private readonly internalAttributeWrites = new Map<
    Element,
    Map<IsolationAttributeName, InternalAttributeWrite[]>
  >();
  private observer: MutationObserver | null = null;
  private baselineFocus: Element | null = null;
  private pendingFinalFocus: PendingFinalFocus | null = null;
  private revision = 0;
  private reconciling = false;
  private reconciliationRequested = false;
  private focusinListening = false;
  private keydownListening = false;
  private reconcilingDocumentListeners = false;
  private documentListenerReconciliationRequested = false;
  private redirectingFocus = false;
  private focusRedirectionRequested = false;
  private settlingMutationRecords = false;
  private mutationSettlementRequested = false;

  private readonly focusinListener = (event: FocusEvent): void => {
    const target = event.target;
    if (!target || this.isInsideTopVisibleOverlay(target as Node)) return;
    this.redirectFocusToTopOwner();
  };
  private readonly keydownListener = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    this.findTopVisibleOwner()?.escape();
  };

  constructor(private readonly ownerDocument: Document) {}

  activate(owner: CoordinatorOwner, initiator: Element | null): boolean {
    this.settlePendingMutationRecords();
    if (this.owners.includes(owner)) return true;

    const firstOwner = this.owners.length === 0;
    this.owners.push(owner);
    this.revision += 1;
    const inheritedFinalFocus = firstOwner ? this.pendingFinalFocus : null;
    if (firstOwner) {
      this.baselineFocus =
        (inheritedFinalFocus?.restoreRequested ? inheritedFinalFocus.target : null) ??
        initiator ??
        safeActiveElement(this.ownerDocument);
      if (!this.owners.includes(owner)) {
        if (this.owners.length === 0) this.baselineFocus = null;
        this.returnInheritedFinalFocus(inheritedFinalFocus);
        this.stopRuntimeIfInactive();
        this.finishPendingFocusIfSettled();
        return false;
      }
    }

    try {
      this.startRuntime();
      if (!this.owners.includes(owner)) {
        if (this.owners.length === 0) this.baselineFocus = null;
        this.returnInheritedFinalFocus(inheritedFinalFocus);
        this.stopRuntimeIfInactive();
        this.finishPendingFocusIfSettled();
        return false;
      }
      const settled = this.recomputeIsolation();
      if (!settled || !this.owners.includes(owner)) {
        if (this.owners.includes(owner)) {
          this.removeOwner(owner);
          this.recoverIsolationBestEffort();
        }
        if (this.owners.length === 0) this.baselineFocus = null;
        this.returnInheritedFinalFocus(inheritedFinalFocus);
        this.stopRuntimeIfInactive();
        this.finishPendingFocusIfSettled();
        return false;
      }
      if (!owner.ownsMount()) {
        owner.disconnect();
        this.returnInheritedFinalFocus(inheritedFinalFocus);
        this.stopRuntimeIfInactive();
        this.finishPendingFocusIfSettled();
        return false;
      }
      if (firstOwner && this.pendingFinalFocus === inheritedFinalFocus) {
        this.pendingFinalFocus = null;
      }
      return true;
    } catch (error) {
      this.removeOwner(owner);
      this.recoverIsolationBestEffort();
      this.returnInheritedFinalFocus(inheritedFinalFocus);
      this.stopRuntimeIfInactive();
      if (this.owners.length === 0) this.baselineFocus = null;
      this.finishPendingFocusIfSettled();
      throw error;
    }
  }

  deactivate(owner: CoordinatorOwner, restoreFocus: boolean): void {
    this.settlePendingMutationRecords();
    if (!this.removeOwner(owner)) {
      this.stopRuntimeIfInactive();
      this.finishPendingFocusIfSettled();
      return;
    }

    if (this.owners.length === 0) {
      this.pendingFinalFocus = {
        target: this.baselineFocus,
        restoreRequested: restoreFocus,
      };
      this.baselineFocus = null;
    }

    try {
      this.recomputeIsolation();
    } catch {
      this.recoverIsolationBestEffort();
    } finally {
      this.stopRuntimeIfInactive();
      this.finishPendingFocusIfSettled();
    }
  }

  forget(owner: CoordinatorOwner): void {
    if (this.owners.includes(owner)) this.deactivate(owner, false);
    const state = this.isolation.get(owner.overlay);
    if (state) {
      this.isolation.delete(owner.overlay);
      this.restoreStateBestEffort(state);
    }
  }

  isActive(owner: CoordinatorOwner): boolean {
    return this.owners.includes(owner);
  }

  focus(owner: CoordinatorOwner): void {
    if (this.findTopVisibleOwner() === owner) {
      owner.iframe.focus();
      return;
    }
    this.redirectFocusToTopOwner();
  }

  private removeOwner(owner: CoordinatorOwner): boolean {
    const index = this.owners.indexOf(owner);
    if (index === -1) return false;
    this.owners.splice(index, 1);
    this.revision += 1;
    return true;
  }

  private returnInheritedFinalFocus(inheritedFinalFocus: PendingFinalFocus | null): void {
    if (inheritedFinalFocus && this.owners.length === 0) {
      this.pendingFinalFocus = inheritedFinalFocus;
    }
  }

  private startRuntime(): void {
    if (!this.observer) {
      const observer = new MutationObserver((records) => {
        this.handleMutations(records);
      });
      this.observer = observer;
      observer.observe(this.ownerDocument.documentElement, {
        attributes: true,
        attributeFilter: ["inert", "aria-hidden"],
        attributeOldValue: true,
        childList: true,
        subtree: true,
      });
    }

    this.reconcileDocumentListeners();
  }

  private stopRuntimeIfInactive(): void {
    if (this.owners.length > 0) {
      this.reconcileDocumentListeners();
      return;
    }

    if (this.settlingMutationRecords) {
      this.mutationSettlementRequested = true;
      return;
    }

    this.settlePendingMutationRecords();
    if (this.owners.length > 0) {
      this.reconcileDocumentListeners();
      return;
    }

    const observer = this.observer;
    this.observer = null;
    if (observer) {
      try {
        observer.disconnect();
      } catch {
        // Observer teardown is best-effort after ownership has already been released.
      }
    }
    this.internalAttributeWrites.clear();

    this.reconcileDocumentListeners();
  }

  private reconcileDocumentListeners(): void {
    if (this.reconcilingDocumentListeners) {
      this.documentListenerReconciliationRequested = true;
      return;
    }

    this.reconcilingDocumentListeners = true;
    try {
      do {
        this.documentListenerReconciliationRequested = false;
        const expectedRevision = this.revision;
        const shouldListen = this.owners.length > 0;
        if (shouldListen && !this.focusinListening) {
          this.focusinListening = true;
          this.ownerDocument.addEventListener("focusin", this.focusinListener, true);
        } else if (!shouldListen && this.focusinListening) {
          this.focusinListening = false;
          try {
            this.ownerDocument.removeEventListener("focusin", this.focusinListener, true);
          } catch {
            // Ownership is released before the best-effort DOM listener cleanup.
          }
        }
        if (shouldListen && !this.keydownListening) {
          this.keydownListening = true;
          this.ownerDocument.addEventListener("keydown", this.keydownListener);
        } else if (!shouldListen && this.keydownListening) {
          this.keydownListening = false;
          try {
            this.ownerDocument.removeEventListener("keydown", this.keydownListener);
          } catch {
            // Ownership is released before the best-effort DOM listener cleanup.
          }
        }
        if (
          this.revision !== expectedRevision ||
          this.focusinListening !== this.owners.length > 0 ||
          this.keydownListening !== this.owners.length > 0
        ) {
          this.documentListenerReconciliationRequested = true;
        }
        if (this.focusinListening && this.owners.length > 0) {
          this.redirectFocusIfOutsideActiveOverlay();
        }
      } while (this.documentListenerReconciliationRequested);
    } finally {
      this.reconcilingDocumentListeners = false;
    }
  }

  private handleMutations(records: readonly MutationRecord[]): void {
    this.processMutationRecords(records);
    this.stopRuntimeIfInactive();
    this.finishPendingFocusIfSettled();
  }

  private processMutationRecords(records: readonly MutationRecord[]): void {
    try {
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (
          record.type === "attributes" &&
          (record.attributeName === "inert" || record.attributeName === "aria-hidden")
        ) {
          const nextRecord = records
            .slice(index + 1)
            .find(
              (candidate) =>
                candidate.type === "attributes" &&
                candidate.target === record.target &&
                candidate.attributeName === record.attributeName
            );
          const to = nextRecord
            ? this.attributeSnapshotFromOldValue(nextRecord.oldValue)
            : this.snapshotAttribute(record.target as Element, record.attributeName, null);
          this.captureExternalAttributeMutation(
            record.target as Element,
            record.attributeName,
            record.oldValue,
            to
          );
        }
        for (const removedNode of Array.from(record.removedNodes)) {
          this.disconnectOwnersRemovedBy(removedNode);
          this.rollOverRemovedIsolation(removedNode);
        }
      }

      this.recomputeIsolation();
      this.redirectFocusIfNewlyIsolated();
    } catch {
      this.recoverIsolationBestEffort();
    }
  }

  private settlePendingMutationRecords(): void {
    if (this.settlingMutationRecords) {
      this.mutationSettlementRequested = true;
      return;
    }

    this.settlingMutationRecords = true;
    try {
      let passes = 0;
      do {
        this.mutationSettlementRequested = false;
        const observer = this.observer;
        if (!observer) break;
        let records: MutationRecord[];
        try {
          records = observer.takeRecords();
        } catch {
          break;
        }
        if (records.length === 0) break;
        passes += 1;
        this.processMutationRecords(records);
      } while (
        passes < maxMutationSettlementPasses &&
        (this.mutationSettlementRequested || this.observer !== null)
      );
    } finally {
      this.settlingMutationRecords = false;
      this.mutationSettlementRequested = false;
    }
  }

  private disconnectOwnersRemovedBy(removedNode: Node): void {
    for (const owner of [...this.owners]) {
      if (!owner.wasRemoved(removedNode)) continue;
      owner.disconnect();
      if (this.owners.includes(owner)) this.removeOwner(owner);
    }
  }

  private rollOverRemovedIsolation(removedNode: Node): void {
    for (const state of Array.from(this.isolation.values())) {
      if (!removedNodeContains(removedNode, state.element)) continue;
      this.restoreState(state, this.revision, false);
      this.isolation.delete(state.element);
    }
  }

  private recomputeIsolation(): boolean {
    if (this.reconciling) {
      this.reconciliationRequested = true;
      return false;
    }

    this.reconciling = true;
    try {
      do {
        this.reconciliationRequested = false;
        const expectedRevision = this.revision;
        try {
          this.recomputeIsolationOnce(expectedRevision);
        } catch (error) {
          if (error !== reconciliationInterrupted) throw error;
          this.reconciliationRequested = true;
        }
        if (this.revision !== expectedRevision) this.reconciliationRequested = true;
      } while (this.reconciliationRequested);
      return true;
    } finally {
      this.reconciling = false;
    }
  }

  private recomputeIsolationOnce(expectedRevision: number): void {
    this.assertStable(expectedRevision);
    const protectedElements = this.collectProtectedElements(expectedRevision);
    const isolatedElements = this.collectIsolatedElements(protectedElements, expectedRevision);

    for (const [element, state] of Array.from(this.isolation)) {
      this.assertStable(expectedRevision);
      if (!isolatedElements.has(element)) {
        this.restoreState(state, expectedRevision, false);
        this.isolation.delete(element);
        continue;
      }

      this.captureExternalInertPropertyMutation(state, expectedRevision);
      if (!this.matchesAppliedState(state, expectedRevision)) {
        this.applyIsolation(state, expectedRevision);
      }
    }

    for (const element of isolatedElements) {
      this.assertStable(expectedRevision);
      if (this.isolation.has(element)) continue;
      const state = this.createIsolationState(element, expectedRevision);
      this.isolation.set(element, state);
      this.applyIsolation(state, expectedRevision);
    }
  }

  private collectProtectedElements(expectedRevision: number): Set<Element> {
    const protectedElements = new Set<Element>();
    for (const owner of this.owners) {
      let current: Element | null = owner.overlay;
      while (current) {
        protectedElements.add(current);
        if (current === this.ownerDocument.body) break;
        current = current.parentElement;
        this.assertStable(expectedRevision);
      }
      if (current !== this.ownerDocument.body) {
        owner.disconnect();
        throw reconciliationInterrupted;
      }
    }
    return protectedElements;
  }

  private collectIsolatedElements(
    protectedElements: ReadonlySet<Element>,
    expectedRevision: number
  ): Set<Element> {
    const isolatedElements = new Set<Element>();
    for (const owner of this.owners) {
      let pathElement: Element = owner.overlay;
      while (pathElement !== this.ownerDocument.body) {
        const parent = pathElement.parentElement;
        this.assertStable(expectedRevision);
        if (!parent) {
          owner.disconnect();
          throw reconciliationInterrupted;
        }
        for (const sibling of Array.from(parent.children)) {
          if (sibling !== pathElement && !protectedElements.has(sibling)) {
            isolatedElements.add(sibling);
          }
        }
        pathElement = parent;
      }
    }
    return isolatedElements;
  }

  private createIsolationState(element: Element, expectedRevision: number): IsolationState {
    const baseline = this.snapshotElement(element, expectedRevision);
    return {
      element,
      baseline,
      applied: {
        element,
        inertSupported: baseline.inertSupported,
        inertValue: true,
        inertAttribute: appliedInertAttribute,
        ariaHiddenAttribute: appliedAriaHiddenAttribute,
      },
    };
  }

  private snapshotElement(element: Element, expectedRevision: number | null): IsolationSnapshot {
    let inertSupported = false;
    let inertValue = false;
    if ("inert" in element) {
      const value = (element as InertElement).inert;
      this.assertStableIfNeeded(expectedRevision);
      inertSupported = typeof value === "boolean";
      inertValue = inertSupported ? value : false;
    }
    const inertAttribute = this.snapshotAttribute(element, "inert", expectedRevision);
    const ariaHiddenAttribute = this.snapshotAttribute(element, "aria-hidden", expectedRevision);
    return { element, inertSupported, inertValue, inertAttribute, ariaHiddenAttribute };
  }

  private snapshotAttribute(
    element: Element,
    name: string,
    expectedRevision: number | null
  ): AttributeSnapshot {
    const present = element.hasAttribute(name);
    this.assertStableIfNeeded(expectedRevision);
    const value = element.getAttribute(name);
    this.assertStableIfNeeded(expectedRevision);
    return { present, value };
  }

  private matchesAppliedState(state: IsolationState, expectedRevision: number): boolean {
    const current = this.snapshotElement(state.element, expectedRevision);
    return (
      (!state.applied.inertSupported || current.inertValue === state.applied.inertValue) &&
      attributesEqual(current.inertAttribute, state.applied.inertAttribute) &&
      attributesEqual(current.ariaHiddenAttribute, state.applied.ariaHiddenAttribute)
    );
  }

  private captureExternalInertPropertyMutation(
    state: IsolationState,
    expectedRevision: number
  ): void {
    if (!state.applied.inertSupported) return;
    const current = this.snapshotElement(state.element, expectedRevision);
    if (current.inertValue === state.applied.inertValue) return;
    state.baseline = { ...state.baseline, inertValue: current.inertValue };
  }

  private applyIsolation(state: IsolationState, expectedRevision: number): void {
    let current = this.snapshotElement(state.element, expectedRevision);
    if (!attributesEqual(current.inertAttribute, state.applied.inertAttribute)) {
      this.writeAttribute(state.element, "inert", state.applied.inertAttribute, expectedRevision);
      current = this.snapshotElement(state.element, expectedRevision);
    }
    if (state.applied.inertSupported && current.inertValue !== state.applied.inertValue) {
      this.mutate(expectedRevision, () => {
        (state.element as InertElement).inert = state.applied.inertValue;
      });
    }
    current = this.snapshotElement(state.element, expectedRevision);
    if (!attributesEqual(current.ariaHiddenAttribute, state.applied.ariaHiddenAttribute)) {
      this.writeAttribute(
        state.element,
        "aria-hidden",
        state.applied.ariaHiddenAttribute,
        expectedRevision
      );
    }
  }

  private restoreState(
    state: IsolationState,
    expectedRevision: number | null,
    bestEffort: boolean
  ): void {
    let current = this.snapshotElement(state.element, expectedRevision);
    const inertAttributeOwned = attributesEqual(
      current.inertAttribute,
      state.applied.inertAttribute
    );
    const inertPropertyOwned =
      !state.applied.inertSupported || current.inertValue === state.applied.inertValue;
    const ariaHiddenOwned = attributesEqual(
      current.ariaHiddenAttribute,
      state.applied.ariaHiddenAttribute
    );

    let desiredInertAttribute: AttributeSnapshot;
    let desiredInertValue: boolean;
    if (!inertAttributeOwned) {
      desiredInertAttribute = current.inertAttribute;
      desiredInertValue = current.inertValue;
    } else if (!inertPropertyOwned) {
      desiredInertAttribute = state.baseline.inertAttribute;
      desiredInertValue = current.inertValue;
    } else {
      desiredInertAttribute = state.baseline.inertAttribute;
      desiredInertValue = state.baseline.inertValue;
    }
    const perform = <Result>(operation: () => Result): Result | null => {
      if (!bestEffort) {
        return operation();
      }
      try {
        return operation();
      } catch {
        // Continue restoring independent channels after a hostile DOM callback throws.
        return null;
      }
    };

    if (state.baseline.inertSupported && current.inertValue !== desiredInertValue) {
      const propertyMutation = perform(() =>
        this.mutateInertProperty(state.element, desiredInertValue, expectedRevision)
      );
      current = this.snapshotElement(state.element, expectedRevision);
      const externalAttributeAfter =
        (propertyMutation?.coordinatorRecordsSettled
          ? state.baseline.inertAttribute
          : propertyMutation?.externalAttributeAfter) ??
        (propertyMutation &&
        !attributesEqual(current.inertAttribute, propertyMutation.attributeBefore) &&
        !attributesEqual(current.inertAttribute, propertyMutation.reflectedAttribute)
          ? current.inertAttribute
          : null);
      if (externalAttributeAfter) {
        desiredInertAttribute = externalAttributeAfter;
        desiredInertValue = current.inertValue;
        state.baseline = {
          ...state.baseline,
          inertAttribute: externalAttributeAfter,
          inertValue: current.inertValue,
        };
      }
    }
    if (!attributesEqual(current.inertAttribute, desiredInertAttribute)) {
      perform(() =>
        this.writeAttribute(state.element, "inert", desiredInertAttribute, expectedRevision)
      );
      current = this.snapshotElement(state.element, expectedRevision);
    }
    const desiredAriaHidden =
      ariaHiddenOwned &&
      attributesEqual(current.ariaHiddenAttribute, state.applied.ariaHiddenAttribute)
        ? state.baseline.ariaHiddenAttribute
        : current.ariaHiddenAttribute;
    if (!attributesEqual(current.ariaHiddenAttribute, desiredAriaHidden)) {
      perform(() =>
        this.writeAttribute(state.element, "aria-hidden", desiredAriaHidden, expectedRevision)
      );
    }
  }

  private restoreStateBestEffort(state: IsolationState): void {
    try {
      this.restoreState(state, null, true);
    } catch {
      // A throwing getter must not strand coordinator listener or observer ownership.
    }
  }

  private writeAttribute(
    element: Element,
    name: IsolationAttributeName,
    snapshot: AttributeSnapshot,
    expectedRevision: number | null
  ): void {
    const previous = this.snapshotAttribute(element, name, expectedRevision);
    const internalWrite = this.observesAttributeWritesFor(element)
      ? this.recordInternalAttributeWrite(element, name, previous, snapshot)
      : null;
    try {
      if (snapshot.present) element.setAttribute(name, snapshot.value ?? "");
      else element.removeAttribute(name);
    } catch (error) {
      if (internalWrite) {
        this.discardUnappliedInternalAttributeWrite(element, name, previous, internalWrite);
      }
      throw error;
    }
    this.assertStableIfNeeded(expectedRevision);
  }

  private mutateInertProperty(
    element: Element,
    value: boolean,
    expectedRevision: number | null
  ): InertPropertyMutation {
    const attributeBefore = this.snapshotAttribute(element, "inert", expectedRevision);
    const reflectedAttribute = value ? appliedInertAttribute : { present: false, value: null };
    const observedByCoordinator = this.observesAttributeWritesFor(element);
    const needsLocalJournal = !observedByCoordinator || this.settlingMutationRecords;
    const internalWrite = observedByCoordinator
      ? this.recordInternalAttributeWrite(element, "inert", attributeBefore, reflectedAttribute)
      : null;
    let journal: MutationObserver | null = null;
    let journalAvailable = false;
    if (needsLocalJournal) {
      try {
        journal = new MutationObserver(() => undefined);
        journal.observe(element, {
          attributes: true,
          attributeFilter: ["inert"],
          attributeOldValue: true,
        });
        journalAvailable = true;
      } catch {
        if (journal) {
          try {
            journal.disconnect();
          } catch {
            // Attribute journaling is diagnostic; property restoration still proceeds.
          }
        }
        journal = null;
      }
    }

    let mutationFailed = false;
    let mutationError: unknown;
    try {
      this.mutateIfNeeded(expectedRevision, () => {
        (element as InertElement).inert = value;
      });
    } catch (error) {
      mutationFailed = true;
      mutationError = error;
    }

    if (observedByCoordinator && !needsLocalJournal) this.settlePendingMutationRecords();

    let journalRecords: readonly MutationRecord[] = [];
    if (journal) {
      try {
        journalRecords = journal.takeRecords();
      } catch {
        journalAvailable = false;
      } finally {
        try {
          journal.disconnect();
        } catch {
          // Attribute journaling must never strand restoration ownership.
        }
      }
    }

    let attributeAfter: AttributeSnapshot;
    try {
      attributeAfter = this.snapshotAttribute(element, "inert", expectedRevision);
    } catch (error) {
      if (mutationFailed) throw mutationError;
      throw error;
    }
    const journalResult = journalAvailable
      ? this.classifyInertPropertyAttributeRecords(
          element,
          journalRecords,
          attributeBefore,
          attributeAfter,
          reflectedAttribute
        )
      : null;
    if (internalWrite && journalResult && !journalResult.internalMutationObserved) {
      this.removeInternalAttributeWrite(element, "inert", internalWrite);
    } else if (
      internalWrite &&
      !journalResult &&
      attributesEqual(attributeAfter, attributeBefore)
    ) {
      this.discardUnappliedInternalAttributeWrite(element, "inert", attributeBefore, internalWrite);
    }
    if (mutationFailed) throw mutationError;
    return {
      attributeAfter,
      attributeBefore,
      coordinatorRecordsSettled: observedByCoordinator && !needsLocalJournal,
      externalAttributeAfter: journalResult?.externalAttributeAfter ?? null,
      reflectedAttribute,
    };
  }

  private classifyInertPropertyAttributeRecords(
    element: Element,
    records: readonly MutationRecord[],
    attributeBefore: AttributeSnapshot,
    attributeAfter: AttributeSnapshot,
    reflectedAttribute: AttributeSnapshot
  ): { externalAttributeAfter: AttributeSnapshot | null; internalMutationObserved: boolean } {
    const inertRecords = records.filter(
      (record) =>
        record.type === "attributes" &&
        record.target === element &&
        record.attributeName === "inert"
    );
    let externalAttributeAfter: AttributeSnapshot | null = null;
    let internalMutationObserved = false;
    for (let index = 0; index < inertRecords.length; index += 1) {
      const record = inertRecords[index];
      const from = this.attributeSnapshotFromOldValue(record.oldValue);
      const nextRecord = inertRecords[index + 1];
      const to = nextRecord
        ? this.attributeSnapshotFromOldValue(nextRecord.oldValue)
        : attributeAfter;
      if (
        !internalMutationObserved &&
        attributesEqual(from, attributeBefore) &&
        attributesEqual(to, reflectedAttribute)
      ) {
        internalMutationObserved = true;
      } else {
        externalAttributeAfter = to;
      }
    }
    return { externalAttributeAfter, internalMutationObserved };
  }

  private observesAttributeWritesFor(element: Element): boolean {
    if (!this.observer) return false;
    try {
      return (
        element.ownerDocument === this.ownerDocument &&
        element.isConnected &&
        (element === this.ownerDocument.documentElement ||
          this.ownerDocument.documentElement.contains(element))
      );
    } catch {
      return false;
    }
  }

  private recordInternalAttributeWrite(
    element: Element,
    name: IsolationAttributeName,
    from: AttributeSnapshot,
    to: AttributeSnapshot
  ): InternalAttributeWrite {
    let byAttribute = this.internalAttributeWrites.get(element);
    if (!byAttribute) {
      byAttribute = new Map();
      this.internalAttributeWrites.set(element, byAttribute);
    }
    const writes = byAttribute.get(name) ?? [];
    const write = { from, to };
    writes.push(write);
    byAttribute.set(name, writes);
    return write;
  }

  private discardUnappliedInternalAttributeWrite(
    element: Element,
    name: IsolationAttributeName,
    previous: AttributeSnapshot,
    write: InternalAttributeWrite
  ): void {
    let current: AttributeSnapshot;
    try {
      current = this.snapshotAttribute(element, name, null);
    } catch {
      return;
    }
    if (!attributesEqual(current, previous)) return;

    const byAttribute = this.internalAttributeWrites.get(element);
    const writes = byAttribute?.get(name);
    const index = writes?.indexOf(write) ?? -1;
    if (index === -1) return;
    writes?.splice(index, 1);
    if (writes?.length === 0) byAttribute?.delete(name);
    if (byAttribute?.size === 0) this.internalAttributeWrites.delete(element);
  }

  private removeInternalAttributeWrite(
    element: Element,
    name: IsolationAttributeName,
    write: InternalAttributeWrite
  ): void {
    const byAttribute = this.internalAttributeWrites.get(element);
    const writes = byAttribute?.get(name);
    const index = writes?.indexOf(write) ?? -1;
    if (index === -1) return;
    writes?.splice(index, 1);
    if (writes?.length === 0) byAttribute?.delete(name);
    if (byAttribute?.size === 0) this.internalAttributeWrites.delete(element);
  }

  private captureExternalAttributeMutation(
    element: Element,
    name: IsolationAttributeName,
    oldValue: string | null,
    to: AttributeSnapshot
  ): void {
    const from = this.attributeSnapshotFromOldValue(oldValue);

    if (this.consumeInternalAttributeWrite(element, name, from, to)) return;
    const state = this.isolation.get(element);
    if (!state) return;
    if (name === "inert") {
      state.baseline = { ...state.baseline, inertAttribute: to };
    } else {
      state.baseline = { ...state.baseline, ariaHiddenAttribute: to };
    }
  }

  private consumeInternalAttributeWrite(
    element: Element,
    name: IsolationAttributeName,
    from: AttributeSnapshot,
    to: AttributeSnapshot
  ): boolean {
    const byAttribute = this.internalAttributeWrites.get(element);
    const writes = byAttribute?.get(name);
    const next = writes?.[0];
    if (!next || !attributesEqual(next.from, from) || !attributesEqual(next.to, to)) {
      return false;
    }
    writes?.shift();
    if (writes?.length === 0) byAttribute?.delete(name);
    if (byAttribute?.size === 0) this.internalAttributeWrites.delete(element);
    return true;
  }

  private attributeSnapshotFromOldValue(oldValue: string | null): AttributeSnapshot {
    return oldValue === null ? { present: false, value: null } : { present: true, value: oldValue };
  }

  private mutate(expectedRevision: number, mutation: () => void): void {
    mutation();
    this.assertStable(expectedRevision);
  }

  private mutateIfNeeded(expectedRevision: number | null, mutation: () => void): void {
    mutation();
    this.assertStableIfNeeded(expectedRevision);
  }

  private assertStableIfNeeded(expectedRevision: number | null): void {
    if (expectedRevision !== null) this.assertStable(expectedRevision);
  }

  private assertStable(expectedRevision: number): void {
    if (this.revision !== expectedRevision) throw reconciliationInterrupted;
    for (const owner of [...this.owners]) {
      let ownsMount = false;
      try {
        ownsMount = owner.ownsMount();
      } catch {
        ownsMount = false;
      }
      if (!ownsMount) {
        owner.disconnect();
        if (this.owners.includes(owner)) this.removeOwner(owner);
        throw reconciliationInterrupted;
      }
      if (this.revision !== expectedRevision) throw reconciliationInterrupted;
    }
  }

  private recoverIsolationBestEffort(): void {
    if (this.owners.length === 0) {
      for (const state of Array.from(this.isolation.values())) {
        this.restoreStateBestEffort(state);
      }
      this.isolation.clear();
      return;
    }

    try {
      this.recomputeIsolation();
    } catch {
      // Existing owners keep their recorded baselines; a later mutation or close retries cleanup.
    }
  }

  private isInsideOwnerOverlay(target: Node, owner: CoordinatorOwner): boolean {
    try {
      return owner.overlay === target || owner.overlay.contains(target);
    } catch {
      return false;
    }
  }

  private isInsideTopVisibleOverlay(target: Node): boolean {
    const owner = this.findTopVisibleOwner();
    return owner ? this.isInsideOwnerOverlay(target, owner) : false;
  }

  private redirectFocusIfNewlyIsolated(): void {
    const activeElement = safeActiveElement(this.ownerDocument);
    if (!activeElement) return;
    const newlyIsolated = Array.from(this.isolation.keys()).some((element) => {
      try {
        return element === activeElement || element.contains(activeElement);
      } catch {
        return false;
      }
    });
    if (newlyIsolated) this.redirectFocusToTopOwner();
  }

  private redirectFocusToTopOwner(): void {
    if (this.redirectingFocus) {
      this.focusRedirectionRequested = true;
      return;
    }

    this.redirectingFocus = true;
    try {
      let attempts = 0;
      do {
        this.focusRedirectionRequested = false;
        const owner = this.findTopVisibleOwner();
        if (!owner) return;
        try {
          owner.iframe.focus();
        } catch {
          // Focus containment is best-effort and guarded against hostile focus callbacks.
          return;
        }
        attempts += 1;
        const activeElement = safeActiveElement(this.ownerDocument);
        if (activeElement && !this.isInsideTopVisibleOverlay(activeElement)) {
          this.focusRedirectionRequested = true;
        }
      } while (this.focusRedirectionRequested && attempts < 2);
    } finally {
      this.redirectingFocus = false;
      this.focusRedirectionRequested = false;
    }
  }

  private redirectFocusIfOutsideActiveOverlay(): void {
    const activeElement = safeActiveElement(this.ownerDocument);
    if (!activeElement || this.isInsideTopVisibleOverlay(activeElement)) return;
    this.redirectFocusToTopOwner();
  }

  private findTopVisibleOwner(): CoordinatorOwner | undefined {
    return [...this.owners].reverse().find((candidate) => {
      try {
        return (
          candidate.ownsMount() &&
          !candidate.overlay.hasAttribute("inert") &&
          candidate.overlay.getAttribute("aria-hidden") !== "true"
        );
      } catch {
        return false;
      }
    });
  }

  private finishPendingFocusIfSettled(): void {
    if (this.reconciling || this.owners.length > 0 || this.isolation.size > 0) return;
    const pendingFinalFocus = this.pendingFinalFocus;
    this.pendingFinalFocus = null;
    if (pendingFinalFocus?.restoreRequested) {
      focusBestEffort(pendingFinalFocus.target, this.ownerDocument);
    }
  }
}

function getDocumentCoordinator(ownerDocument: Document): HostSurfaceCoordinator {
  const existing = documentCoordinators.get(ownerDocument);
  if (existing) return existing;
  const coordinator = new HostSurfaceCoordinator(ownerDocument);
  documentCoordinators.set(ownerDocument, coordinator);
  return coordinator;
}

type SurfaceLifecycle =
  "hidden" | "showing" | "shown" | "focusing" | "cleaning" | "disconnected" | "destroyed";

class BrowserHostSurface implements HostSurface {
  readonly iframe: HTMLIFrameElement;

  private readonly ownerDocument: Document;
  private readonly overlay: HTMLDivElement;
  private readonly mountParent: HTMLElement;
  private readonly mountPath: readonly Element[];
  private readonly configuredContainer: HTMLElement | null;
  private readonly coordinator: HostSurfaceCoordinator;
  private readonly coordinatorOwner: CoordinatorOwner;
  private readonly detachOwnedOverlay: () => void;
  private readonly onEscape: () => void;
  private readonly onDisconnect: () => void;
  private containerObserver: MutationObserver | null = null;
  private lifecycle: SurfaceLifecycle = "hidden";
  private lifecycleGeneration = 0;
  private disconnectNotified = false;

  constructor(options: HostSurfaceOptions) {
    const ownerDocument = document;
    const mountParent = options.container ?? ownerDocument.body;
    if (!mountParent || !isLightDomContainer(mountParent, ownerDocument)) {
      throw new HostSurfaceContainerDisconnectedError();
    }

    this.ownerDocument = ownerDocument;
    this.mountParent = mountParent;
    this.mountPath = this.captureMountPath(mountParent);
    this.configuredContainer = options.container ?? null;
    this.onEscape = options.onEscape;
    this.onDisconnect = options.onDisconnect;
    this.coordinator = getDocumentCoordinator(ownerDocument);

    const overlay = ownerDocument.createElement("div");
    overlay.id = "ohmywallet-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "OhMyWallet");
    overlay.setAttribute("inert", "");
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 99999;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease;
    `;
    overlay.style.opacity = "0";
    overlay.style.pointerEvents = "none";

    const iframeContainer = ownerDocument.createElement("div");
    iframeContainer.style.cssText = `
      width: 100%;
      max-width: 420px;
      height: 90%;
      max-height: 700px;
      background: transparent;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: none;
      position: relative;
    `;

    const iframe = ownerDocument.createElement("iframe");
    iframe.src = options.iframeSrc;
    iframe.title = "OhMyWallet";
    iframe.referrerPolicy = "no-referrer";
    iframe.style.cssText = `
      width: 100%;
      height: 100%;
      border: none;
    `;
    iframe.setAttribute("sandbox", options.sandbox);

    iframeContainer.appendChild(iframe);
    overlay.appendChild(iframeContainer);

    const removeOverlay = overlay.remove.bind(overlay);
    const removeChild = mountParent.removeChild;
    this.detachOwnedOverlay = () => {
      let cleanupError: unknown;
      try {
        removeOverlay();
      } catch (error) {
        cleanupError = error;
      }

      let parent = overlay.parentElement;
      if (parent) {
        try {
          removeChild.call(parent, overlay);
        } catch (error) {
          cleanupError ??= error;
        }
        parent = overlay.parentElement;
      }
      if (parent !== null || overlay.isConnected) {
        throw cleanupError instanceof Error
          ? cleanupError
          : new Error("Host surface overlay could not be detached");
      }
    };

    this.overlay = overlay;
    this.iframe = iframe;
    this.coordinatorOwner = {
      overlay,
      iframe,
      ownsMount: () => this.ownsExactMount(),
      wasRemoved: (removedNode) => this.removedNodeBreaksMount(removedNode),
      disconnect: () => this.handleMountLoss(),
      escape: () => this.onEscape(),
    };

    let observer: MutationObserver | null = null;
    try {
      if (this.configuredContainer) {
        observer = new MutationObserver((records) => {
          this.handleContainerMutation(records);
        });
        this.containerObserver = observer;
        observer.observe(ownerDocument.documentElement, {
          childList: true,
          subtree: true,
        });
      }
      mountParent.appendChild(overlay);
      if (observer) {
        this.handleContainerMutation(observer.takeRecords());
      }
      if (this.lifecycle === "disconnected" || !this.ownsExactMount()) {
        throw new HostSurfaceContainerDisconnectedError();
      }
    } catch (error) {
      const mountedObserver = this.containerObserver === observer ? observer : null;
      this.containerObserver = null;
      if (mountedObserver) this.attemptCleanup(() => mountedObserver.disconnect());
      this.attemptCleanup(this.detachOwnedOverlay);
      throw error;
    }
  }

  show(initiator: Element | null): void {
    if (this.lifecycle === "cleaning") throw new Error("Host surface is cleaning up");
    if (this.lifecycle === "destroyed" || this.lifecycle === "disconnected") return;
    if (this.lifecycle === "shown") {
      this.focusShownSurface();
      return;
    }
    if (this.lifecycle !== "hidden") return;
    if (!this.ownsExactMount()) {
      this.handleMountLoss();
      return;
    }

    const generation = ++this.lifecycleGeneration;
    this.lifecycle = "showing";
    let focusAttempted = false;
    try {
      const activationSettled = this.coordinator.activate(this.coordinatorOwner, initiator);
      if (!this.ownsShowLifecycle(generation)) {
        this.abortShowAttempt(generation, false);
        return;
      }
      if (!activationSettled) throw new Error("Host surface activation was interrupted");
      if (!this.assertShowOwnership(generation)) return;

      this.overlay.removeAttribute("inert");
      if (!this.assertShowOwnership(generation)) return;
      this.overlay.removeAttribute("aria-hidden");
      if (!this.assertShowOwnership(generation)) return;
      this.overlay.style.opacity = "1";
      if (!this.assertShowOwnership(generation)) return;
      this.overlay.style.pointerEvents = "auto";
      if (!this.assertShowOwnership(generation)) return;

      focusAttempted = true;
      this.coordinator.focus(this.coordinatorOwner);
      if (!this.assertShowOwnership(generation)) return;
      this.lifecycle = "shown";
    } catch (error) {
      this.abortShowAttempt(generation, focusAttempted);
      throw error;
    }
  }

  hide({ restoreFocus }: { restoreFocus: boolean }): void {
    if (this.lifecycle !== "shown") return;

    const cleanupGeneration = ++this.lifecycleGeneration;
    this.lifecycle = "cleaning";
    this.concealOverlay();
    this.attemptCleanup(() => this.coordinator.deactivate(this.coordinatorOwner, restoreFocus));

    if (this.lifecycleGeneration === cleanupGeneration && this.lifecycle === "cleaning") {
      this.lifecycle = "hidden";
    }
  }

  destroy(): void {
    if (this.lifecycle === "destroyed") return;

    this.lifecycleGeneration += 1;
    this.lifecycle = "destroyed";
    this.concealOverlay();
    this.attemptCleanup(() => this.coordinator.deactivate(this.coordinatorOwner, false));
    const observer = this.containerObserver;
    this.containerObserver = null;
    if (observer) this.attemptCleanup(() => observer.disconnect());
    this.attemptCleanup(this.detachOwnedOverlay);
    this.attemptCleanup(() => this.coordinator.forget(this.coordinatorOwner));
  }

  private ownsShowLifecycle(generation: number): boolean {
    return this.lifecycleGeneration === generation && this.lifecycle === "showing";
  }

  private assertShowOwnership(generation: number): boolean {
    if (!this.ownsShowLifecycle(generation)) {
      this.abortShowAttempt(generation, false);
      return false;
    }
    if (!this.ownsExactMount()) {
      this.handleMountLoss();
      return false;
    }
    if (!this.coordinator.isActive(this.coordinatorOwner)) {
      throw new Error("Host surface activation was interrupted");
    }
    return true;
  }

  private focusShownSurface(): void {
    const generation = ++this.lifecycleGeneration;
    this.lifecycle = "focusing";
    try {
      this.coordinator.focus(this.coordinatorOwner);
    } catch (error) {
      if (this.lifecycleGeneration === generation && this.lifecycle === "focusing") {
        this.lifecycle = "shown";
      }
      throw error;
    }
    if (this.lifecycleGeneration === generation && this.lifecycle === "focusing") {
      this.lifecycle = "shown";
    }
  }

  private abortShowAttempt(generation: number, restoreFocus: boolean): void {
    this.concealOverlay();
    this.attemptCleanup(() => this.coordinator.deactivate(this.coordinatorOwner, restoreFocus));

    if (!this.ownsShowLifecycle(generation)) return;
    this.lifecycleGeneration += 1;
    this.lifecycle = "hidden";
  }

  private concealOverlay(): void {
    this.attemptCleanup(() => {
      this.overlay.style.opacity = "0";
    });
    this.attemptCleanup(() => {
      this.overlay.style.pointerEvents = "none";
    });
    this.attemptCleanup(() => this.overlay.setAttribute("inert", ""));
    this.attemptCleanup(() => this.overlay.setAttribute("aria-hidden", "true"));
  }

  private attemptCleanup(cleanup: () => void): void {
    try {
      cleanup();
    } catch {
      // Lifecycle cleanup remains authoritative when DOM callbacks throw.
    }
  }

  private captureMountPath(element: Element): readonly Element[] {
    const path: Element[] = [];
    let current: Element | null = element;
    while (current) {
      path.push(current);
      if (current === this.ownerDocument.body) break;
      current = current.parentElement;
    }
    return path;
  }

  private ownsExactMount(): boolean {
    try {
      if (this.overlay.parentElement !== this.mountParent) return false;
      if (!isLightDomContainer(this.mountParent, this.ownerDocument)) return false;
      for (let index = 0; index < this.mountPath.length - 1; index += 1) {
        if (this.mountPath[index]?.parentElement !== this.mountPath[index + 1]) return false;
      }
      return this.mountPath.at(-1) === this.ownerDocument.body;
    } catch {
      return false;
    }
  }

  private removedNodeBreaksMount(removedNode: Node): boolean {
    if (removedNodeContains(removedNode, this.overlay)) return true;
    return this.mountPath.some((element) => removedNodeContains(removedNode, element));
  }

  private handleContainerMutation(records: readonly MutationRecord[]): void {
    if (this.lifecycle === "destroyed" || this.lifecycle === "disconnected") return;
    const pathWasRemoved = records.some((record) =>
      Array.from(record.removedNodes).some((removedNode) =>
        this.mountPath.some((element) => removedNodeContains(removedNode, element))
      )
    );
    if (!pathWasRemoved && this.ownsExactMount()) return;
    this.handleMountLoss();
  }

  private handleMountLoss(): void {
    if (
      this.lifecycle === "destroyed" ||
      this.lifecycle === "disconnected" ||
      this.disconnectNotified
    ) {
      return;
    }

    this.disconnectNotified = true;
    this.lifecycleGeneration += 1;
    this.lifecycle = "disconnected";
    this.concealOverlay();
    this.attemptCleanup(() => this.coordinator.deactivate(this.coordinatorOwner, false));
    const observer = this.containerObserver;
    this.containerObserver = null;
    if (observer) this.attemptCleanup(() => observer.disconnect());
    this.attemptCleanup(this.onDisconnect);
  }
}

export function createHostSurface(options: HostSurfaceOptions): HostSurface {
  return new BrowserHostSurface(options);
}

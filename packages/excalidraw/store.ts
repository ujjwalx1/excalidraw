import { getDefaultAppState } from "./appState";
import { AppStateChange, ElementsChange } from "./change";
import { newElementWith } from "./element/mutateElement";
import { deepCopyElement } from "./element/newElement";
import { ExcalidrawElement } from "./element/types";
import { Emitter } from "./emitter";
import { AppState, ObservedAppState } from "./types";
import { isShallowEqual } from "./utils";

const getObservedAppState = (appState: AppState): ObservedAppState => {
  return {
    name: appState.name,
    editingGroupId: appState.editingGroupId,
    viewBackgroundColor: appState.viewBackgroundColor,
    selectedElementIds: appState.selectedElementIds,
    selectedGroupIds: appState.selectedGroupIds,
    editingLinearElement: appState.editingLinearElement,
    selectedLinearElement: appState.selectedLinearElement,
  };
};

/**
 * Store which captures the observed changes and emits them as `StoreIncrementEvent` events.
 *
 * For the future:
 * - Store should coordinate the changes and maintain its increments cohesive between different instances.
 * - Store increments should be kept as append-only events log, with additional metadata, such as the logical timestamp for conflict-free resolution of increments.
 * - Store flow should be bi-directional, not only listening and capturing changes, but mainly receiving increments as commands and applying them to the state.
 *
 * @experimental this interface is experimental and subject to change.
 */
export interface IStore {
  /**
   * Get the store snapshot
   */
  getSnapshot(): Readonly<Snapshot>;

  /**
   * Use to schedule update of the snapshot, useful on updates for which we don't need to calculate increments (i.e. such as remote updates).
   */
  shouldUpdateSnapshot(): void;

  /**
   * Use to schedule calculation of a store increment on a next component update.
   */
  shouldCaptureIncrement(): void;

  /**
   * Capture changes to the @param elements and @param appState by calculating changes (based on a snapshot) and emitting resulting changes as a store increment.
   *
   * @emits StoreIncrementEvent
   */
  capture(elements: Map<string, ExcalidrawElement>, appState: AppState): void;

  /**
   * Listens to the store increments, emitted by the capture method.
   * Suitable for consuming store increments by various system components, such as History, Collab, Storage and etc.
   *
   * @listens StoreIncrementEvent
   */
  listen(
    callback: (
      elementsChange: ElementsChange,
      appStateChange: AppStateChange,
    ) => void,
  ): ReturnType<Emitter<StoreIncrementEvent>["on"]>;

  /**
   * Clears the store instance.
   */
  clear(): void;

  /**
   * Clears the store instance and destroys the emitter.
   */
  destroy(): void;

  /**
   * Filters out yet uncomitted local elements, which are part of in progress async actions, based on what we have in snapshot.
   *
   * This is necessary on updates in which we receive reconcilled-like elements, already containing elements
   * which were not yet captured by the store. Once we will be exchanging just store increments this will be deprecated.
   */
  ignoreUncomittedElements(
    prevElements: Map<string, ExcalidrawElement>,
    nextElements: Map<string, ExcalidrawElement>,
  ): Map<string, ExcalidrawElement>;
}

/**
 * Represent an increment to the Store.
 */
type StoreIncrementEvent = [
  elementsChange: ElementsChange,
  appStateChange: AppStateChange,
];

export class Store implements IStore {
  private readonly onStoreIncrementEmitter = new Emitter<StoreIncrementEvent>();

  private calculatingIncrement: boolean = false;
  private updatingSnapshot: boolean = false;

  private snapshot = Snapshot.empty();

  public getSnapshot = () => {
    return this.snapshot;
  };

  public shouldUpdateSnapshot = () => {
    this.updatingSnapshot = true;
  };

  // Suspicious that this is called so many places. Seems error-prone.
  public shouldCaptureIncrement = () => {
    this.calculatingIncrement = true;
  };

  public capture = (
    elements: Map<string, ExcalidrawElement>,
    appState: AppState,
  ): void => {
    // Quick exit for irrelevant changes
    if (!this.calculatingIncrement && !this.updatingSnapshot) {
      return;
    }

    try {
      const nextSnapshot = this.snapshot.clone(elements, appState);

      // Optimisation, don't continue if nothing has changed
      if (this.snapshot !== nextSnapshot) {
        // Calculate and record the changes based on the previous and next snapshot
        if (this.calculatingIncrement) {
          const elementsChange = nextSnapshot.meta.didElementsChange
            ? ElementsChange.calculate(
                this.snapshot.elements,
                nextSnapshot.elements,
              )
            : ElementsChange.empty();

          const appStateChange = nextSnapshot.meta.didAppStateChange
            ? AppStateChange.calculate(
                this.snapshot.appState,
                nextSnapshot.appState,
              )
            : AppStateChange.empty();

          if (!elementsChange.isEmpty() || !appStateChange.isEmpty()) {
            // Notify listeners with the increment
            this.onStoreIncrementEmitter.trigger(
              elementsChange,
              appStateChange,
            );
          }
        }

        // Update the snapshot
        this.snapshot = nextSnapshot;
      }
    } finally {
      // Reset props
      this.updatingSnapshot = false;
      this.calculatingIncrement = false;
    }
  };

  public listen = (
    callback: (
      elementsChange: ElementsChange,
      appStateChange: AppStateChange,
    ) => void,
  ) => {
    return this.onStoreIncrementEmitter.on(callback);
  };

  public ignoreUncomittedElements = (
    prevElements: Map<string, ExcalidrawElement>,
    nextElements: Map<string, ExcalidrawElement>,
  ) => {
    for (const [id, prevElement] of prevElements.entries()) {
      const nextElement = nextElements.get(id);

      if (!nextElement) {
        // Nothing to care about here, elements were forcefully updated
        continue;
      }

      const elementSnapshot = this.snapshot.elements.get(id);

      // Uncomitted element's snapshot doesn't exist, or its snapshot has lower version than the local element
      if (
        !elementSnapshot ||
        (elementSnapshot && elementSnapshot.version < prevElement.version)
      ) {
        // Detected yet uncomitted local element ~ async user action is in progress
        if (elementSnapshot) {
          nextElements.set(id, elementSnapshot);
        } else {
          nextElements.delete(id);
        }
      }
    }

    return nextElements;
  };

  public clear = (): void => {
    this.snapshot = Snapshot.empty();
  };

  public destroy = (): void => {
    this.clear();
    this.onStoreIncrementEmitter.destroy();
  };
}

export class Snapshot {
  private constructor(
    public readonly elements: Map<string, ExcalidrawElement>,
    public readonly appState: ObservedAppState,
    public readonly meta: {
      didElementsChange: boolean;
      didAppStateChange: boolean;
      isEmpty?: boolean;
    } = {
      didElementsChange: false,
      didAppStateChange: false,
      isEmpty: false,
    },
  ) {}

  public static empty() {
    return new Snapshot(
      new Map(),
      getObservedAppState(getDefaultAppState() as AppState),
      { didElementsChange: false, didAppStateChange: false, isEmpty: true },
    );
  }

  public isEmpty() {
    return this.meta.isEmpty;
  }

  /**
   * Efficiently clone the existing snapshot.
   *
   * @returns same instance if there are no changes detected, new instance otherwise.
   */
  public clone(elements: Map<string, ExcalidrawElement>, appState: AppState) {
    const didElementsChange = this.detectChangedElements(elements);

    // Not watching over everything from app state, just the relevant props
    const nextAppStateSnapshot = getObservedAppState(appState);
    const didAppStateChange = this.detectChangedAppState(nextAppStateSnapshot);

    // Nothing has changed, so there is no point of continuing further
    if (!didElementsChange && !didAppStateChange) {
      return this;
    }

    // Clone only if there was really a change
    let nextElementsSnapshot = this.elements;
    if (didElementsChange) {
      nextElementsSnapshot = this.createElementsSnapshot(elements);
    }

    const snapshot = new Snapshot(nextElementsSnapshot, nextAppStateSnapshot, {
      didElementsChange,
      didAppStateChange,
    });

    return snapshot;
  }

  /**
   * Detect if there any changed elements.
   *
   * NOTE: we shouldn't use `sceneVersionNonce` instead, as we need to call this before the scene updates.
   */
  private detectChangedElements(nextElements: Map<string, ExcalidrawElement>) {
    if (this.elements === nextElements) {
      return false;
    }

    if (this.elements.size !== nextElements.size) {
      return true;
    }

    // loop from right to left as changes are likelier to happen on new elements
    const keys = Array.from(nextElements.keys());

    for (let i = keys.length - 1; i >= 0; i--) {
      const prev = this.elements.get(keys[i]);
      const next = nextElements.get(keys[i]);
      if (
        !prev ||
        !next ||
        prev.id !== next.id ||
        prev.versionNonce !== next.versionNonce
      ) {
        return true;
      }
    }

    return false;
  }

  private detectChangedAppState(observedAppState: ObservedAppState) {
    return !isShallowEqual(this.appState, observedAppState, {
      selectedElementIds: isShallowEqual,
      selectedGroupIds: isShallowEqual,
    });
  }

  /**
   * Perform structural clone, cloning only elements that changed.
   */
  private createElementsSnapshot(nextElements: Map<string, ExcalidrawElement>) {
    const clonedElements = new Map();

    for (const [id, prevElement] of this.elements.entries()) {
      // clone previous elements, never delete, in case nextElements would be just a subset of previous elements
      // i.e. during collab, persist or whenenever isDeleted elements get cleared
      if (!nextElements.get(id)) {
        // when we cannot find the prev element in the next elements, we mark it as deleted
        clonedElements.set(
          id,
          newElementWith(prevElement, { isDeleted: true }),
        );
      } else {
        clonedElements.set(id, prevElement);
      }
    }

    for (const [id, nextElement] of nextElements.entries()) {
      const prevElement = clonedElements.get(id);

      // At this point our elements are reconcilled already, meaning the next element is always newer
      if (
        !prevElement || // element was added
        (prevElement && prevElement.versionNonce !== nextElement.versionNonce) // element was updated
      ) {
        clonedElements.set(id, deepCopyElement(nextElement));
      }
    }

    return clonedElements;
  }
}

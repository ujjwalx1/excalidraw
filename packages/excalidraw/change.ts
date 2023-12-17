import { ENV } from "./constants";
import { fixBindingsAfterDeletion } from "./element/binding";
import { ElementUpdate, newElementWith } from "./element/mutateElement";
import {
  getBoundTextElementId,
  redrawTextBoundingBox,
} from "./element/textElement";
import { hasBoundTextElement, isBoundToContainer } from "./element/typeChecks";
import {
  BoundElement,
  ExcalidrawElement,
  ExcalidrawTextElement,
} from "./element/types";
import {
  AppState,
  ObservedAppState,
  ObservedElementsAppState,
  ObservedStandaloneAppState,
} from "./types";
import { Mutable, SubtypeOf } from "./utility-types";
import { arrayToObject, assertNever, isShallowEqual } from "./utils";

/**
 * Represents the difference between two `T` objects.
 *
 * Keeping it as pure object (without transient state, side-effects, etc.), so we don't have to instantiate it on load.
 */
class Delta<T> {
  // TODO_UNDO: is it really from / to, now it's more like removed / added (but not exactly)
  private constructor(
    public readonly from: Partial<T>,
    public readonly to: Partial<T>,
  ) {}

  public static create<T>(
    from: Partial<T>,
    to: Partial<T>,
    modifier?: (delta: Partial<T>) => Partial<T>,
    modifierOptions?: "from" | "to",
  ) {
    const modifiedFrom =
      modifier && modifierOptions !== "to" ? modifier(from) : from;
    const modifiedTo =
      modifier && modifierOptions !== "from" ? modifier(to) : to;

    return new Delta(modifiedFrom, modifiedTo);
  }

  /**
   * Calculates the delta between two objects.
   *
   * @param prevObject - The previous state of the object.
   * @param nextObject - The next state of the object.
   *
   * @returns new Delta instance.
   */
  public static calculate<T extends { [key: string]: any }>(
    prevObject: T,
    nextObject: T,
    modifier?: (partial: Partial<T>) => Partial<T>,
    postProcess?: (
      from: Partial<T>,
      to: Partial<T>,
    ) => [Partial<T>, Partial<T>],
  ): Delta<T> {
    if (prevObject === nextObject) {
      return Delta.empty();
    }

    const from = {} as Partial<T>;
    const to = {} as Partial<T>;

    // O(n^3) here, but it's not as bad as it looks:
    // - we do this only on history recordings, not on every frame
    // - we do this only on changed elements
    // - we do shallow compare only on first level
    // - # of element's properties is reasonably small
    // - for expensive ops we could emit deltas on user actions directly
    for (const key of this.distinctKeysIterator(
      "full",
      prevObject,
      nextObject,
    )) {
      from[key as keyof T] = prevObject[key];
      to[key as keyof T] = nextObject[key];
    }

    const [processedFrom, processedTo] = postProcess
      ? postProcess(from, to)
      : [from, to];

    return Delta.create(processedFrom, processedTo, modifier);
  }

  public static empty() {
    return new Delta({}, {});
  }

  public static isEmpty<T>(delta: Delta<T>): boolean {
    return !Object.keys(delta.from).length && !Object.keys(delta.to).length;
  }

  /**
   * Merges partials for nested objects.
   */
  public static merge<T extends { [key: string]: unknown }>(
    prev: T,
    added: T,
    removed: T,
  ) {
    const cloned = { ...prev };

    for (const key of Object.keys(removed)) {
      delete cloned[key];
    }

    return { ...cloned, ...added };
  }

  /**
   * Compares if object1 contains any different value compared to the object2.
   */
  public static isLeftDifferent<T extends {}>(object1: T, object2: T): boolean {
    const anyDistinctKey = this.distinctKeysIterator(
      "left",
      object1,
      object2,
    ).next().value;

    return !!anyDistinctKey;
  }

  /**
   * Compares if object2 contains any different value compared to the object1.
   */
  public static isRightDifferent<T extends {}>(
    object1: T,
    object2: T,
  ): boolean {
    const anyDistinctKey = this.distinctKeysIterator(
      "right",
      object1,
      object2,
    ).next().value;

    return !!anyDistinctKey;
  }

  /**
   * Returns all the object1 keys that have distinct values.
   */
  public static getLeftDifferences<T extends {}>(object1: T, object2: T) {
    const distinctKeys = new Set<string>();

    for (const key of this.distinctKeysIterator("left", object1, object2)) {
      distinctKeys.add(key);
    }

    return Array.from(distinctKeys);
  }

  /**
   * Returns all the object2 keys that have distinct values.
   */
  public static getRightDifferences<T extends {}>(object1: T, object2: T) {
    const distinctKeys = new Set<string>();

    for (const key of this.distinctKeysIterator("right", object1, object2)) {
      distinctKeys.add(key);
    }

    return Array.from(distinctKeys);
  }

  /**
   * Iterator comparing values of object properties based on the passed joining strategy.
   *
   * @yields keys of properties with different values
   *
   * WARN: it's based on shallow compare performed only on the first level and doesn't go deeper than that.
   */
  private static *distinctKeysIterator<T extends {}>(
    join: "left" | "right" | "full",
    object1: T,
    object2: T,
  ) {
    let keys: string[] = [];

    if (join === "left") {
      keys = Object.keys(object1);
    } else if (join === "right") {
      keys = Object.keys(object2);
    } else {
      keys = Array.from(
        new Set([...Object.keys(object1), ...Object.keys(object2)]),
      );
    }

    for (const key of keys) {
      const object1Value = object1[key as keyof T];
      const object2Value = object2[key as keyof T];

      if (object1Value !== object2Value) {
        if (
          typeof object1Value === "object" &&
          typeof object2Value === "object" &&
          object1Value !== null &&
          object2Value !== null &&
          isShallowEqual(object1Value, object2Value)
        ) {
          continue;
        }

        yield key;
      }
    }
  }
}

/**
 * Encapsulates the modifications captured as `Delta`/s.
 */
interface Change<T> {
  /**
   * Inverses the `Delta`s inside while creating a new `Change`.
   */
  inverse(): Change<T>;

  /**
   * Applies the `Change` to the previous object.
   */
  applyTo(previous: Readonly<T>, ...options: unknown[]): [T, boolean];

  /**
   * Checks whether there are actually `Delta`s.
   */
  isEmpty(): boolean;
}

export class AppStateChange implements Change<AppState> {
  private constructor(private readonly delta: Delta<ObservedAppState>) {}

  public static calculate<T extends ObservedAppState>(
    prevAppState: T,
    nextAppState: T,
  ): AppStateChange {
    const delta = Delta.calculate(
      prevAppState,
      nextAppState,
      undefined,
      AppStateChange.postProcess,
    );

    return new AppStateChange(delta);
  }

  public static empty() {
    return new AppStateChange(Delta.create({}, {}));
  }

  public inverse(): AppStateChange {
    const inversedDelta = Delta.create(this.delta.to, this.delta.from);
    return new AppStateChange(inversedDelta);
  }

  // TODO_UNDO: we might need to filter out appState related to deleted elements
  public applyTo(
    appState: Readonly<AppState>,
    elements: Readonly<Map<string, ExcalidrawElement>>,
  ): [AppState, boolean] {
    const {
      selectedElementIds: removedSelectedElementIds = {},
      selectedGroupIds: removedSelectedGroupIds = {},
    } = this.delta.from;

    const {
      selectedElementIds: addedSelectedElementIds = {},
      selectedGroupIds: addedSelectedGroupIds = {},
      ...directlyApplicablePartial
    } = this.delta.to;

    const mergedSelectedElementIds = Delta.merge(
      appState.selectedElementIds,
      addedSelectedElementIds,
      removedSelectedElementIds,
    );

    const mergedSelectedGroupIds = Delta.merge(
      appState.selectedGroupIds,
      addedSelectedGroupIds,
      removedSelectedGroupIds,
    );

    const nextAppState = {
      ...appState,
      ...directlyApplicablePartial,
      selectedElementIds: mergedSelectedElementIds,
      selectedGroupIds: mergedSelectedGroupIds,
    };

    const constainsVisibleChanges = this.checkForVisibleChanges(
      appState,
      nextAppState,
      elements,
    );

    return [nextAppState, constainsVisibleChanges];
  }

  public isEmpty(): boolean {
    return Delta.isEmpty(this.delta);
  }

  /**
   * It is necessary to post process the partials in case of reference values,
   * for which we need to calculate the real diff between `from` and `to`.
   */
  private static postProcess<T extends ObservedAppState>(
    from: Partial<T>,
    to: Partial<T>,
  ): [Partial<T>, Partial<T>] {
    if (from.selectedElementIds && to.selectedElementIds) {
      const fromDifferences = Delta.getLeftDifferences(
        from.selectedElementIds,
        to.selectedElementIds,
      ).reduce((acc, id) => {
        acc[id] = true;
        return acc;
      }, {} as Mutable<ObservedAppState["selectedElementIds"]>);

      const toDifferences = Delta.getRightDifferences(
        from.selectedElementIds,
        to.selectedElementIds,
      ).reduce((acc, id) => {
        acc[id] = true;
        return acc;
      }, {} as Mutable<ObservedAppState["selectedElementIds"]>);

      (from as Mutable<Partial<T>>).selectedElementIds = fromDifferences;
      (to as Mutable<Partial<T>>).selectedElementIds = toDifferences;
    }

    if (from.selectedGroupIds && to.selectedGroupIds) {
      const fromDifferences = Delta.getLeftDifferences(
        from.selectedGroupIds,
        to.selectedGroupIds,
      ).reduce((acc, groupId) => {
        acc[groupId] = from.selectedGroupIds![groupId];
        return acc;
      }, {} as Mutable<ObservedAppState["selectedGroupIds"]>);

      const toDifferences = Delta.getRightDifferences(
        from.selectedGroupIds,
        to.selectedGroupIds,
      ).reduce((acc, groupId) => {
        acc[groupId] = to.selectedGroupIds![groupId];
        return acc;
      }, {} as Mutable<ObservedAppState["selectedGroupIds"]>);

      (from as Mutable<Partial<T>>).selectedGroupIds = fromDifferences;
      (to as Mutable<Partial<T>>).selectedGroupIds = toDifferences;
    }

    return [from, to];
  }

  private checkForVisibleChanges(
    prevAppState: AppState,
    nextAppState: ObservedAppState,
    nextElements: Map<string, ExcalidrawElement>,
  ): boolean {
    const containsStandaloneDifference = Delta.isRightDifferent(
      prevAppState,
      AppStateChange.stripElementsProps(nextAppState),
    );

    if (containsStandaloneDifference) {
      // We detected a a difference which is unrelated to the elements
      return true;
    }

    const containsElementsDifference = Delta.isRightDifferent(
      prevAppState,
      AppStateChange.stripStandaloneProps(nextAppState),
    );

    if (!containsStandaloneDifference && !containsElementsDifference) {
      // There is no difference detected at all
      return false;
    }

    // We need to handle elements differences separately,
    // as they could be related to deleted elements and/or they could on their own result in no visible action
    const changedDeltaKeys = Delta.getRightDifferences(
      prevAppState,
      AppStateChange.stripStandaloneProps(nextAppState),
    ) as Array<keyof ObservedElementsAppState>;

    // Check whether delta properties are related to the existing non-deleted elements
    for (const key of changedDeltaKeys) {
      switch (key) {
        case "selectedElementIds":
          if (
            AppStateChange.checkForSelectedElementsDifferences(
              nextAppState,
              nextElements,
            )
          ) {
            return true;
          }
          break;
        case "selectedLinearElement":
        case "editingLinearElement":
          if (
            AppStateChange.checkForLinearElementDifferences(
              nextAppState[key],
              nextElements,
            )
          ) {
            return true;
          }
          break;
        case "editingGroupId":
        case "selectedGroupIds":
          return AppStateChange.checkForGroupsDifferences();
        default: {
          assertNever(
            key,
            `Unknown ObservedElementsAppState key "${key}"`,
            true,
          );
        }
      }
    }

    return false;
  }

  private static checkForSelectedElementsDifferences(
    appState: Pick<ObservedElementsAppState, "selectedElementIds">,
    elements: Map<string, ExcalidrawElement>,
  ) {
    // TODO_UNDO: it could have been visible before (and now it's not)
    for (const id of Object.keys(appState.selectedElementIds)) {
      const element = elements.get(id);

      if (element && !element.isDeleted) {
        // // TODO_UNDO: breaks multi selection
        // if (appState.selectedElementIds[id]) {
        //   // Element is already selected
        //   return;
        // }

        // Found related visible element!
        return true;
      }
    }
  }

  private static checkForLinearElementDifferences(
    linearElement:
      | ObservedElementsAppState["editingLinearElement"]
      | ObservedAppState["selectedLinearElement"]
      | undefined,
    elements: Map<string, ExcalidrawElement>,
  ) {
    if (!linearElement) {
      return;
    }

    const element = elements.get(linearElement.elementId);

    if (element && !element.isDeleted) {
      // Found related visible element!
      return true;
    }
  }

  // Currently we don't have an index of elements by groupIds, which means
  // the calculation for getting the visible elements based on the groupIds stored in delta
  // is not worth performing - due to perf. and dev. complexity.
  //
  // Therefore we are accepting in these cases empty undos / redos, which should be pretty rare:
  // - only when one of these (or both) are in delta and the are no non deleted elements containing these group ids
  private static checkForGroupsDifferences() {
    return true;
  }

  private static stripElementsProps(
    delta: Partial<ObservedAppState>,
  ): Partial<ObservedStandaloneAppState> {
    // WARN: Do not remove the type-casts as they here to ensure proper type checks
    const {
      editingGroupId,
      selectedGroupIds,
      selectedElementIds,
      editingLinearElement,
      selectedLinearElement,
      ...standaloneProps
    } = delta as ObservedAppState;

    return standaloneProps as SubtypeOf<
      typeof standaloneProps,
      ObservedStandaloneAppState
    >;
  }

  private static stripStandaloneProps(
    delta: Partial<ObservedAppState>,
  ): Partial<ObservedElementsAppState> {
    // WARN: Do not remove the type-casts as they here to ensure proper type checks
    const { name, viewBackgroundColor, ...elementsProps } =
      delta as ObservedAppState;

    return elementsProps as SubtypeOf<
      typeof elementsProps,
      ObservedElementsAppState
    >;
  }
}

/**
 * Elements change is a low level primitive to capture a change between two sets of elements.
 * It does so by encapsulating forward and backward `Delta`s, which allow to travel in both directions.
 *
 * We could be smarter about the change in the future, ideas for improvements are:
 * - for memory, share the same delta instances between different deltas (flyweight-like)
 * - for serialization, compress the deltas into a tree-like structures with custom pointers or let one delta instance contain multiple element ids
 * - for performance, emit the changes directly by the user actions, then apply them in from store into the state (no diffing!)
 * - for performance, add operations in addition to deltas, which increment (decrement) properties by given value (could be used i.e. for presence-like move)
 */
export class ElementsChange implements Change<Map<string, ExcalidrawElement>> {
  // TODO_UNDO: omit certain props as in ElementUpdates (everywhere)
  private constructor(
    private readonly added: Map<string, Delta<ExcalidrawElement>>,
    private readonly removed: Map<string, Delta<ExcalidrawElement>>,
    private readonly updated: Map<string, Delta<ExcalidrawElement>>,
  ) {}

  public static create(
    added: Map<string, Delta<ExcalidrawElement>>,
    removed: Map<string, Delta<ExcalidrawElement>>,
    updated: Map<string, Delta<ExcalidrawElement>>,
  ) {
    if (import.meta.env.DEV || import.meta.env.MODE === ENV.TEST) {
      ElementsChange.validateInvariants(
        "added",
        added,
        // Element could be added as deleted, ignoring "to"
        (from, _) => from.isDeleted === true,
      );
      ElementsChange.validateInvariants(
        "removed",
        removed,
        (from, to) => from.isDeleted === false && to.isDeleted === true,
      );
      ElementsChange.validateInvariants(
        "updated",
        updated,
        (from, to) => !from.isDeleted && !to.isDeleted,
      );
    }

    return new ElementsChange(added, removed, updated);
  }

  private static validateInvariants(
    type: "added" | "removed" | "updated",
    deltas: Map<string, Delta<ExcalidrawElement>>,
    satifiesInvariants: (
      from: Partial<ExcalidrawElement>,
      to: Partial<ExcalidrawElement>,
    ) => boolean,
  ) {
    for (const [id, delta] of deltas.entries()) {
      if (!satifiesInvariants(delta.from, delta.to)) {
        console.error(
          `Broken invariant for "${type}" delta, element "${id}", delta:`,
          delta,
        );
        throw new Error(`ElementsChange invariant broken for element "${id}".`);
      }
    }
  }

  /**
   * Calculates the `Delta`s between the previous and next set of elements.
   *
   * @param prevElements - Map representing the previous state of elements.
   * @param nextElements - Map representing the next state of elements.
   *
   * @returns `ElementsChange` instance representing the `Delta` changes between the two sets of elements.
   */
  public static calculate<T extends ExcalidrawElement>(
    prevElements: Map<string, T>,
    nextElements: Map<string, T>,
  ): ElementsChange {
    if (prevElements === nextElements) {
      return ElementsChange.empty();
    }

    const added = new Map<string, Delta<T>>();
    const removed = new Map<string, Delta<T>>();
    const updated = new Map<string, Delta<T>>();

    // This might be needed only in same edge cases, like during collab, when `isDeleted` elements get removed
    for (const prevElement of prevElements.values()) {
      const nextElement = nextElements.get(prevElement.id);

      if (!nextElement) {
        const from = { ...prevElement, isDeleted: false } as T;
        const to = { isDeleted: true } as T;

        const delta = Delta.create(
          from,
          to,
          ElementsChange.stripIrrelevantProps,
        );

        removed.set(prevElement.id, delta as Delta<T>);
      }
    }

    for (const nextElement of nextElements.values()) {
      const prevElement = prevElements.get(nextElement.id);

      if (!prevElement) {
        const from = { isDeleted: true } as T;
        const to = {
          ...nextElement,
          // Special case when an element is added as deleted (i.e. through the API).
          isDeleted: nextElement.isDeleted || false,
        } as T;

        const delta = Delta.create(
          from,
          to,
          ElementsChange.stripIrrelevantProps,
        );

        added.set(nextElement.id, delta as Delta<T>);

        continue;
      }

      if (prevElement.versionNonce !== nextElement.versionNonce) {
        if (
          // Making sure we don't get here some non-boolean values (i.e. undefined, null, etc.)
          typeof prevElement.isDeleted === "boolean" &&
          typeof nextElement.isDeleted === "boolean" &&
          prevElement.isDeleted !== nextElement.isDeleted
        ) {
          const from = { ...prevElement };
          const to = { ...nextElement };
          const delta = Delta.calculate<ExcalidrawElement>(
            from,
            to,
            ElementsChange.stripIrrelevantProps,
            ElementsChange.postProcess,
          );

          // Notice that other props could have been updated as well
          if (prevElement.isDeleted && !nextElement.isDeleted) {
            added.set(nextElement.id, delta as Delta<T>);
          } else {
            removed.set(nextElement.id, delta as Delta<T>);
          }
        } else {
          const delta = Delta.calculate<ExcalidrawElement>(
            prevElement,
            nextElement,
            ElementsChange.stripIrrelevantProps,
            ElementsChange.postProcess,
          );

          // Make sure there are at least some changes (except changes to irrelevant data)
          if (!Delta.isEmpty(delta)) {
            updated.set(nextElement.id, delta as Delta<T>);
          }
        }
      }
    }

    return ElementsChange.create(added, removed, updated);
  }

  public static empty() {
    return ElementsChange.create(new Map(), new Map(), new Map());
  }

  public inverse(): ElementsChange {
    const inverseInternal = (deltas: Map<string, Delta<ExcalidrawElement>>) => {
      const inversedDeltas = new Map<string, Delta<ExcalidrawElement>>();

      for (const [id, delta] of deltas.entries()) {
        inversedDeltas.set(id, Delta.create(delta.to, delta.from));
      }

      return inversedDeltas;
    };

    const added = inverseInternal(this.added);
    const removed = inverseInternal(this.removed);
    const updated = inverseInternal(this.updated);

    // Notice we inverse removed with added not to break the invariants
    return ElementsChange.create(removed, added, updated);
  }

  public isEmpty(): boolean {
    return (
      this.added.size === 0 &&
      this.removed.size === 0 &&
      this.updated.size === 0
    );
  }

  /**
   * Update the delta/s based on the existing elements.
   *
   * @param elements current elements
   * @param modifierOptions defines which of the delta (`from` or `to`) will be updated
   * @returns new instance with modified delta/s
   */
  public applyLatestChanges(
    elements: Map<string, ExcalidrawElement>,
    modifierOptions: "from" | "to",
  ): ElementsChange {
    const modifier =
      (element: ExcalidrawElement) => (partial: Partial<ExcalidrawElement>) => {
        const updatedPartial = { ...partial };

        for (const key of Object.keys(updatedPartial) as Array<
          keyof typeof partial
        >) {
          // TODO_UNDO: `isDeleted` shouldn't be modified, otherwise invariants will fail, this also means one can always redo his own creation - add test cases
          // TODO_UNDO: figure out whether updating reference deltas (i.e. boundElemenmakes) any sense (maybe just on deletion, but not worth doing now) - add test case
          if (
            key === "isDeleted" ||
            key === "boundElements" ||
            key === "groupIds" ||
            key === "customData"
          ) {
            continue;
          }

          // TODO: fix typing
          (updatedPartial as any)[key] = element[key];
        }

        return updatedPartial;
      };

    const applyLatestChangesInternal = (
      deltas: Map<string, Delta<ExcalidrawElement>>,
    ) => {
      const modifiedDeltas = new Map<string, Delta<ExcalidrawElement>>();

      for (const [id, delta] of deltas.entries()) {
        const existingElement = elements.get(id);

        if (existingElement) {
          const modifiedDelta = Delta.create(
            delta.from,
            delta.to,
            modifier(existingElement),
            modifierOptions,
          );

          modifiedDeltas.set(id, modifiedDelta);
        } else {
          // Keep whatever we had
          modifiedDeltas.set(id, delta);
        }
      }

      return modifiedDeltas;
    };

    const added = applyLatestChangesInternal(this.added);
    const removed = applyLatestChangesInternal(this.removed);
    const updated = applyLatestChangesInternal(this.updated);

    return ElementsChange.create(added, removed, updated);
  }

  // For future reference, we might want to "rebase" the change itself instead, so it could be shared to other clients
  public applyTo(
    elements: Readonly<Map<string, ExcalidrawElement>>,
  ): [Map<string, ExcalidrawElement>, boolean] {
    let containsVisibleDifference = false;

    // TODO_UNDO: would rather check for no visible differences so that we don't accidently iterate in the history stack
    const checkForVisibleDifference = (
      prevElement: ExcalidrawElement | void,
      nextElement: ExcalidrawElement,
    ) => {
      if (!containsVisibleDifference) {
        if (!prevElement) {
          if (nextElement.isDeleted === false) {
            // When we have an addition of an element in history, but it was removed completely from the scene and now we will restore it
            containsVisibleDifference = true;
          }
        } else if (prevElement.isDeleted && nextElement.isDeleted === false) {
          // When delta adds an element, it results in a visible change
          containsVisibleDifference = true;
        } else if (!prevElement.isDeleted) {
          if (nextElement.isDeleted) {
            // When delta removes visible element, it results in a visible change
            containsVisibleDifference = true;
          } else {
            // Check for any difference on a visible element
            // Notice we go through all deltas regardless,
            // as visible changes could also be inside added changes (not just updated)
            containsVisibleDifference = Delta.isRightDifferent(
              nextElement,
              prevElement,
            );
          }
        }
      }
    };

    const addedElements = new Map();
    const removedElements = new Map();
    const updatedElements = new Map();

    for (const [id, delta] of this.removed.entries()) {
      const existingElement = elements.get(id);

      if (existingElement) {
        const removedElement = ElementsChange.applyDelta(
          existingElement,
          delta,
          elements,
        );
        elements.set(id, removedElement);
        removedElements.set(id, removedElement);
        checkForVisibleDifference(existingElement, removedElement);
        this.removeBoundText(removedElement, elements);
      }
    }

    for (const [id, delta] of this.added.entries()) {
      const existingElement = elements.get(id);

      let addedElement = null;
      if (existingElement) {
        addedElement = ElementsChange.applyDelta(
          existingElement,
          delta,
          elements,
        );
      } else {
        addedElement = ElementsChange.applyDelta(
          { id } as ExcalidrawElement,
          delta,
          elements,
        );
      }

      if (addedElement) {
        elements.set(id, addedElement);
        addedElements.set(id, addedElement);
        checkForVisibleDifference(existingElement, addedElement);
        // If we would be persisting history, restoring might be problematic if we would not be persiting deleted elements
        this.restoreBoundText(addedElement, elements);
        this.restoreContainer(addedElement, elements);
      }
    }

    for (const [id, delta] of this.updated.entries()) {
      const existingElement = elements.get(id);

      if (existingElement) {
        const updatedElement = ElementsChange.applyDelta(
          existingElement,
          delta,
          elements,
        );
        elements.set(id, updatedElement);
        updatedElements.set(id, updatedElement);
        checkForVisibleDifference(existingElement, updatedElement);
      }
    }

    // Playing it safe for now, but below mutators would deserve to be rewritten
    fixBindingsAfterDeletion(
      Array.from(elements.values()),
      Array.from(removedElements.values()),
      false,
    );

    ElementsChange.redrawTextBoundingBoxes(
      elements,
      new Map([...addedElements, ...updatedElements]),
    );

    return [elements, containsVisibleDifference];
  }

  private static applyDelta(
    element: ExcalidrawElement,
    delta: Delta<ExcalidrawElement>,
    elements: Map<string, ExcalidrawElement>,
  ) {
    const { boundElements: removedBoundElements, groupIds: removedGroupIds } =
      delta.from;

    const {
      boundElements: addedBoundElements,
      groupIds: addedGroupIds,
      ...directlyApplicablePartial
    } = delta.to;

    const { boundElements, groupIds } = element;

    let nextBoundElements = boundElements;
    if (addedBoundElements?.length || removedBoundElements?.length) {
      const modifiedBoundElements = this.removedBoundTextElements(
        boundElements ?? [],
        addedBoundElements ?? [],
        elements,
      );

      const mergedBoundElements = Object.values(
        Delta.merge(
          arrayToObject(modifiedBoundElements, (x) => x.id),
          arrayToObject(addedBoundElements ?? [], (x) => x.id),
          arrayToObject(removedBoundElements ?? [], (x) => x.id),
        ),
      );

      nextBoundElements = mergedBoundElements.length
        ? mergedBoundElements
        : null;
    }

    let nextGroupIds = groupIds;
    if (addedGroupIds?.length || removedGroupIds?.length) {
      const mergedGroupIds = Object.values(
        Delta.merge(
          arrayToObject(groupIds ?? []),
          arrayToObject(addedGroupIds ?? []),
          arrayToObject(removedGroupIds ?? []),
        ),
      );
      nextGroupIds = mergedGroupIds;
    }

    const updates: ElementUpdate<ExcalidrawElement> = {
      ...directlyApplicablePartial,
      boundElements: nextBoundElements,
      groupIds: nextGroupIds,
    };

    return newElementWith(element, updates, true);
  }

  /**
   * If we are adding text, make sure to unbind existing text first, so we don't end up with duplicates.
   */
  private static removedBoundTextElements(
    boundElements: readonly BoundElement[],
    addedBoundElements: readonly BoundElement[],
    elements: Map<string, ExcalidrawElement>,
  ): readonly BoundElement[] {
    if (!addedBoundElements.find((x) => x.type === "text")) {
      return boundElements;
    }

    const boundTextElements = boundElements.filter((x) => x.type === "text");

    for (const { id } of boundTextElements) {
      const element = elements.get(id);

      if (element) {
        const removed = newElementWith(
          element as ExcalidrawTextElement,
          {
            isDeleted: true,
            containerId: undefined,
          },
          true,
        );
        elements.set(element.id, removed);
      }
    }

    return boundElements.filter((x) => x.type !== "text");
  }

  /**
   * When text bindable container is removed through history, we need to:
   * - remove bound text (don't remove bindings, so we could restore it again)
   */
  private removeBoundText(
    container: ExcalidrawElement,
    elements: Map<string, ExcalidrawElement>,
  ) {
    if (!hasBoundTextElement(container)) {
      return;
    }

    const boundTextElementId = getBoundTextElementId(container) || "";
    const textElement = elements.get(boundTextElementId);

    if (textElement && !textElement.isDeleted) {
      const removed = newElementWith(
        textElement as ExcalidrawTextElement,
        {
          isDeleted: true,
          containerId: undefined,
        },
        true,
      );
      elements.set(textElement.id, removed);
    }
  }

  /**
   * When text bindable container is added through history (restored), we need to:
   * - restore bound text if it was deleted with history action (we don't remove bindings on removal)
   */
  private restoreBoundText(
    container: ExcalidrawElement,
    elements: Map<string, ExcalidrawElement>,
  ) {
    if (!hasBoundTextElement(container)) {
      return;
    }

    const boundTextElementId = getBoundTextElementId(container) || "";
    const boundText = elements.get(boundTextElementId);

    if (boundText && boundText.isDeleted) {
      const restored = newElementWith(boundText, { isDeleted: false });
      elements.set(boundText.id, restored);
    }
  }

  /**
   * When bounded text is added through a history (restored), we need to:
   * - unbind the text if container cannot be found
   * - restore container if was deleted
   * - repair container bindings if there are already some bound text elements
   * - update props of the bound text and container
   *
   * Looks like similar to what we are doing inside restore.ts (i.e. repairBoundElement)
   */
  private restoreContainer(
    boundText: ExcalidrawElement,
    elements: Map<string, ExcalidrawElement>,
  ) {
    if (isBoundToContainer(boundText)) {
      const container = elements.get(boundText.containerId);

      if (container) {
        if (container?.isDeleted) {
          // Restore the container
          const restored = newElementWith(container, { isDeleted: false });
          elements.set(container.id, restored);
        }
      } else {
        // Delete the binding to the container if it's not found
        const unbound = newElementWith(
          boundText,
          {
            containerId: undefined,
          },
          true,
        );
        elements.set(boundText.id, unbound);
      }
    }
  }

  private static redrawTextBoundingBoxes(
    elements: Map<string, ExcalidrawElement>,
    changed: Map<string, ExcalidrawElement>,
  ) {
    const containerTextMapping = new Map();

    for (const element of changed.values()) {
      if (element.isDeleted) {
        continue;
      }

      if (hasBoundTextElement(element)) {
        const boundTextElementId = getBoundTextElementId(element) || "";
        const boundText = elements.get(boundTextElementId);

        if (boundText) {
          containerTextMapping.set(element.id, {
            container: element,
            boundText,
          });
        }
      } else if (isBoundToContainer(element)) {
        const container = elements.get(element.containerId);

        if (container) {
          containerTextMapping.set(element.id, {
            container,
            boundText: element,
          });
        }
      }
    }

    for (const { container, boundText } of containerTextMapping.values()) {
      redrawTextBoundingBox(boundText, container, false);
    }
  }

  private static stripIrrelevantProps(partial: Partial<ExcalidrawElement>) {
    const { id, updated, version, versionNonce, ...strippedPartial } = partial;

    return strippedPartial;
  }

  /**
   * It is necessary to post process the partials in case of reference values,
   * for which we need to calculate the real diff between `from` and `to`.
   */
  private static postProcess<T extends ExcalidrawElement>(
    from: Partial<T>,
    to: Partial<T>,
  ): [Partial<T>, Partial<T>] {
    if (from.boundElements && to.boundElements) {
      const fromDifferences = arrayToObject(
        Delta.getLeftDifferences(
          arrayToObject(from.boundElements, (x) => x.id),
          arrayToObject(to.boundElements, (x) => x.id),
        ),
      );
      const toDifferences = arrayToObject(
        Delta.getRightDifferences(
          arrayToObject(from.boundElements, (x) => x.id),
          arrayToObject(to.boundElements, (x) => x.id),
        ),
      );

      const fromBoundElements = from.boundElements.filter(
        ({ id }) => !!fromDifferences[id],
      );
      const toBoundElements = to.boundElements.filter(
        ({ id }) => !!toDifferences[id],
      );

      (from as Mutable<Partial<T>>).boundElements = fromBoundElements;
      (to as Mutable<Partial<T>>).boundElements = toBoundElements;
    }

    if (from.groupIds && to.groupIds) {
      const fromDifferences = arrayToObject(
        Delta.getLeftDifferences(
          arrayToObject(from.groupIds),
          arrayToObject(to.groupIds),
        ),
      );
      const toDifferences = arrayToObject(
        Delta.getRightDifferences(
          arrayToObject(from.groupIds),
          arrayToObject(to.groupIds),
        ),
      );

      const fromGroupIds = from.groupIds.filter(
        (groupId) => !!fromDifferences[groupId],
      );
      const toGroupIds = to.groupIds.filter(
        (groupId) => !!toDifferences[groupId],
      );

      (from as Mutable<Partial<T>>).groupIds = fromGroupIds;
      (to as Mutable<Partial<T>>).groupIds = toGroupIds;
    }

    return [from, to];
  }
}

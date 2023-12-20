import { ENV } from "./constants";
import {
  ElementUpdate,
  mutateElement,
  newElementWith,
} from "./element/mutateElement";
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

  // TODO_UNDO: filter out appState related to deleted elements
  public applyTo(
    appState: Readonly<AppState>,
    elements: ReadonlyMap<string, ExcalidrawElement>,
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
    nextElements: ReadonlyMap<string, ExcalidrawElement>,
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
    elements: ReadonlyMap<string, ExcalidrawElement>,
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
    elements: ReadonlyMap<string, ExcalidrawElement>,
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

type ElementPartial = Omit<ElementUpdate<ExcalidrawElement>, "seed">;

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
  private constructor(
    private readonly added: Map<string, Delta<ElementPartial>>,
    private readonly removed: Map<string, Delta<ElementPartial>>,
    private readonly updated: Map<string, Delta<ElementPartial>>,
  ) {}

  public static create(
    added: Map<string, Delta<ElementPartial>>,
    removed: Map<string, Delta<ElementPartial>>,
    updated: Map<string, Delta<ElementPartial>>,
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
    deltas: Map<string, Delta<ElementPartial>>,
    satifiesInvariants: (from: ElementPartial, to: ElementPartial) => boolean,
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

    const added = new Map<string, Delta<ElementPartial>>();
    const removed = new Map<string, Delta<ElementPartial>>();
    const updated = new Map<string, Delta<ElementPartial>>();

    // This might be needed only in same edge cases, like during collab, when `isDeleted` elements get removed
    for (const prevElement of prevElements.values()) {
      const nextElement = nextElements.get(prevElement.id);

      if (!nextElement) {
        const from = { ...prevElement, isDeleted: false } as ElementPartial;
        const to = { isDeleted: true } as ElementPartial;

        const delta = Delta.create(
          from,
          to,
          ElementsChange.stripIrrelevantProps,
        );

        removed.set(prevElement.id, delta);
      }
    }

    for (const nextElement of nextElements.values()) {
      const prevElement = prevElements.get(nextElement.id);

      if (!prevElement) {
        const from = { isDeleted: true } as ElementPartial;
        const to = {
          ...nextElement,
          // Special case when an element is added as deleted (i.e. through the API). // isDeleted: nextElement.isDeleted
          isDeleted: false,
        } as ElementPartial;

        const delta = Delta.create(
          from,
          to,
          ElementsChange.stripIrrelevantProps,
        );

        added.set(nextElement.id, delta);

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
          const delta = Delta.calculate<ElementPartial>(
            from,
            to,
            ElementsChange.stripIrrelevantProps,
            ElementsChange.postProcess,
          );

          // Notice that other props could have been updated as well
          if (prevElement.isDeleted && !nextElement.isDeleted) {
            added.set(nextElement.id, delta);
          } else {
            removed.set(nextElement.id, delta);
          }
        } else {
          const delta = Delta.calculate<ElementPartial>(
            prevElement,
            nextElement,
            ElementsChange.stripIrrelevantProps,
            ElementsChange.postProcess,
          );

          // Make sure there are at least some changes (except changes to irrelevant data)
          if (!Delta.isEmpty(delta)) {
            updated.set(nextElement.id, delta);
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
    const inverseInternal = (deltas: Map<string, Delta<ElementPartial>>) => {
      const inversedDeltas = new Map<string, Delta<ElementPartial>>();

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
   * Update only `updated` delta/s based on the existing elements.
   * In comparison, `added` and `removed` deltas are not updated as it would cause our invariants to break.
   *
   * Also, i.e. not updating `added` deltas allow the element author to always restore his
   * remotely deleted element/s through a series of undos & redos.
   *
   * @param elements current elements
   * @param modifierOptions defines which of the delta (`from` or `to`) will be updated
   * @returns new instance with modified delta/s
   */
  public applyLatestChanges(
    elements: ReadonlyMap<string, ExcalidrawElement>,
    modifierOptions: "from" | "to",
  ): ElementsChange {
    const modifier =
      (element: ExcalidrawElement) => (partial: ElementPartial) => {
        const latestPartial: { [key: string]: unknown } = {};

        for (const key of Object.keys(partial) as Array<keyof typeof partial>) {
          if (
            key === "boundElements" ||
            key === "groupIds" ||
            key === "customData"
          ) {
            // It doesn't make sense to update the above props since:
            // - `boundElements` and `groupIds` are reference values which are represent just as removed/added changes in the delta
            // - `customData` can be anything
            latestPartial[key] = partial[key];
          } else {
            latestPartial[key] = element[key];
          }
        }

        return latestPartial;
      };

    const applyLatestChangesInternal = (
      deltas: Map<string, Delta<ElementPartial>>,
    ) => {
      const modifiedDeltas = new Map<string, Delta<ElementPartial>>();

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

    const updated = applyLatestChangesInternal(this.updated);

    return ElementsChange.create(this.added, this.removed, updated);
  }

  // For future reference, we might want to "rebase" the change itself instead (or create new increment), so it could be shared to other clients
  public applyTo(
    elements: Map<string, ExcalidrawElement>,
    snapshot: ReadonlyMap<string, ExcalidrawElement>,
  ): [Map<string, ExcalidrawElement>, boolean] {
    const visibleDifferenceFlag = { value: false };
    const changedElements = new Map<string, ExcalidrawElement>();

    function setElements(
      ...updatedElements: (ExcalidrawElement | undefined)[]
    ) {
      for (const element of updatedElements) {
        if (element) {
          elements.set(element.id, element);
          changedElements.set(element.id, element);
        }
      }
    }

    for (const [id, delta] of this.removed.entries()) {
      const existingElement = elements.get(id) ?? snapshot.get(id);

      if (existingElement) {
        const removedElement = ElementsChange.applyDelta(
          existingElement,
          delta,
          elements,
          visibleDifferenceFlag,
        );

        setElements(
          removedElement,
          ElementsChange.whenTextContainer(removedElement)?.removeBoundText(
            removedElement,
            elements,
          ),
          ElementsChange.whenBoundText(removedElement)?.unbindContainer(
            removedElement,
          ),
        );
      }
    }

    for (const [id, delta] of this.updated.entries()) {
      const existingElement = elements.get(id) ?? snapshot.get(id);

      if (existingElement) {
        const updatedElement = ElementsChange.applyDelta(
          existingElement,
          delta,
          elements,
          visibleDifferenceFlag,
        );

        setElements(updatedElement);
      }
    }

    for (const [id, delta] of this.added.entries()) {
      // Always having the local snapshot as a backup fallback, in cases when we cannot find the element in the elements array
      const existingElement = elements.get(id) ?? snapshot.get(id);

      if (existingElement) {
        const addedElement = ElementsChange.applyDelta(
          existingElement,
          delta,
          elements,
          visibleDifferenceFlag,
        );

        setElements(
          addedElement,
          ElementsChange.whenTextContainer(addedElement)?.restoreBoundText(
            addedElement,
            elements,
          ),
          ElementsChange.whenBoundText(addedElement)?.restoreContainer(
            addedElement,
            elements,
          ),
        );
      }
    }

    // TODO: refactor mutations away, so we couln't end up in an incosistent state
    ElementsChange.redrawTextBoundingBoxes(changedElements, elements);

    return [elements, visibleDifferenceFlag.value];
  }

  private static applyDelta(
    element: ExcalidrawElement,
    delta: Delta<ElementPartial>,
    elements: ReadonlyMap<string, ExcalidrawElement>,
    visibleDifferenceFlag: { value: boolean },
  ): ExcalidrawElement {
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
      // If we are adding / updating container bound elements with text,
      // make sure to unbind existing text elements first, so we don't end up with duplicates.
      if (
        addedBoundElements?.length &&
        addedBoundElements.find((x) => x.type === "text")
      ) {
        nextBoundElements = ElementsChange.unbindExistingTextElements(
          nextBoundElements ?? [],
          elements,
        );
      }

      const mergedBoundElements = Object.values(
        Delta.merge(
          arrayToObject(nextBoundElements ?? [], (x) => x.id),
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

    const mergedPartial: ElementPartial = {
      ...directlyApplicablePartial,
      boundElements: nextBoundElements,
      groupIds: nextGroupIds,
    };

    const updatedElement = newElementWith(element, mergedPartial);

    if (!visibleDifferenceFlag.value) {
      const containsVisibleDifference =
        ElementsChange.checkForVisibleDifference(element, mergedPartial);

      visibleDifferenceFlag.value = containsVisibleDifference;
    }

    return updatedElement;
  }

  /**
   * Check for visible changes regardless of whether they were removed, added or updated.
   */
  private static checkForVisibleDifference(
    element: ExcalidrawElement,
    partial: ElementPartial,
  ) {
    if (element.isDeleted && partial.isDeleted !== false) {
      // When it's deleted and partial is not false, it cannot end up with a visible change
      return false;
    }

    if (element.isDeleted && partial.isDeleted === false) {
      // When we add an element, it results in a visible change
      return true;
    }

    if (element.isDeleted === false && partial.isDeleted) {
      // When we remove an element, it results in a visible change
      return true;
    }

    // Check for any difference on a visible element
    return Delta.isRightDifferent(element, partial);
  }

  /**
   * Note: performs mutation, which we might want to refactor away, not to end up in an inconsistent state.
   */
  private static unbindExistingTextElements(
    boundElements: readonly BoundElement[],
    elements: ReadonlyMap<string, ExcalidrawElement>,
  ): readonly BoundElement[] | null {
    const boundTextElements = boundElements.filter((x) => x.type === "text");

    for (const { id } of boundTextElements) {
      const element = elements.get(id);

      if (element) {
        mutateElement(
          element as ExcalidrawTextElement,
          {
            isDeleted: true,
            containerId: null,
          },
          false,
        );
      }
    }

    const nextBoundTextElements = boundElements.filter(
      (x) => x.type !== "text",
    );

    return nextBoundTextElements.length ? nextBoundTextElements : null;
  }

  /**
   * Helper for related text containers logic.
   */
  private static whenTextContainer(element: ExcalidrawElement) {
    return hasBoundTextElement(element) ? this : undefined;
  }

  /**
   * Helper for related bound text logic.
   */
  private static whenBoundText(element: ExcalidrawElement) {
    return isBoundToContainer(element) ? this : undefined;
  }

  /**
   * When bound text is removed through history, we need to unbind it from container.
   */
  private static unbindContainer(boundText: ExcalidrawElement) {
    if ((boundText as ExcalidrawTextElement).containerId) {
      return newElementWith(boundText as ExcalidrawTextElement, {
        containerId: null,
      });
    }
  }

  /**
   * When text bindable container is removed through history, we need to remove the bound text.
   */
  private static removeBoundText(
    container: ExcalidrawElement,
    elements: ReadonlyMap<string, ExcalidrawElement>,
  ) {
    const boundTextElementId = getBoundTextElementId(container);
    const boundText = boundTextElementId
      ? elements.get(boundTextElementId)
      : undefined;

    if (boundText && !boundText.isDeleted) {
      return newElementWith(boundText, {
        isDeleted: true,
      });
    }
  }

  /**
   * When text bindable container is added through history, we need to restore it's bound text.
   */
  private static restoreBoundText(
    container: ExcalidrawElement,
    elements: ReadonlyMap<string, ExcalidrawElement>,
  ) {
    const boundTextElementId = getBoundTextElementId(container);
    const boundText = boundTextElementId
      ? elements.get(boundTextElementId)
      : undefined;

    if (boundText) {
      const updates: Mutable<ElementUpdate<ExcalidrawTextElement>> = {};

      if ((boundText as ExcalidrawTextElement).containerId !== container.id) {
        updates.containerId = container.id;
      }

      if (boundText.isDeleted) {
        updates.isDeleted = false;
      }

      return newElementWith(boundText, updates);
    }
  }

  /**
   * When bound text is added through a history, we need to restore the container if it was deleted.
   */
  private static restoreContainer(
    boundText: ExcalidrawElement,
    elements: ReadonlyMap<string, ExcalidrawElement>,
  ) {
    const { containerId } = boundText as ExcalidrawTextElement;
    const container = containerId ? elements.get(containerId) : undefined;

    if (container) {
      if (container.isDeleted) {
        return newElementWith(container, { isDeleted: false });
      }
    } else if ((boundText as ExcalidrawTextElement).containerId) {
      // Unbind when we cannot find the container
      return newElementWith(boundText as ExcalidrawTextElement, {
        containerId: null,
      });
    }
  }

  /**
   * It could happen that bindings are out of sync due to incremental history operations,
   * or that they are in sync, but end up in an incosistent state (i.e. container in a different position / angle, smaller than a bound text, etc.).
   *
   * We are trying to fix all such cases in the following method.
   *
   * Note: performs mutations.
   */
  private static redrawTextBoundingBoxes(
    changedElements: ReadonlyMap<string, ExcalidrawElement>,
    elements: ReadonlyMap<string, ExcalidrawElement>,
  ) {
    const containerTextMapping = new Map<
      string,
      { container: ExcalidrawElement; boundText: ExcalidrawTextElement }
    >();

    for (const element of changedElements.values()) {
      if (hasBoundTextElement(element)) {
        const boundTextElementId = getBoundTextElementId(element);
        const boundText = boundTextElementId
          ? elements.get(boundTextElementId)
          : undefined;

        if (boundText) {
          containerTextMapping.set(element.id, {
            container: element,
            boundText: boundText as ExcalidrawTextElement,
          });
        }
      } else if (isBoundToContainer(element)) {
        const container = elements.get(element.containerId);

        if (container) {
          containerTextMapping.set(container.id, {
            container,
            boundText: element,
          });
        }
      }
    }

    for (const { container, boundText } of containerTextMapping.values()) {
      if (container.isDeleted || boundText.isDeleted) {
        // Skip on deleted container or bound text, sa it doesn't result in visible changes so we don't need to redraw
        continue;
      }
      // this.resyncTextBindings(boundText, container, elements);
      // TODO: this is a huge bottleneck which can take up to 96% of undo / redo computation time
      // TODO: I might not need to redraw deletions, I could do it on add / update only
      redrawTextBoundingBox(boundText, container, false);
    }
  }

  /**
   * It is necessary to post process the partials in case of reference values,
   * for which we need to calculate the real diff between `from` and `to`.
   */
  private static postProcess(
    from: ElementPartial,
    to: ElementPartial,
  ): [ElementPartial, ElementPartial] {
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

      (from as Mutable<typeof from>).boundElements = fromBoundElements;
      (to as Mutable<typeof to>).boundElements = toBoundElements;
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

      (from as Mutable<typeof from>).groupIds = fromGroupIds;
      (to as Mutable<typeof to>).groupIds = toGroupIds;
    }

    return [from, to];
  }

  private static stripIrrelevantProps(
    partial: Partial<ExcalidrawElement>,
  ): ElementPartial {
    const { id, updated, version, versionNonce, seed, ...strippedPartial } =
      partial;

    return strippedPartial;
  }
}

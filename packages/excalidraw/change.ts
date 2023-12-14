import { ENV } from "./constants";
import { fixBindingsAfterDeletion } from "./element/binding";
import { mutateElement, newElementWith } from "./element/mutateElement";
import {
  getBoundTextElementId,
  redrawTextBoundingBox,
} from "./element/textElement";
import { hasBoundTextElement, isBoundToContainer } from "./element/typeChecks";
import {
  ExcalidrawElement,
  ExcalidrawTextElement,
  ExcalidrawTextElementWithContainer,
} from "./element/types";
import {
  AppState,
  ObservedAppState,
  ObservedElementsAppState,
  ObservedStandaloneAppState,
} from "./types";
import { Mutable, SubtypeOf } from "./utility-types";
import { assertNever, isShallowEqual } from "./utils";

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
    modifier?: (delta: Partial<T>) => Partial<T>,
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

    return Delta.create(from, to, modifier);
  }

  public static empty() {
    return new Delta({}, {});
  }

  public static isEmpty<T>(delta: Delta<T>): boolean {
    return !Object.keys(delta.from).length && !Object.keys(delta.to).length;
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
   * WARN: it's based on shallow compare performed only on the first level and doesn't go deeper than that.
   */
  private static *distinctKeysIterator<T extends {}>(
    join: "left" | "full",
    object1: T,
    object2: T,
  ) {
    let keys = null;

    if (join === "left") {
      keys = Object.keys(object1);
    } else {
      keys = new Set([...Object.keys(object1), ...Object.keys(object2)]);
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
   *
   * @returns new object instance and boolean, indicating if there was any visible change made.
   */
  applyTo(previous: Readonly<T>, ...options: unknown[]): [T, boolean];

  /**
   * Checks whether there are actually `Delta`s.
   */
  isEmpty(): boolean;
}

export class AppStateChange implements Change<AppState> {
  private constructor(private readonly delta: Delta<ObservedAppState>) {}

  public static calculate<T extends Partial<ObservedAppState>>(
    prevAppState: T,
    nextAppState: T,
  ): AppStateChange {
    const delta = Delta.calculate(prevAppState, nextAppState);
    return new AppStateChange(delta);
  }

  public static empty() {
    return new AppStateChange(Delta.create({}, {}));
  }

  public inverse(): AppStateChange {
    const inversedDelta = Delta.create(this.delta.to, this.delta.from);
    return new AppStateChange(inversedDelta);
  }

  public applyTo(
    appState: Readonly<AppState>,
    elements: Readonly<Map<string, ExcalidrawElement>>,
  ): [AppState, boolean] {
    const constainsVisibleChanges = this.checkForVisibleChanges(
      appState,
      elements,
    );

    const newAppState = {
      ...appState,
      ...this.delta.to, // TODO_UNDO: shouldn't apply element changes related to deleted elements, these need to be filtered out
    };

    return [newAppState, constainsVisibleChanges];
  }

  public isEmpty(): boolean {
    return Delta.isEmpty(this.delta);
  }

  private checkForVisibleChanges(
    appState: ObservedAppState,
    elements: Map<string, ExcalidrawElement>,
  ): boolean {
    const containsStandaloneDifference = Delta.isLeftDifferent(
      AppStateChange.stripElementsProps(this.delta.to),
      appState,
    );

    if (containsStandaloneDifference) {
      // We detected a a difference which is unrelated to the elements
      return true;
    }

    const containsElementsDifference = Delta.isLeftDifferent(
      AppStateChange.stripStandaloneProps(this.delta.to),
      appState,
    );

    if (!containsStandaloneDifference && !containsElementsDifference) {
      // There is no difference detected at all
      return false;
    }

    // We need to handle elements differences separately,
    // as they could be related to deleted elements and/or they could on their own result in no visible action
    const changedDeltaKeys = Delta.getLeftDifferences(
      AppStateChange.stripStandaloneProps(this.delta.to),
      appState,
    ) as Array<keyof ObservedElementsAppState>;

    // Check whether delta properties are related to the existing non-deleted elements
    for (const key of changedDeltaKeys) {
      switch (key) {
        case "selectedElementIds":
          if (
            AppStateChange.checkForSelectedElementsDifferences(
              this.delta.to[key],
              appState,
              elements,
            )
          ) {
            return true;
          }
          break;
        case "selectedLinearElement":
        case "editingLinearElement":
          if (
            AppStateChange.checkForLinearElementDifferences(
              this.delta.to[key],
              elements,
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
    deltaIds: ObservedElementsAppState["selectedElementIds"] | undefined,
    appState: Pick<AppState, "selectedElementIds">,
    elements: Map<string, ExcalidrawElement>,
  ) {
    if (!deltaIds) {
      // There are no selectedElementIds in the delta
      return;
    }

    // TODO_UNDO: it could have been visible before (and now it's not)
    // TODO_UNDO: it could have been selected even before
    for (const id of Object.keys(deltaIds)) {
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
  // TODO_UNDO: omit certain props as in ElementUpdates
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
        // When both are undefined then it's fine, otherwise they have to be different
        (from, to) =>
          (!from.isDeleted && !to.isDeleted) || from.isDeleted !== to.isDeleted,
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
          // Making sure we don't get here some weird values (i.e. undefined)
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

    // Notice we inverse removed with added
    return ElementsChange.create(removed, added, updated);
  }

  // TODO_UNDO_NEXT: what if we would instead create a new increment or update existing one?
  public applyTo(
    elements: Readonly<Map<string, ExcalidrawElement>>,
  ): [Map<string, ExcalidrawElement>, boolean] {
    let containsVisibleDifference = false;

    const checkForVisibleDifference = (
      element: ExcalidrawElement | void,
      delta: Delta<ExcalidrawElement>,
    ) => {
      if (!containsVisibleDifference) {
        if (!element) {
          // Special case when we have an addition of an element in history, but it was removed completely from the scene and want to restore it
          if (delta.to.isDeleted === false) {
            containsVisibleDifference = true;
          }
        } else if (element.isDeleted) {
          // When delta adds an element, it results in a visible change
          if (delta.to.isDeleted === false) {
            containsVisibleDifference = true;
          }
        } else if (!element.isDeleted) {
          if (delta.to.isDeleted) {
            // When delta removes non-deleted element, it results in a visible change
            containsVisibleDifference = true;
          } else {
            // Check for any difference on a visible element
            // Notice we go through all deltas regardless,
            // as visible changes could also be inside added changes (not just updated)
            containsVisibleDifference = Delta.isLeftDifferent(
              delta.to,
              element,
            );
          }
        }
      }
    };

    // Adding bound elements back might be a problem if we would be persisting history, but not persiting deleted element
    for (const [id, delta] of this.added.entries()) {
      const existingElement = elements.get(id);

      let addedElement = null;
      if (existingElement) {
        checkForVisibleDifference(existingElement, delta);
        addedElement = newElementWith(existingElement, delta.to, true);
      } else {
        checkForVisibleDifference(existingElement, delta);

        addedElement = newElementWith(
          { id } as ExcalidrawElement,
          delta.to,
          true,
        );
      }

      if (addedElement) {
        elements.set(id, addedElement);
        this.restoreContainer(addedElement, elements);
        this.restoreBoundText(addedElement, elements);
      }
    }

    for (const [id, delta] of this.removed.entries()) {
      const existingElement = elements.get(id);

      if (existingElement) {
        checkForVisibleDifference(existingElement, delta);

        const removedElement = newElementWith(existingElement, delta.to, true);
        elements.set(id, removedElement);
        this.removeBoundTextElement(removedElement, elements);

        fixBindingsAfterDeletion(
          Array.from(elements.values()),
          [removedElement],
          false,
        );
      }
    }

    for (const [id, delta] of this.updated.entries()) {
      const existingElement = elements.get(id);

      if (existingElement) {
        checkForVisibleDifference(existingElement, delta);

        const modifiedElement = newElementWith(existingElement, delta.to, true);
        elements.set(id, modifiedElement);
        this.updateBoundTextElement(modifiedElement, elements);
      }
    }

    return [elements, containsVisibleDifference];
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
      (element: ExcalidrawElement, skipDeletion: boolean) =>
      (partial: Partial<ExcalidrawElement>) => {
        const modifiedPartial: { [key: string]: unknown } = {};

        for (const key of Object.keys(partial)) {
          modifiedPartial[key] = element[key as keyof ExcalidrawElement];
        }

        return modifiedPartial;
      };

    const applyLatestChangesInternal = (
      deltas: Map<string, Delta<ExcalidrawElement>>,
      skipDeletion: boolean = false,
    ) => {
      const modifiedDeltas = new Map<string, Delta<ExcalidrawElement>>();

      for (const [id, delta] of deltas.entries()) {
        const existingElement = elements.get(id);

        if (existingElement) {
          const modifiedDelta = Delta.create(
            delta.from,
            delta.to,
            modifier(existingElement, skipDeletion),
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

  /**
   * When bounded text is added through a history action, we need to:
   * - unbind the text if container cannot be found
   * - restore container if was deleted
   * - repair container bindings if there are already some bound text elements
   * - update props of the bound text and container
   *
   * Looks like similar to what we are doing inside restore.ts (i.e. repairBoundElement)
   */
  private restoreBoundText(
    boundText: ExcalidrawElement,
    elements: Map<string, ExcalidrawElement>,
  ) {
    if (isBoundToContainer(boundText)) {
      const container = elements.get(boundText.containerId);

      if (container) {
        const updates = {} as Mutable<
          Partial<ExcalidrawTextElementWithContainer>
        >;
        if (container?.isDeleted) {
          // Restore the container
          updates.isDeleted = false;
        }

        if (hasBoundTextElement(container)) {
          // This `boundElements` field feels abused, instead we should probably have just one `boundTextElement` prop
          const otherBoundTextElements = container.boundElements.filter(
            ({ type, id }) => type === "text" && id !== boundText.id,
          );

          // Unbound existing bound text elements
          for (const other of otherBoundTextElements) {
            const otherBoundElement = elements.get(other.id);

            if (otherBoundElement) {
              const otherUnboundElement = newElementWith(
                otherBoundElement as ExcalidrawTextElementWithContainer,
                {
                  containerId: undefined,
                  isDeleted: true,
                },
              );
              elements.set(otherBoundElement.id, otherUnboundElement);
            }
          }

          // Bind new text element to the container
          updates.containerId = container.id;
        }

        let restoredContainer = container;
        if (Object.keys(updates).length) {
          restoredContainer = mutateElement(container, updates, false);
        }

        // TODO_UNDO_NEXT: get rid of such mutations, as if we would fail here, there is no way to roll back
        redrawTextBoundingBox(
          boundText as ExcalidrawTextElement,
          restoredContainer,
          false,
        );
      } else {
        // Delete the binding to the container
        const unboundText = newElementWith(
          boundText,
          {
            containerId: undefined,
          },
          true,
        );
        elements.set(boundText.id, unboundText);
      }
    }
  }

  /**
   * When text bindable container is added through history, we need to:
   * - restore bound text if it was deleted with history action (we don't remove bindings on removal)
   * - update props of the bound text and container
   */
  private restoreContainer(
    container: ExcalidrawElement,
    elements: Map<string, ExcalidrawElement>,
  ) {
    if (!hasBoundTextElement(container)) {
      return;
    }

    const boundTextElementId = getBoundTextElementId(container) || "";
    const boundText = elements.get(boundTextElementId);

    if (boundText && boundText.isDeleted) {
      mutateElement(boundText, { isDeleted: false }, false);
    }

    redrawTextBoundingBox(boundText as ExcalidrawTextElement, container, false);
  }

  private removeBoundTextElement(
    element: ExcalidrawElement,
    elements: Map<string, ExcalidrawElement>,
  ) {
    if (!hasBoundTextElement(element)) {
      return;
    }

    const boundTextElementId = getBoundTextElementId(element) || "";
    const textElement = elements.get(boundTextElementId);

    if (textElement && !textElement.isDeleted) {
      const deleted = newElementWith(textElement, { isDeleted: true });
      elements.set(textElement.id, deleted);
    }
  }

  // TODO_UNDO: Test
  private updateBoundTextElement(
    element: ExcalidrawElement,
    elements: Map<string, ExcalidrawElement>,
  ) {
    if (!hasBoundTextElement(element)) {
      return;
    }

    const boundTextElementId = getBoundTextElementId(element) || "";
    const textElement = elements.get(boundTextElementId);

    if (textElement) {
      // Performs mutation of container (element) and textElement
      redrawTextBoundingBox(
        textElement as ExcalidrawTextElement,
        element,
        false,
      );
    }
  }

  private static stripIrrelevantProps(delta: Partial<ExcalidrawElement>) {
    const { id, updated, version, versionNonce, ...strippedDelta } = delta;

    return strippedDelta;
  }
}

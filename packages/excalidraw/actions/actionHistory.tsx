import { Action, ActionResult, StoreAction } from "./types";
import { UndoIcon, RedoIcon } from "../components/icons";
import { ToolButton } from "../components/ToolButton";
import { t } from "../i18n";
import { History } from "../history";
import { AppState } from "../types";
import { KEYS } from "../keys";
import { arrayToMap } from "../utils";
import { isWindows } from "../constants";
import { ExcalidrawElement } from "../element/types";
import { IStore } from "../store";

const writeData = (
  appState: Readonly<AppState>,
  updater: () => [Map<string, ExcalidrawElement>, AppState] | void,
): ActionResult => {
  if (
    !appState.multiElement &&
    !appState.resizingElement &&
    !appState.editingElement &&
    !appState.draggingElement
  ) {
    const result = updater();

    if (!result) {
      return { storeAction: StoreAction.NONE };
    }

    // TODO_UNDO: worth detecting z-index deltas or do we just order based on fractional indices?
    // TODO_UNDO: fractional index ordering needs to be part of undo itself, as if it result in no changes, we want to iterate to the next undo
    const [nextElementsMap, nextAppState] = result;
    const nextElements = Array.from(nextElementsMap.values());

    return {
      appState: nextAppState,
      elements: nextElements,
      storeAction: StoreAction.UPDATE,
    };
  }

  return { storeAction: StoreAction.NONE };
};

type ActionCreator = (history: History, store: IStore) => Action;

export const createUndoAction: ActionCreator = (history, store) => ({
  name: "undo",
  trackEvent: { category: "history" },
  perform: (elements, appState) =>
    writeData(appState, () =>
      history.undo(arrayToMap(elements), appState, store.getSnapshot()),
    ),
  keyTest: (event) =>
    event[KEYS.CTRL_OR_CMD] &&
    event.key.toLowerCase() === KEYS.Z &&
    !event.shiftKey,
  PanelComponent: ({ updateData, data }) => (
    <ToolButton
      type="button"
      icon={UndoIcon}
      aria-label={t("buttons.undo")}
      onClick={updateData}
      size={data?.size || "medium"}
      disabled={history.isUndoStackEmpty}
    />
  ),
});

export const createRedoAction: ActionCreator = (history, store) => ({
  name: "redo",
  trackEvent: { category: "history" },
  perform: (elements, appState) =>
    writeData(appState, () =>
      history.redo(arrayToMap(elements), appState, store.getSnapshot()),
    ),
  keyTest: (event) =>
    (event[KEYS.CTRL_OR_CMD] &&
      event.shiftKey &&
      event.key.toLowerCase() === KEYS.Z) ||
    (isWindows && event.ctrlKey && !event.shiftKey && event.key === KEYS.Y),
  PanelComponent: ({ updateData, data }) => (
    <ToolButton
      type="button"
      icon={RedoIcon}
      aria-label={t("buttons.redo")}
      onClick={updateData}
      size={data?.size || "medium"}
      disabled={history.isRedoStackEmpty}
    />
  ),
});

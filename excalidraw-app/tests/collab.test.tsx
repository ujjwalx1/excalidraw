import { vi } from "vitest";
import {
  render,
  updateSceneData,
  waitFor,
} from "../../packages/excalidraw/tests/test-utils";
import ExcalidrawApp from "../App";
import { API } from "../../packages/excalidraw/tests/helpers/api";
import {
  createRedoAction,
  createUndoAction,
} from "../../packages/excalidraw/actions/actionHistory";
import { newElementWith } from "../../packages/excalidraw";
const { h } = window;

Object.defineProperty(window, "crypto", {
  value: {
    getRandomValues: (arr: number[]) =>
      arr.forEach((v, i) => (arr[i] = Math.floor(Math.random() * 256))),
    subtle: {
      generateKey: () => {},
      exportKey: () => ({ k: "sTdLvMC_M3V8_vGa3UVRDg" }),
    },
  },
});

vi.mock("../../excalidraw-app/data/index.ts", async (importActual) => {
  const module = (await importActual()) as any;
  return {
    __esmodule: true,
    ...module,
    getCollabServer: vi.fn(() => ({
      url: /* doesn't really matter */ "http://localhost:3002",
    })),
  };
});

vi.mock("../../excalidraw-app/data/firebase.ts", () => {
  const loadFromFirebase = async () => null;
  const saveToFirebase = () => {};
  const isSavedToFirebase = () => true;
  const loadFilesFromFirebase = async () => ({
    loadedFiles: [],
    erroredFiles: [],
  });
  const saveFilesToFirebase = async () => ({
    savedFiles: new Map(),
    erroredFiles: new Map(),
  });

  return {
    loadFromFirebase,
    saveToFirebase,
    isSavedToFirebase,
    loadFilesFromFirebase,
    saveFilesToFirebase,
  };
});

vi.mock("socket.io-client", () => {
  return {
    default: () => {
      return {
        close: () => {},
        on: () => {},
        once: () => {},
        off: () => {},
        emit: () => {},
      };
    },
  };
});

// These test would deserve to be extended by testing collab with (at least) two clients simultanouesly,
// while having access to both scenes, appstates, histories and etc.
// i.e. multiplayer history tests could be a good first candidate, as we could test both history stacks simultaneously.
describe("collaboration", () => {
  it("creating room should reset deleted elements while allowing undo", async () => {
    await render(<ExcalidrawApp />);
    // To update the scene with deleted elements before starting collab
    const rect1 = API.createElement({ type: "rectangle", id: "A" });
    const rect2 = API.createElement({
      type: "rectangle",
      id: "B",
    });

    updateSceneData({
      elements: [rect1, rect2],
      commitToStore: true,
    });

    updateSceneData({
      elements: [rect1, newElementWith(rect2, { isDeleted: true })],
      commitToStore: true,
    });

    await waitFor(() => {
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getSnapshot()).toEqual([
        expect.objectContaining({ id: "A" }),
        expect.objectContaining({ id: "B", isDeleted: true }),
      ]);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: "A" }),
        expect.objectContaining({ id: "B", isDeleted: true }),
      ]);
    });
    window.collab.startCollaboration(null);
    await waitFor(() => {
      expect(API.getUndoStack().length).toBe(2);
      // We never delete from the local store as it is used for correct diff calculation
      expect(API.getSnapshot()).toEqual([
        expect.objectContaining({ id: "A" }),
        expect.objectContaining({ id: "B", isDeleted: true }),
      ]);
      expect(h.elements).toEqual([expect.objectContaining({ id: "A" })]);
    });

    const undoAction = createUndoAction(h.history);
    h.app.actionManager.executeAction(undoAction);

    // Inability to undo your own deletions (and lose data) is a bigger factor than
    // potentially saving sensitive data into a backup service
    await waitFor(() => {
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getSnapshot()).toEqual([
        expect.objectContaining({ id: "A" }),
        expect.objectContaining({ id: "B", isDeleted: false }),
      ]);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: "A" }),
        expect.objectContaining({ id: "B", isDeleted: false }),
      ]);
    });

    h.app.actionManager.executeAction(undoAction);

    await waitFor(() => {
      expect(h.history.isUndoStackEmpty).toBeTruthy();
      expect(API.getRedoStack().length).toBe(2);
      expect(API.getSnapshot()).toEqual([
        expect.objectContaining({ id: "A", isDeleted: true }),
        expect.objectContaining({ id: "B", isDeleted: true }),
      ]);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: "A", isDeleted: true }),
        expect.objectContaining({ id: "B", isDeleted: true }),
      ]);
    });

    const redoAction = createRedoAction(h.history);
    h.app.actionManager.executeAction(redoAction);

    await waitFor(() => {
      expect(API.getUndoStack().length).toBe(1);
      expect(API.getRedoStack().length).toBe(1);
      expect(API.getSnapshot()).toEqual([
        expect.objectContaining({ id: "A", isDeleted: false }),
        expect.objectContaining({ id: "B", isDeleted: false }),
      ]);
      expect(h.elements).toEqual([
        expect.objectContaining({ id: "A", isDeleted: false }),
        expect.objectContaining({ id: "B", isDeleted: false }),
      ]);
    });

    h.app.actionManager.executeAction(redoAction);

    await waitFor(() => {
      expect(API.getUndoStack().length).toBe(2);
      expect(API.getSnapshot()).toEqual([
        expect.objectContaining({ id: "A", isDeleted: false }),
        expect.objectContaining({ id: "B", isDeleted: true }),
      ]);
      expect(h.history.isRedoStackEmpty).toBeTruthy();
      expect(h.elements).toEqual([
        expect.objectContaining({ id: "A", isDeleted: false }),
        expect.objectContaining({ id: "B", isDeleted: true }),
      ]);
    });
  });
});

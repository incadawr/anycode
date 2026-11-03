import { describe, expect, it, vi } from "vitest";
import { formatDroppedPath, planComposerDrop } from "./composer-drop.js";

describe("dropped paths", () => {
  it("formats workspace paths, outside paths, spaces and Windows paths", () => {
    expect(formatDroppedPath("/work/project/a b.md", "/work/project")).toBe('"a b.md"');
    expect(formatDroppedPath("/work/project-other/a", "/work/project")).toBe("/work/project-other/a");
    expect(formatDroppedPath("/work/project", "/work/project/")).toBe(".");
    expect(formatDroppedPath("/a", "/")).toBe("a");
    expect(formatDroppedPath("C:\\", "c:\\")).toBe(".");
    expect(formatDroppedPath("C:\\Work\\Project\\a b.txt", "c:\\work\\project")).toBe('"a b.txt"');
    expect(formatDroppedPath("D:\\other\\a", "C:\\work")).toBe("D:\\other\\a");
  });
  it("attaches images when supported and inserts all other available paths", () => {
    const image = { name: "a.png", type: "image/png", path: "/ws/a.png" };
    const doc = { name: "a.md", type: "", path: "/ws/a.md" };
    const folder = { name: "folder", type: "", path: "/ws/folder" };
    const missing = { name: "missing", type: "", path: "" };
    const getPath = vi.fn((file: typeof image) => file.path);
    const items = [image, doc, folder, missing].map(file => ({ file, isDirectory: false }));
    expect(planComposerDrop(items, true, "/ws", getPath)).toEqual({ attachImages: [image], insertPaths: ["a.md", "folder"] });
    expect(planComposerDrop([{ file: image, isDirectory: false }], false, "/ws", getPath)).toEqual({ attachImages: [], insertPaths: ["a.png"] });
  });
  it("inserts a directory even when its name looks like an image", () => {
    const folder = { name: "photos.png", type: "", path: "/ws/photos.png" };
    expect(planComposerDrop([{ file: folder, isDirectory: true }], true, "/ws", file => file.path))
      .toEqual({ attachImages: [], insertPaths: ["photos.png"] });
  });
});

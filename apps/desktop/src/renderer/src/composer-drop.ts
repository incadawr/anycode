export function formatDroppedPath(path: string, workspace?: string): string {
  const windows = /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
  const normalized = (value: string): string => windows ? value.replace(/\\/g, "/") : value;
  const candidate = normalized(path);
  const root = workspace ? normalized(workspace).replace(/\/+$/, "") : "";
  const compare = (value: string): string => windows ? value.toLowerCase() : value;
  let result = path;
  if (workspace && compare(candidate.replace(/\/+$/, "")) === compare(normalized(workspace).replace(/\/+$/, ""))) result = ".";
  else if (root && compare(candidate).startsWith(compare(root + "/"))) result = candidate.slice(root.length + 1);
  else if (workspace === "/" && candidate.startsWith("/")) result = candidate.slice(1) || ".";
  return /[\s"]/.test(result) ? JSON.stringify(result) : result;
}

export function planComposerDrop<T extends { type: string; name: string }>(
  items: readonly { file: T; isDirectory: boolean }[], supportsImages: boolean, workspace: string | undefined, getPath: (file: T) => string,
): { attachImages: T[]; insertPaths: string[] } {
  const attachImages: T[] = [];
  const insertPaths: string[] = [];
  for (const { file, isDirectory } of items) {
    if (!isDirectory && supportsImages && (file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(file.name))) {
      attachImages.push(file);
    } else {
      const path = getPath(file);
      if (path) insertPaths.push(formatDroppedPath(path, workspace));
    }
  }
  return { attachImages, insertPaths };
}

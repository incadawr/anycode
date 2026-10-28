/**
 * Settings → Roles profile controls: naming, rename eligibility and the
 * project picker's label. Pure, no React, so node-env vitest pins the rules
 * (`role-profile-controls.test.ts`).
 *
 * Two rules the pane used to miss:
 * - an empty "Profile name" no longer produces a second "New profile"/"Copy"
 *   row that cannot be told apart — it falls back to the next free
 *   "Profile N" (or "<source> copy N" for Duplicate);
 * - Rename is enabled for a CUSTOM profile as soon as the typed name differs,
 *   and is never offered for the built-in defaults (no custom profile).
 */

/** The first free name in the `Profile 1`, `Profile 2`, … series. */
export function nextProfileName(existing: readonly string[]): string {
  let ordinal = 1;
  while (existing.includes(`Profile ${ordinal}`)) {
    ordinal += 1;
  }
  return `Profile ${ordinal}`;
}

/** `base`, or the first free `base N` when the name is taken. */
export function uniqueProfileName(existing: readonly string[], base: string): string {
  if (!existing.includes(base)) {
    return base;
  }
  let ordinal = 2;
  while (existing.includes(`${base} ${ordinal}`)) {
    ordinal += 1;
  }
  return `${base} ${ordinal}`;
}

/** Create profile: the typed name, else a unique default. */
export function createProfileName(typed: string, existing: readonly string[]): string {
  const name = typed.trim();
  return name === "" ? nextProfileName(existing) : name;
}

/**
 * The name a copy series counts from: a trailing ` copy` / ` copy N` is
 * stripped, so duplicating an untouched copy asks for the next free
 * `<source> copy N` instead of chaining ` copy copy`.
 */
export function copySeriesBaseName(name: string): string {
  return name.trim().replace(/(?: copy(?: \d+)?)+$/, "").trim();
}

/** Duplicate profile: the typed name, else a unique "<source> copy". */
export function duplicateProfileName(
  typed: string,
  existing: readonly string[],
  sourceName: string | undefined,
): string {
  const name = typed.trim();
  if (name !== "") {
    return name;
  }
  if (sourceName === undefined || sourceName.trim() === "") {
    return uniqueProfileName(existing, "Copy");
  }
  const base = copySeriesBaseName(sourceName);
  return uniqueProfileName(existing, `${base === "" ? sourceName.trim() : base} copy`);
}

/**
 * Rename applies to a CUSTOM profile only, and only to a typed name that
 * actually changes it.
 */
export function canRenameProfile(selectedName: string | undefined, typed: string): boolean {
  const name = typed.trim();
  return selectedName !== undefined && name !== "" && name !== selectedName;
}

/** A project option shows the folder name; the full path stays a tooltip. */
export function projectFolderName(path: string): string {
  const trimmed = path.trim();
  const withoutTrailing = trimmed.replace(/[/\\]+$/, "");
  if (withoutTrailing === "") {
    return trimmed;
  }
  const index = Math.max(withoutTrailing.lastIndexOf("/"), withoutTrailing.lastIndexOf("\\"));
  const folder = index === -1 ? withoutTrailing : withoutTrailing.slice(index + 1);
  return folder === "" ? trimmed : folder;
}

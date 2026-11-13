const MAX_PROJECT_KEY_LENGTH = 48;
const ASCII_ALPHANUMERIC_RUN = /[A-Za-z0-9]+/gu;

/**
 * Suggests an editable project key from ASCII name fragments.
 *
 * This does not reserve a key. The Host and the current Profile database remain
 * authoritative for validation and uniqueness.
 */
export function suggestProjectKey(
  name: string,
  existingKeys: readonly string[] = [],
): string | null {
  const fragments = name.match(ASCII_ALPHANUMERIC_RUN);
  if (fragments === null) return null;

  const slug = fragments.map((fragment) => fragment.toLowerCase()).join("-");
  const base = slug.slice(0, MAX_PROJECT_KEY_LENGTH).replace(/-+$/u, "");
  const existing = new Set(existingKeys);
  if (!existing.has(base)) return base;

  for (let suffixNumber = 2; ; suffixNumber += 1) {
    const suffix = `-${suffixNumber}`;
    const prefixLength = MAX_PROJECT_KEY_LENGTH - suffix.length;
    const prefix = base.slice(0, prefixLength).replace(/-+$/u, "");
    const candidate = `${prefix}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
}

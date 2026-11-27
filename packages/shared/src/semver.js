/**
 * Canonical RFC SemVer parsing and comparison utilities shared across
 * Desktop Auto-Updater, Mobile/Android OTA Updater, Relay Server, and CI scripts.
 */

const SEMVER_RE =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

/**
 * Parse a SemVer string into structured numeric & prerelease components.
 * Returns `null` if invalid.
 * @param {string} raw
 */
export function parseSemver(raw) {
  const m = String(raw || '').trim().match(SEMVER_RE)
  if (!m) return null
  const major = Number(m[1])
  const minor = Number(m[2])
  const patch = Number(m[3])
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null
  }
  const pre = m[4] ? m[4].split('.') : []
  return { major, minor, patch, pre, build: m[5] || '' }
}

/**
 * Check whether a string is a valid SemVer version (optional leading `v`).
 * @param {string} raw
 */
export function isValidSemver(raw) {
  return parseSemver(raw) !== null
}

/**
 * Compare two SemVer strings according to SemVer 2.0.0 precedence rules
 * (numeric prerelease identifiers are compared numerically, e.g. `beta.10 > beta.2`).
 * Returns `-1`, `0`, or `1`.
 * @param {string} a
 * @param {string} b
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa && !pb) return 0
  if (!pa) return -1
  if (!pb) return 1

  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1

  if (pa.pre.length === 0 && pb.pre.length === 0) return 0
  if (pa.pre.length === 0) return 1
  if (pb.pre.length === 0) return -1

  const len = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < len; i += 1) {
    if (i >= pa.pre.length) return -1
    if (i >= pb.pre.length) return 1
    const ai = pa.pre[i]
    const bi = pb.pre[i]
    if (ai === bi) continue
    const aNum = /^\d+$/.test(ai)
    const bNum = /^\d+$/.test(bi)
    if (aNum && bNum) {
      const diff = Number(ai) - Number(bi)
      if (diff !== 0) return diff > 0 ? 1 : -1
      continue
    }
    // SemVer 2.0.0 §11.4.3: numeric identifiers always have lower precedence than non-numeric
    if (aNum !== bNum) return aNum ? -1 : 1
    return ai < bi ? -1 : 1
  }
  return 0
}

/**
 * Return true if `current >= minimum` under SemVer 2.0.0 precedence.
 * @param {string} current
 * @param {string} minimum
 */
export function isSemverAtLeast(current, minimum) {
  if (!minimum) return true
  if (!parseSemver(current) || !parseSemver(minimum)) return false
  return compareSemver(current, minimum) >= 0
}

/**
 * Locale-independent lexicographical UTF-16 code-unit comparison.
 * Use this instead of `localeCompare()` for deterministic manifest/archive signing.
 * @param {string} a
 * @param {string} b
 */
export function compareCodePoint(a, b) {
  const sa = String(a ?? '')
  const sb = String(b ?? '')
  if (sa < sb) return -1
  if (sa > sb) return 1
  return 0
}

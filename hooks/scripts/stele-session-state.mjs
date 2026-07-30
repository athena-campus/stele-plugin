import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"

const API_TOKEN_PATTERN = /sk_stele_[A-Za-z0-9_-]+/
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const WORKSPACE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/

export function sessionStateDirectory(env) {
  if (env.STELE_SESSION_STATE_DIR) {
    return path.resolve(env.STELE_SESSION_STATE_DIR)
  }
  return env.HOME ? path.join(env.HOME, ".stele", "claude-sessions") : null
}

export function sessionStateFile(directory, sessionId) {
  if (
    !directory ||
    typeof sessionId !== "string" ||
    !SESSION_ID_PATTERN.test(sessionId)
  ) {
    return null
  }
  return path.join(directory, `${sessionId}.json`)
}

function normalizeEntry(value) {
  if (!value || typeof value !== "object") return null
  if (typeof value.planId !== "string" || value.planId.length === 0) return null
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
    return null
  }

  const entry = { planId: value.planId }
  if (
    typeof value.workspaceSlug === "string" &&
    WORKSPACE_SLUG_PATTERN.test(value.workspaceSlug)
  ) {
    entry.workspaceSlug = value.workspaceSlug
  }
  entry.planTitle = typeof value.planTitle === "string" ? value.planTitle : ""
  entry.createdAt = value.createdAt
  return entry
}

async function removeTemporary(file) {
  try {
    await unlink(file)
  } catch {
    return
  }
}

export async function readSessionState(file) {
  let raw
  try {
    raw = await readFile(file, "utf8")
  } catch {
    return null
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return null

  return {
    version: 1,
    entries: parsed.entries.map(normalizeEntry).filter(Boolean),
  }
}

export async function writeSessionState(file, state, forbiddenSecrets = []) {
  const normalized = {
    version: 1,
    entries: Array.isArray(state?.entries)
      ? state.entries.map(normalizeEntry).filter(Boolean)
      : [],
  }
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`
  if (
    API_TOKEN_PATTERN.test(serialized) ||
    forbiddenSecrets.some(
      (secret) => typeof secret === "string" && secret.length > 0 && serialized.includes(secret),
    )
  ) {
    throw new Error("refusing to persist secret material in Claude session state")
  }

  const directory = path.dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  )

  try {
    await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, file)
    await chmod(file, 0o600)
  } catch (error) {
    await removeTemporary(temporary)
    throw error
  }
}

export async function removePlanEntry(file, planId, forbiddenSecrets = []) {
  const current = await readSessionState(file)
  if (!current) return false
  const entries = current.entries.filter((entry) => entry.planId !== planId)
  if (entries.length === current.entries.length) return true
  await writeSessionState(file, { version: 1, entries }, forbiddenSecrets)
  return true
}

export async function findSessionIdForPlan(directory, planId) {
  if (!directory) return null

  let directoryEntries
  try {
    directoryEntries = await readdir(directory, { withFileTypes: true })
  } catch {
    return null
  }

  const candidates = directoryEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))

  for (const candidate of candidates) {
    const sessionId = candidate.name.slice(0, -".json".length)
    const file = sessionStateFile(directory, sessionId)
    if (!file) continue
    const state = await readSessionState(file)
    if (state?.entries.some((entry) => entry.planId === planId)) return sessionId
  }
  return null
}

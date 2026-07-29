#!/usr/bin/env node

import { spawn } from "node:child_process"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

const DEFAULT_URL = "http://localhost:3033/api/mcp"
const DEFAULT_INTERVAL_SECONDS = 60
const PLAN_STATUSES = new Set([
  "proposed",
  "ready",
  "active",
  "completed",
  "cancelled",
])

const usage = `Usage: node watcher.mjs --workspace <slug> [options]

Required environment:
  STELE_API_KEY              Stele API token (environment only)

Options and environment:
  --url <url>                MCP endpoint (STELE_URL; default: ${DEFAULT_URL})
  --workspace <slug>         Workspace slug (STELE_WORKSPACE)
  --interval <seconds>       Poll interval (STELE_POLL_INTERVAL; default: 60)
  --status <status>          Plan status (STELE_STATUS; default: ready)
  --on-ready <command>       Opt-in shell command for each newly seen Plan
  --notify                   Enable macOS notification (default)
  --no-notify                Disable macOS notification
  --once                     Poll once, then exit
  --help                     Show this help

State defaults to ~/.stele/watcher-state.json. STELE_WATCHER_STATE_FILE may
override the path for isolated verification. The API token is never persisted.`

function parseArgs(argv) {
  const values = new Map()
  let notify = true
  let once = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--help" || argument === "-h") {
      return { help: true }
    }
    if (argument === "--notify") {
      notify = true
      continue
    }
    if (argument === "--no-notify") {
      notify = false
      continue
    }
    if (argument === "--once") {
      once = true
      continue
    }
    if (argument === "--api-key" || argument.startsWith("--api-key=")) {
      throw new Error("STELE_API_KEY is environment-only; --api-key is not supported")
    }

    const equalsIndex = argument.indexOf("=")
    const name = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex)
    if (!["--url", "--workspace", "--interval", "--status", "--on-ready"].includes(name)) {
      throw new Error(`Unknown argument: ${argument}`)
    }
    const value =
      equalsIndex === -1 ? argv[index + 1] : argument.slice(equalsIndex + 1)
    if (!value || (equalsIndex === -1 && value.startsWith("--"))) {
      throw new Error(`${name} requires a value`)
    }
    values.set(name, value)
    if (equalsIndex === -1) index += 1
  }

  return { help: false, values, notify, once }
}

function loadConfig(argv, env) {
  const parsed = parseArgs(argv)
  if (parsed.help) return parsed

  const workspace = parsed.values.get("--workspace") ?? env.STELE_WORKSPACE
  if (!workspace) throw new Error("--workspace or STELE_WORKSPACE is required")
  if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(workspace)) {
    throw new Error(`Invalid Workspace slug: ${workspace}`)
  }

  const apiKey = env.STELE_API_KEY
  if (!apiKey) throw new Error("STELE_API_KEY is required")

  const endpoint = new URL(parsed.values.get("--url") ?? env.STELE_URL ?? DEFAULT_URL)
  if (!["http:", "https:"].includes(endpoint.protocol)) {
    throw new Error("STELE_URL must use http or https")
  }
  if (endpoint.username || endpoint.password) {
    throw new Error("STELE_URL must not contain credentials; use STELE_API_KEY")
  }

  const intervalText =
    parsed.values.get("--interval") ??
    env.STELE_POLL_INTERVAL ??
    String(DEFAULT_INTERVAL_SECONDS)
  const intervalSeconds = Number(intervalText)
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error("Poll interval must be a positive number of seconds")
  }

  const status = parsed.values.get("--status") ?? env.STELE_STATUS ?? "ready"
  if (!PLAN_STATUSES.has(status)) {
    throw new Error(`Invalid Plan status: ${status}`)
  }

  const home = env.HOME
  const stateFile = env.STELE_WATCHER_STATE_FILE
    ? path.resolve(env.STELE_WATCHER_STATE_FILE)
    : home
      ? path.join(home, ".stele", "watcher-state.json")
      : null
  if (!stateFile) {
    throw new Error("HOME or STELE_WATCHER_STATE_FILE is required for watcher state")
  }

  return {
    help: false,
    endpoint,
    apiKey,
    workspace,
    intervalMs: intervalSeconds * 1000,
    status,
    command: parsed.values.get("--on-ready") ?? null,
    notify: parsed.notify,
    once: parsed.once,
    stateFile,
  }
}

function endpointStateId(endpoint) {
  return `${endpoint.origin}${endpoint.pathname}`
}

function watcherStateKey(config) {
  return JSON.stringify([
    endpointStateId(config.endpoint),
    config.workspace,
    config.status,
  ])
}

class StateStore {
  constructor(file, forbiddenSecret) {
    this.file = file
    this.forbiddenSecret = forbiddenSecret
    this.state = { version: 1, watchers: {} }
    this.saveQueue = Promise.resolve()
  }

  async load() {
    try {
      const raw = await readFile(this.file, "utf8")
      if (raw.includes(this.forbiddenSecret)) {
        throw new Error("state file contains STELE_API_KEY; remove it before continuing")
      }
      const parsed = JSON.parse(raw)
      if (parsed?.version !== 1 || typeof parsed.watchers !== "object") {
        throw new Error("unsupported state format")
      }
      this.state = parsed
    } catch (error) {
      if (error?.code === "ENOENT") return
      throw error
    }
  }

  seenIds(key) {
    const ids = this.state.watchers[key]?.seen
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [])
  }

  replaceSeen(key, seen) {
    this.state.watchers[key] = {
      seen: [...seen].sort(),
      updatedAt: new Date().toISOString(),
    }
  }

  save() {
    this.saveQueue = this.saveQueue.then(async () => {
      const serialized = `${JSON.stringify(this.state, null, 2)}\n`
      if (serialized.includes(this.forbiddenSecret)) {
        throw new Error("refusing to persist STELE_API_KEY in watcher state")
      }
      const directory = path.dirname(this.file)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = `${this.file}.${process.pid}.tmp`
      await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 })
      await rename(temporary, this.file)
    })
    return this.saveQueue
  }
}

function parseSse(raw) {
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice("data:".length).trim()
    if (!payload) continue
    try {
      const parsed = JSON.parse(payload)
      if (parsed?.jsonrpc === "2.0") return parsed
    } catch {
      // Continue to the next SSE data frame.
    }
  }
  return null
}

let requestId = 0
let activeChild = null

async function callTool(config, name, args, signal) {
  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++requestId,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    signal,
  })

  const raw = await response.text()
  const contentType = response.headers.get("content-type") ?? ""
  let rpc = null
  try {
    rpc = contentType.includes("text/event-stream") ? parseSse(raw) : JSON.parse(raw)
  } catch {
    throw new Error(`MCP returned an unreadable response (HTTP ${response.status})`)
  }
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`)
  if (!rpc) throw new Error("MCP response did not contain JSON-RPC data")
  if (rpc.error) throw new Error(`MCP ${rpc.error.code}: ${rpc.error.message}`)
  if (rpc.result?.isError) {
    const message = rpc.result.content
      ?.filter((item) => item.type === "text")
      .map((item) => item.text)
      .join(" ")
    throw new Error(message || `${name} failed`)
  }

  const text = rpc.result?.content?.find((item) => item.type === "text")?.text
  if (typeof text !== "string") throw new Error(`${name} returned no text content`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${name} returned invalid JSON content`)
  }
}

async function listPlans(config, signal) {
  const result = await callTool(
    config,
    "list_plans",
    { workspace: config.workspace, status: config.status },
    signal,
  )
  if (!Array.isArray(result?.plans)) throw new Error("list_plans returned no plans array")
  return result.plans.filter(
    (plan) =>
      plan &&
      typeof plan.id === "string" &&
      typeof plan.title === "string" &&
      plan.status === config.status,
  )
}

function planWebUrl(config, planId) {
  const url = new URL(config.endpoint)
  url.username = ""
  url.password = ""
  url.search = ""
  url.hash = ""
  url.pathname = `/w/${encodeURIComponent(config.workspace)}/plans/${encodeURIComponent(planId)}`
  return url.toString()
}

function appleScriptString(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ")
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
}

async function notifyPlan(plan) {
  if (process.platform !== "darwin") {
    throw new Error("macOS notification unavailable on this platform")
  }
  const message = appleScriptString(
    `Plan を検知 (${plan.status}): ${plan.title}`.slice(0, 240),
  )
  const script = `display notification "${message}" with title "Stele watcher"`
  const child = spawn("/usr/bin/osascript", ["-e", script], { stdio: "ignore" })
  activeChild = child
  let result
  try {
    result = await waitForChild(child)
  } finally {
    activeChild = null
  }
  if (result.code !== 0) {
    throw new Error(`osascript exited with ${result.code ?? result.signal}`)
  }
}

async function runCommand(config, plan, url) {
  const child = spawn(config.command, {
    shell: true,
    stdio: "inherit",
    env: {
      ...process.env,
      STELE_PLAN_ID: plan.id,
      STELE_PLAN_TITLE: plan.title,
      STELE_PLAN_URL: url,
      STELE_PLAN_STATUS: plan.status,
      STELE_WORKSPACE: config.workspace,
    },
  })
  activeChild = child
  let result
  try {
    result = await waitForChild(child)
  } finally {
    activeChild = null
  }
  if (result.code !== 0) {
    throw new Error(`--on-ready command exited with ${result.code ?? result.signal}`)
  }
}

function oneLine(value) {
  return value.replace(/[\r\n]+/g, " ")
}

async function handlePlan(config, plan, shouldStop) {
  const url = planWebUrl(config, plan.id)
  let notification = "disabled"
  if (config.notify) {
    try {
      await notifyPlan(plan)
      notification = "sent"
    } catch (error) {
      notification = "failed"
      console.warn(`[stele-watcher] notification warning: ${error.message}`)
    }
  }

  console.log(
    `${new Date().toISOString()} [stele-watcher] detected status=${plan.status} id=${plan.id} title=${JSON.stringify(oneLine(plan.title))} url=${url} notify=${notification} action=${config.command && !shouldStop() ? "run" : "disabled"}`,
  )

  if (!config.command || shouldStop()) return
  try {
    await runCommand(config, plan, url)
  } catch (error) {
    console.warn(`[stele-watcher] command warning: ${error.message}`)
  }
}

function abortableDelay(milliseconds, registerWake) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    registerWake(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function main() {
  let config
  try {
    config = loadConfig(process.argv.slice(2), process.env)
  } catch (error) {
    console.error(`[stele-watcher] ${error.message}`)
    console.error(usage)
    process.exitCode = 1
    return
  }
  if (config.help) {
    console.log(usage)
    return
  }

  const store = new StateStore(config.stateFile, config.apiKey)
  try {
    await store.load()
  } catch (error) {
    console.error(`[stele-watcher] state error: ${error.message}`)
    process.exitCode = 1
    return
  }

  const key = watcherStateKey(config)
  const seen = store.seenIds(key)
  let stopping = false
  let wakeDelay = null
  let activeController = null

  const stop = (signal) => {
    if (stopping) return
    stopping = true
    activeController?.abort()
    activeChild?.kill("SIGTERM")
    wakeDelay?.()
    console.warn(`[stele-watcher] ${signal} received; saving state`)
    void store.save().catch((error) => {
      console.error(`[stele-watcher] failed to save state: ${error.message}`)
      process.exitCode = 1
    })
  }
  process.on("SIGINT", () => stop("SIGINT"))
  process.on("SIGTERM", () => stop("SIGTERM"))

  do {
    activeController = new AbortController()
    const timeout = setTimeout(() => activeController.abort(), 15_000)
    try {
      const plans = await listPlans(config, activeController.signal)
      const fresh = plans.filter((plan) => !seen.has(plan.id))

      for (const plan of fresh) seen.add(plan.id)
      if (fresh.length > 0) {
        store.replaceSeen(key, seen)
        await store.save()
      }
      for (const plan of fresh) {
        if (stopping) break
        await handlePlan(config, plan, () => stopping)
      }
    } catch (error) {
      if (!stopping) {
        console.warn(`[stele-watcher] poll warning: ${error.message}; retrying`)
      }
    } finally {
      clearTimeout(timeout)
      activeController = null
    }

    if (config.once || stopping) break
    await abortableDelay(config.intervalMs, (wake) => {
      wakeDelay = wake
    })
    wakeDelay = null
  } while (!stopping)

  store.replaceSeen(key, seen)
  try {
    await store.save()
  } catch (error) {
    console.error(`[stele-watcher] failed to save state: ${error.message}`)
    process.exitCode = 1
  }
}

await main()

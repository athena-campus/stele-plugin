#!/usr/bin/env node

import {
  readSessionState,
  removePlanEntry,
  sessionStateDirectory,
  sessionStateFile,
} from "./stele-session-state.mjs"

const DEFAULT_URL = "http://localhost:3033/api/mcp"
const DEFAULT_INTERVAL_SECONDS = 25
const MIN_INTERVAL_SECONDS = 15
const DEFAULT_BUDGET_SECONDS = 900
const MAX_BUDGET_SECONDS = 1080

async function readHookInput() {
  let raw = ""
  try {
    for await (const chunk of process.stdin) raw += chunk
  } catch {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function parseNumber(value, fallback) {
  if (value === undefined || value === "") return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function loadPollingConfig(env) {
  let endpoint
  try {
    endpoint = new URL(env.STELE_URL ?? DEFAULT_URL)
  } catch {
    return null
  }
  if (!["http:", "https:"].includes(endpoint.protocol)) return null
  if (endpoint.username || endpoint.password) return null

  const intervalSeconds = Math.max(
    MIN_INTERVAL_SECONDS,
    parseNumber(env.STELE_STOP_HOOK_INTERVAL, DEFAULT_INTERVAL_SECONDS),
  )
  const budgetSeconds = Math.min(
    MAX_BUDGET_SECONDS,
    parseNumber(env.STELE_STOP_HOOK_BUDGET, DEFAULT_BUDGET_SECONDS),
  )
  return {
    endpoint,
    intervalMs: intervalSeconds * 1000,
    budgetMs: budgetSeconds * 1000,
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
      continue
    }
  }
  return null
}

let requestId = 0

async function listPlans(config, apiKey, workspace, signal) {
  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++requestId,
      method: "tools/call",
      params: { name: "list_plans", arguments: { workspace } },
    }),
    signal,
  })

  const raw = await response.text()
  const contentType = response.headers.get("content-type") ?? ""
  let rpc
  try {
    rpc = contentType.includes("text/event-stream") ? parseSse(raw) : JSON.parse(raw)
  } catch {
    throw new Error("unreadable MCP response")
  }
  if (!response.ok || !rpc || rpc.error || rpc.result?.isError) {
    throw new Error("list_plans failed")
  }

  const text = rpc.result?.content?.find((item) => item.type === "text")?.text
  if (typeof text !== "string") throw new Error("list_plans returned no text content")
  let result
  try {
    result = JSON.parse(text)
  } catch {
    throw new Error("list_plans returned invalid JSON content")
  }
  if (!Array.isArray(result?.plans)) throw new Error("list_plans returned no plans array")
  return result.plans
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function pollWorkspace(config, apiKey, workspace, remainingMs) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(1, remainingMs))
  try {
    return await listPlans(config, apiKey, workspace, controller.signal)
  } finally {
    clearTimeout(timeout)
  }
}

function findOutcome(entries, plansByWorkspace) {
  for (const entry of entries) {
    if (!entry.workspaceSlug || !plansByWorkspace.has(entry.workspaceSlug)) continue
    const plan = plansByWorkspace
      .get(entry.workspaceSlug)
      .find((candidate) => candidate?.id === entry.planId)
    if (plan?.status === "ready") {
      return {
        kind: "ready",
        entry,
        title: typeof plan.title === "string" ? plan.title : entry.planTitle,
      }
    }
  }

  for (const entry of entries) {
    if (!entry.workspaceSlug || !plansByWorkspace.has(entry.workspaceSlug)) continue
    const exists = plansByWorkspace
      .get(entry.workspaceSlug)
      .some((candidate) => candidate?.id === entry.planId)
    if (!exists) return { kind: "absent", entry }
  }
  return null
}

function blockReason(outcome) {
  if (outcome.kind === "ready") {
    return `Plan ${outcome.entry.planId} (${outcome.title}) が承認されました。read_plan で最新の本文と status を再確認してから着手してください。`
  }
  return `Plan ${outcome.entry.planId} は承認待ち一覧に存在しません（cancelled または completed の可能性）。read_plan で確認し、対応を判断してください。`
}

async function waitForApproval(apiKey, stateFile, state, config) {
  const workspaces = [
    ...new Set(state.entries.map((entry) => entry.workspaceSlug).filter(Boolean)),
  ]
  if (workspaces.length === 0) return

  const startedAt = Date.now()
  let consecutiveFailures = 0

  while (Date.now() - startedAt < config.budgetMs) {
    const plansByWorkspace = new Map()
    let pollFailed = false

    for (const workspace of workspaces) {
      const remainingMs = config.budgetMs - (Date.now() - startedAt)
      if (remainingMs <= 0) return
      try {
        plansByWorkspace.set(
          workspace,
          await pollWorkspace(config, apiKey, workspace, remainingMs),
        )
      } catch {
        pollFailed = true
      }
    }

    const outcome = findOutcome(state.entries, plansByWorkspace)
    if (outcome) {
      const removed = await removePlanEntry(stateFile, outcome.entry.planId, [apiKey])
      if (!removed) return
      process.stdout.write(
        JSON.stringify({ decision: "block", reason: blockReason(outcome) }),
      )
      return
    }

    consecutiveFailures = pollFailed ? consecutiveFailures + 1 : 0
    if (consecutiveFailures >= 3) return

    const remainingMs = config.budgetMs - (Date.now() - startedAt)
    if (remainingMs <= 0) return
    await delay(Math.min(config.intervalMs, remainingMs))
  }
}

async function runHook() {
  const input = await readHookInput()
  if (!input || input.stop_hook_active === true) return
  if (process.env.STELE_STOP_HOOK !== "1") return
  const apiKey = process.env.STELE_API_KEY
  if (!apiKey) return

  const directory = sessionStateDirectory(process.env)
  const stateFile = sessionStateFile(directory, input.session_id)
  if (!stateFile) return
  const state = await readSessionState(stateFile)
  if (!state || state.entries.length === 0) return

  const config = loadPollingConfig(process.env)
  if (!config) return
  await waitForApproval(apiKey, stateFile, state, config)
}

async function runFailOpen() {
  try {
    await runHook()
  } catch {
    return
  }
}

await runFailOpen()

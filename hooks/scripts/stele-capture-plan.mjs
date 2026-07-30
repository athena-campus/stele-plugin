#!/usr/bin/env node

import {
  readSessionState,
  sessionStateDirectory,
  sessionStateFile,
  writeSessionState,
} from "./stele-session-state.mjs"

const CREATE_PLAN_TOOL = /^mcp__.+__create_plan$/
const ENTRY_MAX_AGE_MS = 48 * 60 * 60 * 1000

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

function parseToolResponse(toolResponse) {
  if (!Array.isArray(toolResponse?.content)) return null
  for (const item of toolResponse.content) {
    if (item?.type !== "text" || typeof item.text !== "string") continue
    try {
      const parsed = JSON.parse(item.text)
      if (parsed && typeof parsed === "object") return parsed
    } catch {
      continue
    }
  }
  return null
}

function captureCandidate(input) {
  if (!CREATE_PLAN_TOOL.test(input?.tool_name)) return null
  const response = parseToolResponse(input.tool_response)
  if (!response) return null

  const nestedPlan =
    response.plan && typeof response.plan === "object" ? response.plan : null
  const planId =
    typeof nestedPlan?.id === "string"
      ? nestedPlan.id
      : typeof response.id === "string"
        ? response.id
        : null
  if (!planId) return null

  const workspace = input.tool_input?.workspace
  let planTitle = ""
  if (typeof nestedPlan?.title === "string") {
    planTitle = nestedPlan.title
  } else if (typeof response.title === "string") {
    planTitle = response.title
  } else if (typeof input.tool_input?.title === "string") {
    planTitle = input.tool_input.title
  }
  return {
    sessionId: typeof input.session_id === "string" ? input.session_id : null,
    entry: {
      planId,
      planTitle,
      createdAt: new Date().toISOString(),
      ...(typeof workspace === "string" ? { workspaceSlug: workspace } : {}),
    },
  }
}

async function capturePlan() {
  const input = await readHookInput()
  const candidate = captureCandidate(input)
  if (!candidate?.sessionId) return

  const directory = sessionStateDirectory(process.env)
  const file = sessionStateFile(directory, candidate.sessionId)
  if (!file) return

  const current = (await readSessionState(file)) ?? { version: 1, entries: [] }
  const cutoff = Date.now() - ENTRY_MAX_AGE_MS
  const entries = current.entries.filter((entry) => Date.parse(entry.createdAt) >= cutoff)
  if (!entries.some((entry) => entry.planId === candidate.entry.planId)) {
    entries.push(candidate.entry)
  }
  await writeSessionState(file, { version: 1, entries }, [process.env.STELE_API_KEY])
}

async function runFailOpen() {
  try {
    await capturePlan()
  } catch {
    return
  }
}

await runFailOpen()

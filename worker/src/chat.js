/**
 * LLM proxy
 * ---------
 * Frontend JS calls this Worker (never the LLM provider directly).
 * The Worker holds the API keys as Cloudflare secrets and picks the
 * model/provider based on the request body, so the frontend can switch
 * between Claude, OpenAI, etc. without ever seeing a key.
 *
 * POST /api/chat
 * Body: {
 *   provider: "anthropic" | "openai",
 *   model?: string,              // optional override, e.g. "claude-sonnet-4-6"
 *   messages: [{ role: "user" | "assistant", content: string }]
 * }
 */

import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { configuredValue, json } from "./http.js";

// Provider id -> the env binding that holds its secret. Only providers this
// Worker actually proxies (see getModel() below) belong here — the "keys"
// widget supports many more provider ids than this Worker implements.
const PROVIDER_ENV_VARS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

export function getConfiguredProviders(env) {
  return Object.entries(PROVIDER_ENV_VARS)
    .filter(([, envVar]) => configuredValue(env, envVar))
    .map(([providerId]) => providerId);
}

function toLangChainMessages(messages) {
  return messages.map((m) =>
    m.role === "assistant" ? new AIMessage(m.content) : new HumanMessage(m.content)
  );
}

function getModel(env, provider, modelOverride) {
  switch (provider) {
    case "openai":
      if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured");
      return new ChatOpenAI({
        apiKey: env.OPENAI_API_KEY,
        model: modelOverride || "gpt-4o-mini",
      });
    case "anthropic":
    default:
      if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");
      return new ChatAnthropic({
        apiKey: env.ANTHROPIC_API_KEY,
        model: modelOverride || "claude-sonnet-4-6",
      });
  }
}

export async function handleChat(request, env) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const { provider = "anthropic", model, messages } = await request.json();

    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: "messages[] is required" }, 400);
    }

    const chatModel = getModel(env, provider, model);
    const response = await chatModel.invoke(toLangChainMessages(messages));
    return json({ provider, content: response.content });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

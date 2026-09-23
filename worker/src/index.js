/**
 * Cloudflare Worker: LangChain LLM proxy
 * ---------------------------------------
 * Frontend JS calls this Worker (never the LLM provider directly).
 * The Worker holds the API keys as Cloudflare secrets and picks the
 * model/provider based on the request body, so the frontend can switch
 * between Claude, OpenAI, etc. without ever seeing a key.
 *
 * Endpoint: POST /api/chat
 * Body: {
 *   provider: "anthropic" | "openai",
 *   model?: string,              // optional override, e.g. "claude-sonnet-4-6"
 *   messages: [{ role: "user" | "assistant", content: string }]
 * }
 *
 * Endpoint: GET /api/key-status
 * Returns which of the provider keys this Worker manages are configured as
 * Cloudflare secrets, e.g. ["anthropic","openai"] — never the key values
 * themselves. Lets a frontend (e.g. the "keys" widget) show "server has a
 * key configured" badges without reading a local env file.
 */

import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage } from "@langchain/core/messages";

// Restrict which origins may call this Worker.
const ALLOWED_ORIGINS = [
  "https://model.earth",
  "https://dreamstudio.com",
  "http://localhost:8887", // adjust to your local dev port
];

function corsHeaders(origin) {
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// Provider id -> the env binding that holds its secret. Only providers this
// Worker actually proxies (see getModel() below) belong here — the "keys"
// widget supports many more provider ids than this Worker implements.
const PROVIDER_ENV_VARS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

function getConfiguredProviders(env) {
  return Object.entries(PROVIDER_ENV_VARS)
    .filter(([, envVar]) => !!(env[envVar] && env[envVar].trim().length > 0))
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/key-status" && request.method === "GET") {
      return new Response(JSON.stringify(getConfiguredProviders(env)), {
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders(origin) });
    }

    try {
      const { provider = "anthropic", model, messages } = await request.json();

      if (!Array.isArray(messages) || messages.length === 0) {
        return new Response(JSON.stringify({ error: "messages[] is required" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        });
      }

      const chatModel = getModel(env, provider, model);
      const response = await chatModel.invoke(toLangChainMessages(messages));

      return new Response(
        JSON.stringify({ provider, content: response.content }),
        { headers: { "Content-Type": "application/json", ...corsHeaders(origin) } }
      );
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }
  },
};

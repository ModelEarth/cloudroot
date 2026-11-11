// Example frontend call — no API keys here, ever. Pages on
// cloud.model.earth call /api/chat on their own origin; from another site use
// https://cloud.model.earth/api/chat (that origin must be in ALLOWED_ORIGINS).
// Swap `provider` to "openai" or "anthropic" per request.
// The keys are the site's own, so each request needs the team's passphrase
// (TEAM_PASSPHRASE). Once it's entered, by the voice widget (engine/claude-voice.js)
// or with rememberPassphrase() below, a cookie that page scripts can't read stands
// in for it, so it's never kept in the browser.

async function rememberPassphrase(passphrase) {
  const res = await fetch("/api/team-passphrase", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passphrase }),
  });
  return res.status === 204;
}

async function askLLM(userText, provider = "anthropic") {
  const res = await fetch("/api/chat", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider,
      messages: [{ role: "user", content: userText }],
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Request failed");
  }

  const data = await res.json();
  return data.content;
}

// Usage:
// const reply = await askLLM("Summarize this trade dataset...", "anthropic");

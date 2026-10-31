// Example frontend call — no API keys here, ever. Pages on
// cloud.model.earth call /api/chat on their own origin; from another site use
// https://cloud.model.earth/api/chat (that origin must be in ALLOWED_ORIGINS).
// Swap `provider` to "openai" or "anthropic" per request.
// The keys are the site's own, so each request carries the team's passphrase
// (TEAM_PASSPHRASE), kept in localStorage as "team-passphrase" once entered
// (the voice widget, engine/claude-voice.js, saves it there too).

async function askLLM(userText, provider = "anthropic") {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Team-Passphrase": localStorage.getItem("team-passphrase") || "" },
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

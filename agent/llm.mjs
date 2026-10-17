// Minimal client for a local OpenAI-compatible chat server (Ollama by default).
// No network calls happen at import time. Failures throw, and callers must fail closed.

export const LLM_DEFAULTS = Object.freeze({
  baseUrl: "http://localhost:11434/v1",
  model: "llama3.2:3b", // ~3B parameters. Check the size on your machine with `ollama list`.
  timeoutMs: 20000,
});

export function createLlmClient({
  baseUrl = LLM_DEFAULTS.baseUrl,
  model = LLM_DEFAULTS.model,
  timeoutMs = LLM_DEFAULTS.timeoutMs,
  fetchImpl = globalThis.fetch,
} = {}) {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  return {
    model,
    async chatJson(messages) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages,
            stream: false,
            temperature: 0,
            response_format: { type: "json_object" },
          }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
        const body = await res.json();
        const content = body?.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new Error("LLM returned no content");
        return JSON.parse(content);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

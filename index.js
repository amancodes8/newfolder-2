// ------------------------------
// index.js — GEMINI + TTS with LLM Config + Server-side SSE logging
// ------------------------------

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");

const app = express();

app.use(
  cors({
    origin: "*",
    methods: "*",
    allowedHeaders: "*",
  })
);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 8000;

/**
 * Helper: streamAndLogSSE
 * - Opens a streaming GET to `url` (SSE / event stream)
 * - Parses SSE 'data:' events and logs them to console with optional `note`
 * - Tries a simple reconnect on error with limited attempts
 */
async function streamAndLogSSE(url, note = "agent-stream") {
  if (!url) return;
  let attempt = 0;
  const maxAttempts = 5;
  const baseDelayMs = 1000;

  async function connectOnce() {
    attempt++;
    console.log(`[sse] Connecting to ${note}: ${url} (attempt ${attempt})`);
    let resp;
    try {
      resp = await axios.get(url, {
        responseType: "stream",
        timeout: 0, // don't time out; let stream hang
        headers: {
          // Some SSE endpoints expect no extra headers; add Accept for clarity
          Accept: "text/event-stream, application/json",
        },
        validateStatus: null,
      });
    } catch (err) {
      console.error(`[sse] Network error connecting to stream (${note}):`, err.message);
      if (attempt < maxAttempts) {
        const wait = baseDelayMs * attempt;
        console.log(`[sse] Retrying in ${wait} ms...`);
        await new Promise(r => setTimeout(r, wait));
        return connectOnce();
      } else {
        console.error(`[sse] Max attempts reached. Giving up on ${note}.`);
        return;
      }
    }

    if (!resp || !resp.data || typeof resp.data.on !== "function") {
      console.error(`[sse] Unexpected stream response for ${note}. Status: ${resp?.status}`);
      return;
    }

    console.log(`[sse] Connected. Status: ${resp.status} — streaming ${note}...`);

    // SSE parsing: accumulate chunks and split events by "\n\n"
    let buffer = "";
    const stream = resp.data;

    stream.on("data", chunk => {
      try {
        buffer += chunk.toString("utf8");
        // Process complete events separated by double newlines
        let parts = buffer.split("\n\n");
        // Keep the last partial part in buffer
        buffer = parts.pop();
        for (const part of parts) {
          // part contains lines like "event: something\nid: 1\ndata: {...}\n"
          const lines = part.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
          let eventName = null;
          let dataLines = [];
          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventName = line.replace(/^event:\s*/, "");
            } else if (line.startsWith("data:")) {
              dataLines.push(line.replace(/^data:\s*/, ""));
            } // ignore other SSE fields (id, retry, etc)
          }
          const dataStr = dataLines.join("\n");
          let parsed = dataStr;
          try {
            parsed = JSON.parse(dataStr);
          } catch (e) {
            // keep raw string if not JSON
          }
          // Log timestamped info
          console.log(`[sse][${note}] event=${eventName || "message"} payload=`);
          console.log(parsed);
        }
      } catch (err) {
        console.error(`[sse] Error parsing chunk for ${note}:`, err);
      }
    });

    stream.on("end", () => {
      console.warn(`[sse] Stream ended for ${note}`);
      // attempt reconnect
      if (attempt < maxAttempts) {
        const wait = baseDelayMs * attempt;
        console.log(`[sse] Reconnecting to ${note} in ${wait} ms...`);
        setTimeout(connectOnce, wait);
      } else {
        console.error(`[sse] Not reconnecting (max attempts reached) for ${note}`);
      }
    });

    stream.on("error", err => {
      console.error(`[sse] Stream error for ${note}:`, err?.message || err);
      // axios stream errors may also trigger 'end'; schedule reconnect
      if (attempt < maxAttempts) {
        const wait = baseDelayMs * attempt;
        console.log(`[sse] Reconnecting to ${note} in ${wait} ms...`);
        setTimeout(connectOnce, wait);
      } else {
        console.error(`[sse] Not reconnecting (max attempts reached) for ${note}`);
      }
    });

    // optional: handle close from response (some libs emit 'close')
    stream.on("close", () => {
      console.warn(`[sse] Stream closed for ${note}`);
    });
  }

  // start first connection attempt
  connectOnce().catch(err => {
    console.error(`[sse] Unexpected error while connecting to ${note}:`, err);
  });
}

app.get("/health", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.post("/api/agent/join", async (req, res) => {
  try {
    const { channel = "", name = `web-${Date.now()}` } = req.body || {};
    if (!channel)
      return res.status(400).json({ error: "channel is required" });

    const CUSTOMER_KEY = process.env.AGORA_CUSTOMER_KEY;
    const CUSTOMER_SECRET = process.env.AGORA_CUSTOMER_SECRET;
    const AGORA_APP_ID = process.env.AGORA_APP_ID;

    if (!CUSTOMER_KEY || !CUSTOMER_SECRET || !AGORA_APP_ID) {
      return res.json({
        ok: true,
        source: "mock",
        data: {
          appid: "MOCK_APPID",
          channel,
          agent_rtc_uid: "1001",
          token: null,
          message: "Mock mode active (no Agora keys in .env)",
        },
      });
    }

    // -------------------------------------------
    // LLM (GEMINI) CONFIG
    // -------------------------------------------
    if (!process.env.LLM_PROVIDER_URL) {
      console.error("[server] ERROR: LLM_PROVIDER_URL is missing in .env file.");
      return res.status(500).json({
        error: "server_config_error",
        detail: "LLM_PROVIDER_URL is missing. It is required for Gemini.",
      });
    }

    const llmConfig = {
      url: process.env.LLM_PROVIDER_URL,
      api_key: process.env.LLM_API_KEY,
      model: process.env.LLM_MODEL || "gemini-1.5-flash-latest",
      system_messages: [{
        role: "system",
        content: process.env.LLM_SYSTEM_MESSAGE ||
          "You are a compassionate, empathetic therapy agent who helps users talk through their feelings."
      }]
    };

    const agentUid = String(Math.floor(Math.random() * 1000000) + 1000);

    const payload = {
      name,
      properties: {
        channel,
        token: null, // Set to null if not using tokens, or generate one
        agent_rtc_uid: agentUid,
        remote_rtc_uids: ["*"], // Subscribe to all users in the channel
        idle_timeout: 120,
        advanced_features: { enable_aivad: true },
        turn_detection: { enabled: true, end_of_turn_threshold_ms: 700 },
        llm: llmConfig,
        // TTS block will be added dynamically below
      },
    };

    // -------------------------------------------
    // DYNAMIC TTS BLOCK (Required for audio output)
    // -------------------------------------------
    const ttsKey = process.env.TTS_KEY;
    const ttsVendor = (process.env.TTS_VENDOR || "microsoft").toLowerCase();

    if (ttsKey) {
      payload.properties.tts = { vendor: ttsVendor };

      if (ttsVendor === "openai") {
        // OpenAI TTS settings
        payload.properties.tts.params = {
          key: ttsKey,
          model: process.env.TTS_MODEL || "tts-1",
          voice: process.env.TTS_VOICE || "alloy",
        };
      } else {
        // Microsoft Azure TTS settings
        payload.properties.tts.params = {
          key: ttsKey,
          region: process.env.TTS_REGION || "eastus",
          voice_name: process.env.TTS_VOICE || "en-US-AndrewMultilingualNeural",
        };
      }
    } else {
      console.error("[server] ERROR: TTS_KEY is missing in .env.");
      return res.status(500).json({
        error: "server_config_error",
        detail: "TTS_KEY is missing. It is required when using a text-only LLM like Gemini for audio output.",
      });
    }

    // -------------------------------------------
    // DEBUG LOG
    // -------------------------------------------
    console.log("\n[server] DEBUG: LLM CONFIG VERSION\n");
    const printPayload = JSON.stringify(
      payload,
      (k, v) => (k && /key|secret|token|api/i.test(k) ? "[REDACTED]" : v),
      2
    );
    console.log("\n[server] SENDING PAYLOAD TO AGORA:\n", printPayload);

    // -------------------------------------------
    // SEND JOIN REQUEST TO AGORA
    // -------------------------------------------
    const auth = Buffer.from(
      `${CUSTOMER_KEY}:${CUSTOMER_SECRET}`
    ).toString("base64");
    const url = `https://api.agora.io/api/conversational-ai-agent/v2/projects/${AGORA_APP_ID}/join`;

    let r;
    try {
      r = await axios.post(url, payload, {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
        validateStatus: null,
      });
    } catch (networkErr) {
      console.error("[server] AXIOS NETWORK ERROR:", networkErr.message);
      return res.status(502).json({
        error: "upstream_network_error",
        detail: networkErr.message,
      });
    }

    console.log("[server] Agora response status:", r.status);
    console.log("[server] Agora response headers:", JSON.stringify(r.headers || {}));
    const rawBody =
      typeof r.data === "string"
        ? r.data
        : JSON.stringify(r.data, null, 2);
    console.log(
      "[server] Agora response body:\n",
      rawBody.slice(0, 8000)
    );

    // If Agora returned stream / sse URL(s), start logging them to console
    try {
      const responseData = r && r.data ? r.data : null;

      // common fields: stream_url, sse_url, websocket_url, ai_stream, etc.
      const possibleStreamUrls = [];
      if (responseData) {
        // responseData might be object or string
        if (typeof responseData === "object") {
          // check top-level well-known keys
          ["sse_url", "stream_url", "ai_stream", "stream", "sse"].forEach(k => {
            if (responseData[k]) possibleStreamUrls.push({ url: responseData[k], note: k });
          });

          // sometimes Agora nests stream URL inside properties or data
          if (responseData.properties && responseData.properties.stream_url) {
            possibleStreamUrls.push({ url: responseData.properties.stream_url, note: "properties.stream_url" });
          }
        }
      }

      // Filter unique valid URLs (string)
      const uniqueUrls = [];
      for (const o of possibleStreamUrls) {
        if (!o || !o.url) continue;
        const u = String(o.url);
        if (!uniqueUrls.some(x => x.url === u)) uniqueUrls.push({ url: u, note: o.note || "agent-stream" });
      }

      // Start streaming logging for each discovered stream URL
      for (const item of uniqueUrls) {
        // Start the async logger (fire-and-forget)
        streamAndLogSSE(item.url, item.note);
      }
    } catch (e) {
      console.error("[server] Failed to inspect/start agent streams:", e);
    }

    if (r.status >= 200 && r.status < 300) {
      return res.json({
        ok: true,
        source: "agora",
        status: r.status,
        data: r.data,
      });
    }

    return res.status(502).json({
      error: "agora_join_failed",
      status: r.status,
      headers: r.headers,
      body: r.data,
    });
  } catch (err) {
    console.error("[server] INTERNAL SERVER ERROR:", err);
    return res.status(500).json({
      error: "server_error",
      detail: err.message || "unknown",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

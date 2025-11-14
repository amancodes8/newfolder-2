// index.js — Agora Conversational AI join (fixed: action:start + rtc/media) + SSE proxy/logger
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");
const { URL } = require("url");

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

/* ---------- Utilities ---------- */
function redact(obj) {
  try {
    return JSON.parse(
      JSON.stringify(obj, (k, v) => {
        if (!k) return v;
        if (/key|secret|token|password|api/i.test(k)) return "[REDACTED]";
        return v;
      })
    );
  } catch (e) {
    return obj;
  }
}

/* ---------- SSE streamer/logger (server-side) ---------- */
async function streamAndLogSSE(url, note = "agent-stream") {
  if (!url) return;
  let attempt = 0;
  const maxAttempts = 6;
  const baseDelayMs = 1000;

  async function connectOnce() {
    attempt++;
    console.log(`[sse] (${note}) connecting to: ${url} (attempt ${attempt})`);
    let resp;
    try {
      resp = await axios.get(url, {
        responseType: "stream",
        timeout: 0,
        headers: { Accept: "text/event-stream, application/json" },
        validateStatus: null,
      });
    } catch (err) {
      console.error(`[sse] (${note}) connect error:`, err?.message || err);
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, baseDelayMs * attempt));
        return connectOnce();
      }
      return;
    }

    if (!resp || !resp.data || typeof resp.data.on !== "function") {
      console.error(`[sse] (${note}) unexpected response when opening stream — status: ${resp?.status}`);
      return;
    }

    console.log(`[sse] (${note}) connected. status=${resp.status}`);
    const stream = resp.data;
    let buffer = "";

    stream.on("data", (chunk) => {
      try {
        buffer += chunk.toString("utf8");
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop();
        for (const part of parts) {
          const lines = part.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          let eventName = null;
          const dataLines = [];
          for (const line of lines) {
            if (line.startsWith("event:")) eventName = line.replace(/^event:\s*/, "");
            else if (line.startsWith("data:")) dataLines.push(line.replace(/^data:\s*/, ""));
          }
          const dataStr = dataLines.join("\n");
          let parsed = dataStr;
          try { parsed = JSON.parse(dataStr); } catch (e) {}
          console.log(`[sse][${note}] event=${eventName || "message"} payload:`, parsed);
        }
      } catch (err) {
        console.error(`[sse][${note}] parse error:`, err);
      }
    });

    stream.on("end", () => {
      console.warn(`[sse] (${note}) upstream ended`);
      if (attempt < maxAttempts) setTimeout(connectOnce, baseDelayMs * attempt);
    });

    stream.on("error", (err) => {
      console.error(`[sse] (${note}) stream error:`, err?.message || err);
      if (attempt < maxAttempts) setTimeout(connectOnce, baseDelayMs * attempt);
    });

    stream.on("close", () => console.warn(`[sse] (${note}) stream closed`));
  }

  connectOnce().catch((e) => console.error(`[sse] (${note}) unexpected connect error:`, e));
}

/* ---------- SSE proxy endpoint (client -> server -> upstream SSE) ---------- */
app.get("/api/agent/stream-proxy", async (req, res) => {
  const { src } = req.query;
  if (!src) return res.status(400).send("missing src (base64 upstream url)");

  let upstream;
  try {
    upstream = Buffer.from(src, "base64").toString("utf8");
    const u = new URL(upstream);
    if (!["https:"].includes(u.protocol)) return res.status(400).send("only https upstream allowed");
  } catch (e) {
    return res.status(400).send("invalid src");
  }

  console.log("[proxy] proxying upstream SSE:", upstream);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Add Authorization header here if upstream requires it (uncomment and set token)
  const upstreamHeaders = {
    Accept: "text/event-stream, application/json",
    // Authorization: `Bearer ${SOME_TOKEN}`,
  };

  try {
    const resp = await axios.get(upstream, {
      responseType: "stream",
      headers: upstreamHeaders,
      timeout: 0,
      validateStatus: null,
    });

    if (resp.status >= 400) {
      console.error("[proxy] upstream returned error status:", resp.status);
      res.write(`event: error\ndata: ${JSON.stringify({ status: resp.status, message: "upstream error" })}\n\n`);
      return res.end();
    }

    const stream = resp.data;
    stream.on("data", (chunk) => {
      try { res.write(chunk); } catch (e) { console.error("[proxy] write chunk failed:", e?.message || e); }
    });

    stream.on("end", () => {
      console.log("[proxy] upstream ended, closing proxy");
      try { res.end(); } catch (_) {}
    });

    stream.on("error", (err) => {
      console.error("[proxy] upstream stream error:", err?.message || err);
      try { res.end(); } catch (_) {}
    });

    req.on("close", () => {
      try { if (stream.destroy) stream.destroy(); } catch (_) {}
    });
  } catch (err) {
    console.error("[proxy] failed to open upstream:", err?.message || err);
    try { res.write(`event: error\ndata: ${JSON.stringify({ error: err?.message || "failed" })}\n\n`); } catch (_) {}
    res.end();
  }
});

/* ---------- health ---------- */
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

/* ---------- main join endpoint (FIXED: includes action:start + rtc/media) ---------- */
app.post("/api/agent/join", async (req, res) => {
  try {
    const { channel = "", name = `web-${Date.now()}` } = req.body || {};
    if (!channel) return res.status(400).json({ error: "channel is required" });

    const CUSTOMER_KEY = process.env.AGORA_CUSTOMER_KEY;
    const CUSTOMER_SECRET = process.env.AGORA_CUSTOMER_SECRET;
    const AGORA_APP_ID = process.env.AGORA_APP_ID;

    if (!CUSTOMER_KEY || !CUSTOMER_SECRET || !AGORA_APP_ID) {
      console.warn("[server] Missing Agora keys/app id — returning mock response.");
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

    // Validate LLM provider and TTS
    if (!process.env.LLM_PROVIDER_URL) {
      console.error("[server] ERROR: LLM_PROVIDER_URL missing in .env");
      return res.status(500).json({ error: "server_config_error", detail: "LLM_PROVIDER_URL missing" });
    }
    if (!process.env.TTS_KEY) {
      console.error("[server] ERROR: TTS_KEY missing in .env");
      return res.status(500).json({ error: "server_config_error", detail: "TTS_KEY missing" });
    }

    // HeyGen (avatar) envs
    const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
    const HEYGEN_AVATAR_ID = process.env.HEYGEN_AVATAR_ID; // optional
    const HEYGEN_QUALITY = process.env.HEYGEN_QUALITY || "medium"; // low/medium/high
    const HEYGEN_STYLE = process.env.HEYGEN_STYLE || "default";

    if (HEYGEN_API_KEY) {
      console.log("[server] HeyGen avatar enabled (HEYGEN_API_KEY present). AvatarId=" + (HEYGEN_AVATAR_ID ? HEYGEN_AVATAR_ID : "<not set>"));
    }

    // Build llm config
    const llmConfig = {
      url: process.env.LLM_PROVIDER_URL,
      api_key: process.env.LLM_API_KEY,
      model: process.env.LLM_MODEL || "gemini-1.5-flash-latest",
      system_messages: [
        {
          role: "system",
          content:
            process.env.LLM_SYSTEM_MESSAGE ||
            "You are a helpful, empathetic assistant. Keep answers short if user asks for brevity.",
        },
      ],
    };

    const agentUid = String(Math.floor(Math.random() * 1000000) + 1000);

    // Dynamic TTS config
    const ttsKey = process.env.TTS_KEY;
    const ttsVendor = (process.env.TTS_VENDOR || "microsoft").toLowerCase();
    let ttsParams = {};
    if (ttsVendor === "openai") {
      ttsParams = {
        key: ttsKey,
        model: process.env.TTS_MODEL || "tts-1",
        voice: process.env.TTS_VOICE || "alloy",
      };
    } else {
      ttsParams = {
        key: ttsKey,
        region: process.env.TTS_REGION || "eastus",
        voice_name: process.env.TTS_VOICE || "en-US-ChristopherNeural",
      };
    }

    // If HeyGen avatar is enabled, ensure the required sample rate for HeyGen lip-sync
    if (HEYGEN_API_KEY) {
      // HeyGen requires 24kHz audio sample rate for proper lip-sync
      ttsParams.sample_rate = 24000;
    }

    /* ----------- CRITICAL: include action:"start" and request RTC/Media/TTS ----------- */
    const payload = {
      action: "start", // <<< IMPORTANT: ensures Agora returns join details (appid, token, stream urls)
      name,
      properties: {
        channel,
        agent_rtc_uid: agentUid,
        remote_rtc_uids: ["*"],
        idle_timeout: 120,
        advanced_features: { enable_aivad: true },
        turn_detection: { enabled: true, end_of_turn_threshold_ms: 700 },

        // Request RTC and TTS media in join — required for agent audio/video output
        rtc: { enable: true },
        media: { enable_rtc: true, enable_tts: true },

        // LLM and TTS blocks
        llm: llmConfig,
        tts: {
          vendor: ttsVendor,
          params: ttsParams,
        },
      },
    };

    // If HeyGen API key is provided, attach avatar config to the payload
    if (HEYGEN_API_KEY) {
      payload.properties.avatar = {
        vendor: "heygen",
        config: {
          apiKey: HEYGEN_API_KEY,
          // avatarId is optional — HeyGen account must have a chosen avatar or template
          avatarId: HEYGEN_AVATAR_ID || undefined,
          quality: HEYGEN_QUALITY, // low / medium / high
          style: HEYGEN_STYLE,
        },
      };

      // Ensure advanced feature flag for avatar is present
      payload.properties.advanced_features = payload.properties.advanced_features || {};
      payload.properties.advanced_features.enable_aivad = true;

      // Make a best-effort addition: add hint to properties about required sample rate
      payload.properties.hints = payload.properties.hints || {};
      payload.properties.hints.required_audio_sample_rate = 24000;
    }

    // Debug print (redacted)
    console.log("\n[server] Prepared join payload (redacted):");
    try { console.log(JSON.stringify(redact(payload), null, 2)); } catch (e) { console.log(redact(payload)); }

    // Send join request to Agora Conversational AI join endpoint
    const auth = Buffer.from(`${CUSTOMER_KEY}:${CUSTOMER_SECRET}`).toString("base64");
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
      console.error("[server] AXIOS NETWORK ERROR:", networkErr?.message || networkErr);
      return res.status(502).json({ error: "upstream_network_error", detail: networkErr?.message || String(networkErr) });
    }

    console.log("[server] Agora response status:", r.status);
    console.log("[server] Agora response headers (redacted):", JSON.stringify(redact(r.headers || {})));
    const rawBody = typeof r.data === "string" ? r.data : JSON.stringify(r.data, null, 2);
    console.log("[server] Agora response body (truncated):", (rawBody || "").slice(0, 8000));

    // If response contains stream urls, start server-side logging
    try {
      const responseData = r && r.data ? r.data : null;
      const possibleStreamUrls = [];

      if (responseData && typeof responseData === "object") {
        ["sse_url", "stream_url", "ai_stream", "stream", "sse", "websocket_url", "wss"].forEach((k) => {
          if (responseData[k]) possibleStreamUrls.push({ url: responseData[k], note: k });
        });
        if (responseData.properties && responseData.properties.stream_url) {
          possibleStreamUrls.push({ url: responseData.properties.stream_url, note: "properties.stream_url" });
        }
        if (responseData.data && responseData.data.sse_url) {
          possibleStreamUrls.push({ url: responseData.data.sse_url, note: "data.sse_url" });
        }
      }

      const unique = [];
      for (const o of possibleStreamUrls) {
        if (!o || !o.url) continue;
        const u = String(o.url);
        if (!unique.some((x) => x.url === u)) unique.push({ url: u, note: o.note || "agent-stream" });
      }

      for (const item of unique) {
        streamAndLogSSE(item.url, item.note);
      }
    } catch (e) {
      console.error("[server] Failed to inspect/start agent streams:", e?.message || e);
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
    console.error("[server] INTERNAL SERVER ERROR:", err?.stack || err?.message || err);
    return res.status(500).json({ error: "server_error", detail: err?.message || "unknown" });
  }
});

/* ---------- optional client log endpoint ---------- */
app.post("/api/client/log", (req, res) => {
  try {
    console.log("[client-log]", JSON.stringify(req.body, null, 2));
  } catch (e) {
    console.log("[client-log] (unserializable)");
  }
  res.json({ ok: true });
});

/* ---------- start server ---------- */
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT} (pid ${process.pid})`);
});
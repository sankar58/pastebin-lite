import express from "express";
import { nanoid } from "nanoid";
import { kv } from "@vercel/kv";

const app = express();
const PORT = process.env.PORT || 3000;

/* =======================
   Middleware
======================= */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =======================
   Utility: deterministic time
======================= */
function now(req) {
  if (process.env.TEST_MODE === "1" && req.headers["x-test-now-ms"]) {
    return Number(req.headers["x-test-now-ms"]);
  }
  return Date.now();
}

/* =======================
   HOME PAGE
======================= */
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`
    <html>
      <head><title>Pastebin Lite</title></head>
      <body>
        <h2>Create Paste</h2>
        <form method="POST" action="/create">
          <textarea name="content" rows="10" cols="60" required></textarea><br/><br/>
          TTL (seconds): <input type="number" name="ttl_seconds"/><br/><br/>
          Max Views: <input type="number" name="max_views"/><br/><br/>
          <button type="submit">Create Paste</button>
        </form>
      </body>
    </html>
  `);
});

/* =======================
   HEALTH CHECK
======================= */
app.get("/api/healthz", async (req, res) => {
  try {
    await kv.ping();
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

/* =======================
   CREATE PASTE (API)
======================= */
app.post("/api/pastes", async (req, res) => {
  const { content, ttl_seconds, max_views } = req.body;

  if (!content || typeof content !== "string" || content.trim() === "") {
    return res.status(400).json({ error: "Invalid content" });
  }
  if (ttl_seconds !== undefined && (!Number.isInteger(ttl_seconds) || ttl_seconds < 1)) {
    return res.status(400).json({ error: "Invalid ttl_seconds" });
  }
  if (max_views !== undefined && (!Number.isInteger(max_views) || max_views < 1)) {
    return res.status(400).json({ error: "Invalid max_views" });
  }

  const id = nanoid(8);
  const createdAt = now(req);

  const paste = {
    content,
    createdAt,
    ttl_seconds: ttl_seconds ?? null,
    max_views: max_views ?? null,
    views: 0
  };

  await kv.set(`paste:${id}`, paste);

  res.status(201).json({
    id,
    url: `${req.protocol}://${req.get("host")}/p/${id}`
  });
});

/* =======================
   CREATE PASTE (FORM) — FIXED
======================= */
app.post("/create", async (req, res) => {
  try {
    const response = await fetch(`${req.protocol}://${req.get("host")}/api/pastes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: req.body.content,
        ttl_seconds: req.body.ttl_seconds ? Number(req.body.ttl_seconds) : undefined,
        max_views: req.body.max_views ? Number(req.body.max_views) : undefined
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(400).send(`
        <h3>Error creating paste</h3>
        <pre>${errorText}</pre>
        <a href="/">Go back</a>
      `);
    }

    const data = await response.json();
    res.redirect(data.url);
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

/* =======================
   FETCH PASTE (API)
======================= */
app.get("/api/pastes/:id", async (req, res) => {
  const key = `paste:${req.params.id}`;
  const paste = await kv.get(key);
  if (!paste) return res.status(404).json({ error: "Not found" });

  const currentTime = now(req);

  if (paste.ttl_seconds) {
    const expiresAt = paste.createdAt + paste.ttl_seconds * 1000;
    if (currentTime >= expiresAt) {
      await kv.del(key);
      return res.status(404).json({ error: "Expired" });
    }
  }

  if (paste.max_views !== null && paste.views >= paste.max_views) {
    return res.status(404).json({ error: "View limit exceeded" });
  }

  paste.views += 1;
  await kv.set(key, paste);

  res.json({
    content: paste.content,
    remaining_views:
      paste.max_views === null ? null : Math.max(0, paste.max_views - paste.views),
    expires_at:
      paste.ttl_seconds === null
        ? null
        : new Date(paste.createdAt + paste.ttl_seconds * 1000).toISOString()
  });
});

/* =======================
   VIEW PASTE (HTML)
======================= */
app.get("/p/:id", async (req, res) => {
  const key = `paste:${req.params.id}`;
  const paste = await kv.get(key);
  if (!paste) return res.status(404).send("Not Found");

  const currentTime = now(req);

  if (paste.ttl_seconds) {
    const expiresAt = paste.createdAt + paste.ttl_seconds * 1000;
    if (currentTime >= expiresAt) {
      await kv.del(key);
      return res.status(404).send("Expired");
    }
  }

  if (paste.max_views !== null && paste.views >= paste.max_views) {
    return res.status(404).send("View limit exceeded");
  }

  paste.views += 1;
  await kv.set(key, paste);

  res.setHeader("Content-Type", "text/html");
  res.send(`
    <html>
      <body>
        <pre>${paste.content.replace(/</g, "&lt;")}</pre>
      </body>
    </html>
  `);
});

/* =======================
   START SERVER
======================= */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

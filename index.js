import express from "express";
import { nanoid } from "nanoid";
import { kv } from "@vercel/kv";

const app = express();

app.use(express.static("public"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================
   Deterministic Time Helper
========================= */
function now(req) {
  if (process.env.TEST_MODE === "1" && req.headers["x-test-now-ms"]) {
    return Number(req.headers["x-test-now-ms"]);
  }
  return Date.now();
}

/* =========================
   HOME PAGE (UI)
========================= */
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Pastebin Lite</title>
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <div class="container">
          <h2>Create Paste</h2>
          <form method="POST" action="/create">
            <textarea name="content" rows="8" cols="50" required></textarea><br/><br/>
            TTL (seconds):
            <input type="number" name="ttl_seconds" /><br/><br/>
            Max Views:
            <input type="number" name="max_views" /><br/><br/>
            <button>Create</button>
          </form>
        </div>
      </body>
    </html>
  `);
});

/* =========================
   HEALTH CHECK
========================= */
app.get("/api/healthz", async (req, res) => {
  try {
    await kv.ping();
    res.status(200).json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

/* =========================
   SHARED CREATE LOGIC
========================= */
async function createPaste(data, req) {
  const { content, ttl_seconds, max_views } = data;

  if (!content || typeof content !== "string" || !content.trim()) {
    throw new Error("Invalid content");
  }
  if (
    ttl_seconds !== undefined &&
    (!Number.isInteger(ttl_seconds) || ttl_seconds < 1)
  ) {
    throw new Error("Invalid ttl_seconds");
  }
  if (
    max_views !== undefined &&
    (!Number.isInteger(max_views) || max_views < 1)
  ) {
    throw new Error("Invalid max_views");
  }

  const id = nanoid(8);

  await kv.set(`paste:${id}`, {
    content,
    createdAt: now(req),
    ttl_seconds: ttl_seconds ?? null,
    max_views: max_views ?? null,
    views: 0
  });

  return id;
}

/* =========================
   CREATE PASTE (API)
========================= */
app.post("/api/pastes", async (req, res) => {
  try {
    const id = await createPaste(req.body, req);
    res.status(201).json({
      id,
      url: `${req.protocol}://${req.get("host")}/p/${id}`
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* =========================
   GET /api/pastes (NOT SUPPORTED)
========================= */
app.get("/api/pastes", (req, res) => {
  res.status(405).json({
    error: "Method not allowed",
    message: "Use POST /api/pastes to create a paste"
  });
});

/* =========================
   CREATE PASTE (FORM)
========================= */
app.post("/create", async (req, res) => {
  try {
    const id = await createPaste(
      {
        content: req.body.content,
        ttl_seconds: req.body.ttl_seconds
          ? Number(req.body.ttl_seconds)
          : undefined,
        max_views: req.body.max_views
          ? Number(req.body.max_views)
          : undefined
      },
      req
    );
    res.redirect(`/p/${id}`);
  } catch (e) {
    res.status(400).send(`<pre>${e.message}</pre><a href="/">Go back</a>`);
  }
});

/* =========================
   FETCH PASTE (API)
========================= */
app.get("/api/pastes/:id", async (req, res) => {
  const key = `paste:${req.params.id}`;
  const paste = await kv.get(key);

  if (!paste) {
    return res.status(404).json({ error: "Not found" });
  }

  const currentTime = now(req);

  if (paste.ttl_seconds !== null) {
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

  res.status(200).json({
    content: paste.content,
    remaining_views:
      paste.max_views === null
        ? null
        : Math.max(0, paste.max_views - paste.views),
    expires_at:
      paste.ttl_seconds === null
        ? null
        : new Date(
            paste.createdAt + paste.ttl_seconds * 1000
          ).toISOString()
  });
});

/* =========================
   VIEW PASTE (HTML)
========================= */
app.get("/p/:id", async (req, res) => {
  const key = `paste:${req.params.id}`;
  const paste = await kv.get(key);

  if (!paste) {
    return res.status(404).send("Not found");
  }

  const currentTime = now(req);

  if (paste.ttl_seconds !== null) {
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

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>View Paste</title>
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <div class="container">
          <pre>${paste.content.replace(/</g, "&lt;")}</pre>
        </div>
      </body>
    </html>
  `);
});

/* =========================
   REQUIRED FOR VERCEL
========================= */
export default app;

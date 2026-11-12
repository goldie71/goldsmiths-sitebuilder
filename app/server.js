// Goldsmiths Site Builder - standalone server for the TerraMaster TOS 7 container
// Reads everything from the environment so the same image runs on any NAS:
//   PORT        web UI port (default 8090, matches the TOS package config)
//   DATA_DIR    persistent data root (default /data, mounted from the NAS)
//   OLLAMA_URL  base URL of the local model service (default http://ollama:11434)
//   MODEL       model tag to use (default qwen2.5-coder:7b)
//
// 1.0.1 added uploads: a + button for files and pictures, a 256x256 profile
// picture slot, and asset copying into each built site so pages reference
// their own images with relative paths.
// 1.0.2 adds domain ideas: type the brand name and it checks .com and .co.uk
// against the public registry (keyless) or GoDaddy when a key is supplied.
//
// If a gs_builder.js module is present it is loaded using the house pattern
// require("./gs_builder")(router, ctxGetter), so the estate copy can be dropped
// straight in. Without it the built-in minimal builder runs, which keeps the
// container installable and testable while the real module is being lifted.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");

const PORT = Number(process.env.PORT || 8090);
const MODEL = process.env.MODEL || "qwen2.5-coder:7b";
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://ollama:11434").replace(/\/+$/, "");
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 10) * 1024 * 1024;
// Domain checks run keyless by default (registry RDAP). If a GoDaddy key is
// present we also get prices, but the app never requires one, so it still works
// on a customer's NAS with no credentials anywhere.
const GD_KEY = process.env.GODADDY_KEY || "";
const GD_SECRET = process.env.GODADDY_SECRET || "";
// Selling domains: margin over registry cost, and Stripe for the money.
// Card details never touch the NAS - payment happens on Stripe's page.
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";
// overridable so the payment path can be tested without touching a live account
const STRIPE_API = (process.env.STRIPE_API_BASE || "https://api.stripe.com").replace(/\/+$/, "");
const DOMAIN_MARGIN = Number(process.env.DOMAIN_MARGIN_PCT || 40);
const SELL_CURRENCY = (process.env.DOMAIN_CURRENCY || "GBP").toUpperCase();
const FX = Number(process.env.DOMAIN_FX || 0.79); // GBP per USD, only used when converting
const SALES_EMAIL = process.env.SALES_EMAIL || "";
// Picture generation. Deliberately backend-agnostic: anything that speaks the
// OpenAI images API works (LocalAI, ComfyUI bridges, a hosted endpoint). With
// nothing configured the box says so honestly instead of pretending.
const IMAGE_API = (process.env.IMAGE_API_URL || "").replace(/\/+$/, "");
const IMAGE_MODEL = process.env.IMAGE_MODEL || "stablediffusion";
const IMAGE_API_KEY = process.env.IMAGE_API_KEY || "";
const IMAGE_SIZE = process.env.IMAGE_SIZE || "512x512";

// Data root: fall back to a writable temp dir rather than crash on a read-only mount
let DATA_DIR = process.env.DATA_DIR || "/data";
const WANTED_DATA_DIR = DATA_DIR;
let dataPersistent = true;
let dataWarning = null;
try {
  fs.mkdirSync(path.join(DATA_DIR, "sites"), { recursive: true });
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
} catch (err) {
  const fallback = path.join(require("os").tmpdir(), "sitebuilder-data");
  fs.mkdirSync(path.join(fallback, "sites"), { recursive: true });
  console.warn(`DATA_DIR ${DATA_DIR} not writable (${err.code}); using ${fallback} - data will not survive the container`);
  console.warn("If this is a compose install, the data mount is root-owned: start as root so the entrypoint can claim it.");
  dataWarning = `${WANTED_DATA_DIR} is not writable (${err.code}); running from ${fallback}, so data will not survive a restart`;
  dataPersistent = false;
  DATA_DIR = fallback;
}
const SITES_DIR = path.join(DATA_DIR, "sites");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const ORDERS_DIR = path.join(DATA_DIR, "orders");
fs.mkdirSync(ORDERS_DIR, { recursive: true });

const app = express();

// ---- uploads ------------------------------------------------------------
// Raw body uploads, no multipart parser and no dependencies. The browser sends
// the File object itself with the name in x-file-name, so this works for
// pictures and documents alike. Mounted above express.json() so nothing else
// consumes the body first.
const uploadRouter = express.Router();
uploadRouter.use(express.raw({ type: () => true, limit: MAX_UPLOAD }));

function safeSession(value) {
  const s = String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
  return s || "anon";
}

function safeFileName(raw) {
  let name = String(raw || "file");
  try {
    name = decodeURIComponent(name);
  } catch (e) {}
  name = path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+/, "");
  if (!name) name = "file";
  const ext = path.extname(name).toLowerCase();
  const base = path.basename(name, path.extname(name)).slice(0, 48) || "file";
  return base + ext;
}

function sessionPath(session) {
  const dir = path.join(UPLOAD_DIR, safeSession(session));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listUploads(session) {
  const dir = path.join(UPLOAD_DIR, safeSession(session));
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.endsWith(".meta.json"))
    .map((d) => {
      const full = path.join(dir, d.name);
      let kind = "asset";
      try {
        kind = JSON.parse(fs.readFileSync(full + ".meta.json", "utf8")).kind || "asset";
      } catch (e) {}
      return {
        name: d.name,
        kind,
        size: fs.statSync(full).size,
        url: `/uploads/${safeSession(session)}/${encodeURIComponent(d.name)}`,
      };
    });
}

uploadRouter.post("/", (req, res) => {
  const session = req.get("x-session");
  const kind = (req.get("x-kind") || "asset").toLowerCase() === "avatar" ? "avatar" : "asset";
  const body = req.body;
  const size = Buffer.isBuffer(body) ? body.length : 0;
  if (!size) return res.status(400).json({ error: "empty upload" });
  if (size > MAX_UPLOAD) return res.status(413).json({ error: `file is larger than ${MAX_UPLOAD / 1024 / 1024}MB` });

  const dir = sessionPath(session);
  let name = safeFileName(req.get("x-file-name") || "file");
  // avatars are a single slot: replace any previous one
  if (kind === "avatar") {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith("avatar-256")) {
        try {
          fs.unlinkSync(path.join(dir, f));
          fs.unlinkSync(path.join(dir, f + ".meta.json"));
        } catch (e) {}
      }
    }
    const ext = [".png", ".jpg", ".jpeg", ".webp"].includes(path.extname(name).toLowerCase())
      ? path.extname(name).toLowerCase()
      : ".png";
    name = "avatar-256" + ext;
  }
  const full = path.join(dir, name);
  fs.writeFileSync(full, body);
  fs.writeFileSync(
    full + ".meta.json",
    JSON.stringify({ kind, original: req.get("x-file-name") || name, size, uploadedAt: new Date().toISOString() }),
    "utf8"
  );
  res.status(201).json({ ok: true, name, kind, size, url: `/uploads/${safeSession(session)}/${encodeURIComponent(name)}` });
});

uploadRouter.get("/", (req, res) => res.json({ uploads: listUploads(req.query.session) }));

uploadRouter.delete("/", (req, res) => {
  const session = safeSession(req.query.session);
  const name = safeFileName(req.query.name);
  const full = path.join(UPLOAD_DIR, session, name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: "not found" });
  try {
    fs.unlinkSync(full);
    if (fs.existsSync(full + ".meta.json")) fs.unlinkSync(full + ".meta.json");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// a too-large body or a broken stream should answer in JSON, not express's HTML page
uploadRouter.use((err, req, res, next) => {
  if (err && (err.type === "entity.too.large" || err.status === 413 || err.statusCode === 413)) {
    return res.status(413).json({ error: `file is larger than ${MAX_UPLOAD / 1024 / 1024}MB` });
  }
  if (err) return res.status(400).json({ error: err.message });
  next();
});

app.use("/api/upload", uploadRouter);
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "1h" }));

app.use(express.json({ limit: "2mb" }));

// ---- shared context handed to the estate module -------------------------
const ctx = {
  dataDir: DATA_DIR,
  sitesDir: SITES_DIR,
  uploadsDir: UPLOAD_DIR,
  model: MODEL,
  ollamaUrl: OLLAMA_URL,
  listUploads,
  generatedAt: () => new Date().toISOString(),
};
const ctxGetter = () => ctx;

// ---- model call ---------------------------------------------------------
async function generate(prompt) {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`model returned ${res.status}`);
  const data = await res.json();
  return String(data.response || "").trim();
}

function slugify(name) {
  return (
    String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || `site-${Date.now()}`
  );
}

function stripFences(text) {
  return text.replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

// Copy this session's uploads into the finished site so the page is self
// contained and the links survive the container being rebuilt.
function attachAssets(session, siteDir) {
  const files = listUploads(session);
  if (!files.length) return [];
  const dest = path.join(siteDir, "assets");
  fs.mkdirSync(dest, { recursive: true });
  const copied = [];
  for (const f of files) {
    const from = path.join(UPLOAD_DIR, safeSession(session), f.name);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(dest, f.name));
    copied.push({ name: f.name, kind: f.kind, rel: `assets/${f.name}`, size: f.size });
  }
  return copied;
}

// ---- built-in minimal builder (used when gs_builder.js is absent) -------
function builtinRoutes(router) {
  router.get("/build", (req, res) => res.type("html").send(BUILD_PAGE));

  router.post("/api/build", async (req, res) => {
    const name = (req.body && req.body.name) || "";
    const brief = (req.body && req.body.brief) || "";
    const session = (req.body && req.body.session) || "anon";
    if (!brief.trim()) return res.status(400).json({ error: "a brief is required" });
    try {
      const uploads = listUploads(session);
      const pictures = uploads.filter((u) => u.kind !== "avatar");
      const avatar = uploads.find((u) => u.kind === "avatar");

      const lines = [
        "You are a web designer. Return only a complete, self-contained HTML document.",
        "Use semantic HTML and inline CSS in a style tag. No external assets, no scripts, no CDN links.",
      ];
      if (uploads.length) {
        lines.push(
          "The client supplied local files. They are already next to the page and MUST be referenced with " +
            "these exact relative paths (do not invent other image URLs, do not use placeholders):"
        );
        for (const u of uploads) {
          lines.push(`- assets/${u.name} (${u.kind === "avatar" ? "profile picture, 256x256" : "supplied image or document"})`);
        }
        if (avatar) lines.push(`Use assets/${avatar.name} as the profile picture, sized exactly 256px by 256px.`);
        if (pictures.length) lines.push("Use the other supplied files as the site's imagery where it fits the brief.");
      }
      lines.push("Design brief:", brief.slice(0, 4000));

      const html = stripFences(await generate(lines.join("\n")));
      if (!/<html[\s>]/i.test(html)) throw new Error("model did not return a document");
      const slug = slugify(name || brief.split(/\s+/).slice(0, 4).join("-"));
      const dir = path.join(SITES_DIR, slug);
      fs.mkdirSync(dir, { recursive: true });
      const assets = attachAssets(session, dir);
      fs.writeFileSync(path.join(dir, "index.html"), html, "utf8");
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify(
          { slug, name: name || slug, brief, model: MODEL, assets, builtAt: ctx.generatedAt() },
          null,
          2
        ),
        "utf8"
      );
      res.json({ ok: true, slug, url: `/s/${slug}`, assets });
    } catch (err) {
      res.status(502).json({ error: `could not build the site: ${err.message}` });
    }
  });

  router.get("/api/sites", (req, res) => {
    const sites = fs
      .readdirSync(SITES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const metaPath = path.join(SITES_DIR, d.name, "meta.json");
        let meta = { slug: d.name, name: d.name };
        try {
          meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        } catch (e) {}
        return meta;
      });
    res.json({ sites });
  });
}

const BUILD_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Goldsmiths Site Builder</title>
<style>
:root{color-scheme:dark}
body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#0b0b0b;color:#f2eee3;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
main{width:100%;max-width:720px}
h1{font-size:24px;margin:0 0 4px;letter-spacing:.02em}
p.sub{color:#c9a227;margin:0 0 24px;font-size:14px}
label{display:block;margin:16px 0 6px;font-size:13px;color:#b8b2a3}
input,textarea{width:100%;box-sizing:border-box;background:#161616;border:1px solid #333;border-radius:10px;color:#f2eee3;padding:12px;font:inherit}
textarea{min-height:140px;resize:vertical}
button{margin-top:18px;background:#c9a227;color:#0b0b0b;border:0;border-radius:10px;padding:13px 20px;font:inherit;font-weight:600;cursor:pointer}
button[disabled]{opacity:.5;cursor:default}
#out{margin-top:20px;font-size:14px}
#out a{color:#f5d67b}
.frames{margin-top:20px;border:1px solid #333;border-radius:10px;overflow:hidden}
iframe{width:100%;height:460px;border:0;background:#fff}
.row{display:flex;align-items:flex-end;gap:10px;margin-top:10px}
.attach{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.plus{width:44px;height:44px;border-radius:50%;border:1px solid #4a4128;background:#171510;color:#c9a227;font-size:26px;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer;margin:0;padding:0;flex:0 0 auto}
.plus:hover{background:#221e14}
.chips{display:flex;gap:8px;flex-wrap:wrap;min-height:36px;align-items:center}
.chip{display:flex;align-items:center;gap:8px;background:#161616;border:1px solid #333;border-radius:8px;padding:4px 8px 4px 4px;font-size:12px;color:#cfc9bb;max-width:220px}
.chip img{width:28px;height:28px;object-fit:cover;border-radius:5px;background:#000}
.chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip b{color:#c9a227;font-weight:600;cursor:pointer;padding:0 2px}
.hint{color:#7d7768;font-size:12px;margin:6px 0 0}
.avatarWrap{display:flex;gap:14px;align-items:center;margin-top:8px}
.avatar{border:1px dashed #4a4128;border-radius:12px;background:#131210;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;overflow:hidden;text-align:center}
.avatar.empty{width:256px;height:256px;max-width:100%}
.avatar.has{width:128px;height:128px;border-style:solid}
.avatar img{width:100%;height:100%;object-fit:cover}
.avatar .t{color:#8f887a;font-size:13px;padding:0 12px}
.avatar small{display:block;color:#6f6a5d;font-size:11px;margin-top:4px}
.avInfo{font-size:12px;color:#8f887a;max-width:280px}
.avInfo b{color:#c9a227;font-weight:600}
.dom{margin-top:8px;background:#131210;border:1px solid #2b2618;border-radius:10px;padding:10px 12px}
.dom h4{margin:0 0 8px;font-size:12px;font-weight:600;color:#b8b2a3;letter-spacing:.02em}
.domList{display:flex;flex-direction:column;gap:6px}
.domRow{display:flex;align-items:center;gap:10px;font-size:13px}
.domRow .n{font-family:ui-monospace,Menlo,monospace;color:#f2eee3}
.domRow .s{font-size:11px;padding:2px 7px;border-radius:999px;font-weight:600}
.domRow .yes{background:#1d3a24;color:#7ee08d}
.domRow .no{background:#332020;color:#c98a8a}
.domRow .unk{background:#2a2a2a;color:#9a9486}
.domRow .p{color:#8f887a;font-size:12px}
.domFoot{margin-top:8px;font-size:11px;color:#6f6a5d}
.domFoot b{color:#c9a227;font-weight:600}
.pic{margin-top:8px;background:#131210;border:1px solid #2b2618;border-radius:10px;padding:10px 12px}
.pic textarea{min-height:70px;font-size:14px}
.pic .orow{margin-top:8px}
.pic.needs{border-color:#4a3a1a;background:#1a1508}
.pic code{background:#000;color:#f5d67b;padding:1px 5px;border-radius:4px;font-size:11px;word-break:break-all}
.ghost{background:transparent;color:#c9a227;border:1px solid #4a4128;padding:8px 12px;font-size:12px}
.ask{display:flex;gap:8px;margin:0 0 10px}
.ask input{flex:1;background:#161616;border:1px solid #333;border-radius:8px;color:#f2eee3;padding:10px 11px;font:inherit;font-size:14px;caret-color:#c9a227}
.ask input:focus{outline:none;border-color:#c9a227}
.ask button{margin:0;padding:0 16px;font-size:13px}
.domRow .buy{color:#0b0b0b;background:#c9a227;border-radius:6px;padding:3px 9px;font-size:12px;font-weight:600;cursor:pointer;margin-left:auto}
.ord{margin-top:10px;padding:10px;border:1px solid #3a3320;border-radius:10px;background:#100f0c;display:flex;flex-direction:column;gap:6px}
.ord .ot{font-size:12px;color:#c9a227;font-weight:600}
.ord input{background:#161616;border:1px solid #333;border-radius:7px;color:#f2eee3;padding:8px;font:inherit;font-size:13px}
.orow{display:flex;align-items:center;gap:10px;margin-top:4px}
.orow button{margin:0;padding:9px 14px;font-size:13px}
#oMsg{font-size:12px;color:#b8b2a3}
.of{font-size:11px;color:#6f6a5d}
</style></head><body><main>
<h1>Goldsmiths Site Builder</h1>
<p class="sub">Describe it. Add your pictures. It builds. Everything stays on your NAS.</p>
<form id="f">
  <label for="name">Site name</label>
  <input id="name" name="name" placeholder="carrera servicing oxford">
  <div id="dom" class="dom" hidden></div>
  <label for="brief">What is the site for?</label>
  <textarea id="brief" name="brief" placeholder="A one page site for an e-bike servicing workshop in Oxford. Black and gold, prices, opening hours, phone number and a contact form."></textarea>

  <label>Files and pictures</label>
  <div class="attach">
    <button type="button" class="plus" id="plus" title="Add files or pictures">+</button>
    <div class="chips" id="chips"></div>
  </div>
  <input type="file" id="picker" multiple accept="image/*,.pdf,.txt,.doc,.docx,.csv" hidden>
  <p class="hint" id="hint">Images, logos, price lists, PDFs. Up to 10MB each. They get built into your page.</p>

  <label>Picture generator</label>
  <div class="pic" id="picBox">
    <textarea id="picPrompt" placeholder="Describe the picture you want, e.g. a black and gold e-bike leaning against a Victorian shopfront in Oxford, morning light"></textarea>
    <div class="orow"><button type="button" id="picGo">Build the picture</button><span id="picMsg"></span></div>
    <div class="of" id="picNote">Pictures you make here are added to your files and used in the page automatically.</div>
  </div>

  <label>Profile picture</label>
  <div class="avatarWrap">
    <div class="avatar empty" id="avatarBox"><div class="t">Click to add<br>256 &times; 256</div><small>cropped square automatically</small></div>
    <div class="avInfo" id="avInfo">A square 256 by 256 picture is cropped from whatever you choose, then used as the site's profile picture.</div>
  </div>
  <input type="file" id="avPicker" accept="image/*" hidden>

  <button id="go" type="submit">Build the site</button>
</form>
<div id="out"></div><div class="frames" id="frames" hidden><iframe id="pv" title="preview"></iframe></div>
<script>
const f=document.getElementById('f'),out=document.getElementById('out'),go=document.getElementById('go'),frames=document.getElementById('frames'),pv=document.getElementById('pv');
const plus=document.getElementById('plus'),picker=document.getElementById('picker'),chips=document.getElementById('chips'),hint=document.getElementById('hint');
const avatarBox=document.getElementById('avatarBox'),avPicker=document.getElementById('avPicker'),avInfo=document.getElementById('avInfo');
const SESSION=(function(){let s=localStorage.getItem('sb-session');if(!s){s=Math.random().toString(36).slice(2)+Date.now().toString(36);localStorage.setItem('sb-session',s);}return s;})();

function row(u){
  const el=document.createElement('div'); el.className='chip';
  const ext=String(u.name||'').split('.').pop().toLowerCase();
  const isImg=(u.type||'').indexOf('image/')===0||['png','jpg','jpeg','gif','webp','svg'].indexOf(ext)>=0;
  el.innerHTML=(isImg?'<img alt="">':'\u{1F4C4}')+'<span></span><b title="remove">&times;</b>';
  const img=el.querySelector('img'); if(img) img.src=u.url;
  el.querySelector('span').textContent=u.name;
  el.querySelector('b').onclick=async()=>{
    el.remove();
    try{ await fetch('/api/upload?session='+encodeURIComponent(SESSION)+'&name='+encodeURIComponent(u.name),{method:'DELETE'}); }catch(e){}
    if(!chips.children.length) hint.textContent='Images, logos, price lists, PDFs. Up to 10MB each. They get built into your page.';
  };
  chips.appendChild(el);
}

async function upload(blob,filename,kind){
  const r=await fetch('/api/upload',{method:'POST',headers:{'Content-Type':blob.type||'application/octet-stream','x-file-name':encodeURIComponent(filename),'x-session':SESSION,'x-kind':kind},body:blob});
  const d=await r.json(); if(!r.ok) throw new Error(d.error||'upload failed'); return d;
}

// picture generator: if no model is running, explain how to switch it on
// rather than leaving a dead button, and re-check on demand.
const picPrompt=document.getElementById('picPrompt'),picGo=document.getElementById('picGo'),
      picMsg=document.getElementById('picMsg'),picNote=document.getElementById('picNote');
const picBox=document.getElementById('picBox');
let picReady=false;

async function picHealth(){
  try{
    const h=await (await fetch('/api/images/health')).json();
    picReady=Boolean(h.configured && h.reachable && h.modelPresent!==false);
    picGo.disabled=!picReady;
    if(!h.configured){
      picBox.classList.add('needs');
      picNote.innerHTML='<b>Pictures are off on this box.</b> They need a small image model running alongside the builder. '+
        'Start one with <code>docker run -d --name pictures -p 8080:8080 localai/localai:latest-aio-cpu</code>, then restart the builder with '+
        '<code>IMAGE_API_URL</code> pointing at it and the port published. Any server that speaks OpenAI images works.';
    } else if(!h.reachable){
      picBox.classList.add('needs');
      picNote.innerHTML='<b>Image server not answering</b> at '+h.address+' ('+(h.reason||'no reply')+'). Started it recently? It can take a minute to load.';
    } else if(h.modelPresent===false){
      picBox.classList.add('needs');
      picNote.innerHTML='<b>Server is up, but it has no model called '+h.model+'.</b> It offers: '+
        (h.models&&h.models.length?h.models.map(m=>'<code>'+m+'</code>').join(' '):'nothing yet')+
        '. Start the builder with <code>IMAGE_MODEL</code> set to one of those.';
    } else {
      picBox.classList.remove('needs');
      picNote.innerHTML='Pictures you make here are added to your files and used in the page automatically.'+
        (h.model?' Model: <code>'+h.model+'</code>.':'');
    }
    return h;
  }catch(err){ return null; }
}

picNote.insertAdjacentHTML('afterend','<div class="orow"><button type="button" id="picRe" class="ghost">Check again</button></div>');
document.getElementById('picRe').onclick=async()=>{ picMsg.textContent='checking...'; const h=await picHealth(); picMsg.textContent=h&&h.reachable?'that is answering now':'still not answering'; };

picGo.onclick=async()=>{
  const prompt=picPrompt.value.trim();
  if(!prompt){ picMsg.textContent='describe the picture first'; return; }
  picGo.disabled=true;
  picMsg.textContent='building the picture. On a CPU-only box this can take a couple of minutes.';
  try{
    const r=await fetch('/api/images/generate',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({prompt:prompt,session:SESSION})});
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||'could not make that picture');
    row({name:d.name,url:d.url,type:'image/png'});
    picMsg.textContent='added to your files';
    picPrompt.value='';
    if(!chips.children.length) hint.textContent='Added. The builder is told to use these files in the page.';
  }catch(err){ picMsg.textContent=String(err.message||err); }
  finally{ picGo.disabled=!picReady; }
};

picHealth();

plus.onclick=()=>picker.click();
picker.onchange=async()=>{
  const files=[...picker.files]; picker.value='';
  for(const file of files){
    if(file.size>10*1024*1024){ out.textContent=file.name+' is over 10MB, skipped.'; continue; }
    try{ const d=await upload(file,file.name,'asset'); row({name:d.name,url:d.url,type:file.type}); }
    catch(err){ out.textContent=file.name+': '+err.message; }
  }
  hint.textContent='Added. The builder is told to use these files in the page.';
};

// 256x256 profile picture: cover-crop on a canvas so the file is exactly the
// size the site needs, whatever aspect ratio was chosen.
function crop256(file){
  return new Promise((resolve,reject)=>{
    const img=new Image(); const url=URL.createObjectURL(file);
    img.onload=()=>{
      const c=document.createElement('canvas'); c.width=256; c.height=256;
      const g=c.getContext('2d');
      const s=Math.max(256/img.width,256/img.height);
      const w=img.width*s,h=img.height*s;
      g.drawImage(img,(256-w)/2,(256-h)/2,w,h);
      URL.revokeObjectURL(url);
      c.toBlob(b=>b?resolve(b):reject(new Error('could not process that picture')),'image/png');
    };
    img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('that file is not a picture'));};
    img.src=url;
  });
}

avatarBox.onclick=()=>avPicker.click();
avPicker.onchange=async()=>{
  const file=avPicker.files[0]; avPicker.value='';
  if(!file) return;
  try{
    const blob=await crop256(file);
    const d=await upload(blob,'avatar-256.png','avatar');
    avatarBox.className='avatar has'; avatarBox.innerHTML='';
    const im=document.createElement('img'); im.src=d.url+'?t='+Date.now(); im.alt='profile picture';
    avatarBox.appendChild(im);
    avInfo.innerHTML='<b>256 &times; 256</b> saved and ready. Click the picture to replace it.';
  }catch(err){ avInfo.textContent=err.message; }
};

// domain ideas: a box you can type in yourself, plus suggestions from the
// brand name as it is typed. Both end in the same check and the same buy form.
const domBox=document.getElementById('dom'),nameInput=document.getElementById('name');
let domSeq=0,domTimer=null;

function buildPanel(){
  domBox.innerHTML=
    '<h4>Domain names</h4>'+
    '<div class="ask"><input id="askName" type="text" inputmode="text" autocomplete="off" '+
      'autocapitalize="off" spellcheck="false" placeholder="Type the name you want, e.g. mybrand.com">'+
      '<button type="button" id="askGo">Check</button></div>'+
    '<div class="domList" id="domList"></div>'+
    '<div class="domFoot" id="domFoot">Type any ending you like, or start filling in the site name above and ideas appear here.</div>';
  domBox.hidden=false;
  const ask=document.getElementById('askName');
  const go=async()=>{
    const raw=String(ask.value||'').trim().toLowerCase().replace(/\s+/g,'');
    if(!raw){ return; }
    const foot=document.getElementById('domFoot');
    foot.textContent='checking '+raw+'...';
    try{
      let data;
      if(raw.indexOf('.')>=0){
        const r=await fetch('/api/domains/check?domain='+encodeURIComponent(raw));
        const d=await r.json();
        if(!r.ok) throw new Error(d.error||'could not check that name');
        data={base:raw,results:[d]};
      }else{
        const r=await fetch('/api/domains/suggest?q='+encodeURIComponent(raw));
        data=await r.json();
      }
      renderResults(data,true);
    }catch(err){ foot.textContent=String(err.message||err); }
  };
  document.getElementById('askGo').onclick=go;
  ask.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); go(); } });
}

function renderResults(data,fromTyping){
  const rows=(data.results||[]).filter(r=>r&&r.domain);
  const list=document.getElementById('domList'), foot=document.getElementById('domFoot');
  list.innerHTML='';
  if(!rows.length){ foot.textContent='Nothing to show for that yet.'; return; }
  rows.forEach(r=>{
    let cls='unk', word='check failed';
    if(r.available===true){ cls='yes'; word='available'; }
    else if(r.available===false){ cls='no'; word='taken'; }
    let price='';
    if(r.sell!=null){
      const cur=r.sellCurrency==='GBP'?'&pound;':(r.sellCurrency==='USD'?'$':'');
      price='<span class="p">'+cur+r.sell.toFixed(2)+'</span>';
    } else if(r.reason){ price='<span class="p">'+r.reason+'</span>'; }
    const el=document.createElement('div');
    el.className='domRow';
    el.innerHTML='<span class="n"></span><span class="s '+cls+'">'+word+'</span>'+price;
    el.querySelector('.n').textContent=r.domain;
    if(r.available===true){
      const b=document.createElement('b');
      b.className='buy'; b.textContent='Get this one';
      b.onclick=()=>openOrder(el,r);
      el.appendChild(b);
    }
    list.appendChild(el);
  });
  foot.innerHTML=data.pricing
    ? 'Prices are ours, registration included. Card details go to Stripe, never through this box.'
    : 'Availability comes from the public registry. Prices are confirmed by email before anything is charged.';
}

// suggestions from the brand name, filling the same list
function renderDomains(data){ renderResults(data,false); }

function openOrder(rowEl,r){
  if(document.getElementById('ord')) return;
  const cur=r.sellCurrency==='GBP'?'&pound;':(r.sellCurrency==='USD'?'$':'');
  const ours=r.sell!=null?(cur+r.sell.toFixed(2)):'a price we confirm first';
  const box=document.createElement('div');
  box.className='ord'; box.id='ord';
  box.innerHTML='<div class="ot">'+r.domain+' &mdash; '+ours+'</div>'+
    '<input id="oName" placeholder="Your name (registrant)" autocomplete="name">'+
    '<input id="oMail" placeholder="Email for the registration" autocomplete="email" type="email">'+
    '<input id="oAddr" placeholder="Address line" autocomplete="street-address">'+
    '<input id="oCity" placeholder="Town" autocomplete="address-level2">'+
    '<input id="oPost" placeholder="Postcode" autocomplete="postal-code">'+
    '<div class="orow"><button type="button" id="oGo">Place the order</button><span id="oMsg"></span></div>'+
    '<div class="of">Card details go straight to Stripe, never through this box.</div>';
  rowEl.appendChild(box);
  document.getElementById('oGo').onclick=async()=>{
    const msg=document.getElementById('oMsg'), btn=document.getElementById('oGo');
    btn.disabled=true; msg.textContent='checking the name is still free...';
    try{
      const r2=await fetch('/api/domains/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        domain:r.domain,
        contact:{name:document.getElementById('oName').value,email:document.getElementById('oMail').value,
                 line1:document.getElementById('oAddr').value,city:document.getElementById('oCity').value,
                 postcode:document.getElementById('oPost').value,country:'GB'}})});
      const d=await r2.json();
      if(!r2.ok) throw new Error(d.error||'could not place the order');
      if(d.checkoutUrl){ msg.textContent='taking you to payment...'; location.href=d.checkoutUrl; return; }
      msg.innerHTML='Requested. Reference <b>'+d.ref+'</b>. '+d.note;
    }catch(err){ msg.textContent=String(err.message||err); btn.disabled=false; }
  };
}

buildPanel();

nameInput.addEventListener('input',()=>{
  const q=nameInput.value.trim();
  clearTimeout(domTimer);
  if(q.length<3) return;
  domTimer=setTimeout(async()=>{
    const mine=++domSeq;
    try{
      const r=await fetch('/api/domains/suggest?q='+encodeURIComponent(q));
      const d=await r.json();
      if(mine===domSeq) renderDomains(d);
    }catch(err){}
  },700);
});

f.addEventListener('submit',async e=>{
  e.preventDefault(); go.disabled=true; out.textContent='Building. The first build also downloads the model, so this can take a few minutes.';
  try{
    const r=await fetch('/api/build',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:f.elements['name'].value,brief:f.elements['brief'].value,session:SESSION})});
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||'failed');
    out.innerHTML='Built. <a href="'+d.url+'" target="_blank" rel="noopener">Open '+d.slug+'</a>'+(d.assets&&d.assets.length?' with '+d.assets.length+' file'+(d.assets.length>1?'s':'')+' attached.':'.');
    pv.src=d.url+'?t='+Date.now(); frames.hidden=false;
  }catch(err){ out.textContent=String(err.message||err); }
  finally{ go.disabled=false; }
});
</script></main></body></html>`;

// ---- domain suggestions -------------------------------------------------
// Turning the brand name into real domain ideas is the natural next question
// after "what is it called". Keyless by design: registry RDAP answers whether a
// name is registered. Prices only appear when a GoDaddy key is supplied.
const RDAP = {
  com: (d) => `https://rdap.verisign.com/com/v1/domain/${d}`,
  net: (d) => `https://rdap.verisign.com/net/v1/domain/${d}`,
  "co.uk": (d) => `https://rdap.nominet.uk/uk/domain/${d}`,
  uk: (d) => `https://rdap.nominet.uk/uk/domain/${d}`,
};
const DEFAULT_TLDS = ["com", "co.uk"];
const domainCache = new Map();

function brandBase(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 40);
}

function tldOf(domain) {
  const d = String(domain || "").toLowerCase();
  if (d.endsWith(".co.uk")) return "co.uk";
  const i = d.lastIndexOf(".");
  return i >= 0 ? d.slice(i + 1) : "";
}

async function checkRegistry(domain) {
  const tld = tldOf(domain);
  const build = RDAP[tld];
  if (!build) return { domain, tld, available: null, reason: "we cannot check that ending" };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(build(domain), { headers: { accept: "application/rdap+json" }, signal: ctrl.signal });
    clearTimeout(timer);
    if (res.status === 404) return { domain, tld, available: true, provider: "registry" };
    if (res.status === 200) return { domain, tld, available: false, provider: "registry" };
    return { domain, tld, available: null, reason: `registry said ${res.status}` };
  } catch (err) {
    return { domain, tld, available: null, reason: err.name === "AbortError" ? "registry timed out" : err.message };
  }
}

async function checkGodaddy(domain) {
  const auth = "sso-key " + GD_KEY + ":" + GD_SECRET;
  try {
    const res = await fetch(
      `https://api.godaddy.com/v1/domains/available?domain=${encodeURIComponent(domain)}&checkType=FAST`,
      { headers: { Authorization: auth } }
    );
    if (!res.ok) return null;
    const d = await res.json();
    return {
      domain,
      tld: tldOf(domain),
      available: d.available === true,
      // GoDaddy quotes micro-units of the currency: 12990000 is 12.99
      price: typeof d.price === "number" ? Math.round(d.price) / 1000000 : null,
      renewal: typeof d.renewalPrice === "number" ? Math.round(d.renewalPrice) / 1000000 : null,
      currency: d.currency || null,
      provider: "godaddy",
    };
  } catch (err) {
    return null;
  }
}

async function checkDomain(domain) {
  const key = String(domain || "").toLowerCase();
  const hit = domainCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  let value = null;
  if (GD_KEY && GD_SECRET) value = await checkGodaddy(key);
  if (!value) value = await checkRegistry(key);
  domainCache.set(key, { at: Date.now(), value });
  return value;
}

app.get("/api/domains/suggest", async (req, res) => {
  const base = brandBase(req.query.q);
  if (!base) return res.json({ query: String(req.query.q || ""), base: "", results: [] });
  const asked = String(req.query.tlds || "").split(",").map((t) => t.trim()).filter(Boolean);
  const tlds = asked.length ? asked.filter((t) => RDAP[t]) : DEFAULT_TLDS;
  const names = tlds.map((t) => `${base}.${t}`);
  const settled = await Promise.all(names.map((n) => checkDomain(n)));
  const results = settled.filter(Boolean).map((r) => ({
    ...r,
    sell: sellPrice(r.price == null ? null : r.price, r.currency),
    sellCurrency: SELL_CURRENCY,
  }));
  res.json({
    query: String(req.query.q || ""),
    base,
    pricing: Boolean(GD_KEY && GD_SECRET),
    margin: DOMAIN_MARGIN,
    results,
  });
});

app.get("/api/domains/check", async (req, res) => {
  const domain = String(req.query.domain || "").toLowerCase().trim();
  if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]\.[a-z.]{2,}$/.test(domain)) {
    return res.status(400).json({ error: "that does not look like a domain name" });
  }
  const result = await checkDomain(domain);
  if (!result) return res.status(502).json({ error: "could not check that name" });
  res.json({
    ...result,
    sell: sellPrice(result.price == null ? null : result.price, result.currency),
    sellCurrency: SELL_CURRENCY,
    margin: DOMAIN_MARGIN,
  });
});

// ---- picture generation ------------------------------------------------
// Describe it, get a picture. The result is saved as a normal upload so it flows
// into the build exactly like a photo the customer provided.
async function imageHealth() {
  if (!IMAGE_API) return { configured: false, reachable: null, model: IMAGE_MODEL };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${IMAGE_API}/v1/models`, {
      headers: IMAGE_API_KEY ? { Authorization: `Bearer ${IMAGE_API_KEY}` } : {},
      signal: ctrl.signal,
    });
    clearTimeout(t);
    let models = [];
    try {
      const d = await res.json();
      models = (d.data || []).map((m) => m.id).filter(Boolean).slice(0, 20);
    } catch (e) {}
    return {
      configured: true,
      reachable: res.ok,
      model: IMAGE_MODEL,
      modelPresent: models.length ? models.includes(IMAGE_MODEL) : null,
      models,
      address: IMAGE_API,
      status: res.status,
    };
  } catch (err) {
    return {
      configured: true,
      reachable: false,
      model: IMAGE_MODEL,
      address: IMAGE_API,
      reason: err.name === "AbortError" ? "timed out" : err.message,
    };
  }
}

async function generatePicture(prompt) {
  const body = { model: IMAGE_MODEL, prompt: prompt.slice(0, 1500), n: 1, size: IMAGE_SIZE, response_format: "b64_json" };
  const headers = { "Content-Type": "application/json" };
  if (IMAGE_API_KEY) headers.Authorization = `Bearer ${IMAGE_API_KEY}`;
  const ctrl = new AbortController();
  // image models on a CPU-only NAS are slow; give it five minutes
  const t = setTimeout(() => ctrl.abort(), 300000);
  let res;
  try {
    res = await fetch(`${IMAGE_API}/v1/images/generations`, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`picture model said ${res.status} ${detail.slice(0, 160)}`.trim());
  }
  const data = await res.json();
  const item = (data.data && data.data[0]) || {};
  if (item.b64_json) return Buffer.from(item.b64_json, "base64");
  if (item.url) {
    const img = await fetch(item.url);
    if (!img.ok) throw new Error(`could not fetch the generated picture (${img.status})`);
    return Buffer.from(await img.arrayBuffer());
  }
  throw new Error("the picture model returned nothing usable");
}

app.get("/api/images/health", async (req, res) => {
  const h = await imageHealth();
  res.json({ ...h, size: IMAGE_SIZE });
});

app.post("/api/images/generate", async (req, res) => {
  const prompt = String((req.body && req.body.prompt) || "").trim();
  const session = safeSession((req.body && req.body.session) || "anon");
  if (!prompt) return res.status(400).json({ error: "describe the picture first" });
  if (!IMAGE_API) {
    return res.status(503).json({
      error: "no picture model is configured on this box",
      hint: "set IMAGE_API_URL to an OpenAI-compatible image server (for example a LocalAI container) and restart",
    });
  }
  try {
    const buf = await generatePicture(prompt);
    const dir = sessionPath(session);
    const name = `picture-${Date.now()}.png`;
    const full = path.join(dir, name);
    fs.writeFileSync(full, buf);
    fs.writeFileSync(full + ".meta.json", JSON.stringify({ kind: "asset", generated: true, prompt, size: buf.length, uploadedAt: new Date().toISOString() }), "utf8");
    res.status(201).json({ ok: true, name, size: buf.length, url: `/uploads/${session}/${encodeURIComponent(name)}`, prompt });
  } catch (err) {
    res.status(502).json({ error: `could not make that picture: ${err.message}` });
  }
});

// ---- domain orders ------------------------------------------------------
// A domain is only ever offered for sale at a price we can stand behind, so the
// availability check is repeated server-side at order time. Trust the registry,
// never the browser.
function ordersPath() {
  return path.join(ORDERS_DIR, "domains.json");
}

function readOrders() {
  try {
    return JSON.parse(fs.readFileSync(ordersPath(), "utf8"));
  } catch (e) {
    return [];
  }
}

function writeOrders(list) {
  fs.writeFileSync(ordersPath(), JSON.stringify(list, null, 2), "utf8");
}

function orderRef() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `DM-${stamp}-${rand}`;
}

// Registry quotes come back in whichever currency the registry uses, usually
// USD. We sell in one currency, so convert, then apply margin once.
function sellPrice(base, quoteCurrency) {
  if (base == null) return null;
  let amount = base;
  const qc = String(quoteCurrency || "USD").toUpperCase();
  if (qc !== SELL_CURRENCY) {
    if (qc === "USD" && SELL_CURRENCY === "GBP") amount = base * FX;
  }
  const raw = amount * (1 + DOMAIN_MARGIN / 100);
  return Math.round(raw * 100) / 100;
}

async function stripeCreateSession(order, price, currency) {
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", `http://${order.host}/domains/paid?ref=${encodeURIComponent(order.ref)}&session_id={CHECKOUT_SESSION_ID}`);
  form.set("cancel_url", `http://${order.host}/build?cancelled=${encodeURIComponent(order.ref)}`);
  form.set("customer_email", order.contact.email);
  form.set("client_reference_id", order.ref);
  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", String(currency || "gbp").toLowerCase());
  form.set("line_items[0][price_data][unit_amount]", String(Math.round(price * 100)));
  form.set("line_items[0][price_data][product_data][name]", `Domain: ${order.domain}`);
  form.set("line_items[0][price_data][product_data][description]", "One year registration, and we point it at your site.");
  const res = await fetch(`${STRIPE_API}/v1/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error && data.error.message) || `stripe said ${res.status}`);
  return data;
}

async function stripeRetrieve(sessionId) {
  const res = await fetch(`${STRIPE_API}/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${STRIPE_KEY}` },
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

app.post("/api/domains/order", async (req, res) => {
  const b = req.body || {};
  const domain = String(b.domain || "").toLowerCase().trim();
  const contact = b.contact || {};
  if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]\.[a-z.]{2,}$/.test(domain)) {
    return res.status(400).json({ error: "that does not look like a domain name" });
  }
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(String(contact.email || ""))) {
    return res.status(400).json({ error: "a real email address is needed for the registration" });
  }
  if (!String(contact.name || "").trim()) {
    return res.status(400).json({ error: "the registrant name is needed" });
  }

  const check = await checkDomain(domain);
  if (!check || check.available !== true) {
    return res.status(409).json({
      error: check && check.available === false ? "that name has just been taken" : "we could not confirm that name is free",
    });
  }

  const base = check.price == null ? null : check.price;
  const price = sellPrice(base, check.currency);
  const currency = SELL_CURRENCY;

  const order = {
    ref: orderRef(),
    domain,
    contact: {
      name: String(contact.name).trim().slice(0, 120),
      email: String(contact.email).trim().slice(0, 160),
      line1: String(contact.line1 || "").trim().slice(0, 160),
      city: String(contact.city || "").trim().slice(0, 80),
      postcode: String(contact.postcode || "").trim().slice(0, 20),
      country: String(contact.country || "GB").trim().slice(0, 2).toUpperCase(),
    },
    cost: base,
    price,
    currency,
    status: price != null && STRIPE_KEY ? "awaiting_payment" : "requested",
    host: String(req.get("host") || "").slice(0, 120),
    createdAt: new Date().toISOString(),
  };

  if (order.status === "awaiting_payment") {
    try {
      const s = await stripeCreateSession(order, price, currency);
      order.stripeSession = s.id;
      order.checkoutUrl = s.url;
    } catch (err) {
      order.status = "requested";
      order.stripeError = err.message;
    }
  }

  const all = readOrders();
  all.push(order);
  writeOrders(all);
  res.status(201).json({
    ok: true,
    ref: order.ref,
    status: order.status,
    domain,
    price,
    currency,
    checkoutUrl: order.checkoutUrl || null,
    note:
      order.status === "awaiting_payment"
        ? "pay on the secure Stripe page and the registration is placed"
        : "we have your request and will confirm the price by email before anything is charged",
  });
});

app.get("/api/domains/order", async (req, res) => {
  const ref = String(req.query.ref || "").trim();
  const all = readOrders();
  const order = all.find((o) => o.ref === ref);
  if (!order) return res.status(404).json({ error: "no such order" });
  const sessionId = String(req.query.session_id || "");
  if (sessionId && STRIPE_KEY && order.status === "awaiting_payment") {
    const s = await stripeRetrieve(sessionId);
    if (s && s.payment_status === "paid") {
      order.status = "paid";
      order.paidAt = new Date().toISOString();
      order.stripeSession = s.id;
      writeOrders(all);
    }
  }
  res.json({
    ref: order.ref,
    domain: order.domain,
    status: order.status,
    price: order.price,
    currency: order.currency,
    createdAt: order.createdAt,
  });
});

app.get("/api/domains/orders", (req, res) => {
  const all = readOrders();
  res.json({ count: all.length, orders: all });
});

app.get("/domains/paid", async (req, res) => {
  const ref = String(req.query.ref || "");
  const sessionId = String(req.query.session_id || "");
  let order = null;
  if (STRIPE_KEY) {
    const all = readOrders();
    order = all.find((o) => o.ref === ref) || null;
    if (order && sessionId && order.status === "awaiting_payment") {
      const s = await stripeRetrieve(sessionId);
      if (s && s.payment_status === "paid") {
        order.status = "paid";
        order.paidAt = new Date().toISOString();
        writeOrders(all);
      }
    }
  }
  const name = order ? order.domain : "your domain";
  const paid = order && order.status === "paid";
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Domain order ${ref}</title>
<style>body{margin:0;font:16px/1.6 system-ui,sans-serif;background:#0b0b0b;color:#f2eee3;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
main{max-width:560px}h1{font-size:22px;margin:0 0 8px}p{color:#cfc9bb}code{color:#c9a227}a{color:#f5d67b}
.b{display:inline-block;margin-top:18px;background:#c9a227;color:#0b0b0b;border-radius:10px;padding:12px 18px;font-weight:600;text-decoration:none}</style>
</head><body><main>
<h1>${paid ? "Paid, thank you" : "Order received"}</h1>
<p>${paid ? `We have your payment for <strong>${name}</strong>. The registration gets placed and the name pointed at your site within one working day, and you will get the confirmation by email.` : `We have your request for <strong>${name}</strong>. Nothing has been charged. You will get the price confirmed by email first.`}</p>
<p>Reference <code>${ref || "unknown"}</code></p>
<a class="b" href="/build">Back to the builder</a>
</main></body></html>`);
});

// ---- wire up: estate module if present, built-in otherwise -------------
const router = express.Router();
let moduleLoaded = false;
const modulePath = path.join(__dirname, "gs_builder.js");
if (fs.existsSync(modulePath)) {
  try {
    require(modulePath)(router, ctxGetter);
    moduleLoaded = true;
    console.log("gs_builder.js loaded via require('./gs_builder')(router, ctxGetter)");
  } catch (err) {
    console.error("gs_builder.js failed to load, falling back to the built-in builder:", err.message);
  }
}
if (!moduleLoaded) builtinRoutes(router);
app.use(router);

// generated sites are served from disk, outside the router module
app.use("/s", express.static(SITES_DIR, { extensions: ["html"], maxAge: "1m" }));

app.get("/healthz", async (req, res) => {
  let model = "unknown";
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    const d = await r.json();
    const names = (d.models || []).map((m) => m.name);
    model = names.includes(MODEL) ? "ready" : names.length ? "other models present" : "no models pulled yet";
  } catch (e) {
    model = "unreachable";
  }
  res.json({
    ok: true,
    version: "1.2.5",
    module: moduleLoaded ? "gs_builder" : "builtin",
    dataDir: DATA_DIR,
    dataPersistent,
    dataWarning,
    uploadsDir: UPLOAD_DIR,
    model: MODEL,
    modelState: model,
  });
});

// ---- your data (review C6 / C7) ----------------------------------------
// Everything this app keeps is on this NAS: sites/, uploads/, orders/.
// These routes let the owner see it, get a copy, and delete it. No account needed,
// because there is no account: whoever can reach the box owns the data on it.
function dataSummary() {
  const count = (d) => { try { return fs.readdirSync(d).length; } catch (e) { return 0; } };
  return {
    stored: "On this NAS only",
    location: DATA_DIR,
    sites: count(SITES_DIR),
    uploads: count(UPLOAD_DIR),
    orders: count(ORDERS_DIR),
    howToSee: "GET /api/my-data",
    howToExport: "GET /api/my-data/export",
    howToDelete: "DELETE /api/my-data",
  };
}

app.get("/api/my-data", (req, res) => {
  const sites = (() => {
    try {
      return fs.readdirSync(SITES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
        let meta = { slug: d.name };
        try { meta = JSON.parse(fs.readFileSync(path.join(SITES_DIR, d.name, "meta.json"), "utf8")); } catch (e) {}
        return meta;
      });
    } catch (e) { return []; }
  })();
  const orders = (() => { try { return readOrders(); } catch (e) { return []; } })();
  res.json({ ...dataSummary(), siteList: sites, orderCount: Array.isArray(orders) ? orders.length : 0 });
});

// A copy you can keep: every site page plus its record, and the order list.
app.get("/api/my-data/export", (req, res) => {
  const out = { exportedAt: new Date().toISOString(), sites: [], orders: [] };
  try {
    for (const d of fs.readdirSync(SITES_DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(SITES_DIR, d.name);
      const rec = { slug: d.name, files: {} };
      for (const f of fs.readdirSync(dir)) {
        const fp = path.join(dir, f);
        try { if (fs.statSync(fp).isFile()) rec.files[f] = fs.readFileSync(fp, "utf8"); } catch (e) {}
      }
      out.sites.push(rec);
    }
  } catch (e) {}
  try { out.orders = readOrders(); } catch (e) {}
  res.setHeader("content-disposition", 'attachment; filename="site-builder-my-data.json"');
  res.json(out);
});

// Delete one site.
app.delete("/api/my-data/site/:slug", (req, res) => {
  const slug = String(req.params.slug || "");
  const clean = slug.toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!clean || clean !== slug) return res.status(400).json({ error: "bad site name" });
  const dir = path.join(SITES_DIR, clean);
  if (!dir.startsWith(SITES_DIR + path.sep) || !fs.existsSync(dir)) return res.status(404).json({ error: "no such site" });
  fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true, deleted: clean });
});

// Delete everything the app holds.
app.delete("/api/my-data", (req, res) => {
  const cleared = { sites: 0, uploads: 0, orders: 0 };
  for (const [dir, key] of [[SITES_DIR, "sites"], [UPLOAD_DIR, "uploads"], [ORDERS_DIR, "orders"]]) {
    try {
      for (const d of fs.readdirSync(dir)) {
        fs.rmSync(path.join(dir, d), { recursive: true, force: true });
        cleared[key]++;
      }
    } catch (e) {}
  }
  res.json({ ok: true, cleared });
});

app.get("/privacy", (req, res) => res.type("text/plain").send(PRIVACY_TEXT));

const PRIVACY_TEXT = [
  "Goldsmiths Site & AI Builder - what happens to your data",
  "",
  "Everything you type is stored on this NAS and nowhere else. There is no account,",
  "no login, no analytics and no tracking of any kind.",
  "",
  "WHAT IS STORED, and where",
  "  sites/<name>/        the site name, the brief you typed, and the page the AI wrote",
  "  uploads/<session>/   pictures and documents you add, plus any picture the app generates",
  "  orders/              domain orders you start: the domain, the price, and the contact",
  "                       details you enter (name, email, and any address you give)",
  "All of it lives under the app's data volume. Deleting the app's volumes deletes all of it.",
  "",
  "WHAT LEAVES THE NAS",
  "The AI that writes the site runs in a container beside this app, on this NAS",
  "(" + OLLAMA_URL + "). Your brief is not sent to G-Lock, to TerraMaster, or to any AI cloud.",
  "",
  "Three optional features do talk to other services, and only when they are switched on:",
  "",
  "  1. Looking up whether a domain is free.",
  "     Always on, because it only asks a public registry about a name you typed.",
  "     Sends: the domain name. To: rdap.verisign.com (for .com and .net) or",
  "     rdap.nominet.uk (for .uk). No personal data is sent.",
  "     If GODADDY_KEY and GODADDY_SECRET are set, the lookup goes to api.godaddy.com",
  "     instead, sending the domain name and those credentials.",
  "",
  "  2. Generating a picture. Only works if IMAGE_API_URL is set.",
  "     Sends: the picture description you typed, to the address in IMAGE_API_URL.",
  "     If that address points at a service on the internet, your description leaves this NAS;",
  "     if it points at a box on your own network, it does not. The app does not care which,",
  "     so read that setting before relying on it.",
  "",
  "  3. Buying a domain. Only works if STRIPE_SECRET_KEY is set.",
  "     Sends: the domain, the price, and the name and email you entered, to api.stripe.com,",
  "     so that Stripe can take the payment. Card details are typed on Stripe's page and never",
  "     reach this NAS. Stripe's own privacy policy covers what Stripe then keeps.",
  "",
  "WHAT NEVER HAPPENS",
  "No telemetry, no usage reporting, no advertising, no sharing of your sites or documents",
  "with G-Lock Ltd or anyone else. The app makes no other outbound connections.",
  "",
  "YOUR RIGHTS: SEE IT, TAKE IT, DELETE IT",
  "  see      GET    /api/my-data            a summary, plus every site record",
  "  take     GET    /api/my-data/export     one JSON file: your pages and your orders",
  "  fix      edit the site by building it again with the same name; it replaces the old copy",
  "  delete   DELETE /api/my-data/site/<name>  remove one site",
  "           DELETE /api/my-data              remove every site, upload and order",
  "  erase everything: uninstall the app and delete its volumes.",
  "You do not have to ask us for any of this, and we cannot do it for you: the data is",
  "on your hardware, not ours.",
  "",
  "Publisher: G-Lock Ltd. Contact: privacy@goldsmiths.ai",
  "Receipts and rights questions: https://goldsmiths.ai/privacy",
  "",
].join("\n");

app.get("/", (req, res) => res.redirect("/build"));

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`site builder listening on 0.0.0.0:${PORT} | data ${DATA_DIR} | model ${MODEL} at ${OLLAMA_URL}`);
});

// ---- clean stop (review F3) --------------------------------------------
// Stop accepting work, let in-flight requests finish, close the port, exit 0.
// init:true in the compose makes node the direct child, so SIGTERM arrives here.
let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(signal + " received, stopping cleanly");
  const force = setTimeout(() => { console.log("forcing exit after 10s"); process.exit(0); }, 10000);
  force.unref();
  server.close(() => { console.log("stopped, port released"); process.exit(0); });
  if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

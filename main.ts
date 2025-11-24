import { S3Client } from "npm:@aws-sdk/client-s3";
import { Upload } from "npm:@aws-sdk/lib-storage";
import { timingSafeEqual } from "jsr:@std/crypto/timing-safe-equal";

// --- 1. CONFIGURATION ---
const REQUIRED_ENV_VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_URL"];
for (const v of REQUIRED_ENV_VARS) if (!Deno.env.get(v)) throw new Error(`Missing: ${v}`);

const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID")!;
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID")!;
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY")!;
const R2_BUCKET_NAME = Deno.env.get("R2_BUCKET_NAME")!;
const R2_PUBLIC_URL = Deno.env.get("R2_PUBLIC_URL")!;
const BASIC_AUTH_USER = Deno.env.get("BASIC_AUTH_USER");
const BASIC_AUTH_PASS = Deno.env.get("BASIC_AUTH_PASS");

// --- 2. SETUP ---
const kv = await Deno.openKv();
const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});
const MAX_DATE_MS = 9999999999999;

// --- 3. HELPERS ---
function mimeToExt(mime: string): string {
  const m: any = {'video/mp4':'mp4','video/webm':'webm','video/x-matroska':'mkv','video/quicktime':'mov','video/avi':'avi','image/jpeg':'jpg','image/png':'png','image/gif':'gif'};
  return m[mime.split(';')[0]] || 'bin';
}
function formatTimeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime())/1000);
  if(s>31536000)return Math.floor(s/31536000)+"y ago"; if(s>2592000)return Math.floor(s/2592000)+"mo ago";
  if(s>86400)return Math.floor(s/86400)+"d ago"; if(s>3600)return Math.floor(s/3600)+"h ago";
  if(s>60)return Math.floor(s/60)+"m ago"; return s+"s ago";
}
function sanitize(n: string|null): string|null {
  return n ? n.replace(/\.[^/.]+$/, "").replace(/[?&#/\\]/g, "").replace(/[\s_]+/g, "-").trim() : null;
}

// --- 4. SERVER ---
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // Auth Check
  if (BASIC_AUTH_USER && BASIC_AUTH_PASS) {
    const auth = req.headers.get("Authorization");
    if (auth) {
      const [u, p] = new TextDecoder().decode(Uint8Array.from(atob(auth.split(" ")[1]), c=>c.charCodeAt(0))).split(":");
      const enc = new TextEncoder();
      if (timingSafeEqual(enc.encode(u), enc.encode(BASIC_AUTH_USER)) && timingSafeEqual(enc.encode(p), enc.encode(BASIC_AUTH_PASS))) {
        // OK
      } else return new Response("Unauthorized", {status:401, headers:{'WWW-Authenticate':'Basic realm="Restricted"'}});
    } else return new Response("Unauthorized", {status:401, headers:{'WWW-Authenticate':'Basic realm="Restricted"'}});
  }

  // --- ROUTE 1: UPLOADER UI ---
  if (req.method === "GET" && url.pathname === "/") {
    return new Response(`<!DOCTYPE html><html><head><title>R2 Uploader</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      :root{--bg:#111;--card:#222;--text:#eee;--accent:#3b82f6;--border:#333;}
      body{font-family:sans-serif;background:var(--bg);color:var(--text);margin:0;display:grid;place-items:center;min-height:100vh;}
      .box{background:var(--card);padding:2rem;border-radius:12px;width:90%;max-width:400px;box-shadow:0 10px 25px rgba(0,0,0,0.5);}
      .head{display:flex;justify-content:space-between;margin-bottom:1.5rem;} a{color:var(--accent);text-decoration:none;}
      .tabs{display:flex;border-bottom:2px solid var(--border);margin-bottom:1rem;}
      .tab{flex:1;padding:0.8rem;background:none;border:none;color:#888;cursor:pointer;font-size:1rem;transition:0.3s;}
      .tab:hover{color:#ccc;}
      .tab.active{color:var(--accent);border-bottom:2px solid var(--accent);}
      .content{display:none;} .content.active{display:block;}
      .btn{width:100%;padding:0.8rem;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;margin-top:1rem;font-weight:bold;}
      .btn:disabled{background:#444;cursor:not-allowed;}
      input{width:100%;padding:0.8rem;background:#000;border:1px solid var(--border);color:#fff;border-radius:6px;box-sizing:border-box;margin-bottom:0.5rem;}
      #fileBox{border:2px dashed #555;padding:2rem;text-align:center;border-radius:8px;cursor:pointer;}
      #fileBox:hover{background:#2a2a2a;border-color:var(--accent);}
      .res{margin-top:1.5rem;font-size:0.9rem;} 
      .link-row {margin-bottom:10px;}
      .link-label {font-size:0.75rem; color:#888; margin-bottom:2px;}
      .link-group {display:flex;}
      .link-group input {margin-bottom:0; border-radius: 4px 0 0 4px; border-right:none;}
      .copy-btn {background:var(--accent); color:white; border:none; padding:0 12px; border-radius:0 4px 4px 0; cursor:pointer;}
      .copy-btn:hover {filter:brightness(1.1);}
      .bar-box{height:6px;background:#333;border-radius:3px;margin-top:10px;overflow:hidden;display:none;}
      .bar{height:100%;background:var(--accent);width:0%;transition:0.2s;}
      #progText {text-align:center; font-size:0.8rem; color:#888; margin-top:5px; display:none;}
    </style></head><body>
    <div class="box">
      <div class="head"><h2>R2 Uploader</h2><a href="/history">History</a></div>
      
      <div class="tabs">
        <button class="tab active" id="tab-btn-file" onclick="openTab('file')">File Upload</button>
        <button class="tab" id="tab-btn-url" onclick="openTab('url')">Remote URL</button>
      </div>
      
      <div id="view-file" class="content active">
        <form id="fForm">
          <label id="fileBox"><input type="file" id="file" hidden><span>Click to Choose File</span><div id="fName" style="color:#888;font-size:0.8em;margin-top:5px"></div></label>
          <button class="btn" id="fBtn" disabled>Upload</button>
        </form>
      </div>
      
      <div id="view-url" class="content">
        <form id="uForm">
            <input id="urlInput" placeholder="https://example.com/video.mp4" type="url" required>
            <input id="nameInput" placeholder="Custom Name (Optional)">
            <button class="btn" id="uBtn">Remote Upload</button>
        </form>
      </div>

      <div class="bar-box" id="progBox"><div class="bar" id="bar"></div></div>
      <div id="progText">0%</div>
      <div id="res" class="res"></div>
    </div>
    <script>
      function openTab(name) {
          document.querySelectorAll('.content').forEach(el => el.classList.remove('active'));
          document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
          document.getElementById('view-' + name).classList.add('active');
          document.getElementById('tab-btn-' + name).classList.add('active');
          document.getElementById('res').innerHTML = '';
          resetProg();
      }

      const fIn=document.getElementById('file'), fName=document.getElementById('fName'), fBtn=document.getElementById('fBtn');
      fIn.onchange=()=>{if(fIn.files.length){fName.innerText=fIn.files[0].name;fBtn.disabled=false;}else{fName.innerText='';fBtn.disabled=true;}};
      
      function resetProg(){
          document.getElementById('progBox').style.display='none';
          document.getElementById('progText').style.display='none';
          document.getElementById('bar').style.width='0%';
          document.getElementById('progText').innerText='0%';
      }

      function updateProg(pct, msg) {
          document.getElementById('progBox').style.display='block';
          document.getElementById('progText').style.display='block';
          document.getElementById('bar').style.width = pct + '%';
          document.getElementById('progText').innerText = pct + '% ' + (msg || '');
      }

      // 1. Standard File Upload
      document.getElementById('fForm').onsubmit=e=>{
          e.preventDefault(); 
          const fd=new FormData(); fd.append('file',fIn.files[0]); 
          const btn = fBtn; btn.disabled=true; btn.innerText='Uploading...';
          
          const xhr=new XMLHttpRequest(); 
          xhr.open('POST', '/upload-file');
          xhr.upload.onprogress=e=>{if(e.lengthComputable) updateProg(Math.round((e.loaded/e.total)*100));};
          xhr.onload=()=>{
              btn.disabled=false; btn.innerText='Upload'; resetProg();
              try{const d=JSON.parse(xhr.responseText); xhr.status===200?show(d):alert(d.error)}catch(e){alert('Error: '+xhr.responseText)}
          };
          xhr.onerror=()=>{ btn.disabled=false; btn.innerText='Upload'; alert('Network Error'); };
          xhr.send(fd);
      };
      
      // 2. Remote URL Upload (Streaming Progress)
      document.getElementById('uForm').onsubmit=async e=>{
          e.preventDefault(); 
          const btn = document.getElementById('uBtn');
          const url = document.getElementById('urlInput').value;
          const name = document.getElementById('nameInput').value;
          
          btn.disabled=true; btn.innerText='Uploading...'; 
          updateProg(0, 'Starting...');

          try {
              const response = await fetch('/upload-remote', {
                  method: 'POST',
                  headers: {'Content-Type': 'application/json'},
                  body: JSON.stringify({url, name})
              });

              if (!response.ok && response.headers.get('content-type') === 'application/json') {
                  const err = await response.json(); throw new Error(err.error);
              }

              // Stream Reader
              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let buffer = '';

              while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  
                  buffer += decoder.decode(value, { stream: true });
                  const lines = buffer.split('\\n');
                  buffer = lines.pop(); // Keep incomplete line

                  for (const line of lines) {
                      if (!line.trim()) continue;
                      try {
                          const msg = JSON.parse(line);
                          if (msg.progress) {
                              updateProg(msg.progress, 'Processing...');
                          } else if (msg.done) {
                              show(msg.done);
                          } else if (msg.error) {
                              throw new Error(msg.error);
                          }
                      } catch (e) { console.log('Parse error', e); }
                  }
              }
          } catch (e) {
              alert("Error: " + e.message);
          } finally {
              btn.disabled=false; btn.innerText='Remote Upload'; resetProg();
          }
      };
      
      function copyTxt(btn, txt) {
          navigator.clipboard.writeText(txt).then(() => {
              btn.innerText = '✓'; setTimeout(() => btn.innerText = 'Copy', 2000);
          });
      }

      function show(d){
          const res = document.getElementById('res');
          res.innerHTML = \`
            <div style="color:#4ade80;margin-bottom:10px;text-align:center">✓ Upload Successful!</div>
            <div class="link-row"><div class="link-label">Proxy Play (Deno Bandwidth)</div>
                <div class="link-group"><input readonly value="\${d.proxy}" onclick="this.select()"><button class="copy-btn" onclick="copyTxt(this, '\${d.proxy}')">Copy</button></div></div>
            <div class="link-row"><div class="link-label">Proxy Download (Deno Bandwidth)</div>
                <div class="link-group"><input readonly value="\${d.dl}" onclick="this.select()"><button class="copy-btn" onclick="copyTxt(this, '\${d.dl}')">Copy</button></div></div>
            <div class="link-row"><div class="link-label">R2 Direct (Saves Bandwidth)</div>
                <div class="link-group"><input readonly value="\${d.r2}" onclick="this.select()"><button class="copy-btn" onclick="copyTxt(this, '\${d.r2}')">Copy</button></div></div>
          \`;
      }
    </script></body></html>`, {headers:{"content-type":"text/html"}});
  }

  // --- ROUTE 2: UPLOAD FILE (Standard) ---
  if (req.method === "POST" && url.pathname === "/upload-file") {
    try {
      const formData = await req.formData();
      const file = formData.get("file") as File;
      if (!file) return Response.json({error:"No file"},{status:400});
      
      const ext = mimeToExt(file.type);
      const fileName = `${sanitize(file.name)||crypto.randomUUID()}.${ext}`;
      
      const upload = new Upload({
        client: s3Client,
        params: { Bucket: R2_BUCKET_NAME, Key: fileName, Body: file.stream(), ContentType: file.type },
        queueSize: 4, partSize: 10 * 1024 * 1024
      });
      await upload.done();

      const data = { id: crypto.randomUUID(), fileName, proxyUrl: `https://${url.host}/image/${fileName}`, r2Url: `https://${R2_PUBLIC_URL}/${fileName}`, downloadUrl: `https://${url.host}/download/${fileName}`, createdAt: new Date(), source: "File" };
      await kv.set(["uploads", MAX_DATE_MS - Date.now(), data.id], data);
      return Response.json({proxy:data.proxyUrl, r2:data.r2Url, dl:data.downloadUrl});
    } catch (e) { return Response.json({error:e.message},{status:500}); }
  }

  // --- ROUTE 3: REMOTE UPLOAD (Streaming Progress) ---
  if (req.method === "POST" && url.pathname === "/upload-remote") {
    const body = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const push = (data: any) => controller.enqueue(enc.encode(JSON.stringify(data) + "\n"));
        
        try {
          const {url:u, name:n} = await req.json();
          const r = await fetch(u);
          if(!r.ok) throw new Error("Fetch failed: " + r.status);
          
          const totalSize = parseInt(r.headers.get("content-length") || "0");
          const ext = mimeToExt(r.headers.get("content-type")||"");
          const fileName = `${sanitize(n)||crypto.randomUUID()}.${ext}`;
          
          const upload = new Upload({
            client: s3Client,
            params: { Bucket: R2_BUCKET_NAME, Key: fileName, Body: r.body as any, ContentType: r.headers.get("content-type")||"application/octet-stream" },
            queueSize: 4, partSize: 10 * 1024 * 1024
          });

          // Monitor Progress
          upload.on("httpUploadProgress", (progress) => {
            if (totalSize > 0 && progress.loaded) {
              const pct = Math.round((progress.loaded / totalSize) * 100);
              push({ progress: pct });
            }
          });

          await upload.done();

          const data = { id: crypto.randomUUID(), fileName, proxyUrl: `https://${url.host}/image/${fileName}`, r2Url: `https://${R2_PUBLIC_URL}/${fileName}`, downloadUrl: `https://${url.host}/download/${fileName}`, createdAt: new Date(), source: "URL" };
          await kv.set(["uploads", MAX_DATE_MS - Date.now(), data.id], data);
          
          push({ done: {proxy:data.proxyUrl, r2:data.r2Url, dl:data.downloadUrl} });
        } catch (e) {
          push({ error: e.message });
        }
        controller.close();
      }
    });
    return new Response(body, { headers: { "Content-Type": "application/x-ndjson" } });
  }

  // --- ROUTE 4: PROXY & DOWNLOAD ---
  if (req.method === "GET" && (url.pathname.startsWith("/image/") || url.pathname.startsWith("/download/"))) {
    const dl = url.pathname.startsWith("/download/");
    const key = url.pathname.substring(dl?10:7);
    try {
      const r = await fetch(`https://${R2_PUBLIC_URL}/${key}`, {headers: req.headers.get("range")?{"range":req.headers.get("range")!}:{}});
      if (!r.ok) return new Response("File not found", {status:404});
      const h = new Headers(r.headers); h.set("Access-Control-Allow-Origin","*");
      h.set("Content-Disposition", `${dl?'attachment':'inline'}; filename="${key}"`);
      return new Response(r.body, {status:r.status, headers:h});
    } catch { return new Response("Error",{status:500}); }
  }

  // --- ROUTE 5: HISTORY PAGE ---
  if (req.method === "GET" && url.pathname === "/history") {
    const iter = kv.list({ prefix: ["uploads"] }, { limit: 50 });
    let items = "";
    for await (const e of iter) {
      const v = e.value as any;
      const key = JSON.stringify(e.key);
      items += `
        <div class="item">
          <div class="top"><b>${v.fileName}</b><button onclick='del(${key})'>Remove List</button></div>
          <div class="meta">${formatTimeAgo(new Date(v.createdAt))} • ${v.source}</div>
          <div class="link-group"><input readonly value="${v.proxyUrl}" onclick="this.select()"><button class="copy-btn" onclick="copyTxt(this, '${v.proxyUrl}')">Copy</button></div>
          <div class="link-group"><input readonly value="${v.downloadUrl}" onclick="this.select()"><button class="copy-btn" onclick="copyTxt(this, '${v.downloadUrl}')">Copy</button></div>
          <div class="link-group"><input readonly value="${v.r2Url}" onclick="this.select()"><button class="copy-btn" onclick="copyTxt(this, '${v.r2Url}')">Copy</button></div>
        </div>`;
    }
    return new Response(`<!DOCTYPE html><html><head><title>History</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      body{background:#111;color:#eee;font-family:sans-serif;padding:1rem;max-width:600px;margin:0 auto;}
      .head{display:flex;justify-content:space-between;margin-bottom:1rem;border-bottom:1px solid #333;padding-bottom:10px;} a{color:#3b82f6;}
      .item{background:#222;padding:1rem;border-radius:8px;margin-bottom:10px;}
      .top{display:flex;justify-content:space-between;align-items:center;}
      button{background:#ef4444;color:#fff;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:0.8rem;}
      .meta{font-size:0.8rem;color:#888;margin:5px 0;}
      .link-group{display:flex;margin-top:5px;}
      input{background:#000;border:1px solid #333;color:#4ade80;flex:1;padding:5px;border-radius:4px 0 0 4px;border-right:none;}
      .copy-btn{background:#3b82f6;color:white;border:none;padding:0 10px;border-radius:0 4px 4px 0;cursor:pointer;}
    </style><script>
      async function del(k){
        if(!confirm("Remove from history list? (File remains on Cloud)"))return;
        await fetch('/api/delete-history',{method:'POST',body:JSON.stringify({key:k})});
        location.reload();
      }
      function copyTxt(btn, txt) {
          navigator.clipboard.writeText(txt).then(() => {
              const original = btn.innerText; btn.innerText = '✓';
              setTimeout(() => btn.innerText = original, 2000);
          });
      }
    </script></head><body>
      <div class="head"><h2>History</h2><a href="/">Back</a></div>
      <div class="list">${items||'No history'}</div>
    </body></html>`, {headers:{"content-type":"text/html"}});
  }

  // --- ROUTE 6: DELETE HISTORY API ---
  if (req.method === "POST" && url.pathname === "/api/delete-history") {
    try {
      const { key } = await req.json();
      await kv.delete(key);
      return Response.json({success:true});
    } catch { return Response.json({error:"Failed"},{status:500}); }
  }

  return new Response("404", { status: 404 });
});

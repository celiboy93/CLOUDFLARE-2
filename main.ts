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
  return n ? n.replace(/[^\w\-. ]/g, "").replace(/\s+/g, "-").trim() : "file";
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
      :root{--bg:#0f172a;--card:#1e293b;--text:#f1f5f9;--accent:#3b82f6;--accent-glow:#60a5fa;--border:#334155;}
      body{font-family:'Segoe UI', sans-serif;background:var(--bg);color:var(--text);margin:0;display:grid;place-items:center;min-height:100vh;}
      .box{background:var(--card);padding:2.5rem;border-radius:16px;width:90%;max-width:420px;box-shadow:0 20px 40px -10px rgba(0,0,0,0.5);border:1px solid var(--border);}
      .head{display:flex;justify-content:space-between;align-items:center;margin-bottom:2rem;} 
      h2{margin:0;font-weight:600;letter-spacing:-0.5px;}
      a{color:var(--accent);text-decoration:none;font-size:0.9rem;font-weight:500;transition:0.2s;} a:hover{color:var(--accent-glow);}
      
      .tabs{display:flex;background:#0f172a;padding:4px;border-radius:10px;margin-bottom:1.5rem;}
      .tab{flex:1;padding:0.6rem;background:none;border:none;color:#94a3b8;cursor:pointer;font-size:0.9rem;border-radius:8px;transition:0.3s;font-weight:500;}
      .tab:hover{color:#fff;}
      .tab.active{background:var(--accent);color:#fff;box-shadow:0 4px 12px rgba(59,130,246,0.4);}
      
      .content{display:none;animation:fade 0.3s ease;} .content.active{display:block;}
      @keyframes fade{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
      
      .btn{width:100%;padding:1rem;background:linear-gradient(135deg, var(--accent), var(--accent-glow));color:#fff;border:none;border-radius:10px;cursor:pointer;margin-top:1.5rem;font-weight:600;font-size:1rem;transition:0.2s;box-shadow:0 4px 15px rgba(59,130,246,0.3);}
      .btn:disabled{background:#334155;color:#94a3b8;cursor:not-allowed;box-shadow:none;}
      .btn:active{transform:scale(0.98);}
      
      input{width:100%;padding:1rem;background:#0f172a;border:1px solid var(--border);color:#fff;border-radius:10px;box-sizing:border-box;margin-bottom:0.8rem;transition:0.2s;outline:none;}
      input:focus{border-color:var(--accent);box-shadow:0 0 0 2px rgba(59,130,246,0.2);}
      
      #fileBox{border:2px dashed var(--border);padding:2.5rem;text-align:center;border-radius:12px;cursor:pointer;transition:0.2s;display:block;}
      #fileBox:hover{background:#0f172a;border-color:var(--accent);}
      
      /* Progress Bar Styling */
      .progress-container {margin-top:20px; display:none;}
      .progress-header {display:flex; justify-content:space-between; font-size:0.85rem; color:#94a3b8; margin-bottom:8px;}
      .progress-track {height:8px; background:#0f172a; border-radius:4px; overflow:hidden;}
      .progress-fill {
          height:100%; width:0%; border-radius:4px;
          background: linear-gradient(90deg, var(--accent), #a855f7);
          background-size: 200% 100%;
          animation: shimmer 2s infinite linear;
          transition: width 0.3s ease-out;
          box-shadow: 0 0 10px rgba(59,130,246,0.5);
      }
      @keyframes shimmer { 0%{background-position: 100% 0} 100%{background-position: -100% 0} }
      
      .res{margin-top:1.5rem;}
      .link-row {margin-bottom:12px;}
      .link-label {font-size:0.75rem; color:#94a3b8; margin-bottom:4px; font-weight:500;}
      .link-group {display:flex; position:relative;}
      .link-group input {margin-bottom:0; border-radius:8px; padding-right:60px; font-family:monospace; color:#60a5fa; font-size:0.85rem;}
      .copy-btn {position:absolute; right:4px; top:4px; bottom:4px; background:var(--card); color:var(--accent); border:none; padding:0 12px; border-radius:6px; cursor:pointer; font-weight:600; font-size:0.8rem; border:1px solid var(--border);}
      .copy-btn:hover {background:var(--accent); color:#fff; border-color:var(--accent);}
    </style></head><body>
    <div class="box">
      <div class="head"><h2>R2 Uploader</h2><a href="/history">History →</a></div>
      
      <div class="tabs">
        <button class="tab active" id="tab-btn-file" onclick="openTab('file')">File Upload</button>
        <button class="tab" id="tab-btn-url" onclick="openTab('url')">Remote URL</button>
      </div>
      
      <div id="view-file" class="content active">
        <form id="fForm">
          <label id="fileBox"><input type="file" id="file" hidden><span style="font-size:1.2rem">📁</span><br><span style="color:#94a3b8;font-size:0.9rem">Click to select file</span><div id="fName" style="color:var(--accent);font-weight:bold;font-size:0.9rem;margin-top:10px"></div></label>
          <button class="btn" id="fBtn" disabled>Upload File</button>
        </form>
      </div>
      
      <div id="view-url" class="content">
        <form id="uForm">
            <input id="urlInput" placeholder="https://example.com/video.mp4" type="url" required>
            <input id="nameInput" placeholder="Custom Filename (Optional)">
            <button class="btn" id="uBtn">Start Remote Upload</button>
        </form>
      </div>

      <div class="progress-container" id="progBox">
          <div class="progress-header"><span id="progStatus">Uploading...</span><span id="progPct">0%</span></div>
          <div class="progress-track"><div class="progress-fill" id="bar"></div></div>
      </div>
      
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
      fIn.onchange=()=>{if(fIn.files.length){fName.innerText=fIn.files[0].name;fBtn.disabled=false;document.getElementById('fileBox').style.borderColor='var(--accent)';}else{fName.innerText='';fBtn.disabled=true;document.getElementById('fileBox').style.borderColor='var(--border)';}};
      
      function resetProg(){
          document.getElementById('progBox').style.display='none';
          document.getElementById('bar').style.width='0%';
          document.getElementById('progPct').innerText='0%';
      }

      function updateProg(pct, msg) {
          document.getElementById('progBox').style.display='block';
          document.getElementById('bar').style.width = pct + '%';
          document.getElementById('progPct').innerText = pct + '%';
          if(msg) document.getElementById('progStatus').innerText = msg;
      }

      // 1. File Upload
      document.getElementById('fForm').onsubmit=e=>{
          e.preventDefault(); 
          const fd=new FormData(); fd.append('file',fIn.files[0]); 
          const btn = fBtn; btn.disabled=true; btn.innerText='Uploading...';
          
          const xhr=new XMLHttpRequest(); 
          xhr.open('POST', '/upload-file');
          xhr.upload.onprogress=e=>{if(e.lengthComputable) updateProg(Math.round((e.loaded/e.total)*100), 'Uploading File...');};
          xhr.onload=()=>{
              btn.disabled=false; btn.innerText='Upload File'; resetProg();
              try{const d=JSON.parse(xhr.responseText); xhr.status===200?show(d):alert(d.error)}catch(e){alert('Error: '+xhr.responseText)}
          };
          xhr.onerror=()=>{ btn.disabled=false; btn.innerText='Upload File'; alert('Network Error'); };
          xhr.send(fd);
      };
      
      // 2. Remote Upload
      document.getElementById('uForm').onsubmit=async e=>{
          e.preventDefault(); 
          const btn = document.getElementById('uBtn');
          const url = document.getElementById('urlInput').value;
          const name = document.getElementById('nameInput').value;
          
          btn.disabled=true; btn.innerText='Processing...'; 
          updateProg(0, 'Connecting...');

          try {
              const response = await fetch('/upload-remote', {
                  method: 'POST',
                  headers: {'Content-Type': 'application/json'},
                  body: JSON.stringify({url, name})
              });

              if (!response.ok && response.headers.get('content-type') === 'application/json') {
                  const err = await response.json(); throw new Error(err.error);
              }

              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let buffer = '';

              while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  
                  buffer += decoder.decode(value, { stream: true });
                  const lines = buffer.split('\\n');
                  buffer = lines.pop();

                  for (const line of lines) {
                      if (!line.trim()) continue;
                      try {
                          const msg = JSON.parse(line);
                          if (msg.progress) {
                              updateProg(msg.progress, 'Transferring to Cloud...');
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
              btn.disabled=false; btn.innerText='Start Remote Upload'; resetProg();
          }
      };
      
      function copyTxt(btn, txt) {
          navigator.clipboard.writeText(txt).then(() => {
              const original = btn.innerText; btn.innerText = '✓';
              btn.style.background = '#22c55e'; btn.style.color='white';
              setTimeout(() => { 
                  btn.innerText = 'Copy'; 
                  btn.style.background = 'var(--card)';
                  btn.style.color = 'var(--accent)';
              }, 2000);
          });
      }

      function show(d){
          const res = document.getElementById('res');
          res.innerHTML = \`
            <div style="background:rgba(74,222,128,0.1);border:1px solid #22c55e;color:#4ade80;padding:10px;border-radius:8px;margin-bottom:15px;text-align:center;font-weight:500;">✓ Upload Successful!</div>
            <div class="link-row"><div class="link-label">R2 Direct Link (Auto Download)</div>
                <div class="link-group"><input readonly value="\${d.r2}" onclick="this.select()"><button class="copy-btn" onclick="copyTxt(this, '\${d.r2}')">Copy</button></div></div>
            <div style="font-size:0.75rem; color:#64748b; margin-top:8px; line-height:1.4;">* This link is optimized for high-speed streaming and will force download when clicked. Perfect for your Movie App.</div>
          \`;
      }
    </script></body></html>`, {headers:{"content-type":"text/html"}});
  }

  // --- ROUTE 2: UPLOAD FILE (High Speed & Parallel) ---
  if (req.method === "POST" && url.pathname === "/upload-file") {
    try {
      const formData = await req.formData();
      const file = formData.get("file") as File;
      if (!file) return Response.json({error:"No file"},{status:400});
      
      const ext = mimeToExt(file.type);
      const safeName = sanitize(file.name) || crypto.randomUUID();
      const fileName = `${safeName}.${ext}`;
      
      const upload = new Upload({
        client: s3Client,
        params: { 
            Bucket: R2_BUCKET_NAME, 
            Key: fileName, 
            Body: file.stream(), 
            ContentType: file.type,
            // Forced Download & High Cache
            ContentDisposition: `attachment; filename="${fileName}"`, 
            CacheControl: "public, max-age=31536000, immutable"
        },
        // OPTIMIZATION: Higher parallelism for speed
        queueSize: 8, partSize: 20 * 1024 * 1024 
      });
      await upload.done();

      const data = { id: crypto.randomUUID(), fileName, proxyUrl: `https://${url.host}/image/${fileName}`, r2Url: `https://${R2_PUBLIC_URL}/${fileName}`, downloadUrl: `https://${url.host}/download/${fileName}`, createdAt: new Date(), source: "File" };
      await kv.set(["uploads", MAX_DATE_MS - Date.now(), data.id], data);
      return Response.json({proxy:data.proxyUrl, r2:data.r2Url, dl:data.downloadUrl});
    } catch (e) { return Response.json({error:e.message},{status:500}); }
  }

  // --- ROUTE 3: REMOTE UPLOAD (High Speed & Parallel) ---
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
          const safeName = sanitize(n) || crypto.randomUUID();
          const fileName = `${safeName}.${ext}`;
          
          const upload = new Upload({
            client: s3Client,
            params: { 
                Bucket: R2_BUCKET_NAME, 
                Key: fileName, 
                Body: r.body as any, 
                ContentType: r.headers.get("content-type")||"application/octet-stream",
                // Forced Download & High Cache
                ContentDisposition: `attachment; filename="${fileName}"`, 
                CacheControl: "public, max-age=31536000, immutable"
            },
            // OPTIMIZATION: Higher parallelism for speed
            queueSize: 8, partSize: 20 * 1024 * 1024 
          });

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
    const isDownloadLink = url.pathname.startsWith("/download/");
    const key = url.pathname.substring(isDownloadLink ? 10 : 7);

    try {
      const r2Response = await fetch(`https://${R2_PUBLIC_URL}/${key}`, {
        headers: req.headers.get("range") ? { "range": req.headers.get("range")! } : {}
      });

      if (!r2Response.ok) return new Response("File not found on Cloud", { status: 404 });

      const responseHeaders = new Headers(r2Response.headers);
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      responseHeaders.set("Cache-Control", "public, max-age=31536000, immutable"); 

      if (isDownloadLink) {
        responseHeaders.set("Content-Disposition", `attachment; filename="${key}"`);
        responseHeaders.set("Content-Type", "application/octet-stream");
      } else {
        responseHeaders.set("Content-Disposition", `inline; filename="${key}"`);
      }

      return new Response(r2Response.body, { status: r2Response.status, headers: responseHeaders });
    } catch { 
      return new Response("Proxy Error", { status: 500 }); 
    }
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
          <div class="link-group"><input readonly value="${v.r2Url}" onclick="this.select()"><button class="copy-btn" onclick="copyTxt(this, '${v.r2Url}')">Copy</button></div>
        </div>`;
    }
    return new Response(`<!DOCTYPE html><html><head><title>History</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      body{background:#0f172a;color:#f1f5f9;font-family:sans-serif;padding:1rem;max-width:600px;margin:0 auto;}
      .head{display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem;border-bottom:1px solid #334155;padding-bottom:15px;} 
      a{color:#3b82f6;text-decoration:none;}
      .item{background:#1e293b;padding:1.2rem;border-radius:12px;margin-bottom:15px;border:1px solid #334155;box-shadow:0 4px 6px -1px rgba(0,0,0,0.1);}
      .top{display:flex;justify-content:space-between;align-items:center;}
      button{background:#ef4444;color:#fff;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:0.8rem;font-weight:500;}
      .meta{font-size:0.8rem;color:#94a3b8;margin:8px 0;}
      .link-group{display:flex;margin-top:8px;position:relative;}
      input{background:#0f172a;border:1px solid #334155;color:#60a5fa;flex:1;padding:8px;border-radius:8px;font-family:monospace;padding-right:60px;}
      .copy-btn{background:#1e293b;color:#3b82f6;border:1px solid #334155;position:absolute;right:4px;top:4px;bottom:4px;padding:0 12px;border-radius:6px;}
      .copy-btn:hover{background:#3b82f6;color:white;}
    </style><script>
      async function del(k){
        if(!confirm("Remove from history list? (File remains on Cloud)"))return;
        await fetch('/api/delete-history',{method:'POST',body:JSON.stringify({key:k})});
        location.reload();
      }
      function copyTxt(btn, txt) {
          navigator.clipboard.writeText(txt).then(() => {
              const original = btn.innerText; btn.innerText = '✓'; btn.style.color='#22c55e';
              setTimeout(() => {btn.innerText = original; btn.style.color='#3b82f6'}, 2000);
          });
      }
    </script></head><body>
      <div class="head"><h2>History</h2><a href="/">← Back to Upload</a></div>
      <div class="list">${items||'<div style="text-align:center;color:#64748b;margin-top:50px">No history found</div>'}</div>
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

// main.ts (v1.25 - FIX: Increased Remote Upload Speed)
import {
  S3Client,
  PutObjectCommand,
} from "npm:@aws-sdk/client-s3";
import { Upload } from "npm:@aws-sdk/lib-storage";
import { timingSafeEqual } from "jsr:@std/crypto/timing-safe-equal";

// --- 1. Check for Required Environment Variables ---
const REQUIRED_ENV_VARS = [
  "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", 
  "R2_BUCKET_NAME", "R2_PUBLIC_URL"
];

for (const varName of REQUIRED_ENV_VARS) {
  if (!Deno.env.get(varName)) {
    console.error(`[FATAL ERROR] Missing required environment variable: ${varName}`);
    if (typeof Deno.exit === 'function') {
      Deno.exit(1); 
    } else {
      throw new Error(`Missing required environment variable: ${varName}`);
    }
  }
}

// --- 2. Get Secrets from Deno Deploy Environment Variables ---
const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID")!;
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID")!;
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY")!;
const R2_BUCKET_NAME = Deno.env.get("R2_BUCKET_NAME")!;
const R2_PUBLIC_URL = Deno.env.get("R2_PUBLIC_URL")!;

const BASIC_AUTH_USER = Deno.env.get("BASIC_AUTH_USER");
const BASIC_AUTH_PASS = Deno.env.get("BASIC_AUTH_PASS");

// --- 3. Open Deno KV Database (for History) ---
const kv = await Deno.openKv();

// --- 4. Create S3 Client for R2 ---
const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

// --- 5. Helper Functions ---
const MAX_DATE_MS = 9999999999999; 

function mimeToExt(mimeType) {
  const mapping = {'video/mp4': 'mp4','video/webm': 'webm','video/x-matroska': 'mkv','video/quicktime': 'mov','video/avi': 'avi','image/jpeg': 'jpg','image/png': 'png','image/gif': 'gif','application/octet-stream': 'bin'};
  const simpleMime = mimeType.split(';')[0];
  return mapping[simpleMime] || 'bin';
}
function formatTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  let interval = seconds / 31536000;
  if (interval > 1) return Math.floor(interval) + " years ago";
  interval = seconds / 2592000;
  if (interval > 1) return Math.floor(interval) + " months ago";
  interval = seconds / 86400;
  if (interval > 1) return Math.floor(interval) + " days ago";
  interval = seconds / 3600;
  if (interval > 1) return Math.floor(interval) + " hours ago";
  interval = seconds / 60;
  if (interval > 1) return Math.floor(interval) + " minutes ago";
  return Math.floor(seconds) + " seconds ago";
}
function sanitizeFileName(name) {
  if (!name || name.trim() === "") return null;
  return name.replace(/\.[^/.]+$/, "").replace(/[?&#/\\]/g, "").replace(/[\s_]+/g, "-").trim() || null;
}


// --- 6. Start the Web Server ---
Deno.serve(async (req: Request) => {

  // --- BASIC AUTH CHECK ---
  if (BASIC_AUTH_USER && BASIC_AUTH_PASS) {
    const authHeader = req.headers.get("Authorization");
    if (authHeader) {
      const auth = authHeader.split(" ")[1];
      if (auth) {
        const [user, pass] = atob(auth).split(":");
        
        const encoder = new TextEncoder();
        const userBytes = encoder.encode(user);
        const passBytes = encoder.encode(pass);
        const expectedUserBytes = encoder.encode(BASIC_AUTH_USER);
        const expectedPassBytes = encoder.encode(BASIC_AUTH_PASS);

        const userMatch = userBytes.length === expectedUserBytes.length &&
          timingSafeEqual(userBytes, expectedUserBytes);
        const passMatch = passBytes.length === expectedPassBytes.length &&
          timingSafeEqual(passBytes, expectedPassBytes);

        if (!userMatch || !passMatch) {
          return new Response("Unauthorized", { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Restricted Area"' },});
        }
      } else {
        return new Response("Unauthorized", { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Restricted Area"' },});
      }
    } else {
      return new Response("Unauthorized", { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Restricted Area"' },});
    }
  }

  const url = new URL(req.url);

  // --- 6B. Serve the Uploader HTML Page ---
  if (req.method === "GET" && url.pathname === "/") {
    
    return new Response(
      `
      <!DOCTYPE html>
      <html>
      <head>
        <title>R2 Uploader</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          :root {
            --bg: #1a1a1a; --card-bg: #2a2a2a; --text: #f0f0f0; --text-dim: #888;
            --accent: #007aff; --accent-hover: #0056b3; --success: #34C759; --error: #FF3B30;
            --tab-inactive: #444; --border: #333; --progress-bg: #444; --input-bg: #1f1f1f;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            display: grid; place-items: center; min-height: 100vh; margin: 0;
            background: var(--bg); color: var(--text);
          }
          .container {
            width: 90%; max-width: 420px; background: var(--card-bg);
            padding: 1.5rem 2rem 2rem 2rem; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.3);
          }
          .header {
            display: flex; justify-content: space-between; align-items: center;
            margin-bottom: 1.5rem;
          }
          h2 { margin: 0; }
          #history-link { font-size: 0.9em; color: var(--accent); text-decoration: none; }
          .tab-buttons { display: flex; border-bottom: 2px solid var(--border); margin-bottom: 1.5rem; }
          .tab-btn {
            flex: 1; padding: 0.8rem; background: none; border: none; color: var(--text-dim);
            font-size: 1rem; cursor: pointer; border-bottom: 3px solid transparent;
          }
          .tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }
          .tab-content { display: none; }
          .tab-content.active { display: block; }
          form { display: flex; flex-direction: column; gap: 1rem; }
          #fileLabel {
            display: block; padding: 1.5rem 1rem; border: 2px dashed var(--text-dim);
            border-radius: 8px; cursor: pointer; text-align: center; transition: background 0.2s;
          }
          #fileLabel:hover { background: rgba(255,255,255,0.05); }
          #fileName { font-size: 0.9em; color: var(--text-dim); margin-top: 0.5rem; }
          
          .input-field {
            font-size: 1rem; padding: 0.8rem; background: var(--bg); border: 1px solid var(--border);
            border-radius: 8px; color: var(--text);
          }
          .submitBtn {
            font-size: 1rem; padding: 0.9rem; background: var(--accent); color: white;
            border: none; border-radius: 8px; cursor: pointer; transition: background 0.2s; margin-top: 0.5rem;
          }
          .submitBtn:hover { background: var(--accent-hover); }
          .submitBtn:disabled { background: var(--text-dim); cursor: not-allowed; }
          
          #progress-container { display: none; margin-top: 1rem; }
          #progress-bar-outer { width: 100%; background: var(--progress-bg); border-radius: 5px; overflow: hidden; }
          #progress-bar-inner {
            height: 10px; background: var(--accent); border-radius: 5px;
            width: 0%; transition: width 0.2s ease-out;
          }
          #progress-text { text-align: center; margin-top: 5px; font-size: 0.9em; color: var(--text-dim); }
          #progress-bar-inner.indeterminate {
            width: 100% !important;
            background: linear-gradient(90deg, var(--accent-hover) 0%, var(--accent) 50%, var(--accent-hover) 100%);
            background-size: 200% 100%;
            animation: indeterminate-scroll 1.5s linear infinite;
          }
          @keyframes indeterminate-scroll {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
          }
          
          #result { margin-top: 1.5rem; width: 100%; }
          .success { color: var(--success); text-align: center; display: block; margin-bottom: 1rem; }
          .error { color: var(--error); text-align: center; display: block; word-break: break-all;}
          
          .links-container { display: flex; flex-direction: column; gap: 0.75rem; }
          .link-box { display: flex; flex-direction: column; gap: 0.5rem; }
          .link-box strong { font-size: 0.9em; color: var(--text-dim); }
          .link-input-group { display: flex; }
          .link-box input[type="text"] {
            flex: 1; font-size: 0.9rem; padding: 0.5rem; background: var(--input-bg);
            border: 1px solid var(--border); border-right: none;
            color: var(--text); border-radius: 4px 0 0 4px;
        }
          .copy-btn {
            font-size: 0.9rem; padding: 0 0.75rem; background: var(--accent); color: white;
            border: 1px solid var(--accent); border-radius: 0 4px 4px 0; cursor: pointer;
          }
          .copy-btn:hover { background: var(--accent-hover); }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>R2 Uploader</h2>
            <a href="/history" id="history-link">View History</a>
          </div>
          
          <div class="tab-buttons">
            <button class="tab-btn active" data-tab="file">Upload File</button>
            <button class="tab-btn" data-tab="url">Remote URL</button>
          </div>

          <div id="tab-file" class="tab-content active">
            <form id="fileUploadForm">
              <label for="file" id="fileLabel">
                Click to select file
                <div id="fileName">No file chosen</div>
              </label>
              <input type="file" id="file" name="file" style="display:none;" required>
              <button type="submit" id="fileSubmitBtn" class="submitBtn" disabled>Upload File</button>
            </form>
          </div>
          
          <div id="tab-url" class="tab-content">
            <form id="urlUploadForm">
              <input type="url" id="urlInput" class="input-field" placeholder="Enter remote URL (http://...)" required>
              <input type="text" id="nameInput" class="input-field" placeholder="Custom file name (ASCII ONLY)">
              <button type="submit" id="urlSubmitBtn" class="submitBtn">Upload from URL</button>
            </form>
          </div>

          <div id="progress-container">
            <div id="progress-bar-outer">
              <div id="progress-bar-inner"></div>
            </div>
            <div id="progress-text">0%</div>
          </div>
          
          <div id="result"></div>
        </div>
        
        <script>
          const resultDiv = document.getElementById('result');
          const progressContainer = document.getElementById('progress-container');
          const progressBar = document.getElementById('progress-bar-inner');
          const progressText = document.getElementById('progress-text');
          
          document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
              document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
              btn.classList.add('active');
              document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
              document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
              resetUI();
            });
          });
          
          document.body.addEventListener('click', (e) => {
            if (e.target.classList.contains('copy-btn')) {
              const inputField = e.target.closest('.link-input-group').querySelector('input[type="text"]');
              if (inputField) {
                inputField.select();
                try {
                  navigator.clipboard.writeText(inputField.value);
                  e.target.textContent = 'Copied!';
                  setTimeout(() => { e.target.textContent = 'Copy'; }, 2000);
                } catch (err) { console.error('Copy failed', err); }
              }
            }
          });

          const fileForm = document.getElementById('fileUploadForm');
          const fileInput = document.getElementById('file');
          const fileNameDiv = document.getElementById('fileName');
          const fileSubmitBtn = document.getElementById('fileSubmitBtn');

          fileInput.addEventListener('change', () => {
            if (fileInput.files.length > 0) {
              fileNameDiv.textContent = fileInput.files[0].name;
              fileSubmitBtn.disabled = false;
            } else {
              fileNameDiv.textContent = 'No file chosen';
              fileSubmitBtn.disabled = true;
            }
            resetUI();
          });

          fileForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const file = fileInput.files[0];
            if (!file) return;
            setLoading(fileSubmitBtn, 'Uploading...', true);
            showProgress(0, '0%');
            const formData = new FormData();
            formData.append('file', file);
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/upload-file');
            xhr.upload.addEventListener('progress', (event) => {
              if (event.lengthComputable) {
                const percent = Math.round((event.loaded / event.total) * 100);
                showProgress(percent, percent + '%');
              }
            });
            xhr.addEventListener('load', () => {
              hideProgress();
              setLoading(fileSubmitBtn, 'Upload File', false);
              try {
                const data = JSON.parse(xhr.responseText);
                if (xhr.status === 200) {
                  setResult(data);
                } else {
                  setResult(data.error, 'error');
                }
              } catch (err) {
                setResult(\`Server error: \${xhr.responseText}\`, 'error');
              }
            });
            xhr.addEventListener('error', () => {
              hideProgress();
              setLoading(fileSubmitBtn, 'Upload File', false);
              setResult('Upload failed. Network error.', 'error');
            });
            xhr.send(formData);
          });

          const urlForm = document.getElementById('urlUploadForm');
          const urlInput = document.getElementById('urlInput');
          const nameInput = document.getElementById('nameInput'); 
          const urlSubmitBtn = document.getElementById('urlSubmitBtn');

          urlForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const remoteUrl = urlInput.value;
            const customName = nameInput.value; 
            if (!remoteUrl) return;

            setLoading(urlSubmitBtn, 'Uploading...', true);
            showProgress(100, 'Uploading from remote URL...', true);
            try {
              const response = await fetch('/upload-remote', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: remoteUrl, name: customName }) 
              });
              
              const data = await response.json();
              if (response.ok) {
                setResult(data);
              } else {
                setResult(data.error, 'error');
              }
            } catch (err) {
              setResult(\`Network error: \${err.message}\`, 'error');
            } finally {
              hideProgress();
              setLoading(urlSubmitBtn, 'Upload from URL', false);
            }
          });

          function setLoading(button, text, disabled = true) {
            button.disabled = disabled;
            button.textContent = text;
          }
          
          function setResult(data, type = 'success') {
            if (type === 'error') {
              resultDiv.innerHTML = \`<span class="error">\${data}</span>\`;
            } else {
              resultDiv.innerHTML = \`
                <span class="success">Upload Complete!</span>
                <div class="links-container">
                  <div class="link-box">
                    <strong>No VPN (Proxy Play)</strong>
                    <div class="link-input-group">
                      <input type="text" value="\${data.proxyUrl}" readonly>
                      <button class="copy-btn">Copy</button>
                    </div>
                  </div>
                  
                  <div class="link-box">
                    <strong>No VPN (Auto Download)</strong>
                    <div class="link-input-group">
                      <input type="text" value="\${data.downloadLink}" readonly>
                      <button class="copy-btn">Copy</button>
                    </div>
                  </div>
                  
                  <div class="link-box">
                    <strong>R2 Original (Auto Download)</strong>
                    <div class="link-input-group">
                      <input type="text" value="\${data.r2Url}" readonly>
                      <button class="copy-btn">Copy</button>
                    </div>
                  </div>
                </div>
              \`;
            }
          }
          
          function showProgress(percent, text, indeterminate = false) {
            progressContainer.style.display = 'block';
            progressBar.style.width = percent + '%';
            progressText.textContent = text;
            if (indeterminate) {
              progressBar.classList.add('indeterminate');
            } else {
              progressBar.classList.remove('indeterminate');
            }
          }
          
          function hideProgress() {
            progressContainer.style.display = 'none';
          }
          
          function resetUI() {
            resultDiv.innerHTML = '';
            hideProgress();
          }
        </script>
      </body>
      </html>
    `,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  // --- 6C. Handle File Upload (from computer) ---
  if (req.method === "POST" && url.pathname === "/upload-file") {
    try {
      const formData = await req.formData();
      const file = formData.get("file") as File;
      if (!file) return Response.json({ error: "No file found." }, { status: 400 });
      
      const contentType = file.type || "application/octet-stream";
      const extension = mimeToExt(contentType);
      
      const originalName = file.name || "file.bin";
      const sanitizedName = sanitizeFileName(originalName);
      const fileName = `${sanitizedName || crypto.randomUUID()}.${extension}`;
      
      const putCommand = new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: fileName,
        Body: file.stream(), 
        ContentType: contentType,
        ContentLength: file.size, 
        ContentDisposition: `attachment; filename="${fileName}"`,
      });
      await s3Client.send(putCommand);
      
      const proxyLink = `https://${url.host}/image/${fileName}`;
      const r2Link = `https://${R2_PUBLIC_URL}/${fileName}`;
      const downloadLink = `https://${url.host}/download/${fileName}`;
      
      const entry = {
        fileName,
        proxyUrl: proxyLink,
        r2Url: r2Link,
        downloadUrl: downloadLink,
        createdAt: new Date(),
        source: "File Upload"
      };
      
      await kv.set(["uploads", MAX_DATE_MS - Date.now(), crypto.randomUUID()], entry);

      return Response.json({ proxyUrl: proxyLink, r2Url: r2Link, downloadLink: downloadLink });
    } catch (err) {
      console.error("File Upload Error:", err);
      return Response.json({ error: `Upload failed: ${err.message}` }, { status: 500 });
    }
  }

  // --- 6D. Handle Remote URL Upload ---
  if (req.method === "POST" && url.pathname === "/upload-remote") {
    try {
      const { url: remoteUrl, name: customName } = await req.json();
      if (!remoteUrl) return Response.json({ error: "No URL provided." }, { status: 400 });
      
      const remoteResponse = await fetch(remoteUrl);
      if (!remoteResponse.ok) return Response.json({ error: `Remote server error: ${remoteResponse.status}` }, { status: 400 });
      if (!remoteResponse.body) return Response.json({ error: "Remote file has no content." }, { status: 400 });

      const contentType = remoteResponse.headers.get("Content-Type") || "application/octet-stream";
      const extension = mimeToExt(contentType);
      
      const sanitizedName = sanitizeFileName(customName);
      const fileName = `${sanitizedName || crypto.randomUUID()}.${extension}`;
      
      const parallelUploads3 = new Upload({
        client: s3Client,
        params: {
          Bucket: R2_BUCKET_NAME,
          Key: fileName,
          Body: remoteResponse.body as any,
          ContentType: contentType,
          ContentDisposition: `attachment; filename="${fileName}"`,
        },
        // --- FIX (v1.25): Increase queueSize and partSize for faster upload ---
        queueSize: 8, 
        partSize: 25 * 1024 * 1024, // Increased to 25MB
      });

      parallelUploads3.on("httpUploadProgress", (progress) => {
        console.log(`[Remote Upload: ${fileName}] Part: ${progress.part}, Loaded: ${progress.loaded} / ${progress.total}`);
      });

      await parallelUploads3.done();
      
      const proxyLink = `https://${url.host}/image/${fileName}`;
      const r2Link = `https://${R2_PUBLIC_URL}/${fileName}`;
      const downloadLink = `https://${url.host}/download/${fileName}`;

      const entry = {
        fileName,
        proxyUrl: proxyLink,
        r2Url: r2Link,
        downloadUrl: downloadLink,
        createdAt: new Date(),
        source: "Remote URL"
      };
      
      await kv.set(["uploads", MAX_DATE_MS - Date.now(), crypto.randomUUID()], entry);

      return Response.json({ proxyUrl: proxyLink, r2Url: r2Link, downloadLink: downloadLink });
    } catch (err) {
      console.error("Remote Upload Error:", err);
      return Response.json({ error: `Remote upload failed: ${err.message}` }, { status: 500 });
    }
  }

  // --- 6E. Handle the Proxy Request (GET /image/...) (For Playing) ---
  if (req.method === "GET" && url.pathname.startsWith("/image/")) {
    if (!R2_PUBLIC_URL) return new Response("R2_PUBLIC_URL not set.", { status: 500 });
    const fileName = url.pathname.substring("/image/".length);
    if (!fileName) return new Response("File name not specified.", { status: 400 });
    const r2Url = `https://${R2_PUBLIC_URL}/${fileName}`;
    const range = req.headers.get("Range");
    const fetchOptions = { method: "GET", headers: {} };
    if (range) fetchOptions.headers["Range"] = range;
    try {
      const r2Response = await fetch(r2Url, fetchOptions);
      if (!r2Response.ok && r2Response.status !== 206) {
        return new Response(r2Response.body, {status: r2Response.status,statusText: r2Response.statusText,});
      }
      const headers = new Headers(r2Response.headers);
      headers.set("Cache-Control", "public, max-age=604800"); 
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Accept-Ranges", "bytes");
      headers.set("Content-Disposition", `inline; filename="${fileName}"`);
      return new Response(r2Response.body, {status: r2Response.status,statusText: r2Response.statusText,headers: headers,});
    } catch (err) {
      console.error("Proxy Error (/image):", err);
      return new Response("Proxy failed.", { status: 500 });
    }
  }

  // --- 6F. Handle the Proxy Request (GET /download/...) (For Downloading) ---
  if (req.method === "GET" && url.pathname.startsWith("/download/")) {
    if (!R2_PUBLIC_URL) return new Response("R2_PUBLIC_URL not set.", { status: 500 });
    const fileName = url.pathname.substring("/download/".length);
    if (!fileName) return new Response("File name not specified.", { status: 400 });
    const r2Url = `https://${R2_PUBLIC_URL}/${fileName}`;
    const range = req.headers.get("Range");
    const fetchOptions = { method: "GET", headers: {} };
    if (range) fetchOptions.headers["Range"] = range;
    try {
      const r2Response = await fetch(r2Url, fetchOptions);
      if (!r2Response.ok && r2Response.status !== 206) {
        return new Response(r2Response.body, {status: r2Response.status,statusText: r2Response.statusText,});
      }
      const headers = new Headers(r2Response.headers);
      headers.set("Cache-Control", "public, max-age=604800"); 
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Accept-Ranges", "bytes");
      headers.set("Content-Disposition", `attachment; filename="${fileName}"`);
      return new Response(r2Response.body, {status: r2Response.status,statusText: r2Response.statusText,headers: headers,});
    } catch (err) {
      console.error("Proxy Error (/download):", err);
      return new Response("Proxy failed.", { status: 500 });
    }
  }

  // --- 6G. Handle the History Page (GET) ---
  if (req.method === "GET" && url.pathname === "/history") {
    
    let html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Upload History</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          :root {
            --bg: #1a1a1a; --card-bg: #2a2a2a; --text: #f0f0f0; --text-dim: #888;
            --accent: #007aff; --border: #333; --input-bg: #1f1f1f;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background: var(--bg); color: var(--text); margin: 0; padding: 1rem;
          }
          .container { max-width: 900px; margin: 2rem auto; }
          .header {
            display: flex; justify-content: space-between; align-items: center;
            border-bottom: 1px solid var(--border); padding-bottom: 1rem;
          }
          h2 { margin: 0; }
          a { color: var(--accent); text-decoration: none; }
          .history-list { 
            display: flex; flex-direction: column; gap: 1rem; margin-top: 1.5rem;
            max-height: 70vh; overflow-y: auto; padding-right: 5px;
          }
          .history-item {
            background: var(--card-bg); border-radius: 8px; padding: 1rem;
            display: flex; flex-direction: column; gap: 1rem;
          }
          .file-name { font-weight: bold; word-break: break-all; }
          .timestamp { font-size: 0.85em; color: var(--text-dim); }
          .links-container { display: flex; flex-direction: column; gap: 0.75rem; }
          .link-box { display: flex; flex-direction: column; gap: 0.5rem; }
          .link-box strong { font-size: 0.9em; color: var(--text-dim); }
          .link-input-group { display: flex; }
          .link-box input[type="text"] {
            flex: 1; font-size: 0.9rem; padding: 0.5rem; background: var(--input-bg);
            border: 1px solid var(--border); border-right: none;
            color: var(--text); border-radius: 4px 0 0 4px;
          }
          .copy-btn {
            font-size: 0.9rem; padding: 0 0.75rem; background: var(--accent); color: white;
            border: 1px solid var(--accent); border-radius: 0 4px 4px 0; cursor: pointer;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>Upload History</h2>
            <a href="/">Back to Uploader</a>
          </div>
          <div class="history-list" id="history-list">
    `;

    const entries = kv.list({ prefix: ["uploads"] });
    let count = 0;
    for await (const entry of entries) {
      const item = entry.value as any; 
      const createdAt = new Date(item.createdAt);
      html += `
        <div class="history-item">
          <div class="file-name">${item.fileName || 'N/A'}</div>
          <div class="timestamp">Uploaded: ${formatTimeAgo(createdAt)} (${item.source || 'N/A'})</div>
          <div class="links-container">
            <div class="link-box">
              <strong>No VPN (Proxy Play)</strong>
              <div class="link-input-group">
                <input type="text" value="${item.proxyUrl}" readonly>
                <button class="copy-btn">Copy</button>
              </div>
            </div>
            
            <div class="link-box">
              <strong>No VPN (Auto Download)</strong>
              <div class="link-input-group">
                <input type="text" value="${item.downloadUrl || 'N/A'}" readonly>
                <button class="copy-btn">Copy</button>
              </div>
            </div>
            
            <div class="link-box">
              <strong>R2 Original (Auto Download)</strong>
              <div class="link-input-group">
                <input type="text" value="${item.r2Url}" readonly>
                <button class="copy-btn">Copy</button>
              </div>
            </div>
          </div>
        </div>
      `;
      count++;
    }
    if (count === 0) html += `<div>No upload history found.</div>`;
    html += `
          </div> </div> <script>
          document.body.addEventListener('click', (e) => {
            if (e.target.classList.contains('copy-btn')) {
              const inputField = e.target.closest('.link-input-group').querySelector('input[type="text"]');
              if (inputField) {
                inputField.select();
                try {
                  navigator.clipboard.writeText(inputField.value);
                  e.target.textContent = 'Copied!';
                  setTimeout(() => { e.target.textContent = 'Copy'; }, 2000);
                } catch (err) { console.error('Copy failed', err); }
              }
            }
          });
        </script>
      </body>
      </html>
    `;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } },);
  }

  // --- 7. Return 404 for other paths ---
  return new Response("Not Found", { status: 404 });
});

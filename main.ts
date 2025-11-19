import { S3Client, PutObjectCommand } from "npm:@aws-sdk/client-s3";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner";
import { DOMParser } from "https://deno.land/x/deno_dom/deno-dom-wasm.ts";

const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID") || "";
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID") || "";
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY") || "";
const R2_BUCKET_NAME = Deno.env.get("R2_BUCKET_NAME") || "";
const R2_PUBLIC_URL_RAW = Deno.env.get("R2_PUBLIC_URL") || "";

Deno.serve(async (req) => {
  // Clean up Public URL
  let R2_PUBLIC_URL = R2_PUBLIC_URL_RAW.trim();
  if (R2_PUBLIC_URL && !R2_PUBLIC_URL.startsWith("http")) R2_PUBLIC_URL = `https://${R2_PUBLIC_URL}`;
  if (R2_PUBLIC_URL.endsWith("/")) R2_PUBLIC_URL = R2_PUBLIC_URL.slice(0, -1);

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    return new Response("Error: R2 Env Vars missing", { status: 500 });
  }

  const url = new URL(req.url);

  // 1. UI Section
  if (req.method === "GET" && url.pathname === "/") {
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>MediaFire to R2</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #f0f2f5; margin: 0; }
          .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.12); width: 100%; max-width: 400px; text-align: center; }
          h2 { color: #007bff; margin-top: 0; }
          p { color: #666; font-size: 14px; margin-bottom: 25px; }
          input { width: 100%; padding: 14px; margin-bottom: 15px; border: 1px solid #dfe6e9; border-radius: 8px; box-sizing: border-box; outline: none; transition: border 0.2s; }
          input:focus { border-color: #007bff; }
          button { width: 100%; padding: 14px; background: #007bff; color: white; border: none; border-radius: 8px; font-weight: 600; font-size: 16px; cursor: pointer; transition: background 0.2s; }
          button:hover { background: #0056b3; }
          #status { margin-top: 20px; font-size: 0.9rem; text-align: left; word-break: break-all; }
          .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.3); border-radius: 50%; border-top-color: #fff; animation: spin 1s infinite; margin-bottom: -3px;}
          @keyframes spin { to { transform: rotate(360deg); } }
          textarea { width: 100%; padding: 10px; background: #f8f9fa; border: 1px solid #ddd; border-radius: 6px; margin-top: 10px; font-size: 12px; box-sizing: border-box; resize: none; }
          .success-box { background:#e7f5ff; padding:15px; border-radius:8px; text-align:center; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>🔥 MediaFire to R2</h2>
          <p>Auto-Extract & Direct Upload</p>
          <form id="uploadForm">
            <input type="url" name="url" placeholder="Paste MediaFire Link" required />
            <input type="text" name="name" placeholder="Filename (Optional)" />
            <button type="submit">Start Transfer</button>
          </form>
          <div id="status"></div>
        </div>
        <script>
          const form = document.querySelector('#uploadForm');
          const status = document.querySelector('#status');
          
          form.onsubmit = async (e) => {
            e.preventDefault();
            const btn = form.querySelector('button');
            const oldText = btn.innerText;
            btn.disabled = true;
            btn.innerHTML = '<div class="spinner"></div> Processing...';
            status.innerHTML = '';

            const formData = new FormData(form);
            try {
              const res = await fetch('/upload', { method: 'POST', body: formData });
              const data = await res.json();
              
              if(data.success) {
                status.innerHTML = \`
                  <div class="success-box">
                    <h3 style="color:#007bff; margin:0 0 5px 0;">✅ Saved to R2!</h3>
                    <p style="font-size:12px; color:#555; margin-bottom:10px;">\${data.fileName}</p>
                    <textarea rows="3" onclick="this.select()">\${data.link}</textarea>
                    <button onclick="location.reload()" style="margin-top:10px; font-size:12px; padding:8px; background:#17a2b8; border:none; border-radius:4px; color:white; cursor:pointer;">Transfer Another</button>
                  </div>
                \`;
                btn.style.display = 'none';
              } else {
                status.innerHTML = '<div style="color:red; text-align:center; padding:10px;">❌ Error: ' + data.error + '</div>';
                btn.disabled = false;
                btn.innerText = oldText;
              }
            } catch(err) {
              status.innerHTML = '<div style="color:red; text-align:center; padding:10px;">Network Error</div>';
              btn.disabled = false;
              btn.innerText = oldText;
            }
          };
        </script>
      </body>
      </html>
    `;
    return new Response(html, { headers: { "content-type": "text/html" } });
  }

  // 2. Upload Logic
  if (req.method === "POST" && url.pathname === "/upload") {
    try {
      const formData = await req.formData();
      let remoteUrl = formData.get("url") as string;
      let fileName = formData.get("name") as string;

      if (!remoteUrl) throw new Error("URL is required");

      // --- MEDIAFIRE EXTRACTION START ---
      if (remoteUrl.includes("mediafire.com")) {
        const mfRes = await fetch(remoteUrl, {
             headers: { "User-Agent": "Mozilla/5.0" }
        });
        const html = await mfRes.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        
        const downloadButton = doc?.getElementById("downloadButton");
        const directLink = downloadButton?.getAttribute("href");
        
        if (!directLink) throw new Error("Could not extract direct link from MediaFire.");
        remoteUrl = directLink;
      }
      // --- MEDIAFIRE EXTRACTION END ---

      // Use extracted URL to get stream
      const remoteRes = await fetch(remoteUrl);
      if (!remoteRes.body) throw new Error("Failed to fetch file stream.");
      
      // Determine Filename
      if (!fileName) {
          const disp = remoteRes.headers.get("content-disposition");
          if (disp && disp.includes("filename=")) {
              fileName = disp.split("filename=")[1].replace(/"/g, "");
          } else {
              fileName = remoteUrl.split('/').pop()?.split('?')[0] || `file-${Date.now()}.bin`;
          }
      }

      const contentType = remoteRes.headers.get("content-type") || "application/octet-stream";

      // Initialize R2 S3 Client
      const s3 = new S3Client({
        region: "auto",
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
      });

      // Create Signed URL for Direct Upload (Fastest Method)
      const command = new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: fileName,
        ContentType: contentType,
        ContentDisposition: `attachment; filename="${fileName}"`, // Auto Download Header
      });
      
      const signedUploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

      // Pipe Stream to R2
      const uploadRes = await fetch(signedUploadUrl, {
        method: "PUT",
        body: remoteRes.body,
        headers: {
            "Content-Type": contentType,
            "Content-Disposition": `attachment; filename="${fileName}"`,
        }
      });

      if (!uploadRes.ok) throw new Error(`Upload Failed: ${uploadRes.statusText}`);

      return Response.json({
        success: true,
        fileName: fileName,
        link: `${R2_PUBLIC_URL}/${fileName}`
      });

    } catch (err) {
      return Response.json({ success: false, error: err.message });
    }
  }

  return new Response("Not Found", { status: 404 });
});

import { S3Client } from "npm:@aws-sdk/client-s3";
import { Upload } from "npm:@aws-sdk/lib-storage";
import { DOMParser } from "https://deno.land/x/deno_dom/deno-dom-wasm.ts";

// --- Configuration ---
const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID") || "";
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID") || "";
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY") || "";
const R2_BUCKET_NAME = Deno.env.get("R2_BUCKET_NAME") || "";
const R2_PUBLIC_URL_RAW = Deno.env.get("R2_PUBLIC_URL") || "";

Deno.serve(async (req) => {
  // Ensure Public URL format
  let R2_PUBLIC_URL = R2_PUBLIC_URL_RAW.trim();
  if (R2_PUBLIC_URL && !R2_PUBLIC_URL.startsWith("http")) R2_PUBLIC_URL = `https://${R2_PUBLIC_URL}`;
  if (R2_PUBLIC_URL.endsWith("/")) R2_PUBLIC_URL = R2_PUBLIC_URL.slice(0, -1);

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    return new Response("Error: Missing R2 Environment Variables.", { status: 500 });
  }

  const url = new URL(req.url);

  // 1. UI Section
  if (req.method === "GET" && url.pathname === "/") {
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>R2 Speed Uploader</title>
        <style>
          body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #f0f2f5; margin: 0; }
          .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.12); width: 100%; max-width: 400px; text-align: center; }
          h2 { color: #d35400; margin-top: 0; }
          p { color: #666; font-size: 14px; margin-bottom: 20px; }
          input { width: 100%; padding: 14px; margin-bottom: 15px; border: 1px solid #dfe6e9; border-radius: 8px; box-sizing: border-box; outline: none; transition: 0.2s; }
          input:focus { border-color: #e67e22; }
          button { width: 100%; padding: 14px; background: #e67e22; color: white; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; transition: 0.2s; }
          button:hover { background: #d35400; }
          #status { margin-top: 20px; text-align: left; word-break: break-all; }
          .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid rgba(0,0,0,0.2); border-radius: 50%; border-top-color: #e67e22; animation: spin 1s infinite; margin-bottom: -3px;}
          @keyframes spin { to { transform: rotate(360deg); } }
          textarea { width: 100%; padding: 10px; background: #fff3cd; border: 1px solid #ffeeba; border-radius: 6px; margin-top: 10px; font-size: 12px; resize: none; box-sizing: border-box; color: #856404; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>⚡ R2 Multipart</h2>
          <p>High Speed Transfer for MediaFire</p>
          <form id="uploadForm">
            <input type="url" name="url" placeholder="Paste MediaFire or Direct Link" required />
            <input type="text" name="name" placeholder="Filename (Optional)" />
            <button type="submit">Start Upload</button>
          </form>
          <div id="status"></div>
        </div>
        <script>
          const form = document.querySelector('#uploadForm');
          const status = document.querySelector('#status');
          
          form.onsubmit = async (e) => {
            e.preventDefault();
            const btn = form.querySelector('button');
            const originalText = btn.innerText;
            btn.disabled = true;
            btn.innerHTML = '<div class="spinner"></div> Processing...';
            status.innerHTML = '';

            const formData = new FormData(form);
            try {
              const res = await fetch('/upload', { method: 'POST', body: formData });
              const data = await res.json();
              
              if(data.success) {
                status.innerHTML = \`
                  <div style="text-align:center;">
                    <h3 style="color:#28a745; margin:0 0 5px 0;">✅ Upload Complete</h3>
                    <p style="font-size:12px; color:#555;">\${data.fileName}</p>
                    <textarea rows="3" onclick="this.select()">\${data.link}</textarea>
                    <button onclick="location.reload()" style="margin-top:15px; padding:8px 15px; background:#28a745; color:white; border:none; border-radius:4px; cursor:pointer;">Upload Another</button>
                  </div>
                \`;
                btn.style.display = 'none';
              } else {
                status.innerHTML = '<div style="color:red; text-align:center; padding:10px;">❌ Error: ' + data.error + '</div>';
                btn.disabled = false;
                btn.innerText = originalText;
              }
            } catch(err) {
              status.innerHTML = '<div style="color:red; text-align:center; padding:10px;">Network Error</div>';
              btn.disabled = false;
              btn.innerText = originalText;
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

      // --- MediaFire Link Extraction ---
      if (remoteUrl.includes("mediafire.com")) {
        const mfRes = await fetch(remoteUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
        const html = await mfRes.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        const directLink = doc?.getElementById("downloadButton")?.getAttribute("href");
        if (!directLink) throw new Error("Could not extract MediaFire link.");
        remoteUrl = directLink;
      }

      const remoteRes = await fetch(remoteUrl);
      if (!remoteRes.body) throw new Error("Failed to fetch remote stream.");
      
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

      // Initialize S3 (R2)
      const s3 = new S3Client({
        region: "auto",
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
      });

      // Multipart Upload Strategy
      const parallelUpload = new Upload({
        client: s3,
        params: {
          Bucket: R2_BUCKET_NAME,
          Key: fileName,
          Body: remoteRes.body,
          ContentType: contentType,
          ContentDisposition: `attachment; filename="${fileName}"`, // Force Download Header
        },
        queueSize: 4, // 4 Concurrent uploads (Faster)
        partSize: 10 * 1024 * 1024, // 10MB Parts
      });

      await parallelUpload.done();

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

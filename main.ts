import { S3Client, PutObjectCommand } from "npm:@aws-sdk/client-s3";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner";

// --- R2 Config ---
const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID") || "";
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID") || "";
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY") || "";
const R2_BUCKET_NAME = Deno.env.get("R2_BUCKET_NAME") || "";
const R2_PUBLIC_URL_RAW = Deno.env.get("R2_PUBLIC_URL") || "";

Deno.serve(async (req) => {
  // Fix URL: Ensure it starts with https:// and has no trailing slash
  let R2_PUBLIC_URL = R2_PUBLIC_URL_RAW.trim();
  if (R2_PUBLIC_URL && !R2_PUBLIC_URL.startsWith("http")) {
    R2_PUBLIC_URL = `https://${R2_PUBLIC_URL}`;
  }
  if (R2_PUBLIC_URL.endsWith("/")) {
    R2_PUBLIC_URL = R2_PUBLIC_URL.slice(0, -1);
  }

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    return new Response("Error: R2 Env Vars missing", { status: 500 });
  }

  const url = new URL(req.url);

  // 1. Frontend UI
  if (req.method === "GET" && url.pathname === "/") {
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>R2 Auto-Downloader</title>
        <style>
          body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #f0f2f5; margin: 0; }
          .box { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 100%; max-width: 400px; text-align: center; }
          h2 { color: #2d3436; margin-bottom: 10px; }
          p { color: #636e72; font-size: 14px; margin-bottom: 20px; }
          input { width: 100%; padding: 12px; margin-bottom: 15px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; outline: none; }
          input:focus { border-color: #0984e3; }
          button { width: 100%; padding: 12px; background: #0984e3; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; transition: 0.2s; }
          button:hover { background: #74b9ff; }
          
          #status { margin-top: 20px; font-size: 0.9rem; color: #555; word-break: break-all; text-align: left; }
          .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.3); border-radius: 50%; border-top-color: #fff; animation: spin 1s ease-in-out infinite; margin-bottom: -3px; margin-right: 5px;}
          @keyframes spin { to { transform: rotate(360deg); } }
          
          .success-box { background: #e6fffa; border: 1px solid #38b2ac; padding: 15px; border-radius: 8px; text-align: center; }
          .copy-area { width: 100%; padding: 8px; margin-top: 10px; border: 1px dashed #38b2ac; background: #fff; font-size: 12px; color: #333; box-sizing: border-box; }
        </style>
      </head>
      <body>
        <div class="box">
          <h2>⚡ R2 Direct Upload</h2>
          <p>Creates Direct Download Links</p>
          <form id="form">
            <input type="url" name="url" placeholder="Paste Remote File URL" required />
            <input type="text" name="name" placeholder="Filename (e.g. movie.mp4)" />
            <button type="submit">Start Upload</button>
          </form>
          <div id="status"></div>
        </div>
        <script>
          const form = document.querySelector('#form');
          const status = document.querySelector('#status');
          
          form.onsubmit = async (e) => {
            e.preventDefault();
            const btn = form.querySelector('button');
            const originalBtnText = btn.innerText;
            
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
                    <h3 style="color:#2c7a7b; margin:0 0 5px 0;">✅ Uploaded!</h3>
                    <p style="font-size:12px; margin-bottom:10px;">\${data.fileName}</p>
                    <textarea class="copy-area" rows="3" onclick="this.select()">\${data.link}</textarea>
                    <button onclick="location.reload()" style="margin-top:10px; background:#38b2ac; font-size:13px; padding:8px;">Upload Another</button>
                  </div>
                \`;
                btn.style.display = 'none'; // Hide original button
              } else {
                status.innerHTML = '<div style="color:red; text-align:center;">❌ Error: ' + data.error + '</div>';
                btn.disabled = false;
                btn.innerText = originalBtnText;
              }
            } catch(err) {
              status.innerHTML = '<div style="color:red; text-align:center;">Connection Error</div>';
              btn.disabled = false;
              btn.innerText = originalBtnText;
            }
          };
        </script>
      </body>
      </html>
    `;
    return new Response(html, { headers: { "content-type": "text/html" } });
  }

  // 2. Backend Logic
  if (req.method === "POST" && url.pathname === "/upload") {
    try {
      const formData = await req.formData();
      const remoteUrl = formData.get("url") as string;
      let fileName = formData.get("name") as string;

      if (!remoteUrl) throw new Error("URL required");
      if (!fileName) fileName = remoteUrl.split('/').pop() || `file-${Date.now()}.bin`;

      // Initialize S3 Client
      const s3 = new S3Client({
        region: "auto",
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: R2_ACCESS_KEY_ID,
            secretAccessKey: R2_SECRET_ACCESS_KEY,
        },
      });

      // Fetch Remote Stream
      const remoteRes = await fetch(remoteUrl);
      if (!remoteRes.body) throw new Error("Remote stream failed");
      
      const contentType = remoteRes.headers.get("content-type") || "application/octet-stream";

      // 🔥 KEY FIX: Add Content-Disposition for Auto Download 🔥
      const command = new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: fileName,
        ContentType: contentType,
        ContentDisposition: `attachment; filename="${fileName}"`, // This forces download
      });
      
      // Get Signed URL for Upload
      const signedUploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

      // Direct Stream Upload
      const uploadRes = await fetch(signedUploadUrl, {
        method: "PUT",
        body: remoteRes.body,
        headers: {
            "Content-Type": contentType,
            "Content-Disposition": `attachment; filename="${fileName}"`, // Must match signed params
        }
      });

      if (!uploadRes.ok) {
        throw new Error(`Upload Failed: ${uploadRes.statusText}`);
      }

      // Construct Final Link (Corrected format)
      const finalLink = `${R2_PUBLIC_URL}/${fileName}`;

      return Response.json({
        success: true,
        fileName: fileName,
        link: finalLink
      });

    } catch (err) {
      console.error(err);
      return Response.json({ success: false, error: err.message });
    }
  }

  return new Response("Not Found", { status: 404 });
});

import { S3Client, PutObjectCommand } from "npm:@aws-sdk/client-s3";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner";

// --- R2 Config ---
const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID") || "";
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID") || "";
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY") || "";
const R2_BUCKET_NAME = Deno.env.get("R2_BUCKET_NAME") || "";
const R2_PUBLIC_URL = Deno.env.get("R2_PUBLIC_URL") || "";

Deno.serve(async (req) => {
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    return new Response("Error: R2 Env Vars missing", { status: 500 });
  }

  const url = new URL(req.url);

  // 1. Frontend UI (Simple & Fast)
  if (req.method === "GET" && url.pathname === "/") {
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>R2 Speed Stream</title>
        <style>
          body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #f0f2f5; margin: 0; }
          .box { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 100%; max-width: 400px; text-align: center; }
          input { width: 100%; padding: 12px; margin-bottom: 15px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; }
          button { width: 100%; padding: 12px; background: #f48120; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; }
          button:hover { background: #e67300; }
          #status { margin-top: 15px; font-size: 0.9rem; color: #555; word-break: break-all; }
          .spinner { display: inline-block; width: 20px; height: 20px; border: 3px solid rgba(0,0,0,0.1); border-radius: 50%; border-top-color: #f48120; animation: spin 1s ease-in-out infinite; margin-bottom: -5px; margin-right: 5px;}
          @keyframes spin { to { transform: rotate(360deg); } }
        </style>
      </head>
      <body>
        <div class="box">
          <h2 style="color:#333;">⚡ R2 Speed Stream</h2>
          <form id="form">
            <input type="url" name="url" placeholder="Remote File URL" required />
            <input type="text" name="name" placeholder="Filename (Optional)" />
            <button type="submit">Upload Fast</button>
          </form>
          <div id="status"></div>
        </div>
        <script>
          const form = document.querySelector('#form');
          const status = document.querySelector('#status');
          
          form.onsubmit = async (e) => {
            e.preventDefault();
            const btn = form.querySelector('button');
            btn.disabled = true;
            btn.innerHTML = '<div class="spinner"></div> Streaming...';
            status.innerHTML = '';

            const formData = new FormData(form);
            try {
              const res = await fetch('/upload', { method: 'POST', body: formData });
              const data = await res.json();
              if(data.success) {
                status.innerHTML = '<div style="color:green">✅ Done!</div><br><a href="' + data.link + '" target="_blank">' + data.link + '</a>';
              } else {
                status.innerHTML = '<div style="color:red">❌ Error: ' + data.error + '</div>';
              }
            } catch(err) {
              status.innerHTML = '<div style="color:red">Connection Error</div>';
            }
            btn.disabled = false;
            btn.innerText = 'Upload Fast';
          };
        </script>
      </body>
      </html>
    `;
    return new Response(html, { headers: { "content-type": "text/html" } });
  }

  // 2. Backend Logic (Presigned URL + Direct Fetch)
  if (req.method === "POST" && url.pathname === "/upload") {
    try {
      const formData = await req.formData();
      const remoteUrl = formData.get("url") as string;
      let fileName = formData.get("name") as string;

      if (!remoteUrl) throw new Error("URL required");
      if (!fileName) fileName = remoteUrl.split('/').pop() || `file-${Date.now()}.bin`;

      // Step A: Initialize S3 Client
      const s3 = new S3Client({
        region: "auto",
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: R2_ACCESS_KEY_ID,
            secretAccessKey: R2_SECRET_ACCESS_KEY,
        },
      });

      // Step B: Fetch Remote Stream (Get the pipe ready)
      console.log("Fetching remote...");
      const remoteRes = await fetch(remoteUrl);
      if (!remoteRes.body) throw new Error("Remote stream failed");

      // Step C: Generate a Signed URL (The 'Ticket' to upload directly)
      // This allows us to use simple 'fetch' for the upload, bypassing SDK overhead
      const command = new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: fileName,
        ContentType: remoteRes.headers.get("content-type") || "application/octet-stream",
        ContentLength: Number(remoteRes.headers.get("content-length")), // Pass length if available for progress/speed
      });
      
      // Get a temporary upload URL valid for 1 hour
      const signedUploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

      // Step D: Direct Stream Pipe (The Fast Part!)
      console.log("Streaming to R2...");
      const uploadRes = await fetch(signedUploadUrl, {
        method: "PUT",
        body: remoteRes.body, // <--- Direct Pipe!
        headers: {
            "Content-Type": remoteRes.headers.get("content-type") || "application/octet-stream",
            // R2 requires Content-Length if signed with it, but fetch handles body stream automatically usually
        }
      });

      if (!uploadRes.ok) {
        throw new Error(`R2 Upload Failed: ${uploadRes.statusText}`);
      }

      return Response.json({
        success: true,
        fileName: fileName,
        link: `${R2_PUBLIC_URL}/${fileName}`
      });

    } catch (err) {
      console.error(err);
      return Response.json({ success: false, error: err.message });
    }
  }

  return new Response("Not Found", { status: 404 });
});

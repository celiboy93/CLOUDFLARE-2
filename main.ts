import { S3Client, GetObjectCommand } from "npm:@aws-sdk/client-s3";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner";

const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID");
const ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID");
const SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY");
const BUCKET_NAME = Deno.env.get("R2_BUCKET_NAME");

const S3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: ACCESS_KEY_ID!,
    secretAccessKey: SECRET_ACCESS_KEY!,
  },
});

Deno.serve(async (req) => {
  const url = new URL(req.url);
  let fileName = decodeURIComponent(url.pathname.slice(1));
  let isProxyMode = false;

  // Check if user wants Proxy Mode (VPN Free)
  // Link format: domain.com/play/movie.mp4
  if (url.pathname.startsWith("/play/")) {
    isProxyMode = true;
    fileName = decodeURIComponent(url.pathname.replace("/play/", ""));
  }

  if (fileName === "" || fileName === "favicon.ico") {
    return new Response("Server Ready", { status: 200 });
  }

  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
    });

    // Generate Signed URL (3 Hours)
    const signedUrl = await getSignedUrl(S3, command, { expiresIn: 10800 });

    if (isProxyMode) {
      // PROXY MODE: Deno fetches and streams to user (Uses Deno Bandwidth)
      const response = await fetch(signedUrl);
      
      // Pass original headers (Content-Type, Content-Length) for video players
      const newHeaders = new Headers(response.headers);
      newHeaders.set("Access-Control-Allow-Origin", "*"); // Allow CORS

      return new Response(response.body, {
        status: response.status,
        headers: newHeaders,
      });

    } else {
      // REDIRECT MODE: Direct to R2 (Saves Bandwidth)
      return Response.redirect(signedUrl, 302);
    }

  } catch (error) {
    return new Response("File not found", { status: 404 });
  }
});

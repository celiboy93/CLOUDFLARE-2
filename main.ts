import { S3Client, GetObjectCommand } from "npm:@aws-sdk/client-s3";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner";

const R2_ACCOUNT_ID = "YOUR_ACCOUNT_ID_HERE";
const ACCESS_KEY_ID = "YOUR_ACCESS_KEY_HERE";
const SECRET_ACCESS_KEY = "YOUR_SECRET_KEY_HERE";
const BUCKET_NAME = "YOUR_BUCKET_NAME_HERE";

const S3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
});

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const fileName = url.pathname.slice(1);

  if (fileName === "" || fileName === "favicon.ico") {
    return new Response("Server Ready", { status: 200 });
  }

  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
    });

    // 3 Hours = 10800 Seconds
    const signedUrl = await getSignedUrl(S3, command, { expiresIn: 10800 });

    return Response.redirect(signedUrl, 302);

  } catch (error) {
    return new Response("File not found", { status: 404 });
  }
});

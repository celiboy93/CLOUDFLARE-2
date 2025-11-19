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
  const fileName = decodeURIComponent(url.pathname.slice(1));

  if (fileName === "" || fileName === "favicon.ico") {
    return new Response("Movie Server Running", { status: 200 });
  }

  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
    });

    // 10800 seconds = 3 hours
    const signedUrl = await getSignedUrl(S3, command, { expiresIn: 10800 });

    return Response.redirect(signedUrl, 302);

  } catch (error) {
    return new Response("File not found", { status: 404 });
  }
});

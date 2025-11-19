// main.ts
import { S3Client, GetObjectCommand } from "npm:@aws-sdk/client-s3";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner";

Deno.serve(async (req: Request) => {
  // 1. Retrieve Environment Variables
  const ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID");
  const ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID");
  const SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY");
  const BUCKET_NAME = Deno.env.get("R2_BUCKET_NAME");

  // 2. Validate Configuration
  if (!ACCOUNT_ID || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY || !BUCKET_NAME) {
    console.error("Missing Environment Variables in Deno Deploy settings.");
    return new Response("Internal Server Error: Missing Configuration", { status: 500 });
  }

  // 3. Parse Query Parameters
  const url = new URL(req.url);
  const fileName = url.searchParams.get("file");

  if (!fileName) {
    return new Response("Error: Please provide a file name. Example: /?file=video.mp4", { status: 400 });
  }

  try {
    // 4. Initialize S3 Client for Cloudflare R2
    const S3 = new S3Client({
      region: "auto",
      endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET_ACCESS_KEY,
      },
    });

    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
    });

    // 5. Generate Presigned URL (Valid for 1 hour / 3600 seconds)
    const signedUrl = await getSignedUrl(S3, command, { expiresIn: 3600 });

    // 6. Redirect user to the Cloudflare URL directly
    return Response.redirect(signedUrl);

  } catch (error) {
    console.error("Error generating signed URL:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
});

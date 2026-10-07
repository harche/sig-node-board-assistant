// Uploads a release zip to the Chrome Web Store and submits it for review, with the Chrome Web Store API v2.
// `node scripts/publish-cws.mjs <zip>`. The chrome-web-store workflow runs it on each release's zip, which
// `npm run zip` built and checked is not a test build.
// Env: CWS_SERVICE_ACCOUNT_KEY (the JSON key of the service account added to the publisher in the Developer
// Dashboard), CWS_PUBLISHER_ID, CWS_EXTENSION_ID.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const key = JSON.parse(env("CWS_SERVICE_ACCOUNT_KEY"));
const item = `publishers/${env("CWS_PUBLISHER_ID")}/items/${env("CWS_EXTENSION_ID")}`;
if (!process.argv[2]) throw new Error("usage: node scripts/publish-cws.mjs <zip>");
const zip = readFileSync(process.argv[2]);

// An access token from a JWT signed with the service account's key (OAuth 2.0 JWT bearer grant).
const b64url = (data) => Buffer.from(data).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const claims = {
  iss: key.client_email,
  scope: "https://www.googleapis.com/auth/chromewebstore",
  aud: key.token_uri,
  iat: now,
  exp: now + 3600,
};
const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");
const tokenRes = await fetch(key.token_uri, {
  method: "POST",
  body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: `${unsigned}.${signature}`,
  }),
});
if (!tokenRes.ok) throw new Error(`token: ${tokenRes.status} ${await tokenRes.text()}`);
const token = (await tokenRes.json()).access_token;

const call = async (method, url, body) => {
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${text}`);
  return JSON.parse(text);
};
const api = "https://chromewebstore.googleapis.com";

const upload = await call("POST", `${api}/upload/v2/${item}:upload`, zip);
let state = upload.uploadState;
// A big package is processed asynchronously: poll until it settles.
for (let i = 0; state === "IN_PROGRESS" && i < 30; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  state = (await call("GET", `${api}/v2/${item}:fetchStatus`)).lastAsyncUploadState;
}
if (state !== "SUCCEEDED") throw new Error(`upload ended in ${state}: ${JSON.stringify(upload)}`);
console.info(`uploaded ${upload.crxVersion}`);

const published = await call("POST", `${api}/v2/${item}:publish`);
console.info(`submitted for review: ${published.state}`);
if (published.warningInfo) console.warn(JSON.stringify(published.warningInfo));

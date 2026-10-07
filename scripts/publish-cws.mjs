// Uploads sig-node-board-assistant-<version>.zip to the Chrome Web Store and submits it for review, with the Chrome
// Web Store API v2. The release workflow runs it after `npm run zip`, which refuses a test build.
// Env: CWS_ACCESS_TOKEN (scope https://www.googleapis.com/auth/chromewebstore), CWS_PUBLISHER_ID, CWS_EXTENSION_ID.
import { readFileSync } from "node:fs";

const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const token = env("CWS_ACCESS_TOKEN");
const item = `publishers/${env("CWS_PUBLISHER_ID")}/items/${env("CWS_EXTENSION_ID")}`;
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const zip = readFileSync(`sig-node-board-assistant-${version}.zip`);

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

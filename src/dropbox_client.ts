// worker/src/dropbox_client.ts (Example)
import { Dropbox } from "dropbox";
// Depending on your worker environment (Node.js/Cloudflare/etc.), you may need 
// a specific fetch implementation, e.g., 'undici' for Node.
import { fetch } from 'undici'; 

// Ensure DROPBOX_REFRESH_TOKEN, DROPBOX_APP_KEY, and DROPBOX_APP_SECRET are set in worker environment
if (!process.env.DROPBOX_REFRESH_TOKEN || !process.env.DROPBOX_APP_KEY || !process.env.DROPBOX_APP_SECRET) {
  throw new Error("Missing Dropbox worker credentials for automatic token refresh.");
}

export const dbxWorker = new Dropbox({
  clientId: process.env.DROPBOX_APP_KEY,
  clientSecret: process.env.DROPBOX_APP_SECRET,
  refreshToken: process.env.DROPBOX_REFRESH_TOKEN, 
  fetch,
});
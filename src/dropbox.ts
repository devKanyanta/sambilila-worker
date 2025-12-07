import fetch from "node-fetch";

export async function downloadFromDropbox(url: string): Promise<Buffer> {
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error("Failed to download PDF from Dropbox");
  }

  return Buffer.from(await res.arrayBuffer());
}

// Which addresses the web client loads as pictures. Profile pictures and cast embeds are
// URLs that people sign into their messages; the client fetches them straight from wherever
// they point, so only plain https URLs are ever used.

const IMAGE_PATH = /\.(png|jpe?g|gif|webp|avif)$/i;
// Cloudflare Images, where the Farcaster app stores uploads. Its URLs have no file extension.
const IMAGE_HOSTS = new Set(["imagedelivery.net"]);

export function httpsUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" && u.hostname ? u.href : undefined;
  } catch {
    return undefined;
  }
}

// An embed shown as an image: an https URL whose path names an image file, or an upload host.
export function isImageEmbed(raw: string): boolean {
  const href = httpsUrl(raw);
  if (!href) return false;
  const u = new URL(href);
  return IMAGE_PATH.test(u.pathname) || IMAGE_HOSTS.has(u.hostname);
}

// The letter shown in place of a missing profile picture.
export function initial(name: string | undefined): string {
  const c = Array.from((name ?? "").replace(/^@/, "").trim())[0];
  return c ? c.toUpperCase() : "#";
}

// Society node: a node someone else runs, reached with a per-member token.
// Invite link: https://spider333.github.io/outpost/app/#node=<url-encoded base URL>&token=<token>
// The token sits in the fragment, so the browser never sends it to the page's host.

export interface Society {
  node: string; // base URL, no trailing slash
  token: string;
}

// https only, except a node on this machine (for testing).
export function checkNodeUrl(s: string): string {
  let u: URL;
  try {
    u = new URL(s.trim());
  } catch {
    throw new Error(`not a URL: ${s}`);
  }
  const local = u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  if (u.protocol !== "https:" && !local) throw new Error(`a society node needs an https URL: ${s}`);
  if (u.username || u.password || u.search || u.hash) throw new Error(`a node URL is a plain base URL, with no login, query or fragment: ${s}`);
  return u.origin + u.pathname.replace(/\/+$/, "");
}

// It goes into an HTTP header: printable ASCII, no spaces.
export function checkToken(s: string): string {
  const t = s.trim();
  if (!/^[\x21-\x7e]{16,512}$/.test(t)) throw new Error("the access token must be 16 to 512 printable characters with no spaces");
  return t;
}

// Reads an invite fragment ("#node=...&token=..."). Undefined if the fragment is not an invite.
export function parseInvite(fragment: string): Society | undefined {
  const p = new URLSearchParams(fragment.replace(/^#/, ""));
  const node = p.get("node");
  const token = p.get("token");
  if (node === null && token === null) return undefined;
  if (!node || !token) throw new Error("this invite link is incomplete: it needs both node= and token=");
  return { node: checkNodeUrl(node), token: checkToken(token) };
}

// Takes the invite out of the address bar right away, so the token does not stay in the
// history, a bookmark or a screenshot. Removed even when the link turns out to be malformed.
export function takeInvite(loc: { hash: string; pathname: string; search: string }, history: { replaceState(data: unknown, unused: string, url: string): void }): Society | undefined {
  if (!/(^#|&)(node|token)=/.test(loc.hash)) return undefined;
  history.replaceState(null, "", loc.pathname + loc.search);
  return parseInvite(loc.hash);
}

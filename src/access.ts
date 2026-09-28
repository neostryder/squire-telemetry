// The admin pages sit behind a Cloudflare Access application. Access already refuses anyone who has
// not signed in, and the Worker checks the token Access adds as well, so a request that reaches the
// Worker by another route than squire.rpgm.tools is still refused.

interface Jwk extends JsonWebKey { kid: string }
let certs: { at: number; keys: Jwk[] } | null = null;

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const text = (s: string) => new TextDecoder().decode(b64url(s));

async function keys(team: string, refresh: boolean): Promise<Jwk[]> {
  if (!refresh && certs && Date.now() - certs.at < 3600_000) return certs.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  certs = { at: Date.now(), keys: ((await r.json()) as { keys: Jwk[] }).keys };
  return certs.keys;
}

/** The signed-in email, or the service token's name, when the request carries a valid Access token for this app; otherwise null. */
export async function accessIdentity(request: Request, team: string | undefined, aud: string | undefined): Promise<string | null> {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || !team || !aud) return null;
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) return null;
  try {
    const header = JSON.parse(text(h)) as { kid?: string; alg?: string };
    const claims = JSON.parse(text(p)) as { aud?: string | string[]; exp?: number; iss?: string; email?: string; common_name?: string };
    if (header.alg !== 'RS256') return null;
    if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(aud)) return null;
    if (claims.iss !== `https://${team}` || !claims.exp || claims.exp * 1000 < Date.now()) return null;
    let jwk = (await keys(team, false)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await keys(team, true)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
    return ok ? (claims.email ?? claims.common_name ?? 'service token') : null;
  } catch {
    return null;
  }
}

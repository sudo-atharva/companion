/* eslint-disable camelcase -- Spotify Web API field names */
// Spotify Web API with PKCE (no client secret). Login runs in the web editor; the screen keeps and refreshes the token.
// Spotify only redirects to https: the editor must be opened via its Tailscale https address, and Spotify sends the
// visitor back to that same page (register it as Redirect URI in the Spotify app).
export const spotifyRedirect = () => `${location.origin}${location.pathname}`;
export const canLogin = () => location.protocol === 'https:';

// Captured when the script loads: Angular's router rewrites the address on startup and, because of <base href>,
// drops the ?code=... Spotify sent the visitor back with.
const RETURN_URL = new URL(location.href);
export const isLoginReturn = () => RETURN_URL.searchParams.has('code') || RETURN_URL.searchParams.has('error');
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  // library lists in the Music app
  'playlist-read-private',
  'user-library-read',
  'user-read-recently-played',
].join(' ');
const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';

export interface SpotifyPlayer {
  is_playing: boolean;
  progress_ms: number;
  device: { id: string; name: string; volume_percent: number | null };
  item: SpotifyTrack | null;
}

export interface SpotifyTrack {
  id: string;
  uri: string;
  name: string;
  duration_ms: number;
  artists: { name: string }[];
  album: { name: string; images: { url: string }[] };
}

export interface SpotifyDevice {
  id: string;
  name: string;
  is_active: boolean;
}

// ---- login (web editor) ----

export async function startLogin(clientId: string): Promise<void> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  sessionStorage.setItem('spotify-pkce', JSON.stringify({ clientId, verifier }));
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: spotifyRedirect(),
    code_challenge_method: 'S256',
    code_challenge: base64url(sha256(new TextEncoder().encode(verifier))),
  });
  location.href = `${ACCOUNTS}/authorize?${params}`;
}

// call on the page Spotify sent the visitor back to (?code=... or ?error=...). The code is exchanged for the
// refresh token by the OctoPrint plugin (server side), so this only collects what it needs.
export function loginResult(): { clientId: string; code: string; verifier: string; redirectUri: string } {
  const { clientId, verifier } = JSON.parse(sessionStorage.getItem('spotify-pkce') ?? '{}');
  const code = RETURN_URL.searchParams.get('code');
  if (!code) throw new Error(RETURN_URL.searchParams.get('error') ?? 'No code in that address');
  if (!clientId || !verifier) throw new Error('Login was started in another tab or browser: press Connect again');
  return { clientId, code, verifier, redirectUri: spotifyRedirect() };
}

// ---- playback (screen) ----

export async function api<T>(accessToken: string, method: string, path: string, body?: unknown): Promise<T | null> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401) throw new SpotifyExpired();
  if (!response.ok) throw new Error(`Spotify ${response.status}`);
  // 204/empty = nothing playing or command accepted; player commands may also answer with a non-JSON body
  const text = await response.text();
  try {
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

export class SpotifyExpired extends Error {}
export class SpotifyNotConnected extends Error {}

// Screen side: the Electron main process holds the login and hands out access tokens (they last 1 h).
// One per user of the API (Music app, dashboard); call dispose() when done.
export class SpotifyClient {
  private accessToken = '';
  private waiters: ((reply: { accessToken?: string; notConnected?: boolean; error?: string }) => void)[] = [];
  private onToken = (_, reply) => this.zone.run(() => this.waiters.splice(0).forEach(w => w(reply)));

  public constructor(
    private electronService: { on: IpcOn; removeListener: IpcOn; send: (channel: string) => void },
    private zone: { run: <T>(fn: () => T) => T },
  ) {
    electronService.on('spotifyToken', this.onToken);
  }

  public dispose(): void {
    this.electronService.removeListener('spotifyToken', this.onToken);
  }

  public async call<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    if (!this.accessToken) await this.refresh();
    try {
      return await api<T>(this.accessToken, method, path, body);
    } catch (e) {
      if (!(e instanceof SpotifyExpired)) throw e;
      await this.refresh();
      return api<T>(this.accessToken, method, path, body);
    }
  }

  public async refresh(): Promise<void> {
    const reply = await new Promise<{ accessToken?: string; notConnected?: boolean; error?: string }>(resolve => {
      this.waiters.push(resolve);
      this.electronService.send('spotifyToken');
    });
    if (reply.notConnected) throw new SpotifyNotConnected();
    if (reply.error) throw new Error(reply.error);
    this.accessToken = reply.accessToken;
  }
}

type IpcOn = (channel: string, listener: (...args: unknown[]) => void) => void;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// SHA-256 (FIPS 180-4). crypto.subtle only exists on https/localhost; the editor runs on plain http in the LAN.
export function sha256(data: Uint8Array): Uint8Array {
  const k = new Uint32Array(64);
  const h = new Uint32Array(8);
  const frac = (x: number) => ((x - Math.floor(x)) * 0x100000000) >>> 0;
  for (let n = 2, i = 0; i < 64; n++) {
    if ([...Array(n).keys()].slice(2).some(d => n % d === 0)) continue;
    if (i < 8) h[i] = frac(Math.sqrt(n));
    k[i++] = frac(Math.cbrt(n));
  }
  const length = data.length;
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  padded.set(data);
  padded[length] = 0x80;
  new DataView(padded.buffer).setUint32(padded.length - 4, length * 8);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    const view = new DataView(padded.buffer, off, 64);
    for (let t = 0; t < 64; t++) {
      if (t < 16) w[t] = view.getUint32(t * 4);
      else {
        const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + k[t] + w[t]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      [hh, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
    }
    [a, b, c, d, e, f, g, hh].forEach((v, i) => (h[i] = (h[i] + v) >>> 0));
  }
  const out = new Uint8Array(32);
  h.forEach((v, i) => new DataView(out.buffer).setUint32(i * 4, v));
  return out;
}

// ---- lyrics: Spotify's API has none; LRCLIB is free, keyless and has time-synced lyrics ----

export interface LyricLine {
  time: number; // ms
  text: string;
}

export async function fetchLyrics(
  track: string,
  artist: string,
  album: string,
  durationMs: number,
): Promise<LyricLine[]> {
  const params = new URLSearchParams({
    track_name: track,
    artist_name: artist,
    album_name: album,
    duration: String(Math.round(durationMs / 1000)),
  });
  let result = await fetch(`https://lrclib.net/api/get?${params}`).then(r => (r.ok ? r.json() : null));
  if (!result) {
    // exact match failed (album/duration differ): best search hit
    const hits = await fetch(
      `https://lrclib.net/api/search?${new URLSearchParams({ track_name: track, artist_name: artist })}`,
    )
      .then(r => (r.ok ? r.json() : []))
      .catch(() => []);
    result = hits.find((hit: { syncedLyrics?: string }) => hit.syncedLyrics) ?? hits[0] ?? null;
  }
  if (result?.syncedLyrics) return parseLrc(result.syncedLyrics);
  // unsynced: show the text, no timing
  return (result?.plainLyrics ?? '').split('\n').map((text: string) => ({ time: -1, text }));
}

// "[01:23.45] line" -> { time: 83450, text: 'line' }
export function parseLrc(lrc: string): LyricLine[] {
  return lrc
    .split('\n')
    .map(line => line.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/))
    .filter(Boolean)
    .map(([, min, sec, text]) => ({ time: Math.round((+min * 60 + +sec) * 1000), text }));
}

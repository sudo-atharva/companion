// Browser stand-in for Electron's ipcRenderer: the app runs as Companion's web control panel, served by the OctoPrint
// plugin at the same address as OctoPrint. Config = the touchscreen's real config on the Pi (plugin API), so editing
// here edits the screen. Auth = the visitor's OctoPrint login session (no API key).
import defaultConfig from '../helper/config.default.json';
import { ConfigSchema as Config } from '../model';

type Listener = (event: unknown, ...args: unknown[]) => void;

const API = '/api/plugin/companion';

export const isWebVersion = () => !window.require;
export const isPreview = () => window.self !== window.top; // the editor's live preview iframe

export function csrfHeader(): Record<string, string> {
  return { 'X-CSRF-Token': document.cookie.match(/csrf_token_P\d+[^=]*=([^;]+)/)?.[1] ?? '' };
}

// The screen talks to OctoPrint as http://localhost with its own API key; the browser uses this address + its login.
// Keep the screen's values so saving from the browser doesn't break the screen.
let screenOctoprint: Config['octoprint'] | null = null;

export function createWebIpc() {
  const listeners = new Map<string, Listener[]>();
  const emit = (channel: string, ...args: unknown[]) =>
    setTimeout(() => (listeners.get(channel) ?? []).forEach(listener => listener(null, ...args)));

  const handlers: Record<string, (...args: unknown[]) => void> = {
    readConfig: () => loadConfig().then(config => config && emit('configRead', config)),
    checkConfig: () => emit('configPass'),
    saveConfig: (config: Config) =>
      saveToScreen(config)
        .then(() => emit('configSaved', config))
        .catch(error => emit('configSaveFail', [String(error)])),
    reload: () => location.reload(),
    touchStatus: () => emit('touchStatus', { needed: false }), // calibration happens on the screen itself
    spotifyToken: () => emit('spotifyToken', { notConnected: true }), // music runs on the screen; the browser does the login
  };

  return {
    on: (channel: string, listener: Listener) => listeners.set(channel, [...(listeners.get(channel) ?? []), listener]),
    removeListener: (channel: string, listener: Listener) =>
      listeners.set(
        channel,
        (listeners.get(channel) ?? []).filter(l => l !== listener),
      ),
    send: (channel: string, ...args: unknown[]) => handlers[channel]?.(...args), // everything else: Pi-only, no-op
  };
}

async function loadConfig(): Promise<Config | null> {
  const user = await (await fetch('/api/currentuser', { credentials: 'same-origin' })).json().catch(() => null);
  if (!user?.name) {
    // not logged in to OctoPrint: log in there, then come back here
    location.href = `/login/?redirect=${encodeURIComponent(location.pathname + location.hash)}`;
    return null;
  }
  const response = await fetch(API, { credentials: 'same-origin' });
  const screen: Config | null = response.ok ? (await response.json()).config : null;
  const config = structuredClone(screen ?? defaultConfig) as Config;
  screenOctoprint = screen ? { ...screen.octoprint } : null;
  config.octoprint.url = new URL('/', location.href).href; // same address as OctoPrint
  config.octoprint.accessToken = ''; // session auth, see ConfigService.generateHttpHeaders
  return config;
}

async function saveToScreen(config: Config): Promise<void> {
  const toScreen = structuredClone(config);
  // a screen that was never set up gets this OctoPrint via localhost; its API key comes from the screen's own wizard
  toScreen.octoprint = screenOctoprint ?? { url: 'http://localhost/', accessToken: '' };
  const response = await fetch(API, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...csrfHeader() },
    body: JSON.stringify({ command: 'save', config: toScreen }),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
}

export async function screenCommand(command: 'restart' | 'recalibrate'): Promise<boolean> {
  const response = await fetch(API, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...csrfHeader() },
    body: JSON.stringify({ command }),
  });
  return response.ok;
}

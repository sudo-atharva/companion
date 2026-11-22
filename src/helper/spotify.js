/* eslint-disable camelcase -- Spotify API field names */
// Spotify for the screen: the login (refresh token) is written by the OctoPrint plugin after the web editor login.
// Access tokens are fetched here in the main process (Node: no browser CORS rules), and PKCE refresh tokens rotate,
// so each new one is stored right away.
export async function activateSpotifyListener(ipcMain, window) {
  const { default: Store } = await import('electron-store');
  const store = new Store();

  ipcMain.on('spotifyToken', async () => {
    const auth = store.get('spotify');
    if (!auth?.refreshToken) return window.webContents.send('spotifyToken', { notConnected: true });
    try {
      const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: auth.refreshToken,
          client_id: auth.clientId,
        }),
      });
      const token = await response.json();
      if (!response.ok) throw new Error(token.error_description ?? token.error ?? `Spotify ${response.status}`);
      if (token.refresh_token) store.set('spotify', { ...auth, refreshToken: token.refresh_token });
      window.webContents.send('spotifyToken', { accessToken: token.access_token });
    } catch (error) {
      window.webContents.send('spotifyToken', { error: error.message });
    }
  });
}

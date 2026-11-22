/* eslint-disable camelcase -- Spotify Web API field names */
import { ChangeDetectionStrategy, Component, NgZone, OnDestroy, OnInit } from '@angular/core';

import { ElectronService } from '../../../services/electron.service';
import {
  fetchLyrics,
  LyricLine,
  SpotifyClient,
  SpotifyDevice,
  SpotifyNotConnected,
  SpotifyPlayer,
  SpotifyTrack,
} from '../../../services/spotify';

type ListTab = 'queue' | 'playlists' | 'liked' | 'recent';

interface ListItem {
  title: string;
  subtitle: string;
  image: string | null;
  play: { context_uri: string } | { uris: string[] } | { skip: number }; // play body, or: skip forward N in the queue
}

const PAGE_SIZE = 3; // rows of >= 60px that fit between the tabs and the paging bar

// Spotify remote: controls whatever plays on your phone/PC/speaker. Album art as a blurred "live poster" background,
// time-synced lyrics (LRCLIB). Tap-only (no swipes).
@Component({
  selector: 'app-music',
  templateUrl: './music.component.html',
  styleUrls: ['./music.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: false,
})
export class MusicComponent implements OnInit, OnDestroy {
  public state: 'loading' | 'notConnected' | 'ready' | 'error' = 'loading';
  public player: SpotifyPlayer | null = null;
  public devices: SpotifyDevice[] = [];
  public error = '';
  public showLyrics = false;
  public lyrics: LyricLine[] | null = null; // null = loading/none yet
  public position = 0; // ms, interpolated between polls so the bar and lyrics move smoothly
  public view: 'player' | 'list' = 'player';
  public listTab: ListTab = 'queue';
  public listItems: ListItem[] | null = null; // null = loading
  public listError = '';
  public page = 0;
  public tabs: { id: ListTab; icon: string; label: string }[] = [
    { id: 'queue', icon: 'forward', label: $localize`:@@music-tab-queue:Queue` },
    { id: 'playlists', icon: 'list', label: $localize`:@@music-tab-playlists:Playlists` },
    { id: 'liked', icon: 'heart', label: $localize`:@@music-tab-liked:Liked` },
    { id: 'recent', icon: 'clock-rotate-left', label: $localize`:@@music-tab-recent:Recent` },
  ];

  private lyricsTrackId = '';
  private polledAt = 0;
  private pollInterval: ReturnType<typeof setInterval>;
  private tickInterval: ReturnType<typeof setInterval>;
  private spotify: SpotifyClient;

  public constructor(
    private electronService: ElectronService,
    private zone: NgZone,
  ) {
    this.spotify = new SpotifyClient(this.electronService, this.zone);
  }

  public async ngOnInit(): Promise<void> {
    try {
      await this.spotify.refresh();
    } catch (e) {
      this.state = e instanceof SpotifyNotConnected ? 'notConnected' : 'error';
      this.error = String(e);
      return;
    }
    await this.poll();
    this.pollInterval = setInterval(() => this.zone.run(() => this.poll()), 3000);
    this.tickInterval = setInterval(() => this.tick(), 250);
  }

  public ngOnDestroy(): void {
    clearInterval(this.pollInterval);
    clearInterval(this.tickInterval);
    this.spotify.dispose();
  }

  public cover(): string | null {
    return this.player?.item?.album.images[0]?.url ?? null;
  }

  public artists(): string {
    return this.player?.item?.artists.map(a => a.name).join(', ') ?? '';
  }

  public progress(): number {
    const duration = this.player?.item?.duration_ms;
    return duration ? Math.min(100, (100 * this.position) / duration) : 0;
  }

  public time(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // index of the line being sung (synced lyrics), -1 before the first line
  public currentLine(): number {
    if (!this.lyrics?.length || this.lyrics[0].time < 0) return -1;
    let index = -1;
    for (let i = 0; i < this.lyrics.length && this.lyrics[i].time <= this.position; i++) index = i;
    return index;
  }

  // previous, current and the next two lines around the sung one
  public visibleLines(): { text: string; current: boolean }[] {
    const lines = this.lyrics ?? [];
    if (lines.length && lines[0].time < 0) return lines.slice(0, 6).map(l => ({ text: l.text, current: false }));
    const index = this.currentLine();
    return [-1, 0, 1, 2]
      .map(offset => index + offset)
      .filter(i => i >= 0 && i < lines.length)
      .map(i => ({ text: lines[i].text || '♪', current: i === index }));
  }

  public playPause(): void {
    this.command('PUT', this.player?.is_playing ? '/me/player/pause' : '/me/player/play');
  }

  public next(): void {
    this.command('POST', '/me/player/next');
  }

  public previous(): void {
    this.command('POST', '/me/player/previous');
  }

  public volume(step: number): void {
    const current = this.player?.device.volume_percent;
    if (current === null || current === undefined) return; // device doesn't allow remote volume
    this.command('PUT', `/me/player/volume?volume_percent=${Math.min(100, Math.max(0, current + step))}`);
  }

  // one button: move playback to the next available device
  public nextDevice(): void {
    if (this.devices.length < 2) return;
    const index = this.devices.findIndex(d => d.is_active);
    this.playOn(this.devices[(index + 1) % this.devices.length]);
  }

  // ---- library lists (tap-only: tabs + ◀ ▶ pages, no scrolling) ----

  public openList(tab: ListTab = this.listTab): void {
    this.view = 'list';
    this.listTab = tab;
    this.page = 0;
    this.listItems = null;
    this.listError = '';
    this.loadList(tab).then(
      items => this.listTab === tab && (this.listItems = items),
      e => {
        this.listItems = [];
        // 403 = the login predates the library permissions
        this.listError = String(e).includes('403')
          ? $localize`:@@music-reconnect:Reconnect Spotify in the web editor (Setup) to allow lists.`
          : String(e);
      },
    );
  }

  public pageItems(): ListItem[] {
    return (this.listItems ?? []).slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE);
  }

  public pageCount(): number {
    return Math.max(1, Math.ceil((this.listItems?.length ?? 0) / PAGE_SIZE));
  }

  public turnPage(step: number): void {
    this.page = Math.min(this.pageCount() - 1, Math.max(0, this.page + step));
  }

  public async playItem(item: ListItem): Promise<void> {
    this.view = 'player';
    if ('skip' in item.play) {
      // the API can't jump inside the queue: skip forward to it instead
      for (let i = 0; i < item.play.skip; i++) await this.call('POST', '/me/player/next').catch(() => {});
      setTimeout(() => this.zone.run(() => this.poll()), 400);
      return;
    }
    this.command('PUT', '/me/player/play', item.play);
  }

  private async loadList(tab: ListTab): Promise<ListItem[]> {
    const track = (t: SpotifyTrack, play: ListItem['play'] = { uris: [t.uri] }): ListItem => ({
      title: t.name,
      subtitle: t.artists.map(a => a.name).join(', '),
      image: t.album.images.at(-1)?.url ?? null, // smallest image
      play,
    });
    switch (tab) {
      case 'queue': {
        const r = await this.call<{ queue: SpotifyTrack[] }>('GET', '/me/player/queue');
        return (r?.queue ?? []).filter(t => t?.album).map((t, i) => track(t, { skip: i + 1 }));
      }
      case 'playlists': {
        const r = await this.call<{
          items: { name: string; uri: string; owner: { display_name: string }; images: { url: string }[] | null }[];
        }>('GET', '/me/playlists?limit=50');
        return (r?.items ?? []).map(p => ({
          title: p.name,
          subtitle: p.owner.display_name,
          image: p.images?.at(-1)?.url ?? null,
          play: { context_uri: p.uri },
        }));
      }
      case 'liked': {
        const r = await this.call<{ items: { track: SpotifyTrack }[] }>('GET', '/me/tracks?limit=50');
        return (r?.items ?? []).map(i => track(i.track));
      }
      case 'recent': {
        const r = await this.call<{ items: { track: SpotifyTrack }[] }>('GET', '/me/player/recently-played?limit=50');
        return (r?.items ?? []).map(i => track(i.track));
      }
    }
  }

  public playOn(device: SpotifyDevice): void {
    this.command('PUT', '/me/player', { device_ids: [device.id], play: true });
  }

  private tick(): void {
    if (!this.player?.is_playing) return;
    this.position = this.player.progress_ms + (Date.now() - this.polledAt);
  }

  private async poll(): Promise<void> {
    try {
      const [player, devices] = await Promise.all([
        this.call<SpotifyPlayer>('GET', '/me/player'),
        this.call<{ devices: SpotifyDevice[] }>('GET', '/me/player/devices'),
      ]);
      this.player = player; // null = nothing playing anywhere
      this.polledAt = Date.now();
      this.position = player?.progress_ms ?? 0;
      this.devices = devices?.devices ?? [];
      this.state = 'ready';
      this.loadLyrics();
    } catch (e) {
      this.state = 'error';
      this.error = String(e);
    }
  }

  private async loadLyrics(): Promise<void> {
    const item = this.player?.item;
    if (!item || item.id === this.lyricsTrackId) return;
    this.lyricsTrackId = item.id;
    this.lyrics = null;
    const lines = await fetchLyrics(item.name, item.artists[0]?.name ?? '', item.album.name, item.duration_ms).catch(
      () => [],
    );
    if (this.lyricsTrackId === item.id) this.lyrics = lines;
  }

  private async command(method: string, path: string, body?: unknown): Promise<void> {
    try {
      this.error = '';
      await this.call(method, path, body);
    } catch (e) {
      this.error = String(e); // e.g. 403: Premium needed, 404: no active device
      setTimeout(() => this.zone.run(() => (this.error = '')), 4000);
    }
    setTimeout(() => this.zone.run(() => this.poll()), 400);
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    return this.spotify.call<T>(method, path, body);
  }
}

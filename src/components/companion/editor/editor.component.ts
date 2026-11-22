import { ChangeDetectionStrategy, Component, ElementRef, NgZone, OnDestroy, ViewChild } from '@angular/core';

import { ConfigSchema as Config, DeckButton } from '../../../model';
import { ConfigService } from '../../../services/config.service';
import { ElectronService } from '../../../services/electron.service';
import { NotificationService } from '../../../services/notification.service';
import { canLogin, isLoginReturn, loginResult, startLogin } from '../../../services/spotify';
import { csrfHeader, screenCommand } from '../../../services/web-ipc';

type Tab = 'dashboard' | 'deck' | 'screen' | 'setup' | 'printer';

// Web control panel for the touchscreen: live preview + settings that are saved to the screen on the Pi.
@Component({
  selector: 'app-editor',
  templateUrl: './editor.component.html',
  styleUrls: ['./editor.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: false,
})
export class EditorComponent implements OnDestroy {
  @ViewChild('preview') private preview: ElementRef<HTMLIFrameElement>;

  public tab: Tab = 'dashboard';
  public config: Config;
  public user = '';
  public plugAvailable: boolean | null = null;
  public saving = false;
  public octodashSettingsVisible = false;
  public spotify: { clientId: string | null; connected: boolean } = { clientId: null, connected: false };
  public spotifyClientId = '';
  // Tapo plug (the Tapo Plug OctoPrint plugin's own settings + API)
  public tapo: { host: string; username: string; password: string } | null = null;
  public tapoDevices: { host: string; alias: string; model: string; note: string }[] = [];
  public tapoBusy = '';
  public tapoStatus = '';
  public canLoginSpotify = canLogin();
  public spotifyRedirectUri = location.origin + location.pathname;

  private onSaved = () => this.zone.run(() => this.afterScreenChange($localize`:@@editor-saved:Saved to the screen`));
  private onSaveFail = (_, errors: string[]) =>
    this.zone.run(() => {
      this.saving = false;
      this.notificationService.error($localize`:@@editor-save-failed:Could not save`, String(errors));
    });

  public constructor(
    private configService: ConfigService,
    private electronService: ElectronService,
    private notificationService: NotificationService,
    private zone: NgZone,
  ) {
    this.config = this.configService.getCurrentConfig();
    this.config.octodash.deck ??= structuredClone(this.configService.getDeck()); // defaults until edited
    this.electronService.on('configSaved', this.onSaved);
    this.electronService.on('configSaveFail', this.onSaveFail);
    fetch('/api/currentuser', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(u => (this.user = u.name ?? ''))
      .catch(() => {});
    this.loadSpotifyStatus();
    if (isLoginReturn()) this.finishSpotifyLogin(); // back from Spotify's login
    fetch('/api/settings', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(s => {
        this.plugAvailable = !!s.plugins?.psucontrol;
        const tapo = s.plugins?.psucontrol_tapo;
        if (tapo) this.tapo = { host: tapo.host ?? '', username: tapo.username ?? '', password: tapo.password ?? '' };
        if (tapo?.host) this.testTapo();
      })
      .catch(() => (this.plugAvailable = false));
  }

  public ngOnDestroy(): void {
    this.electronService.removeListener('configSaved', this.onSaved);
    this.electronService.removeListener('configSaveFail', this.onSaveFail);
  }

  public save(): void {
    this.saving = true;
    this.configService.saveConfig(this.config); // -> web-ipc -> plugin -> screen restarts with it
  }

  public async restartScreen(): Promise<void> {
    if (await screenCommand('restart')) this.afterScreenChange($localize`:@@editor-restarted:Screen restarting`);
  }

  public async recalibrate(): Promise<void> {
    if (await screenCommand('recalibrate')) {
      this.afterScreenChange($localize`:@@editor-recalibrate:Screen restarting into the touch calibration`);
    }
  }

  public connectSpotify(): void {
    startLogin(this.spotifyClientId.trim());
  }

  // Client ID is kept on the Pi as soon as it's entered, so it's there next time
  public saveSpotifyClientId(): void {
    const clientId = this.spotifyClientId.trim();
    if (!clientId || clientId === this.spotify.clientId) return;
    fetch('/api/plugin/companion', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...csrfHeader() },
      body: JSON.stringify({ command: 'spotifyClient', clientId }),
    }).then(r => r.ok && (this.spotify = { ...this.spotify, clientId }));
  }

  private loadSpotifyStatus(): void {
    fetch('/api/plugin/companion', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(r => {
        this.spotify = r.spotify ?? { clientId: null, connected: false }; // older plugin: no Spotify yet
        this.spotifyClientId = r.spotify?.clientId ?? '';
      })
      .catch(() => {});
  }

  private async finishSpotifyLogin(): Promise<void> {
    this.tab = 'setup';
    try {
      const response = await fetch('/api/plugin/companion', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({ command: 'spotify', ...loginResult() }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `${response.status} ${response.statusText}`);
      }
      this.zone.run(() => this.afterScreenChange($localize`:@@editor-spotify-connected:Spotify connected`));
      this.loadSpotifyStatus();
    } catch (e) {
      console.error('Spotify login failed', e);
      this.zone.run(() =>
        // sticky: the visitor needs time to read why (e.g. a browser shield blocking accounts.spotify.com)
        this.notificationService.error($localize`:@@editor-spotify-failed:Spotify login failed`, String(e), true),
      );
    }
    history.replaceState(null, '', location.pathname + location.hash); // drop ?code=... from the address
  }

  public async scanTapo(): Promise<void> {
    this.tapoBusy = $localize`:@@editor-tapo-scanning:Scanning the network (about 10 s)…`;
    this.tapoDevices = [];
    try {
      const r = await this.tapoApi({ command: 'discover', username: this.tapo.username, password: this.tapo.password });
      this.tapoDevices = r.devices ?? [];
      this.tapoBusy = this.tapoDevices.length
        ? ''
        : $localize`:@@editor-tapo-none:No Tapo plug found. Type its IP instead.`;
    } catch (e) {
      this.tapoBusy = String(e);
    }
  }

  public async saveTapo(): Promise<void> {
    this.tapoBusy = $localize`:@@editor-saving:Saving…`;
    const response = await fetch('/api/settings', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...csrfHeader() },
      body: JSON.stringify({ plugins: { psucontrol_tapo: this.tapo } }), // eslint-disable-line camelcase -- plugin id
    });
    this.tapoBusy = response.ok ? '' : `${response.status} ${response.statusText}`;
    if (response.ok) this.testTapo();
  }

  public async switchTapo(on: boolean): Promise<void> {
    this.tapoStatus = this.describeTapo(
      await this.tapoApi({ command: on ? 'on' : 'off' }).catch(e => ({ error: String(e) })),
    );
  }

  public async testTapo(): Promise<void> {
    this.tapoStatus = $localize`:@@editor-tapo-checking:Checking the plug…`;
    const r = await fetch('/api/plugin/psucontrol_tapo', { credentials: 'same-origin' })
      .then(x => x.json())
      .catch(e => ({ error: String(e) }));
    this.tapoStatus = this.describeTapo(r);
  }

  private describeTapo(r: { on?: boolean | null; error?: string | null }): string {
    if (r.error) return r.error;
    return r.on ? $localize`:@@editor-tapo-on:Plug is ON` : $localize`:@@editor-tapo-off:Plug is OFF`;
  }

  private async tapoApi(body: Record<string, unknown>) {
    const response = await fetch('/api/plugin/psucontrol_tapo', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...csrfHeader() },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  }

  // ---- Deck buttons ----

  public addDeckButton(): void {
    this.config.octodash.deck.push({
      label: 'New',
      icon: 'star',
      color: '#44bd32',
      type: 'gcode',
      value: '',
      confirm: false,
    });
  }

  public moveDeckButton(index: number, step: number): void {
    const deck = this.config.octodash.deck;
    const target = index + step;
    if (target < 0 || target >= deck.length) return;
    [deck[index], deck[target]] = [deck[target], deck[index]];
  }

  public removeDeckButton(button: DeckButton): void {
    this.config.octodash.deck = this.config.octodash.deck.filter(b => b !== button);
  }

  public refreshPreview(): void {
    this.preview?.nativeElement.contentWindow?.location.reload();
  }

  private afterScreenChange(message: string): void {
    this.saving = false;
    this.notificationService.info(message, '');
    this.refreshPreview();
  }
}

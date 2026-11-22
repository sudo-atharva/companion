import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { of, Subscription, timer } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';

import { JobStatus, PrinterState, PrinterStatus, PSUState } from '../../../model';
import { ConfigService } from '../../../services/config.service';
import { ElectronService } from '../../../services/electron.service';
import { EnclosureService } from '../../../services/enclosure/enclosure.service';
import { NotificationService } from '../../../services/notification.service';
import { SocketService } from '../../../services/socket/socket.service';
import { SpotifyClient, SpotifyNotConnected, SpotifyPlayer } from '../../../services/spotify';
import { SystemService } from '../../../services/system/system.service';

interface Weather {
  temperature: number;
  text: string;
}

// WMO weather codes used by Open-Meteo
const WEATHER_TEXT: [number, string][] = [
  [0, $localize`:@@weather-clear:Clear`],
  [2, $localize`:@@weather-partly-cloudy:Partly cloudy`],
  [3, $localize`:@@weather-cloudy:Cloudy`],
  [48, $localize`:@@weather-fog:Fog`],
  [57, $localize`:@@weather-drizzle:Drizzle`],
  [67, $localize`:@@weather-rain:Rain`],
  [77, $localize`:@@weather-snow:Snow`],
  [82, $localize`:@@weather-showers:Showers`],
  [86, $localize`:@@weather-snow-showers:Snow showers`],
  [99, $localize`:@@weather-thunderstorm:Thunderstorm`],
];

const OFFLINE = [PrinterState.closed, PrinterState.connecting, PrinterState.reconnecting, PrinterState.socketDead];
const BUSY = [PrinterState.printing, PrinterState.pausing, PrinterState.paused, PrinterState.cancelling];

// Companion home: big widget (clock/weather, or print progress) + printer and power cards + app dock.
@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: false,
})
export class DashboardComponent implements OnInit, OnDestroy {
  public now = new Date();
  public weather: Weather | null = null;
  public psuOn: boolean | null = null;
  public printer: PrinterStatus | null = null;
  public job: JobStatus | null = null;
  public connecting = false;
  public connectFailed = false;
  public confirmOff = false;
  public music: SpotifyPlayer | null = null;
  // from the Tapo plugin's energy meter (P110/P115); null = no such plug/plugin
  public energy: { watts: number; kwh_today: number; print_kwh: number | null; printing: boolean } | null = null;

  private openPrinterWhenReady = false;
  private connectTimeout: ReturnType<typeof setTimeout>;
  private confirmTimeout: ReturnType<typeof setTimeout>;
  private clockInterval: ReturnType<typeof setInterval>;
  private musicTimeout: ReturnType<typeof setTimeout>;
  private spotify: SpotifyClient;
  private subscriptions = new Subscription();

  public constructor(
    private configService: ConfigService,
    private enclosureService: EnclosureService,
    private systemService: SystemService,
    private socketService: SocketService,
    private notificationService: NotificationService,
    private router: Router,
    private electronService: ElectronService,
    private zone: NgZone,
    private http: HttpClient,
  ) {
    this.spotify = new SpotifyClient(this.electronService, this.zone);
  }

  public ngOnInit(): void {
    this.clockInterval = setInterval(() => (this.now = new Date()), 10000);
    this.pollMusic();
    if (!this.isConfigured()) return; // printer side not set up yet: clock (and music) only
    this.subscriptions.add(
      timer(0, 15000)
        .pipe(switchMap(() => this.enclosureService.getPSUState()))
        .subscribe(on => (this.psuOn = on)),
    );
    // ponytail: polls the Tapo plugin directly; other plug plugins have no energy API, the card then shows On/Off only
    this.subscriptions.add(
      timer(0, 15000)
        .pipe(
          switchMap(
            () =>
              this.http
                .get<
                  DashboardComponent['energy']
                >(this.configService.getApiURL('plugin/psucontrol_tapo'), this.configService.getHTTPHeaders())
                .pipe(catchError(() => of(null))), // keep polling after an error
          ),
        )
        .subscribe(r => (this.energy = typeof r?.watts === 'number' ? r : null)),
    );
    this.subscriptions.add(
      this.socketService.getPrinterStatusSubscribable().subscribe(status => {
        this.printer = status;
        if (this.isOnline()) {
          this.connecting = false;
          clearTimeout(this.connectTimeout);
          if (this.openPrinterWhenReady) this.router.navigate(['/main-screen']);
        }
      }),
    );
    this.subscriptions.add(this.socketService.getJobStatusSubscribable().subscribe(job => (this.job = job)));
    // ponytail: weather refreshes every 30 min, city is geocoded each time (2 tiny requests)
    if (this.configService.getWeatherCity()) {
      this.subscriptions.add(timer(0, 1800000).subscribe(() => this.loadWeather()));
    }
  }

  public ngOnDestroy(): void {
    clearTimeout(this.connectTimeout);
    clearTimeout(this.confirmTimeout);
    clearInterval(this.clockInterval);
    clearTimeout(this.musicTimeout);
    this.spotify.dispose();
    this.subscriptions.unsubscribe();
  }

  // ---- now playing (big widget shows it instead of the clock; print progress still wins) ----

  public musicCover(): string | null {
    return this.music?.item?.album.images[0]?.url ?? null; // largest: it fills the whole widget
  }

  public musicArtists(): string {
    return this.music?.item?.artists.map(a => a.name).join(', ') ?? '';
  }

  public toggleMusic(event: Event): void {
    event.stopPropagation(); // the widget itself opens the Music app
    const playing = this.music?.is_playing;
    if (this.music) this.music = { ...this.music, is_playing: !playing }; // eslint-disable-line camelcase -- Spotify field
    this.spotify.call('PUT', playing ? '/me/player/pause' : '/me/player/play').catch(() => {});
  }

  private pollMusic(): void {
    this.spotify
      .call<SpotifyPlayer>('GET', '/me/player')
      .then(player => (this.music = player?.item ? player : null))
      .then(() => (this.musicTimeout = setTimeout(() => this.pollMusic(), 5000)))
      .catch(e => {
        this.music = null;
        // not connected: stop asking; network hiccup: try again later
        if (!(e instanceof SpotifyNotConnected)) this.musicTimeout = setTimeout(() => this.pollMusic(), 30000);
      });
  }

  // OctoDash (the printer app) has a valid config: OctoPrint URL, API key, plugins
  public isConfigured(): boolean {
    return this.configService.isLoaded() && this.configService.isValid();
  }

  public isOnline(): boolean {
    return this.printer !== null && !OFFLINE.includes(this.printer.status);
  }

  public isPrinting(): boolean {
    return this.printer !== null && BUSY.includes(this.printer.status);
  }

  public printerText(): string {
    if (!this.isConfigured()) return $localize`:@@companion-not-set-up:Not set up`;
    if (this.connecting) return $localize`:@@connecting:connecting`;
    switch (this.printer?.status) {
      case PrinterState.operational:
        return $localize`:@@companion-ready:Ready`;
      case PrinterState.printing:
        return $localize`:@@companion-printing:Printing` + (this.job ? ` ${Math.round(this.job.progress)}%` : '');
      case PrinterState.pausing:
      case PrinterState.paused:
        return $localize`:@@companion-paused:Paused`;
      case PrinterState.cancelling:
        return $localize`:@@companion-cancelling:Cancelling`;
      default:
        return $localize`:@@companion-offline:Offline`;
    }
  }

  public hasPSUControl(): boolean {
    if (!this.isConfigured()) return false;
    return (
      this.configService.usePSUControl() ||
      this.configService.useOphomControl() ||
      this.configService.useTpLinkSmartPlug() ||
      this.configService.useTasmota() ||
      this.configService.useTasmotaMqtt() ||
      this.configService.useTuya() ||
      this.configService.useWemo()
    );
  }

  // Printer app: open it, or bring the printer up first and open it once it is connected
  public openPrinter(): void {
    if (!this.isConfigured()) {
      this.router.navigate(['/no-config']); // OctoDash's setup wizard
      return;
    }
    if (this.isOnline()) {
      this.router.navigate(['/main-screen']);
      return;
    }
    this.openPrinterWhenReady = true;
    this.startPrinter();
  }

  // dock: the Printer app opens even with the printer off (browse files; Print switches it on)
  public openPrinterApp(): void {
    this.router.navigate([this.isConfigured() ? '/main-screen' : '/no-config']);
  }

  public openDeck(): void {
    this.router.navigate(['/deck']);
  }

  public openMusic(): void {
    this.router.navigate(['/music']);
  }

  public togglePower(): void {
    if (this.psuOn !== true) {
      this.startPrinter();
      return;
    }
    if (this.isPrinting()) {
      this.notificationService.warn(
        $localize`:@@companion-power-blocked:Printer is busy`,
        $localize`:@@companion-power-blocked-message:Stop or finish the print before turning the power off.`,
      );
      return;
    }
    // two taps to cut power, so a stray touch can't switch the printer off
    if (!this.confirmOff) {
      this.confirmOff = true;
      this.confirmTimeout = setTimeout(() => (this.confirmOff = false), 3000);
      return;
    }
    this.confirmOff = false;
    this.psuOn = false;
    this.enclosureService.setPSUState(PSUState.OFF);
  }

  public openSettings(): void {
    this.router.navigate(['/companion-settings']);
  }

  private startPrinter(): void {
    if (this.connecting) return;
    this.connecting = true;
    this.connectFailed = false;
    if (this.hasPSUControl() && this.psuOn !== true) {
      this.psuOn = true;
      this.enclosureService.setPSUState(PSUState.ON);
      // give the printer's board time to boot before opening the serial port
      setTimeout(() => this.systemService.connectPrinter(), 5000);
    } else {
      this.systemService.connectPrinter();
    }
    this.connectTimeout = setTimeout(() => {
      this.connecting = false;
      this.connectFailed = true;
      this.openPrinterWhenReady = false;
    }, 35000);
  }

  private async loadWeather(): Promise<void> {
    try {
      const city = encodeURIComponent(this.configService.getWeatherCity());
      const geo = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${city}&count=1`)).json();
      const place = geo.results?.[0];
      if (!place) {
        this.weather = null;
        return;
      }
      const forecast = await (
        await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,weather_code`,
        )
      ).json();
      const code: number = forecast.current.weather_code;
      this.weather = {
        temperature: Math.round(forecast.current.temperature_2m),
        text: WEATHER_TEXT.find(([max]) => code <= max)?.[1] ?? '',
      };
    } catch {
      this.weather = null; // offline: just hide the weather
    }
  }
}

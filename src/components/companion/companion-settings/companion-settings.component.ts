import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Observable, of } from 'rxjs';

import { AppService } from '../../../services/app.service';
import { ConfigService } from '../../../services/config.service';
import { ElectronService } from '../../../services/electron.service';
import { SystemService } from '../../../services/system/system.service';

// Companion's own settings on the screen: big tiles, tap-only. Everything else is set up in the web editor;
// the printer's (OctoDash) settings are one tile away.
@Component({
  selector: 'app-companion-settings',
  templateUrl: './companion-settings.component.html',
  styleUrls: ['./companion-settings.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: false,
})
export class CompanionSettingsComponent {
  public sleep: boolean;
  public address$: Observable<string | null>;
  public printerSettingsVisible = false;
  public confirmRestart = false;

  public constructor(
    private configService: ConfigService,
    private appService: AppService,
    private electronService: ElectronService,
    systemService: SystemService,
  ) {
    const configured = this.configService.isLoaded() && this.configService.isValid();
    this.sleep = configured && this.configService.getAutomaticScreenSleep();
    this.address$ = configured ? systemService.getLocalIpAddress() : of(null);
  }

  public isConfigured(): boolean {
    return this.configService.isLoaded() && this.configService.isValid();
  }

  public toggleSleep(): void {
    if (!this.isConfigured()) return;
    const config = this.configService.getCurrentConfig();
    config.octodash.turnScreenOffWhileSleeping = this.sleep = !this.sleep;
    this.configService.saveConfig(config); // saved right away, no save button
  }

  public calibrate(): void {
    this.appService.screenTestVisible = true;
  }

  public openPrinterSettings(): void {
    if (this.isConfigured()) this.printerSettingsVisible = true;
  }

  public hidePrinterSettings(): void {
    setTimeout(() => (this.printerSettingsVisible = false), 350); // let the slide-out finish
  }

  // two taps, like every action that interrupts what's on the screen
  public restart(): void {
    if (!this.confirmRestart) {
      this.confirmRestart = true;
      setTimeout(() => (this.confirmRestart = false), 3000);
      return;
    }
    this.electronService.send('reload');
  }
}

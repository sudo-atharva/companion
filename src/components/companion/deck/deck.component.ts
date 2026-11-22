import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, OnDestroy } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { DeckButton, PSUState } from '../../../model';
import { ConfigService } from '../../../services/config.service';
import { EnclosureService } from '../../../services/enclosure/enclosure.service';

const PAGE_SIZE = 6; // 3 x 2 big buttons on 480x320

// Stream-deck style shortcut buttons (set up in the web editor). Tap-only: pages via ◀ ▶,
// buttons marked "confirm" need a second tap within 3 s.
@Component({
  selector: 'app-deck',
  templateUrl: './deck.component.html',
  styleUrls: ['./deck.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: false,
})
export class DeckComponent implements OnDestroy {
  public buttons: DeckButton[];
  public page = 0;
  public armed: DeckButton | null = null; // waiting for the confirming second tap
  public result = new Map<DeckButton, 'ok' | 'fail'>(); // short flash after running

  private armTimeout: ReturnType<typeof setTimeout>;

  public constructor(
    private configService: ConfigService,
    private enclosureService: EnclosureService,
    private http: HttpClient,
  ) {
    this.buttons = this.configService.getDeck();
  }

  public ngOnDestroy(): void {
    clearTimeout(this.armTimeout);
  }

  public pageButtons(): DeckButton[] {
    return this.buttons.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE);
  }

  public pageCount(): number {
    return Math.max(1, Math.ceil(this.buttons.length / PAGE_SIZE));
  }

  public turnPage(step: number): void {
    this.page = Math.min(this.pageCount() - 1, Math.max(0, this.page + step));
    this.armed = null;
  }

  public tap(button: DeckButton): void {
    if (button.confirm && this.armed !== button) {
      this.armed = button;
      clearTimeout(this.armTimeout);
      this.armTimeout = setTimeout(() => (this.armed = null), 3000);
      return;
    }
    this.armed = null;
    this.run(button).then(
      () => this.flash(button, 'ok'),
      () => this.flash(button, 'fail'),
    );
  }

  private async run(button: DeckButton): Promise<void> {
    switch (button.type) {
      case 'gcode': {
        const commands = button.value
          .split(/[;\n]/)
          .map(c => c.trim())
          .filter(Boolean);
        await firstValueFrom(
          this.http.post(
            this.configService.getApiURL('printer/command'),
            { commands },
            this.configService.getHTTPHeaders(),
          ),
        );
        return;
      }
      case 'psu':
        if (button.value === 'toggle') this.enclosureService.togglePSU();
        else this.enclosureService.setPSUState(button.value === 'off' ? PSUState.OFF : PSUState.ON);
        return;
      case 'http': {
        // "POST https://..." or just a URL (GET). no-cors: the request goes out (Home Assistant webhooks,
        // lights, …) even though those servers don't allow this app to read the answer.
        const [method, url] = /^(GET|POST|PUT)\s+/i.test(button.value)
          ? button.value.split(/\s+(.*)/s)
          : ['GET', button.value];
        await fetch(url.trim(), { method: method.toUpperCase(), mode: 'no-cors' });
        return;
      }
    }
  }

  private flash(button: DeckButton, outcome: 'ok' | 'fail'): void {
    this.result.set(button, outcome);
    setTimeout(() => this.result.delete(button), 1200);
  }
}

import { ChangeDetectionStrategy, Component, HostListener, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { filter, take } from 'rxjs/operators';

import { PrinterState } from '../../../model';
import { AppService } from '../../../services/app.service';
import { ConfigService } from '../../../services/config.service';
import { SocketService } from '../../../services/socket/socket.service';

const IDLE_MS = 5 * 60 * 1000;
const BUSY = [PrinterState.printing, PrinterState.pausing, PrinterState.paused, PrinterState.cancelling];

// After 5 min without a tap (never while printing): night clock. A black flip clock + date, redrawn once a minute,
// instead of switching the display off. While it shows, the first tap only wakes the screen: the clock overlay
// swallows it, so a wake-up tap can't press whatever is underneath.
@Component({
  selector: 'app-screen-sleep',
  templateUrl: './screen-sleep.component.html',
  styleUrls: ['./screen-sleep.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: false,
})
export class ScreenSleepComponent implements OnInit, OnDestroy {
  public asleep = false;
  public digits: string[] = [];
  public now = new Date();

  private printing = false;
  private timeout: ReturnType<typeof setTimeout>;
  private clockInterval: ReturnType<typeof setInterval>;
  private subscription: Subscription;

  public constructor(
    private service: AppService,
    private configService: ConfigService,
    private socketService: SocketService,
  ) {}

  public ngOnInit(): void {
    // a restart must never leave the screen dark (wake command comes from the config, so wait for it)
    this.configService
      .getInitializedSubscribable()
      .pipe(filter(Boolean), take(1))
      .subscribe(() => this.configService.isLoaded() && this.service.turnDisplayOn());
    this.subscription = this.socketService.getPrinterStatusSubscribable().subscribe(status => {
      this.printing = BUSY.includes(status?.status);
      if (this.printing && this.asleep) this.wake();
    });
    this.schedule();
  }

  public ngOnDestroy(): void {
    clearTimeout(this.timeout);
    clearInterval(this.clockInterval);
    this.subscription?.unsubscribe();
  }

  // any tap anywhere restarts the idle timer
  @HostListener('document:pointerdown')
  public activity(): void {
    if (!this.asleep) this.schedule();
  }

  public wake(event?: Event): void {
    event?.stopPropagation();
    this.asleep = false;
    clearInterval(this.clockInterval);
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => {
      if (this.printing || !this.enabled()) return this.schedule();
      this.asleep = true;
      this.tick();
      // ponytail: checks every 5 s but only re-renders when the minute changes (the flip animation runs then)
      this.clockInterval = setInterval(() => this.tick(), 5000);
    }, IDLE_MS);
  }

  private tick(): void {
    const now = new Date();
    const digits = [...now.toTimeString().slice(0, 5).replace(':', '')];
    if (digits.join('') !== this.digits.join('')) {
      this.digits = digits;
      this.now = now;
    }
  }

  private enabled(): boolean {
    return this.configService.isLoaded() && this.configService.getAutomaticScreenSleep();
  }
}

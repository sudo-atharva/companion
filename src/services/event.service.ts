import { Injectable, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';

import { PrinterEvent } from '../model/event.model';
import { ConfigService } from './config.service';
import { SocketService } from './socket/socket.service';

export const PRINTER_APP_ROUTES = ['/main-screen', '/control', '/files', '/filament'];

@Injectable()
export class EventService implements OnDestroy {
  private subscriptions: Subscription = new Subscription();

  private printing = false;

  public constructor(
    private socketService: SocketService,
    private configService: ConfigService,
    private router: Router,
  ) {
    this.subscriptions.add(
      this.socketService.getEventSubscribable().subscribe((event: PrinterEvent) => this.handlePrinterEvent(event)),
    );
  }

  private handlePrinterEvent(event: PrinterEvent): void {
    if (event === PrinterEvent.PRINTING || event === PrinterEvent.PAUSED) {
      setTimeout(() => {
        this.printing = true;
      }, 500);
    } else {
      setTimeout(() => {
        this.printing = false;
      }, 1000);
    }

    // Companion: the printer is one app among others, so connecting never takes over the screen.
    // Losing the printer while inside its app goes back to the dashboard.
    if (event === PrinterEvent.CLOSED && PRINTER_APP_ROUTES.some(route => this.router.url.startsWith(route))) {
      this.router.navigate(['/home']);
    }
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  public isPrinting(): boolean {
    return this.printing;
  }
}

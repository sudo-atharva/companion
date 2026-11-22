import { Injectable } from '@angular/core';
import { IpcRenderer } from 'electron';

import { NotificationService } from './notification.service';
import { createWebIpc } from './web-ipc';

@Injectable({
  providedIn: 'root',
})
export class ElectronService {
  private ipcRenderer: IpcRenderer | undefined;

  constructor(private notificationService: NotificationService) {
    if (window.require) {
      this.ipcRenderer = window.require('electron').ipcRenderer;
    } else {
      // Companion web version (browser): same messages, answered in the page
      this.ipcRenderer = createWebIpc() as unknown as IpcRenderer;
    }
  }

  public on(channel: string, listener: (...args) => void): void {
    if (!this.ipcRenderer) {
      return;
    }
    this.ipcRenderer.on(channel, listener);
  }

  public removeListener(channel: string, listener: (...args) => void): void {
    if (!this.ipcRenderer) {
      return;
    }
    this.ipcRenderer.removeListener(channel, listener);
  }

  public send(channel: string, ...args): void {
    if (!this.ipcRenderer) {
      return;
    }
    this.ipcRenderer.send(channel, ...args);
  }
}

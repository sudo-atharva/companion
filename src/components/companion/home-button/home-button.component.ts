import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Router } from '@angular/router';

// Way back to the Companion dashboard from any app (OctoDash screens, Music, Deck).
const HIDDEN_ON = ['/home', '/', '/editor'];

@Component({
  selector: 'app-home-button',
  template: `@if (visible()) {
    <span class="home-button" matRipple [matRippleCentered]="true" (click)="goHome()"><fa-icon icon="house" /></span>
  }`,
  styleUrls: ['./home-button.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: false,
})
export class HomeButtonComponent {
  public constructor(private router: Router) {}

  public visible(): boolean {
    return !HIDDEN_ON.includes(this.router.url);
  }

  public goHome(): void {
    this.router.navigate(['/home']);
  }
}

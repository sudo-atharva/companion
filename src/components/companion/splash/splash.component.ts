import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnInit, Output } from '@angular/core';

// Boot intro: gear spins, sheds its teeth, opens into the "C" of Companion. Pure CSS.
// Stays on the final logo until the app is ready (slow Pi boots), then fades out.
@Component({
  selector: 'app-splash',
  templateUrl: './splash.component.html',
  styleUrls: ['./splash.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: false,
})
export class SplashComponent implements OnInit {
  @Input() ready = false;
  @Output() done = new EventEmitter<void>();

  public teeth = [0, 45, 90, 135, 180, 225, 270, 315];
  public introDone = false;

  public ngOnInit(): void {
    setTimeout(() => (this.introDone = true), 2600); // end of the word slide-in in the SCSS, plus a short hold
  }

  public onAnimationEnd(event: AnimationEvent): void {
    // Angular scopes keyframe names per component, so match the suffix
    if (event.animationName.endsWith('splash-fade')) this.done.emit();
  }
}

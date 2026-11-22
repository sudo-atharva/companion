import { ChangeDetectionStrategy, Component, NgZone, OnDestroy } from '@angular/core';

import { AppService } from '../../services/app.service';
import { ElectronService } from '../../services/electron.service';

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const COLORS = ['#ffffff', '#ff0000', '#00ff00', '#0000ff', '#000000'];
// calibration targets, normalized screen coordinates (10% in from each corner)
const TARGETS = [
  [0.1, 0.1],
  [0.9, 0.1],
  [0.9, 0.9],
  [0.1, 0.9],
];
const REVERT_SECONDS = 15;

interface CalibrationPoint {
  tx: number;
  ty: number;
  rx: number;
  ry: number;
}

// Shown on first start (touchscreen, never calibrated) and from Settings:
// 1. colour fills to spot dead pixels / bad cabling, 2. tap 4 targets, 3. draw test with auto-revert.
@Component({
  selector: 'app-screen-test',
  templateUrl: './screen-test.component.html',
  styleUrls: ['./screen-test.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: false,
})
export class ScreenTestComponent implements OnDestroy {
  public step: 'colors' | 'waiting' | 'calibrate' | 'test' | 'error' = 'colors';
  public colorIndex = 0;
  public colors = COLORS;
  public targets = TARGETS;
  public points: CalibrationPoint[] = [];
  public dots: { x: number; y: number }[] = [];
  public message = '';
  public secondsLeft = REVERT_SECONDS;

  private matrix: number[] = [];
  private revertInterval: ReturnType<typeof setInterval>;
  private onMatrixSet = (_, result: { matrix?: number[]; error?: string }) =>
    this.zone.run(() => this.handleMatrixSet(result));

  public constructor(
    private appService: AppService,
    private electronService: ElectronService,
    private zone: NgZone,
  ) {
    this.electronService.on('touchMatrixSet', this.onMatrixSet);
  }

  public ngOnDestroy(): void {
    clearInterval(this.revertInterval);
    this.electronService.removeListener('touchMatrixSet', this.onMatrixSet);
  }

  public nextColor(): void {
    if (++this.colorIndex >= COLORS.length) {
      this.startCalibration();
    }
  }

  public startCalibration(message = ''): void {
    clearInterval(this.revertInterval);
    this.points = [];
    this.message = message;
    this.step = 'waiting';
    // raw (uncalibrated) touches are needed to compute a new matrix
    this.electronService.send('touchSetMatrix', IDENTITY);
  }

  public tapTarget(event: PointerEvent): void {
    const [tx, ty] = TARGETS[this.points.length];
    this.points.push({ tx, ty, rx: event.clientX / window.innerWidth, ry: event.clientY / window.innerHeight });
    if (this.points.length === TARGETS.length) {
      this.step = 'waiting';
      this.electronService.send('touchCalibrate', this.points);
    }
  }

  public draw(event: PointerEvent): void {
    this.dots = [...this.dots.slice(-40), { x: event.clientX, y: event.clientY }];
  }

  public save(): void {
    this.electronService.send('touchSave', this.matrix);
    this.close();
  }

  // puts the previous calibration back; on first start also remembers "skipped" so it isn't asked again
  public skip(): void {
    this.electronService.send('touchCancel');
    this.close();
  }

  private close(): void {
    clearInterval(this.revertInterval);
    this.appService.screenTestVisible = false;
  }

  private handleMatrixSet(result: { matrix?: number[]; error?: string }): void {
    if (result.error) {
      if (this.step === 'waiting' && this.points.length === TARGETS.length) {
        this.startCalibration(result.error); // bad taps: start over
      } else {
        this.message = result.error;
        this.step = 'error';
      }
      return;
    }
    if (this.points.length < TARGETS.length) {
      this.step = 'calibrate'; // identity applied, ready for taps
      return;
    }
    this.matrix = result.matrix;
    this.dots = [];
    this.step = 'test';
    // a wrong matrix can make touch unusable: go back unless the user confirms in time
    this.secondsLeft = REVERT_SECONDS;
    this.revertInterval = setInterval(() => {
      if (--this.secondsLeft <= 0) {
        this.startCalibration($localize`:@@calibration-reverted:Not confirmed, calibration reverted.`);
      }
    }, 1000);
  }
}

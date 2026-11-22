export interface PSUControlCommand {
  command: 'turnPSUOn' | 'turnPSUOff' | 'togglePSU' | 'getPSUState';
}

export interface PSUControlState {
  isPSUOn: boolean;
}

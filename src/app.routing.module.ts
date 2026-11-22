import { CommonModule } from '@angular/common';
import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

import { CompanionSettingsComponent } from './components/companion/companion-settings/companion-settings.component';
import { DashboardComponent } from './components/companion/dashboard/dashboard.component';
import { DeckComponent } from './components/companion/deck/deck.component';
import { EditorComponent } from './components/companion/editor/editor.component';
import { MusicComponent } from './components/companion/music/music.component';
import { ControlComponent } from './components/control/control.component';
import { FilamentComponent } from './components/filament/filament.component';
import { FilesComponent } from './components/files/files.component';
import { MainScreenComponent } from './components/main-screen/main-screen.component';
import { SettingsComponent } from './components/settings/settings.component';
import { ConfigInvalidComponent } from './components/setup/invalid-config/invalid-config.component';
import { ConfigSetupComponent } from './components/setup/setup.component';

const routes: Routes = [
  {
    path: 'home',
    component: DashboardComponent,
  },
  {
    path: 'editor',
    component: EditorComponent,
  },
  {
    path: 'companion-settings',
    component: CompanionSettingsComponent,
  },
  {
    path: 'deck',
    component: DeckComponent,
  },
  {
    path: 'music',
    component: MusicComponent,
  },
  {
    path: 'main-screen',
    component: MainScreenComponent,
  },
  {
    path: 'control',
    component: ControlComponent,
  },
  {
    path: 'filament',
    component: FilamentComponent,
  },
  {
    path: 'files',
    component: FilesComponent,
  },
  {
    path: 'invalid-config',
    component: ConfigInvalidComponent,
  },
  {
    path: 'no-config',
    component: ConfigSetupComponent,
  },
  {
    path: 'settings',
    component: SettingsComponent,
  },
];

@NgModule({
  declarations: [],
  imports: [CommonModule, RouterModule.forRoot(routes, { useHash: true, enableViewTransitions: true })],
  exports: [RouterModule],
})
export class AppRoutingModule {}

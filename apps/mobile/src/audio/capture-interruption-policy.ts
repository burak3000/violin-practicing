export type MobileRouteChangeReason =
  | 'Unknown'
  | 'Override'
  | 'CategoryChange'
  | 'WakeFromSleep'
  | 'NewDeviceAvailable'
  | 'OldDeviceUnavailable'
  | 'ConfigurationChange'
  | 'NoSuitableRouteForCategory';

export type CapturePauseResumeMode = 'automatic' | 'manual';

export interface CapturePauseDescriptor {
  readonly message: string;
  readonly resumeMode: CapturePauseResumeMode;
}

export function interruptionBeganPauseDescriptor(): CapturePauseDescriptor {
  return {
    message: 'Audio interrupted — waiting for the system to hand the session back.',
    resumeMode: 'automatic',
  };
}

export function interruptionEndedManualPauseDescriptor(): CapturePauseDescriptor {
  return {
    message: 'Audio interruption ended. Tap Resume to continue listening.',
    resumeMode: 'manual',
  };
}

export function backgroundPauseDescriptor(): CapturePauseDescriptor {
  return {
    message: 'Capture paused while the app was in the background. Tap Resume when you are ready.',
    resumeMode: 'manual',
  };
}

export function shouldAutoResumeAfterInterruptionEnded({
  shouldResume,
  appIsActive,
  backgroundPausePending,
}: {
  shouldResume: boolean;
  appIsActive: boolean;
  backgroundPausePending: boolean;
}): boolean {
  return shouldResume && appIsActive && !backgroundPausePending;
}

export function shouldTreatRouteChangeAsDisconnect(reason: MobileRouteChangeReason): boolean {
  return reason === 'OldDeviceUnavailable' || reason === 'NoSuitableRouteForCategory';
}

export function describeRouteChangeDisconnect(reason: MobileRouteChangeReason): string {
  switch (reason) {
    case 'OldDeviceUnavailable':
      return 'Input device disconnected. Reconnect your audio interface, then tap Start.';
    case 'NoSuitableRouteForCategory':
      return 'No suitable audio input route is available. Reconnect your audio interface, then tap Start.';
    default:
      return 'Audio input changed unexpectedly. Reconnect your audio interface, then tap Start.';
  }
}

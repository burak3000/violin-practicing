import { describe, expect, it } from 'vitest';
import {
  backgroundPauseDescriptor,
  describeRouteChangeDisconnect,
  interruptionBeganPauseDescriptor,
  interruptionEndedManualPauseDescriptor,
  shouldAutoResumeAfterInterruptionEnded,
  shouldTreatRouteChangeAsDisconnect,
} from './capture-interruption-policy';

describe('capture-interruption-policy', () => {
  it('auto-resumes only when the system allows it and the app is still active', () => {
    expect(
      shouldAutoResumeAfterInterruptionEnded({
        shouldResume: true,
        appIsActive: true,
        backgroundPausePending: false,
      }),
    ).toBe(true);

    expect(
      shouldAutoResumeAfterInterruptionEnded({
        shouldResume: false,
        appIsActive: true,
        backgroundPausePending: false,
      }),
    ).toBe(false);

    expect(
      shouldAutoResumeAfterInterruptionEnded({
        shouldResume: true,
        appIsActive: false,
        backgroundPausePending: false,
      }),
    ).toBe(false);

    expect(
      shouldAutoResumeAfterInterruptionEnded({
        shouldResume: true,
        appIsActive: true,
        backgroundPausePending: true,
      }),
    ).toBe(false);
  });

  it('marks only unplugged-or-no-route changes as disconnect-worthy', () => {
    expect(shouldTreatRouteChangeAsDisconnect('OldDeviceUnavailable')).toBe(true);
    expect(shouldTreatRouteChangeAsDisconnect('NoSuitableRouteForCategory')).toBe(true);
    expect(shouldTreatRouteChangeAsDisconnect('NewDeviceAvailable')).toBe(false);
    expect(shouldTreatRouteChangeAsDisconnect('ConfigurationChange')).toBe(false);
  });

  it('describes the paused states with the intended copy', () => {
    expect(interruptionBeganPauseDescriptor()).toEqual({
      message: 'Audio interrupted — waiting for the system to hand the session back.',
      resumeMode: 'automatic',
    });
    expect(interruptionEndedManualPauseDescriptor()).toEqual({
      message: 'Audio interruption ended. Tap Resume to continue listening.',
      resumeMode: 'manual',
    });
    expect(backgroundPauseDescriptor()).toEqual({
      message: 'Capture paused while the app was in the background. Tap Resume when you are ready.',
      resumeMode: 'manual',
    });
  });

  it('uses route-specific disconnect messages', () => {
    expect(describeRouteChangeDisconnect('OldDeviceUnavailable')).toBe(
      'Input device disconnected. Reconnect your audio interface, then tap Start.',
    );
    expect(describeRouteChangeDisconnect('NoSuitableRouteForCategory')).toBe(
      'No suitable audio input route is available. Reconnect your audio interface, then tap Start.',
    );
    expect(describeRouteChangeDisconnect('Unknown')).toBe(
      'Audio input changed unexpectedly. Reconnect your audio interface, then tap Start.',
    );
  });
});

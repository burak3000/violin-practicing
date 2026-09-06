/**
 * Input-device enumeration/selection (task point 1). Runs on the main
 * renderer thread (uses `navigator.mediaDevices`) -- part of the
 * DOM-lib tsconfig project, NOT the worklet.
 */

export interface AudioInputDevice {
  readonly deviceId: string;
  readonly label: string;
}

export type DeviceEnumerationError = 'permission-denied' | 'no-devices' | 'unsupported' | 'unknown';

export type DeviceEnumerationResult =
  | { readonly ok: true; readonly devices: readonly AudioInputDevice[] }
  | { readonly ok: false; readonly error: DeviceEnumerationError; readonly message: string };

/**
 * Requests microphone permission (device *labels* are blank until
 * permission is granted, in Electron as in any Chromium-based browser)
 * and returns the `audioinput` device list.
 *
 * Never throws: every failure mode (permission denied, no devices,
 * `enumerateDevices` unsupported, or any other unexpected error) resolves
 * to `{ ok: false, ... }` with a specific, UI-displayable reason -- this is
 * the "fail gracefully instead of crashing when no device grants are
 * available" path this phase's verification explicitly calls for (e.g. a
 * sandboxed/headless environment with no real mic).
 */
export async function requestMicPermissionAndListInputDevices(): Promise<DeviceEnumerationResult> {
  if (!navigator.mediaDevices?.getUserMedia || !navigator.mediaDevices?.enumerateDevices) {
    return {
      ok: false,
      error: 'unsupported',
      message: 'This Electron build does not expose navigator.mediaDevices.',
    };
  }

  let permissionStream: MediaStream | undefined;
  try {
    // Momentary generic-audio permission request purely to unlock device
    // *labels* in the enumerateDevices() call below -- the real capture
    // stream (specific deviceId + echoCancellation/noiseSuppression/
    // autoGainControl constraints) is opened separately in
    // capture-pipeline.ts once the user picks a device. Stopped
    // immediately in `finally`; never left open.
    permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    return classifyGetUserMediaError(err);
  } finally {
    permissionStream?.getTracks().forEach((track) => track.stop());
  }

  try {
    const allDevices = await navigator.mediaDevices.enumerateDevices();
    const inputs: AudioInputDevice[] = allDevices
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({
        deviceId: d.deviceId,
        label: d.label || `Audio input (${d.deviceId.slice(0, 8)})`,
      }));

    if (inputs.length === 0) {
      return {
        ok: false,
        error: 'no-devices',
        message: 'No audio input devices were found on this machine.',
      };
    }
    return { ok: true, devices: inputs };
  } catch (err) {
    return { ok: false, error: 'unknown', message: describeError(err) };
  }
}

function classifyGetUserMediaError(err: unknown): {
  ok: false;
  error: DeviceEnumerationError;
  message: string;
} {
  const name = err instanceof DOMException ? err.name : undefined;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return {
      ok: false,
      error: 'permission-denied',
      message:
        'Microphone/line-in permission was denied. Grant access in System Settings and try again.',
    };
  }
  if (name === 'NotFoundError') {
    return {
      ok: false,
      error: 'no-devices',
      message: 'No audio input devices were found on this machine.',
    };
  }
  return { ok: false, error: 'unknown', message: describeError(err) };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

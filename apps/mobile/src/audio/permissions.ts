/**
 * Microphone-permission flow (Phase 4 task point 2). Wraps
 * react-native-audio-api's `AudioManager` permission calls behind a
 * never-throwing surface -- mirrors apps/desktop/src/audio/
 * device-enumeration.ts's own convention for the same reason: a UI
 * shouldn't need to wrap every call in a try/catch to render a sensible
 * state, and `AudioManager`'s own methods are typed as `Promise`-returning
 * without documenting whether they can reject.
 *
 * iOS and Android have genuinely different re-request semantics (the
 * plan's mobile-platform edge cases call this out explicitly): iOS shows
 * its system permission dialog at most once ever per install -- calling
 * `requestRecordingPermissions()` again after a denial does NOT re-show
 * it, it just resolves to 'Denied' immediately, so the only way forward is
 * deep-linking to the Settings app. Android's OS dialog CAN be shown again
 * (the OS itself decides whether to add a "don't ask again" checkbox after
 * a repeat denial), so a plain "try again" button is still meaningfully
 * different there. `canRePromptAfterDenial` lets the UI (App.tsx) choose
 * copy/behavior accordingly; this module doesn't hide that platform
 * difference behind a single boolean state machine.
 */
import { Linking, Platform } from 'react-native';
import { AudioManager, type PermissionStatus } from 'react-native-audio-api';

export type { PermissionStatus };

export async function checkMicPermission(): Promise<PermissionStatus> {
  try {
    return await AudioManager.checkRecordingPermissions();
  } catch {
    return 'Undetermined';
  }
}

export async function requestMicPermission(): Promise<PermissionStatus> {
  try {
    return await AudioManager.requestRecordingPermissions();
  } catch {
    return 'Denied';
  }
}

/**
 * Deep-links to this app's OS settings screen -- the only way forward once
 * iOS has denied once (see module doc comment). `Linking.openSettings()`
 * opens the app's own settings page on iOS and the app-info screen on
 * Android, so this one call is correct on both platforms.
 */
export async function openAppSettings(): Promise<void> {
  await Linking.openSettings();
}

/**
 * Whether the OS permission dialog can plausibly be shown again after a
 * denial without leaving Settings. True on Android (not a hard guarantee
 * -- the OS may itself decide to stop prompting after repeated denials --
 * but a retry is still meaningful there); false on iOS, where a denial is
 * permanent until the user changes it in Settings.
 */
export const CAN_RE_PROMPT_AFTER_DENIAL = Platform.OS === 'android';

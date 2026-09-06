/**
 * Pure derivation of the message to show when `useAudioInput()`'s
 * `onSelectInput()` rejects. Extracted from the Phase 4 debug UI's inline
 * `App.tsx` catch handler (unchanged behavior, just pulled out into its
 * own testable function) so this platform/error branching doesn't need a
 * React Native environment or a mocked `Platform.OS` to exercise -- the
 * caller passes in the one fact (`isAndroid`) this function actually
 * needs, instead of this module importing 'react-native' itself.
 *
 * See apps/mobile/CLAUDE.md's "External audio interface" section: as of
 * react-native-audio-api 0.13.3, explicit input-device selection is
 * iOS-only -- `onSelectInput` calls `AudioManager.setInputDevice`
 * unconditionally on both platforms, so an Android rejection here is an
 * *expected*, library-version-specific limitation, not a real failure, and
 * gets a specific, friendlier explanation rather than surfacing whatever
 * raw error the native side happens to throw. A rejection on iOS (where
 * selection is supposed to work) is unexpected, so it surfaces the real
 * error message instead, since that's worth seeing verbatim.
 */
export function describeInputSelectError(err: unknown, isAndroid: boolean): string {
  if (isAndroid) {
    return 'Input selection is iOS-only in this version of react-native-audio-api; Android routes automatically.';
  }
  return err instanceof Error ? err.message : String(err);
}

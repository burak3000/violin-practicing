import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, ScrollView, StyleSheet, View, Pressable, Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import {
  analyzeTunerReading,
  TunerDisplaySmoother,
  type FingerTunerReading,
  type PitchReading,
  type SequenceDirection,
  type SequencePatternType,
  type SmoothedTunerReading,
  type ViolinStringName,
} from '@violin/core';
import {
  checkMicPermission,
  requestMicPermission,
  openAppSettings,
  type PermissionStatus,
} from './src/audio/permissions';
import {
  MicCaptureController,
  type CaptureState,
  type MobileAnalysisResult,
} from './src/audio/mic-capture-controller';
import { FingerTunerScreen } from './src/tuner/FingerTunerScreen';
import { RollingStats } from './src/tuner/rolling-stats';
import {
  INITIAL_PLAYING_PRACTICE_VIEW_STATE,
  PlayingPracticeController,
  type PlayingPracticeViewState,
} from './src/practice/playing-practice-controller';
import { PlayingPracticeScreen } from './src/practice/PlayingPracticeScreen';

/**
 * Phase 5 Part B: the real mobile Finger Tuner, replacing the Phase 4
 * debug UI. This file owns session mechanics only (permission requests,
 * starting/stopping capture, and turning each analysis hop into a
 * displayable reading) -- everything about what's actually on screen
 * lives in src/tuner/FingerTunerScreen.tsx, which this renders and feeds
 * via props. Mirrors apps/desktop/src/renderer.ts's own composition root
 * role. See CLAUDE.md for what is/isn't verified about this file in this
 * (sandboxed, no-simulator) phase.
 *
 * Deliberately unchanged from Phase 4: the capture/DSP wiring itself
 * (MicCaptureController, permissions.ts, and everything under
 * @violin/dsp-ts) -- this phase only changes how the pipeline's output is
 * consumed and displayed.
 *
 * **Phase 6 Part B update**: a second mode, Playing Practice, now sits
 * alongside Finger Tuner behind a mode-tabs switcher (mirrors
 * apps/desktop/src/renderer.ts's own Phase 6 "Mode switcher" design
 * exactly in spirit) -- both modes share this one running capture session
 * (there is no separate "start capture" per mode), and both keep scoring
 * in the background regardless of which tab is currently visible (see the
 * two <ScrollView>s in the JSX below, toggled via
 * `display: 'none'`/`'flex'` rather than conditional rendering, so neither
 * screen is ever unmounted on a tab switch and Playing Practice never
 * loses its place in the sequence). Finger Tuner's own wiring/rendering
 * above is untouched except for one small, behavior-preserving change: the
 * `onAnalysis` callback below now reads `performance.now()` once per hop
 * into a local `timestampMs`, reused for both `smoother.update(...)` (as
 * before) and the new `PlayingPracticeController.handleAnalysisFrame(...)`
 * call, instead of calling it twice inline -- see that callback's own
 * comment.
 *
 * **Phase 7 Part B update**: one new callback, `onSkipDrillPractice`,
 * wired to `PlayingPracticeController.skipDrill()` and passed to
 * `PlayingPracticeScreen` as `onSkipDrill` -- the real Drilling UI's "Skip
 * this drill" button (see `apps/mobile/CLAUDE.md`'s "Drilling UI (Phase 7
 * Part B)" section and `playing-practice-controller.ts`'s own doc comment).
 * Mirrors `onGiveUpPractice`'s existing shape exactly; nothing else in this
 * file changed for this phase.
 *
 * **Phase 8 update**: app boot is now eager rather than lazy for the
 * permission/native-audio setup the plan explicitly prioritizes -- this
 * file configures the recording session, asks for mic permission on first
 * mount when it has not been decided yet, preps MicCaptureController's
 * interruption observers immediately, and listens to React Native's
 * `AppState` so backgrounding/inactivation pauses capture instead of
 * leaving the UI pretending it is still listening.
 */
export default function App() {
  // Boot-time eager setup (Phase 8): configuring the recording session is
  // harmless before permission is granted (see
  // MicCaptureController.configureSession's own doc comment: it only sets
  // options, it doesn't activate the session), and the plan explicitly
  // prefers paying this one-time cost at launch rather than on the user's
  // first "start practicing" tap. Actual capture still remains opt-in via
  // the Start/Resume controls below.
  useEffect(() => {
    MicCaptureController.configureSession();
  }, []);

  const [permission, setPermission] = useState<PermissionStatus>('Undetermined');
  const [permissionBusy, setPermissionBusy] = useState(false);

  const refreshPermission = useCallback((requestIfUndetermined: boolean) => {
    setPermissionBusy(true);
    void checkMicPermission()
      .then(async (status) => {
        if (status === 'Undetermined' && requestIfUndetermined) {
          return requestMicPermission();
        }
        return status;
      })
      .then((status) => {
        setPermission(status);
        setPermissionBusy(false);
      });
  }, []);

  useEffect(() => {
    refreshPermission(true);
  }, [refreshPermission]);

  const onRequestPermission = useCallback(() => {
    refreshPermission(true);
  }, [refreshPermission]);

  const [captureState, setCaptureState] = useState<CaptureState>({ status: 'idle' });

  // The vibrato-aware smoothing layer this whole phase is about -- Part
  // A's `TunerDisplaySmoother` (packages/core/src/tuner/
  // tuner-display-smoother.ts), reused verbatim, not re-derived. One
  // instance for the app's lifetime (stable across re-renders via
  // useState's lazy initializer, which React guarantees runs only once --
  // see https://react.dev/reference/react/useState#avoiding-recreating-
  // the-initial-state -- unlike `useRef(new TunerDisplaySmoother())`,
  // which would construct-and-discard a fresh instance on every render).
  const [smoother] = useState(() => new TunerDisplaySmoother());
  const [computeStats] = useState(() => new RollingStats());

  const [rawReading, setRawReading] = useState<FingerTunerReading>({ status: 'no-signal' });
  const [smoothedReading, setSmoothedReading] = useState<SmoothedTunerReading>({
    status: 'no-signal',
  });
  const [onsetState, setOnsetState] = useState('—');
  const [clipping, setClipping] = useState(false);
  const [framesAnalyzed, setFramesAnalyzed] = useState(0);
  const [computeMs, setComputeMs] = useState<{
    last: number | undefined;
    mean: number | undefined;
  }>({ last: undefined, mean: undefined });

  // --- Mode switcher + Playing Practice (Phase 6 Part B) -------------------

  const [mode, setMode] = useState<'tuner' | 'practice'>('tuner');

  // PlayingPracticeController is this app's headless analogue of
  // apps/desktop's `PlayingPracticeUi` (see that file/class's own doc
  // comment) -- one instance for the app's lifetime, constructed via the
  // same `useRef` + "construct once, guard on `.current`" pattern already
  // used for `controllerRef` below (NOT `useState(() => new ...)`, since
  // this controller also needs the `setPpViewState` setter passed into its
  // constructor, and `useRef` lets that happen inline without the
  // lazy-initializer ordering problem a `useState` call would have here).
  // `INITIAL_PLAYING_PRACTICE_VIEW_STATE` seeds the very first render with
  // exactly what a freshly-constructed controller's own `getViewState()`
  // would report (all four strings selected, default pattern/direction, a
  // populated live preview) -- see that constant's own doc comment for why
  // the controller itself never pushes this synchronously via `onChange`.
  const [ppViewState, setPpViewState] = useState<PlayingPracticeViewState>(
    INITIAL_PLAYING_PRACTICE_VIEW_STATE,
  );
  const ppControllerRef = useRef<PlayingPracticeController | undefined>(undefined);
  if (!ppControllerRef.current) {
    ppControllerRef.current = new PlayingPracticeController({ onChange: setPpViewState });
  }

  const controllerRef = useRef<MicCaptureController | undefined>(undefined);
  if (!controllerRef.current) {
    controllerRef.current = new MicCaptureController({
      onState: setCaptureState,
      onAnalysis: (result: MobileAnalysisResult) => {
        setFramesAnalyzed((n) => n + 1);
        setOnsetState(result.onsetState);
        setClipping(result.clipping);

        computeStats.push(result.computeTimeMs);
        setComputeMs({ last: computeStats.last, mean: computeStats.mean });

        // Same wiring apps/desktop/src/renderer.ts uses: feed `voiced`
        // continuously (Finger-Tuner-style, undebounced) into
        // packages/core's analyzeTunerReading -- see that file and
        // packages/core/CLAUDE.md's Finger Tuner section for why. New
        // this phase: the raw per-hop FingerTunerReading is then run
        // through the same shared TunerDisplaySmoother apps/desktop uses
        // before it reaches the primary display.
        //
        // `performance.now()` is read here, directly in this JS-thread
        // callback, as the shared timestamp source for everything below --
        // Finger Tuner's smoother AND (new in Phase 6 Part B) Playing
        // Practice's controller both need "when did this hop happen," and
        // reading it once into `timestampMs` keeps both consumers on the
        // identical value for this hop rather than two independent
        // `performance.now()` calls microseconds apart. Unlike desktop
        // (whose worklet runs on a separate real-time audio thread and has
        // to relay a timestamp across to the main thread, relying on the
        // documented-but-not-spec-guaranteed assumption that both threads
        // share a performance.now() time origin -- see
        // apps/desktop/CLAUDE.md's "Latency measurement" section), this
        // app's event-callback DSP hosting (see mic-capture-controller.ts's
        // own doc comment) already runs everything on one JS thread, so
        // there's no cross-thread relay assumption to make at all here --
        // if anything, a simpler and more directly-correct case than
        // desktop's.
        const timestampMs = performance.now();
        const pitchReading: PitchReading = {
          voiced: result.voiced,
          frequencyHz: result.frequencyHz,
          confidence: result.confidence,
        };
        const raw = analyzeTunerReading(pitchReading);
        const smoothed = smoother.update(raw, timestampMs);
        setRawReading(raw);
        setSmoothedReading(smoothed);

        // Phase 6 Part B, purely additive: the same raw reading/rawReading
        // this hop already computed above is also fed to Playing
        // Practice's own scoring path (PracticeAttemptTracker, NOT
        // TunerDisplaySmoother -- see playing-practice-controller.ts's
        // module doc comment for why). A no-op whenever no Playing
        // Practice sequence has been started yet, and independent of
        // which mode tab is currently visible (see this file's own top
        // comment) -- mirrors apps/desktop/src/renderer.ts's identical
        // `playingPracticeUi.handleAnalysisFrame(...)` call exactly.
        ppControllerRef.current?.handleAnalysisFrame(pitchReading, raw, timestampMs);
      },
    });
  }

  useEffect(() => {
    controllerRef.current?.prepare();
  }, []);

  // Mirrors apps/desktop/src/renderer.ts's resetTunerDisplay(), called
  // whenever capture isn't actively running. Desktop calls this for
  // idle/starting/stopped/error, i.e. every state except its own
  // running/self-test; mobile's CaptureState has no 'self-test' state to
  // additionally exclude (see mic-capture-controller.ts), so "not
  // running" is the complete, equivalent condition here.
  useEffect(() => {
    if (captureState.status !== 'running') {
      smoother.reset();
      setRawReading({ status: 'no-signal' });
      setSmoothedReading({ status: 'no-signal' });
    }
  }, [captureState.status, smoother]);

  useEffect(() => {
    // Stop capture on unmount so a hot-reload / screen change doesn't
    // leave a dangling native recording session or system-event listener.
    return () => {
      void controllerRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      const isActive = nextState === 'active';
      controllerRef.current?.setAppActive(isActive);

      if (!isActive) {
        void controllerRef.current?.pauseForBackground();
        return;
      }

      refreshPermission(false);
    });

    controllerRef.current?.setAppActive(AppState.currentState === 'active');
    return () => {
      subscription.remove();
    };
  }, [refreshPermission]);

  const onStart = useCallback(() => {
    setFramesAnalyzed(0);
    computeStats.reset();
    setComputeMs({ last: undefined, mean: undefined });
    void controllerRef.current?.start();
  }, [computeStats]);

  const onStop = useCallback(() => {
    void controllerRef.current?.stop();
  }, []);

  const onOpenSettings = useCallback(() => {
    void openAppSettings();
  }, []);

  const onToggleString = useCallback((name: ViolinStringName, selected: boolean) => {
    ppControllerRef.current?.setStringSelected(name, selected);
  }, []);
  const onSetPatternType = useCallback((pattern: SequencePatternType) => {
    ppControllerRef.current?.setPatternType(pattern);
  }, []);
  const onSetDirection = useCallback((direction: SequenceDirection) => {
    ppControllerRef.current?.setDirection(direction);
  }, []);
  const onSetMinFrequencyText = useCallback((text: string) => {
    ppControllerRef.current?.setMinFrequencyText(text);
  }, []);
  const onSetMaxFrequencyText = useCallback((text: string) => {
    ppControllerRef.current?.setMaxFrequencyText(text);
  }, []);
  const onStartPractice = useCallback(() => {
    ppControllerRef.current?.start();
  }, []);
  const onGiveUpPractice = useCallback(() => {
    ppControllerRef.current?.giveUp();
  }, []);
  // Phase 7 Part B: "Skip this drill" -- see
  // PlayingPracticeController.skipDrill() (-> PracticeSessionController.
  // skipDrill() -> DrillingMachine.skip()). Mirrors onGiveUpPractice's own
  // shape exactly; PlayingPracticeScreen only ever renders the button that
  // calls this while `showSkipDrillButton` is true (mutually exclusive with
  // onGiveUpPractice's own button).
  const onSkipDrillPractice = useCallback(() => {
    ppControllerRef.current?.skipDrill();
  }, []);
  const onRestartPractice = useCallback(() => {
    ppControllerRef.current?.restart();
  }, []);

  return (
    <View style={styles.container}>
      <StatusBar style="auto" />

      {/* Mode switcher (Phase 6 Part B) -- mirrors
          apps/desktop/index.html's `.mode-tabs` nav exactly in role: two
          plain toggle buttons, Finger Tuner the default active mode so its
          existing appearance/behavior is unchanged for anyone who never
          touches the new tab. */}
      <View style={styles.modeTabs}>
        <ModeTab label="Finger Tuner" active={mode === 'tuner'} onPress={() => setMode('tuner')} />
        <ModeTab
          label="Playing Practice"
          active={mode === 'practice'}
          onPress={() => setMode('practice')}
        />
      </View>

      {/* Both screens stay permanently mounted, toggled only via
          `display: 'none'`/`'flex'` (never conditionally rendered) -- see
          this file's top comment for why: Playing Practice must keep
          scoring in the background while Finger Tuner's tab is showing
          (and vice versa), and neither screen's own local UI state (e.g.
          the debug panel's collapsed/expanded flag) should reset just from
          switching tabs. Each keeps its own independent scroll position. */}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.scroll}
        style={mode === 'tuner' ? styles.flexOne : styles.hiddenScreen}
      >
        <FingerTunerScreen
          permission={permission}
          permissionBusy={permissionBusy}
          onRequestPermission={onRequestPermission}
          onOpenSettings={onOpenSettings}
          captureState={captureState}
          onStart={onStart}
          onStop={onStop}
          rawReading={rawReading}
          smoothedReading={smoothedReading}
          onsetState={onsetState}
          clipping={clipping}
          framesAnalyzed={framesAnalyzed}
          computeMsLast={computeMs.last}
          computeMsMean={computeMs.mean}
        />
      </ScrollView>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.scroll}
        style={mode === 'practice' ? styles.flexOne : styles.hiddenScreen}
      >
        <PlayingPracticeScreen
          viewState={ppViewState}
          captureNotice={
            captureState.status === 'paused' || captureState.status === 'error'
              ? {
                  message: captureState.message,
                  actionLabel:
                    captureState.status === 'paused'
                      ? captureState.resumeMode === 'manual'
                        ? 'Resume listening'
                        : undefined
                      : 'Start listening',
                }
              : undefined
          }
          onResumeCapture={onStart}
          onToggleString={onToggleString}
          onSetPatternType={onSetPatternType}
          onSetDirection={onSetDirection}
          onSetMinFrequencyText={onSetMinFrequencyText}
          onSetMaxFrequencyText={onSetMaxFrequencyText}
          onStart={onStartPractice}
          onGiveUp={onGiveUpPractice}
          onSkipDrill={onSkipDrillPractice}
          onRestart={onRestartPractice}
        />
      </ScrollView>
    </View>
  );
}

function ModeTab({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.modeTab, active && styles.modeTabActive]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.modeTabLabel, active && styles.modeTabLabelActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  scroll: {
    padding: 16,
    paddingTop: 16,
    paddingBottom: 40,
  },
  // Both screens' outer <ScrollView> gets one of these two styles (see the
  // JSX above) -- `flexOne` for the active tab, `hiddenScreen` for the
  // inactive one. `display: 'none'` (not conditional rendering) keeps the
  // inactive screen mounted -- see this file's top comment.
  flexOne: {
    flex: 1,
  },
  hiddenScreen: {
    display: 'none',
  },
  modeTabs: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 8,
  },
  modeTab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ddd',
    backgroundColor: '#f7f7f7',
  },
  modeTabActive: {
    backgroundColor: '#eaf3ff',
    borderColor: '#8fbcf5',
  },
  modeTabLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#666',
  },
  modeTabLabelActive: {
    color: '#1a4d8f',
  },
});

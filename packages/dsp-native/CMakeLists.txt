cmake_minimum_required(VERSION 3.20)
project(dsp_native LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Pitch-detection timing numbers are meaningless in an unoptimized debug
# build, and this package has no debugging-under-a-debugger workflow that
# would need one — default to Release unless the caller explicitly asked
# for something else (still overridable with -DCMAKE_BUILD_TYPE=Debug).
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

# Phase 1 (see ../../temp/PLAN-violin-practice-app.md): YIN and MPM
# pitch-detection algorithms, a note-onset/duration segmentation layer, a
# harmonicity/HNR confidence signal, and the CTest-driven validation
# harness that empirically compares them. See ./CLAUDE.md for what's
# implemented, how to run/extend the harness, and the resulting numbers.
# This is what apps/desktop's native addon / WASM build and (if the mobile
# fallback in Phase 4b triggers) the C++ TurboModule will eventually wrap —
# still no platform bindings here, per Phase 1's explicit scope.

add_library(dsp_native STATIC
  src/types.cpp
  src/note_utils.cpp
  src/wav_file.cpp
  src/yin_detector.cpp
  src/mpm_detector.cpp
  src/harmonicity.cpp
  src/onset_detector.cpp
)
target_include_directories(dsp_native PUBLIC include)
target_compile_options(dsp_native PRIVATE
  $<$<NOT:$<CXX_COMPILER_ID:MSVC>>:-Wall -Wextra>
  $<$<CXX_COMPILER_ID:MSVC>:/W4>
)

enable_testing()

# Step 1 of the harness pipeline: generate synthetic WAV fixtures (sine +
# sawtooth chromatic sweep, plus the adversarial weak-fundamental set) into
# the source tree's test/fixtures/synthetic/ so they're inspectable (e.g.
# in Audacity) and so the manifest.csv ground truth lives next to the WAVs
# it describes. Registered as a CTest "fixture setup" so `ctest` always
# regenerates them fresh before the comparison runs.
add_executable(generate_synthetic_fixtures test/generate_synthetic_fixtures.cpp)
target_link_libraries(generate_synthetic_fixtures PRIVATE dsp_native)

add_test(NAME generate_synthetic_fixtures
         COMMAND generate_synthetic_fixtures "${CMAKE_CURRENT_SOURCE_DIR}/test/fixtures/synthetic")
set_tests_properties(generate_synthetic_fixtures PROPERTIES FIXTURES_SETUP synthetic_fixtures)

# Step 2: the actual YIN-vs-MPM comparison, against the freshly-generated
# synthetic fixtures, the checked-in University of Iowa real recordings
# (test/fixtures/iowa), and the (currently empty, pending) user-violin tier
# (test/fixtures/user-violin). Writes CSVs + a summary to test/results/.
add_executable(dsp_native_validation_harness test/validation_harness.cpp)
target_link_libraries(dsp_native_validation_harness PRIVATE dsp_native)

add_test(NAME dsp_native_validation_harness
         COMMAND dsp_native_validation_harness "${CMAKE_CURRENT_SOURCE_DIR}/test")
set_tests_properties(dsp_native_validation_harness PROPERTIES FIXTURES_REQUIRED synthetic_fixtures)

/**
 * The real `AbcFilePicker` for the mobile ABC Notation mode: shows the
 * system document picker (Files app on iOS, the system picker on Android) and
 * reads the chosen file as text, using `expo-file-system`'s own picker
 * (`File.pickFileAsync`) so no separate document-picker module is needed.
 *
 * Kept out of `abc-practice-controller.ts` so that module stays free of any
 * native-module import and unit-testable under Vitest.
 *
 * Not restricted by MIME type: `.abc` has no registered type on iOS, and
 * Android file providers label it inconsistently (`text/plain`,
 * `text/vnd.abc`, `application/octet-stream`), so filtering would hide the
 * very files the user is looking for. `parseAbc` is what decides whether a
 * file is really ABC, and it says so clearly if it isn't.
 */

import { File } from 'expo-file-system';
import { MAX_ABC_TEXT_LENGTH } from '@violin/core';
import type { AbcFilePicker } from './abc-practice-controller';

/** UTF-8 is at most 4 bytes per character, so anything bigger can't be within `parseAbc`'s size cap. */
const MAX_ABC_FILE_BYTES = MAX_ABC_TEXT_LENGTH * 4;

export const pickAbcFile: AbcFilePicker = async () => {
  const picked = await File.pickFileAsync();
  if (picked.canceled) return undefined;

  const file = picked.result;
  if (file.size > MAX_ABC_FILE_BYTES) {
    throw new Error(`"${file.name}" is too large to be an ABC file.`);
  }
  try {
    return { name: file.name, text: await file.text() };
  } catch (err) {
    throw new Error(
      `Could not read "${file.name}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
};

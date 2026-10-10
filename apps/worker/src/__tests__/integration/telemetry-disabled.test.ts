import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { db } from '@repo/db';
import { processTelemetry } from '../../telemetry';

const originalDisabled = process.env.TELEMETRY_DISABLED;
const originalDoNotTrack = process.env.DO_NOT_TRACK;

afterEach(() => {
  if (originalDisabled === undefined) delete process.env.TELEMETRY_DISABLED;
  else process.env.TELEMETRY_DISABLED = originalDisabled;
  if (originalDoNotTrack === undefined) delete process.env.DO_NOT_TRACK;
  else process.env.DO_NOT_TRACK = originalDoNotTrack;
});

describe('disabled usage telemetry', () => {
  it('does not read usage, create an identifier, or send requests without explicit opt-in', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch');
    const selectSpy = spyOn(db, 'select');
    const insertSpy = spyOn(db, 'insert');
    const executeSpy = spyOn(db, 'execute');
    try {
      for (const [disabled, doNotTrack] of [
        [undefined, undefined],
        ['', '0'],
        ['1', '0'],
        ['false', '0'],
        ['0', '1'],
        ['0', 'true'],
      ]) {
        if (disabled === undefined) delete process.env.TELEMETRY_DISABLED;
        else process.env.TELEMETRY_DISABLED = disabled;
        if (doNotTrack === undefined) delete process.env.DO_NOT_TRACK;
        else process.env.DO_NOT_TRACK = doNotTrack;
        await processTelemetry();
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(selectSpy).not.toHaveBeenCalled();
      expect(insertSpy).not.toHaveBeenCalled();
      expect(executeSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      selectSpy.mockRestore();
      insertSpy.mockRestore();
      executeSpy.mockRestore();
    }
  });
});

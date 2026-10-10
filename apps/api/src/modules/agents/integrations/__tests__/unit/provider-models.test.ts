import { expect, it, spyOn } from 'bun:test';
import { listModelsForProvider } from '../../provider-models';

it('does not request the external model catalogue without explicit opt-in', async () => {
  const original = process.env.MODEL_CATALOG_ENABLED;
  const fetchSpy = spyOn(globalThis, 'fetch');
  try {
    for (const value of [undefined, '', '0']) {
      if (value === undefined) delete process.env.MODEL_CATALOG_ENABLED;
      else process.env.MODEL_CATALOG_ENABLED = value;
      expect(await listModelsForProvider('openai')).toEqual([]);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    if (original === undefined) delete process.env.MODEL_CATALOG_ENABLED;
    else process.env.MODEL_CATALOG_ENABLED = original;
    fetchSpy.mockRestore();
  }
});

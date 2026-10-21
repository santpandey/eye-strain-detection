import { describe, expect, it } from 'vitest';
import { isStaleModuleError } from '../src/lib/stale';

describe('isStaleModuleError', () => {
  it('matches Chrome/Edge dynamic-import failures', () => {
    expect(
      isStaleModuleError(
        new TypeError('error loading dynamically imported module: http://localhost:5173/src/lib/vision/engine.ts?t=1'),
      ),
    ).toBe(true);
  });

  it('matches other browsers wordings', () => {
    expect(isStaleModuleError(new Error('Failed to fetch dynamically imported module'))).toBe(true);
    expect(isStaleModuleError('Importing a module script failed.')).toBe(true);
  });

  it('rejects ordinary errors', () => {
    expect(isStaleModuleError(new Error('No usable camera was found on this device.'))).toBe(false);
    expect(isStaleModuleError(new DOMException('denied', 'NotAllowedError'))).toBe(false);
    expect(isStaleModuleError('Could not play that video file.')).toBe(false);
  });
});

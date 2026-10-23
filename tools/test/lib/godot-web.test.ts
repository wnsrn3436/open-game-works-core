import { describe, expect, it } from 'vitest';
import { filledServiceWorker } from '../../src/lib/godot-web.ts';

describe('filledServiceWorker', () => {
  const template = [
    '// ogw: null body status and status 0 fixed',
    "const CACHE_VERSION = '___GODOT_VERSION___';",
    "const CACHE_NAME = '___GODOT_NAME___-sw-cache-' + CACHE_VERSION;",
    'const CACHED_FILES = ___GODOT_CACHED_FILES___;',
    'if (response.status === 0) return response;',
  ].join('\n');
  const exported = [
    "const CACHE_VERSION = '1729-a';",
    "const CACHE_NAME = 'Game-sw-cache-' + CACHE_VERSION;",
    'const CACHED_FILES = ["index.html","index.js"];',
    'const body = new Response(response.body, {});',
  ].join('\n');

  it('gives client core\'s worker the values the exporter filled into the exported one', () => {
    expect(filledServiceWorker(template, exported)).toBe([
      '// ogw: null body status and status 0 fixed',
      "const CACHE_VERSION = '1729-a';",
      "const CACHE_NAME = 'Game-sw-cache-' + CACHE_VERSION;",
      'const CACHED_FILES = ["index.html","index.js"];',
      'if (response.status === 0) return response;',
    ].join('\n'));
  });

  it('fails when a placeholder line of the template matches no line or two lines of the exported worker', () => {
    expect(() => filledServiceWorker(template, exported.replace("const CACHE_VERSION = '1729-a';", "let version = '1729-a';"))).toThrow('has 0 lines');
    expect(() => filledServiceWorker(template, `${exported}\nconst CACHE_VERSION = 'other';`)).toThrow('has 2 lines');
  });

  it('fails when the exported worker gives one placeholder two values', () => {
    const twice = `${template}\nconst AGAIN = '___GODOT_VERSION___!';`;
    expect(() => filledServiceWorker(twice, `${exported}\nconst AGAIN = 'other!';`)).toThrow('gives ___GODOT_VERSION___ two values');
  });
});

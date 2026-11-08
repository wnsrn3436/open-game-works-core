import { mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filledServiceWorker, launchValueFileError, webExportOptions, writePageLaunchValues } from '../../src/lib/godot-web.ts';

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

describe('webExportOptions', () => {
  it('gives only a DEV export the head include marker by which the web shell reads the launch value file of the page', () => {
    expect(webExportOptions('DEV')['html/head_include']).toBe('<script>window.ogwDevExport = true;</script>');
    for (const env of ['STG', 'PROD'] as const) {
      expect(webExportOptions(env)).not.toHaveProperty('html/head_include');
      expect(webExportOptions(env)['html/custom_html_shell']).toBe('res://core/web/ogw-shell.html');
    }
  });
});

describe('page launch values', () => {
  it('writes a launch value file under a new random name and gives the query parameter that names its URL path', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-page-')));
    const first = await writePageLaunchValues(dir, '/app/', { OGW_INSTANCE_ID: 'i1' });
    const second = await writePageLaunchValues(dir, '/app/', { OGW_INSTANCE_ID: 'i2' });
    const path = new URLSearchParams(first).get('ogw_launch_values') ?? '';
    expect(path).toMatch(/^\/app\/ogw-launch-values-[0-9a-z]+\.json$/);
    expect(new URLSearchParams(second).get('ogw_launch_values')).not.toBe(path);
    expect(readdirSync(dir)).toHaveLength(2);
    const file = join(dir, path.slice('/app/'.length));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ OGW_INSTANCE_ID: 'i1' });
    // launch values may hold secrets (\`OGW_DEV_ACCESS\`): only the owner reads the file
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('tells why a value is not a launch value file: a JSON object whose values are JSON strings', () => {
    expect(launchValueFileError({ OGW_INSTANCE_ID: 'i1', OGW_RANDOM_BASE: '' })).toBeNull();
    expect(launchValueFileError({})).toBeNull();
    expect(launchValueFileError({ OGW_RANDOM_BASE: 42 })).toBe('the value of OGW_RANDOM_BASE is not a string');
    expect(launchValueFileError({ OGW_INSTANCE_ID: null })).toBe('the value of OGW_INSTANCE_ID is not a string');
    expect(launchValueFileError(['OGW_INSTANCE_ID'])).toBe('not a JSON object');
    expect(launchValueFileError('i1')).toBe('not a JSON object');
    expect(launchValueFileError(null)).toBe('not a JSON object');
  });
});

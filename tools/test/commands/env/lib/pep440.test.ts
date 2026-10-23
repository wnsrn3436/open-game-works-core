import { describe, expect, it } from 'vitest';
import {
  compareHost,
  compareVersions,
  evaluateMarker,
  highestMatching,
  isPrerelease,
  markerHolds,
  markerHostOf,
  parseRequirement,
  parseVersion,
  satisfies,
} from '../../../../src/commands/env/lib/pep440.ts';

function v(text: string) {
  const parsed = parseVersion(text);
  if (!parsed) throw new Error(`bad version ${text}`);
  return parsed;
}

describe('parseVersion', () => {
  it('reads epoch, release, pre, post and dev', () => {
    expect(parseVersion('1!2.3.4rc5.post6.dev7')).toEqual({ epoch: 1, release: [2, 3, 4], pre: [2, 5], post: 6, dev: 7 });
    expect(parseVersion('v1.0')).toEqual({ epoch: 0, release: [1, 0], pre: null, post: null, dev: null });
    expect(parseVersion('1.0a')).toMatchObject({ pre: [0, 0] });
    expect(parseVersion('1.0b2')).toMatchObject({ pre: [1, 2] });
    expect(parseVersion('1.0-3')).toMatchObject({ post: 3 });
    expect(parseVersion('1.0.post')).toMatchObject({ post: 0 });
    expect(parseVersion('1.0.dev')).toMatchObject({ dev: 0 });
    expect(parseVersion('1.0+local.1')).toMatchObject({ release: [1, 0] });
    expect(parseVersion('not-a-version')).toBeNull();
  });

  it('orders versions as PEP 440 does', () => {
    const ordered = ['1.0.dev1', '1.0a1', '1.0b1', '1.0rc1', '1.0', '1.0.post1', '1.1', '2!0.1'];
    for (let i = 1; i < ordered.length; i++) {
      expect(compareVersions(v(ordered[i - 1] as string), v(ordered[i] as string))).toBe(-1);
      expect(compareVersions(v(ordered[i] as string), v(ordered[i - 1] as string))).toBe(1);
    }
    expect(compareVersions(v('1.0'), v('1.0.0'))).toBe(0);
    expect(compareVersions(v('1.0rc1.dev1'), v('1.0rc1'))).toBe(-1);
  });

  it('knows pre-releases', () => {
    expect(isPrerelease(v('1.0rc1'))).toBe(true);
    expect(isPrerelease(v('1.0.dev1'))).toBe(true);
    expect(isPrerelease(v('1.0.post1'))).toBe(false);
  });
});

describe('satisfies', () => {
  it('handles each operator', () => {
    expect(satisfies(v('1.5'), '>=1.2')).toBe(true);
    expect(satisfies(v('1.1'), '>=1.2')).toBe(false);
    expect(satisfies(v('1.2'), '<=1.2')).toBe(true);
    expect(satisfies(v('1.3'), '<=1.2')).toBe(false);
    expect(satisfies(v('1.1'), '<1.2')).toBe(true);
    expect(satisfies(v('1.2'), '<1.2')).toBe(false);
    expect(satisfies(v('1.3'), '>1.2')).toBe(true);
    expect(satisfies(v('1.2'), '>1.2')).toBe(false);
    expect(satisfies(v('1.2'), '==1.2')).toBe(true);
    expect(satisfies(v('1.2'), '===1.2')).toBe(true);
    expect(satisfies(v('1.3'), '==1.2')).toBe(false);
    expect(satisfies(v('1.3'), '!=1.2')).toBe(true);
    expect(satisfies(v('1.2'), '!=1.2')).toBe(false);
    expect(satisfies(v('1.2.9'), '==1.2.*')).toBe(true);
    expect(satisfies(v('1.3'), '==1.2.*')).toBe(false);
    expect(satisfies(v('1.3'), '!=1.2.*')).toBe(true);
    expect(satisfies(v('1.2.1'), '!=1.2.*')).toBe(false);
    expect(satisfies(v('2.4'), '~=2.2')).toBe(true);
    expect(satisfies(v('3.0'), '~=2.2')).toBe(false);
    expect(satisfies(v('2.1'), '~=2.2')).toBe(false);
    expect(satisfies(v('1.4.9'), '~=1.4.5')).toBe(true);
    expect(satisfies(v('1.5.0'), '~=1.4.5')).toBe(false);
    expect(satisfies(v('1.0'), 'nonsense')).toBe(false);
    expect(satisfies(v('1.0'), '>=x.y')).toBe(false);
  });
});

describe('requirements', () => {
  it('parses names, extras, specifiers, markers and URLs', () => {
    expect(parseRequirement('torch>=2.0,<3 ; sys_platform == "darwin"')).toEqual({
      name: 'torch',
      extras: '',
      specifiers: ['>=2.0', '<3'],
      marker: 'sys_platform == "darwin"',
      url: null,
    });
    expect(parseRequirement('rembg[cpu, cli] (==2.0.85)')).toEqual({ name: 'rembg', extras: '[cpu,cli]', specifiers: ['==2.0.85'], marker: null, url: null });
    expect(parseRequirement('numpy')).toEqual({ name: 'numpy', extras: '', specifiers: [], marker: null, url: null });
    expect(parseRequirement('pkg @ git+https://x/y.git@abc')).toMatchObject({ name: 'pkg', url: 'git+https://x/y.git@abc' });
    expect(parseRequirement('!!')).toBeNull();
  });

  it('picks the highest version that satisfies every specifier, without pre-releases unless named', () => {
    const versions = ['1.0', '1.5', '2.0rc1', '1.9.post1', 'junk'];
    expect(highestMatching(versions, ['<2'])).toBe('1.9.post1');
    expect(highestMatching(versions, [])).toBe('1.9.post1');
    expect(highestMatching(versions, ['>=2.0rc1'])).toBe('2.0rc1');
    expect(highestMatching(versions, ['>3'])).toBeNull();
  });

  it('evaluates platform markers for the host', () => {
    const mac = markerHostOf('darwin', 'arm64');
    expect(mac).toEqual({ sys_platform: 'darwin', platform_system: 'Darwin', os_name: 'posix', platform_machine: 'arm64' });
    expect(markerHostOf('win32', 'x64')).toEqual({ sys_platform: 'win32', platform_system: 'Windows', os_name: 'nt', platform_machine: 'AMD64' });
    expect(markerHostOf('linux', 'arm64').platform_machine).toBe('aarch64');
    expect(markerHostOf('linux', 'x64').platform_machine).toBe('x86_64');
    expect(markerHostOf('aix', 'ppc').platform_system).toBe('aix');
    expect(markerHolds(null, mac)).toBe(true);
    expect(markerHolds('sys_platform == "win32"', mac)).toBe(false);
    expect(markerHolds("sys_platform != 'win32'", mac)).toBe(true);
    expect(markerHolds('platform_system == "Linux" or platform_system == "Darwin"', mac)).toBe(true);
    expect(markerHolds('os_name == "posix" and platform_machine == "x86_64"', mac)).toBe(false);
    expect(markerHolds('python_version < "3.10"', mac)).toBe(true);
  });

  it('respects parentheses and evaluates and before or', () => {
    const mac = markerHostOf('darwin', 'arm64');
    expect(markerHolds("sys_platform == 'win32' and (platform_machine == 'AMD64' or os_name == 'posix')", mac)).toBe(false);
    expect(markerHolds("sys_platform == 'darwin' and (platform_machine == 'AMD64' or os_name == 'posix')", mac)).toBe(true);
    expect(markerHolds("sys_platform == 'darwin' and (platform_machine == 'AMD64' or os_name == 'nt')", mac)).toBe(false);
    expect(markerHolds("sys_platform == 'win32' and platform_machine == 'AMD64' or os_name == 'posix'", mac)).toBe(true);
    expect(markerHolds("os_name == 'posix' or sys_platform == 'win32' and platform_machine == 'AMD64'", mac)).toBe(true);
    expect(markerHolds("os_name == 'nt' or sys_platform == 'win32' and os_name == 'posix'", mac)).toBe(false);
    expect(markerHolds("((sys_platform == 'darwin'))", mac)).toBe(true);
    expect(markerHolds("'darwin' == sys_platform and 'win32' != sys_platform", mac)).toBe(true);
    expect(markerHolds("'darwin' != sys_platform", mac)).toBe(false);
    expect(markerHolds("platform_machine > 'a' and 'linux' in sys_platform", mac)).toBe(true);
    expect(markerHolds("platform.machine == 'x'", mac)).toBe(true);
  });

  it('gives each comparison to the compare function, the value on the right', () => {
    const seen: string[] = [];
    const compare = (variable: string, op: string, value: string): boolean => {
      seen.push(`${variable} ${op} ${value}`);
      return variable === 'yes';
    };
    expect(evaluateMarker(`"3.8" < python_version and '3' >= a or b not  in "x" or c in 'y' and d === "z" or e ~= '1'`, compare)).toBe(false);
    expect(seen).toEqual(['python_version > 3.8', 'a <= 3', 'b not in x', 'c in y', 'd === z', 'e ~= 1']);
    seen.length = 0;
    expect(evaluateMarker(`'1' > f or '2' <= g or '3' == h or '4' != i or '5' ~= j or '6' in k`, compare)).toBe(false);
    expect(seen).toEqual(['f < 1', 'g >= 2', 'h == 3', 'i != 4', 'j ~= 5', 'k in 6']);
    expect(evaluateMarker('yes == "1" or no == "2"', compare)).toBe(true);
    expect(evaluateMarker('no == "1" or yes == "2"', compare)).toBe(true);
    expect(evaluateMarker('yes == "1" and no == "2"', compare)).toBe(false);
    expect(evaluateMarker('no == "1" and yes == "2"', compare)).toBe(false);
    expect(evaluateMarker('android == "1"', compare)).toBe(false);
    expect(evaluateMarker('  yes == "1"  ', compare)).toBe(true);
    for (const bad of ['', 'yes', 'yes ==', '(yes == "1"', 'yes == "1")', 'yes == "1" and', '"1" == "2"', 'a == b', 'yes "1" "2"', 'yes == "1" yes == "1"', 'yes == "1" or (', 'yes == "1" & x', 'yes == "1', '(yes == "1" yes']) {
      expect(() => evaluateMarker(bad, compare), bad).toThrow(`cannot read marker: ${bad}`);
    }
  });

  it('compares the host variables with == and != only', () => {
    const mac = markerHostOf('darwin', 'arm64');
    expect(compareHost(mac, 'os_name', '==', 'posix')).toBe(true);
    expect(compareHost(mac, 'os_name', '!=', 'posix')).toBe(false);
    expect(compareHost(mac, 'platform_system', '==', 'Linux')).toBe(false);
    expect(compareHost(mac, 'platform_machine', '!=', 'x86_64')).toBe(true);
    expect(compareHost(mac, 'os_name', '===', 'nt')).toBe(true);
    expect(compareHost(mac, 'implementation_name', '==', 'pypy')).toBe(true);
    expect(compareHost(mac, 'sys_platform', 'in', 'linux')).toBe(true);
  });
});

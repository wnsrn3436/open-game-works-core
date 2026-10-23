import { afterEach, describe, expect, it } from 'vitest';
import { setNet } from '../../../../src/commands/env/lib/net.ts';
import { markerHostOf } from '../../../../src/commands/env/lib/pep440.ts';
import { ffmpegPin, FFMPEG_SOURCE, gdtoolkitPin } from '../../../../src/commands/env/lib/proposals.ts';
import {
  fitsPlatform,
  isPureWheel,
  markerFits,
  normalizeName,
  pickWheel,
  pinEntries,
  Pypi,
  FIRST_PYTHON_MINOR,
  resolveWheels,
  WHEEL_PLATFORMS,
  wheelTags,
  type PypiFile,
  type ResolvedWheel,
} from '../../../../src/commands/env/lib/wheels.ts';
import { fakeNet } from '../fakes.ts';

function file(filename: string, yanked = false): PypiFile {
  return { filename, url: `https://files/${filename}`, digests: { sha256: filename.length.toString(16).padStart(64, '0') }, yanked };
}

afterEach(() => {
  setNet(null);
});

describe('wheel tags', () => {
  it('reads wheel file names', () => {
    expect(wheelTags('a-1.0-py2.py3-none-any.whl')).toEqual({ python: ['py2', 'py3'], abi: ['none'], platform: ['any'] });
    expect(wheelTags('a-1.0-1-cp312-cp312-win_amd64.whl')).toEqual({ python: ['cp312'], abi: ['cp312'], platform: ['win_amd64'] });
    expect(wheelTags('a-1.0.tar.gz')).toBeNull();
    expect(wheelTags('a-1.0-none-any.whl')).toBeNull();
    expect(wheelTags('a-b-1.0-1-2-cp3-none-any.whl')).toBeNull();
  });

  it('matches pure wheels and platform wheels for a CPython minor version', () => {
    const tags = (name: string) => wheelTags(name) ?? { python: [], abi: [], platform: [] };
    expect(isPureWheel(tags('a-1-py3-none-any.whl'))).toBe(true);
    expect(isPureWheel(tags('a-1-py2-none-any.whl'))).toBe(false);
    expect(isPureWheel(tags('a-1-py3-none-win_amd64.whl'))).toBe(false);
    expect(isPureWheel(tags('a-1-cp312-abi3-any.whl'))).toBe(false);
    expect(isPureWheel(tags('a-1-py312-none-any.whl'))).toBe(true);
    expect(fitsPlatform(tags('a-1-cp312-cp312-macosx_11_0_arm64.whl'), 'macos-arm64', 12)).toBe(true);
    expect(fitsPlatform(tags('a-1-cp312-cp312-macosx_10_9_universal2.whl'), 'macos-arm64', 12)).toBe(true);
    expect(fitsPlatform(tags('a-1-cp312-cp312-macosx_10_9_x86_64.whl'), 'macos-arm64', 12)).toBe(false);
    expect(fitsPlatform(tags('a-1-cp312-cp312-macosx_11_0_arm64.whl'), 'macos-arm64', 13)).toBe(false);
    expect(fitsPlatform(tags('a-1-cp312-cp312-manylinux2014_x86_64.manylinux_2_17_x86_64.whl'), 'linux-x64', 12)).toBe(true);
    expect(fitsPlatform(tags('a-1-cp312-cp312-manylinux1_x86_64.whl'), 'linux-x64', 12)).toBe(true);
    expect(fitsPlatform(tags('a-1-cp312-cp312-manylinux2010_x86_64.whl'), 'linux-x64', 12)).toBe(true);
    expect(fitsPlatform(tags('a-1-cp312-cp312-musllinux_1_1_x86_64.whl'), 'linux-x64', 12)).toBe(false);
    expect(fitsPlatform(tags('a-1-cp312-cp312-manylinux_2_17_aarch64.whl'), 'linux-x64', 12)).toBe(false);
    expect(fitsPlatform(tags('a-1-cp312-cp312-win_amd64.whl'), 'windows-x64', 12)).toBe(true);
    expect(fitsPlatform(tags('a-1-cp312-cp312-win32.whl'), 'windows-x64', 12)).toBe(false);
    expect(fitsPlatform(tags('a-1-cp38-abi3-win_amd64.whl'), 'windows-x64', 12)).toBe(true);
    expect(fitsPlatform(tags('a-1-cp313-abi3-win_amd64.whl'), 'windows-x64', 12)).toBe(false);
    expect(fitsPlatform(tags('a-1-py3-none-win_amd64.whl'), 'windows-x64', 12)).toBe(true);
    expect(fitsPlatform(tags('a-1-cp312-none-win_amd64.whl'), 'windows-x64', 12)).toBe(true);
    expect(fitsPlatform(tags('a-1-cp311-none-win_amd64.whl'), 'windows-x64', 12)).toBe(false);
    expect(fitsPlatform(tags('a-1-cp311-cp311-win_amd64.whl'), 'windows-x64', 12)).toBe(false);
  });

  it('picks a pure wheel first, then a platform wheel, never a yanked one', () => {
    const files = [file('a-1-cp312-cp312-win_amd64.whl'), file('a-1-py3-none-any.whl')];
    expect(pickWheel(files, 'windows-x64', 12)).toEqual({ file: files[1], pure: true });
    expect(pickWheel([files[0] as PypiFile], 'windows-x64', 12)).toEqual({ file: files[0], pure: false });
    expect(pickWheel([files[0] as PypiFile], 'linux-x64', 12)).toBeNull();
    expect(pickWheel([file('a-1-py3-none-any.whl', true), file('a-1.tar.gz')], 'linux-x64', 12)).toBeNull();
  });

  it('skips a wheel whose requires_python does not allow the CPython minor version', () => {
    const pure = { ...file('a-2-py3-none-any.whl'), requires_python: '>=3.11, <4' };
    expect(pickWheel([pure], 'linux-x64', 10)).toBeNull();
    expect(pickWheel([pure], 'linux-x64', 11)).toEqual({ file: pure, pure: true });
    expect(pickWheel([{ ...pure, requires_python: null }], 'linux-x64', 9)).toEqual({ file: { ...pure, requires_python: null }, pure: true });
  });
});

describe('markers', () => {
  const mac = markerHostOf('darwin', 'arm64');
  const win = markerHostOf('win32', 'x64');
  it('evaluates extras, Python versions and platforms', () => {
    expect(markerFits(null, mac, 12, new Set())).toBe(true);
    expect(markerFits("extra == 'regex'", mac, 12, new Set(['regex']))).toBe(true);
    expect(markerFits('extra == "Re_Gex"', mac, 12, new Set(['re-gex']))).toBe(true);
    expect(markerFits("extra == 'regex'", mac, 12, new Set())).toBe(false);
    expect(markerFits("extra != 'regex'", mac, 12, new Set())).toBe(true);
    expect(markerFits("extra != 'regex'", mac, 12, new Set(['regex']))).toBe(false);
    expect(markerFits("python_version < '3.5'", mac, 12, new Set())).toBe(false);
    expect(markerFits("python_version >= '3.12'", mac, 12, new Set())).toBe(true);
    expect(markerFits("python_full_version <= '3.11'", mac, 12, new Set())).toBe(false);
    expect(markerFits("sys_platform == 'win32'", win, 12, new Set())).toBe(true);
    expect(markerFits("sys_platform == 'win32'", mac, 12, new Set())).toBe(false);
    expect(markerFits("sys_platform != 'win32'", mac, 12, new Set())).toBe(true);
    expect(markerFits("platform_machine > 'x'", mac, 12, new Set())).toBe(true);
    expect(markerFits("implementation_name == 'pypy'", mac, 12, new Set())).toBe(true);
    expect(markerFits("sys_platform == 'win32' or extra == 'x'", mac, 12, new Set(['x']))).toBe(true);
    expect(markerFits("(sys_platform == 'darwin') and python_version < '3.10'", mac, 12, new Set())).toBe(false);
    expect(() => markerFits('weird marker', mac, 12, new Set())).toThrow('cannot read marker: weird marker');
    expect(markerFits("extra == 'dev' and (sys_platform == 'linux' or sys_platform == 'darwin')", mac, 12, new Set())).toBe(false);
    expect(markerFits("extra == 'dev' and (sys_platform == 'linux' or sys_platform == 'darwin')", mac, 12, new Set(['dev']))).toBe(true);
    expect(markerFits("'3.10' <= python_version", mac, 12, new Set())).toBe(true);
    expect(markerFits("'3.13' <= python_version", mac, 12, new Set())).toBe(false);
    expect(markerFits("python_version ~= '3.11'", mac, 12, new Set())).toBe(true);
    expect(markerFits("python_version in '3.13 3.14'", mac, 12, new Set())).toBe(true);
    expect(markerFits("python_version not in '3.12'", mac, 12, new Set())).toBe(true);
  });

  it('normalizes names', () => {
    expect(normalizeName('Docopt_NG.x')).toBe('docopt-ng-x');
  });
});

describe('resolving wheels', () => {
  const routes = {
    'https://pypi.org/pypi/root/json': { releases: { '1.0': [file('root-1.0-py3-none-any.whl')] } },
    'https://pypi.org/pypi/root/1.0/json': { info: { requires_dist: ['dep[x]>=1', 'Dep>=1', 'other'] }, urls: [] },
    'https://pypi.org/pypi/dep/json': { releases: { '1.0': [file('dep-1.0-py3-none-any.whl')], '2.0': [file('dep-2.0.tar.gz')] } },
    'https://pypi.org/pypi/dep/1.0/json': { info: { requires_dist: ["xtra; extra == 'x'"] }, urls: [] },
    'https://pypi.org/pypi/xtra/json': { releases: { '3.0': [file('xtra-3.0-cp314-cp314-win_amd64.whl'), file('xtra-3.0-cp314-cp314-macosx_11_0_arm64.whl'), file('xtra-3.0-cp314-cp314-manylinux_2_17_x86_64.whl')] } },
    'https://pypi.org/pypi/xtra/3.0/json': { info: { requires_dist: null }, urls: [] },
    'https://pypi.org/pypi/other/json': { releases: { '1.0': [file('other-1.0-py3-none-any.whl')] } },
    'https://pypi.org/pypi/other/1.0/json': { info: { requires_dist: ['dep<1'] }, urls: [] },
  };

  it('follows dependencies with their extras and checks repeated requirements', async () => {
    setNet(fakeNet({ ...routes, 'https://pypi.org/pypi/other/1.0/json': { info: { requires_dist: ['dep>=0.5'] }, urls: [] } }));
    const wheels = await resolveWheels(new Pypi(), { name: 'root', version: '1.0' }, 'windows-x64', 14);
    expect(wheels.map((w) => [w.name, w.version, w.file.filename, w.pure])).toEqual([
      ['root', '1.0', 'root-1.0-py3-none-any.whl', true],
      ['dep', '1.0', 'dep-1.0-py3-none-any.whl', true],
      ['other', '1.0', 'other-1.0-py3-none-any.whl', true],
      ['xtra', '3.0', 'xtra-3.0-cp314-cp314-win_amd64.whl', false],
    ]);
  });

  it('fails on a conflict, a missing wheel or an unreadable requirement', async () => {
    setNet(fakeNet(routes));
    await expect(resolveWheels(new Pypi(), { name: 'root', version: '1.0' }, 'windows-x64', 14)).rejects.toThrow('dep 1.0 does not satisfy dep<1 of other');
    await expect(resolveWheels(new Pypi(), { name: 'root', version: '1.0' }, 'windows-x64', 13)).rejects.toThrow('no wheel of xtra  for windows-x64 CPython 3.13');
    await expect(resolveWheels(new Pypi(), { name: 'root', version: '2.0' }, 'windows-x64', 14)).rejects.toThrow('no wheel of root 2.0 for windows-x64 CPython 3.14');
    setNet(fakeNet({ ...routes, 'https://pypi.org/pypi/root/1.0/json': { info: { requires_dist: ['!bad'] }, urls: [] } }));
    await expect(resolveWheels(new Pypi(), { name: 'root', version: '1.0' }, 'windows-x64', 14)).rejects.toThrow('cannot read dependency of root: !bad');
  });

  it('chooses the highest dependency version whose wheel allows the CPython minor version', async () => {
    const newer = { ...file('dep-1.5-py3-none-any.whl'), requires_python: '>=3.13' };
    setNet(
      fakeNet({
        ...routes,
        'https://pypi.org/pypi/root/1.0/json': { info: { requires_dist: ['dep>=1'] }, urls: [] },
        'https://pypi.org/pypi/dep/json': { releases: { '1.0': [file('dep-1.0-py3-none-any.whl')], '1.5': [newer] } },
        'https://pypi.org/pypi/dep/1.5/json': { info: { requires_dist: null }, urls: [] },
      }),
    );
    const versions = async (minor: number): Promise<string[]> => (await resolveWheels(new Pypi(), { name: 'root', version: '1.0' }, 'linux-x64', minor)).map((w) => w.version);
    expect(await versions(13)).toEqual(['1.0', '1.5']);
    expect(await versions(12)).toEqual(['1.0', '1.0']);
  });

  it('reads each PyPI URL once', async () => {
    const net = fakeNet(routes);
    setNet(net);
    const pypi = new Pypi();
    await pypi.project('dep');
    await pypi.project('dep');
    expect(net.calls.filter((c) => c === 'GET https://pypi.org/pypi/dep/json')).toHaveLength(1);
  });

  it('merges per-platform wheels into downloads and dependencies', () => {
    const wheel = (name: string, pure: boolean): ResolvedWheel => ({ name, version: '1', file: file(name), pure });
    const entries = pinEntries(
      new Map([
        ['macos-arm64', [wheel('root.whl', true), wheel('b.whl', true), wheel('mac.whl', false)]],
        ['linux-x64', [wheel('root.whl', true), wheel('b.whl', true), wheel('a.whl', false)]],
      ]),
    );
    expect(entries.downloads).toEqual([{ platform: 'any', url: 'https://files/root.whl', sha256: file('root.whl').digests.sha256 }]);
    expect(entries.dependencies.map((d) => `${d.platform} ${d.url}`)).toEqual(['linux-x64 https://files/a.whl', 'any https://files/b.whl', 'macos-arm64 https://files/mac.whl']);
  });

  it('tries CPython minor versions from the highest and fails when none has every wheel', async () => {
    expect(FIRST_PYTHON_MINOR).toBe(14);
    expect(WHEEL_PLATFORMS).toEqual(['macos-arm64', 'linux-x64', 'windows-x64']);
    const both = (minor: number) => [file(`c-1-cp3${String(minor)}-cp3${String(minor)}-win_amd64.whl`), file(`c-1-cp3${String(minor)}-cp3${String(minor)}-macosx_11_0_arm64.whl`), file(`c-1-cp3${String(minor)}-cp3${String(minor)}-manylinux_2_17_x86_64.whl`)];
    setNet(
      fakeNet({
        'https://pypi.org/pypi/gdtoolkit/json': { releases: { '4.0': [file('gdtoolkit-4.0-py3-none-any.whl')] } },
        'https://pypi.org/pypi/gdtoolkit/4.0/json': { info: { requires_dist: ['c'] }, urls: [] },
        'https://pypi.org/pypi/c/json': { releases: { '1': [...both(12), file('c-1-cp313-cp313-win_amd64.whl')] } },
        'https://pypi.org/pypi/c/1/json': { info: { requires_dist: [] }, urls: [] },
      }),
    );
    const pin = await gdtoolkitPin('4.0');
    expect(pin.python).toBe('3.12');
    expect(pin.dependencies.map((d) => d.platform).sort()).toEqual(['linux-x64', 'macos-arm64', 'windows-x64']);
    await expect(gdtoolkitPin('5.0')).rejects.toThrow('no CPython 3.x has wheels of gdtoolkit 5.0 and its dependencies on every platform: no wheel of gdtoolkit 5.0 for macos-arm64 CPython 3.14');
    await expect(gdtoolkitPin('5.0', new Pypi())).rejects.toThrow(/CPython 3\.14$/);
  });

  it('tries the CPython minor versions the wheels name, above the first one too', async () => {
    const all = (name: string, minor: number) => [file(`${name}-1-cp3${String(minor)}-cp3${String(minor)}-win_amd64.whl`), file(`${name}-1-cp3${String(minor)}-cp3${String(minor)}-macosx_11_0_arm64.whl`), file(`${name}-1-cp3${String(minor)}-cp3${String(minor)}-manylinux_2_17_x86_64.whl`)];
    const routes = (cReleases: PypiFile[], dReleases: PypiFile[]) => ({
      'https://pypi.org/pypi/gdtoolkit/json': { releases: { '4.0': [file('gdtoolkit-4.0-py3-none-any.whl')] } },
      'https://pypi.org/pypi/gdtoolkit/4.0/json': { info: { requires_dist: ['c', 'd'] }, urls: [] },
      'https://pypi.org/pypi/c/json': { releases: { '1': cReleases } },
      'https://pypi.org/pypi/c/1/json': { info: { requires_dist: [] }, urls: [] },
      'https://pypi.org/pypi/d/json': { releases: { '1': dReleases } },
      'https://pypi.org/pypi/d/1/json': { info: { requires_dist: [] }, urls: [] },
    });
    setNet(fakeNet(routes([...all('c', 14), ...all('c', 15)], [file('d-1-py3-none-any.whl'), file('d-1-cp316-abi3-win_amd64.whl')])));
    const pypi = new Pypi();
    expect((await gdtoolkitPin('4.0', pypi)).python).toBe('3.15');
    expect([...pypi.cpythonMinors()].sort()).toEqual([14, 15, 16]);
    setNet(fakeNet(routes([...all('c', 14), ...all('c', 15)], [...all('d', 13), ...all('d', 14)])));
    expect((await gdtoolkitPin('4.0')).python).toBe('3.14');
    setNet(fakeNet(routes([...all('c', 12), ...all('c', 15)], [...all('d', 13), ...all('d', 12)])));
    const pin = await gdtoolkitPin('4.0');
    expect(pin.python).toBe('3.12');
    expect(pin.dependencies.map((d) => d.url.replace('https://files/', '')).sort()).toEqual([
      'c-1-cp312-cp312-macosx_11_0_arm64.whl',
      'c-1-cp312-cp312-manylinux_2_17_x86_64.whl',
      'c-1-cp312-cp312-win_amd64.whl',
      'd-1-cp312-cp312-macosx_11_0_arm64.whl',
      'd-1-cp312-cp312-manylinux_2_17_x86_64.whl',
      'd-1-cp312-cp312-win_amd64.whl',
    ]);
    setNet(fakeNet(routes([file('c-1-py3-none-any.whl')], [file('d-1-py3-none-any.whl')])));
    expect((await gdtoolkitPin('4.0')).python).toBe('3.14');
    setNet(fakeNet(routes([file('c-1-cp312-cp312-win_amd64.whl'), file('c-1-cp313-cp313-win_amd64.whl'), file('c-1.tar.gz')], [file('d-1-py3-none-any.whl')])));
    await expect(gdtoolkitPin('4.0')).rejects.toThrow(
      'no CPython 3.x has wheels of gdtoolkit 4.0 and its dependencies on every platform: no wheel of c  for macos-arm64 CPython 3.14; no wheel of c  for macos-arm64 CPython 3.13; no wheel of c  for macos-arm64 CPython 3.12',
    );
  });

  it('reads the CPython minor versions of the python and abi tags of every project read', async () => {
    setNet(fakeNet({ 'https://pypi.org/pypi/e/json': { releases: { '1': [file('e-1-py3-cp313-win_amd64.whl'), file('e-1-cp310-abi3-win_amd64.whl'), file('e-1-cp39-cp39t-win_amd64.whl'), file('e-1.tar.gz')], '2': [] } } }));
    const pypi = new Pypi();
    expect(pypi.cpythonMinors()).toEqual(new Set());
    await pypi.project('e');
    expect([...pypi.cpythonMinors()].sort((a, b) => a - b)).toEqual([9, 10, 13]);
  });
});

describe('ffmpeg pin', () => {
  it('reads the fixed release and fails without an asset digest', async () => {
    expect(FFMPEG_SOURCE).toEqual({ repository: 'eugeneware/ffmpeg-static', tag: 'b6.1.1', assets: { 'macos-arm64': 'ffmpeg-darwin-arm64', 'linux-x64': 'ffmpeg-linux-x64', 'windows-x64': 'ffmpeg-win32-x64' } });
    const url = 'https://api.github.com/repos/eugeneware/ffmpeg-static/releases/tags/b6.1.1';
    const asset = (name: string, digest: string | null) => ({ name, browser_download_url: `https://gh/${name}`, digest });
    setNet(fakeNet({ [url]: { assets: [asset('ffmpeg-darwin-arm64', `sha256:${'a'.repeat(64)}`), asset('ffmpeg-linux-x64', null), asset('ffmpeg-win32-x64', `sha256:${'c'.repeat(64)}`)] } }));
    await expect(ffmpegPin()).rejects.toThrow('release eugeneware/ffmpeg-static b6.1.1 has no asset ffmpeg-linux-x64 with a sha256 digest');
    setNet(fakeNet({ [url]: {} }));
    await expect(ffmpegPin()).rejects.toThrow('has no asset ffmpeg-darwin-arm64 with a sha256 digest');
  });
});

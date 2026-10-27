import { describe, expect, it } from 'vitest';
import { macosRefreshHz, windowsRefreshHz, xrandrRefreshHz } from '../../src/lib/display.ts';

describe('display refresh rate', () => {
  it('reads the main display of system_profiler', () => {
    const json = JSON.stringify({
      SPDisplaysDataType: [
        { _name: 'GPU', spdisplays_ndrvs: [{ _name: 'Side', _spdisplays_resolution: '1920 x 1080 @ 60.00Hz' }, { _name: 'Color LCD', _spdisplays_resolution: '1728 x 1117 @ 120.00Hz', spdisplays_main: 'spdisplays_yes' }] },
      ],
    });
    expect(macosRefreshHz(json)).toBe(120);
    expect(macosRefreshHz(JSON.stringify({ SPDisplaysDataType: [{ spdisplays_ndrvs: [{ _spdisplays_resolution: '2560 x 1440 @ 59.94Hz' }] }] }))).toBe(59.94);
    expect(macosRefreshHz(JSON.stringify({ SPDisplaysDataType: [{ _name: 'GPU' }] }))).toBeNull();
    expect(macosRefreshHz('not json')).toBeNull();
  });

  it('reads the current mode of the primary output of xrandr', () => {
    const text = [
      'Screen 0: minimum 320 x 200, current 3840 x 1080, maximum 16384 x 16384',
      'HDMI-1 connected 1920x1080+1920+0 (normal left inverted right x axis y axis) 527mm x 296mm',
      '   1920x1080     60.00*+  50.00    59.94',
      'DP-1 connected primary 1920x1080+0+0 (normal left inverted right x axis y axis) 527mm x 296mm',
      '   1920x1080    144.00*+ 120.00    60.00',
      'DP-2 disconnected (normal left inverted right x axis y axis)',
    ].join('\n');
    expect(xrandrRefreshHz(text)).toBe(144);
    expect(xrandrRefreshHz(text.replace(' primary', ''))).toBe(60);
    expect(xrandrRefreshHz('Screen 0: minimum 320 x 200\n')).toBeNull();
  });

  it('reads CurrentRefreshRate of Windows', () => {
    expect(windowsRefreshHz('165\r\n')).toBe(165);
    expect(windowsRefreshHz('\r\n')).toBeNull();
  });
});

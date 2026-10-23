import { describe, expect, it } from 'vitest';
import { section } from '../../src/lib/markdown.ts';

describe('section', () => {
  const text = '# T\r\n## A \r\nx\r\n```\r\n## in fence\r\n# in fence\r\n```\r\n### B\r\ny\r\n## C\r\nz\r\n# top\r\nw';

  it('reads the lines up to the next heading of the same or a higher level outside code fences', () => {
    expect(section(text, 'A')).toEqual(['x', '```', '## in fence', '# in fence', '```', '### B', 'y']);
    expect(section(text, 'C')).toEqual(['z']);
    expect(section(text, 'B', 3)).toEqual(['y']);
    expect(section(text, 'T', 1)).toEqual(['## A ', 'x', '```', '## in fence', '# in fence', '```', '### B', 'y', '## C', 'z']);
  });

  it('is null when the heading is missing', () => {
    expect(section(text, 'B')).toBeNull();
    expect(section('# T', 'A')).toBeNull();
  });
});

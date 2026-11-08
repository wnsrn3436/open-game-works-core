import { describe, expect, it } from 'vitest';
import * as testSkip from '../../../../src/commands/check/static/test-skip.ts';
import { lines, memContext } from './helpers.ts';

describe('test skip', () => {
  it('finds pending(), skip_script and should_skip_script() in client tests only', async () => {
    const test = [
      'extends UnitTestCase',
      '',
      'var skip_script: String = "later"',
      '',
      'func should_skip_script() -> Variant:',
      '\treturn "later"',
      '',
      'func test_a() -> void:',
      '\tpending("not done")',
      '\tself.pending()',
      '\tskip_script = "x"',
      '\tself.skip_script = "y"',
      '\tother.pending()',
      '\tassert_eq(1, 1)',
    ].join('\n');
    const sc = memContext({ 'client/tests/shop/test_shop.gd': test, 'client/features/shop/shop.gd': 'extends Node\n\nfunc pending() -> void:\n\tpending()\n' });
    expect(lines(await testSkip.run(sc))).toEqual([
      'client/tests/shop/test_shop.gd:3 | test skip: `skip_script` skips a test; a regression test runs every test',
      'client/tests/shop/test_shop.gd:5 | test skip: `should_skip_script()` skips a test; a regression test runs every test',
      'client/tests/shop/test_shop.gd:9 | test skip: `pending()` skips a test; a regression test runs every test',
      'client/tests/shop/test_shop.gd:10 | test skip: `pending()` skips a test; a regression test runs every test',
      'client/tests/shop/test_shop.gd:11 | test skip: `skip_script` skips a test; a regression test runs every test',
      'client/tests/shop/test_shop.gd:12 | test skip: `skip_script` skips a test; a regression test runs every test',
    ]);
  });

  it('finds skipped and focused vitest tests and context skips in server tests only', async () => {
    const test = [
      "describe.skip('a', () => {});",
      "describe.concurrent.only('b', () => {});",
      "it.todo('c');",
      "test.skipIf(process.env.CI)('d', () => {});",
      "it.runIf(false)('e', () => {});",
      "suite.only('f', () => {});",
      "it('g', (ctx) => { if (ctx.task) ctx.skip(); });",
      "test('h', ({ skip }) => { skip(); });",
      "test('i', ({ skip: later }) => { later(); });",
      "it.each([1])('j', (n) => { expect(n).toBe(1); });",
      "it('k', async () => { await helper.skip(); });",
      "it('l', (ctx) => { other.skip(); });",
    ].join('\n');
    const own = "const test = { skip: () => 1 };\ntest.skip();\n";
    const sc = memContext({ 'server/tests/shop.test.ts': test, 'server/tests/own.test.ts': own, 'server/handlers/Buy.ts': "describe.skip('x', () => {});\n" });
    expect(lines(await testSkip.run(sc))).toEqual([
      "server/tests/shop.test.ts:1 | test skip: `describe.skip` skips a test; a regression test runs every test",
      "server/tests/shop.test.ts:2 | test skip: `describe.concurrent.only` focuses a test, which skips the others; a regression test runs every test",
      "server/tests/shop.test.ts:3 | test skip: `it.todo` skips a test; a regression test runs every test",
      "server/tests/shop.test.ts:4 | test skip: `test.skipIf` skips a test; a regression test runs every test",
      "server/tests/shop.test.ts:5 | test skip: `it.runIf` skips a test; a regression test runs every test",
      "server/tests/shop.test.ts:6 | test skip: `suite.only` focuses a test, which skips the others; a regression test runs every test",
      "server/tests/shop.test.ts:7 | test skip: `ctx.skip()` skips a test; a regression test runs every test",
      "server/tests/shop.test.ts:8 | test skip: `skip()` skips a test; a regression test runs every test",
      "server/tests/shop.test.ts:9 | test skip: `later()` skips a test; a regression test runs every test",
    ]);
  });

  it('finds them also when the file imports the test functions from vitest, which declares no name of its own', async () => {
    const test = [
      "import { describe, it, expect } from 'vitest';",
      "import * as helper from '../core/testing/dev/index.ts';",
      "describe.skip('a', () => {});",
      "it.only('b', () => { expect(helper).toBeDefined(); });",
      "it('c', (ctx) => { ctx.skip(); });",
    ].join('\n');
    expect(lines(await testSkip.run(memContext({ 'server/tests/shop.test.ts': test })))).toEqual([
      "server/tests/shop.test.ts:3 | test skip: `describe.skip` skips a test; a regression test runs every test",
      "server/tests/shop.test.ts:4 | test skip: `it.only` focuses a test, which skips the others; a regression test runs every test",
      "server/tests/shop.test.ts:5 | test skip: `ctx.skip()` skips a test; a regression test runs every test",
    ]);
    // a name imported from another module is a name of the file
    expect(await testSkip.run(memContext({ 'server/tests/own.test.ts': "import { test } from './own.ts';\ntest.skip();\n" }))).toEqual([]);
  });
});

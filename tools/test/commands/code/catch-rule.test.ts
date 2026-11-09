import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import { noSwallowedError } from '../../../src/commands/code/catch-rule.ts';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const swallowed = [{ messageId: 'swallowed' }];

tester.run('ogw/no-swallowed-error', noSwallowedError, {
  valid: [
    // one expected error checked, the rest rethrown
    "try { read(); } catch (error) { if (isNotFound(error)) return null; throw error; }",
    "read().catch((error: unknown) => { if (isNotFound(error)) return null; throw error; });",
    "read().catch((error: unknown) => (isNotFound(error) ? null : Promise.reject(error)));",
    // the failure becomes a result that carries its reason
    "try { run(); } catch (error) { return { result: 'unknown', reason: (error as Error).message }; }",
    "run().then(ok, (error: unknown) => failure(String(error)));",
    // every path throws
    "try { JSON.parse(text); } catch { throw new OgwError('invalid JSON'); }",
    "try { run(); } catch { if (a) throw new Error('a'); else throw new Error('b'); }",
    "import { fail } from '../lib/errors.ts'; try { run(); } catch { fail('stopped'); }",
    "import { fail } from '../lib/errors.ts'; run().catch(() => fail('stopped'));",
    "run().catch(() => { throw new OgwError('stopped'); });",
    // named helpers
    "read().catch(whenNotFound(null));",
    "rm(tmp).catch(ignoreCleanupError);",
    // a handler defined in the file is checked at its definition
    "function gone(error: unknown): never { throw error; } read().catch(gone);",
    "const logged = (what: string) => (error: unknown) => { log(what, error); }; run().catch(logged('x'));",
    "function stopped(what: string) { return (error: unknown) => [`${what}: ${String(error)}`]; } run().catch(stopped('x'));",
    // the reject of a promise executor passes the error on
    'new Promise((resolve, reject) => { run().then(resolve, reject); });',
    'new Promise((resolve, reject) => { run().catch(reject); });',
    // a then without a rejection handler is not a catch
    'run().then((value) => value);',
    // the helpers imported by name
    "import { whenNotFound } from './fsx.ts'; read().catch(whenNotFound(null));",
    "import { ignoreCleanupError } from '../lib/errors.ts'; rm(tmp).catch(ignoreCleanupError);",
    // fail of lib/errors.ts, and a function of the file whose body always throws, never return
    { code: "import { fail } from '../../lib/errors.ts'; try { run(); } catch { fail('stopped'); }", filename: 'src/commands/demo/run.ts' },
    { code: "import { fail } from './errors.ts'; run().catch(() => fail('stopped'));", filename: 'src/lib/run.ts' },
    "function stop(what: string): never { throw new OgwError(what); } try { run(); } catch { stop('x'); }",
    "const stop = (): never => { throw new OgwError('x'); }; run().catch(() => { stop(); });",
    "async function stop(): Promise<never> { throw new OgwError('x'); } async function f() { try { run(); } catch { await stop(); } }",
    // an overloaded handler is checked at its implementation
    'function h(e: unknown): never; function h(e: unknown): never { throw e; } read().catch(h);',
    "function g(): never; function g(): never { throw new OgwError('x'); } read().catch(g);",
    // a handler that ends only by a throw: breaks and continues that stay inside it, switch and try statements
    "try { read(); } catch { for (const x of xs) { if (x) break; } throw new Error('y'); }",
    "try { read(); } catch { for (const x of xs) { if (x) continue; log(x); } throw new Error('y'); }",
    "try { read(); } catch { outer: for (const x of xs) { for (const y of x) { if (y) continue outer; } } throw new Error('y'); }",
    "try { read(); } catch { done: { if (a) break done; log(); } throw new Error('y'); }",
    "try { read(); } catch { switch (k) { case 1: throw new Error('a'); default: throw new Error('b'); } }",
    "try { read(); } catch { switch (k) { case 1: log(); break; default: log(); } throw new Error('b'); }",
    "try { read(); } catch { try { log(); } finally { cleanup(); } throw new Error('z'); }",
    "try { read(); } catch { try { log(); } catch { throw new Error('a'); } throw new Error('z'); }",
    "try { read(); } catch { while (true) { if (a) throw new Error('a'); } }",
    // a name whose value is a handler or a factory call, and a factory that returns a handler through a name
    "import { whenNotFound } from './fsx.ts'; const h = whenNotFound(null); read().catch(h);",
    "import { ignoreCleanupError } from '../lib/errors.ts'; const h = ignoreCleanupError; rm(tmp).catch(h);",
    'function mk() { const h = (e: unknown) => { throw e; }; return h; } read().catch(mk());',
    // a return whose value is a call that always throws ends by that throw
    "function stop(): never { throw new Error('x'); } try { read(); } catch { return stop(); }",
    { code: "import { fail } from '../../lib/errors.ts'; try { read(); } catch { return fail('x'); }", filename: 'src/commands/demo/run.ts' },
    // a type, an interface or a namespace of the same name does not change the value that runs
    'const h = (e: unknown) => { throw e; }; interface h { a: number } read().catch(h);',
    "const stop = (): never => { throw new Error('x'); }; type stop = number; try { read(); } catch { stop(); }",
    "function stop(): never { throw new Error('x'); } namespace stop { export const a = 1; } try { read(); } catch { stop(); }",
    // a type or an interface of the name in an inner scope: the value that runs is that of the upper scope
    'const h = (e: unknown) => { throw e; }; function f() { type h = number; read().catch(h); }',
    "const stop = (): never => { throw new Error('x'); }; function f() { interface stop { a: number } try { read(); } catch { stop(); } }",
  ],
  invalid: [
    { code: 'try { read(); } catch { return null; }', errors: swallowed },
    { code: 'try { read(); } catch (error) { return null; }', errors: swallowed },
    { code: 'for (const f of files) { try { read(f); } catch { continue; } }', errors: swallowed },
    { code: 'try { read(); } catch {}', errors: swallowed },
    { code: "try { read(); } catch { if (a) return null; throw new Error('x'); }", errors: swallowed },
    { code: "try { read(); } catch { if (a) throw new Error('x'); }", errors: swallowed },
    { code: "read().catch(() => '');", errors: swallowed },
    { code: 'read().catch(() => undefined);', errors: swallowed },
    { code: 'read().catch(() => {});', errors: swallowed },
    { code: 'read().catch((error: unknown) => null);', errors: swallowed },
    { code: 'read().then((v) => v, () => null);', errors: swallowed },
    { code: 'function quiet() { return null; } read().catch(quiet);', errors: swallowed },
    { code: 'const quiet = () => null; read().catch(quiet);', errors: swallowed },
    { code: 'function orNull() { return () => null; } read().catch(orNull());', errors: swallowed },
    // a handler the file does not define and that is no named helper cannot be seen
    { code: "import { noop } from './x.ts'; read().catch(noop);", errors: swallowed },
    { code: "import { orNull } from './x.ts'; read().catch(orNull());", errors: swallowed },
    { code: 'read().catch(console.error);', errors: swallowed },
    { code: 'function f(reject: () => void) { read().catch(reject); }', errors: swallowed },
    // whenNotFound passes only called: bare, it makes every error the handler function
    { code: "import { whenNotFound } from './fsx.ts'; rm(p).catch(whenNotFound);", errors: swallowed },
    { code: 'rm(p).catch(whenNotFound);', errors: swallowed },
    // a helper name that the file defines is checked at its definition
    { code: 'const ignoreCleanupError = () => null; read().catch(ignoreCleanupError);', errors: swallowed },
    { code: 'function whenNotFound(v: unknown) { return () => v; } read().catch(whenNotFound(null));', errors: swallowed },
    { code: "import { noop as ignoreCleanupError } from './x.ts'; read().catch(ignoreCleanupError);", errors: swallowed },
    // a fail that can return is no throw: one the file defines, one of another module, one the file does not define
    { code: "function fail(): void { log('x'); } try { read(); } catch { fail(); }", errors: swallowed },
    { code: "const fail = (m: string) => ({ result: 'fail', m }); read().catch(() => fail('x'));", errors: swallowed },
    { code: "try { read(); } catch { fail('x'); }", errors: swallowed },
    { code: "import { fail } from './errors.ts'; try { read(); } catch { fail('x'); }", filename: 'src/commands/demo/run.ts', errors: swallowed },
    { code: "async function stop(): Promise<never> { throw new OgwError('x'); } try { read(); } catch { stop(); }", errors: swallowed },
    // a declared function has no body in the file to check
    { code: 'declare function h(e: unknown): never; read().catch(h);', errors: swallowed },
    // ends other than by a throw: a loop or switch that can complete, a break out of the handler, a finally that returns
    { code: 'try { read(); } catch { for (const x of xs) { if (x) break; } }', errors: swallowed },
    { code: "try { read(); } catch { switch (k) { case 1: throw new Error('a'); } }", errors: swallowed },
    { code: "try { read(); } catch { switch (k) { case 1: break; default: throw new Error('b'); } }", errors: swallowed },
    { code: "outer: for (const x of xs) { try { read(x); } catch { for (const y of ys) { break outer; } throw new Error('z'); } }", errors: swallowed },
    { code: "try { read(); } catch { try { throw new Error('a'); } finally { return; } }", errors: swallowed },
    { code: "try { read(); } catch { do { if (a) continue; throw new Error('a'); } while (b); }", errors: swallowed },
    // a name whose value or factory result is no handler that passes
    { code: "import { orNull } from './x.ts'; const h = orNull(); read().catch(h);", errors: swallowed },
    { code: 'function mk() { const h = () => null; return h; } read().catch(mk());', errors: swallowed },
    { code: 'let h = g; const g = h; read().catch(h);', errors: swallowed },
    { code: "import fail = require('../lib/errors.ts'); try { read(); } catch { fail(); }", errors: swallowed },
    // a name assigned again or declared again can hold another value when the handler runs
    { code: 'let h = ignoreCleanupError; if (x) h = () => null; read().catch(h);', errors: swallowed },
    { code: 'var h = (e: unknown) => { throw e; }; var h = () => null; read().catch(h);', errors: swallowed },
    { code: "let stop = (): never => { throw new Error('x'); }; stop = () => {}; try { read(); } catch { stop(); }", errors: swallowed },
    // a return of a call that can return is an end other than by a throw
    { code: 'function quiet(): null { return null; } try { read(); } catch { return quiet(); }', errors: swallowed },
    { code: 'const ignoreCleanupError = () => null; function f() { type ignoreCleanupError = number; read().catch(ignoreCleanupError); }', errors: swallowed },
  ],
});

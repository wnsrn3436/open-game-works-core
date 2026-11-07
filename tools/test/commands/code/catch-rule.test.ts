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
    "try { run(); } catch { fail('stopped'); }",
    "run().catch(() => fail('stopped'));",
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
  ],
});

// Stand-in data tool of benchmark-data.test.ts: refuses the binary build when the benchmark copy has a `stale` file.
import { existsSync } from 'node:fs';

if (existsSync('stale')) {
  process.stderr.write('the data is not matched; run the data tool without --binary and commit: data/translations/en.csv\n');
  process.exit(1);
}

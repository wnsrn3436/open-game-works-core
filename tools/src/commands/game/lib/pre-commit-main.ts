// Entry point of the game repo pre-commit hook that `ogw game init` installs. Usage: node pre-commit-main.ts <game>
import { runCli } from '../../../lib/cli.ts';
import { staticCheckDetail } from '../../check/static-api.ts';
import { commands } from '../../index.ts';
import { hookMain } from './pre-commit.ts';

process.exitCode = await hookMain(process.argv[2] ?? '', { ogw: (argv, io) => runCli(commands, argv, io), staticCheck: staticCheckDetail });

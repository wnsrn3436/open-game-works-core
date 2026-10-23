import { OgwError } from './errors.ts';
import { LIMITS } from './limits.ts';
import { run, runOk } from './proc.ts';

/** The password file inside the container; the image reads it through `POSTGRES_PASSWORD_FILE`. */
export const PASSWORD_FILE_NAME = 'ogw-postgres-password';
const PASSWORD_FILE = `/${PASSWORD_FILE_NAME}`;

/** The label of every throwaway PostgreSQL data volume; a volume with it that no container uses is a leftover. */
export const VOLUME_LABEL = 'ogw.postgres=throwaway';

/** The data `VOLUME` of the `postgres` image of a tag: from major 18 `/var/lib/postgresql`, before it `/var/lib/postgresql/data`. */
export function postgresDataPath(tag: string): string {
  return Number.parseInt(tag, 10) >= 18 ? '/var/lib/postgresql' : '/var/lib/postgresql/data';
}

const BLOCK = 512;

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

/**
 * A tar archive (ustar) of one regular file owned by root with mode 0444, for `docker cp -`. The file reaches the
 * container through the stdin of `docker cp`, never through a command line, an environment variable or a host file.
 */
export function singleFileTar(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(BLOCK);
  const field = (offset: number, text: string): void => {
    header.write(text, offset, 'ascii');
  };
  field(0, name);
  field(100, octal(0o444, 8));
  field(108, octal(0, 8));
  field(116, octal(0, 8));
  field(124, octal(data.length, 12));
  field(136, octal(Math.floor(Date.now() / 1000), 12));
  field(148, ' '.repeat(8));
  field(156, '0');
  field(257, 'ustar\0');
  field(263, '00');
  let sum = 0;
  for (const byte of header) sum += byte;
  field(148, `${sum.toString(8).padStart(6, '0')}\0 `);
  const padding = Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK);
  return Buffer.concat([header, data, padding, Buffer.alloc(2 * BLOCK)]);
}

export interface PostgresCreate {
  /** Container name; without it the container is referred to by the id `docker create` prints. */
  name?: string;
  /** More `docker create` options before the image, for example `--publish`. */
  options: readonly string[];
  /** `postgres:<tag>@<digest>`. */
  image: string;
  /** Arguments after the image: options of the `postgres` server, for example `-c max_connections=1000`. */
  command?: readonly string[];
  password: string;
  env: NodeJS.ProcessEnv;
  /** Runs between the steps; throws to stop the start (the container is then removed). */
  between?: () => Promise<void>;
}

/**
 * Creates and starts a PostgreSQL container whose password is in no process command line or environment variable:
 * the container is created with `POSTGRES_PASSWORD_FILE`, the file is copied in from stdin, then the container
 * starts. Its data is on an anonymous volume labeled `VOLUME_LABEL`; first the labeled volumes no container uses are
 * removed, which are what a process killed before `removeContainer` left. Returns the container name, else its id. On
 * failure the container is removed and the error is thrown.
 */
export async function startPostgresContainer(input: PostgresCreate): Promise<string> {
  const docker = (args: string[], stdin?: Buffer): Promise<string> =>
    runOk('docker', args, { timeoutMs: LIMITS.programMs, env: input.env, ...(stdin === undefined ? {} : { input: stdin }) }).then((r) => r.stdout.trim());
  const named = input.name === undefined ? [] : ['--name', input.name];
  const tag = /^postgres:([^@]+)@/.exec(input.image)?.[1];
  if (tag === undefined) throw new OgwError(`not a postgres:<tag>@<digest> image: ${input.image}`);
  // the mount covers the image's data VOLUME, so Docker makes no unlabeled volume for it
  const mount = `type=volume,dst=${postgresDataPath(tag)},volume-label=${VOLUME_LABEL}`;
  let id: string | null = input.name ?? null;
  await pruneVolumes(input.env);
  try {
    const printed = await docker(['create', ...named, '--env', `POSTGRES_PASSWORD_FILE=${PASSWORD_FILE}`, '--mount', mount, ...input.options, input.image, ...(input.command ?? [])]);
    id ??= printed;
    if (id === '') throw new OgwError('docker create printed no container id');
    await input.between?.();
    await docker(['cp', '-', `${id}:/`], singleFileTar(PASSWORD_FILE_NAME, Buffer.from(input.password)));
    await input.between?.();
    await docker(['start', id]);
    return id;
  } catch (error) {
    if (id !== null && id !== '') await removeContainer(id, input.env);
    throw error;
  }
}

/** Removes a container and its anonymous volumes. A missing container is not an error. */
export async function removeContainer(nameOrId: string, env: NodeJS.ProcessEnv): Promise<void> {
  await run('docker', ['rm', '--force', '--volumes', nameOrId], { timeoutMs: LIMITS.programMs, env }).catch(() => undefined);
}

/**
 * Removes the volumes labeled `VOLUME_LABEL` that no container uses. They are anonymous volumes, which `docker volume
 * prune` removes without `--all` on every Docker version. A failure is not an error.
 */
async function pruneVolumes(env: NodeJS.ProcessEnv): Promise<void> {
  await run('docker', ['volume', 'prune', '--force', '--filter', `label=${VOLUME_LABEL}`], { timeoutMs: LIMITS.programMs, env }).catch(() => undefined);
}

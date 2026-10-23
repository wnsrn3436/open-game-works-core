import type { CommandDef } from '../../lib/command.ts';
import { done } from './done.ts';
import { todo } from './todo.ts';

export const commands: CommandDef[] = [todo, done];

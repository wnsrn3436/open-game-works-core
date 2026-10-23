import { syncCommand } from './sync.ts';

/** `ogw resource placeholder <game>`: the same procedure as `ogw resource sync`, which makes the placeholder resource of every `placeholder` row. */
export const placeholder = syncCommand('placeholder');
